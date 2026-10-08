/**
 * Relevance measurement for src/search-index.js.
 *
 * Runs every query in test/eval/queries.js over test/eval/corpus.js through the
 * same search() the tools call, with the same options each tool passes, and
 * scores the ranking:
 *
 *   nDCG@10    graded, position-discounted; the headline number
 *   MRR@10     how soon the first answer (grade 2) appears
 *   recall@25  share of judged items found anywhere on a default page
 *   snippet    share of passage queries whose answering hit shows the sentence
 *   records    nDCG@10 over distinct records (an authority with its quotations,
 *              or a captured document with its sections), which is what a reader
 *              scanning a page is counting. Two rows from one record are one
 *              answer here, and one row showing an authority and its quotation
 *              is not penalised for being one row.
 *
 * A judgment is counted once, at the first hit that satisfies it. Three
 * quotations from one authority earn the quote judgment once, and the other two
 * are rows that pushed something else down. That's the cost a model pays for
 * duplicates, so it's the cost measured here.
 */
'use strict';

const { buildIndex, search } = require('../../src/search-index');
const { normalize } = require('../../src/tokenize');
const { library } = require('./corpus');
const QUERIES = require('./queries');

/** The options each tool passes to search(), so what is measured is what is served. */
const SUITE_OPTIONS = Object.freeze({
  cases: { types: ['case'] },
  quotes: { types: ['quote'] },
  library: { group: true }
});
const DEPTH = 10;
const RECALL_DEPTH = 25;

/** Every judgment key a hit satisfies, most specific first. */
function keysFor(hit, sectionLabels) {
  if (hit.type === 'case') return [`case:${hit.ref}`];
  if (hit.type === 'quote') return [`quote:${hit.ref.guid}`];
  const label = sectionLabels.get(hit.ref.sectionId);
  return [
    ...(label !== undefined ? [`source:${hit.ref.documentId}#${label}`] : []),
    `source:${hit.ref.documentId}`
  ];
}

/**
 * The keys a hit's row puts in front of the reader, which are the hit itself plus
 * anything grouped under it. A grouped row shows those at the same rank.
 */
function rowKeys(hit, sectionLabels) {
  return [hit, ...(hit.grouped || [])].flatMap(item => keysFor(item, sectionLabels));
}

/** The record a judgment key belongs to: an authority, or a captured document. */
function recordOf(key) {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'case' || kind === 'quote') return `authority:${rest}`;
  return `document:${rest.split('#')[0]}`;
}

const gain = grade => (2 ** grade) - 1;
const discount = rank => 1 / Math.log2(rank + 2);

function scoreQuery(entry, result, sectionLabels) {
  const judged = entry.judgments;
  const credited = new Set();
  let dcg = 0;
  let reciprocal = 0;
  let snippetShown = null;

  result.hits.forEach((hit, rank) => {
    const fresh = rowKeys(hit, sectionLabels)
      .filter(key => judged[key] && !credited.has(key));
    const grade = fresh.reduce((best, key) => Math.max(best, judged[key]), 0);
    fresh.forEach(key => credited.add(key));
    if (rank < DEPTH) dcg += gain(grade) * discount(rank);
    if (grade === 2 && !reciprocal && rank < DEPTH) reciprocal = 1 / (rank + 1);
    if (grade === 2 && snippetShown === null && entry.snippet) {
      const shown = [hit, ...(hit.grouped || [])].map(item => item.snippet?.text || '').join(' ');
      snippetShown = normalize(shown).includes(normalize(entry.snippet));
    }
  });

  const ideal = Object.values(judged).sort((left, right) => right - left).slice(0, DEPTH)
    .reduce((total, grade, rank) => total + gain(grade) * discount(rank), 0);
  const found = new Set();
  result.hits.slice(0, RECALL_DEPTH).forEach(hit => rowKeys(hit, sectionLabels)
    .forEach(key => { if (judged[key]) found.add(key); }));

  // The same ranking, judged by record. Each record counts at its best grade,
  // earned once by the first row that shows any part of it.
  const recordGrades = {};
  for (const [key, grade] of Object.entries(judged)) {
    const record = recordOf(key);
    recordGrades[record] = Math.max(recordGrades[record] || 0, grade);
  }
  const creditedRecords = new Set();
  let recordDcg = 0;
  result.hits.slice(0, DEPTH).forEach((hit, rank) => {
    const records = [...new Set(rowKeys(hit, sectionLabels).map(recordOf))]
      .filter(record => recordGrades[record] && !creditedRecords.has(record));
    const grade = records.reduce((best, record) => Math.max(best, recordGrades[record]), 0);
    records.forEach(record => creditedRecords.add(record));
    recordDcg += gain(grade) * discount(rank);
  });
  const recordIdeal = Object.values(recordGrades).sort((left, right) => right - left)
    .slice(0, DEPTH).reduce((total, grade, rank) => total + gain(grade) * discount(rank), 0);

  return {
    ndcg: ideal ? dcg / ideal : 0,
    records: recordIdeal ? recordDcg / recordIdeal : 0,
    mrr: reciprocal,
    recall: found.size / Object.keys(judged).length,
    snippet: entry.snippet ? Boolean(snippetShown) : null
  };
}

const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const round = value => Number(value.toFixed(4));

function summarize(rows) {
  const snippets = rows.map(row => row.snippet).filter(value => value !== null);
  return {
    queries: rows.length,
    ndcg: round(mean(rows.map(row => row.ndcg))),
    records: round(mean(rows.map(row => row.records))),
    mrr: round(mean(rows.map(row => row.mrr))),
    recall: round(mean(rows.map(row => row.recall))),
    ...(snippets.length ? { snippet: round(mean(snippets.map(Number))) } : {})
  };
}

/**
 * @param {object} [options]
 * @param {(query: object) => object} [options.searchOptions] extra options per
 *   query, for trying a change before making it the default
 * @param {{buildIndex: Function, search: Function}} [options.engine] another
 *   implementation to measure, for comparing two versions side by side
 * @param {object} [options.library] a variant of the corpus, for stress runs
 */
function evaluate(options = {}) {
  const engine = options.engine || { buildIndex, search };
  const corpus = options.library || library;
  const index = engine.buildIndex(corpus);
  const sectionLabels = new Map(corpus.documentSections.map(item => [item.sectionId, item.label]));
  const perQuery = QUERIES.map(entry => {
    const result = engine.search(index, entry.query, {
      ...SUITE_OPTIONS[entry.suite],
      limit: RECALL_DEPTH,
      ...(options.searchOptions ? options.searchOptions(entry) : {})
    });
    return { ...entry, ...scoreQuery(entry, result, sectionLabels), top: result.hits.slice(0, 3) };
  });

  const byKind = {};
  for (const row of perQuery) (byKind[row.kind] ||= []).push(row);
  return {
    overall: summarize(perQuery),
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, rows]) => [kind, summarize(rows)])),
    perQuery
  };
}

module.exports = { evaluate, scoreQuery, SUITE_OPTIONS };
