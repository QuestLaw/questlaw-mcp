/**
 * Turns legal text into terms worth matching. Plain whitespace tokenization
 * loses most of what makes a citation findable: "603 U.S. 369", "603 U. S. 369",
 * and "603 US 369" are the same citation, "F.3d" and "F. 3d" are one reporter,
 * and a section symbol is a word. So abbreviations are folded before splitting,
 * and a volume-reporter-page run also emits one joined term, so a pasted
 * citation matches a stored one exactly instead of by sharing the number 603.
 *
 * Stemming is deliberately light (plurals and common verb endings, not full
 * Porter) because aggressive stemming mangles legal vocabulary. Porter doesn't
 * reduce "deferential" to the same stem as "deference", and the prefix expansion
 * in the query planner bridges those pairs without guessing.
 */
'use strict';

/**
 * Dropped only when a query or field has other terms to go on. "not" and "no" are
 * left out on purpose since they carry meaning in a holding.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'she', 'that', 'the', 'their', 'them', 'there', 'these',
  'they', 'this', 'to', 'was', 'were', 'which', 'who', 'will', 'with', 'would',
  // Question phrasing, not subject matter. In "what overrules Chevron" only the
  // last two words say anything about the library.
  'what', 'when', 'where', 'why', 'how', 'does', 'did', 'do'
]);

/** Spelling variants of the same word. */
const VARIANTS = new Map([
  ['judgement', 'judgment'],
  ['acknowledgement', 'acknowledgment'],
  ['defence', 'defense'],
  ['offence', 'offense'],
  ['plaintiffs', 'plaintiff'],
  ['defendants', 'defendant']
]);

const VOWEL = /[aeiouy]/;

/**
 * Marks a hard break between texts concatenated into one field, such as separate
 * quotations on one authority. Callers insert it and this module turns it into a
 * jump in position numbers.
 *
 * It's built with fromCharCode because a raw control character in source is
 * invisible in a diff, makes grep treat the file as binary, and doesn't survive
 * every editor. NUL works because no legal text contains one.
 */
const SEGMENT_BREAK = String.fromCharCode(0);

/**
 * Positions skipped at a break. Any value past the longest searchable phrase
 * works, as long as positions can't straddle a boundary.
 */
const SEGMENT_GAP = 100;

/** Fold accents, case, and the punctuation that only separates abbreviations. */
function normalize(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // A section symbol is a word, and a doubled one is "sections".
    .replace(/§§/g, ' sections ')
    .replace(/§/g, ' section ')
    // Runs of single-letter abbreviations collapse: "u.s." -> "us", "f.supp." -> "fsupp".
    .replace(/\b(?:[a-z]\.\s*){2,}/g, match => ` ${match.replace(/[.\s]/g, '')} `)
    // A letter followed by a period and a digit is one reporter: "f.3d" -> "f3d".
    .replace(/\b([a-z])\.\s*(\d)/g, '$1$2')
    // Possessives never distinguish anything here.
    .replace(/'s\b/g, '')
    .replace(/[‘’“”]/g, ' ');
}

/** Suffix rules, first match wins. "sses" has to come before the bare "s" that would otherwise claim it. */
const SUFFIX_RULES = Object.freeze([
  { suffix: 'ies', minLength: 5, apply: term => `${term.slice(0, -3)}y` },
  { suffix: 'sses', minLength: 4, apply: term => term.slice(0, -2) },
  {
    suffix: 's',
    minLength: 4,
    // "us", "ss" and "is" endings aren't plurals (amicus, class, analysis).
    when: term => !/(?:ss|us|is)$/.test(term),
    apply: term => term.slice(0, -1)
  },
  {
    suffix: 'ing',
    minLength: 6,
    when: term => VOWEL.test(term.slice(0, -3)),
    apply: term => term.slice(0, -3)
  },
  {
    suffix: 'ed',
    minLength: 5,
    when: term => VOWEL.test(term.slice(0, -2)),
    apply: term => term.slice(0, -2)
  },
  { suffix: 'ly', minLength: 5, apply: term => term.slice(0, -2) }
]);

function stem(term) {
  const variant = VARIANTS.get(term);
  if (variant) return variant;
  if (term.length <= 3) return term;

  for (const rule of SUFFIX_RULES) {
    const matches = term.length >= rule.minLength
      && term.endsWith(rule.suffix)
      && (!rule.when || rule.when(term));
    if (matches) return rule.apply(term);
  }
  return term;
}

/**
 * Terms in order, with the positions phrase matching needs. A
 * volume-reporter-page run also yields a joined term at the position of its first
 * token, so phrase queries and citation queries both match.
 *
 * Positions jump at a segment break. Without the jump, the last word of one
 * quotation and the first word of the next get consecutive positions, and a
 * phrase search matches a sequence that exists in no real sentence.
 *
 * @returns {{terms: string[], positions: number[]}}
 */
function tokenize(value) {
  const terms = [];
  const positions = [];
  let base = 0;

  for (const segment of String(value == null ? '' : value).split(SEGMENT_BREAK)) {
    const raw = normalize(segment).split(/[^a-z0-9]+/).filter(Boolean);

    for (let index = 0; index < raw.length; index += 1) {
      const token = raw[index];
      terms.push(stem(token));
      positions.push(base + index);

      // volume, reporter, page -> one citation term, e.g. "603us369".
      const reporter = raw[index + 1];
      const page = raw[index + 2];
      if (
        /^\d{1,4}$/.test(token) && reporter && /^[a-z][a-z0-9]{0,7}$/.test(reporter)
        && page && /^\d{1,5}$/.test(page)
      ) {
        terms.push(`${token}${reporter}${page}`);
        positions.push(base + index);
      }
    }
    base += raw.length + SEGMENT_GAP;
  }
  return { terms, positions };
}

/** Terms only, stopwords dropped when something else survives. */
function contentTerms(value) {
  const { terms } = tokenize(value);
  const kept = terms.filter(term => !STOPWORDS.has(term));
  return kept.length ? kept : terms;
}

/**
 * @returns {{terms: string[], phrases: string[][], hadQuotes: boolean}}
 */
function parseQuery(query) {
  const text = String(query || '');
  const phrases = [];
  let hadQuotes = false;

  const remainder = text.replace(/"([^"]+)"/g, (_match, inner) => {
    hadQuotes = true;
    const terms = tokenize(inner).terms;
    if (terms.length) phrases.push(terms);
    return ' ';
  });

  const terms = contentTerms(remainder);
  // A bare phrase query still needs its words as terms, or nothing scores.
  if (!terms.length && phrases.length) {
    return { terms: [...new Set(phrases.flat())], phrases, hadQuotes };
  }
  return { terms, phrases, hadQuotes };
}

module.exports = {
  normalize, stem, tokenize, contentTerms, parseQuery,
  STOPWORDS, VARIANTS, SEGMENT_BREAK, SEGMENT_GAP
};
