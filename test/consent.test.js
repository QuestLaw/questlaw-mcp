/**
 * The disclosure gate. What matters isn't that consent can be given but that the
 * default is no, a stale acceptance doesn't carry forward, and refusal stops the
 * read before anything is decrypted.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PACKAGE_ROOT = path.join(__dirname, '..');
const { ensureFixture } = require('./helpers/vault-fixture');

function scratchConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'questlaw-consent-'));
}

/** Evaluate in a child, because src/consent.js reads process.env at call time. */
function evaluate(script, env) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: PACKAGE_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8'
  }).trim();
}

const STATE = 'process.stdout.write(JSON.stringify(require("./src/consent").consentState()))';

test('consent defaults to no', () => {
  const dir = scratchConfig();
  try {
    const state = JSON.parse(evaluate(STATE, { QUESTLAW_CONFIG_DIR: dir }));
    assert.equal(state.granted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the environment acknowledgement must match exactly', () => {
  const dir = scratchConfig();
  try {
    for (const value of ['yes', 'true', '1', 'I-UNDERSTAND', 'i understand', '']) {
      const state = JSON.parse(evaluate(STATE,
        { QUESTLAW_CONFIG_DIR: dir, QUESTLAW_DISCLOSURE_ACK: value }));
      assert.equal(state.granted, false, `QUESTLAW_DISCLOSURE_ACK=${value} must not grant consent`);
    }
    const granted = JSON.parse(evaluate(STATE,
      { QUESTLAW_CONFIG_DIR: dir, QUESTLAW_DISCLOSURE_ACK: 'i-understand' }));
    assert.equal(granted.granted, true);
    assert.equal(granted.via, 'environment');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a recorded acceptance is honoured, and a stale revision is not', () => {
  const dir = scratchConfig();
  const { DISCLOSURE_REVISION } = require('../src/consent');
  try {
    const file = path.join(dir, 'consent.json');
    fs.writeFileSync(file, JSON.stringify({
      accepted: true, revision: DISCLOSURE_REVISION, at: '2026-01-01T00:00:00.000Z'
    }));
    assert.equal(JSON.parse(evaluate(STATE, { QUESTLAW_CONFIG_DIR: dir })).granted, true);

    // The disclosure text changed since they agreed, so the old yes no longer counts.
    fs.writeFileSync(file, JSON.stringify({
      accepted: true, revision: DISCLOSURE_REVISION - 1, at: '2026-01-01T00:00:00.000Z'
    }));
    assert.equal(JSON.parse(evaluate(STATE, { QUESTLAW_CONFIG_DIR: dir })).granted, false);

    // An explicit refusal isn't consent either.
    fs.writeFileSync(file, JSON.stringify({
      accepted: false, revision: DISCLOSURE_REVISION, at: '2026-01-01T00:00:00.000Z'
    }));
    assert.equal(JSON.parse(evaluate(STATE, { QUESTLAW_CONFIG_DIR: dir })).granted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt consent file reads as no, not as a crash', () => {
  const dir = scratchConfig();
  try {
    fs.writeFileSync(path.join(dir, 'consent.json'), '{ not json');
    assert.equal(JSON.parse(evaluate(STATE, { QUESTLAW_CONFIG_DIR: dir })).granted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The gate has to close before the file is opened. A server that decrypts and
 * then declines to answer has already done what consent was protecting against.
 */
test('without consent nothing is decrypted at all', async () => {
  const fixture = await ensureFixture();
  const dir = scratchConfig();
  try {
    const script = 'const s = require("./src/snapshot").createSnapshotStore({'
      + ' target: process.env.F, recoveryCode: process.env.K });'
      + ' s.load().then(() => process.stdout.write("SERVED"),'
      + ' error => process.stdout.write(error.code));';
    const result = evaluate(script, {
      QUESTLAW_CONFIG_DIR: dir,
      F: fixture.file,
      K: fixture.recoveryCode
    });
    assert.equal(result, 'disclosure_not_accepted');

    // The same call with consent granted does serve, which shows the refusal above
    // is the gate and not an unrelated failure.
    const served = evaluate(script, {
      QUESTLAW_CONFIG_DIR: dir,
      QUESTLAW_DISCLOSURE_ACK: 'i-understand',
      F: fixture.file,
      K: fixture.recoveryCode
    });
    assert.equal(served, 'SERVED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Consent has to come before the key is even asked for, not just before the
 * decrypt. Reading the secret store can show a keychain prompt, and it hands the
 * key to this process, both of which an unconsented install must not do. This
 * drives the real server wiring, with the key reader wrapped to count its calls.
 */
test('the server asks the secret store for nothing until consent is given', async () => {
  const fixture = await ensureFixture();
  const dir = scratchConfig();
  const script = 'const credentials = require("./src/credentials");'
    + ' const read = credentials.resolveVaultKey; let reads = 0;'
    + ' credentials.resolveVaultKey = () => { reads += 1; return read(); };'
    + ' const { store } = require("./src/server").createServer({ log: () => {} });'
    + ' store.start().then(() => process.stdout.write(JSON.stringify('
    + '{ reads, state: store.status().state, code: store.status().error?.code })));';
  const env = {
    QUESTLAW_CONFIG_DIR: dir,
    QUESTLAW_VAULT_FILE: fixture.file,
    QUESTLAW_ALLOW_ENV_KEY: '1',
    QUESTLAW_RECOVERY_CODE: fixture.recoveryCode
  };
  try {
    assert.deepEqual(JSON.parse(evaluate(script, env)),
      { reads: 0, state: 'unavailable', code: 'disclosure_not_accepted' });
    // With consent, the same wiring reads the key once and serves, so the zero
    // above is the gate and not a reader that was never connected.
    assert.deepEqual(JSON.parse(evaluate(script, { ...env, QUESTLAW_DISCLOSURE_ACK: 'i-understand' })),
      { reads: 1, state: 'loaded' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `consent --revoke` says the server will serve nothing until consent is given
 * again. That has to hold for a server already running, including through a
 * reload, which otherwise keeps serving the library it already has.
 */
test('revoking consent stops a running server, and accepting again resumes it', async () => {
  const fixture = await ensureFixture();
  const dir = scratchConfig();
  const script = `
    const fs = require('fs');
    const { record } = require('./cli/consent');
    const { consentFile } = require('./src/consent');
    const store = require('./src/snapshot').createSnapshotStore(
      { target: process.env.F, recoveryCode: process.env.K, freshnessIntervalMs: 0 });
    const outcome = promise => promise.then(() => 'served', error => error.code);
    (async () => {
      const seen = [];
      record();
      await store.load();
      seen.push(await outcome(store.ready()));
      fs.unlinkSync(consentFile());
      seen.push(await outcome(store.ready()), store.status().state);
      seen.push(await outcome(store.reload()), store.status().state);
      record();
      seen.push(await outcome(store.ready()));
      process.stdout.write(JSON.stringify(seen));
    })();`;
  try {
    assert.deepEqual(JSON.parse(evaluate(script, {
      QUESTLAW_CONFIG_DIR: dir, F: fixture.file, K: fixture.recoveryCode
    })), [
      'served',
      'disclosure_not_accepted', 'unavailable',
      'disclosure_not_accepted', 'unavailable',
      'served'
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the disclosure names what actually becomes readable', () => {
  const { DISCLOSURE } = require('../src/consent');
  for (const claim of [/notes/i, /quotation/i, /opinion/i, /read-only/i, /provider/i]) {
    assert.match(DISCLOSURE, claim);
  }
  // The encrypted export carries opinion bodies that the ordinary JSON export
  // filters out. If that sentence goes missing, the disclosure understates what is shared.
  assert.match(DISCLOSURE, /carries more than/i);
});
