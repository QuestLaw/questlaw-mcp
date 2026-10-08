/**
 * The relevance gate: search may not get worse on the evaluation set unless
 * someone decides it should.
 *
 * The set is test/eval/queries.js over test/eval/corpus.js, and the recorded
 * scores are in test/eval/baseline.json. A change that lowers any score fails
 * here, and a deliberate trade is recorded with `npm run eval -- --write`, which
 * puts the new numbers in the diff where review sees them.
 *
 * Below the gate are the contracts behind individual gains, written as orderings
 * on small libraries so each fails for its own reason.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { evaluate } = require('./eval/run');
const { buildIndex, search, expandTerm, buildSnippet } = require('../src/search-index');
const { readShorthand } = require('../src/legal-terms');

const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval', 'baseline.json'), 'utf8'));
/** Floating-point room, not a regression allowance. */
const TOLERANCE = 0.0005;
const METRICS = ['ndcg', 'records', 'mrr', 'recall', 'snippet'];

test('no relevance score falls below the recorded baseline', () => {
  const result = evaluate();
  const drops = [];
  const compare = (label, now, before) => {
    for (const metric of METRICS) {
      if (before?.[metric] === undefined) continue;
      if (now[metric] < before[metric] - TOLERANCE) {
        drops.push(`${label} ${metric}: ${before[metric]} -> ${now[metric]}`);
      }
    }
  };
  compare('overall', result.overall, BASELINE.overall);
  for (const [kind, scores] of Object.entries(result.byKind)) compare(kind, scores, BASELINE.byKind[kind]);
  assert.deepEqual(drops, [], 'Run `npm run eval -- --worst` to see which queries moved; '
    + 'record a deliberate trade with `npm run eval -- --write`.');
});

/* ------------------------------------------------------------- contracts */

let serial = 0;
const authority = fields => ({ guid: `c${serial += 1}`, title: '', quotes: [], tags: [], ...fields });
const libraryOf = (cases, extra = {}) => ({
  cases, projects: [], relationships: [], documents: [], documentSections: [], ...extra
});
const top = result => result.hits.map(hit => (typeof hit.ref === 'string' ? hit.ref : hit.ref.documentId));

test('a word reaches its other forms: moot finds mootness, redressability finds redress', () => {
  const index = buildIndex(libraryOf([
    authority({ guid: 'noun', title: 'Alpha', notes: 'The mootness question was preserved.' }),
    authority({ guid: 'verb', title: 'Beta', notes: 'A favorable ruling would redress the harm.' }),
    authority({ guid: 'none', title: 'Gamma', notes: 'Nothing relevant here at all.' })
  ]));
  assert.deepEqual(top(search(index, 'moot')), ['noun']);
  assert.deepEqual(top(search(index, 'redressability')), ['verb']);
});

test('a known word is not stripped into a different one', () => {
  const index = buildIndex(libraryOf([
    authority({ title: 'Alpha', notes: 'Summary judgment was entered.' }),
    authority({ title: 'Beta', notes: 'The officer judged the threat.' })
  ]));
  const forms = expandTerm(index, 'judgment').map(item => item.term);
  assert.ok(!forms.includes('judg'), `judgment must not reach judged: ${forms.join(', ')}`);
});

test('a misspelling with one correction is taken nearly at its word, and a question word is not a typo', () => {
  const index = buildIndex(libraryOf([
    authority({ title: 'Alpha', notes: 'The claim is plausible, and plausibility is the test.' }),
    authority({ title: 'Beta', notes: 'Note that this is unrelated.' })
  ]));
  const expanded = expandTerm(index, 'plausable');
  assert.equal(expanded[0].term, 'plausible');
  assert.ok(expanded[0].weight >= 0.8);
  assert.ok(expanded.some(item => item.term === 'plausibility'),
    'the corrected word reaches its own neighbours');
  assert.deepEqual(expandTerm(index, 'what'), [], 'what is not a misspelling of that');
});

test('shorthand is read both ways', () => {
  assert.deepEqual(readShorthand('MSJ burden'), [{ from: 'msj', to: 'summary judgment' }]);
  assert.deepEqual(readShorthand('the summary judgment standard').map(item => item.to).sort(),
    ['msj', 'sj']);
  assert.deepEqual(readShorthand('12(b)(6) motion'), [{ from: '12(b)(6)', to: 'failure to state a claim' }]);
  assert.deepEqual(readShorthand('pi damages'), [], 'ambiguous shorthand is left alone');

  const index = buildIndex(libraryOf([
    authority({ guid: 'long', title: 'Alpha', notes: 'Denied summary judgment on the contract count.' }),
    authority({ guid: 'short', title: 'Beta', notes: 'Our MSJ opposition relies on this.' }),
    authority({ guid: 'none', title: 'Gamma', notes: 'A contract case with no motion practice.' })
  ]));
  assert.deepEqual(top(search(index, 'MSJ')).sort(), ['long', 'short'],
    'MSJ finds the note that says it and the one that spells it out, and nothing else');
  assert.ok(top(search(index, 'summary judgment')).includes('short'), 'and the reverse');
  assert.deepEqual(search(index, 'MSJ').readAs, [{ from: 'msj', to: 'summary judgment' }]);
});

test('words kept together outrank the same words apart', () => {
  const index = buildIndex(libraryOf([
    authority({ guid: 'apart', title: 'Alpha',
      notes: 'The summary of the record was thin. Judgment for the county on the pleadings.' }),
    authority({ guid: 'together', title: 'Beta',
      notes: 'The record was thin. Summary judgment for the county on the pleadings.' })
  ]));
  assert.deepEqual(top(search(index, 'summary judgment')), ['together', 'apart']);
});

test('grouping gives an authority and a document one row each', () => {
  const index = buildIndex(libraryOf([
    authority({ guid: 'a', title: 'Deference Case', notes: 'deference deference',
      quotes: [{ text: 'No deference is owed.' }, { text: 'Deference ends here.' }] }),
    authority({ guid: 'b', title: 'Other', notes: 'deference once' })
  ], {
    documents: [{ documentId: 'd', sourceTitle: 'Deference statute' }],
    documentSections: [
      { sectionId: 's1', documentId: 'd', label: '(a)', text: 'deference in (a)' },
      { sectionId: 's2', documentId: 'd', label: '(b)', text: 'deference in (b)' }
    ]
  }));
  const flat = search(index, 'deference');
  const grouped = search(index, 'deference', { group: true });
  assert.equal(flat.total, 6);
  assert.equal(grouped.total, 3, 'one row per authority and per document');
  const rowFor = key => grouped.hits.find(hit =>
    (typeof hit.ref === 'string' ? hit.ref : hit.ref.guid || hit.ref.documentId) === key);
  assert.equal(rowFor('a').groupedTotal, 2, 'the two quotations sit under their authority');
  assert.equal(rowFor('d').groupedTotal, 1, 'the second section sits under the first');
  assert.ok(!rowFor('b').grouped);
});

test('a snippet shows the passage that answers, not the first word that matched', () => {
  const filler = 'The court reviewed the record and the parties briefed the issues at length. '.repeat(30);
  const text = `The agency moved first. ${filler}Stare decisis does not require adherence where `
    + `reliance interests are weak and the rule has proved unworkable. ${filler}`;
  const document = { fields: { text }, weights: { text: 2 } };
  const snippet = buildSnippet(document, ['stare', 'decisis', 'reliance', 'agency'], 240);
  assert.match(snippet.text, /Stare decisis does not require/);
});

test('search_library serves one row per record, says what else matched, and says how it read shorthand', async () => {
  const { createTools } = require('../src/tools');
  const { library } = require('./eval/corpus');
  const snapshot = { library, decrypted: 0 };
  const store = { ready: async () => snapshot, status: () => ({ state: 'loaded' }) };
  const tool = createTools(store).find(item => item.name === 'search_library');

  const cited = await tool.run({ query: '5 USC 706' });
  const statuteRows = cited.results.filter(row => row.documentId === 'doc-apa-706');
  assert.equal(statuteRows.length, 1, 'every section cites 5 U.S.C. 706; they share one row');
  assert.ok(statuteRows[0].alsoMatched.every(item => item.kind === 'source' && 'label' in item));

  const phrase = await tool.run({ query: '"arbitrary and capricious"' });
  const stateFarm = phrase.results.find(row => row.guid === 'state-farm');
  assert.ok(stateFarm, 'the authority is a row');
  assert.deepEqual(stateFarm.alsoMatched.map(item => item.kind), ['quote'],
    'and its quotation sits under it, with the pincite');
  assert.equal(stateFarm.alsoMatched[0].pincite, '43');

  const shorthand = await tool.run({ query: 'QI clearly established' });
  assert.deepEqual(shorthand.readAs, ['qi = qualified immunity']);
});
