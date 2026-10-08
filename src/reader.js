/**
 * Read-only reader for a QuestLaw encrypted export (.qlvault).
 *
 * Chain: recovery code -> vault key -> head -> manifest shards -> records. Each
 * step mirrors the extension's own restore from an export, but uses the recovery
 * unwrap instead of the device unwrap, because this process has no device. The
 * vendored crypto module generates the device wrap key as non-extractable, and
 * checks that again before using it, so that key never leaves the browser.
 *
 * Read-only is enforced, not promised. Nothing here opens a file for writing,
 * touches IndexedDB, or uses the network, and test/module-graph.test.js asserts it.
 */
'use strict';

const fs = require('fs');
const { webcrypto } = require('crypto');
const { Crypto, Protocol, Backup } = require('./core-modules');
const { LibraryError, fail } = require('./errors');

const COLLECTION_BY_RECORD_TYPE = Object.freeze({
  'case': 'cases',
  'project': 'projects',
  'relationship': 'relationships',
  'workspace-section': 'workspaceSections',
  'document': 'documents',
  'document-section': 'documentSections',
  'document-reference': 'documentReferences'
});

// 32 random bytes, base64url, unpadded, which is exactly what
// generateRecoveryCode() in the crypto module produces. Anything else is a typo,
// not a wrong vault.
const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * How many records are verified and decrypted at once. Each needs a digest, a key
 * derivation, an unwrap, and a decrypt, which Web Crypto runs off the main
 * thread, so awaiting them one at a time left those threads idle.
 */
const DECRYPT_CONCURRENCY = 32;

const PROGRESS_EVERY = 250;

/**
 * Runs `fn` over every item, `limit` at a time, with results in input order. The
 * first failure stops new work from starting and is what the caller sees, and
 * work already started is allowed to settle.
 */
async function mapInOrder(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const position = next;
      next += 1;
      try {
        results[position] = await fn(items[position], position);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find(outcome => outcome.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}

function emptyLibrary() {
  return Object.fromEntries(
    Object.values(COLLECTION_BY_RECORD_TYPE).map(collection => [collection, []])
  );
}

function integrityFailure(error, stage) {
  const detail = error?.code ? String(error.code) : String(error?.message || 'unknown');
  if (stage === 'parse') {
    return new LibraryError(
      'invalid_export_file',
      'That file is not a readable QuestLaw encrypted export.',
      {
        detail,
        hint: 'Use a questlaw-backup-<date>.qlvault written by the extension, unedited. '
          + 'The format is canonical JSON, so even reformatting the file invalidates it.',
        cause: error
      }
    );
  }
  return new LibraryError(
    'vault_integrity_failed',
    `The export failed an integrity check while reading the ${stage}. Nothing from it was returned.`,
    {
      detail,
      hint: 'Export a fresh backup from the extension. If a fresh export fails the same way, '
        + 'the file was altered after it was written.',
      cause: error
    }
  );
}

async function parseFile(filePath) {
  const records = [];
  const shards = [];
  const parser = new Backup.CanonicalEncryptedBackupParser({
    onRecords: rows => { records.push(...rows); },
    onShards: rows => { shards.push(...rows); }
  });
  let bundle;
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    for await (const chunk of stream) await parser.write(chunk);
    bundle = await parser.finish();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new LibraryError('vault_file_missing', `No file at ${filePath}.`, { cause: error });
    }
    // An errno means the filesystem refused, not that the file is malformed.
    // Telling someone with a permissions problem "not a valid export" sends them
    // to re-export, which won't help.
    if (typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
      throw new LibraryError('vault_file_unreadable',
        `Could not read ${filePath} (${error.code}).`,
        { detail: error.code, hint: 'Check the path and its permissions.', cause: error });
    }
    throw integrityFailure(error, 'parse');
  }
  // The parser already pins both, but check again rather than decrypt on assumption.
  if (bundle.kind !== Backup.KIND || bundle.protocolVersion !== Protocol.PROTOCOL_VERSION) {
    throw integrityFailure(new Error('unexpected_export_kind'), 'parse');
  }
  return { bundle, records, shards };
}

function unwrapFailure(generation, cause) {
  if (generation > 1) {
    return new LibraryError(
      'recovery_unwrap_failed',
      `The recovery code did not unwrap this export. The library is on generation ${generation}, `
        + 'and a recovery code only opens the generation it was issued for.',
      {
        cause,
        hint: 'Use the recovery code from your most recent key rotation, not an earlier one. '
          + 'An old code and a mistyped code fail identically here, so check both.'
      }
    );
  }
  return new LibraryError(
    'recovery_unwrap_failed',
    'The recovery code did not unwrap this export.',
    {
      cause,
      hint: 'The code is 43 characters and case-sensitive. Check it against the one the '
        + 'extension showed at enrollment, and confirm the export came from the same library.'
    }
  );
}

/**
 * Decrypt one export in memory.
 *
 * @param {string} filePath
 * @param {string} recoveryCode 43-character recovery code
 * @param {{onProgress?: (stage: object) => void}} [options]
 * @returns {Promise<{vaultId: string, vaultGeneration: number, headVersion: number,
 *   recordCount: number, decrypted: number, skippedRecordTypes: string[], library: object}>}
 */
async function readEncryptedLibrary(filePath, recoveryCode, options = {}) {
  const code = String(recoveryCode || '').trim();
  if (!code) {
    fail('recovery_code_missing', 'No recovery code was supplied.', {
      hint: 'Set QUESTLAW_RECOVERY_CODE, or store the code in the keychain.'
    });
  }
  if (!RECOVERY_CODE_PATTERN.test(code)) {
    fail('recovery_code_malformed',
      `That is not a recovery code: expected 43 base64url characters, got ${code.length}.`,
      { hint: 'Copy the code exactly as the extension showed it, with no spaces or line breaks.' });
  }

  const cryptoApi = Crypto.createCrypto({ crypto: webcrypto, TextEncoder, TextDecoder });
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const { bundle, records: recordRows, shards: shardRows } = await parseFile(filePath);
  onProgress({ stage: 'parsed', records: bundle.recordCount, shards: bundle.shardCount });

  // The recovery code is the only way into this file outside the browser.
  let vaultKey;
  try {
    vaultKey = await cryptoApi.unwrapVaultKeyWithRecovery(
      bundle.recoveryWrappedVaultKey,
      code,
      bundle.vaultId,
      bundle.vaultGeneration,
      bundle.vaultGeneration
    );
  } catch (error) {
    // The underlying error always says `recovery_unwrap_failed` and nothing more,
    // so it's kept only as the cause.
    throw unwrapFailure(bundle.vaultGeneration, error);
  }
  onProgress({ stage: 'unwrapped', vaultId: bundle.vaultId, generation: bundle.vaultGeneration });

  try {
    return await readWithVaultKey({ bundle, recordRows, shardRows, cryptoApi, vaultKey, onProgress });
  } finally {
    // Best effort only, since Node may already have copied these bytes during the unwrap.
    vaultKey.fill(0);
  }
}

async function readWithVaultKey({ bundle, recordRows, shardRows, cryptoApi, vaultKey, onProgress }) {
  const common = {
    vaultKey,
    vaultId: bundle.vaultId,
    vaultGeneration: bundle.vaultGeneration,
    trustedVaultGeneration: bundle.vaultGeneration
  };

  // 1. Head: authenticates all 256 manifest buckets at once.
  let head;
  try {
    head = await cryptoApi.decryptRecord({
      ...common,
      recordType: Protocol.RECORD_TYPES.head,
      recordId: Protocol.HEAD_RECORD_ID,
      recordVersion: bundle.headVersion,
      purpose: Protocol.PURPOSES.head,
      envelope: bundle.head,
      replayRegistry: Crypto.createReplayRegistry()
    });
    Protocol.verifyHead(head, {
      vaultId: bundle.vaultId,
      vaultGeneration: bundle.vaultGeneration,
      headVersion: bundle.headVersion
    });
    if (await cryptoApi.digestText(bundle.head) !== bundle.headDigest) {
      throw new LibraryError('head_digest_mismatch', 'head digest mismatch');
    }
  } catch (error) {
    throw integrityFailure(error, 'head');
  }
  onProgress({ stage: 'head', recordCount: head.recordCount });

  // 2. Shards: the manifest that names every record.
  let shards;
  try {
    shards = await mapInOrder(shardRows, DECRYPT_CONCURRENCY, async row => {
      const shard = await cryptoApi.decryptRecord({
        ...common,
        recordType: Protocol.RECORD_TYPES.shard,
        recordId: Protocol.shardIdentifier(row.shardNumber),
        recordVersion: row.shardVersion,
        purpose: Protocol.PURPOSES.shard,
        envelope: row.envelope,
        replayRegistry: Crypto.createReplayRegistry()
      });
      Protocol.verifyShardAgainstHead({
        shard,
        head,
        shardNumber: row.shardNumber,
        envelopeDigest: row.shardDigest,
        envelopeBytes: Protocol.utf8Bytes(row.envelope)
      });
      return shard;
    });
    Protocol.assertShardSetComplete(head, shards);
  } catch (error) {
    throw integrityFailure(error, 'manifest');
  }
  onProgress({ stage: 'shards', count: shards.length });

  const entries = new Map(
    shards.flatMap(shard => shard.entries.map(entry => [entry.blindId, entry]))
  );
  // The parser rejects a duplicate blindId, so equal counts plus every row
  // resolving to an entry is a one-to-one match, with no manifest entry unread and
  // no record unlisted.
  if (entries.size !== bundle.recordCount) {
    throw integrityFailure(new Error('manifest_record_count_mismatch'), 'manifest');
  }

  // 3. Records. One replay registry for the whole read, since every record has a
  //    distinct blind id and a repeat means a malformed file.
  const replayRegistry = Crypto.createReplayRegistry();
  const library = emptyLibrary();
  const skipped = new Set();
  let decrypted = 0;

  // Decrypted concurrently but kept in file order. The replay registry is checked
  // and updated synchronously inside decryptRecord, so sharing it across
  // concurrent reads still rejects a repeat.
  const plaintexts = await mapInOrder(recordRows, DECRYPT_CONCURRENCY, async row => {
    const entry = entries.get(row.blindId);
    if (!entry) throw integrityFailure(new Error('unlisted_record'), 'records');
    let plaintext;
    try {
      if (Protocol.utf8Bytes(row.envelope) !== entry.envelopeBytes) {
        throw new LibraryError('record_size_mismatch', 'record size mismatch');
      }
      if (await cryptoApi.digestText(row.envelope) !== entry.digest) {
        throw new LibraryError('record_digest_mismatch', 'record digest mismatch');
      }
      plaintext = await cryptoApi.decryptRecord({
        ...common,
        recordType: entry.recordType,
        recordId: entry.recordId,
        recordVersion: entry.recordVersion,
        envelope: row.envelope,
        replayRegistry
      });
    } catch (error) {
      throw integrityFailure(error, 'records');
    }
    decrypted += 1;
    if (decrypted % PROGRESS_EVERY === 0) onProgress({ stage: 'records', decrypted });
    return { recordType: entry.recordType, plaintext };
  });

  for (const { recordType, plaintext } of plaintexts) {
    const collection = COLLECTION_BY_RECORD_TYPE[recordType];
    // `private-state` is confidential UI state (active workspace, collapse state),
    // not research, so drop it here.
    if (!collection) { skipped.add(recordType); continue; }
    library[collection].push(plaintext);
  }
  onProgress({ stage: 'records', decrypted });

  return {
    vaultId: bundle.vaultId,
    vaultGeneration: bundle.vaultGeneration,
    headVersion: bundle.headVersion,
    recordCount: bundle.recordCount,
    decrypted,
    skippedRecordTypes: [...skipped].sort(),
    library
  };
}

module.exports = {
  readEncryptedLibrary,
  COLLECTION_BY_RECORD_TYPE,
  RECOVERY_CODE_PATTERN
};
