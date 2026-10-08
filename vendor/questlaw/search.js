/**
 * QuestLaw shared search and citation helpers.
 */
(function (root) {
  'use strict';

  // Leaves single spaces alone: rewriting each one, as \s+ did, is 5x slower.
  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/ \s+|[^\S ]\s*/g, ' ')
      .trim();
  }

  function getBestCitation(caseData) {
    if (!caseData) return '';
    if (caseData.citation && String(caseData.citation).trim()) return String(caseData.citation).trim();
    if (caseData.cite && String(caseData.cite).trim()) return String(caseData.cite).trim();
    if (caseData.functionalCite && String(caseData.functionalCite).trim()) return String(caseData.functionalCite).trim();
    if (Array.isArray(caseData.parallelCitations) && caseData.parallelCitations[0]) {
      return String(caseData.parallelCitations[0]).trim();
    }
    return '';
  }

  function getInsertableCitation(caseData, quote = null) {
    const candidates = [quote?.citation, getBestCitation(caseData)];
    return candidates
      .map(value => String(value || '').trim())
      .find(value => value && !/^https?:\/\//i.test(value)) || '';
  }

  function tagSearchText(caseData, tagCatalog = []) {
    const tags = Array.isArray(caseData?.tags) ? caseData.tags : [];
    const catalog = Array.isArray(tagCatalog) ? tagCatalog : [];
    if (!catalog.length) return tags.join(' ');

    const namesById = new Map(catalog
      .filter(tag => tag && tag.id !== undefined && tag.id !== null)
      .map(tag => [String(tag.id), tag.name || tag.label || '']));
    return tags.map(tag => {
      const id = typeof tag === 'object' ? tag?.id : tag;
      const inlineName = typeof tag === 'object' ? (tag?.name || tag?.label || '') : '';
      return inlineName || namesById.get(String(id)) || '';
    }).filter(Boolean).join(' ');
  }

  function caseSearchHaystack(caseData, options = {}) {
    const quotes = Array.isArray(caseData?.quotes)
      ? caseData.quotes.map(q => [q.text, q.citation, q.page].filter(Boolean).join(' ')).join(' ')
      : '';
    return normalizeText([
      caseData?.title,
      caseData?.cite,
      caseData?.citation,
      caseData?.functionalCite,
      Array.isArray(caseData?.parallelCitations) ? caseData.parallelCitations.join(' ') : '',
      caseData?.court,
      caseData?.jurisdictionText,
      caseData?.contentType,
      caseData?.contentTypeNormalized,
      caseData?.notes,
      caseData?.description,
      caseData?.holding,
      caseData?.keyFacts,
      caseData?.whyItMatters,
      caseData?.sourceUrl,
      caseData?.url,
      caseData?.permalink,
      caseData?.docLink,
      tagSearchText(caseData, options.tagCatalog),
      quotes
    ].filter(Boolean).join(' '));
  }

  function searchCases(cases, query, options = {}) {
    const term = normalizeText(query);
    const limit = typeof options.limit === 'number' ? options.limit : Infinity;
    const list = Array.isArray(cases) ? cases : [];

    if (!term) return list.slice(0, limit);

    return list
      .filter(caseData => caseSearchHaystack(caseData, options).includes(term))
      .slice(0, limit);
  }

  function searchQuotes(cases, query, options = {}) {
    const term = normalizeText(query);
    const limit = typeof options.limit === 'number' ? options.limit : Infinity;
    const matches = [];

    if (!term) return matches;

    for (const caseData of Array.isArray(cases) ? cases : []) {
      for (const quote of Array.isArray(caseData.quotes) ? caseData.quotes : []) {
        const haystack = normalizeText([quote.text, quote.citation, quote.page, caseData.title, getBestCitation(caseData)].join(' '));
        if (haystack.includes(term)) {
          matches.push({ caseData, quote });
          if (matches.length >= limit) return matches;
        }
      }
    }

    return matches;
  }

  // Normalized opinion text per source, derived once per library rather than
  // on every keystroke. A commit replaces the library, so this goes with it.
  const opinionTextIndexes = new WeakMap();

  function opinionTextIndex(library) {
    let index = opinionTextIndexes.get(library);
    if (index) return index;
    const latestByGuid = new Map();
    for (const document of library.documents || []) {
      if (String(document.contentType || '').toLowerCase() !== 'opinion' ||
          !document.authorityGuid) continue;
      const previous = latestByGuid.get(document.authorityGuid);
      if (!previous || (Date.parse(document.capturedAt) || 0) >
          (Date.parse(previous.capturedAt) || 0)) {
        latestByGuid.set(document.authorityGuid, document);
      }
    }
    const guidByDocument = new Map([...latestByGuid].map(([guid, document]) =>
      [document.documentId, guid]));
    const sectionsByGuid = new Map();
    for (const section of library.documentSections || []) {
      const guid = guidByDocument.get(section.documentId);
      if (!guid) continue;
      if (!sectionsByGuid.has(guid)) sectionsByGuid.set(guid, []);
      sectionsByGuid.get(guid).push(normalizeText(section.text));
    }
    // A normalized needle holds no newline, so no match can span two sections.
    index = [...sectionsByGuid].map(([guid, texts]) => [guid, texts.join('\n')]);
    opinionTextIndexes.set(library, index);
    return index;
  }

  // Scan decrypted, in-memory document sections and return IDs only. The body
  // never enters a snapshot, browser storage, or an ordinary case record.
  function opinionTextMatches(library, query) {
    const needle = normalizeText(query);
    if (!needle || needle.length > 512) return [];
    return opinionTextIndex(library)
      .filter(([, text]) => text.includes(needle))
      .map(([guid]) => guid);
  }

  function findCitationMentions(text, cases) {
    const sourceText = String(text || '');
    const mentions = [];

    for (const caseData of Array.isArray(cases) ? cases : []) {
      const candidates = [getBestCitation(caseData), ...(Array.isArray(caseData.parallelCitations) ? caseData.parallelCitations : [])]
        .filter(Boolean)
        .map(String);

      for (const citation of candidates) {
        const index = sourceText.indexOf(citation);
        if (index !== -1) {
          mentions.push({
            text: citation,
            normalizedCitation: normalizeText(citation),
            matchedCaseGuid: caseData.guid,
            index
          });
        }
      }
    }

    return mentions.sort((a, b) => a.index - b.index);
  }

  const api = {
    normalizeText,
    getBestCitation,
    getInsertableCitation,
    caseSearchHaystack,
    searchCases,
    searchQuotes,
    opinionTextMatches,
    findCitationMentions
  };

  root.QuestLaw = root.QuestLaw || {};
  root.QuestLaw.Search = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
