/**
 * Round trip: a vault written by the shipped stack reads back through the recovery
 * code alone, with no storage, IndexedDB, or browser.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { ensureFixture, writeVariant } = require('./helpers/vault-fixture');
const { readEncryptedLibrary } = require('../src/reader');

let fixture;
test.before(async () => { fixture = await ensureFixture(); });

test('decrypts every record and groups it by type', async () => {
  const stages = [];
  const result = await readEncryptedLibrary(fixture.file, fixture.recoveryCode, {
    onProgress: stage => stages.push(stage.stage)
  });

  assert.equal(result.decrypted, result.recordCount);
  assert.equal(result.vaultGeneration, 1);
  assert.deepEqual(stages, ['parsed', 'unwrapped', 'head', 'shards', 'records']);
  // private-state is confidential UI state, not research. It must be dropped, and
  // the reader must say that it dropped it.
  assert.deepEqual(result.skippedRecordTypes, ['private-state']);

  const counts = Object.fromEntries(
    Object.entries(result.library).map(([name, rows]) => [name, rows.length]));
  assert.deepEqual(counts, {
    cases: 4, projects: 2, relationships: 1, workspaceSections: 1,
    documents: 2, documentSections: 3, documentReferences: 1
  });
});

test('recovers plaintext research, not just record shapes', async () => {
  const { library } = await readEncryptedLibrary(fixture.file, fixture.recoveryCode);
  const loper = library.cases.find(item => item.guid === 'case-loper-bright');

  assert.equal(loper.title, 'Loper Bright Enterprises v. Raimondo');
  assert.match(loper.notes, /Overrules Chevron/);
  assert.equal(loper.quotes.length, 2);
  assert.match(loper.quotes[0].text, /independent judgment/);
  assert.equal(loper.quotes[0].page, '412');
  assert.equal(library.workspaceSections[0].name, 'Argument I: no deference owed');
  assert.equal(library.relationships[0].type, 'distinguishes');
  assert.match(
    library.documentSections.find(section => section.label === '(a)').text,
    /reviewing court shall decide all relevant questions of law/
  );
});

/**
 * The product claim the consent copy rests on: this connector exposes more than
 * the user's ordinary JSON export. portableCollections() filters documents to
 * statute, regulation, and court rule, but the .qlvault carries raw envelopes, so
 * captured opinion bodies come with it.
 */
test('carries captured opinion text that the portable JSON export filters out', async () => {
  const { library } = await readEncryptedLibrary(fixture.file, fixture.recoveryCode);

  const portableIds = fixture.portableExport.data.documents.map(item => item.documentId);
  assert.deepEqual(portableIds, ['doc-apa-706']);

  const vaultIds = library.documents.map(item => item.documentId).sort();
  assert.deepEqual(vaultIds, ['doc-apa-706', 'doc-loper-opinion']);
  const opinionBody = library.documentSections.find(s => s.documentId === 'doc-loper-opinion');
  assert.match(opinionBody.text, /full opinion paragraph body text/);
});

test('rejects a recovery code that is not one, before touching the vault', async () => {
  for (const [code, expected] of [
    ['', 'recovery_code_missing'],
    ['   ', 'recovery_code_missing'],
    ['not-a-code', 'recovery_code_malformed'],
    [`${fixture.recoveryCode}X`, 'recovery_code_malformed'],
    [fixture.recoveryCode.slice(0, 42), 'recovery_code_malformed']
  ]) {
    await assert.rejects(
      () => readEncryptedLibrary(fixture.file, code),
      error => error.code === expected,
      `expected ${expected} for ${JSON.stringify(code)}`
    );
  }
});

test('tolerates surrounding whitespace, which every custody path introduces', async () => {
  const result = await readEncryptedLibrary(fixture.file, `\n  ${fixture.recoveryCode}\t\n`);
  assert.equal(result.decrypted, result.recordCount);
});

test('separates a missing file from an unreadable one', async t => {
  await assert.rejects(
    () => readEncryptedLibrary('/nonexistent/questlaw.qlvault', fixture.recoveryCode),
    error => error.code === 'vault_file_missing'
  );

  // A filesystem refusal must not be reported as a malformed export, since that
  // would send someone off to re-export, which can't help. chmod is how to cause
  // one here, and on Windows it only sets the read-only attribute, which still
  // lets the file be read.
  if (process.platform === 'win32') return t.skip('Windows file modes cannot refuse a read');
  const locked = writeVariant(fixture.text, 'locked');
  fs.chmodSync(locked, 0o000);
  try {
    await assert.rejects(
      () => readEncryptedLibrary(locked, fixture.recoveryCode),
      error => error.code === 'vault_file_unreadable' && error.detail === 'EACCES'
    );
  } finally {
    fs.chmodSync(locked, 0o600);
  }
});

/**
 * The trap that makes a first key rotation look like a bug. The recovery wrap is
 * generation-scoped (HKDF label recovery-key-wrap/generation/${vaultGeneration}),
 * so an old code fails exactly like a wrong one. The reader only has the file's
 * own generation to go on, so the message must use that.
 */
test('a rotated library says so instead of only saying wrong code', async () => {
  const rotated = writeVariant(
    fixture.text.replace('"vaultGeneration":1', '"vaultGeneration":4'), 'rotated');

  await assert.rejects(
    () => readEncryptedLibrary(rotated, fixture.recoveryCode),
    error => error.code === 'recovery_unwrap_failed'
      && /generation 4/.test(error.message)
      && /most recent key rotation/.test(error.hint)
  );

  // Generation 1 can't have been rotated, so the message must not suggest it was.
  await assert.rejects(
    () => readEncryptedLibrary(fixture.file, 'A'.repeat(43)),
    error => error.code === 'recovery_unwrap_failed' && !/generation/.test(error.message)
  );
});
