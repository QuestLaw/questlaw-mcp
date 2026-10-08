/**
 * Where a draft cites authorities the library holds, in whatever spelling the
 * draft uses.
 *
 * The vendored Search.findCitationMentions looks for each stored citation with an
 * exact indexOf. That misses "603 US 369" for a stored "603 U.S. 369", misses a
 * stored "603 U.S. 369 (2024)" cited with a pincite, reports only the first place
 * each one appears, and costs one scan of the draft per citation: a 256 KiB draft
 * against 20,000 authorities held the event loop for about 440 ms.
 *
 * So both sides are folded to lowercase letters and digits, with accents removed
 * the way src/tokenize.js removes them, and a citation matches wherever its folded
 * form starts and ends on a word boundary of the folded draft. "603 U.S. 369",
 * "603 U. S. 369" and "603 US 369" all fold to "603us369", and "1603 U.S. 369"
 * doesn't match because the match would start inside a word. The folded
 * citations are bucketed by their first characters once per snapshot, so a scan
 * is one pass over the draft whatever the size of the library.
 */
'use strict';

const { normalize } = require('./tokenize');

/** Folded citations shorter than this are words, not citations, and the bucket key is this long. */
const MIN_KEY = 3;

const COMBINING_MARK = /\p{M}/u;

/** One character as citation text: lowercase letters and digits, or nothing. */
function foldChar(ch) {
  const code = ch.charCodeAt(0);
  if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) return ch;
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
  if (code < 128) return '';
  return normalize(ch).replace(/[^a-z0-9]/g, '');
}

/**
 * The text as one string of letters and digits, with the span of the original
 * each folded character came from and where the original's words start and end.
 */
function foldText(text) {
  const chars = [];
  const from = [];
  const to = [];
  const starts = [];
  const ends = [];
  let inWord = false;
  for (let index = 0; index < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(index));
    const next = index + ch.length;
    const folded = foldChar(ch);
    if (folded) {
      if (!inWord) starts.push(chars.length);
      for (const unit of folded) { chars.push(unit); from.push(index); to.push(next); }
      inWord = true;
    } else if (inWord && !COMBINING_MARK.test(ch)) {
      // An accent on a decomposed letter is part of the word, not the end of it.
      ends.push(chars.length);
      inWord = false;
    }
    index = next;
  }
  if (inWord) ends.push(chars.length);
  const isEnd = new Uint8Array(chars.length + 1);
  for (const end of ends) isEnd[end] = 1;
  return { chars: chars.join(''), from, to, starts, isEnd };
}

/**
 * A trailing parenthetical is the court and year, which a draft drops or moves
 * behind a pincite ("603 U.S. 369, 412 (2024)"), so it's left out of the key.
 */
function citationKey(citation) {
  const text = String(citation || '').trim();
  const bare = foldText(text.replace(/\s*\([^()]*\)\s*$/, '')).chars;
  return bare.length >= MIN_KEY ? bare : foldText(text).chars;
}

/**
 * Built once per snapshot.
 *
 * @param {object[]} cases
 * @param {(caseData: object) => string} bestCitation the citation a case is known by
 */
function buildCitationIndex(cases, bestCitation) {
  const byKey = new Map();
  const lengthsByPrefix = new Map();
  for (const caseData of cases) {
    const parallel = Array.isArray(caseData.parallelCitations) ? caseData.parallelCitations : [];
    const seen = new Set();
    for (const citation of [bestCitation(caseData), ...parallel]) {
      const key = citationKey(citation);
      // A case often repeats its best citation among its parallels.
      if (key.length < MIN_KEY || seen.has(key)) continue;
      seen.add(key);
      const entry = { guid: caseData.guid, citation: String(citation).trim() };
      if (byKey.has(key)) byKey.get(key).push(entry);
      else byKey.set(key, [entry]);
      const prefix = key.slice(0, MIN_KEY);
      if (!lengthsByPrefix.has(prefix)) lengthsByPrefix.set(prefix, new Set());
      lengthsByPrefix.get(prefix).add(key.length);
    }
  }
  // Longest first, so where "5 U.S.C." and "5 U.S.C. 706" both match, a case is
  // reported once, under the fuller citation.
  for (const [prefix, lengths] of lengthsByPrefix) {
    lengthsByPrefix.set(prefix, [...lengths].sort((left, right) => right - left));
  }
  return { byKey, lengthsByPrefix };
}

/**
 * Every place `text` cites a case in the index, in the order they appear.
 *
 * @returns {{index: number, text: string, guid: string, citation: string}[]}
 */
function findCitationMentions(text, citationIndex) {
  const draft = foldText(String(text || ''));
  const mentions = [];
  for (const start of draft.starts) {
    const lengths = citationIndex.lengthsByPrefix.get(draft.chars.slice(start, start + MIN_KEY));
    if (!lengths) continue;
    const reported = new Set();
    for (const length of lengths) {
      const end = start + length;
      if (end > draft.chars.length || !draft.isEnd[end]) continue;
      const entries = citationIndex.byKey.get(draft.chars.slice(start, end));
      if (!entries) continue;
      const from = draft.from[start];
      const written = String(text).slice(from, draft.to[end - 1]);
      for (const entry of entries) {
        if (reported.has(entry.guid)) continue;
        reported.add(entry.guid);
        mentions.push({ index: from, text: written, guid: entry.guid, citation: entry.citation });
      }
    }
  }
  return mentions;
}

module.exports = { buildCitationIndex, findCitationMentions, citationKey, foldText };
