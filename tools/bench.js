#!/usr/bin/env node
/**
 * Cold-read and per-query measurements against a synthetic library at scale.
 *
 * Not part of the test suite, since it builds a large vault (which takes minutes)
 * and the numbers inform judgment calls (is the startup read fast enough, does
 * search need an index) instead of pass/fail.
 *
 *   QUESTLAW_REPO=<extension checkout> node tools/bench.js [caseCount]     default 2000
 *
 * The checkout supplies the writer stack, since the vault is written by the code
 * that ships and not a stand-in. A cached fixture needs no checkout.
 * The fixture is cached under tools/.cache/, which is gitignored.
 */
'use strict';

// Reading a library needs the same consent as the server.
process.env.QUESTLAW_DISCLOSURE_ACK = 'i-understand';

const fs = require('fs');
const path = require('path');

const { Search } = require('../src/core-modules');
const { findCheckout, loadWriterStack } = require('./checkout');
const { readEncryptedLibrary } = require('../src/reader');
const { createTools } = require('../src/tools');

const COUNT = Number(process.argv[2] || 2000);
const CACHE = path.join(__dirname, '.cache', `scale-${COUNT}`);
const NOTE = 'Holding turns on the statutory text; the agency reading is not entitled to '
  + 'deference. Compare the concurrence at 418 on stare decisis. '.repeat(3);

function syntheticCases(count) {
  return Array.from({ length: count }, (_, index) => ({
    guid: `case-${index}`,
    title: `Sample Authority No. ${index} v. Administrator`,
    citation: `${100 + (index % 600)} F.3d ${1 + (index % 900)} `
      + `(${index % 13 === 0 ? '9th' : '2d'} Cir. ${1990 + (index % 34)})`,
    court: 'Court of Appeals',
    year: 1990 + (index % 34),
    tags: ['administrative law', index % 3 ? 'deference' : 'standing'],
    notes: `${NOTE} [record ${index}]`,
    projectIds: [1],
    quotes: [
      { id: `q-${index}-a`, text: `Quotation A for authority ${index}. `.repeat(4), page: String(10 + (index % 40)) },
      { id: `q-${index}-b`, text: `Quotation B for authority ${index}. `.repeat(4), page: String(50 + (index % 40)) }
    ]
  }));
}

async function buildFixture() {
  const repo = findCheckout(['tests/helpers/encrypted-library.js']);
  const { createEncryptedLibrary } = loadWriterStack(repo);

  const library = await createEncryptedLibrary();
  try {
    process.stdout.write(`building a ${COUNT}-case vault (minutes, cached afterwards)...\n`);
    const started = Date.now();
    await library.db.importData(
      { data: { cases: syntheticCases(COUNT), projects: [{ id: 1, name: 'Everything' }] } }, true);
    process.stdout.write(`  import: ${Date.now() - started}ms\n`);
    const exported = await library.vault.exportEncrypted();
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(path.join(CACHE, 'scale.qlvault'), exported);
    fs.writeFileSync(path.join(CACHE, 'recovery.txt'), library.recoveryCode);
  } finally {
    await library.destroy();
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timed(times, run) {
  const samples = [];
  for (let index = 0; index < times; index += 1) {
    const started = process.hrtime.bigint();
    await run(index);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return median(samples);
}

async function main() {
  if (!fs.existsSync(path.join(CACHE, 'scale.qlvault'))) await buildFixture();
  const file = path.join(CACHE, 'scale.qlvault');
  const code = fs.readFileSync(path.join(CACHE, 'recovery.txt'), 'utf8').trim();
  const mib = fs.statSync(file).size / 1048576;

  const stages = {};
  let last = Date.now();
  const startedAt = last;
  const snapshot = await readEncryptedLibrary(file, code, {
    onProgress: step => {
      stages[step.stage] = (stages[step.stage] || 0) + Date.now() - last;
      last = Date.now();
    }
  });
  const totalMs = Date.now() - startedAt;
  const memory = process.memoryUsage();

  process.stdout.write(`\nfile: ${mib.toFixed(2)} MiB, ${snapshot.recordCount} records\n`);
  process.stdout.write(`stage ms: ${JSON.stringify(stages)}\n`);
  process.stdout.write(`cold read: ${totalMs}ms (${(totalMs / snapshot.recordCount).toFixed(2)} ms/record)\n`);
  process.stdout.write(`heapUsed ${(memory.heapUsed / 1048576).toFixed(0)} MiB, `
    + `rss ${(memory.rss / 1048576).toFixed(0)} MiB\n`);

  // Reported next to the read so the index cost doesn't hide inside the first query.
  const { buildIndex, search } = require('../src/search-index');
  const indexStart = Date.now();
  const searchIndex = buildIndex(snapshot.library);
  const indexMs = Date.now() - indexStart;
  process.stdout.write(`\nsearch index: ${searchIndex.totalDocuments} documents, `
    + `${searchIndex.vocabulary.length} terms, built in ${indexMs}ms `
    + `(heap now ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MiB)\n`);

  process.stdout.write('\nmedian ranked-query latency over 20 runs:\n');
  for (const [label, query] of [
    ['single term', 'deference'],
    ['several terms', 'independent judgment deference'],
    ['required phrase', '"not entitled to deference"'],
    ['citation', '603 U.S. 369'],
    ['word-form recovery', 'deferential'],
    ['transposed typo', 'jugdment'],
    ['no match', 'zzzz nonexistent']
  ]) {
    const ms = await timed(20, () => search(searchIndex, query, { limit: 25 }));
    process.stdout.write(`  ${label.padEnd(20)}${ms.toFixed(2).padStart(7)}ms  `
      + `${JSON.stringify(query)}\n`);
  }

  const view = { ...snapshot, sourceFile: file, exportedAt: new Date().toISOString(), loadedAt: new Date().toISOString() };
  // The tools read this store the way they read the real one, status() included.
  const store = { ready: async () => view, status: () => ({ state: 'loaded' }) };
  const tools = new Map(createTools(store).map(tool => [tool.name, tool]));
  const draft = snapshot.library.cases.slice(0, 40)
    .map(item => `See ${Search.getBestCitation(item)}.`).join(' ');

  process.stdout.write('\nmedian tool latency over 9 calls:\n');
  const queries = ['deference', 'authority no. 1234', 'zzzz-no-match'];
  for (const query of queries) {
    const ms = await timed(9, () => tools.get('search_cases').run({ query }));
    process.stdout.write(`  ${`search_cases ${JSON.stringify(query)}`.padEnd(34)}${ms.toFixed(1)}ms\n`);
  }
  const quoteMs = await timed(9, () => tools.get('search_quotes').run({ query: 'quotation a' }));
  process.stdout.write(`  ${'search_quotes "quotation a"'.padEnd(34)}${quoteMs.toFixed(1)}ms\n`);
  const caseMs = await timed(9, i => tools.get('get_case').run({ guid: `case-${(i * 37) % COUNT}` }));
  process.stdout.write(`  ${'get_case (indexed lookup)'.padEnd(34)}${caseMs.toFixed(2)}ms\n`);
  const mentionMs = await timed(9, () => tools.get('find_citation_mentions').run({ text: draft }));
  process.stdout.write(`  ${'find_citation_mentions'.padEnd(34)}${mentionMs.toFixed(1)}ms\n`);

  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  process.stdout.write('\nresponse sizes against the 64 KiB budget:\n');
  for (const [label, value] of [
    ['library_overview', await tools.get('library_overview').run({})],
    ['search_cases (limit 50)', await tools.get('search_cases').run({ query: 'deference', limit: 50 })],
    ['search_quotes (limit 50)', await tools.get('search_quotes').run({ query: 'quotation', limit: 50 })],
    ['search_library (limit 50)', await tools.get('search_library').run({ query: 'deference agency', limit: 50 })],
    ['whole decrypted library', snapshot.library]
  ]) {
    const size = bytes(value);
    process.stdout.write(`  ${label.padEnd(26)} ${(size / 1024).toFixed(0).padStart(6)} KiB `
      + `~${Math.round(size / 3.6).toLocaleString()} tokens\n`);
  }
}

main().catch(error => {
  process.stderr.write(`bench failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
