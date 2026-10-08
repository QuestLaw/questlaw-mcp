/**
 * Ranked search: the tokenizer, the ranking, and the three failures that
 * motivated replacing substring matching.
 *
 * Relevance tests are written as orderings instead of exact scores. A score is an
 * implementation detail, and pinning it would make every tuning change a test
 * change. The actual contract is that the authority whose title matches outranks
 * the one that only mentions it in a note.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Search reads a decrypted library, so the fixture has to load.
require('./helpers/consent');

const { tokenize, stem, parseQuery } = require('../src/tokenize');
const { buildIndex, search, expandTerm, genericCourtTerms } = require('../src/search-index');
const { readEncryptedLibrary } = require('../src/reader');
const { ensureFixture } = require('./helpers/vault-fixture');

let index;
let library;

test.before(async () => {
  const fixture = await ensureFixture();
  const result = await readEncryptedLibrary(fixture.file, fixture.recoveryCode);
  library = result.library;
  index = buildIndex(library);
});

const terms = value => tokenize(value).terms;
const refs = result => result.hits.map(hit =>
  (typeof hit.ref === 'string' ? hit.ref : hit.ref.guid || hit.ref.documentId));

/* ------------------------------------------------------------- tokenizer */

test('every spelling of a citation produces the same term', () => {
  const joined = '603us369';
  for (const spelling of ['603 U.S. 369', '603 U. S. 369', '603 US 369', '603 u.s. 369']) {
    assert.ok(terms(spelling).includes(joined), `${spelling} must yield ${joined}`);
  }
});

test('reporter abbreviations survive their periods', () => {
  assert.ok(terms('77 F.3d 100').includes('77f3d100'));
  assert.ok(terms('77 F. 3d 100').includes('77f3d100'));
});

test('a section symbol is a word, and one symbol or two reach the same term', () => {
  assert.ok(terms('§ 706').includes('section'));
  // The doubled symbol expands to "sections", which stems back to "section", so
  // text written either way answers a query written the other way.
  assert.ok(terms('§§ 701-706').includes('section'));
  assert.ok(terms('section 706').includes('section'));
});

test('stemming is light and predictable', () => {
  assert.equal(stem('courts'), 'court');
  assert.equal(stem('overruled'), 'overrul');
  assert.equal(stem('judgement'), 'judgment', 'spelling variants unify');
  // Words that merely end in s are not plurals.
  assert.equal(stem('amicus'), 'amicus');
  assert.equal(stem('class'), 'class');
  assert.equal(stem('analysis'), 'analysis');
});

test('quoted spans parse as phrases, the rest as terms', () => {
  const parsed = parseQuery('"independent judgment" deference');
  assert.deepEqual(parsed.phrases, [['independent', 'judgment']]);
  assert.ok(parsed.terms.includes('deference'));
  assert.equal(parsed.hadQuotes, true);
});

/* ------------------------------------------- the three motivating failures */

/**
 * The gap that mattered most. caseSearchHaystack() covers case fields only, so
 * before this index the captured text of every opinion and statute was reachable
 * only through a document id the model had no way to discover.
 */
test('captured source text is searchable at all', () => {
  const result = search(index, 'arbitrary capricious abuse of discretion');
  assert.ok(result.total > 0, 'statutory text must be findable');
  const source = result.hits.find(hit => hit.type === 'source');
  assert.ok(source, 'a source section must rank');
  assert.equal(source.ref.documentId, 'doc-apa-706');
  assert.match(source.snippet.text, /arbitrary/i);
});

test('a captured opinion body is searchable, not just statutes', () => {
  const result = search(index, 'full opinion paragraph body', { types: ['source'] });
  assert.ok(refs(result).includes('doc-loper-opinion'));
});

test('results are ranked, not returned in storage order', () => {
  const result = search(index, 'independent judgment');
  assert.ok(result.hits.length > 1);
  for (let i = 1; i < result.hits.length; i += 1) {
    assert.ok(result.hits[i - 1].score >= result.hits[i].score, 'scores must descend');
  }
  assert.equal(result.hits[0].relevance, 1, 'the top hit anchors relevance');
});

test('a multi-word query works, which substring matching could not do', () => {
  // These words never appear adjacent in any one field.
  const result = search(index, 'Chevron deference overruled');
  assert.ok(refs(result).includes('case-loper-bright'));
});

/* ---------------------------------------------------------------- ranking */

test('a title match outranks the same word buried in a long note', () => {
  const result = search(index, 'Verbose Holdings', { types: ['case'] });
  assert.equal(refs(result)[0], 'case-verbose');
});

test('a rare term outranks a common one in the same query', () => {
  // "redressability" appears once; "court" is everywhere.
  const result = search(index, 'court redressability', { types: ['case'] });
  assert.equal(refs(result)[0], 'case-lujan');
});

test('a pasted citation finds its authority first', () => {
  const result = search(index, '603 U.S. 369', { types: ['case'] });
  assert.equal(refs(result)[0], 'case-loper-bright');
});

/* ----------------------------------------------------------------- phrase */

test('a quoted phrase is required, not merely preferred', () => {
  const loose = search(index, 'burden establishing elements');
  const exact = search(index, '"burden of establishing these elements"');
  assert.ok(exact.total > 0, 'the phrase exists and must be found');
  assert.ok(exact.total <= loose.total, 'a phrase can only narrow');
  for (const hit of exact.hits) {
    assert.match(hit.snippet.text, /burden of establishing/i);
  }
});

test('a phrase that appears nowhere returns nothing, rather than its words', () => {
  const result = search(index, '"capricious independent redressability"');
  assert.equal(result.total, 0);
});

test('a phrase cannot span two separate quotations on one case', () => {
  // case-loper-bright has "...statutory authority." and "Chevron is overruled."
  // stored as different quotes; the words are adjacent only if the join leaks.
  const result = search(index, '"authority chevron"');
  assert.equal(result.total, 0);
});

/* --------------------------------------------------------------- recovery */

test('a different word form still finds the record', () => {
  // "deferential" is not in the library; "deference" is. Neither is a prefix of
  // the other, so this only works because of the shared-prefix expansion.
  const result = search(index, 'deferential', { types: ['case'] });
  assert.ok(result.total > 0, 'deferential must reach deference');
  assert.ok(result.terms.includes('deference'));
});

test('a transposed typo still finds the record', () => {
  const result = search(index, 'jugdment');
  assert.ok(result.total > 0, 'jugdment must reach judgment');
  assert.ok(result.terms.includes('judgment'));
});

test('an expanded match scores below an exact one', () => {
  const exact = search(index, 'deference', { types: ['case'] });
  const expanded = search(index, 'deferential', { types: ['case'] });
  assert.ok(expanded.hits[0].score < exact.hits[0].score,
    'a guess must never outrank a certainty');
});

test('a term the index already has comes first, at full weight, above any other form of it', () => {
  const expanded = expandTerm(index, 'deference');
  assert.deepEqual(expanded[0], { term: 'deference', weight: 1 });
  assert.ok(expanded.slice(1).every(item => item.weight < 1));
});

test('very short unknown terms are not expanded into noise', () => {
  assert.deepEqual(expandTerm(index, 'zq'), []);
});

/* ------------------------------------------------------- filters and bounds */

test('type filtering restricts what comes back', () => {
  for (const type of ['case', 'quote', 'source']) {
    const result = search(index, 'agency judgment court', { types: [type] });
    for (const hit of result.hits) assert.equal(hit.type, type);
  }
});

test('limit bounds the hits but not the reported total', () => {
  const all = search(index, 'the court agency', { limit: 50 });
  const one = search(index, 'the court agency', { limit: 1 });
  assert.equal(one.hits.length, 1);
  assert.equal(one.total, all.total, 'total counts matches, not returned rows');
});

test('a snippet shows the passage that matched', () => {
  const result = search(index, 'redressability');
  assert.match(result.hits[0].snippet.text, /redressability/i);
  assert.ok(result.hits[0].snippet.field);
});

test('a long field is clipped to a window around the match', () => {
  const result = search(index, 'concurrence', { snippetChars: 120 });
  assert.ok(result.total > 0);
  for (const hit of result.hits) {
    assert.ok(hit.snippet.text.length <= 200, 'a snippet stays a snippet');
  }
});

/**
 * A query with no words is a request to browse, not a failed search. "*" is the
 * first thing people type to get the whole list, and zero results reads as "this
 * library is empty".
 */
test('a query with nothing searchable in it browses instead of failing', () => {
  for (const query of ['', '   ', '!!!', '""', '*']) {
    const result = search(index, query, { types: ['case'] });
    assert.equal(result.browsed, true, `query ${JSON.stringify(query)}`);
    assert.equal(result.total, library.cases.length);
    assert.equal(result.hits.length, library.cases.length);
    // Nothing was ranked, so nothing claims a rank.
    assert.ok(result.hits.every(hit => hit.relevance === null && hit.snippet === null));
  }
});

test('browsing pages like searching does', () => {
  const page = search(index, '*', { types: ['case'], limit: 2, offset: 1 });
  assert.equal(page.total, library.cases.length);
  assert.equal(page.hits.length, 2);
  assert.deepEqual(page.hits.map(hit => hit.ref),
    search(index, '*', { types: ['case'] }).hits.slice(1, 3).map(hit => hit.ref));
});

test('a query of only stopwords still behaves', () => {
  const result = search(index, 'the of and');
  assert.ok(Number.isInteger(result.total));
});

test('every hit resolves to a record that exists', () => {
  const result = search(index, 'agency court judgment statute', { limit: 50 });
  const guids = new Set(library.cases.map(item => item.guid));
  const documentIds = new Set(library.documents.map(item => item.documentId));
  for (const hit of result.hits) {
    if (hit.type === 'case') assert.ok(guids.has(hit.ref));
    else if (hit.type === 'quote') assert.ok(guids.has(hit.ref.guid));
    else assert.ok(documentIds.has(hit.ref.documentId));
  }
});

test('the index covers every case, quote, and non-empty section', () => {
  const expectedQuotes = library.cases
    .reduce((total, item) => total + (item.quotes || [])
      .filter(quote => String(quote.text || '').trim()).length, 0);
  const expectedSections = library.documentSections
    .filter(section => String(section.text || '').trim()).length;
  const counted = type => index.documents.filter(document => document.type === type).length;

  assert.equal(counted('case'), library.cases.length);
  assert.equal(counted('quote'), expectedQuotes);
  assert.equal(counted('source'), expectedSections);
});


/* ------------------------------------------------------------ court noise */

/**
 * Court names used to be free text, so in a federal library every authority
 * matched "united states", "court", "district", and "appeals" on letterhead
 * alone. The caller couldn't tell those matches from real ones, and IDF can't
 * discount a word that really is in 90% of records.
 */
const courtLibrary = courts => ({
  cases: courts.map((court, index) => ({
    guid: `c${index}`,
    title: `Matter ${index}`,
    court,
    notes: ''
  })),
  documents: [],
  documentSections: []
});

const FEDERAL = [
  'United States Court of Appeals for the Ninth Circuit',
  'United States Court of Appeals for the Second Circuit',
  'United States District Court for the District of Massachusetts',
  'United States District Court for the Northern District of California',
  'United States Court of Appeals for the Fifth Circuit',
  'United States District Court for the District of Columbia',
  'United States Court of Appeals for the Federal Circuit',
  'United States District Court for the Southern District of New York',
  'Supreme Court of the United States',
  'Supreme Judicial Court of Massachusetts'
];

test('a query of court boilerplate no longer matches the whole library', () => {
  const federal = buildIndex(courtLibrary(FEDERAL));
  const result = search(federal, 'circuit court of appeals united states');
  assert.equal(result.total, 0,
    'letterhead words must not rank; they are in nearly every court name');
  assert.ok(result.ignoredCourtTerms.length, 'the caller has to be told why');
});

test('what actually distinguishes a court is still searchable', () => {
  const federal = buildIndex(courtLibrary(FEDERAL));
  assert.deepEqual(refs(search(federal, 'ninth')), ['c0']);
  assert.deepEqual(refs(search(federal, 'massachusetts')).sort(), ['c2', 'c9']);
  // A circuit number carries a digit, so it survives both prunings.
  assert.ok(refs(search(federal, 'federal circuit')).includes('c6'));
});

test('boilerplate is measured, not only listed', () => {
  // "Supreme" distinguishes nothing in a library of supreme courts, and
  // everything in a library that has one.
  const supreme = genericCourtTerms(buildIndex(courtLibrary([
    'Supreme Court of Alabama', 'Supreme Court of Alaska', 'Supreme Court of Arizona',
    'Supreme Court of Arkansas', 'Supreme Court of Colorado', 'Supreme Court of Delaware',
    'Supreme Court of Georgia', 'Supreme Court of Hawaii', 'Court of Chancery of Delaware'
  ])).documents);
  assert.ok(supreme.has('supreme'));

  const mixed = genericCourtTerms(buildIndex(courtLibrary(FEDERAL)).documents);
  assert.ok(!mixed.has('massachusetts'), 'a jurisdiction is not boilerplate');
  assert.ok(mixed.has('court') && mixed.has('unit'), 'the static list is always in force');
});

test('a small library is left alone by the measured half', () => {
  // Three courts is not a sample. Only the static list applies, so the one word
  // that tells these apart still works.
  const tiny = buildIndex(courtLibrary([
    'Supreme Court of Ohio', 'Court of Appeals of Ohio', 'Supreme Court of Iowa'
  ]));
  assert.equal(search(tiny, 'supreme').total, 2);
});
