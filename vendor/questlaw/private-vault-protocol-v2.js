/**
 * QuestLaw private vault v2 sync protocol.
 *
 * Pure and host-neutral by contract: bucket selection, canonical entry
 * ordering, manifest-shard construction and verification, and bounded-head
 * construction and verification. No storage, network, UI, clock, crypto, or
 * ambient-global access. Digests are computed by the caller with the vault's
 * crypto module and passed in, so this module can be reasoned about and tested
 * without any host capability.
 *
 * In plain terms: this is the bookkeeping that lets a device ask "which few
 * things changed?" instead of downloading everything to find out.
 *
 * The frozen contract is
 * `tests/fixtures/private-vault-v2/protocol-vectors.json`; every constant below
 * is asserted against it.
 */
(function initPrivateVaultProtocolV2(root) {
  'use strict';

  const Crypto = root.QuestLaw?.PrivateWorkProductCrypto ||
    (typeof module !== 'undefined' && module.exports
      ? module.require('./private-work-product-crypto')
      : null);

  const PROTOCOL_VERSION = 2;
  const BUCKET_COUNT = 256;
  const BLIND_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

  const FORMATS = Object.freeze({
    head: 'questlaw-private-vault-head-v2',
    shard: 'questlaw-private-vault-shard-v2'
  });

  const PURPOSES = Object.freeze({
    record: 'record',
    head: 'vault-head-v2',
    shard: 'manifest-shard-v2'
  });

  const RECORD_TYPES = Object.freeze({
    head: 'vault-head',
    shard: 'manifest-shard'
  });

  const HEAD_RECORD_ID = 'vault-head';

  // Frozen capacity bounds. Bytes are UTF-8 bytes of the canonical serialized
  // form, never string length: the two differ by up to 6x once a control
  // character is JSON-escaped, which is what made an earlier shard bound wrong.
  const LIMITS = Object.freeze({
    recordIdSerializedBytes: 512,
    recordTypeSerializedBytes: 128,
    shardEntries: 256,
    shardPlaintextBytes: 320 * 1024,
    shardEnvelopeBytes: 448 * 1024,
    headPlaintextBytes: 64 * 1024,
    headEnvelopeBytes: 96 * 1024,
    recordPlaintextBytes: 4 * 1024 * 1024,
    recordEnvelopeBytes: 6 * 1024 * 1024,
    vaultIdBytes: 128,
    deviceIdBytes: 128,
    recoveryWrappedKeyBytes: 4096,
    recentHeadDigests: 32,
    recordsPerVault: 20_000,
    responseBudgetBytes: 8 * 1024 * 1024,
    responseRowOverheadBytes: 256,
    responseFramingBytes: 256,
    headResponseBytes: 104 * 1024,
    probeResponseBytes: 2048
  });

  const SHARD_KEYS = Object.freeze([
    'entries', 'format', 'protocolVersion', 'shardNumber', 'shardVersion'
  ]);
  const ENTRY_KEYS = Object.freeze([
    'blindId', 'digest', 'envelopeBytes', 'recordId', 'recordType', 'recordVersion'
  ]);
  const HEAD_KEYS = Object.freeze([
    'buckets', 'format', 'headVersion', 'protocolVersion', 'recentHeadDigests',
    'recordCount', 'suite', 'vaultGeneration', 'vaultId', 'version'
  ]);
  const BUCKET_KEYS = Object.freeze(['digest', 'empty', 'envelopeBytes', 'version']);

  class ProtocolError extends Error {
    constructor(code) {
      super(code);
      this.name = 'QuestLawPrivateVaultProtocolError';
      this.code = code;
    }
  }

  function fail(code) {
    throw new ProtocolError(code);
  }

  function exactKeys(value, expected, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
    const actual = Object.keys(value).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      fail(code);
    }
    return value;
  }

  function positiveInteger(value, code) {
    if (!Number.isSafeInteger(value) || value < 1) fail(code);
    return value;
  }

  function countingInteger(value, code) {
    if (!Number.isSafeInteger(value) || value < 0) fail(code);
    return value;
  }

  /**
   * Decode a 43-character base64url digest or blind identifier to its exact 32
   * bytes. The alphabet check alone is not validation: the final character of a
   * 43-character value carries two bits that must be zero, so a shape-valid
   * string can still be noncanonical and decode to bytes no encoder would
   * produce. Two spellings of one digest would let a mismatch pass as a match.
   *
   * The codec's own error is translated here on purpose: callers switch on this
   * module's stable protocol codes, not on the crypto module's internals.
   */
  function decodeDigest(value, code) {
    if (typeof value !== 'string' || !BLIND_ID_PATTERN.test(value)) fail(code);
    try {
      return Crypto.base64UrlDecode(value, 32);
    } catch (_) {
      fail(code);
      return null;
    }
  }

  function digestText(value, code) {
    decodeDigest(value, code);
    return value;
  }

  /** UTF-8 byte length without relying on a host TextEncoder. */
  function utf8Bytes(text) {
    if (typeof text !== 'string') fail('invalid_text');
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdfff) fail('invalid_text');
        bytes += 4;
        index += 1;
      } else {
        if (code >= 0xdc00 && code <= 0xdfff) fail('invalid_text');
        bytes += 3;
      }
    }
    return bytes;
  }

  /** UTF-8 byte length of the canonical serialization, computed without a codec. */
  function serializedBytes(value) {
    return utf8Bytes(Crypto.canonicalize(value));
  }

  /**
   * The bucket a record belongs to: the first byte of its decoded blind
   * identifier. The identifier is an HMAC, so buckets fill uniformly and the
   * server can recompute this from data it already holds.
   */
  function shardNumberForBlindId(blindId) {
    return decodeDigest(blindId, 'invalid_blind_id')[0];
  }

  /** Zero-padded so the encrypted record id sorts and reads predictably. */
  function shardIdentifier(shardNumber) {
    if (!Number.isInteger(shardNumber) || shardNumber < 0 || shardNumber >= BUCKET_COUNT) {
      fail('invalid_shard_number');
    }
    return `shard-${String(shardNumber).padStart(3, '0')}`;
  }

  /**
   * Order by the decoded bytes, never by the base64url text. The two disagree:
   * base64url's alphabet is not in ASCII order, so a text sort would place
   * `-` and `_` inconsistently and two runtimes would build different shards
   * from identical data.
   */
  function compareBlindIds(left, right) {
    const a = decodeDigest(left, 'invalid_blind_id');
    const b = decodeDigest(right, 'invalid_blind_id');
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }

  /** The single authenticated marker for "this bucket holds nothing". */
  function emptyBucket() {
    return { digest: null, empty: true, envelopeBytes: 0, version: 0 };
  }

  function validateEntry(entry, shardNumber) {
    exactKeys(entry, ENTRY_KEYS, 'invalid_shard_entry');
    digestText(entry.blindId, 'invalid_blind_id');
    digestText(entry.digest, 'invalid_record_digest');
    positiveInteger(entry.envelopeBytes, 'invalid_record_bytes');
    if (entry.envelopeBytes > LIMITS.recordEnvelopeBytes) fail('capacity_exceeded');
    positiveInteger(entry.recordVersion, 'invalid_record_version');
    if (typeof entry.recordId !== 'string' || !entry.recordId) fail('invalid_record_id');
    if (typeof entry.recordType !== 'string' || !entry.recordType) fail('invalid_record_type');
    if (serializedBytes(entry.recordId) > LIMITS.recordIdSerializedBytes) fail('capacity_exceeded');
    if (serializedBytes(entry.recordType) > LIMITS.recordTypeSerializedBytes) {
      fail('capacity_exceeded');
    }
    if (shardNumberForBlindId(entry.blindId) !== shardNumber) fail('shard_membership_mismatch');
    return entry;
  }

  function orderedEntries(entries, shardNumber) {
    if (!Array.isArray(entries)) fail('invalid_shard');
    // A zero-entry shard is invalid everywhere. An emptied bucket deletes its
    // row and is marked empty in the head, so there is exactly one way to say
    // "nothing here" and a reader cannot accept the wrong one.
    if (!entries.length) fail('empty_shard_forbidden');
    if (entries.length > LIMITS.shardEntries) fail('capacity_exceeded');
    const seen = new Set();
    for (const entry of entries) {
      validateEntry(entry, shardNumber);
      if (seen.has(entry.blindId)) fail('duplicate_shard_entry');
      seen.add(entry.blindId);
    }
    return [...entries].sort((left, right) => compareBlindIds(left.blindId, right.blindId));
  }

  /** Build a canonical manifest shard. Entries are sorted here, not by the caller. */
  function buildShard(input = {}) {
    const shardNumber = input.shardNumber;
    if (!Number.isInteger(shardNumber) || shardNumber < 0 || shardNumber >= BUCKET_COUNT) {
      fail('invalid_shard_number');
    }
    const shard = {
      entries: orderedEntries(input.entries, shardNumber).map(entry => ({
        blindId: entry.blindId,
        digest: entry.digest,
        envelopeBytes: entry.envelopeBytes,
        recordId: entry.recordId,
        recordType: entry.recordType,
        recordVersion: entry.recordVersion
      })),
      format: FORMATS.shard,
      protocolVersion: PROTOCOL_VERSION,
      shardNumber,
      shardVersion: positiveInteger(input.shardVersion, 'invalid_shard_version')
    };
    if (serializedBytes(shard) > LIMITS.shardPlaintextBytes) fail('capacity_exceeded');
    return shard;
  }

  /**
   * Verify a decrypted shard against what the head said it should be. This runs
   * after decryption, so it is the only place that can catch a server that
   * returned the wrong bucket, a stale version, or reordered entries.
   */
  function verifyShard(value, expected = {}) {
    exactKeys(value, SHARD_KEYS, 'invalid_shard');
    if (value.format !== FORMATS.shard) fail('invalid_shard');
    if (value.protocolVersion !== PROTOCOL_VERSION) fail('unsupported_protocol_version');
    if (!Number.isInteger(value.shardNumber) ||
      value.shardNumber < 0 || value.shardNumber >= BUCKET_COUNT) {
      fail('invalid_shard_number');
    }
    positiveInteger(value.shardVersion, 'invalid_shard_version');
    if (expected.shardNumber !== undefined && value.shardNumber !== expected.shardNumber) {
      fail('shard_membership_mismatch');
    }
    if (expected.shardVersion !== undefined && value.shardVersion !== expected.shardVersion) {
      fail('stale_shard_version');
    }
    const ordered = orderedEntries(value.entries, value.shardNumber);
    // Sorting is part of the contract, so an out-of-order shard is rejected
    // rather than quietly repaired: two devices must build identical bytes.
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index] !== value.entries[index]) fail('shard_entries_unordered');
    }
    // Every bound build enforces, verify enforces. A verifier that accepts what
    // the builder refuses to produce is a fail-open path by construction.
    if (serializedBytes(value) > LIMITS.shardPlaintextBytes) fail('capacity_exceeded');
    return value;
  }

  function validateBucket(bucket) {
    exactKeys(bucket, BUCKET_KEYS, 'invalid_head_bucket');
    if (typeof bucket.empty !== 'boolean') fail('invalid_head_bucket');
    countingInteger(bucket.version, 'invalid_head_bucket');
    countingInteger(bucket.envelopeBytes, 'invalid_head_bucket');
    // The four fields are deliberately redundant and must agree, so a partial
    // or type-confused write cannot produce a bucket a reader misinterprets.
    if (bucket.empty !== (bucket.version === 0)) fail('inconsistent_head_bucket');
    if (bucket.empty !== (bucket.digest === null)) fail('inconsistent_head_bucket');
    if (bucket.empty !== (bucket.envelopeBytes === 0)) fail('inconsistent_head_bucket');
    if (!bucket.empty) {
      digestText(bucket.digest, 'invalid_shard_digest');
      if (bucket.envelopeBytes > LIMITS.shardEnvelopeBytes) fail('capacity_exceeded');
    }
    return bucket;
  }

  function validateBuckets(buckets) {
    // Dense and fixed-length. A sparse map would make "absent" mean "empty",
    // which is the standard shape of a fail-open bug.
    if (!Array.isArray(buckets) || buckets.length !== BUCKET_COUNT) fail('invalid_head_buckets');
    return buckets.map(validateBucket);
  }

  function validateAncestry(digests) {
    if (!Array.isArray(digests)) fail('invalid_head_ancestry');
    if (digests.length > LIMITS.recentHeadDigests) fail('capacity_exceeded');
    const seen = new Set();
    for (const digest of digests) {
      digestText(digest, 'invalid_head_ancestry');
      if (seen.has(digest)) fail('invalid_head_ancestry');
      seen.add(digest);
    }
    return digests;
  }

  /** Build the bounded head that authenticates all 256 buckets at once. */
  function buildHead(input = {}) {
    const buckets = validateBuckets(input.buckets);
    const head = {
      buckets: buckets.map(bucket => ({
        digest: bucket.digest,
        empty: bucket.empty,
        envelopeBytes: bucket.envelopeBytes,
        version: bucket.version
      })),
      format: FORMATS.head,
      headVersion: positiveInteger(input.headVersion, 'invalid_head_version'),
      protocolVersion: PROTOCOL_VERSION,
      recentHeadDigests: [...validateAncestry(input.recentHeadDigests || [])],
      recordCount: countingInteger(input.recordCount, 'invalid_record_count'),
      suite: Crypto.SUITE,
      vaultGeneration: positiveInteger(input.vaultGeneration, 'invalid_vault_generation'),
      vaultId: typeof input.vaultId === 'string' && input.vaultId
        ? input.vaultId
        : fail('invalid_vault_id'),
      version: Crypto.VERSION
    };
    if (head.recordCount > LIMITS.recordsPerVault) fail('capacity_exceeded');
    if (serializedBytes(head) > LIMITS.headPlaintextBytes) fail('capacity_exceeded');
    return head;
  }

  /** Pin a verified head to the identity the caller already authenticated. */
  function assertHeadMatches(value, expected) {
    if (expected.vaultId !== undefined && value.vaultId !== expected.vaultId) {
      fail('vault_identity_mismatch');
    }
    if (expected.vaultGeneration !== undefined &&
      value.vaultGeneration !== expected.vaultGeneration) {
      fail('stale_vault_generation');
    }
    if (expected.headVersion !== undefined && value.headVersion !== expected.headVersion) {
      fail('stale_head_version');
    }
  }

  function verifyHead(value, expected = {}) {
    exactKeys(value, HEAD_KEYS, 'invalid_head');
    if (value.format !== FORMATS.head) fail('invalid_head');
    if (value.protocolVersion !== PROTOCOL_VERSION) fail('unsupported_protocol_version');
    if (value.suite !== Crypto.SUITE) fail('unsupported_suite');
    if (value.version !== Crypto.VERSION) fail('unsupported_version');
    if (typeof value.vaultId !== 'string' || !value.vaultId) fail('invalid_vault_id');
    positiveInteger(value.vaultGeneration, 'invalid_vault_generation');
    positiveInteger(value.headVersion, 'invalid_head_version');
    countingInteger(value.recordCount, 'invalid_record_count');
    validateBuckets(value.buckets);
    validateAncestry(value.recentHeadDigests);
    assertHeadMatches(value, expected);
    // Same rule as the shard: verify enforces every bound build enforces, or a
    // head that could never have been built locally is accepted from the wire.
    if (value.recordCount > LIMITS.recordsPerVault) fail('capacity_exceeded');
    if (serializedBytes(value) > LIMITS.headPlaintextBytes) fail('capacity_exceeded');
    return value;
  }

  /**
   * The buckets whose authenticated shard state differs between two heads.
   * This is the whole point of the head: comparing 256 small digests replaces
   * downloading every record to discover that nothing changed.
   */
  function changedShardNumbers(localHead, remoteHead) {
    // Both arguments are heads, so both are verified as heads. Accepting any
    // object that merely carries a bucket-shaped array is how an unverified
    // response gets treated as authenticated state.
    const local = verifyHead(localHead).buckets;
    const remote = verifyHead(remoteHead).buckets;
    const changed = [];
    for (let index = 0; index < BUCKET_COUNT; index += 1) {
      if (local[index].digest !== remote[index].digest ||
        local[index].version !== remote[index].version ||
        local[index].envelopeBytes !== remote[index].envelopeBytes) {
        changed.push(index);
      }
    }
    return changed;
  }

  /**
   * Bind a decrypted shard to the head that named it. The head authenticates
   * the shard's digest, version, and byte size; without all three a server
   * could serve a stale but individually valid shard.
   */
  function verifyShardAgainstHead(input = {}) {
    const shard = verifyShard(input.shard, { shardNumber: input.shardNumber });
    const bucket = verifyHead(input.head).buckets[shard.shardNumber];
    if (bucket.empty) fail('unexpected_shard');
    if (bucket.version !== shard.shardVersion) fail('stale_shard_version');
    if (bucket.digest !== digestText(input.envelopeDigest, 'invalid_shard_digest')) {
      fail('shard_digest_mismatch');
    }
    if (bucket.envelopeBytes !== input.envelopeBytes) fail('shard_bytes_mismatch');
    return shard;
  }

  /**
   * Completeness: the head declares which buckets are non-empty, so the entries
   * across exactly those shards must total the head's own record count.
   */
  function assertShardSetComplete(head, shards) {
    const buckets = verifyHead(head).buckets;
    if (!Array.isArray(shards)) fail('invalid_shard_set');
    const expected = buckets
      .map((bucket, index) => (bucket.empty ? null : index))
      .filter(index => index !== null);

    // Every supplied shard is verified before it can contribute to the count,
    // and a repeated bucket is rejected rather than collapsed. Deduplicating
    // here would let two copies of one shard satisfy a record count that no
    // single legal shard set could reach.
    const seen = new Set();
    const actual = [];
    for (const shard of shards) {
      verifyShard(shard);
      if (seen.has(shard.shardNumber)) fail('duplicate_shard_row');
      seen.add(shard.shardNumber);
      actual.push(shard.shardNumber);
    }
    actual.sort((left, right) => left - right);

    if (actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])) {
      fail('incomplete_shard_set');
    }
    const total = shards.reduce((sum, shard) => sum + shard.entries.length, 0);
    if (total !== head.recordCount) fail('record_count_mismatch');
    return true;
  }

  const privateVaultProtocolV2 = Object.freeze({
    PROTOCOL_VERSION,
    BUCKET_COUNT,
    FORMATS,
    PURPOSES,
    RECORD_TYPES,
    HEAD_RECORD_ID,
    LIMITS,
    ProtocolError,
    utf8Bytes,
    serializedBytes,
    shardNumberForBlindId,
    shardIdentifier,
    compareBlindIds,
    emptyBucket,
    buildShard,
    verifyShard,
    buildHead,
    verifyHead,
    changedShardNumbers,
    verifyShardAgainstHead,
    assertShardSetComplete
  });

  root.QuestLaw = root.QuestLaw || {};
  root.QuestLaw.PrivateVaultProtocolV2 = privateVaultProtocolV2;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = privateVaultProtocolV2;
  }
}(typeof self !== 'undefined' ? self : globalThis));
