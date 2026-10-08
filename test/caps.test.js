/**
 * Result caps, measured in bytes. Row counts are the wrong unit, since the
 * measured library is about 3.5 MiB for 2,000 cases and one case with a long note
 * can be larger than fifty bare ones. These tests use a deliberately small budget
 * so the ceiling binds on a fixture small enough to reason about.
 */
'use strict';

// A loaded library needs disclosure consent, and test/consent.test.js covers refusing it.
require('./helpers/consent');

// Read by src/limits.js at require time, so it has to be set before the package loads.
process.env.QUESTLAW_MAX_RESPONSE_BYTES = '8192';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const { LIMITS, capRows, listResult, clip } = require('../src/limits');
const { createTools } = require('../src/tools');

const PARAGRAPH = 'The statute forecloses the agency reading, and the legislative history '
  + 'does not rescue it. '.repeat(12);

function syntheticLibrary({ cases = 200, sections = 40 } = {}) {
  return {
    cases: Array.from({ length: cases }, (_, index) => ({
      guid: `case-${index}`,
      title: `Sample Authority No. ${index} v. Administrator`,
      citation: `${100 + index} F.3d ${index + 1} (9th Cir. 2019)`,
      court: 'Court of Appeals',
      year: 2019,
      tags: ['deference'],
      notes: `${PARAGRAPH} [record ${index}]`,
      projectIds: [1],
      quotes: [{ text: `${PARAGRAPH} quote ${index}`, page: String(index) }]
    })),
    projects: [{ id: 1, uid: 'workspace-1', name: 'Everything' }],
    relationships: [],
    workspaceSections: [],
    documents: [{ documentId: 'doc-long', authorityGuid: 'case-0', contentType: 'statute',
      sourceTitle: 'A very long statute' }],
    documentSections: Array.from({ length: sections }, (_, index) => ({
      documentId: 'doc-long', sectionId: `sec-${index}`, order: index,
      label: `(${index})`, text: `${PARAGRAPH} section ${index}`
    })),
    documentReferences: []
  };
}

function toolsOver(library) {
  const snapshot = {
    library,
    sourceFile: '/tmp/synthetic.qlvault',
    exportedAt: new Date().toISOString(),
    loadedAt: new Date().toISOString(),
    decrypted: 0
  };
  return new Map(createTools({ ready: async () => snapshot }).map(tool => [tool.name, tool]));
}

const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('the configured budget is what the package actually uses', () => {
  assert.equal(LIMITS.responseBytes, 8192);
});

test('an out-of-range budget is clamped, not obeyed', () => {
  // Each case needs its own process because the env value is read once at require
  // time. A 100-byte budget would leave every tool returning nothing useful.
  const budgetWith = value => Number(execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(require("./src/limits").LIMITS.responseBytes))'],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, QUESTLAW_MAX_RESPONSE_BYTES: value },
      encoding: 'utf8' }
  ));

  assert.equal(budgetWith('100'), 8 * 1024, 'floor');
  assert.equal(budgetWith('99999999'), 1024 * 1024, 'ceiling');
  assert.equal(budgetWith('not-a-number'), 64 * 1024, 'default');
  assert.equal(budgetWith('32768'), 32 * 1024, 'in range');
});

test('capRows stops at the budget and never returns nothing', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ index, text: PARAGRAPH }));
  const kept = capRows(rows, 4096);
  assert.ok(kept.length > 0 && kept.length < rows.length);
  assert.ok(bytes(kept) <= 4096);
  // One row larger than the whole budget still comes back. Fields are clipped
  // upstream so a single row is bounded, and returning nothing would be worse.
  assert.equal(capRows([{ text: 'x'.repeat(9000) }], 1024).length, 1);
});

test('a truncated list says which limit bound it', () => {
  const byBudget = listResult(Array.from({ length: 40 }, () => ({ text: PARAGRAPH })), 40);
  assert.match(byBudget.truncated, /byte budget/);
  const byLimit = listResult([{ a: 1 }], 9);
  assert.match(byLimit.truncated, /Raise limit/);
  assert.equal(listResult([{ a: 1 }], 1).truncated, undefined);
});

test('search_cases stays inside the budget on a library that would blow it', async () => {
  const search = toolsOver(syntheticLibrary()).get('search_cases');
  const result = await search.run({ query: 'deference', limit: LIMITS.maxRows });

  assert.equal(result.matched, 200);
  assert.ok(result.returned < LIMITS.maxRows, 'the byte budget must bind before the row cap');
  assert.ok(bytes(result) <= LIMITS.responseBytes, `response was ${bytes(result)} bytes`);
  assert.match(result.truncated, /byte budget/);
});

test('search_quotes clips each quote before the budget is spent on one of them', async () => {
  const result = await toolsOver(syntheticLibrary()).get('search_quotes').run({ query: 'statute' });
  assert.ok(result.returned > 0);
  for (const hit of result.results) {
    assert.ok(hit.text.length <= LIMITS.quoteChars + 60);
  }
  assert.ok(bytes(result) <= LIMITS.responseBytes);
});

test('get_source_text pages a long document instead of dropping the tail', async () => {
  const sourceText = toolsOver(syntheticLibrary()).get('get_source_text');
  const first = await sourceText.run({ documentId: 'doc-long' });

  assert.equal(first.sectionsTotal, 40);
  assert.ok(first.returned < 40);
  assert.equal(first.nextOffset, first.returned);
  assert.match(first.truncated, /offset \d+/);
  assert.ok(bytes(first) <= LIMITS.responseBytes);

  // Following nextOffset must advance, or paging is a dead end.
  const second = await sourceText.run({ documentId: 'doc-long', offset: first.nextOffset });
  assert.equal(second.sections[0].label, `(${first.nextOffset})`);
  assert.ok(second.returned > 0);
});

test('clip marks what it removed rather than silently shortening', () => {
  const clipped = clip('x'.repeat(500), 100);
  assert.ok(clipped.startsWith('x'.repeat(100)));
  assert.match(clipped, /\[clipped, 400 more characters\]/);
  assert.equal(clip('short', 100), 'short');
  assert.equal(clip(null, 10), '');
});
