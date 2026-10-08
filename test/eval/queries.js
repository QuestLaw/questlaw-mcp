/**
 * Queries against test/eval/corpus.js, with graded judgments. Grade 2 is the
 * answer, and grade 1 is something a researcher would be glad to see on the first
 * page. Anything unjudged counts as irrelevant.
 *
 * A judgment names what a hit points at:
 *   case:<guid>               the authority itself
 *   quote:<guid>              any saved quotation on that authority
 *   source:<documentId>       any section of a captured document
 *   source:<documentId>#<label>  one section, by its label
 *
 * `suite` picks the search being measured: `cases` is search_cases (authorities
 * only), `quotes` is search_quotes, `library` is search_library (everything).
 *
 * `snippet`, where given, is text the first answering hit's snippet must show.
 * Ranking the right section first is half the job, and showing the sentence that
 * answers the question saves the model a second call.
 *
 * `kind` groups queries in the report, so a change that helps one kind of search
 * and hurts another shows up as that and not as a wash.
 */
'use strict';

const q = (kind, suite, query, judgments, extra = {}) => ({ kind, suite, query, judgments, ...extra });

module.exports = [
  /* ---- names: the user types the case name they remember */
  q('name', 'cases', 'Loper Bright', { 'case:loper-bright': 2, 'case:chevron': 1 }),
  q('name', 'cases', 'Celotex', { 'case:celotex': 2 }),
  q('name', 'cases', 'Monell', { 'case:monell': 2, 'case:rios-v-county': 1 }),
  q('name', 'cases', 'Twombly', { 'case:twombly': 2, 'case:iqbal': 1, 'case:conley': 1 }),
  q('name', 'cases', 'Chevron', { 'case:chevron': 2, 'case:loper-bright': 1, 'case:mead': 1 }),
  q('name', 'cases', 'Sackett', { 'case:bare-title-only': 2 }),

  /* ---- citations, in the spellings people actually type */
  q('citation', 'cases', '603 U.S. 369', { 'case:loper-bright': 2 }),
  q('citation', 'cases', '603 U. S. 369', { 'case:loper-bright': 2 }),
  q('citation', 'cases', '467 US 837', { 'case:chevron': 2 }),
  q('citation', 'cases', '550 U.S. 544', { 'case:twombly': 2 }),
  q('citation', 'cases', '585 U.S. 296', { 'case:carpenter': 2 }),
  q('citation', 'library', '5 USC 706', { 'source:doc-apa-706': 2, 'case:loper-bright': 1 }),
  q('citation', 'library', '42 U.S.C. § 1983', { 'source:doc-1983': 2, 'case:monell': 1 }),
  q('citation', 'library', 'Fed. R. Civ. P. 56', { 'source:doc-frcp-56': 2, 'case:celotex': 1 }),

  /* ---- doctrine in the researcher's own words */
  q('doctrine', 'cases', 'deference to an agency interpretation of its own regulation',
    { 'case:auer': 2, 'case:kisor': 2, 'case:skidmore': 1 }),
  q('doctrine', 'cases', 'plausibility pleading standard',
    { 'case:twombly': 2, 'case:iqbal': 2, 'case:conley': 1 }),
  q('doctrine', 'cases', 'municipal liability policy or custom', { 'case:monell': 2, 'case:rios-v-county': 1 }),
  q('doctrine', 'cases', 'warrant for cell phone location records',
    { 'case:carpenter': 2, 'case:riley': 1, 'case:smith-maryland': 1 }),
  q('doctrine', 'cases', 'injury in fact concrete and particularized',
    { 'case:lujan': 2, 'case:spokeo': 2, 'case:transunion': 1, 'case:clapper': 1 }),
  q('doctrine', 'cases', 'voluntary cessation mootness', { 'case:laidlaw': 2, 'case:already-llc': 2 }),
  q('doctrine', 'cases', 'agency failed to consider an important aspect of the problem',
    { 'case:state-farm': 2, 'case:overton-park': 1, 'case:ninth-cir-deference': 1 }),
  q('doctrine', 'cases', 'clearly established right qualified immunity',
    { 'case:harlow': 2, 'case:pearson': 2, 'case:tolan': 1 }),
  q('doctrine', 'cases', 'incitement to imminent lawless action', { 'case:brandenburg': 2 }),
  q('doctrine', 'cases', 'actual malice public official', { 'case:sullivan': 2, 'case:anderson': 1 }),
  q('doctrine', 'cases', 'stop and frisk reasonable suspicion', { 'case:terry': 2 }),
  q('doctrine', 'cases', 'reasonable expectation of privacy',
    { 'case:katz': 2, 'case:smith-maryland': 1, 'case:carpenter': 1 }),
  q('doctrine', 'cases', 'threatened injury must be certainly impending', { 'case:clapper': 2 }),
  q('doctrine', 'cases', 'every class member needs standing for damages', { 'case:transunion': 2 }),
  q('doctrine', 'cases', 'excessive force objective reasonableness',
    { 'case:graham': 2, 'case:kingsley': 2 }),
  q('doctrine', 'cases', 'what replaced Chevron', { 'case:loper-bright': 2, 'case:chevron': 1 }),

  /* ---- misspellings and other forms of the word */
  q('typo', 'cases', 'qualifeid immunity', { 'case:harlow': 2, 'case:pearson': 2, 'case:tolan': 1, 'case:iqbal': 1 }),
  q('typo', 'cases', 'Chevorn deference', { 'case:chevron': 2, 'case:loper-bright': 1 }),
  q('typo', 'cases', 'plausable claim', { 'case:twombly': 2, 'case:iqbal': 2 }),
  q('word-form', 'cases', 'deferential review of agency statutory interpretation',
    { 'case:loper-bright': 2, 'case:chevron': 2, 'case:skidmore': 1, 'case:mead': 1 }),
  q('word-form', 'cases', 'redressability', { 'case:lujan': 2, 'case:laidlaw': 1, 'case:mass-v-epa': 1 }),
  q('word-form', 'cases', 'moot', { 'case:laidlaw': 2, 'case:already-llc': 2 }),

  /* ---- the abbreviations practitioners use */
  q('abbreviation', 'cases', 'MSJ burden on the movant',
    { 'case:celotex': 2, 'case:anderson': 1, 'case:matsushita': 1 }),
  q('abbreviation', 'library', '12(b)(6) plausibility',
    { 'case:twombly': 2, 'case:iqbal': 2, 'source:doc-frcp-12#(b)': 1 }),
  q('abbreviation', 'cases', 'QI clearly established', { 'case:harlow': 2, 'case:pearson': 2, 'case:tolan': 1 }),
  q('abbreviation', 'cases', 'APA arbitrary and capricious',
    { 'case:state-farm': 2, 'case:overton-park': 1 }),
  q('abbreviation', 'library', 'FOIA deliberative process exemption',
    { 'source:doc-foia-552b#(b)(5)': 2, 'case:klamath': 2, 'case:milner': 1 }),
  q('abbreviation', 'cases', 'CSLI warrant', { 'case:carpenter': 2 }),
  q('abbreviation', 'cases', 'SJ genuine dispute of material fact',
    { 'case:anderson': 2, 'case:celotex': 1, 'case:matsushita': 1 }),

  /* ---- words that mean something only side by side */
  q('proximity', 'cases', 'summary judgment standard',
    { 'case:celotex': 2, 'case:anderson': 2, 'case:matsushita': 1, 'case:tolan': 1 }),
  q('proximity', 'cases', 'stare decisis', { 'case:loper-bright': 2 }),
  q('proximity', 'cases', 'material fact genuine', { 'case:anderson': 2, 'case:celotex': 1, 'case:matsushita': 1 }),
  q('proximity', 'cases', 'third party doctrine', { 'case:smith-maryland': 2, 'case:carpenter': 2 }),

  /* ---- required phrases */
  q('phrase', 'library', '"arbitrary and capricious"',
    { 'case:state-farm': 2, 'quote:state-farm': 2, 'source:doc-apa-706#(2)(A)': 1 }),
  q('phrase', 'library', '"genuine dispute as to any material fact"', { 'source:doc-frcp-56#(a)': 2 }),
  q('phrase', 'quotes', '"clearly established"', { 'quote:harlow': 2 }),

  /* ---- the answer is inside captured text, often deep inside a long section */
  q('passage', 'library', 'rule of prejudicial error', { 'source:doc-apa-706#flush': 2 },
    { snippet: 'rule of prejudicial error' }),
  q('passage', 'library', 'do prior Chevron holdings keep stare decisis effect',
    { 'source:doc-loper-opinion#IV': 2, 'case:loper-bright': 2, 'quote:loper-bright': 1 },
    { snippet: 'stare decisis' }),
  q('passage', 'library', 'third-party doctrine cell-site location information',
    { 'source:doc-carpenter-opinion#II-A': 2, 'case:carpenter': 2, 'case:smith-maryland': 1 },
    { snippet: 'decline to extend the third-party doctrine' }),
  q('passage', 'library', 'complete failure of proof on an essential element',
    { 'source:doc-celotex-opinion#II': 2, 'quote:celotex': 2, 'case:celotex': 1 },
    { snippet: 'complete failure of proof' }),
  q('passage', 'library', 'failure to state a claim upon which relief can be granted',
    { 'source:doc-frcp-12#(b)': 2, 'case:twombly': 1, 'case:iqbal': 1 },
    { snippet: 'failure to state a claim' }),
  q('passage', 'library', 'inter-agency memorandums not available in litigation',
    { 'source:doc-foia-552b#(b)(5)': 2, 'case:klamath': 1 },
    { snippet: 'inter-agency or intra-agency memorandums' }),
  q('passage', 'library', 'deprivation of rights privileges or immunities secured by the Constitution',
    { 'source:doc-1983': 2, 'case:monell': 1 },
    { snippet: 'deprivation of any rights' }),
  q('passage', 'library', 'Stored Communications Act order reasonable grounds probable cause',
    { 'source:doc-carpenter-opinion#III': 2, 'case:carpenter': 1 },
    { snippet: 'Stored Communications Act' }),
  q('passage', 'library', 'moving party need not support motion with affidavits negating the claim',
    { 'source:doc-celotex-opinion#II': 2, 'case:celotex': 2 },
    { snippet: 'affidavits' }),
  q('passage', 'library', 'agencies have no special competence in resolving statutory ambiguities',
    { 'source:doc-loper-opinion#III': 2, 'case:loper-bright': 1 },
    { snippet: 'no special competence' }),

  /* ---- mixed searches where one authority can crowd out the rest */
  q('mixed', 'library', 'Chevron deference overruled',
    { 'case:loper-bright': 2, 'case:chevron': 2, 'source:doc-loper-opinion': 1, 'quote:loper-bright': 1,
      'case:kisor': 1, 'case:mead': 1 }),
  q('mixed', 'library', 'standing injury',
    { 'case:lujan': 2, 'case:spokeo': 2, 'case:transunion': 2, 'case:clapper': 2, 'case:mass-v-epa': 1,
      'case:laidlaw': 1, 'quote:lujan': 1, 'quote:transunion': 1 }),
  q('mixed', 'library', 'summary judgment burden',
    { 'case:celotex': 2, 'source:doc-celotex-opinion': 1, 'source:doc-frcp-56': 1, 'case:anderson': 1,
      'quote:celotex': 1, 'case:matsushita': 1 }),
  q('mixed', 'library', 'Fourth Amendment warrant',
    { 'case:carpenter': 2, 'case:riley': 2, 'source:doc-carpenter-opinion': 1, 'case:katz': 1,
      'case:terry': 1, 'case:graham': 1 }),

  /* ---- notes and relationships: research that lives only in what the user wrote */
  q('notes', 'cases', 'opposing counsel will lean on the carve-out', { 'case:loper-bright': 2 }),
  q('notes', 'cases', 'Monell claim failed for lack of a pattern', { 'case:rios-v-county': 2, 'case:monell': 1 }),
  q('notes', 'cases', 'what overrules Chevron', { 'case:loper-bright': 2, 'case:chevron': 1 }),
  q('notes', 'cases', 'which case limits Auer', { 'case:kisor': 2, 'case:auer': 1 })
];
