/**
 * The tools, against a real decrypted fixture. They run through the same snapshot
 * store the server uses, so a change that breaks discovery, loading, or
 * projection shows up here instead of in a client.
 */
'use strict';

// A loaded library needs disclosure consent, and test/consent.test.js covers refusing it.
require('./helpers/consent');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { ensureFixture } = require('./helpers/vault-fixture');
const { createSnapshotStore } = require('../src/snapshot');
const { createTools } = require('../src/tools');
const { LIMITS } = require('../src/limits');

let tools;
let fixture;

const call = (name, args = {}) => tools.get(name).run(args);

async function expectToolError(name, args, code) {
  await assert.rejects(async () => call(name, args), error => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    assert.ok(error.message, 'a tool error must carry a sentence');
    return true;
  });
}

test.before(async () => {
  fixture = await ensureFixture();
  const store = createSnapshotStore({
    target: fixture.file,
    recoveryCode: fixture.recoveryCode
  });
  await store.load();
  tools = new Map(createTools(store).map(tool => [tool.name, tool]));
});

test('the tool surface is the ten documented tools', async () => {
  assert.deepEqual([...tools.keys()], [
    'library_overview', 'list_cases', 'search_cases', 'get_case', 'search_quotes',
    'search_library', 'list_project_cases', 'get_source_text', 'find_citation_mentions',
    'reload_snapshot'
  ]);
  for (const tool of tools.values()) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} declares every argument`);
  }
});

/**
 * Counts are integers with bounds, so a client that validates against the schema
 * stops a bad value before it is sent, and the model sees the ceiling.
 */
test('paging arguments are declared as bounded integers', () => {
  for (const tool of tools.values()) {
    const { limit, offset, maxChars } = tool.inputSchema.properties;
    if (limit) {
      assert.deepEqual([limit.type, limit.minimum, limit.maximum], ['integer', 1, LIMITS.maxRows],
        `${tool.name} limit`);
    }
    if (offset) assert.deepEqual([offset.type, offset.minimum], ['integer', 0], `${tool.name} offset`);
    if (maxChars) assert.deepEqual([maxChars.type, maxChars.minimum], ['integer', 1]);
  }
});

test('library_overview orients the model before it searches', async () => {
  const overview = await call('library_overview');
  assert.equal(overview.counts.cases, 4);
  assert.equal(overview.snapshot.records, 15);
  assert.ok(overview.snapshot.ageHours >= 0);
  assert.deepEqual(overview.projects.map(project => project.name).sort(),
    ['Chevron deference brief', 'Standing / mootness']);
  assert.equal(overview.projects.find(p => p.id === 1).cases, 2);
  assert.deepEqual(overview.tags[0], { tag: 'deference', count: 2 });
  // Captured opinion bodies are in this library, and the overview must not hide it.
  assert.deepEqual(overview.capturedSourceTypes, ['case', 'statute']);
});

/**
 * A library where most authorities are in no project reads as nearly empty to
 * anyone who only knows list_project_cases. The count, and the call that reaches
 * those records, are both stated.
 */
test('library_overview says what is filed under nothing, and how to reach it', async () => {
  const overview = await call('library_overview');
  assert.equal(overview.authorities.total, 4);
  assert.equal(overview.authorities.unfiled, 1);
  assert.equal(overview.authorities.withNotes, 3);
  assert.equal(overview.authorities.quotes, 4);
  assert.equal(overview.authorities.withCapturedSource, 1);
  assert.deepEqual(overview.authorities.years, { from: 1992, to: 2024 });

  const guidance = overview.guidance.join(' ');
  assert.match(guidance, /list_cases with no arguments/);
  assert.match(guidance, /1 of 4 authorities are filed under no project/);
  assert.match(guidance, /list_cases\(project: "none"\)/);
});

test('library_overview reports courts as a facet', async () => {
  const overview = await call('library_overview');
  assert.deepEqual(overview.courts, [
    { court: 'U.S. Supreme Court', count: 2 },
    { court: '9th Cir.', count: 1 }
  ]);
});

test('search_cases reports the true match count, not just what it returned', async () => {
  const all = await call('search_cases', { query: 'deference' });
  assert.equal(all.matched, 2);
  assert.equal(all.returned, 2);
  assert.equal(all.truncated, undefined);

  const capped = await call('search_cases', { query: 'deference', limit: 1 });
  assert.equal(capped.matched, 2);
  assert.equal(capped.returned, 1);
  // A short page names the call that continues it.
  assert.equal(capped.nextOffset, 1);
  assert.match(capped.truncated, /offset 1/);

  const rest = await call('search_cases', { query: 'deference', limit: 1, offset: 1 });
  assert.equal(rest.matched, 2);
  assert.equal(rest.nextOffset, undefined);
  assert.notEqual(rest.results[0].guid, capped.results[0].guid);

  assert.equal((await call('search_cases', { query: 'zzzz-no-such-term' })).matched, 0);
});

test('search_cases validates its arguments', async () => {
  await expectToolError('search_cases', { query: 42 }, 'invalid_argument');
  await expectToolError('search_cases', { query: 'x', limit: 0 }, 'invalid_argument');
  await expectToolError('search_cases', { query: 'x', offset: -1 }, 'invalid_argument');
  await expectToolError('search_cases', { query: 'x', limit: 'many' }, 'invalid_argument');
  // Number() used to accept all of these as counts.
  for (const limit of [true, '1e1', '2.5', 2.5, '', ' ', '0x10', [3]]) {
    await expectToolError('search_cases', { query: 'x', limit }, 'invalid_argument');
  }
  await expectToolError('list_cases', { offset: false }, 'invalid_argument');
  await expectToolError('list_cases', { offset: '-1' }, 'invalid_argument');
  await expectToolError('get_source_text', { documentId: 'doc-apa-706', maxChars: true },
    'invalid_argument');
  // A client that stringifies numbers still pages.
  assert.equal((await call('list_cases', { limit: '2', offset: ' 1 ' })).returned, 2);
  // Over the ceiling is clamped, not refused, since the model asked for too much
  // and not for something wrong.
  assert.ok((await call('search_cases', { query: 'v', limit: 10000 })).returned <= LIMITS.maxRows);
});

/**
 * The gap that made a library unreadable. Every enumerating tool needed a key the
 * caller didn't have: list_project_cases needs a project id, and an authority
 * filed under no project is in none of them, so the only way to see the whole
 * library was to guess search terms until the guesses ran out.
 */
test('list_cases enumerates the library with no argument at all', async () => {
  const all = await call('list_cases');
  assert.equal(all.matched, 4);
  assert.equal(all.returned, 4);
  assert.deepEqual(all.results.map(row => row.guid).sort(),
    ['case-bare', 'case-loper-bright', 'case-lujan', 'case-verbose']);
});

test('list_cases reaches the authorities no project contains', async () => {
  const unfiled = await call('list_cases', { project: 'none' });
  assert.equal(unfiled.matched, 1);
  assert.equal(unfiled.results[0].guid, 'case-bare');
  assert.equal(unfiled.project, 'none');

  const filed = await call('list_cases', { project: 1 });
  assert.equal(filed.matched, 2);
  assert.equal(filed.project.name, 'Chevron deference brief');
});

test('list_cases pages, and every page says how to get the next one', async () => {
  const first = await call('list_cases', { limit: 2 });
  assert.equal(first.matched, 4);
  assert.equal(first.returned, 2);
  assert.equal(first.nextOffset, 2);
  assert.match(first.truncated, /offset 2/);

  const second = await call('list_cases', { limit: 2, offset: first.nextOffset });
  assert.equal(second.returned, 2);
  assert.equal(second.nextOffset, undefined);
  const seen = [...first.results, ...second.results].map(row => row.guid);
  assert.equal(new Set(seen).size, 4, 'paging must not repeat or lose a record');
});

test('list_cases filters by court and tag, and sorts', async () => {
  assert.equal((await call('list_cases', { court: '9th' })).matched, 1);
  assert.equal((await call('list_cases', { court: 'Supreme' })).matched, 2);
  assert.equal((await call('list_cases', { tag: 'deference' })).matched, 2);
  assert.equal((await call('list_cases', { court: 'Supreme', tag: 'standing' })).matched, 1);
  // A whole tag, ignoring case and surrounding space, and never part of one.
  assert.equal((await call('list_cases', { tag: '  Administrative LAW ' })).matched, 1);
  assert.equal((await call('list_cases', { tag: 'law' })).matched, 0);
  assert.equal((await call('list_cases', { tag: 'defer' })).matched, 0);
  assert.equal((await call('search_cases', { query: 'chevron', tag: 'administrative' })).matched, 0);

  const byYear = await call('list_cases', { sort: 'year' });
  assert.deepEqual(byYear.results.map(row => row.year), [2024, 2023, 1992, null]);
  const byQuotes = await call('list_cases', { sort: 'quotes' });
  assert.equal(byQuotes.results[0].guid, 'case-loper-bright');

  await expectToolError('list_cases', { sort: 'relevance' }, 'invalid_argument');
  await expectToolError('list_cases', { project: 99 }, 'project_not_found');
});

/**
 * Every row has to be readable on its own, or a whole-library question costs one
 * get_case per authority. The summary is the user's own words, never generated,
 * so the field it came from travels with it.
 */
test('every case row carries a summary, and says where it came from', async () => {
  const rows = (await call('list_cases')).results;
  const byGuid = Object.fromEntries(rows.map(row => [row.guid, row]));

  assert.equal(byGuid['case-loper-bright'].summarySource, 'holding');
  assert.match(byGuid['case-loper-bright'].summary, /Chevron is overruled/);
  assert.equal(byGuid['case-lujan'].summarySource, 'keyFacts');
  assert.equal(byGuid['case-verbose'].summarySource, 'notes');
  assert.ok(byGuid['case-verbose'].summary.length <= LIMITS.summaryChars + 4);

  // A record with nothing written on it says so instead of omitting the field and
  // inviting a get_case that would find nothing either.
  assert.equal(byGuid['case-bare'].summary, '');
  assert.equal(byGuid['case-bare'].summarySource, undefined);
});

/**
 * "*" is the first thing people try for "show me everything", and zero matches is
 * indistinguishable from an empty library.
 */
test('a wildcard or empty query browses, and says that is what happened', async () => {
  for (const args of [{ query: '*' }, {}, { query: '   ' }]) {
    const result = await call('search_cases', args);
    assert.equal(result.matched, 4, JSON.stringify(args));
    assert.equal(result.browsing, true);
    assert.match(result.note, /wildcards are not supported|No query/);
    assert.match(result.note, /list_cases/);
  }
});

test('search_cases narrows by the same facets list_cases does', async () => {
  const ninth = await call('search_cases', { query: 'deference', court: '9th' });
  assert.equal(ninth.matched, 1);
  assert.equal(ninth.results[0].guid, 'case-verbose');
  assert.equal(ninth.court, '9th');

  assert.equal((await call('search_cases', { query: 'deference', project: 1 })).matched, 2);
  assert.equal((await call('search_cases', { query: 'deference', tag: 'standing' })).matched, 0);
  await expectToolError('search_cases', { query: 'x', project: 99 }, 'project_not_found');
});

test('get_case returns the research, and the sources captured for it', async () => {
  const detail = await call('get_case', { guid: 'case-loper-bright' });
  assert.equal(detail.title, 'Loper Bright Enterprises v. Raimondo');
  assert.match(detail.notes, /Overrules Chevron/);
  assert.equal(detail.holding, 'Courts decide statutory questions independently; Chevron is overruled.');
  assert.equal(detail.quotes.length, 2);
  assert.equal(detail.quotes[0].pincite, '412');
  assert.deepEqual(detail.capturedSources.map(source => source.documentId).sort(),
    ['doc-apa-706', 'doc-loper-opinion']);

  // A record with nothing on it must project cleanly instead of throwing.
  const bare = await call('get_case', { guid: 'case-bare' });
  assert.equal(bare.quotes.length, 0);
  assert.equal(bare.hasNotes, false);
  assert.equal(bare.capturedSources, undefined);
});

/**
 * How the user connected two authorities is research that lives between records
 * instead of on one, and nothing returned it before. Direction needs care:
 * "Loper Bright distinguishes Lujan" and its inverse are different legal claims,
 * so the sentence is composed once, at the source.
 */
test('get_case returns how the user connected this authority to others', async () => {
  const loper = await call('get_case', { guid: 'case-loper-bright' });
  assert.equal(loper.related.length, 1);
  assert.deepEqual(loper.related[0], {
    type: 'distinguishes',
    direction: 'outbound',
    guid: 'case-lujan',
    title: 'Lujan v. Defenders of Wildlife',
    note: 'Different threshold question.',
    reads: 'Loper Bright Enterprises v. Raimondo distinguishes Lujan v. Defenders of Wildlife'
  });

  // The same edge from the other end. The far title flips and the sentence doesn't.
  const lujan = await call('get_case', { guid: 'case-lujan' });
  assert.equal(lujan.related[0].direction, 'inbound');
  assert.equal(lujan.related[0].guid, 'case-loper-bright');
  assert.equal(lujan.related[0].title, 'Loper Bright Enterprises v. Raimondo');
  assert.equal(lujan.related[0].reads, loper.related[0].reads);

  // An authority in no relationship doesn't carry an empty array.
  assert.equal((await call('get_case', { guid: 'case-bare' })).related, undefined);
});

test('a note written on a relationship is searchable from either end', async () => {
  const found = await call('search_cases', { query: 'threshold question' });
  const hit = found.results.find(row => row.guid === 'case-lujan');
  assert.ok(hit, 'the note belongs to both ends of the edge, not just the one it was typed on');
  assert.equal(hit.matchedPassage.field, 'related');
  assert.match(hit.matchedPassage.text, /distinguishes/);
});

test('library_overview counts the connections and says where to read them', async () => {
  const overview = await call('library_overview');
  assert.equal(overview.authorities.connected, 2);
  assert.match(overview.guidance.join(' '), /get_case returns those under "related"/);
});

test('get_case clips a long note instead of returning the whole thing', async () => {
  const verbose = await call('get_case', { guid: 'case-verbose' });
  assert.ok(verbose.notes.length < LIMITS.notesChars + 60);
  assert.match(verbose.notes, /\[clipped, \d+ more characters\]/);
  assert.ok(verbose.quotes[0].text.length < LIMITS.quoteChars + 60);
});

test('get_case names the guid it could not find, and how to find one', async () => {
  await assert.rejects(async () => call('get_case', { guid: 'nope' }), error => {
    assert.equal(error.code, 'case_not_found');
    assert.match(error.message, /nope/);
    assert.match(error.hint, /search_cases/);
    return true;
  });
});

test('search_quotes finds language across the library', async () => {
  const hits = await call('search_quotes', { query: 'independent judgment' });
  assert.equal(hits.matched, 2);
  assert.deepEqual(hits.results.map(hit => hit.caseGuid).sort(), ['case-loper-bright', 'case-verbose']);
  const loper = hits.results.find(hit => hit.caseGuid === 'case-loper-bright');
  assert.equal(loper.pincite, '412');
  assert.equal(loper.citation, '603 U.S. 369 (2024)');

  // A limit must not distort the reported total.
  const capped = await call('search_quotes', { query: 'independent judgment', limit: 1 });
  assert.equal(capped.matched, 2);
  assert.equal(capped.returned, 1);
});

test('list_project_cases accepts either project key and refuses a stranger', async () => {
  const byId = await call('list_project_cases', { projectId: 1 });
  assert.equal(byId.matched, 2);
  assert.equal(byId.project.name, 'Chevron deference brief');

  const project = (await call('library_overview')).projects.find(item => item.id === 1);
  assert.equal((await call('list_project_cases', { projectId: project.uid })).matched, 2);

  await assert.rejects(async () => call('list_project_cases', { projectId: 99 }), error => {
    assert.equal(error.code, 'project_not_found');
    assert.match(error.hint, /Chevron deference brief/);
    return true;
  });
  await expectToolError('list_project_cases', {}, 'invalid_argument');
});

test('get_source_text returns captured text and pages through it', async () => {
  const statute = await call('get_source_text', { documentId: 'doc-apa-706' });
  assert.equal(statute.document.contentType, 'statute');
  assert.equal(statute.sectionsTotal, 2);
  assert.equal(statute.returned, 2);
  assert.equal(statute.nextOffset, undefined);
  assert.deepEqual(statute.sections.map(section => section.label), ['(a)', '(2)(A)']);
  assert.match(statute.sections[0].text, /reviewing court shall decide/);

  const second = await call('get_source_text', { documentId: 'doc-apa-706', offset: 1 });
  assert.equal(second.offset, 1);
  assert.equal(second.returned, 1);
  assert.equal(second.sections[0].label, '(2)(A)');

  const past = await call('get_source_text', { documentId: 'doc-apa-706', offset: 99 });
  assert.equal(past.returned, 0);

  // The captured opinion body, which the ordinary JSON export does not carry.
  const opinion = await call('get_source_text', { documentId: 'doc-loper-opinion' });
  assert.equal(opinion.document.contentType, 'case');
  assert.match(opinion.sections[0].text, /full opinion paragraph body text/);

  await expectToolError('get_source_text', { documentId: 'doc-nope' }, 'document_not_found');
  await expectToolError('get_source_text', { documentId: 'doc-apa-706', offset: -1 }, 'invalid_argument');
});

/**
 * All-or-nothing reading made summarising a library expensive, since the only way
 * to learn what an opinion said was to receive the whole thing. Each of these is
 * a way to pay for only the part that answers the question.
 */
test('get_source_text can return structure instead of text', async () => {
  const outline = await call('get_source_text', { documentId: 'doc-apa-706', outline: true });
  assert.equal(outline.outline, true);
  assert.equal(outline.sectionsTotal, 2);
  assert.deepEqual(outline.sections.map(section => section.index), [0, 1]);
  assert.deepEqual(outline.sections.map(section => section.label), ['(a)', '(2)(A)']);
  assert.deepEqual(outline.sections.map(section => section.chars), [247, 194]);
  assert.ok(outline.sections.every(section => section.text === undefined));
  assert.match(outline.note, /limit: 1/);
});

test('get_source_text returns an excerpt when asked for one', async () => {
  const excerpt = await call('get_source_text', { documentId: 'doc-apa-706', maxChars: 120 });
  assert.equal(excerpt.returned, 1);
  assert.ok(excerpt.sections[0].text.length < 200);
  assert.match(excerpt.sections[0].text, /\[clipped, \d+ more characters\]/);
  // The section says how long it really is, so the caller can judge the excerpt.
  assert.equal(excerpt.sections[0].chars, 247);
  assert.equal(excerpt.nextOffset, 1);
  await expectToolError('get_source_text',
    { documentId: 'doc-apa-706', maxChars: 0 }, 'invalid_argument');
});

test('get_source_text returns only the sections that answer a query', async () => {
  const found = await call('get_source_text',
    { documentId: 'doc-apa-706', query: '"set aside" arbitrary capricious' });
  assert.equal(found.matchedSections, 1);
  assert.equal(found.returned, 1);
  assert.equal(found.sections[0].index, 1, 'the index is the section\'s place in the document');
  assert.match(found.sections[0].text, /set aside agency action/);

  const missed = await call('get_source_text', { documentId: 'doc-apa-706', query: 'mootness' });
  assert.equal(missed.matchedSections, 0);
  assert.equal(missed.returned, 0);
  assert.match(missed.note, /outline: true/);
});

test('find_citation_mentions maps a draft back onto the library', async () => {
  const draft = 'The Court abandoned deference in 603 U.S. 369 (2024). Standing still '
    + 'follows 504 U.S. 555 (1992), which the brief cites twice.';
  const found = await call('find_citation_mentions', { text: draft });

  assert.equal(found.matched, 2);
  assert.deepEqual(found.results.map(row => row.caseGuid), ['case-loper-bright', 'case-lujan']);
  assert.equal(found.results[0].caseTitle, 'Loper Bright Enterprises v. Raimondo');
  assert.match(found.results[0].context, /abandoned deference/);
  assert.equal(found.casesSearched, 4);

  assert.equal((await call('find_citation_mentions', { text: 'no citations here' })).matched, 0);

  // Paging, because a long draft can cite more than one page of authorities and
  // the alternative is a truncation note pointing at arguments that do not exist.
  const paged = await call('find_citation_mentions', { text: draft, limit: 1 });
  assert.equal(paged.matched, 2);
  assert.equal(paged.nextOffset, 1);
  assert.equal((await call('find_citation_mentions', { text: draft, limit: 1, offset: 1 }))
    .results[0].caseGuid, 'case-lujan');
  await expectToolError('find_citation_mentions',
    { text: 'x'.repeat(LIMITS.inputTextBytes + 1) }, 'input_too_large');
});

/**
 * A brief cites the same authority many times and rarely in the library's exact
 * spelling. Every place counts, because the point is to check each one.
 */
test('find_citation_mentions finds every citation in any spelling', async () => {
  const draft = 'Under 603 US 369, 412 (2024), courts decide. Loper Bright, 603 U. S. 369, '
    + 'controls; see also 77 F. 4th 100. But 1603 U.S. 369 and 603 U.S. 3690 are not citations '
    + 'to it, and neither is 77 F.4th 1000. Again: 603 U.S. 369.';
  const found = await call('find_citation_mentions', { text: draft });

  assert.deepEqual(found.results.map(row => [row.caseGuid, row.citation]), [
    ['case-loper-bright', '603 US 369'],
    ['case-loper-bright', '603 U. S. 369'],
    ['case-verbose', '77 F. 4th 100'],
    ['case-loper-bright', '603 U.S. 369']
  ]);
  assert.equal(found.matched, 4);
  for (const row of found.results) {
    assert.equal(draft.slice(row.index, row.index + row.citation.length), row.citation,
      'index points at the citation as written');
  }
  assert.equal(found.results[0].libraryCitation, '603 U.S. 369 (2024)',
    'the library\'s own spelling comes back when the draft differs');
  assert.ok(found.casesSearched > 0);

  // Repeats page like anything else.
  const page = await call('find_citation_mentions', { text: draft, limit: 2, offset: 2 });
  assert.deepEqual(page.results.map(row => row.citation), ['77 F. 4th 100', '603 U.S. 369']);
  assert.equal(page.nextOffset, undefined);
});

test('reload_snapshot re-reads from disk', async () => {
  const result = await await call('reload_snapshot');
  assert.equal(result.reloaded, true);
  assert.equal(result.records, 15);
  assert.equal(path.basename(result.sourceFile), 'library.qlvault');
  assert.equal((await call('library_overview')).counts.cases, 4);
});
