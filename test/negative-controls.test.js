/**
 * The security argument, as tests. Every case here is a file or a code that must
 * NOT open the library. They were standalone scripts in the prototype, so the
 * claim rested on someone remembering to run them, and failing closed is the
 * whole product promise.
 *
 * Each control asserts the specific gate that closed, not just that something
 * threw. A tampered record must fail its digest, not fail to parse.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('crypto');

const { ensureFixture, writeVariant } = require('./helpers/vault-fixture');
const { readEncryptedLibrary } = require('../src/reader');
const { Crypto } = require('../src/core-modules');

let fixture;
test.before(async () => { fixture = await ensureFixture(); });

const cryptoApi = () => Crypto.createCrypto({ crypto: webcrypto, TextEncoder, TextDecoder });

/** Flip one base64url character of the ciphertext that starts at `from`. */
function flipCiphertext(text, from) {
  const at = text.indexOf('ciphertext', from) + 30;
  return text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1);
}

async function refuses(label, text, expected) {
  const file = writeVariant(text, 'tamper');
  await assert.rejects(
    () => readEncryptedLibrary(file, fixture.recoveryCode),
    error => {
      assert.equal(error.code, expected.code, `${label}: wrong error code (${error.code})`);
      if (expected.detail instanceof RegExp) {
        assert.match(error.detail, expected.detail, `${label}: wrong detail (${error.detail})`);
      } else if (expected.detail) {
        assert.equal(error.detail, expected.detail, `${label}: wrong detail (${error.detail})`);
      }
      return true;
    },
    `${label} must not decrypt`
  );
}

test('a wrong recovery code of the right shape is refused', async () => {
  const wrong = cryptoApi().generateRecoveryCode();
  await assert.rejects(
    () => readEncryptedLibrary(fixture.file, wrong),
    error => error.code === 'recovery_unwrap_failed'
  );
});

test('a malformed recovery code is refused before any crypto runs', async () => {
  await assert.rejects(
    () => readEncryptedLibrary(fixture.file, 'not-a-code'),
    error => error.code === 'recovery_code_malformed'
  );
});

test('a tampered record ciphertext fails its manifest digest', async () => {
  const recordsAt = fixture.text.indexOf('"records":[');
  await refuses('record ciphertext', flipCiphertext(fixture.text, recordsAt),
    { code: 'vault_integrity_failed', detail: 'record_digest_mismatch' });
});

test('a tampered head envelope fails authentication', async () => {
  await refuses('head envelope', flipCiphertext(fixture.text, 0),
    { code: 'vault_integrity_failed', detail: 'authentication_failed' });
});

test('a tampered manifest shard fails authentication', async () => {
  const shardsAt = fixture.text.indexOf('"shards":[');
  await refuses('shard envelope', flipCiphertext(fixture.text, shardsAt),
    { code: 'vault_integrity_failed', detail: 'authentication_failed' });
});

test('a rewritten head digest is caught even though the head decrypts', async () => {
  const rewritten = fixture.text.replace(
    /"headDigest":"([A-Za-z0-9_-])/,
    (_, first) => `"headDigest":"${first === 'A' ? 'B' : 'A'}`
  );
  await refuses('head digest', rewritten,
    { code: 'vault_integrity_failed', detail: 'head_digest_mismatch' });
});

test('a bumped vault generation cannot be unwrapped with the current code', async () => {
  await assert.rejects(
    () => readEncryptedLibrary(
      writeVariant(fixture.text.replace('"vaultGeneration":1', '"vaultGeneration":2'), 'tamper'),
      fixture.recoveryCode),
    error => error.code === 'recovery_unwrap_failed'
  );
});

test('a rewritten vault id cannot be unwrapped: the id is bound into the key', async () => {
  const renamed = fixture.text.replace(
    /"vaultId":"vault_[A-Za-z0-9_-]+"/g, '"vaultId":"vault_aaaaaaaaaaaaaaaaaaaaaa"');
  await assert.rejects(
    () => readEncryptedLibrary(writeVariant(renamed, 'tamper'), fixture.recoveryCode),
    error => error.code === 'recovery_unwrap_failed'
  );
});

test('a record removed from the file is caught by the manifest', async () => {
  const dropped = fixture.text.replace(
    /\{"blindId":"[^"]+","envelope":"(?:[^"\\]|\\.)*"\},/, '');
  assert.notEqual(dropped.length, fixture.text.length, 'the tamper itself must have applied');
  await refuses('dropped record', dropped,
    { code: 'vault_integrity_failed', detail: 'manifest_record_count_mismatch' });
});

/**
 * The blind id binds a record to its envelope. Swapping two envelopes is caught
 * by whichever manifest gate fires first (size, then digest), and both are
 * checked before anything reaches decryptRecord.
 */
test('two records swapped between blind ids are refused by the manifest', async () => {
  const rows = [...fixture.text.matchAll(/\{"blindId":"([^"]+)","envelope":"((?:[^"\\]|\\.)*)"\}/g)];
  assert.ok(rows.length >= 2, 'fixture needs at least two records');
  const [first, second] = rows;
  const swapped = fixture.text
    .replace(first[0], `{"blindId":"${first[1]}","envelope":"${second[2]}"}`)
    .replace(second[0], `{"blindId":"${second[1]}","envelope":"${first[2]}"}`);
  await refuses('swapped records', swapped,
    { code: 'vault_integrity_failed', detail: /^record_(size|digest)_mismatch$/ });
});

test('non-canonical framing is refused outright', async () => {
  await refuses('non-canonical framing', fixture.text.replace('{"head":', '{"head": '),
    { code: 'invalid_export_file', detail: 'invalid_encrypted_export' });
});

test('a truncated file is refused rather than partially read', async () => {
  await refuses('truncated file', fixture.text.slice(0, Math.floor(fixture.text.length / 2)),
    { code: 'invalid_export_file' });
});

/**
 * Why reading Chrome's IndexedDB from disk is impossible and not just hard: the
 * device wrap key is generated non-extractable, so an offline process holding the
 * whole Chrome profile has ciphertext and an unusable key handle.
 */
test('the device wrap key cannot be exported, at any privilege level', async () => {
  const deviceKey = await cryptoApi().generateDeviceWrapKey();
  assert.equal(deviceKey.type, 'secret');
  assert.equal(deviceKey.extractable, false);
  assert.equal(deviceKey.algorithm.name, 'AES-KW');
  await assert.rejects(() => webcrypto.subtle.exportKey('raw', deviceKey), /not extractable/);
});

test('the control read still works after all of that', async () => {
  const result = await readEncryptedLibrary(fixture.file, fixture.recoveryCode);
  assert.equal(result.decrypted, result.recordCount);
  assert.ok(result.decrypted > 0);
});
