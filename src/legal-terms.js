/**
 * The shorthand practitioners type, and what it stands for. "MSJ" and "summary
 * judgment" share no letters an index could match on, and neither do "QI" and
 * "qualified immunity". Stemming, prefix expansion, and edit distance all work on
 * the shape of a word, and an abbreviation doesn't look like what it abbreviates,
 * so this is the one place search uses a list.
 *
 * The list is short on purpose. Each entry is an abbreviation a litigator would
 * type into a search box, with a single meaning in that setting. Anything
 * ambiguous is left out ("PI" is a preliminary injunction and a personal
 * injury), because a wrong expansion ranks the wrong authorities, which costs
 * more than failing to expand.
 *
 * Expansion runs both ways. "MSJ" also searches "summary judgment" and vice
 * versa, since a note written in a hurry says MSJ and a careful query doesn't.
 */
'use strict';

const { normalize } = require('./tokenize');

/** Abbreviation (as typed, any case) to what it stands for. */
const ABBREVIATIONS = Object.freeze({
  msj: 'summary judgment',
  sj: 'summary judgment',
  psj: 'partial summary judgment',
  jmol: 'judgment as a matter of law',
  mtd: 'motion to dismiss',
  tro: 'temporary restraining order',
  qi: 'qualified immunity',
  apa: 'administrative procedure act',
  foia: 'freedom of information act',
  fisa: 'foreign intelligence surveillance act',
  csli: 'cell site location information',
  ifp: 'in forma pauperis',
  scotus: 'supreme court',
  ada: 'americans with disabilities act',
  fca: 'false claims act',
  fcra: 'fair credit reporting act',
  nepa: 'national environmental policy act'
});

/**
 * Rule subdivisions that name a doctrine. "12(b)(6)" tokenizes to "12", "b", "6",
 * which matches anything under Rule 12, but the researcher means the motion to
 * dismiss for failure to state a claim.
 */
const RULE_REFERENCES = Object.freeze([
  { pattern: /\b12\s*\(\s*b\s*\)\s*\(\s*6\s*\)/i, means: 'failure to state a claim' },
  { pattern: /\b12\s*\(\s*b\s*\)\s*\(\s*1\s*\)/i, means: 'subject matter jurisdiction' },
  { pattern: /\b12\s*\(\s*b\s*\)\s*\(\s*2\s*\)/i, means: 'personal jurisdiction' },
  { pattern: /\brule\s+56\b/i, means: 'summary judgment' },
  { pattern: /\brule\s+11\b/i, means: 'sanctions' }
]);

const WORD = /[a-z0-9]+/g;

/**
 * What a query's shorthand stands for, and the shorthand for what it spells out.
 *
 * @param {string} query
 * @returns {{from: string, to: string}[]} each reading once, in query order
 */
function readShorthand(query) {
  const text = String(query || '');
  const normalized = ` ${(normalize(text).match(WORD) || []).join(' ')} `;
  const words = new Set(normalized.trim().split(' '));
  const readings = [];
  const seen = new Set();
  const note = (from, to) => {
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    readings.push({ from, to });
  };

  for (const { pattern, means } of RULE_REFERENCES) {
    const match = text.match(pattern);
    if (match) note(match[0].replace(/\s+/g, ''), means);
  }
  for (const [short, long] of Object.entries(ABBREVIATIONS)) {
    if (words.has(short)) note(short, long);
    // Spelled out in the query, so also look for the shorthand a note would use.
    else if (normalized.includes(` ${long} `)) note(long, short);
  }
  return readings;
}

module.exports = { ABBREVIATIONS, RULE_REFERENCES, readShorthand };
