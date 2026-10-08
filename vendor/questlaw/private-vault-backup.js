/** Format-aware, streaming bounds for encrypted protocol-2 vault backups. */
(function initPrivateVaultBackup(root) {
  'use strict';

  const MiB = 1024 * 1024;
  const LIMITS = Object.freeze({
    legacyFileBytes: 32 * MiB,
    recordEnvelopeBytes: 6 * MiB,
    shardEnvelopeBytes: 448 * 1024,
    headEnvelopeBytes: 96 * 1024,
    recoveryWrappedKeyBytes: 4 * 1024,
    records: 20_000,
    shards: 256,
    totalEncryptedBytes: 512 * MiB,
    // The encrypted-byte ceiling excludes canonical row framing. The file cap
    // adds the frozen 256-byte allowance per row plus bounded top-level data.
    encryptedFileBytes: (512 * MiB) + ((20_000 + 256) * 256) + (512 * 1024),
    batchBytes: 8 * MiB,
    batchRows: 256,
    sniffBytes: 160 * 1024
  });
  const KIND = 'questlaw-private-vault-export';
  const TOP_LEVEL = Object.freeze([
    ['head', 'string'],
    ['headDigest', 'string'],
    ['headVersion', 'integer'],
    ['kind', 'string'],
    ['protocolVersion', 'integer'],
    ['records', 'records'],
    ['recoveryWrappedVaultKey', 'string'],
    ['shards', 'shards'],
    ['vaultGeneration', 'integer'],
    ['vaultId', 'string']
  ]);
  const RECORD_FIELDS = Object.freeze(['blindId', 'envelope']);
  const SHARD_FIELDS = Object.freeze([
    'envelope', 'shardDigest', 'shardNumber', 'shardVersion'
  ]);

  function fail(code) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }

  function utf8Bytes(value) {
    return new TextEncoder().encode(String(value)).byteLength;
  }

  function assertCapacity(limitName, value) {
    const limit = LIMITS[limitName];
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(limit)) {
      fail('invalid_capacity');
    }
    if (value > limit) fail('capacity_exceeded');
    return value;
  }

  function sameFields(value, expected) {
    return value && !Array.isArray(value) && typeof value === 'object' &&
      JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
  }

  // Token completion is a small JSON state machine; its branches are the
  // quoted/escaped/object/number grammar, not independent business decisions.
  // eslint-disable-next-line complexity
  function valueEnd(text, finished) {
    if (!text) return null;
    const first = text[0];
    if (first === '"') {
      let escaped = false;
      for (let index = 1; index < text.length; index += 1) {
        const char = text[index];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') return index + 1;
      }
      if (finished) fail('invalid_encrypted_export');
      return null;
    }
    if (first === '{') {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) return index + 1;
      }
      if (finished) fail('invalid_encrypted_export');
      return null;
    }
    const match = text.match(/^-?(?:0|[1-9]\d*)/);
    if (!match) fail('invalid_encrypted_export');
    if (match[0].length === text.length && !finished) return null;
    return match[0].length;
  }

  class CanonicalEncryptedBackupParser {
    constructor(options = {}) {
      this.onRecords = options.onRecords || (async () => {});
      this.onShards = options.onShards || (async () => {});
      this.buffer = '';
      this.fieldIndex = 0;
      this.fieldStarted = false;
      this.array = null;
      this.arrayNeedsValue = true;
      this.arrayCount = 0;
      this.batch = [];
      this.batchBytes = 0;
      this.inputBytes = 0;
      this.encryptedBytes = 0;
      this.metadata = {};
      this.recordIds = new Set();
      this.shardNumbers = new Set();
      this.finished = false;
      this.complete = false;
    }

    consumeExact(expected) {
      if (this.buffer.length < expected.length) {
        if (expected.startsWith(this.buffer) && !this.finished) return false;
        fail('invalid_encrypted_export');
      }
      if (!this.buffer.startsWith(expected)) fail('invalid_encrypted_export');
      this.buffer = this.buffer.slice(expected.length);
      return true;
    }

    async flushBatch() {
      if (!this.batch.length) return;
      const values = this.batch;
      this.batch = [];
      this.batchBytes = 0;
      await (this.array === 'records' ? this.onRecords(values) : this.onShards(values));
    }

    validateRecordRow(row) {
      if (!sameFields(row, RECORD_FIELDS) || !row.blindId ||
        typeof row.blindId !== 'string' || typeof row.envelope !== 'string' ||
        this.recordIds.has(row.blindId)) {
        fail('invalid_encrypted_export');
      }
      assertCapacity('recordEnvelopeBytes', utf8Bytes(row.envelope));
      assertCapacity('records', this.recordIds.size + 1);
      this.recordIds.add(row.blindId);
    }

    validateShardRow(row) {
      if (!sameFields(row, SHARD_FIELDS) || typeof row.envelope !== 'string' ||
        typeof row.shardDigest !== 'string' ||
        !Number.isSafeInteger(row.shardNumber) || row.shardNumber < 0 ||
        row.shardNumber >= LIMITS.shards || !Number.isSafeInteger(row.shardVersion) ||
        row.shardVersion < 1 || this.shardNumbers.has(row.shardNumber)) {
        fail('invalid_encrypted_export');
      }
      assertCapacity('shardEnvelopeBytes', utf8Bytes(row.envelope));
      assertCapacity('shards', this.shardNumbers.size + 1);
      this.shardNumbers.add(row.shardNumber);
    }

    validateRow(raw) {
      let row;
      try { row = JSON.parse(raw); } catch (_) { fail('invalid_encrypted_export'); }
      if (JSON.stringify(row) !== raw) fail('noncanonical_encrypted_export');
      if (this.array === 'records') {
        this.validateRecordRow(row);
      } else {
        this.validateShardRow(row);
      }
      const envelopeBytes = utf8Bytes(row.envelope);
      this.encryptedBytes += envelopeBytes;
      assertCapacity('totalEncryptedBytes', this.encryptedBytes);
      return { row, envelopeBytes };
    }

    async processArray() {
      if (!this.arrayNeedsValue) {
        if (!this.buffer) return false;
        if (this.buffer[0] === ']') {
          await this.flushBatch();
          this.buffer = this.buffer.slice(1);
          this.array = null;
          this.fieldIndex += 1;
          return true;
        }
        if (!this.consumeExact(',')) return false;
        this.arrayNeedsValue = true;
        return true;
      }
      if (this.arrayCount === 0 && this.buffer.startsWith(']')) {
        this.buffer = this.buffer.slice(1);
        this.array = null;
        this.fieldIndex += 1;
        return true;
      }
      const end = valueEnd(this.buffer, this.finished);
      if (end === null) return false;
      const raw = this.buffer.slice(0, end);
      if (!raw.startsWith('{')) fail('invalid_encrypted_export');
      this.buffer = this.buffer.slice(end);
      const validated = this.validateRow(raw);
      if (this.batch.length && (this.batch.length >= LIMITS.batchRows ||
        this.batchBytes + validated.envelopeBytes > LIMITS.batchBytes)) {
        await this.flushBatch();
      }
      this.batch.push(validated.row);
      this.batchBytes += validated.envelopeBytes;
      this.arrayNeedsValue = false;
      this.arrayCount += 1;
      if (this.batch.length >= LIMITS.batchRows || this.batchBytes >= LIMITS.batchBytes) {
        await this.flushBatch();
      }
      return true;
    }

    // The canonical top-level field matrix is intentionally closed and all of
    // its type/capacity checks stay together.
    // eslint-disable-next-line complexity
    validateMetadata(name, type, raw) {
      let value;
      try { value = JSON.parse(raw); } catch (_) { fail('invalid_encrypted_export'); }
      if (JSON.stringify(value) !== raw) fail('noncanonical_encrypted_export');
      if (type === 'string' && typeof value !== 'string') fail('invalid_encrypted_export');
      if (type === 'integer' && (!Number.isSafeInteger(value) || value < 1)) {
        fail('invalid_encrypted_export');
      }
      if (name === 'kind' && value !== KIND) fail('invalid_encrypted_export');
      if (name === 'protocolVersion' && value !== 2) fail('invalid_encrypted_export');
      if (name === 'head') {
        const bytes = utf8Bytes(value);
        assertCapacity('headEnvelopeBytes', bytes);
        this.encryptedBytes += bytes;
        assertCapacity('totalEncryptedBytes', this.encryptedBytes);
      }
      if (name === 'recoveryWrappedVaultKey') {
        const bytes = utf8Bytes(value);
        assertCapacity('recoveryWrappedKeyBytes', bytes);
        this.encryptedBytes += bytes;
        assertCapacity('totalEncryptedBytes', this.encryptedBytes);
      }
      if ((name === 'headDigest' || name === 'vaultId') && !value) {
        fail('invalid_encrypted_export');
      }
      this.metadata[name] = value;
    }

    async process() {
      while (!this.complete) {
        if (this.array) {
          if (!await this.processArray()) return;
          continue;
        }
        if (this.fieldIndex >= TOP_LEVEL.length) {
          if (!this.consumeExact('}')) return;
          this.complete = true;
          return;
        }
        const [name, type] = TOP_LEVEL[this.fieldIndex];
        if (!this.fieldStarted) {
          const prefix = `${this.fieldIndex === 0 ? '{' : ','}"${name}":`;
          if (!this.consumeExact(prefix)) return;
          this.fieldStarted = true;
        }
        if (type === 'records' || type === 'shards') {
          if (!this.consumeExact('[')) return;
          this.fieldStarted = false;
          this.array = type;
          this.arrayNeedsValue = true;
          this.arrayCount = 0;
          continue;
        }
        const end = valueEnd(this.buffer, this.finished);
        if (end === null) return;
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        this.validateMetadata(name, type, raw);
        this.fieldStarted = false;
        this.fieldIndex += 1;
      }
    }

    async write(text) {
      if (this.finished) fail('invalid_encrypted_export');
      const value = String(text || '');
      this.inputBytes += utf8Bytes(value);
      assertCapacity('encryptedFileBytes', this.inputBytes);
      this.buffer += value;
      await this.process();
    }

    async finish() {
      this.finished = true;
      await this.process();
      if (!this.complete || this.buffer || this.array || this.batch.length) {
        fail('invalid_encrypted_export');
      }
      return Object.freeze({
        ...this.metadata,
        encryptedBytes: this.encryptedBytes,
        recordCount: this.recordIds.size,
        shardCount: this.shardNumbers.size
      });
    }
  }

  async function encryptedFileFormat(file) {
    const name = String(file?.name || '').toLowerCase();
    if (name.endsWith('.qlvault')) return 'canonical';
    if (!file?.slice) return null;
    const prefix = await file.slice(0, LIMITS.sniffBytes).text();
    if (!new RegExp(`"kind"\\s*:\\s*"${KIND}"`).test(prefix)) return null;
    const marker = `,"kind":"${KIND}","protocolVersion":2,"records":[`;
    return prefix.startsWith('{"head":') && prefix.includes(',"headDigest":') &&
      prefix.includes(',"headVersion":') && prefix.includes(marker) ? 'canonical' : 'legacy';
  }

  async function isEncryptedFile(file) {
    return await encryptedFileFormat(file) !== null;
  }

  function canonicalizeLegacy(text, canonicalize) {
    const value = String(text || '');
    assertCapacity('legacyFileBytes', utf8Bytes(value));
    let parsed;
    try { parsed = JSON.parse(value); } catch (_) { fail('invalid_encrypted_export'); }
    if (!parsed || parsed.kind !== KIND || typeof canonicalize !== 'function') {
      fail('invalid_encrypted_export');
    }
    return canonicalize(parsed);
  }

  const api = Object.freeze({
    KIND,
    LIMITS,
    assertCapacity,
    canonicalizeLegacy,
    CanonicalEncryptedBackupParser,
    encryptedFileFormat,
    isEncryptedFile
  });
  root.QuestLaw = root.QuestLaw || {};
  root.QuestLaw.PrivateVaultBackup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis)));
