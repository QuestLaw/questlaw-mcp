/**
 * Custody resolution. The keychain itself isn't exercised, since that would write
 * to the developer's login keychain, so these cover the decision logic around it,
 * which is where mistakes would be.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const PACKAGE_ROOT = path.join(__dirname, '..');

/**
 * What a child needs to run the platform's secret store at all. PowerShell
 * without SystemRoot, APPDATA, and the rest hangs until the read times out, which
 * tests nothing but the timeout.
 */
const PLATFORM_ENV = Object.fromEntries(['PATH', 'HOME', 'SystemRoot', 'windir', 'APPDATA',
  'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']
  .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));

/** Resolve in a child process, since the module reads process.env and platform. */
function resolveWith(env) {
  const script = 'try {'
    + ' process.stdout.write("ok:" + require("./src/credentials").resolveVaultKey()); }'
    + ' catch (error) { process.stdout.write("err:" + error.code + ":" + error.hint); }';
  return execFileSync(process.execPath, ['-e', script], {
    cwd: PACKAGE_ROOT,
    env: { ...PLATFORM_ENV, ...env },
    encoding: 'utf8'
  });
}

// A keychain account name no test run will have created.
const ABSENT = { QUESTLAW_KEY_ACCOUNT: 'questlaw-mcp-test-absent-account' };
const KEY = 'A'.repeat(43);

test('an environment key is refused without the opt-in', () => {
  const result = resolveWith({ ...ABSENT, QUESTLAW_RECOVERY_CODE: KEY });
  assert.match(result, /^err:account_key_unavailable:/);
});

/**
 * The opt-in has to beat the keychain. Its purpose is opening a vault other than
 * the one the keychain holds, and a developer with a real key stored couldn't run
 * this suite otherwise.
 */
test('the opt-in outranks a stored keychain item', t => {
  // The macOS keychain is the only store this can drive without installing one
  // (a Linux runner has no libsecret daemon and Windows has no `security`).
  // Skipping elsewhere follows test/vendor.test.js.
  if (process.platform !== 'darwin') return t.skip('macOS keychain only');
  const service = require('../src/credentials').SERVICE;
  const name = `questlaw-mcp-precedence-${process.pid}`;
  const stored = 'B'.repeat(43);
  execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', name, '-w', stored]);
  try {
    assert.equal(resolveWith({ QUESTLAW_KEY_ACCOUNT: name }), `ok:${stored}`);
    assert.equal(
      resolveWith({ QUESTLAW_KEY_ACCOUNT: name, QUESTLAW_RECOVERY_CODE: KEY, QUESTLAW_ALLOW_ENV_KEY: '1' }),
      `ok:${KEY}`
    );
  } finally {
    execFileSync('security', ['delete-generic-password', '-s', service, '-a', name],
      { stdio: 'ignore' });
  }
});

test('the opt-in accepts an environment key', () => {
  const result = resolveWith({ ...ABSENT, QUESTLAW_RECOVERY_CODE: KEY, QUESTLAW_ALLOW_ENV_KEY: '1' });
  assert.equal(result, `ok:${KEY}`);
});

test('the opt-in must be exactly 1, so a stray value is not a yes', () => {
  for (const value of ['true', 'yes', '0', '']) {
    const result = resolveWith({ ...ABSENT, QUESTLAW_RECOVERY_CODE: KEY, QUESTLAW_ALLOW_ENV_KEY: value });
    assert.match(result, /^err:account_key_unavailable:/, `QUESTLAW_ALLOW_ENV_KEY=${value}`);
  }
});

test('with nothing anywhere, the error names the command that fixes it', () => {
  const result = resolveWith(ABSENT);
  assert.match(result, /^err:account_key_unavailable:/);
  assert.match(result, /questlaw-library-mcp setup/);
  // Same check through the direct route, with the account it actually looked for.
  assert.match(result, /questlaw-mcp-test-absent-account/);
});

test('every platform\'s store hint names a non-default account', () => {
  const { PROVIDERS } = require('../src/credentials');
  for (const [platform, impl] of Object.entries(PROVIDERS)) {
    assert.match(impl.store('work.2024'), /work\.2024/, platform);
  }
});

test('a missing secret-store item reads as absent rather than throwing', () => {
  const { readSecretStore } = require('../src/credentials');
  assert.equal(readSecretStore('questlaw-mcp-test-absent-account'), '');
});

/**
 * A store that isn't installed (no `secret-tool` on a bare Linux box) must look
 * like a miss, not a crash. ENOENT from the spawn is the common case and the one
 * most likely to be mishandled.
 */
test('a secret store that is not installed reads as absent', () => {
  const { readSecretStore } = require('../src/credentials');
  const missing = {
    label: 'imaginary store',
    command: 'questlaw-no-such-binary-xyz',
    argv: account => ['lookup', account],
    env: null,
    store: () => 'n/a'
  };
  assert.equal(readSecretStore('default', missing), '');
});

test('custodyStatus reports custody without revealing the secret', () => {
  const { custodyStatus, SERVICE } = require('../src/credentials');
  const status = custodyStatus();
  assert.equal(typeof status.account, 'string');
  assert.equal(status.platform, process.platform);
  assert.equal(typeof status.storeHasKey, 'boolean');
  // Nothing in the report may be, or contain, key material.
  const serialized = JSON.stringify(status);
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(serialized), 'status must not carry a 43-char key');
  assert.ok(serialized.includes(SERVICE));
});

/**
 * Windows joins the account into a file path, `%APPDATA%\questlaw-library-mcp\
 * <account>.dpapi`, on read and on write. Keeping it one argv entry stops command
 * injection but not a path that walks out of that directory, so the name itself
 * is validated before any store is touched.
 */
test('an account name that could leave the key directory is refused', () => {
  const { checkAccount } = require('../src/credentials');
  const dir = 'C:\\Users\\a\\AppData\\Roaming\\questlaw-library-mcp';
  const dpapi = name => path.win32.join(dir, `${name}.dpapi`);

  for (const name of ['default', 'work', 'client.2024', 'a-b_c', '.hidden', 'x'.repeat(64)]) {
    assert.equal(checkAccount(name), name);
    assert.equal(path.win32.dirname(dpapi(name)), dir, `${name} stays in the key directory`);
  }

  const hostile = ['..\\..\\x', '../x', '..', '.', '...', 'C:x', 'a/b', 'a\\b', 'a b',
    'a;b', '"', '', 'x'.repeat(65), 'caf\u00e9'];
  for (const name of hostile) {
    assert.throws(() => checkAccount(name), error => error.code === 'invalid_key_account'
      && /QUESTLAW_KEY_ACCOUNT/.test(error.hint), JSON.stringify(name));
  }
  // The point of the check: without it, these would have escaped.
  assert.notEqual(path.win32.dirname(dpapi('..\\..\\x')), dir);
});

test('an unusable QUESTLAW_KEY_ACCOUNT fails as a structured error, not a lookup', () => {
  const result = resolveWith({ QUESTLAW_KEY_ACCOUNT: '..\\..\\evil' });
  assert.match(result, /^err:invalid_key_account:/);
});

test('the key is not written under an unusable account name', () => {
  const { storeKey } = require('../cli/keystore');
  // Refused before any store is spawned, so this touches no keychain.
  assert.throws(() => storeKey('../escape', KEY), error => error.code === 'invalid_key_account');
});
