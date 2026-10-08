/**
 * QuestLaw Private Work Product cryptography.
 *
 * Runtime-dark by contract: this module accepts every host capability through
 * createCrypto(), owns no durable state, and performs no storage, network, UI,
 * database, clock, or ambient-global access.
 */
'use strict';

const SUITE = 'QL-PWP-1';
const VERSION = 1;
const MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// Authenticated purpose prevents record/head/shard substitution. Each v2
// purpose also pins its record type.
const AAD_PURPOSES = Object.freeze({
  'record': null,
  'vault-head-v2': 'vault-head',
  'manifest-shard-v2': 'manifest-shard'
});
const ENVELOPE_KEYS = [
    'aad', 'algorithm', 'ciphertext', 'kdf', 'nonce',
    'suite', 'version', 'wrap', 'wrappedKey'
].sort();

  class CryptoError extends Error {
    constructor(code) {
      super(code);
      this.name = 'QuestLawCryptoError';
      this.code = code;
    }
  }

  function fail(code) {
    throw new CryptoError(code);
  }

  function assertUnicodeScalarString(value) {
    if (typeof value !== 'string') fail('invalid_string');
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid_unicode');
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail('invalid_unicode');
      }
    }
  }

  function canonicalize(value) {
    const active = new Set();

    function visit(input) {
      if (input === null || typeof input === 'boolean') return JSON.stringify(input);
      if (typeof input === 'string') {
        assertUnicodeScalarString(input);
        return JSON.stringify(input);
      }
      if (typeof input === 'number') {
        if (!Number.isFinite(input) || Object.is(input, -0)) fail('invalid_number');
        return JSON.stringify(input);
      }
      if (!input || typeof input !== 'object') fail('invalid_json_value');
      if (active.has(input)) fail('cyclic_value');
      active.add(input);
      let output;
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) fail('invalid_array');
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const ownKeys = Object.keys(descriptors).filter(key => key !== 'length');
        if (
          ownKeys.length !== input.length ||
          ownKeys.some((key, index) => key !== String(index)) ||
          ownKeys.some(key => !Object.prototype.hasOwnProperty.call(descriptors[key], 'value'))
        ) {
          fail('invalid_array');
        }
        output = `[${ownKeys.map(key => visit(descriptors[key].value)).join(',')}]`;
      } else {
        const prototype = Object.getPrototypeOf(input);
        if (prototype !== Object.prototype && prototype !== null) fail('invalid_object');
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const keys = Object.keys(descriptors).sort();
        if (keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors[key], 'value'))) {
          fail('accessor_not_allowed');
        }
        output = `{${keys.map(key => {
          assertUnicodeScalarString(key);
          return `${JSON.stringify(key)}:${visit(descriptors[key].value)}`;
        }).join(',')}}`;
      }
      active.delete(input);
      return output;
    }

    return visit(value);
  }

  function parseCanonical(text) {
    if (typeof text !== 'string') fail('invalid_canonical_json');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      fail('invalid_canonical_json');
    }
    if (canonicalize(parsed) !== text) fail('noncanonical_json');
    return parsed;
  }

  function bytesEqual(left, right) {
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
    return difference === 0;
  }

  function base64UrlEncode(input) {
    const bytes = new Uint8Array(input);
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const a = bytes[index];
      const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
      const value = (a << 16) | (b << 8) | c;
      output += BASE64URL[(value >>> 18) & 63];
      output += BASE64URL[(value >>> 12) & 63];
      if (index + 1 < bytes.length) output += BASE64URL[(value >>> 6) & 63];
      if (index + 2 < bytes.length) output += BASE64URL[value & 63];
    }
    return output;
  }

  // Digit lookup by char code. The previous implementation scanned BASE64URL
  // with indexOf for every character and then re-encoded the whole result to
  // prove canonical form, so decoding one record envelope walked its ciphertext
  // several times and allocated a JS array element per byte. Record reads decode
  // every envelope, so that cost was multiplied by the size of the library.
  const BASE64URL_DIGITS = (() => {
    const table = new Int8Array(128).fill(-1);
    for (let index = 0; index < BASE64URL.length; index += 1) {
      table[BASE64URL.charCodeAt(index)] = index;
    }
    return table;
  })();

  /**
   * Canonical unpadded base64url only, byte-identical in accept/reject and error
   * code to a decode-then-re-encode comparison. Canonical form is established by
   * three checks rather than a round trip: the charset regex, zero overflow bits
   * in the final partial group, and rejection of a trailing single character
   * (which no encoder emits and which would otherwise decode as a shorter
   * string's ciphertext). See tests/unit/private-work-product-crypto.test.js for
   * the differential proof against the round-trip definition.
   */
  function base64UrlDecode(value, expectedLength, maxLength) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('invalid_base64url');
    if (
      maxLength !== undefined &&
      value.length > Math.ceil((maxLength * 4) / 3)
    ) {
      fail('input_too_large');
    }
    const length = value.length;
    const bytes = new Uint8Array((length * 3) >> 2);
    let accumulator = 0;
    let bits = 0;
    let offset = 0;
    for (let index = 0; index < length; index += 1) {
      const digit = BASE64URL_DIGITS[value.charCodeAt(index)];
      if (digit < 0) fail('invalid_base64url');
      accumulator = ((accumulator << 6) | digit) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes[offset] = (accumulator >>> bits) & 255;
        offset += 1;
      }
    }
    if (bits && (accumulator & ((1 << bits) - 1)) !== 0) fail('invalid_base64url');
    // Order matters: a wrong length is reported ahead of non-canonical form,
    // matching the round-trip definition, which reached its length check first.
    if (expectedLength !== undefined && bytes.length !== expectedLength) fail('invalid_length');
    if (length % 4 === 1) fail('noncanonical_base64url');
    return bytes;
  }

  function assertBytes(value, length, code = 'invalid_key_material') {
    if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) fail(code);
    return new Uint8Array(value);
  }

  function assertContextString(value, code) {
    if (typeof value !== 'string' || !value || value.length > 256) fail(code);
    assertUnicodeScalarString(value);
    return value;
  }

  function exactKeys(value, expected, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
    const actual = Object.keys(value).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      fail(code);
    }
  }

  function createNonceRegistry() {
    const used = new Set();
    return Object.freeze({
      checkAndRecord(identifier) {
        if (used.has(identifier)) fail('nonce_reuse');
        used.add(identifier);
      },
      get size() {
        return used.size;
      }
    });
  }

  function createReplayRegistry() {
    const consumed = new Set();
    return Object.freeze({
      checkAndRecord(identifier) {
        if (consumed.has(identifier)) fail('replay_detected');
        consumed.add(identifier);
      },
      get size() {
        return consumed.size;
      }
    });
  }

  function createCrypto(options = {}) {
    const cryptoImpl = options.crypto;
    const Encoder = options.TextEncoder;
    const Decoder = options.TextDecoder;
    if (!cryptoImpl?.subtle || !cryptoImpl?.getRandomValues || !Encoder || !Decoder) {
      fail('crypto_capability_unavailable');
    }
    const encoder = new Encoder();
    const decoder = new Decoder('utf-8', { fatal: true });
    const nonceRegistry = createNonceRegistry();

    function utf8(value) {
      return encoder.encode(value);
    }

    function randomBytes(length) {
      if (!Number.isInteger(length) || length < 1 || length > 65536) fail('invalid_length');
      const output = new Uint8Array(length);
      cryptoImpl.getRandomValues(output);
      return output;
    }

    async function digest(bytes) {
      return new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
    }

    async function digestText(value) {
      assertUnicodeScalarString(value);
      return base64UrlEncode(await digest(utf8(value)));
    }

    async function deriveBytes(vaultKeyBytes, vaultId, purpose) {
      const keyBytes = assertBytes(vaultKeyBytes, 32);
      const vault = assertContextString(vaultId, 'invalid_vault_id');
      const label = assertContextString(purpose, 'invalid_purpose');
      const base = await cryptoImpl.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits']);
      const salt = await digest(utf8(canonicalize({ suite: SUITE, vaultId: vault })));
      const info = utf8(`questlaw/private-work-product/v1/${label}`);
      return new Uint8Array(await cryptoImpl.subtle.deriveBits({
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info
      }, base, 256));
    }

    async function deriveKey(vaultKeyBytes, vaultId, purpose, algorithm, usages) {
      const derived = await deriveBytes(vaultKeyBytes, vaultId, purpose);
      return cryptoImpl.subtle.importKey('raw', derived, algorithm, false, usages);
    }

    async function blindedIdentifier(vaultKeyBytes, context) {
      exactKeys(context, ['id', 'kind', 'vaultId'], 'invalid_identifier_context');
      const vaultId = assertContextString(context.vaultId, 'invalid_vault_id');
      const key = await deriveKey(
        vaultKeyBytes,
        vaultId,
        'blinded-identifier',
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        ['sign']
      );
      const message = canonicalize({
        id: assertContextString(context.id, 'invalid_record_id'),
        kind: assertContextString(context.kind, 'invalid_record_type'),
        suite: SUITE,
        vaultId,
        version: VERSION
      });
      return base64UrlEncode(await cryptoImpl.subtle.sign('HMAC', key, utf8(message)));
    }

    function assertPurpose(input) {
      const purpose = input.purpose === undefined ? 'record' : input.purpose;
      if (!Object.prototype.hasOwnProperty.call(AAD_PURPOSES, purpose)) fail('invalid_purpose');
      const requiredType = AAD_PURPOSES[purpose];
      if (requiredType !== null && input.recordType !== requiredType) fail('invalid_record_type');
      return purpose;
    }

    function expectedAad(input, blindId) {
      return {
        blindId,
        purpose: assertPurpose(input),
        recordType: assertContextString(input.recordType, 'invalid_record_type'),
        recordVersion: input.recordVersion,
        suite: SUITE,
        vaultId: assertContextString(input.vaultId, 'invalid_vault_id'),
        vaultGeneration: input.vaultGeneration,
        version: VERSION
      };
    }

    function assertPositiveVersion(value, code) {
      if (!Number.isSafeInteger(value) || value < 1) fail(code);
      return value;
    }

    function assertFreshness(input) {
      const trusted = assertPositiveVersion(
        input.trustedVaultGeneration,
        'freshness_unavailable'
      );
      const generation = assertPositiveVersion(
        input.vaultGeneration,
        'invalid_vault_generation'
      );
      if (generation !== trusted) fail('stale_vault_generation');
      return generation;
    }

    async function encryptRecord(input = {}) {
      const vaultKey = assertBytes(input.vaultKey, 32);
      assertPositiveVersion(input.recordVersion, 'invalid_record_version');
      assertFreshness(input);
      const blindId = await blindedIdentifier(vaultKey, {
        vaultId: input.vaultId,
        kind: input.recordType,
        id: input.recordId
      });
      const aad = expectedAad(input, blindId);
      const aadBytes = utf8(canonicalize(aad));

      if (
        Object.prototype.hasOwnProperty.call(input, 'dek') ||
        Object.prototype.hasOwnProperty.call(input, 'nonce') ||
        Object.prototype.hasOwnProperty.call(input, 'testOnlyDeterministic')
      ) {
        fail('test_material_forbidden');
      }
      const dekBytes = randomBytes(32);
      const nonce = randomBytes(12);
      const nonceIdentifier = `${base64UrlEncode(await digest(dekBytes))}:${base64UrlEncode(nonce)}`;
      nonceRegistry.checkAndRecord(nonceIdentifier);

      const dek = await cryptoImpl.subtle.importKey(
        'raw',
        dekBytes,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt']
      );
      const wrapKey = await deriveKey(
        vaultKey,
        input.vaultId,
        'record-key-wrap',
        { name: 'AES-KW', length: 256 },
        ['wrapKey']
      );
      const wrappedKey = await cryptoImpl.subtle.wrapKey('raw', dek, wrapKey, 'AES-KW');
      const plaintext = utf8(canonicalize(input.plaintext));
      const ciphertext = await cryptoImpl.subtle.encrypt({
        name: 'AES-GCM',
        iv: nonce,
        additionalData: aadBytes,
        tagLength: 128
      }, dek, plaintext);

      return {
        suite: SUITE,
        version: VERSION,
        algorithm: 'A256GCM',
        wrap: 'A256KW',
        kdf: 'HKDF-SHA-256',
        nonce: base64UrlEncode(nonce),
        wrappedKey: base64UrlEncode(wrappedKey),
        ciphertext: base64UrlEncode(ciphertext),
        aad
      };
    }

    function validateEnvelope(envelope) {
      exactKeys(envelope, ENVELOPE_KEYS, 'invalid_envelope');
      if (envelope.suite !== SUITE) fail('unsupported_suite');
      if (envelope.version !== VERSION) fail('unsupported_version');
      if (envelope.algorithm !== 'A256GCM') fail('unsupported_algorithm');
      if (envelope.wrap !== 'A256KW') fail('unsupported_wrap');
      if (envelope.kdf !== 'HKDF-SHA-256') fail('unsupported_kdf');
      base64UrlDecode(envelope.nonce, 12);
      base64UrlDecode(envelope.wrappedKey, 40);
      base64UrlDecode(envelope.ciphertext, undefined, MAX_CIPHERTEXT_BYTES);
      return envelope;
    }

    async function decryptRecord(input = {}) {
      const vaultKey = assertBytes(input.vaultKey, 32);
      assertPositiveVersion(input.recordVersion, 'invalid_record_version');
      assertFreshness(input);
      if (typeof input.envelope !== 'string') fail('canonical_envelope_required');
      if (
        !input.replayRegistry ||
        typeof input.replayRegistry.checkAndRecord !== 'function'
      ) {
        fail('freshness_unavailable');
      }
      const envelope = validateEnvelope(parseCanonical(input.envelope));
      const blindId = await blindedIdentifier(vaultKey, {
        vaultId: input.vaultId,
        kind: input.recordType,
        id: input.recordId
      });
      const aad = expectedAad(input, blindId);
      if (canonicalize(envelope.aad) !== canonicalize(aad)) fail('context_mismatch');

      try {
        const wrapKey = await deriveKey(
          vaultKey,
          input.vaultId,
          'record-key-wrap',
          { name: 'AES-KW', length: 256 },
          ['unwrapKey']
        );
        const dek = await cryptoImpl.subtle.unwrapKey(
          'raw',
          base64UrlDecode(envelope.wrappedKey, 40),
          wrapKey,
          'AES-KW',
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
        const plaintext = await cryptoImpl.subtle.decrypt({
          name: 'AES-GCM',
          iv: base64UrlDecode(envelope.nonce, 12),
          additionalData: utf8(canonicalize(aad)),
          tagLength: 128
        }, dek, base64UrlDecode(envelope.ciphertext));
        const value = parseCanonical(decoder.decode(plaintext));
        const envelopeDigest = base64UrlEncode(await digest(utf8(input.envelope)));
        input.replayRegistry.checkAndRecord(canonicalize({
          blindId,
          envelopeDigest,
          recordVersion: input.recordVersion,
          vaultGeneration: input.vaultGeneration
        }));
        return value;
      } catch (error) {
        if (error instanceof CryptoError) throw error;
        fail('authentication_failed');
      }
    }

    async function generateDeviceWrapKey() {
      try {
        return await cryptoImpl.subtle.generateKey(
          { name: 'AES-KW', length: 256 },
          false,
          ['wrapKey', 'unwrapKey']
        );
      } catch (_) {
        fail('crypto_operation_failed');
      }
    }

    function assertDeviceWrapKey(key) {
      if (
        !key ||
        key.type !== 'secret' ||
        key.extractable !== false ||
        key.algorithm?.name !== 'AES-KW' ||
        key.algorithm?.length !== 256 ||
        !Array.isArray(key.usages) ||
        !key.usages.includes('wrapKey') ||
        !key.usages.includes('unwrapKey')
      ) {
        fail('invalid_device_key');
      }
      return key;
    }

    async function wrapVaultKeyWithDevice(vaultKeyBytes, deviceWrapKey) {
      try {
        const vaultKey = await cryptoImpl.subtle.importKey(
          'raw',
          assertBytes(vaultKeyBytes, 32),
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        return base64UrlEncode(await cryptoImpl.subtle.wrapKey(
          'raw',
          vaultKey,
          assertDeviceWrapKey(deviceWrapKey),
          'AES-KW'
        ));
      } catch (error) {
        if (error instanceof CryptoError) throw error;
        fail('device_wrap_failed');
      }
    }

    async function unwrapVaultKeyWithDevice(wrappedVaultKey, deviceWrapKey) {
      try {
        const key = await cryptoImpl.subtle.unwrapKey(
          'raw',
          base64UrlDecode(wrappedVaultKey, 40),
          assertDeviceWrapKey(deviceWrapKey),
          'AES-KW',
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        return new Uint8Array(await cryptoImpl.subtle.exportKey('raw', key));
      } catch (_) {
        fail('device_unwrap_failed');
      }
    }

    function generateRecoveryCode() {
      return base64UrlEncode(randomBytes(32));
    }

    async function recoveryWrapKey(recoveryCode, vaultId, vaultGeneration, usage) {
      const code = base64UrlDecode(recoveryCode, 32);
      return deriveKey(
        code,
        vaultId,
        `recovery-key-wrap/generation/${assertPositiveVersion(
          vaultGeneration,
          'invalid_vault_generation'
        )}`,
        { name: 'AES-KW', length: 256 },
        [usage]
      );
    }

    async function wrapVaultKeyWithRecovery(
      vaultKeyBytes,
      recoveryCode,
      vaultId,
      vaultGeneration
    ) {
      try {
        const vaultKey = await cryptoImpl.subtle.importKey(
          'raw',
          assertBytes(vaultKeyBytes, 32),
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        const key = await recoveryWrapKey(
          recoveryCode,
          vaultId,
          vaultGeneration,
          'wrapKey'
        );
        return base64UrlEncode(await cryptoImpl.subtle.wrapKey('raw', vaultKey, key, 'AES-KW'));
      } catch (error) {
        if (error instanceof CryptoError) throw error;
        fail('crypto_operation_failed');
      }
    }

    async function unwrapVaultKeyWithRecovery(
      wrappedVaultKey,
      recoveryCode,
      vaultId,
      vaultGeneration,
      trustedVaultGeneration
    ) {
      try {
        assertFreshness({ vaultGeneration, trustedVaultGeneration });
        const key = await recoveryWrapKey(
          recoveryCode,
          vaultId,
          vaultGeneration,
          'unwrapKey'
        );
        const vaultKey = await cryptoImpl.subtle.unwrapKey(
          'raw',
          base64UrlDecode(wrappedVaultKey, 40),
          key,
          'AES-KW',
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        return new Uint8Array(await cryptoImpl.subtle.exportKey('raw', vaultKey));
      } catch (error) {
        if (
          error instanceof CryptoError &&
          (
            error.code === 'freshness_unavailable' ||
            error.code === 'stale_vault_generation'
          )
        ) {
          throw error;
        }
        fail('recovery_unwrap_failed');
      }
    }

    function fixedAsync(operation, code = 'crypto_operation_failed') {
      return async (...args) => {
        try {
          return await operation(...args);
        } catch (error) {
          if (error instanceof CryptoError) throw error;
          fail(code);
        }
      };
    }

    function fixedSync(operation, code = 'crypto_operation_failed') {
      return (...args) => {
        try {
          return operation(...args);
        } catch (error) {
          if (error instanceof CryptoError) throw error;
          fail(code);
        }
      };
    }

    return Object.freeze({
      randomBytes: fixedSync(randomBytes),
      digestText: fixedAsync(digestText),
      deriveBytes: fixedAsync(deriveBytes),
      blindedIdentifier: fixedAsync(blindedIdentifier),
      encryptRecord: fixedAsync(encryptRecord),
      decryptRecord: fixedAsync(decryptRecord),
      generateDeviceWrapKey: fixedAsync(generateDeviceWrapKey),
      wrapVaultKeyWithDevice: fixedAsync(wrapVaultKeyWithDevice),
      unwrapVaultKeyWithDevice: fixedAsync(unwrapVaultKeyWithDevice),
      generateRecoveryCode: fixedSync(generateRecoveryCode),
      wrapVaultKeyWithRecovery: fixedAsync(wrapVaultKeyWithRecovery),
      unwrapVaultKeyWithRecovery: fixedAsync(unwrapVaultKeyWithRecovery),
      serializeEnvelope: envelope => canonicalize(validateEnvelope(envelope)),
      parseEnvelope: text => validateEnvelope(parseCanonical(text))
    });
  }

const privateWorkProductCrypto = Object.freeze({
  SUITE,
  VERSION,
  CryptoError,
  canonicalize,
  parseCanonical,
  base64UrlEncode,
  base64UrlDecode,
  bytesEqual,
  createNonceRegistry,
  createReplayRegistry,
  createCrypto
});

if (typeof module !== 'undefined' && module.exports) module.exports = privateWorkProductCrypto;

if (typeof self !== 'undefined') {
  self.QuestLaw = self.QuestLaw || {};
  self.QuestLaw.PrivateWorkProductCrypto = privateWorkProductCrypto;
}
