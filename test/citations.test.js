/**
 * The citation index on its own, against cases shaped like the extension's,
 * including the fields a fixture can't conveniently carry.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCitationIndex, findCitationMentions, citationKey } = require('../src/citations');

const best = caseData => caseData.citation || '';
const index = buildCitationIndex([
  { guid: 'carpenter', citation: '585 U.S. 296 (2018)',
    parallelCitations: ['138 S. Ct. 2206', '585 U.S. 296 (2018)'] },
  { guid: 'apa', citation: '5 U.S.C. § 706' },
  { guid: 'title5', citation: '5 U.S.C.' },
  { guid: 'tribunal', citation: '12 Cour Fédérale 7' },
  { guid: 'web', citation: 'https://example.com/opinion/1' },
  { guid: 'tiny', citation: 'Id' }
], best);
const cited = text => findCitationMentions(text, index).map(row => [row.guid, row.text]);

test('spelling, spacing, and case do not change a citation', () => {
  for (const spelling of ['585 U.S. 296', '585 US 296', '585 u. s. 296', '585 U.S.\n296']) {
    assert.deepEqual(cited(`See ${spelling}.`), [['carpenter', spelling]], spelling);
  }
  assert.equal(citationKey('585 U.S. 296 (2018)'), citationKey('585 US 296'));
});

test('a parallel citation finds its case, and a repeated parallel is reported once', () => {
  assert.deepEqual(cited('138 S.Ct. 2206'), [['carpenter', '138 S.Ct. 2206']]);
  assert.deepEqual(cited('585 U.S. 296'), [['carpenter', '585 U.S. 296']]);
});

test('every occurrence is reported, in order', () => {
  assert.deepEqual(cited('585 U.S. 296; id.; 138 S. Ct. 2206; 585 US 296'), [
    ['carpenter', '585 U.S. 296'], ['carpenter', '138 S. Ct. 2206'], ['carpenter', '585 US 296']
  ]);
});

test('a match starts and ends on a word boundary', () => {
  assert.deepEqual(cited('1585 U.S. 296'), []);
  assert.deepEqual(cited('585 U.S. 2960'), []);
  assert.deepEqual(cited('585 U.S. 296, 310'), [['carpenter', '585 U.S. 296']]);
});

test('where a short and a long citation both match, each case is reported once', () => {
  // A span ends on its last letter or digit, so the trailing period isn't in it.
  assert.deepEqual(cited('5 U.S.C. § 706(2)(A)'), [
    ['apa', '5 U.S.C. § 706'], ['title5', '5 U.S.C']
  ]);
  assert.deepEqual(cited('5 U.S.C. section 706'), [
    ['apa', '5 U.S.C. section 706'], ['title5', '5 U.S.C']
  ], 'a section symbol and the word section are one citation, as in search');
});

test('accents fold, and a decomposed accent does not split a word', () => {
  assert.deepEqual(cited('12 Cour Federale 7'), [['tribunal', '12 Cour Federale 7']]);
  const decomposed = '12 Cour Fédérale 7';
  assert.deepEqual(cited(decomposed), [['tribunal', decomposed]]);
});

test('a folded citation too short to be one is not indexed', () => {
  assert.deepEqual(cited('Id. at 5'), []);
  assert.deepEqual(cited('see https://example.com/opinion/1 for the text'),
    [['web', 'https://example.com/opinion/1']]);
});

/**
 * The reason for the index: the vendored scan ran one indexOf per citation over
 * the whole draft, about 440 ms for this size on the event loop. Generous bound,
 * since CI machines vary; the point is that it no longer scales with the library.
 */
test('a long draft against a large library scans in one pass', () => {
  const cases = Array.from({ length: 20000 }, (_, n) =>
    ({ guid: `g${n}`, citation: `${100 + (n % 900)} F.${(n % 3) + 2}d ${n} (9th Cir. 2001)` }));
  const big = buildCitationIndex(cases, best);
  const cite = cases[4567].citation.replace(/ \(.*\)$/, '');
  const draft = `The court held, under ${cite} and nothing else, that this is so. `.repeat(3600);
  assert.ok(draft.length >= 256 * 1024 * 0.95);
  const started = process.hrtime.bigint();
  const found = findCitationMentions(draft, big);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(found.length, 3600);
  assert.ok(ms < 1000, `scan took ${ms.toFixed(0)} ms`);
});
