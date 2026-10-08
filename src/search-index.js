/**
 * Ranked search over a decrypted library.
 *
 * Substring matching had three problems. It couldn't rank, so in a
 * 2,000-authority library "deference" returned whichever 25 records were stored
 * first. It couldn't tokenize, so any paraphrase found nothing. And it never
 * looked at captured source text (caseSearchHaystack() only covers case fields),
 * so opinion and statute bodies were reachable only by a document id the model
 * had no way to learn.
 *
 * This indexes authorities, saved quotations, and captured source sections into
 * one BM25F index, so a single query ranks across all three and callers filter
 * by type. It's built once per snapshot, in memory.
 */
'use strict';

const {
  tokenize, normalize, stem, parseQuery, STOPWORDS, SEGMENT_BREAK, SEGMENT_GAP
} = require('./tokenize');
const { readShorthand } = require('./legal-terms');

// Standard BM25 constants. k1 sets how fast term frequency saturates, b how much
// long fields are penalised.
const K1 = 1.2;
const B = 0.75;

/**
 * Field weights. A hit in a title or citation says more than the same word in a
 * long note, which would otherwise win just by being longer.
 */
const CASE_FIELDS = Object.freeze({
  title: 8, citation: 6, tags: 5, holding: 4, keyFacts: 3,
  whyItMatters: 3, court: 2, notes: 2, related: 2, quotes: 1.5
});
const QUOTE_FIELDS = Object.freeze({ text: 4, citation: 3, caseTitle: 2 });
const SOURCE_FIELDS = Object.freeze({ heading: 5, docTitle: 4, docCitation: 4, text: 2 });

/**
 * Court names are mostly boilerplate. "United States Court of Appeals for the
 * Ninth Circuit" and "United States District Court for the District of
 * Massachusetts" share four words, so in a federal library a query like
 * "circuit court appeals" matched nearly everything. IDF doesn't fix that in a
 * small library, because those words still aren't rare enough.
 *
 * So the court field is indexed without them, which leaves the part that tells
 * courts apart ("ninth", "massachusetts", "fisa"). Dropped terms are reported
 * back so a query made of them can point the caller to the court filter.
 */
const COURT_BOILERPLATE = Object.freeze(
  ['court', 'courts', 'united', 'states', 'district', 'appeals', 'circuit', 'division']
    // Postings are stemmed ("united" is stored as "unit"), so this list has to be too.
    .map(stem)
);

/** Below this many courts, share-based pruning is noise. */
const COURT_PRUNE_MIN_DOCS = 8;
/** A term in over half the court names doesn't distinguish anything. */
const COURT_PRUNE_SHARE = 0.5;

const MAX_EXPANSIONS = 6;
/**
 * Weight for a match through an abbreviation's reading. High, since that's what
 * the researcher meant, but below 1 so the words they typed still break ties.
 */
const SHORTHAND_WEIGHT = 0.8;
const EXPANSION_WEIGHT = 0.45;
const FUZZY_WEIGHT = 0.3;

const PHRASE_BOOST = 2.5;

/**
 * Unquoted words that sit together are usually one idea ("summary judgment" in
 * a holding, versus "summary" and "judgment" sentences apart in a note). The
 * boost is gentler than a quoted phrase's since nobody asked for the words
 * together, and it scales with how many neighbouring query pairs the document
 * keeps together.
 */
const PROXIMITY_BOOST = 0.5;
/** Adjacent, or one word between ("arbitrary and capricious"). */
const PROXIMITY_WINDOW = 2;
/** Only the top-scoring candidates get the position check. */
const PROXIMITY_CANDIDATES = 500;

/**
 * Joins quote texts. The tokenizer turns this marker into a jump in position
 * numbers, so a phrase can't run from the end of one quotation into the next.
 */
const JOIN_GAP = ` ${SEGMENT_BREAK} `;

function joinList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(' ');
  return String(value == null ? '' : value);
}

/* ------------------------------------------------------------- documents */

function caseDocument(caseData, index, related = '') {
  const quotes = Array.isArray(caseData.quotes) ? caseData.quotes : [];
  return {
    id: `case:${caseData.guid}`,
    type: 'case',
    ref: caseData.guid,
    order: index,
    weights: CASE_FIELDS,
    fields: {
      title: String(caseData.title || ''),
      citation: [caseData.citation, caseData.cite, caseData.functionalCite,
        joinList(caseData.parallelCitations)].filter(Boolean).join(' '),
      tags: joinList(caseData.tags),
      holding: String(caseData.holding || ''),
      keyFacts: String(caseData.keyFacts || ''),
      whyItMatters: String(caseData.whyItMatters || ''),
      court: [caseData.court, caseData.jurisdictionText, caseData.year].filter(Boolean).join(' '),
      notes: String(caseData.notes || ''),
      // The user's notes on how this authority relates to others, so a query can
      // reach them from either end.
      related,
      quotes: quotes.map(quote => quote.text || '').join(JOIN_GAP)
    }
  };
}

function quoteDocument(caseData, quote, position) {
  return {
    id: `quote:${caseData.guid}:${quote.id || position}`,
    type: 'quote',
    ref: { guid: caseData.guid, quoteIndex: position },
    order: position,
    weights: QUOTE_FIELDS,
    fields: {
      text: String(quote.text || ''),
      citation: String(quote.citation || ''),
      caseTitle: String(caseData.title || '')
    }
  };
}

function sourceDocument(section, document, index) {
  return {
    id: `source:${section.sectionId || `${section.documentId}:${index}`}`,
    type: 'source',
    ref: { documentId: section.documentId, sectionId: section.sectionId || '' },
    order: index,
    weights: SOURCE_FIELDS,
    fields: {
      heading: [section.label, section.heading].filter(Boolean).join(' '),
      docTitle: String(document?.sourceTitle || ''),
      docCitation: String(document?.sourceCitation || ''),
      text: String(section.text || '')
    }
  };
}

/* ----------------------------------------------------------------- build */

/**
 * Court words this library can't tell apart. The static list is boilerplate in
 * any jurisdiction. The measured part catches words that are boilerplate only
 * here (e.g. "supreme" in a mostly Supreme Court library), and it's conservative
 * on purpose: it needs a real sample and a majority share, because pruning
 * "massachusetts" from a Massachusetts practice's library would cost more than
 * the noise it removed. Anything with a digit stays, since years and circuit
 * numbers are worth finding.
 */
function genericCourtTerms(documents) {
  const generic = new Set(COURT_BOILERPLATE);
  const frequency = new Map();
  let withCourt = 0;

  for (const document of documents) {
    if (document.type !== 'case' || !document.fields.court) continue;
    withCourt += 1;
    for (const term of new Set(tokenize(document.fields.court).terms)) {
      frequency.set(term, (frequency.get(term) || 0) + 1);
    }
  }
  if (withCourt >= COURT_PRUNE_MIN_DOCS) {
    const ceiling = withCourt * COURT_PRUNE_SHARE;
    for (const [term, count] of frequency) {
      if (count > ceiling && !/\d/.test(term)) generic.add(term);
    }
  }
  return generic;
}

const hasText = value => String(value == null ? '' : value).trim().length > 0;

/** Relationship text for one authority: the verb, the authority at the other end, and the user's note. */
function relatedText(guid, edgesByGuid, titleOf) {
  return (edgesByGuid.get(String(guid)) || [])
    .map(edge => {
      const other = String(edge.fromGuid) === String(guid) ? edge.toGuid : edge.fromGuid;
      return [String(edge.type || '').replace(/[_-]+/g, ' '), titleOf(other), edge.note]
        .filter(Boolean).join(' ');
    })
    .join(JOIN_GAP);
}

/** Live edges indexed from both ends. Suppressed or deleted ones aren't research. */
function edgesByAuthority(library) {
  const edges = new Map();
  for (const edge of library.relationships || []) {
    if (Number(edge.suppressedAt) > 0 || edge.deletedAt) continue;
    for (const end of [edge.fromGuid, edge.toGuid]) {
      if (!end) continue;
      const list = edges.get(String(end));
      if (list) list.push(edge);
      else edges.set(String(end), [edge]);
    }
  }
  return edges;
}

/** One authority, plus a document per quotation that has text. */
function caseDocuments(caseData, index, related = '') {
  const documents = [caseDocument(caseData, index, related)];
  const quotes = Array.isArray(caseData.quotes) ? caseData.quotes : [];
  for (const [position, quote] of quotes.entries()) {
    if (hasText(quote?.text)) documents.push(quoteDocument(caseData, quote, position));
  }
  return documents;
}

function collectDocuments(library) {
  const documentsById = new Map(
    (library.documents || []).map(document => [document.documentId, document]));

  const edges = edgesByAuthority(library);
  const titleOf = new Map((library.cases || [])
    .map(caseData => [String(caseData?.guid), caseData?.title || '']));

  const fromCases = (library.cases || [])
    .flatMap((caseData, index) => (caseData?.guid
      ? caseDocuments(caseData, index,
        relatedText(caseData.guid, edges, guid => titleOf.get(String(guid)) || ''))
      : []));

  const fromSections = (library.documentSections || [])
    .map((section, index) => (hasText(section?.text)
      ? sourceDocument(section, documentsById.get(section.documentId), index)
      : null))
    .filter(Boolean);

  return [...fromCases, ...fromSections];
}

function addFieldPostings(postings, docIndex, field, terms, positions) {
  for (const [slot, term] of terms.entries()) {
    let byDoc = postings.get(term);
    if (!byDoc) { byDoc = new Map(); postings.set(term, byDoc); }
    let entry = byDoc.get(docIndex);
    if (!entry) { entry = { weighted: 0, fields: {} }; byDoc.set(docIndex, entry); }
    const list = entry.fields[field];
    if (list) list.push(positions[slot]);
    else entry.fields[field] = [positions[slot]];
  }
}

/** Drops terms but keeps each survivor's original position, so a quoted phrase can't match across the gap. */
function dropTerms(terms, positions, unwanted) {
  const keptTerms = [];
  const keptPositions = [];
  for (const [slot, term] of terms.entries()) {
    if (unwanted.has(term)) continue;
    keptTerms.push(term);
    keptPositions.push(positions[slot]);
  }
  return { terms: keptTerms, positions: keptPositions };
}

/**
 * Postings, plus the per-field lengths BM25F normalises by.
 *
 * @returns {{postings: Map, docFieldLengths: object[], averageFieldLength: Map}}
 */
function indexDocuments(documents, courtGeneric) {
  const postings = new Map();
  const fieldLengths = new Map();   // field -> total term count
  const fieldCounts = new Map();    // field -> documents carrying it
  const docFieldLengths = [];

  for (const [docIndex, document] of documents.entries()) {
    const lengths = {};
    for (const [field, text] of Object.entries(document.fields)) {
      if (!text) continue;
      let { terms, positions } = tokenize(text);
      if (field === 'court') ({ terms, positions } = dropTerms(terms, positions, courtGeneric));
      if (!terms.length) continue;
      lengths[field] = terms.length;
      fieldLengths.set(field, (fieldLengths.get(field) || 0) + terms.length);
      fieldCounts.set(field, (fieldCounts.get(field) || 0) + 1);
      addFieldPostings(postings, docIndex, field, terms, positions);
    }
    docFieldLengths.push(lengths);
  }

  const averageFieldLength = new Map();
  for (const [field, total] of fieldLengths) {
    averageFieldLength.set(field, total / Math.max(1, fieldCounts.get(field)));
  }
  return { postings, docFieldLengths, averageFieldLength };
}

/**
 * Folds BM25F length normalisation and the field boost into each posting. This
 * only depends on the document and its fields, so it's done once here instead
 * of per query term.
 */
function applyFieldWeights(documents, postings, docFieldLengths, averageFieldLength) {
  for (const byDoc of postings.values()) {
    for (const [docIndex, entry] of byDoc) {
      const weights = documents[docIndex].weights;
      let weighted = 0;
      for (const [field, list] of Object.entries(entry.fields)) {
        const length = docFieldLengths[docIndex][field] || 1;
        const average = averageFieldLength.get(field) || length;
        const boost = weights[field] || 1;
        weighted += (boost * list.length) / (1 - B + B * (length / average));
      }
      entry.weighted = weighted;
    }
  }
}

/**
 * @param {object} library the decrypted collections
 * @returns {object} an index for search()
 */
function buildIndex(library) {
  const documents = collectDocuments(library);
  const courtGeneric = genericCourtTerms(documents);
  const { postings, docFieldLengths, averageFieldLength }
    = indexDocuments(documents, courtGeneric);
  applyFieldWeights(documents, postings, docFieldLengths, averageFieldLength);

  const vocabulary = [...postings.keys()].sort();
  return {
    documents,
    postings,
    courtGeneric,
    vocabulary,
    vocabularyByLength: bucketByLength(vocabulary),
    totalDocuments: documents.length
  };
}

/**
 * The vocabulary split by word length, each bucket still sorted. A word one edit
 * from a typo is at most one character longer or shorter, so typo correction
 * reads three buckets instead of the whole vocabulary.
 */
function bucketByLength(vocabulary) {
  const buckets = new Map();
  for (const term of vocabulary) {
    const bucket = buckets.get(term.length);
    if (bucket) bucket.push(term);
    else buckets.set(term.length, [term]);
  }
  return buckets;
}

/* ---------------------------------------------------------------- expand */

/**
 * One substitution or one swap of neighbours between equal-length words. Swaps
 * count as a single edit (Damerau rather than plain Levenshtein) because
 * "jugdment" for "judgment" is a common typo that would otherwise score 2.
 */
function equalLengthWithin1(a, b) {
  const differing = [];
  for (let position = 0; position < a.length; position += 1) {
    if (a[position] === b[position]) continue;
    differing.push(position);
    if (differing.length > 2) return false;
  }
  if (differing.length <= 1) return true;
  const [first, second] = differing;
  return second === first + 1 && a[first] === b[second] && a[second] === b[first];
}

/** One insertion or deletion. Walks both words and allows a single skip. */
function offByOneCharacter(longer, shorter) {
  let index = 0;
  let other = 0;
  let skipped = false;
  while (index < longer.length && other < shorter.length) {
    if (longer[index] === shorter[other]) { index += 1; other += 1; continue; }
    if (skipped) return false;
    skipped = true;
    index += 1;
  }
  return true;
}

function editDistanceWithin1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) return equalLengthWithin1(a, b);
  return a.length > b.length ? offByOneCharacter(a, b) : offByOneCharacter(b, a);
}

function sharedPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length] === b[length]) length += 1;
  return length;
}

/** First index in the sorted vocabulary at or after `term`. */
function lowerBound(vocabulary, term) {
  let low = 0;
  let high = vocabulary.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (vocabulary[mid] < term) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Endings that turn a legal word into its noun, adjective, or abstract form.
 * "moot" and "mootness", or "defer" and "deference", are one idea to a
 * researcher but separate terms to an index. The stemmer handles inflectional
 * endings, so these are left for query time, where a match can be weighted as
 * the guess it is.
 */
const DERIVATIONAL_SUFFIXES = Object.freeze([
  'ability', 'ibility', 'ation', 'ness', 'ment', 'ance', 'ence', 'ancy', 'ency',
  'able', 'ible', 'ity', 'ive', 'al'
]);
/** Below this, a stripped base is too short to be the same word ("act" in "action"). */
const MIN_BASE_LENGTH = 4;
const FAMILY_WEIGHT = 0.5;
/** A misspelling with exactly one plausible correction is very likely that word. */
const SOLE_CORRECTION_WEIGHT = 0.8;

/**
 * Other forms of `term` that the index holds. Base-plus-ending is always tried,
 * and the base itself only when `strip` is set.
 *
 * Stripping is for terms the index has never seen, where "redressability" has
 * nothing to fall back on but "redress". For a term the index does hold it
 * costs more than it finds: "judgment" loses "-ment" to "judg", which is also
 * what the stemmer made of "judged", so every opinion that judged anything
 * would start matching a summary judgment query.
 */
function wordFamily(index, term, { strip = false } = {}) {
  const bases = new Set([term]);
  for (const suffix of strip ? DERIVATIONAL_SUFFIXES : []) {
    if (!term.endsWith(suffix)) continue;
    const base = term.slice(0, -suffix.length);
    if (base.length >= MIN_BASE_LENGTH) { bases.add(base); bases.add(`${base}e`); }
  }
  const forms = new Set();
  for (const base of bases) {
    if (base.length < MIN_BASE_LENGTH) continue;
    forms.add(base);
    const bare = base.endsWith('e') ? base.slice(0, -1) : base;
    for (const suffix of DERIVATIONAL_SUFFIXES) {
      forms.add(`${base}${suffix}`);
      forms.add(`${bare}${suffix}`);
    }
  }
  forms.delete(term);
  return [...forms].filter(form => index.postings.has(form));
}

/** Terms sharing a stem-length run of leading characters with `term`. */
function prefixNeighbours(index, term) {
  const threshold = Math.max(4, Math.ceil(term.length * 0.6));
  const start = lowerBound(index.vocabulary, term);
  const candidates = [];

  for (const direction of [-1, 1]) {
    let cursor = direction < 0 ? start - 1 : start;
    while (cursor >= 0 && cursor < index.vocabulary.length) {
      const candidate = index.vocabulary[cursor];
      const shared = sharedPrefixLength(term, candidate);
      // The vocabulary is sorted, so once the shared prefix is too short it only gets shorter.
      if (shared < threshold) break;
      if (candidate.length >= 4 && candidate !== term) candidates.push({ candidate, shared });
      cursor += direction;
      if (candidates.length >= MAX_EXPANSIONS * 2) break;
    }
  }
  return candidates
    .sort((left, right) => right.shared - left.shared)
    .slice(0, MAX_EXPANSIONS)
    .map(({ candidate, shared }) => ({
      term: candidate,
      // A longer shared run is stronger evidence of the same word.
      weight: EXPANSION_WEIGHT * (shared / Math.max(term.length, candidate.length))
    }));
}

/**
 * The terms a query term should match, each with the weight of a match through
 * it. The term itself, when the index has it, is always worth 1 and always
 * scores above any expansion of it.
 *
 * A known term also reaches its word family at half weight, so "moot" finds an
 * authority that only ever says "mootness".
 *
 * An unknown term tries shared-prefix expansion first, since that bridges real
 * pairs like "deferential" and "deference" without a hand-built synonym list.
 * Neither word is a prefix of the other, so startsWith won't find them, but they
 * share a stem-length run of characters. The vocabulary is sorted, so those
 * candidates sit next to each other and the scan stays local.
 *
 * Edit distance only runs when that finds nothing, because that case is a typo
 * rather than a different word form, and it's the expensive one.
 */
function expandTerm(index, term) {
  const weights = new Map();
  const add = (candidate, weight) => {
    if (weight > (weights.get(candidate) || 0)) weights.set(candidate, weight);
  };
  const result = () => [...weights]
    .map(([candidate, weight]) => ({ term: candidate, weight }))
    .sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term));

  if (index.postings.has(term)) {
    add(term, 1);
    for (const form of wordFamily(index, term)) add(form, FAMILY_WEIGHT);
    return result();
  }
  // "what" isn't a typo for "that".
  if (STOPWORDS.has(term)) return [];
  if (term.length < 4) return [];

  for (const { term: candidate, weight } of prefixNeighbours(index, term)) add(candidate, weight);
  // The word family is added either way but doesn't replace typo correction.
  // "plausable" strips to "plaus" and reaches "plausibility" by coincidence, and
  // stopping there would never find "plausible".
  const found = weights.size > 0;
  for (const form of wordFamily(index, term, { strip: true })) add(form, FAMILY_WEIGHT);
  if (found) return result();

  correctTypo(index, term, add);
  return result();
}

/**
 * Words one edit away from an unknown term, plus their neighbours. A typo with a
 * single correction is weighted as nearly certain, and the corrected word then
 * reaches its own neighbours, so "plausable" finds "plausibility" by way of
 * "plausible".
 */
function correctTypo(index, term, add) {
  // Only lengths within one of the term can be one edit away. The first few
  // matches in vocabulary order are kept, so the three buckets are merged back
  // into that order before the cut, and results match a scan of everything.
  const fuzzy = [];
  for (const length of [term.length - 1, term.length, term.length + 1]) {
    for (const candidate of index.vocabularyByLength.get(length) || []) {
      if (candidate.length < 4 || STOPWORDS.has(candidate)) continue;
      if (editDistanceWithin1(term, candidate)) fuzzy.push(candidate);
    }
  }
  fuzzy.sort();
  fuzzy.length = Math.min(fuzzy.length, MAX_EXPANSIONS);
  const correctionWeight = fuzzy.length === 1 ? SOLE_CORRECTION_WEIGHT : FUZZY_WEIGHT;
  for (const corrected of fuzzy) {
    add(corrected, correctionWeight);
    for (const { term: candidate, weight } of prefixNeighbours(index, corrected)) {
      add(candidate, correctionWeight * weight);
    }
    for (const form of wordFamily(index, corrected)) add(form, correctionWeight * FAMILY_WEIGHT);
  }
}

/* ---------------------------------------------------------------- phrase */

/** Whether any one field holds `phrase` as consecutive tokens. */
function documentHasPhrase(index, docIndex, phrase) {
  const first = index.postings.get(phrase[0])?.get(docIndex);
  if (!first) return false;

  for (const [field, starts] of Object.entries(first.fields)) {
    for (const start of starts) {
      let matched = true;
      for (let offset = 1; offset < phrase.length; offset += 1) {
        const next = index.postings.get(phrase[offset])?.get(docIndex);
        if (!next || !next.fields[field]?.includes(start + offset)) { matched = false; break; }
      }
      if (matched) return true;
    }
  }
  return false;
}

/* --------------------------------------------------------------- snippet */

/**
 * Where each whitespace-separated word of `text` starts, in characters, and the
 * token position the tokenizer gives its first token.
 *
 * Positions have to follow tokenize(), which splits "cell-site" into two tokens
 * and jumps at segment breaks. Counting whitespace words drifts further off with
 * every hyphen, and in a long opinion section it put the snippet paragraphs away
 * from the match.
 *
 * @returns {{index: number, position: number}[]}
 */
function wordStarts(text) {
  const words = [];
  let base = 0;
  let offset = 0;
  for (const segment of text.split(SEGMENT_BREAK)) {
    let position = 0;
    for (const match of segment.matchAll(/[^\s]+/g)) {
      const tokens = normalize(match[0]).split(/[^a-z0-9]+/).filter(Boolean).length;
      if (tokens) words.push({ index: offset + match.index, position: base + position });
      position += tokens;
    }
    // The tokenizer counts tokens over the whole segment, so per-word counting
    // can differ where an abbreviation spans words. That's off by a word, not a paragraph.
    base += position + SEGMENT_GAP;
    offset += segment.length + SEGMENT_BREAK.length;
  }
  return words;
}

/**
 * The run of `span` token positions with the most weight from distinct query
 * terms. Distinct, so a window saying "deference" five times doesn't beat one
 * that says "deference", "agency", and "regulation" once each.
 */
function densestWindow(hits, span, weightOf) {
  let best = null;
  let right = 0;
  const counts = new Map();
  let score = 0;
  for (let left = 0; left < hits.length; left += 1) {
    while (right < hits.length && hits[right].position - hits[left].position < span) {
      const term = hits[right].term;
      if (!counts.get(term)) score += weightOf(term);
      counts.set(term, (counts.get(term) || 0) + 1);
      right += 1;
    }
    if (!best || score > best.score + 1e-9) {
      best = { score, from: hits[left].position, to: hits[right - 1].position };
    }
    const leaving = hits[left].term;
    counts.set(leaving, counts.get(leaving) - 1);
    if (!counts.get(leaving)) score -= weightOf(leaving);
  }
  return best;
}

/**
 * The field and window that best explain this hit, or null if none match.
 *
 * A field is judged by its best window rather than its raw hit count, and a
 * heavily weighted field gets a lift rather than a multiple, so a title sharing
 * one word with the query doesn't beat the paragraph that answers it.
 */
function bestMatchingField(document, wanted, weightOf, span) {
  let best = null;
  for (const [field, text] of Object.entries(document.fields)) {
    if (!text) continue;
    const { terms, positions } = tokenize(text);
    const hits = [];
    for (const [slot, term] of terms.entries()) {
      if (wanted.has(term)) hits.push({ term, position: positions[slot] });
    }
    if (!hits.length) continue;
    const window = densestWindow(hits, span, weightOf);
    const score = window.score * Math.sqrt(document.weights[field] || 1);
    if (!best || score > best.score) best = { field, text, window, score };
  }
  return best;
}

/** Nothing matched, so show the start of whatever the document has. */
function leadingSnippet(document, maxChars) {
  const fallback = Object.entries(document.fields).find(([, value]) => value);
  if (!fallback) return null;
  const [field, text] = fallback;
  return { field, text: text.length > maxChars ? `${text.slice(0, maxChars)}...` : text };
}

/** Rough characters per token, for sizing a window of positions to a character budget. */
const CHARS_PER_TOKEN = 6;

/**
 * The window of original text that shows why this matched, so a model can judge
 * relevance without a second round trip.
 *
 * @param {object} document
 * @param {string[]} queryTerms
 * @param {number} maxChars
 * @param {(term: string) => number} [weightOf] how much a term says (rarer terms
 *   say more). Defaults to every term counting the same.
 */
function buildSnippet(document, queryTerms, maxChars, weightOf = () => 1) {
  // Stopwords stay in for phrase matching ("burden of establishing" needs its
  // "of") but must not choose the snippet. Otherwise "Lujan v. Defenders of
  // Wildlife" would beat the passage that answered the query, on one "of" in a
  // weighted title.
  const meaningful = queryTerms.filter(term => !STOPWORDS.has(term));
  const wanted = new Set(meaningful.length ? meaningful : queryTerms);
  const span = Math.max(8, Math.floor(maxChars / CHARS_PER_TOKEN));

  const best = bestMatchingField(document, wanted, weightOf, span);
  if (!best) return leadingSnippet(document, maxChars);

  // Convert the window's token positions back to characters, then centre it in the budget.
  const words = wordStarts(best.text);
  const charAt = position => {
    let found = words[0]?.index || 0;
    for (const word of words) {
      if (word.position > position) break;
      found = word.index;
    }
    return found;
  };
  const from = charAt(best.window.from);
  const to = charAt(best.window.to);
  const middle = Math.floor((from + to) / 2);
  let start = Math.max(0, Math.min(from, middle - Math.floor(maxChars / 2)));
  let end = Math.min(best.text.length, start + maxChars);
  if (end - start < maxChars) start = Math.max(0, end - maxChars);
  if (start > 0) {
    const space = best.text.indexOf(' ', start);
    if (space >= 0 && space < start + 40 && space < from) start = space + 1;
  }
  if (end < best.text.length) {
    const space = best.text.lastIndexOf(' ', end);
    if (space > start) end = space;
  }
  const slice = best.text.slice(start, end).split(JOIN_GAP).join(' ')
    .replace(/\s+/g, ' ').trim();
  return {
    field: best.field,
    text: `${start > 0 ? '...' : ''}${slice}${end < best.text.length ? '...' : ''}`
  };
}

/* ---------------------------------------------------------------- search */

/**
 * BM25 accumulation over every query term and its expansions.
 *
 * @returns {{scores: Map<number, number>, matchedTerms: Set<string>}}
 */
function scoreTerms(index, terms, extra = []) {
  const scores = new Map();
  const matchedTerms = new Set();
  const total = index.totalDocuments;

  // What was typed at full weight, then what its shorthand stands for. A word
  // already in the query isn't counted again through a reading.
  const typed = new Set(terms);
  const wanted = [...typed].map(term => ({ term, weight: 1 }));
  for (const item of extra) if (!typed.has(item.term)) wanted.push(item);

  for (const { term, weight: base } of wanted) {
    for (const { term: actual, weight } of expandTerm(index, term)) {
      const byDoc = index.postings.get(actual);
      if (!byDoc) continue;
      matchedTerms.add(actual);
      // IDF keeps "court" from dominating a query that also has "mootness".
      const idf = Math.log(1 + (total - byDoc.size + 0.5) / (byDoc.size + 0.5));
      for (const [docIndex, entry] of byDoc) {
        const saturated = entry.weighted / (entry.weighted + K1);
        scores.set(docIndex, (scores.get(docIndex) || 0) + idf * saturated * weight * base);
      }
    }
  }
  return { scores, matchedTerms };
}

/** The terms a query's shorthand reads as, weighted as a reading rather than as typed. */
function shorthandTerms(readings) {
  const weighted = new Map();
  for (const { to } of readings) {
    for (const term of tokenize(to).terms) {
      if (!STOPWORDS.has(term)) weighted.set(term, SHORTHAND_WEIGHT);
    }
  }
  return [...weighted].map(([term, weight]) => ({ term, weight }));
}

/** Whether any one field holds `left` followed by `right` within the window. */
function pairTogether(index, docIndex, left, right) {
  const first = index.postings.get(left)?.get(docIndex);
  const second = index.postings.get(right)?.get(docIndex);
  if (!first || !second) return false;
  for (const [field, starts] of Object.entries(first.fields)) {
    const ends = second.fields[field];
    if (!ends) continue;
    for (const start of starts) {
      for (const end of ends) {
        const gap = end - start;
        if (gap > 0 && gap <= PROXIMITY_WINDOW) return true;
      }
    }
  }
  return false;
}

/**
 * Boosts documents that keep the query's neighbouring words together. Pairs come
 * from the words as typed, in query order, not from their expansions, because
 * proximity is evidence about the phrase the researcher had in mind and a
 * guessed word form isn't that phrase.
 */
function rewardProximity(index, scores, terms) {
  const known = terms.filter(term => index.postings.has(term));
  const pairs = [];
  for (let position = 1; position < known.length; position += 1) {
    if (known[position - 1] !== known[position]) pairs.push([known[position - 1], known[position]]);
  }
  if (!pairs.length) return;

  const candidates = [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, PROXIMITY_CANDIDATES);
  for (const [docIndex, score] of candidates) {
    const together = pairs.filter(([left, right]) => pairTogether(index, docIndex, left, right)).length;
    if (together) scores.set(docIndex, score * (1 + PROXIMITY_BOOST * (together / pairs.length)));
  }
}

/**
 * A quoted phrase is a requirement, since typing quotation marks asks for that
 * exact sequence. Documents that satisfy every phrase are boosted and the rest
 * are dropped.
 */
function requirePhrases(index, scores, phrases) {
  for (const docIndex of [...scores.keys()]) {
    const satisfied = phrases.every(phrase => documentHasPhrase(index, docIndex, phrase));
    if (satisfied) scores.set(docIndex, scores.get(docIndex) * PHRASE_BOOST);
    else scores.delete(docIndex);
  }
}

/**
 * Everything of the requested kind, in library order. A query with no terms used
 * to return nothing, which looks the same as an empty library, and "*" is the
 * first thing people try to list everything. So this returns unranked rows with
 * a `browsed` flag the caller can report.
 */
function browse(index, { types, filter, limit, offset }) {
  const rows = index.documents
    .filter(document => !types || types.has(document.type))
    .filter(document => !filter || filter(document));

  return {
    total: rows.length,
    browsed: true,
    terms: [],
    phrases: [],
    ignoredCourtTerms: [],
    hits: rows.slice(offset, offset + limit).map(document => ({
      type: document.type,
      ref: document.ref,
      score: null,
      relevance: null,
      snippet: null
    }))
  };
}

/** How many hits from one record are shown under its best hit instead of as their own rows. */
const GROUP_SHOWN = 3;

/**
 * What a hit groups under, either an authority with its saved quotations or a
 * captured document with its sections. A captured document isn't folded into
 * the authority it was saved under: "5 U.S.C. 706" captured while reading Loper
 * Bright is still a statute, and hiding it under an opinion's row would hide the
 * answer to a statutory query.
 */
function groupKey(document) {
  if (document.type === 'case') return `authority:${document.ref}`;
  if (document.type === 'quote') return `authority:${document.ref.guid}`;
  return `document:${document.ref.documentId}`;
}

/**
 * One row per authority and per captured document, at the rank of its best hit.
 * Without it a mixed search can spend its first page on a single record, e.g. an
 * opinion whose every section repeats the query's citation, or an authority and
 * three of its quotations.
 */
function groupHits(ranked) {
  const groups = new Map();
  const ordered = [];
  for (const hit of ranked) {
    const key = groupKey(hit.document);
    const existing = groups.get(key);
    if (existing) { existing.members.push(hit); continue; }
    const group = { ...hit, members: [] };
    groups.set(key, group);
    ordered.push(group);
  }
  return ordered;
}

/**
 * @param {object} index from buildIndex
 * @param {string} query free text, with "quoted phrases" honoured
 * @param {{types?: string[], limit?: number, snippetChars?: number, group?: boolean,
 *          filter?: (document: object) => boolean}} [options] `group` collapses an
 *          authority's quotations, and a document's sections, into one row
 * @returns {{total: number, hits: object[], terms: string[], phrases: string[][]}}
 */
function search(index, query, options = {}) {
  const { terms, phrases } = parseQuery(query);
  const limit = options.limit || 25;
  const offset = Math.max(0, options.offset || 0);
  const snippetChars = options.snippetChars || 240;
  const types = options.types ? new Set(options.types) : null;
  const filter = typeof options.filter === 'function' ? options.filter : null;

  if (!terms.length && !phrases.length) {
    return browse(index, { types, filter, limit, offset });
  }

  const readings = readShorthand(query);
  const { scores, matchedTerms } = scoreTerms(index, terms, shorthandTerms(readings));
  rewardProximity(index, scores, terms);
  if (phrases.length) requirePhrases(index, scores, phrases);

  const ranked = [...scores.entries()]
    .map(([docIndex, score]) => ({ document: index.documents[docIndex], score }))
    .filter(hit => !types || types.has(hit.document.type))
    .filter(hit => !filter || filter(hit.document));

  ranked.sort((left, right) =>
    right.score - left.score
    || left.document.order - right.document.order
    || left.document.id.localeCompare(right.document.id));

  const groups = options.group ? groupHits(ranked) : ranked.map(hit => ({ ...hit, members: [] }));
  const top = groups.slice(offset, offset + limit);
  // Normalised against the best hit overall, not this page, so relevance means
  // the same thing on page two.
  const best = ranked[0]?.score || 1;
  const snippetTerms = [...matchedTerms, ...phrases.flat()];
  // Rarer terms count for more in snippets too, as they do in ranking.
  const weightOf = term => {
    const documents = index.postings.get(term)?.size || 0;
    return Math.log(1 + (index.totalDocuments - documents + 0.5) / (documents + 0.5));
  };
  const present = hit => ({
    type: hit.document.type,
    ref: hit.document.ref,
    score: Number(hit.score.toFixed(4)),
    relevance: Number((hit.score / best).toFixed(3)),
    snippet: buildSnippet(hit.document, snippetTerms, snippetChars, weightOf)
  });

  return {
    total: groups.length,
    terms: [...matchedTerms].sort(),
    phrases,
    readAs: readings,
    // Court boilerplate that was indexed out and matched nothing else, so the
    // caller can suggest the court filter instead of returning a dead end.
    ignoredCourtTerms: terms.filter(term =>
      index.courtGeneric?.has(term) && !matchedTerms.has(term)),
    hits: top.map(hit => ({
      ...present(hit),
      ...(hit.members.length
        ? {
          grouped: hit.members.slice(0, GROUP_SHOWN).map(present),
          groupedTotal: hit.members.length
        }
        : {})
    }))
  };
}

module.exports = {
  buildIndex, search, expandTerm, buildSnippet, documentHasPhrase, genericCourtTerms,
  edgesByAuthority,
  CASE_FIELDS, QUOTE_FIELDS, SOURCE_FIELDS, STOPWORDS, COURT_BOILERPLATE
};
