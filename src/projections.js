/**
 * What a tool is allowed to say about a record. Projections keep the byte budget
 * for research instead of schema, since a stored case carries element analysis,
 * stance, timestamps, and an authority key that mean nothing outside the app.
 * Summaries say which authority it is, and details say what it holds.
 */
'use strict';

const { Search } = require('./core-modules');
const { LIMITS, clip } = require('./limits');

/** A quote's pincite: the app stores it on `page`, the parser on citationComponents. */
function pincite(quote) {
  return String(quote?.page || quote?.citationComponents?.pincite || '').trim();
}

/** Cut at a sentence end if there is one nearby, otherwise at a word. */
function firstSentences(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars + 1);
  const sentence = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  // Only accept a sentence break in the back half, since one at character 20 of a
  // 320-character budget throws away most of the gist.
  if (sentence > maxChars * 0.5) return window.slice(0, sentence + 1);
  const space = window.lastIndexOf(' ');
  return `${window.slice(0, space > 0 ? space : maxChars)}...`;
}

/**
 * Where a one-line gist comes from, best first. The user's own holding is best
 * when they wrote one, but most records only have notes. Nothing is generated, so
 * the source field travels with the summary, because the user's working note and
 * the holding of the case aren't interchangeable in a brief.
 */
const SUMMARY_FIELDS = Object.freeze(['holding', 'whyItMatters', 'keyFacts', 'notes']);

function caseGist(caseData) {
  for (const field of SUMMARY_FIELDS) {
    const value = String(caseData[field] || '').trim();
    if (value) return { summary: firstSentences(value, LIMITS.summaryChars), summarySource: field };
  }
  const quotes = Array.isArray(caseData.quotes) ? caseData.quotes : [];
  const quoted = quotes.find(quote => String(quote?.text || '').trim());
  if (quoted) {
    return {
      summary: firstSentences(quoted.text, LIMITS.summaryChars),
      summarySource: 'quote'
    };
  }
  // An empty summary is returned on purpose. It answers "what did I write about
  // this" and saves a get_case that would find nothing.
  return { summary: '' };
}

/** Epoch milliseconds to a plain date, which is all a list row needs. */
function savedOn(caseData) {
  const stamp = Number(caseData.dateAdded);
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function caseSummary(caseData) {
  const summary = {
    guid: caseData.guid,
    title: caseData.title || '',
    citation: Search.getBestCitation(caseData),
    court: caseData.court || '',
    year: caseData.year || null,
    tags: Array.isArray(caseData.tags) ? caseData.tags : [],
    projectIds: Array.isArray(caseData.projectIds) ? caseData.projectIds : [],
    quoteCount: Array.isArray(caseData.quotes) ? caseData.quotes.length : 0,
    hasNotes: Boolean(String(caseData.notes || '').trim()),
    ...caseGist(caseData)
  };
  const added = savedOn(caseData);
  if (added) summary.added = added;
  return summary;
}

function caseDetail(caseData, capturedSources = []) {
  const quotes = Array.isArray(caseData.quotes) ? caseData.quotes : [];
  const detail = {
    ...caseSummary(caseData),
    notes: clip(caseData.notes, LIMITS.notesChars),
    quotes: quotes.slice(0, LIMITS.detailQuotes).map(quote => ({
      text: clip(quote.text, LIMITS.quoteChars),
      pincite: pincite(quote),
      citation: quote.citation || ''
    }))
  };
  // Analysis fields are usually empty, so only include the ones that are filled in.
  for (const field of ['holding', 'keyFacts', 'whyItMatters']) {
    const value = String(caseData[field] || '').trim();
    if (value) detail[field] = clip(value, LIMITS.notesChars);
  }
  if (quotes.length > LIMITS.detailQuotes) {
    detail.quotesOmitted = quotes.length - LIMITS.detailQuotes;
  }
  if (capturedSources.length) detail.capturedSources = capturedSources;
  return detail;
}

/**
 * How the user connected two authorities, seen from one of them. A stored
 * relationship is a direction plus a verb (Loper Bright *distinguishes* Lujan),
 * and getting it backwards inverts the legal claim, so the row carries the
 * composed sentence instead of a direction flag to interpret.
 */
function relatedAuthority(edge, { outbound, other }) {
  const from = String(edge.fromTitle || '').trim();
  const to = String(edge.toTitle || '').trim();
  const verb = String(edge.type || 'relates to').replace(/[_-]+/g, ' ');
  return {
    type: String(edge.type || ''),
    direction: outbound ? 'outbound' : 'inbound',
    guid: other,
    // Always the authority at the far end, whichever way the edge points.
    title: outbound ? to : from,
    ...(String(edge.note || '').trim()
      ? { note: clip(edge.note, LIMITS.notesChars) }
      : {}),
    // Edges are stored from -> to whichever end is being read, so composing in
    // that order can't invert the sentence.
    reads: `${from} ${verb} ${to}`.trim()
  };
}

function quoteHit(caseData, quote) {
  return {
    caseGuid: caseData.guid,
    caseTitle: caseData.title || '',
    citation: Search.getBestCitation(caseData),
    pincite: pincite(quote),
    text: clip(quote.text, LIMITS.quoteChars)
  };
}

function sourceSummary(document, sectionCount) {
  return {
    documentId: document.documentId,
    title: document.sourceTitle || '',
    citation: document.sourceCitation || '',
    contentType: document.contentType || '',
    sections: sectionCount
  };
}

/** One captured section. `chars` is its length as captured, not of the text returned, so a caller reading an excerpt can see how much was left out. */
function sectionView(section, maxChars = LIMITS.sectionChars) {
  const text = String(section.text || '');
  return {
    label: section.label || '',
    heading: section.heading || '',
    chars: text.length,
    text: clip(text, Math.max(1, Math.min(maxChars, LIMITS.sectionChars)))
  };
}

/** A section's structure only, without its text. */
function sectionOutline(section, index) {
  return {
    index,
    label: section.label || '',
    heading: section.heading || '',
    chars: String(section.text || '').length
  };
}

module.exports = {
  caseSummary, caseDetail, quoteHit, sourceSummary, sectionView, sectionOutline,
  relatedAuthority, pincite, firstSentences
};
