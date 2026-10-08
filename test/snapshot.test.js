/**
 * Finding the export, and what happens when the newest one is unreadable.
 */
'use strict';

// A loaded library needs disclosure consent, and test/consent.test.js covers refusing it.
require('./helpers/consent');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureFixture } = require('./helpers/vault-fixture');
const { createSnapshotStore, findVaultFile } = require('../src/snapshot');
const { LibraryError } = require('../src/errors');
const { createTools } = require('../src/tools');

let fixture;
test.before(async () => { fixture = await ensureFixture(); });

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'questlaw-snapshot-'));
}

/** Copy the fixture in under `name`, with an explicit modification time. */
function place(dir, name, mtimeMs, text = fixture.text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('a directory resolves to its newest export', () => {
  const dir = scratchDir();
  place(dir, 'questlaw-backup-2026-01-01.qlvault', Date.now() - 86400000);
  const newest = place(dir, 'questlaw-backup-2026-09-01.qlvault', Date.now());
  place(dir, 'notes.txt', Date.now());

  assert.equal(findVaultFile(dir), newest);
  assert.equal(findVaultFile(fixture.file), fixture.file);
});

/**
 * A download folder is shared with a browser that renames and deletes files as it
 * goes. A directory that happens to end in .qlvault, or a file that vanished
 * between the listing and the stat (a dangling link stands in for it here), must
 * not hide or fail the real export beside it.
 */
test('the newest export is found past entries that are not readable exports', t => {
  const dir = scratchDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = place(dir, 'questlaw-backup-2026-09-01.qlvault', Date.now() - 86400000);
  const folder = path.join(dir, 'questlaw-backup-2026-12-31.qlvault');
  fs.mkdirSync(folder);
  fs.utimesSync(folder, Date.now() / 1000, Date.now() / 1000);
  assert.equal(findVaultFile(dir), real, 'a directory named like an export is skipped');

  // Creating links needs extra privileges on Windows.
  if (process.platform === 'win32') return;
  fs.symlinkSync(path.join(dir, 'gone.qlvault'), path.join(dir, 'questlaw-backup-vanished.qlvault'));
  assert.equal(findVaultFile(dir), real, 'an entry that fails to stat is skipped');

  const target = place(dir, 'elsewhere.bin', Date.now());
  const link = path.join(dir, 'questlaw-backup-linked.qlvault');
  fs.symlinkSync(target, link);
  assert.equal(findVaultFile(dir), link, 'a link to a newer export is still an export');
});

test('an unset location falls back to the download folder', () => {
  const { DEFAULT_TARGET } = require('../src/snapshot');
  assert.equal(DEFAULT_TARGET, '~/Downloads');
  // Resolution either finds an export there or reports that folder by name, and
  // either way must not say "not configured".
  try {
    assert.ok(findVaultFile('').endsWith('.qlvault'));
  } catch (error) {
    assert.equal(error.code, 'vault_file_missing');
    assert.match(error.message, /Downloads/);
  }
});

test('Desktop default placeholders resolve to the download folder', t => {
  const home = scratchDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const downloads = path.join(home, 'Downloads');
  fs.mkdirSync(downloads);
  const newest = place(downloads, 'library.qlvault', Date.now());
  t.mock.method(os, 'homedir', () => home);
  // eslint-disable-next-line no-template-curly-in-string
  const legacy = '${DOWNLOADS}';
  // eslint-disable-next-line no-template-curly-in-string
  const current = '${HOME}/Downloads';
  for (const target of [legacy, `/${legacy}`, current, '~/Downloads']) {
    assert.equal(findVaultFile(target), newest, `${target} must resolve under the home directory`);
  }
  assert.equal(findVaultFile(downloads), newest, 'explicit paths must still work');
});

test('an empty folder says what to do about it', () => {
  assert.throws(() => findVaultFile(scratchDir()), error => {
    assert.equal(error.code, 'vault_file_missing');
    assert.match(error.hint, /Export a backup/);
    return true;
  });
});

test('a home-relative path is expanded, because a client config is not a shell', () => {
  const resolved = (() => {
    try { return findVaultFile('~'); } catch (error) { return error; }
  })();
  // `~` is a directory with no exports on a normal machine, so the point is that
  // it resolved under the home directory and not to "./~".
  const reported = resolved instanceof Error ? resolved.message : resolved;
  assert.ok(reported.includes(os.homedir()), reported);
});

test('an unreadable new export does not cost the library already in memory', async () => {
  const dir = scratchDir();
  place(dir, 'good.qlvault', Date.now() - 60000);
  const store = createSnapshotStore({ target: dir, recoveryCode: fixture.recoveryCode });

  const first = await store.load();
  assert.equal(first.decrypted, 15);

  // The user exports again and the file is truncated in transit.
  place(dir, 'newer.qlvault', Date.now(), fixture.text.slice(0, 4000));

  await assert.rejects(() => store.load(), error => {
    assert.equal(error.code, 'invalid_export_file');
    assert.match(error.message, /Still serving the snapshot read at/);
    return true;
  });

  assert.equal(store.require().decrypted, 15, 'the working snapshot must survive');
  assert.equal(store.status().state, 'loaded');
  assert.equal(store.status().lastReloadError.code, 'invalid_export_file');
});

test('a store that never loaded reports why, not undefined', async () => {
  const store = createSnapshotStore({ target: scratchDir(), recoveryCode: fixture.recoveryCode });
  assert.throws(() => store.require(), error => error.code === 'library_not_loaded');
  await assert.rejects(() => store.load(), error => error.code === 'vault_file_missing');
  assert.throws(() => store.require(), error => error.code === 'vault_file_missing');
  assert.equal(store.status().state, 'unavailable');
  assert.equal(store.status().error.code, 'vault_file_missing');
});

/**
 * The transport must be able to answer `initialize` while the read is still
 * running. A 20,000-record library takes about eleven seconds to decrypt, and a
 * client that waits that long for a handshake gives up on the server.
 */
test('the first read runs in the background and the first tool call waits for it', async () => {
  const dir = scratchDir();
  place(dir, 'good.qlvault', Date.now());
  const store = createSnapshotStore({ target: dir, recoveryCode: fixture.recoveryCode });

  const started = store.start();
  // Still in flight, so a synchronous reader gets an honest "not yet" instead of a stall.
  assert.throws(() => store.require(), error => error.code === 'library_not_loaded');
  assert.equal(store.status().state, 'unavailable');

  assert.equal((await store.ready()).decrypted, 15);
  assert.equal(await started, true);
  assert.equal(store.status().state, 'loaded');
});

test('a background read that fails still resolves, carrying its reason', async () => {
  const store = createSnapshotStore({ target: scratchDir(), recoveryCode: fixture.recoveryCode });
  assert.equal(await store.start(), false);
  await assert.rejects(() => store.ready(), error => error.code === 'vault_file_missing');
});

/**
 * A fresh backup lands in the folder while the server runs. It's read on the next
 * call, without anyone needing to know reload_snapshot exists.
 */
test('a newer export is picked up by the next call on its own', async () => {
  const dir = scratchDir();
  place(dir, 'older.qlvault', Date.now() - 60000);
  const store = createSnapshotStore({
    target: dir, recoveryCode: fixture.recoveryCode, freshnessIntervalMs: 0
  });
  const first = await store.load();
  assert.match(first.sourceFile, /older\.qlvault$/);

  // Unchanged, so it's the same snapshot object and not a re-read.
  assert.equal(await store.ready(), first);

  const newer = place(dir, 'newer.qlvault', Date.now());
  const second = await store.ready();
  assert.notEqual(second, first);
  assert.equal(second.sourceFile, newer);
});

test('a newer export that cannot be read does not fail the call', async () => {
  const dir = scratchDir();
  place(dir, 'good.qlvault', Date.now() - 60000);
  const store = createSnapshotStore({
    target: dir, recoveryCode: fixture.recoveryCode, freshnessIntervalMs: 0
  });
  const first = await store.load();

  place(dir, 'newer.qlvault', Date.now(), fixture.text.slice(0, 4000));
  assert.equal(await store.ready(), first, 'the working library keeps answering');
  assert.equal(store.status().lastReloadError.code, 'invalid_export_file');

  // The overview says so, instead of presenting the older library as current.
  const overview = createTools(store).find(tool => tool.name === 'library_overview');
  const { snapshot } = await overview.run({});
  assert.equal(snapshot.newerExportUnreadable.code, 'invalid_export_file');
  assert.match(snapshot.sourceFile, /good\.qlvault$/);
});

test('an export that appears after a failed start is read on the next call', async () => {
  const dir = scratchDir();
  const store = createSnapshotStore({
    target: dir, recoveryCode: fixture.recoveryCode, freshnessIntervalMs: 0
  });
  assert.equal(await store.start(), false);
  await assert.rejects(() => store.ready(), error => error.code === 'vault_file_missing');

  place(dir, 'first.qlvault', Date.now());
  assert.equal((await store.ready()).decrypted, 15);
});

test('prepare runs before a snapshot is served, and progress reaches a waiting caller', async () => {
  const dir = scratchDir();
  place(dir, 'good.qlvault', Date.now());
  const prepared = [];
  const store = createSnapshotStore({
    target: dir, recoveryCode: fixture.recoveryCode,
    prepare: snapshot => prepared.push(snapshot)
  });
  const seen = [];
  store.start();
  const snapshot = await store.ready({ onProgress: step => seen.push(step) });

  assert.deepEqual(prepared, [snapshot]);
  assert.ok(seen.length >= 4, 'expected every stage of the read');
  const values = seen.map(step => step.progress);
  assert.deepEqual(values, [...values].sort((left, right) => left - right));
  assert.equal(seen[seen.length - 1].progress, seen[seen.length - 1].total);
  assert.match(seen[seen.length - 1].message, /index/);
});

/**
 * The hint for a missing key says to run `setup`. A server already running has
 * to notice the stored key on its own, since the key is read per load and the
 * user has nothing else to restart from inside the client.
 */
test('a key stored after startup is picked up by the next call', async () => {
  let stored = '';
  let reads = 0;
  const store = createSnapshotStore({
    target: fixture.file,
    freshnessIntervalMs: 0,
    resolveKey: () => {
      reads += 1;
      if (stored) return stored;
      throw new LibraryError('account_key_unavailable', 'No key yet.');
    }
  });
  assert.equal(await store.start(), false);
  assert.equal(store.status().error.code, 'account_key_unavailable');

  stored = fixture.recoveryCode;
  const snapshot = await store.ready();
  assert.equal(snapshot.decrypted, 15);
  assert.equal(reads, 2);
});

test('concurrent loads share one read', async () => {
  const dir = scratchDir();
  place(dir, 'good.qlvault', Date.now());
  let reads = 0;
  const store = createSnapshotStore({
    target: dir, recoveryCode: fixture.recoveryCode, prepare: () => { reads += 1; }
  });
  const [left, right] = await Promise.all([store.load(), store.load()]);
  assert.equal(left, right);
  assert.equal(reads, 1);
});
