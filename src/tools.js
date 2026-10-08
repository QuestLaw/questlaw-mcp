/**
 * The read-only tools. Every one returns a bounded result.
 *
 * Search is ranked BM25F over src/search-index.js, not the substring match in
 * the vendored search.js, which couldn't order results, couldn't survive a
 * paraphrase, and never saw captured source text. find_citation_mentions uses
 * src/citations.js instead of the vendored exact-string scan, for the reasons
 * given there. The vendored helpers still choose which citation a case is known by.
 */
'use strict';

const { Search } = require('./core-modules');
const { buildIndex, search: runSearch, edgesByAuthority } = require('./search-index');
const { buildCitationIndex, findCitationMentions } = require('./citations');
const { LibraryError } = require('./errors');
const { LIMITS, capRows, clip, listResult, rowBudget } = require('./limits');
const {
  caseSummary, caseDetail, quoteHit, sourceSummary, sectionView, sectionOutline,
  relatedAuthority, pincite
} = require('./projections');
const { parseQuery, tokenize, STOPWORDS } = require('./tokenize');

/* ------------------------------------------------------------- arguments */

function invalid(message, hint) {
  return new LibraryError('invalid_argument', message, { hint });
}

function requireString(args, name, maxBytes = 4096) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${name} is required and must be a non-empty string.`);
  }
  const bytes = Buffer.byteLength(value);
  if (bytes > maxBytes) {
    throw new LibraryError('input_too_large',
      `${name} is ${bytes} bytes; the limit is ${maxBytes}.`,
      { hint: 'Send the relevant passage rather than the whole document.' });
  }
  return value;
}

/**
 * A query is optional everywhere it's accepted. Asking for the whole library with
 * "*" or nothing used to come back as "nothing matched", which looks like an
 * empty library. Now an unsearchable query browses, and the result says so.
 */
function readQuery(args, maxBytes = 4096) {
  const value = args.query;
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid('query must be a string.');
  const bytes = Buffer.byteLength(value);
  if (bytes > maxBytes) {
    throw new LibraryError('input_too_large',
      `query is ${bytes} bytes; the limit is ${maxBytes}.`,
      { hint: 'Search for the distinctive words rather than pasting the passage.' });
  }
  return value;
}

/**
 * A whole number, sent as a number or as a string of digits, since some clients
 * stringify arguments. Number() alone took true as 1 and "1e1" as 10, and
 * neither is a count anyone meant.
 */
function readInteger(args, name, minimum, message) {
  const value = args[name];
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw invalid(message);
  return parsed;
}

function readLimit(args) {
  if (args.limit === undefined || args.limit === null) return LIMITS.defaultRows;
  return Math.min(readInteger(args, 'limit', 1, 'limit must be a positive integer.'), LIMITS.maxRows);
}

function readOffset(args) {
  if (args.offset === undefined || args.offset === null) return 0;
  return readInteger(args, 'offset', 0, 'offset must be a whole number, zero or greater.');
}

/** Paging arguments as every list tool declares them. */
const limitSchema = description => ({ type: 'integer', minimum: 1, maximum: LIMITS.maxRows, description });
const offsetSchema = description => ({ type: 'integer', minimum: 0, description });

/* --------------------------------------------------------------- indexes */

// Built once per snapshot, since get_case and get_source_text are lookups and a
// linear scan per call is too slow for a 20,000-record library.
const INDEXES = new WeakMap();

function indexFor(snapshot) {
  const existing = INDEXES.get(snapshot);
  if (existing) return existing;
  const { cases, documents, documentSections } = snapshot.library;
  const sectionsByDocument = new Map();
  for (const section of documentSections) {
    const list = sectionsByDocument.get(section.documentId);
    if (list) list.push(section);
    else sectionsByDocument.set(section.documentId, [section]);
  }
  for (const list of sectionsByDocument.values()) {
    list.sort((left, right) => (left.order || 0) - (right.order || 0));
  }
  const sourcesByAuthority = new Map();
  for (const document of documents) {
    const list = sourcesByAuthority.get(document.authorityGuid);
    if (list) list.push(document);
    else sourcesByAuthority.set(document.authorityGuid, [document]);
  }
  // Shared with the search index so the two agree on which edges still count.
  const edgesByGuid = edgesByAuthority(snapshot.library);
  const index = {
    cases: new Map(cases.map(item => [String(item.guid), item])),
    documents: new Map(documents.map(item => [String(item.documentId), item])),
    sectionsByDocument,
    sourcesByAuthority,
    edgesByGuid,
    citations: buildCitationIndex(cases, Search.getBestCitation)
  };
  INDEXES.set(snapshot, index);
  return index;
}

// Built once per snapshot and dropped with it. On the 2,000-authority benchmark
// that adds well under a second to a read that already took one.
const SEARCH_INDEXES = new WeakMap();

function searchIndexFor(snapshot) {
  const existing = SEARCH_INDEXES.get(snapshot);
  if (existing) return existing;
  const index = buildIndex(snapshot.library);
  SEARCH_INDEXES.set(snapshot, index);
  return index;
}

/**
 * Builds both indexes before a snapshot is served. The snapshot store calls this
 * as the last step of a read, so the cost lands in the load the caller is already
 * waiting on (with progress reported) instead of on the first query.
 */
function warmIndexes(snapshot) {
  indexFor(snapshot);
  searchIndexFor(snapshot);
}

function resolveHit(snapshot, hit) {
  const index = indexFor(snapshot);
  if (hit.type === 'case') return index.cases.get(String(hit.ref));
  if (hit.type === 'quote') {
    const caseData = index.cases.get(String(hit.ref.guid));
    const quote = caseData?.quotes?.[hit.ref.quoteIndex];
    return quote ? { caseData, quote } : null;
  }
  const sections = index.sectionsByDocument.get(hit.ref.documentId) || [];
  const section = hit.ref.sectionId
    ? sections.find(item => item.sectionId === hit.ref.sectionId)
    : sections[0];
  return section ? { document: index.documents.get(hit.ref.documentId), section } : null;
}

function relatedFor(snapshot, guid) {
  const index = indexFor(snapshot);
  const titleOf = key => index.cases.get(String(key))?.title || '';
  return (index.edgesByGuid.get(String(guid)) || []).map(edge => {
    const outbound = String(edge.fromGuid) === String(guid);
    return relatedAuthority(
      { ...edge, fromTitle: titleOf(edge.fromGuid), toTitle: titleOf(edge.toGuid) },
      { outbound, other: String(outbound ? edge.toGuid : edge.fromGuid) }
    );
  });
}

function capturedSourcesFor(snapshot, guid) {
  const index = indexFor(snapshot);
  return (index.sourcesByAuthority.get(guid) || []).map(document =>
    sourceSummary(document, (index.sectionsByDocument.get(document.documentId) || []).length));
}

function projectKeys(project) {
  return [project.id, project.uid].filter(value => value !== undefined && value !== null)
    .map(String);
}

function caseProjectKeys(caseData) {
  const ids = Array.isArray(caseData.projectIds) ? caseData.projectIds : [];
  const keys = ids.map(String);
  // Older records have a single projectId and no projectIds.
  if (caseData.projectId !== undefined && caseData.projectId !== null) {
    keys.push(String(caseData.projectId));
  }
  return keys;
}

function caseInProject(caseData, key) {
  return caseProjectKeys(caseData).includes(key);
}

/** One pass over the cases instead of one per project. */
function caseCountsByProjectKey(cases) {
  const counts = new Map();
  for (const caseData of cases) {
    for (const key of new Set(caseProjectKeys(caseData))) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/* ----------------------------------------------------------------- facets */

/** Project filter value for authorities filed under no project. */
const UNFILED = 'none';

const given = value => value !== undefined && value !== null && value !== '';

function projectNotFound(snapshot, key) {
  const known = snapshot.library.projects.slice(0, 20)
    .map(item => `${item.id} (${item.name || 'unnamed'})`).join(', ');
  return new LibraryError('project_not_found', `No project with id ${key}.`, {
    hint: `Known projects: ${known || 'none'}. `
      + 'Pass project "none" for authorities filed under no project, or call list_cases '
      + 'with no filter for the whole library.'
  });
}

function courtText(caseData) {
  return [caseData.court, caseData.jurisdictionText].filter(Boolean).join(' ');
}

/**
 * The facets a caller narrows by rather than searches by. Court is a filter and
 * not ranked text because every federal court name contains "United States" and
 * "Court", and many contain "District", so as free text they matched the whole
 * library and ranked nothing. Tag and project work the same way.
 *
 * @returns {{test: (caseData: object) => boolean, echo: object, active: boolean}}
 */
function readCaseFacets(args, snapshot) {
  const tests = [];
  const echo = {};

  const project = given(args.project) ? args.project : args.projectId;
  if (given(project)) {
    const key = String(project).trim();
    if (key.toLowerCase() === UNFILED) {
      tests.push(caseData => caseProjectKeys(caseData).length === 0);
      echo.project = UNFILED;
    } else {
      const found = snapshot.library.projects.find(item => projectKeys(item).includes(key));
      if (!found) throw projectNotFound(snapshot, key);
      const keys = projectKeys(found);
      tests.push(caseData => keys.some(candidate => caseInProject(caseData, candidate)));
      echo.project = { id: found.id, uid: found.uid, name: found.name || '' };
    }
  }

  // A whole tag, not part of one. As a substring, "law" matched "administrative
  // law" and "lawyering", so a tag that exists matched authorities that don't carry it.
  if (given(args.tag)) {
    const wanted = String(args.tag).trim().toLowerCase();
    tests.push(caseData => (Array.isArray(caseData.tags) ? caseData.tags : [])
      .some(tag => String(tag).trim().toLowerCase() === wanted));
    echo.tag = String(args.tag).trim();
  }

  if (given(args.court)) {
    const needle = String(args.court).trim().toLowerCase();
    tests.push(caseData => courtText(caseData).toLowerCase().includes(needle));
    echo.court = String(args.court).trim();
  }

  return {
    test: caseData => tests.every(check => check(caseData)),
    echo,
    active: tests.length > 0
  };
}

const SORTS = Object.freeze({
  title: (left, right) => String(left.title || '').localeCompare(String(right.title || '')),
  recent: (left, right) => (Number(right.dateAdded) || 0) - (Number(left.dateAdded) || 0),
  year: (left, right) => (Number(right.year) || 0) - (Number(left.year) || 0),
  quotes: (left, right) =>
    (right.quotes?.length || 0) - (left.quotes?.length || 0)
});

function readSort(args) {
  if (!given(args.sort)) return SORTS.title;
  const name = String(args.sort).trim();
  if (!SORTS[name]) {
    throw invalid(`sort must be one of ${Object.keys(SORTS).join(', ')}; got ${name}.`);
  }
  return SORTS[name];
}

/**
 * The passage that explains a hit. It's called `matchedPassage` rather than
 * `matched` because the envelope's `matched` is the result count, and rows
 * shouldn't reuse that name for something else.
 */
function matchedPassage(hit) {
  if (!hit.snippet?.text) return {};
  return { matchedPassage: { field: hit.snippet.field, text: hit.snippet.text } };
}

/** The other hits from the same authority or document, one line each, so they don't take a row apiece. */
function groupedMatches(hit, snapshot) {
  if (!hit.grouped?.length) return {};
  const also = hit.grouped.map(member => {
    const resolved = resolveHit(snapshot, member);
    if (!resolved) return null;
    if (member.type === 'quote') {
      return { kind: 'quote', pincite: pincite(resolved.quote),
        text: clip(resolved.quote.text, GROUPED_TEXT_CHARS) };
    }
    if (member.type === 'case') {
      return { kind: 'case', guid: resolved.guid, title: resolved.title || '' };
    }
    return {
      kind: 'source',
      label: resolved.section.label || '',
      heading: resolved.section.heading || '',
      ...(member.snippet?.text ? { text: clip(member.snippet.text, GROUPED_TEXT_CHARS) } : {})
    };
  }).filter(Boolean);
  return {
    alsoMatched: also,
    ...(hit.groupedTotal > also.length ? { alsoMatchedTotal: hit.groupedTotal } : {})
  };
}

/** Characters of each grouped match shown under its row. */
const GROUPED_TEXT_CHARS = 240;

/**
 * One row of a mixed-type result. Only a source hit needs a second call to read
 * its full text, so the row spells that call out.
 */
function mixedSearchRow(hit, resolved) {
  const common = hit.relevance === null
    ? { kind: hit.type }
    : { kind: hit.type, relevance: hit.relevance };
  if (hit.type === 'case') {
    return { ...common, ...caseSummary(resolved), ...matchedPassage(hit) };
  }
  if (hit.type === 'quote') {
    return { ...common, ...quoteHit(resolved.caseData, resolved.quote) };
  }
  return {
    ...common,
    documentId: resolved.section.documentId,
    title: resolved.document?.sourceTitle || '',
    citation: resolved.document?.sourceCitation || '',
    contentType: resolved.document?.contentType || '',
    label: resolved.section.label || '',
    ...matchedPassage(hit),
    readWith: `get_source_text(documentId: "${resolved.section.documentId}")`
  };
}

const SEARCH_TYPES = new Set(['case', 'quote', 'source']);

function readTypes(args) {
  const value = args.types;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length) {
    throw invalid('types must be a non-empty array of "case", "quote", or "source".');
  }
  for (const entry of value) {
    if (!SEARCH_TYPES.has(entry)) {
      throw invalid(`types may only contain case, quote, or source; got ${JSON.stringify(entry)}.`);
    }
  }
  return [...new Set(value)];
}

/** Explains why a query with no searchable words ("*", punctuation, nothing) returned the whole library. */
function browseNote(query, listTool) {
  const asked = String(query || '').trim();
  return (asked
    ? `${JSON.stringify(clip(asked, 40))} has no searchable words in it -- wildcards are not `
      + 'supported -- so this is the library itself, in stored order. '
    : 'No query, so this is the library itself, in stored order. ')
    + `${listTool} browses authorities with filters and sorting; a query of real words ranks `
    + 'these instead.';
}

/** Reports shorthand expansions, since a row matching "summary judgment" for a query of "MSJ" would look like a mistake. */
function shorthandNote(result) {
  if (!result.readAs?.length) return {};
  return { readAs: result.readAs.map(({ from, to }) => `${from} = ${to}`) };
}

/**
 * Explains why a query behaved the way it did. Without it, a search for a word
 * the library doesn't contain looks the same as a misspelled one, so this reports
 * the terms that matched and notes when the query was widened or had nothing
 * searchable.
 */
function searchDiagnostics(query, result, { listTool = 'list_cases' } = {}) {
  const diagnostics = {};

  if (result.browsed) {
    diagnostics.browsing = true;
    diagnostics.note = browseNote(query, listTool);
    return diagnostics;
  }

  const asked = parseQuery(query).terms;
  const matched = new Set(result.terms);
  const ignored = new Set(result.ignoredCourtTerms || []);
  // Court boilerplate gets its own note below.
  const unmatched = asked.filter(term => !matched.has(term) && !ignored.has(term));
  const notes = [];

  if (result.terms.length) diagnostics.matchedTerms = result.terms;
  Object.assign(diagnostics, shorthandNote(result));
  if (unmatched.length && result.terms.length && result.total > 0) {
    notes.push(`No exact match for ${unmatched.join(', ')}; `
      + `matched ${result.terms.join(', ')} instead.`);
  }
  if (!result.total) {
    notes.push('Nothing matched. Try fewer or more common words, or call '
      + `library_overview to see what this library actually contains, or ${listTool} to browse it.`);
  }
  // Court boilerplate is indexed out on purpose, so say so instead of letting the words vanish.
  const court = result.ignoredCourtTerms || [];
  if (court.length) {
    notes.push(`Court names are a filter here, not search text: ${court.join(', ')} `
      + `${court.length === 1 ? 'was' : 'were'} ignored, because those words appear in almost `
      + 'every court name. Pass court: "Ninth Circuit" (or any distinctive part of a court name) '
      + 'to narrow by court instead.');
  }
  if (notes.length) diagnostics.note = notes.join(' ');
  if (result.phrases.length) {
    diagnostics.requiredPhrases = result.phrases.map(phrase => phrase.join(' '));
  }
  return diagnostics;
}

function facetCounts(cases) {
  const tagCounts = new Map();
  const courtCounts = new Map();
  const years = [];

  for (const caseData of cases) {
    for (const tag of Array.isArray(caseData.tags) ? caseData.tags : []) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    const court = String(caseData.court || '').trim();
    if (court) courtCounts.set(court, (courtCounts.get(court) || 0) + 1);
    if (Number(caseData.year)) years.push(Number(caseData.year));
  }
  return { tagCounts, courtCounts, years };
}

function tallyAuthorities(cases, edgesByGuid) {
  const tally = {
    unfiled: 0, connected: 0, withNotes: 0, withQuotes: 0, quotes: 0, tagged: 0
  };

  for (const caseData of cases) {
    if (Array.isArray(caseData.tags) && caseData.tags.length) tally.tagged += 1;
    if (!caseProjectKeys(caseData).length) tally.unfiled += 1;
    if (edgesByGuid.has(String(caseData.guid))) tally.connected += 1;
    if (String(caseData.notes || '').trim()) tally.withNotes += 1;

    const saved = Array.isArray(caseData.quotes) ? caseData.quotes.length : 0;
    if (saved) { tally.withQuotes += 1; tally.quotes += saved; }
  }
  return tally;
}

/**
 * Next-step advice based on what this library actually contains. The unfiled
 * count matters most, since a model that only knows list_project_cases never
 * sees those records and reads the library as smaller than it is.
 */
function overviewGuidance({ total, unfiled, tagged, withSource, connected }) {
  const guidance = [
    `list_cases with no arguments walks all ${total} authorities, ${LIMITS.defaultRows} at a `
      + 'time; follow nextOffset for the rest. Every row carries a summary, so a whole-library '
      + 'question rarely needs get_case.'
  ];
  if (unfiled) {
    guidance.push(`${unfiled} of ${total} authorities are filed under no project, so `
      + 'list_project_cases cannot reach them at all. list_cases(project: "none") lists exactly '
      + 'those, and list_cases with no arguments covers everything.');
  }
  if (!tagged) {
    guidance.push('No authority in this library is tagged, so tags are not a way in here. '
      + 'Narrow by project, court, or a search query instead.');
  }
  guidance.push('Search is lexical, not semantic: use the words the user would have written. '
    + 'Quote a phrase to require it verbatim. Court names are a filter argument, not search text.');
  if (withSource) {
    guidance.push(`${withSource} ${withSource === 1 ? 'authority has' : 'authorities have'} `
      + 'captured source text. search_library with '
      + 'types: ["source"] searches inside it; get_source_text reads it, and takes outline, '
      + 'query, and maxChars so a long opinion does not have to arrive whole.');
  }
  if (connected) {
    guidance.push(`${connected} authorities are connected to another one -- distinguishes, `
      + 'follows, and so on, each with the user\'s note on why. get_case returns those under '
      + '"related", and the notes on them are searchable like any other text.');
  }
  return guidance;
}

/* --------------------------------------------------------------- sections */

function readMaxChars(args) {
  if (args.maxChars === undefined || args.maxChars === null) return 0;
  return readInteger(args, 'maxChars', 1, 'maxChars must be a positive integer.');
}

/** Sections default to the row ceiling instead of the usual default. */
function readSectionLimit(args) {
  if (args.limit === undefined || args.limit === null) return LIMITS.maxRows;
  return readLimit(args);
}

/**
 * The sections of one document that match a query, best first. This is a plain
 * scan instead of an index lookup because it only covers one document, and
 * ranking by distinct query terms per section is cheaper and more predictable
 * than BM25 for about 20 rows.
 */
function sectionsMatching(numbered, query) {
  const { terms, phrases } = parseQuery(query);
  const wanted = new Set([...terms, ...phrases.flat()].filter(term => !STOPWORDS.has(term)));
  if (!wanted.size) return numbered;

  return numbered
    .map(entry => {
      const found = new Set();
      let hits = 0;
      for (const term of tokenize(entry.section.text || '').terms) {
        if (!wanted.has(term)) continue;
        found.add(term);
        hits += 1;
      }
      return { ...entry, distinct: found.size, hits };
    })
    .filter(entry => entry.distinct > 0)
    .sort((left, right) => right.distinct - left.distinct
      || right.hits - left.hits
      || left.position - right.position);
}

const textLength = sections => sections.reduce((total, row) => total + row.text.length, 0);

/** Tells the caller a cheaper way to read when the answer is empty or very long, so nobody reads a whole opinion unaware excerpts exist. */
function sourceNote({ query, maxChars, matches, kept }) {
  if (query && !matches) {
    return `Nothing in this document matches ${JSON.stringify(clip(query, 40))}. `
      + 'Call with outline: true to see what its sections are, or drop query to read it.';
  }
  if (!query && !maxChars && textLength(kept) > LIMITS.longDocumentChars) {
    return 'This is a long document. outline: true lists its sections, query returns only the '
      + 'matching ones, and maxChars returns an excerpt.';
  }
  return '';
}

/** Fills the page under two limits at once, the caller's character budget and the response byte budget. */
function takeSections(page, maxChars, byteBudget) {
  const kept = [];
  let remaining = maxChars || Infinity;
  let bytes = 2;

  for (const entry of page) {
    if (remaining <= 0) break;
    const view = {
      index: entry.position,
      ...sectionView(entry.section, Math.min(LIMITS.sectionChars, remaining))
    };
    const size = Buffer.byteLength(JSON.stringify(view)) + 1;
    if (kept.length && bytes + size > byteBudget) break;
    kept.push(view);
    bytes += size;
    remaining -= view.text.length;
  }
  return kept;
}

/**
 * One captured document as an outline, the sections matching a query, or the
 * text itself. All three page the same way and carry each section's index, so a
 * caller can go from an outline entry straight to reading that section.
 */
function sourceTextResult({
  sections, document, documentId, offset, query, maxChars, limit, outline
}) {
  const header = {
    documentId,
    title: document.sourceTitle || '',
    citation: document.sourceCitation || '',
    contentType: document.contentType || '',
    url: document.sourceUrl || '',
    authorityGuid: document.authorityGuid || ''
  };
  // Numbered before filtering, so an index always means the section's place in the document.
  const numbered = sections.map((section, position) => ({ section, position }));
  const filtering = Boolean(query) && !outline;
  const selected = filtering ? sectionsMatching(numbered, query) : numbered;
  const page = selected.slice(offset, offset + limit);

  const envelope = {
    document: header,
    sectionsTotal: sections.length,
    ...(outline ? { outline: true } : {}),
    ...(filtering ? { query, matchedSections: selected.length } : {}),
    offset,
    returned: page.length,
    sections: []
  };
  const budget = rowBudget(envelope);
  const kept = outline
    ? capRows(page.map(entry => sectionOutline(entry.section, entry.position)), budget)
    : takeSections(page, maxChars, budget);
  const result = { ...envelope, returned: kept.length, sections: kept };

  // A capped document always names the offset that continues it.
  if (offset + kept.length < selected.length) {
    result.nextOffset = offset + kept.length;
    result.truncated = `Sections ${offset}-${offset + kept.length - 1} of `
      + `${selected.length}${filtering ? ' matching' : ''}. Call again with offset `
      + `${result.nextOffset} for the rest.`;
  }
  const note = outline
    ? 'Structure only. Read one section with offset: <its index>, limit: 1; read the whole '
      + 'document by leaving outline off.'
    : sourceNote({ query, maxChars, matches: selected.length, kept });
  if (note) result.note = note;
  return result;
}

/* ----------------------------------------------------------------- tools */

function createTools(store) {
  return [
    {
      name: 'library_overview',
      title: 'What is in this library',
      description: 'What this library contains: how many authorities, which projects, tags and '
        + 'courts they are filed under, how much captured source text there is, and how old the '
        + 'snapshot is. Call this first. It costs one call and tells you which of the other '
        + 'tools can actually reach what you are after.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, context = {}) {
        const snapshot = await store.ready(context);
        const { library } = snapshot;
        const { tagCounts, courtCounts, years } = facetCounts(library.cases);
        const { unfiled, connected, withNotes, withQuotes, quotes, tagged }
          = tallyAuthorities(library.cases, indexFor(snapshot).edgesByGuid);

        const ageHours = (Date.now() - Date.parse(snapshot.exportedAt)) / 3600000;
        const caseCounts = caseCountsByProjectKey(library.cases);
        const withSource = new Set(library.documents
          .map(document => document.authorityGuid).filter(Boolean)).size;
        const byCount = (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]);
        // If a newer export failed to read, this older one is still answering, and the caller should know.
        const { lastReloadError } = store.status();

        return {
          snapshot: {
            sourceFile: snapshot.sourceFile,
            exportedAt: snapshot.exportedAt,
            ageHours: Number(ageHours.toFixed(1)),
            loadedAt: snapshot.loadedAt,
            records: snapshot.decrypted,
            ...(lastReloadError ? { newerExportUnreadable: lastReloadError } : {})
          },
          counts: Object.fromEntries(
            Object.entries(library).map(([name, rows]) => [name, rows.length])),
          authorities: {
            total: library.cases.length,
            unfiled,
            withNotes,
            withQuotes,
            quotes,
            tagged,
            withCapturedSource: withSource,
            connected,
            years: years.length
              ? { from: Math.min(...years), to: Math.max(...years) }
              : null
          },
          projects: library.projects.map(project => ({
            id: project.id,
            uid: project.uid,
            name: project.name || '',
            cases: projectKeys(project)
              .reduce((total, key) => total + (caseCounts.get(key) || 0), 0)
          })),
          tags: [...tagCounts.entries()].sort(byCount)
            .slice(0, LIMITS.overviewTags)
            .map(([tag, count]) => ({ tag, count })),
          courts: [...courtCounts.entries()].sort(byCount)
            .slice(0, LIMITS.overviewCourts)
            .map(([court, count]) => ({ court, count })),
          capturedSourceTypes: [...new Set(library.documents.map(d => d.contentType || 'unknown'))]
            .sort(),
          guidance: overviewGuidance({
            total: library.cases.length, unfiled, tagged: tagCounts.size, withSource, connected
          })
        };
      }
    },

    {
      name: 'list_cases',
      title: 'List authorities',
      description: 'Every authority in the library, with no query and no filter required. This '
        + 'is how you enumerate the library: what is in here, how big is it, summarise all of '
        + 'it. Optionally narrow by project ("none" for the unfiled ones), court, or tag, and '
        + 'sort by title, recency, year, or quote count. Pages through offset, and every row '
        + 'carries a one-line summary drawn from the user\'s own notes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: {
            type: ['string', 'number'],
            description: 'Project id or uid, or "none" for authorities filed under no project. '
              + 'Omit for all of them.'
          },
          court: {
            type: 'string',
            description: 'Keep only authorities whose court contains this text, case-insensitive.'
          },
          tag: {
            type: 'string',
            description: 'Keep only authorities carrying this exact tag, ignoring case. '
              + 'library_overview lists the tags.'
          },
          sort: {
            type: 'string',
            enum: ['title', 'recent', 'year', 'quotes'],
            description: 'title (default), recent (when it was saved), year (of decision), '
              + 'or quotes (how much language is saved from it).'
          },
          limit: limitSchema(`Rows per call, default ${LIMITS.defaultRows}, max ${LIMITS.maxRows}.`),
          offset: offsetSchema('Skip this many rows; use the nextOffset from the previous call.')
        }
      },
      async run(args, context = {}) {
        const snapshot = await store.ready(context);
        const limit = readLimit(args);
        const offset = readOffset(args);
        const sort = readSort(args);
        const facets = readCaseFacets(args, snapshot);

        const matches = snapshot.library.cases.filter(facets.test).sort(sort);
        const rows = matches.slice(offset, offset + limit).map(caseSummary);
        return listResult(rows, matches.length, {
          offset,
          sort: given(args.sort) ? String(args.sort) : 'title',
          ...facets.echo
        });
      }
    },

    {
      name: 'search_cases',
      title: 'Search authorities',
      description: 'Find saved authorities, ranked by relevance across title, citation, tags, '
        + 'notes, analysis, and quote text. Multi-word queries work; so do "quoted phrases", '
        + 'which are required rather than preferred. Citations match in any spelling '
        + '(603 U.S. 369 = 603 US 369). Narrow by project, court, or tag rather than by putting '
        + 'a court name in the query. Each result carries a summary and the passage that '
        + 'matched, so you can usually judge relevance without calling get_case. Omit query to '
        + 'browse; page with offset. To walk the whole library, use list_cases.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: 'What to look for. Natural wording is fine. Omit it to browse instead '
              + 'of rank; wildcards are not supported and do nothing.'
          },
          project: {
            type: ['string', 'number'],
            description: 'Project id or uid to search within, or "none" for authorities filed '
              + 'under no project.'
          },
          court: {
            type: 'string',
            description: 'Keep only authorities whose court contains this text, e.g. "Ninth '
              + 'Circuit" or "Mass". Case-insensitive.'
          },
          tag: {
            type: 'string',
            description: 'Keep only authorities carrying this exact tag, ignoring case. '
              + 'library_overview lists the tags.'
          },
          limit: limitSchema(`Max results, default ${LIMITS.defaultRows}, max ${LIMITS.maxRows}.`),
          offset: offsetSchema('Skip this many ranked results; use the nextOffset from the previous call.')
        }
      },
      async run(args, context = {}) {
        const snapshot = await store.ready(context);
        const query = readQuery(args);
        const limit = readLimit(args);
        const offset = readOffset(args);
        const facets = readCaseFacets(args, snapshot);
        const cases = indexFor(snapshot).cases;
        const result = runSearch(searchIndexFor(snapshot), query, {
          types: ['case'],
          limit,
          offset,
          filter: facets.active
            ? document => facets.test(cases.get(String(document.ref)) || {})
            : null
        });
        const rows = result.hits.map(hit => {
          // Browsing doesn't rank, so rows carry no relevance.
          if (result.browsed) return caseSummary(cases.get(String(hit.ref)));
          return {
            ...caseSummary(cases.get(String(hit.ref))),
            relevance: hit.relevance,
            ...matchedPassage(hit)
          };
        });
        return listResult(rows, result.total, {
          ...(query ? { query } : {}),
          offset,
          ...facets.echo,
          ...searchDiagnostics(query, result)
        });
      }
    },

    {
      name: 'get_case',
      title: 'Read one authority',
      description: 'One authority in full: the user\'s notes and analysis, every saved quotation '
        + 'with its pincite, the projects it is filed under, how they connected it to other '
        + 'authorities (related), and any captured source text available for it. Search and list '
        + 'rows already carry a summary, so reach for this when you need the whole note, the '
        + 'quotations, or those connections -- not to identify a case.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { guid: { type: 'string', description: 'Case guid from a search or list result.' } },
        required: ['guid']
      },
      async run(args, context = {}) {
        const snapshot = await store.ready(context);
        const guid = requireString(args, 'guid', 512);
        const found = indexFor(snapshot).cases.get(guid);
        if (!found) {
          throw new LibraryError('case_not_found', `No authority in this library has guid ${guid}.`,
            { hint: 'Use search_cases or list_cases and pass the guid from a result verbatim.' });
        }
        const detail = caseDetail(found, capturedSourcesFor(snapshot, guid));
        const related = relatedFor(snapshot, guid);
        if (related.length) detail.related = related;
        // Project ids mean nothing to a user, so add the names.
        const keys = new Set(caseProjectKeys(found));
        const projects = snapshot.library.projects
          .filter(project => projectKeys(project).some(key => keys.has(key)))
          .map(project => ({ id: project.id, name: project.name || '' }));
        if (projects.length) detail.projects = projects;
        return detail;
      }
    },

    {
      name: 'search_quotes',
      title: 'Search saved quotations',
      description: 'Search the text of every saved quotation, ranked. Use this when the user '
        + 'wants language to quote rather than an authority to cite: each hit carries the '
        + 'passage, the authority it came from, and its pincite. Quote a phrase to require it '
        + 'verbatim. This searches only what the user chose to save; to search the full text of '
        + 'captured opinions and statutes, use search_library.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: 'Language to find. Omit it to list every saved quotation instead.'
          },
          limit: limitSchema(`Max results, default ${LIMITS.defaultRows}, max ${LIMITS.maxRows}.`),
          offset: offsetSchema('Skip this many results; use the nextOffset from the previous call.')
        }
      },
      async run(args, context = {}) {
        const snapshot = await store.ready(context);
        const query = readQuery(args);
        const limit = readLimit(args);
        const offset = readOffset(args);
        const result = runSearch(searchIndexFor(snapshot), query,
          { types: ['quote'], limit, offset });
        const rows = [];
        for (const hit of result.hits) {
          const resolved = resolveHit(snapshot, hit);
          if (!resolved) continue;
          rows.push(hit.relevance === null
            ? quoteHit(resolved.caseData, resolved.quote)
            : { ...quoteHit(resolved.caseData, resolved.quote), relevance: hit.relevance });
        }
        return listResult(rows, result.total, {
          ...(query ? { query } : {}),
          offset,
          ...searchDiagnostics(query, result)
        });
      }
    },

    {
      name: 'search_library',
      title: 'Search everything',
      description: 'One ranked search across everything: saved authorities, saved quotations, '
        + 'and the full captured text of statutes, regulations, rules, and opinions. Start here '
        + 'when you do not already know which of those holds the answer -- captured source text '
        + 'is reachable no other way except by a document id you would have to know in advance. '
        + 'One row per authority or captured document: its other matching quotations or '
        + 'sections are listed under the row as alsoMatched. Pages with offset. Omit query to '
        + 'browse what exists of each kind.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: 'What to look for. "Quoted phrases" are required verbatim. Optional: '
              + 'omitting it browses rather than ranks.'
          },
          types: {
            type: 'array',
            items: { type: 'string', enum: ['case', 'quote', 'source'] },
            description: 'Restrict to these kinds. Default: all three.'
          },
          limit: limitSchema(`Max results, default ${LIMITS.defaultRows}, max ${LIMITS.maxRows}.`),
          offset: offsetSchema('Skip this many ranked results; use the nextOffset from the previous call.')
        }
      },
      async run(args, context = {}) {
        const snapshot = await store.ready(context);
        const query = readQuery(args);
        const limit = readLimit(args);
        const offset = readOffset(args);
        const types = readTypes(args);
        // Grouped so each record takes one row, with its quotations or sections under it.
        const result = runSearch(searchIndexFor(snapshot), query,
          { types, limit, offset, group: true });

        const rows = result.hits
          .map(hit => {
            const resolved = resolveHit(snapshot, hit);
            return resolved
              ? { ...mixedSearchRow(hit, resolved), ...groupedMatches(hit, snapshot) }
              : null;
          })
          .filter(Boolean);

        return listResult(rows, result.total, {
          ...(query ? { query } : {}),
          offset,
          ...(types ? { types } : {}),
          ...searchDiagnostics(query, result)
        });
      }
    },

    {
      name: 'list_project_cases',
      title: 'List the authorities on a project',
      description: 'Every authority filed under one project or matter. Project ids come from '
        + 'library_overview. Authorities filed under no project are unreachable here: use '
        + 'list_cases, with project "none" for exactly those.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: ['string', 'number'], description: 'Project id or uid.' },
          sort: {
            type: 'string',
            enum: ['title', 'recent', 'year', 'quotes'],
            description: 'Default title.'
          },
          limit: limitSchema(`Rows per call, default ${LIMITS.defaultRows}, max ${LIMITS.maxRows}.`),
          offset: offsetSchema('Skip this many rows; use the nextOffset from the previous call.')
        },
        required: ['projectId']
      },
      async run(args, context = {}) {
        const snapshot = await store.ready(context);
        if (!given(args.projectId)) {
          throw invalid('projectId is required.',
            'list_cases needs no project and lists the whole library.');
        }
        const limit = readLimit(args);
        const offset = readOffset(args);
        const sort = readSort(args);
        const facets = readCaseFacets({ project: args.projectId }, snapshot);
        const matches = snapshot.library.cases.filter(facets.test).sort(sort);
        return listResult(matches.slice(offset, offset + limit).map(caseSummary), matches.length, {
          offset,
          project: facets.echo.project
        });
      }
    },

    {
      name: 'get_source_text',
      title: 'Read captured source text',
      description: 'The captured text of a statute, regulation, court rule, or opinion. Document '
        + 'ids come from get_case (capturedSources) or a search_library source hit. It does not '
        + 'have to arrive whole: outline lists the sections and their sizes, query returns only '
        + 'the sections matching it, maxChars caps how much text comes back, and offset pages '
        + 'through the rest. Reach for one of those first on an opinion -- a full one runs to '
        + 'tens of thousands of characters.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentId: { type: 'string' },
          outline: {
            type: 'boolean',
            description: 'Structure only: every section\'s index, label, heading, and length, '
              + 'with no text. The cheapest way to find the part worth reading.'
          },
          query: {
            type: 'string',
            description: 'Return only the sections that match these words, most matching first. '
              + 'Use it for "the part about X" instead of reading the whole document.'
          },
          maxChars: {
            type: 'integer',
            minimum: 1,
            description: 'Cap the text returned across all sections; the last one is clipped and '
              + 'says so. An excerpt, rather than all-or-nothing.'
          },
          offset: offsetSchema('First section to return, default 0.'),
          limit: limitSchema(`Max sections, default ${LIMITS.maxRows}.`)
        },
        required: ['documentId']
      },
      async run(args, context = {}) {
        const snapshot = await store.ready(context);
        const documentId = requireString(args, 'documentId', 512);
        const offset = readOffset(args);
        const query = readQuery(args);
        const maxChars = readMaxChars(args);
        const index = indexFor(snapshot);
        const document = index.documents.get(documentId);
        if (!document) {
          throw new LibraryError('document_not_found',
            `No captured source with id ${documentId}.`,
            { hint: 'Call get_case and read capturedSources for its document ids, or run '
              + 'search_library with types: ["source"] and use the documentId on a hit.' });
        }
        return sourceTextResult({
          sections: index.sectionsByDocument.get(documentId) || [],
          document,
          documentId,
          offset,
          query,
          maxChars,
          limit: readSectionLimit(args),
          outline: args.outline === true
        });
      }
    },

    {
      name: 'find_citation_mentions',
      title: 'Check a draft against the library',
      description: 'Given draft text, report every place it cites an authority already in the '
        + 'library, in order. Citations match in any spelling (603 U.S. 369 = 603 US 369), with or '
        + 'without a pincite or year, and a citation used twice is reported twice. Use it to check '
        + 'a draft against the research behind it -- and to find the citations in it that the '
        + 'library does not have.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: 'Draft text to scan.' },
          limit: limitSchema(`Max mentions, default ${LIMITS.defaultRows}, max ${LIMITS.maxRows}.`),
          offset: offsetSchema('Skip this many mentions; use the nextOffset from the previous call.')
        },
        required: ['text']
      },
      async run(args, context = {}) {
        const snapshot = await store.ready(context);
        const text = requireString(args, 'text', LIMITS.inputTextBytes);
        const limit = readLimit(args);
        const offset = readOffset(args);
        const index = indexFor(snapshot);
        const mentions = findCitationMentions(text, index.citations);
        const half = Math.floor(LIMITS.mentionContextChars / 2);
        const rows = mentions.slice(offset, offset + limit).map(mention => ({
          // As the draft wrote it, and the library's own form when that differs.
          citation: mention.text,
          ...(mention.citation !== mention.text ? { libraryCitation: mention.citation } : {}),
          caseGuid: mention.guid,
          caseTitle: index.cases.get(String(mention.guid))?.title || '',
          index: mention.index,
          context: clip(
            text.slice(Math.max(0, mention.index - half), mention.index + mention.text.length + half)
              .replace(/\s+/g, ' ').trim(),
            LIMITS.mentionContextChars + 40
          )
        }));
        return listResult(rows, mentions.length, {
          offset,
          scannedCharacters: text.length,
          casesSearched: snapshot.library.cases.length
        });
      }
    },

    {
      name: 'reload_snapshot',
      title: 'Re-read the export',
      description: 'Re-read the newest export from disk. Use after the user exports a fresh '
        + 'backup, or to retry after a load failure.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, context = {}) {
        const snapshot = await store.reload(context);
        return {
          reloaded: true,
          sourceFile: snapshot.sourceFile,
          exportedAt: snapshot.exportedAt,
          records: snapshot.decrypted,
          readMs: snapshot.readMs
        };
      }
    }
  ];
}

module.exports = { createTools, warmIndexes };
