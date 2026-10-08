/**
 * The relevance corpus: a plaintext library shaped like a decrypted export.
 * Search runs over the decrypted collections, so relevance can be measured
 * without a vault, which lets this corpus be large and realistic where the
 * encrypted fixture has to stay small. It's a working litigator's library with
 * the things that make ranking hard in practice: notes that mention a doctrine
 * in passing, authorities with nothing but a title, several authorities saying
 * similar things, and captured opinions whose relevant paragraph sits inside a
 * section thousands of characters long.
 *
 * The case names and citations are real. Every note, holding, and quotation is
 * written for this corpus and paraphrases instead of reproducing, and captured
 * "opinion" text is synthetic too. None of it is a reliable statement of law,
 * since it exists to be ranked.
 */
'use strict';

/* ------------------------------------------------------------ projects */

const projects = [
  { id: 1, uid: 'ws-deference', name: 'Agency deference brief' },
  { id: 2, uid: 'ws-standing', name: 'Standing motion to dismiss' },
  { id: 3, uid: 'ws-1983', name: 'Section 1983 excessive force' },
  { id: 4, uid: 'ws-foia', name: 'FOIA request litigation' }
];

/* --------------------------------------------------------------- cases */

let order = 0;
/** Saved in a stable order, with dates that move forward. */
function authority(fields) {
  order += 1;
  return {
    tags: [],
    projectIds: [],
    quotes: [],
    notes: '',
    dateAdded: Date.UTC(2026, 0, 1) + order * 86400000,
    ...fields
  };
}

const cases = [
  authority({
    guid: 'loper-bright',
    title: 'Loper Bright Enterprises v. Raimondo',
    citation: '603 U.S. 369 (2024)',
    court: 'Supreme Court of the United States',
    year: 2024,
    projectIds: [1],
    tags: ['administrative law', 'deference'],
    holding: 'The APA requires courts to exercise independent judgment on whether an agency '
      + 'acted within its statutory authority. Chevron is overruled.',
    notes: 'Lead authority for the brief. Section 706 of the APA does the work: the reviewing '
      + 'court decides all relevant questions of law. Prior cases decided under Chevron keep '
      + 'their statutory stare decisis effect -- watch that carve-out, opposing counsel will lean on it.',
    quotes: [
      { text: 'Courts must exercise their independent judgment in deciding whether an agency has '
        + 'acted within its statutory authority, as the APA requires.', page: '412' },
      { text: 'Chevron is overruled.', page: '412' },
      { text: 'Mere reliance on Chevron cannot constitute a special justification for overruling '
        + 'such a holding.', page: '412' }
    ]
  }),
  authority({
    guid: 'chevron',
    title: 'Chevron U.S.A. Inc. v. Natural Resources Defense Council, Inc.',
    citation: '467 U.S. 837 (1984)',
    court: 'Supreme Court of the United States',
    year: 1984,
    projectIds: [1],
    tags: ['administrative law', 'deference'],
    notes: 'Two-step framework. Step one: has Congress directly spoken to the precise question. '
      + 'Step two: if the statute is silent or ambiguous, is the agency answer based on a '
      + 'permissible construction. No longer good law after Loper Bright.',
    quotes: [
      { text: 'If the intent of Congress is clear, that is the end of the matter.', page: '842' }
    ]
  }),
  authority({
    guid: 'skidmore',
    title: 'Skidmore v. Swift & Co.',
    citation: '323 U.S. 134 (1944)',
    court: 'Supreme Court of the United States',
    year: 1944,
    projectIds: [1],
    tags: ['administrative law'],
    notes: 'Respect, not deference. Weight of an agency interpretation depends on the '
      + 'thoroughness evident in its consideration, the validity of its reasoning, and its '
      + 'consistency with earlier and later pronouncements -- its power to persuade.'
  }),
  authority({
    guid: 'auer',
    title: 'Auer v. Robbins',
    citation: '519 U.S. 452 (1997)',
    court: 'Supreme Court of the United States',
    year: 1997,
    projectIds: [1],
    tags: ['administrative law', 'deference'],
    notes: 'Agency interpretation of its own regulation controls unless plainly erroneous or '
      + 'inconsistent with the regulation. Narrowed substantially by Kisor.'
  }),
  authority({
    guid: 'kisor',
    title: 'Kisor v. Wilkie',
    citation: '588 U.S. 558 (2019)',
    court: 'Supreme Court of the United States',
    year: 2019,
    projectIds: [1],
    tags: ['administrative law', 'deference'],
    holding: 'Deference to an agency reading of its own ambiguous regulation survives, but only '
      + 'after the court exhausts the traditional tools of construction and finds genuine '
      + 'ambiguity, and only for the agency\'s authoritative, considered, expertise-based view.',
    quotes: [
      { text: 'First and foremost, a court should not afford Auer deference unless the '
        + 'regulation is genuinely ambiguous.', page: '573' }
    ]
  }),
  authority({
    guid: 'mead',
    title: 'United States v. Mead Corp.',
    citation: '533 U.S. 218 (2001)',
    court: 'Supreme Court of the United States',
    year: 2001,
    tags: ['administrative law'],
    notes: 'Step zero. Tariff classification rulings did not carry force of law, so no Chevron '
      + 'deference; Skidmore weight at most.'
  }),
  authority({
    guid: 'state-farm',
    title: 'Motor Vehicle Manufacturers Ass\'n v. State Farm Mutual Automobile Insurance Co.',
    citation: '463 U.S. 29 (1983)',
    court: 'Supreme Court of the United States',
    year: 1983,
    projectIds: [1],
    tags: ['administrative law', 'arbitrary and capricious'],
    holding: 'Rescission of the passive restraint standard was arbitrary and capricious because '
      + 'the agency failed to consider an obvious alternative and offered no rational connection '
      + 'between the facts found and the choice made.',
    quotes: [
      { text: 'Normally, an agency rule would be arbitrary and capricious if the agency has relied '
        + 'on factors which Congress has not intended it to consider, entirely failed to consider '
        + 'an important aspect of the problem, offered an explanation for its decision that runs '
        + 'counter to the evidence before the agency.', page: '43' }
    ]
  }),
  authority({
    guid: 'overton-park',
    title: 'Citizens to Preserve Overton Park, Inc. v. Volpe',
    citation: '401 U.S. 402 (1971)',
    court: 'Supreme Court of the United States',
    year: 1971,
    tags: ['administrative law'],
    notes: 'Review of informal adjudication on the whole administrative record. Searching and '
      + 'careful inquiry, but the court may not substitute its judgment for the agency\'s.'
  }),
  authority({
    guid: 'lujan',
    title: 'Lujan v. Defenders of Wildlife',
    citation: '504 U.S. 555 (1992)',
    court: 'Supreme Court of the United States',
    year: 1992,
    projectIds: [2],
    tags: ['standing', 'article iii'],
    holding: 'Plaintiffs lacked standing: no concrete and particularized, actual or imminent '
      + 'injury, and the injury was not likely to be redressed by a favorable decision.',
    quotes: [
      { text: 'The party invoking federal jurisdiction bears the burden of establishing these '
        + 'elements.', page: '561' },
      { text: 'Injury in fact is an invasion of a legally protected interest which is concrete and '
        + 'particularized and actual or imminent, not conjectural or hypothetical.', page: '560' }
    ]
  }),
  authority({
    guid: 'clapper',
    title: 'Clapper v. Amnesty International USA',
    citation: '568 U.S. 398 (2013)',
    court: 'Supreme Court of the United States',
    year: 2013,
    projectIds: [2],
    tags: ['standing', 'surveillance'],
    notes: 'Threatened injury must be certainly impending. A speculative chain of possibilities '
      + 'about FISA surveillance does not establish injury. Self-inflicted costs of avoiding '
      + 'surveillance do not manufacture standing.'
  }),
  authority({
    guid: 'spokeo',
    title: 'Spokeo, Inc. v. Robins',
    citation: '578 U.S. 330 (2016)',
    court: 'Supreme Court of the United States',
    year: 2016,
    projectIds: [2],
    tags: ['standing', 'statutory violation'],
    notes: 'A bare procedural violation of a statute, divorced from any concrete harm, does not '
      + 'satisfy injury in fact. Concreteness is distinct from particularization.'
  }),
  authority({
    guid: 'transunion',
    title: 'TransUnion LLC v. Ramirez',
    citation: '594 U.S. 413 (2021)',
    court: 'Supreme Court of the United States',
    year: 2021,
    projectIds: [2],
    tags: ['standing', 'class actions'],
    holding: 'Every class member must have Article III standing to recover individual damages. '
      + 'Only class members whose misleading credit reports were disseminated to third parties '
      + 'suffered a concrete harm.',
    quotes: [
      { text: 'No concrete harm, no standing.', page: '442' }
    ]
  }),
  authority({
    guid: 'mass-v-epa',
    title: 'Massachusetts v. EPA',
    citation: '549 U.S. 497 (2007)',
    court: 'Supreme Court of the United States',
    year: 2007,
    projectIds: [2],
    tags: ['standing', 'environmental'],
    notes: 'States get special solicitude in the standing analysis. Loss of coastal land from '
      + 'rising seas was a sufficient injury; incremental regulation of emissions would partly '
      + 'redress it.'
  }),
  authority({
    guid: 'laidlaw',
    title: 'Friends of the Earth, Inc. v. Laidlaw Environmental Services (TOC), Inc.',
    citation: '528 U.S. 167 (2000)',
    court: 'Supreme Court of the United States',
    year: 2000,
    projectIds: [2],
    tags: ['standing', 'mootness'],
    notes: 'Voluntary cessation does not moot a case unless it is absolutely clear the wrongful '
      + 'behavior could not reasonably be expected to recur; the heavy burden is on the party '
      + 'asserting mootness. Civil penalties payable to the government can redress a citizen '
      + 'plaintiff\'s injury by deterrence.'
  }),
  authority({
    guid: 'already-llc',
    title: 'Already, LLC v. Nike, Inc.',
    citation: '568 U.S. 85 (2013)',
    court: 'Supreme Court of the United States',
    year: 2013,
    tags: ['mootness'],
    notes: 'Covenant not to sue was broad enough to moot the invalidity counterclaim under the '
      + 'voluntary cessation doctrine.'
  }),
  authority({
    guid: 'twombly',
    title: 'Bell Atlantic Corp. v. Twombly',
    citation: '550 U.S. 544 (2007)',
    court: 'Supreme Court of the United States',
    year: 2007,
    tags: ['pleading', 'civil procedure'],
    holding: 'A complaint must plead enough facts to state a claim to relief that is plausible on '
      + 'its face; parallel conduct alone does not suggest an antitrust conspiracy.',
    quotes: [
      { text: 'Factual allegations must be enough to raise a right to relief above the '
        + 'speculative level.', page: '555' }
    ]
  }),
  authority({
    guid: 'iqbal',
    title: 'Ashcroft v. Iqbal',
    citation: '556 U.S. 662 (2009)',
    court: 'Supreme Court of the United States',
    year: 2009,
    tags: ['pleading', 'civil procedure', 'qualified immunity'],
    notes: 'Plausibility standard applies to all civil actions, not only antitrust. Two steps: '
      + 'disregard legal conclusions, then ask whether the well-pleaded facts plausibly give '
      + 'rise to an entitlement to relief. Threadbare recitals of the elements do not suffice.'
  }),
  authority({
    guid: 'conley',
    title: 'Conley v. Gibson',
    citation: '355 U.S. 41 (1957)',
    court: 'Supreme Court of the United States',
    year: 1957,
    tags: ['pleading'],
    notes: 'The old "no set of facts" standard, retired by Twombly.'
  }),
  authority({
    guid: 'celotex',
    title: 'Celotex Corp. v. Catrett',
    citation: '477 U.S. 317 (1986)',
    court: 'Supreme Court of the United States',
    year: 1986,
    tags: ['summary judgment', 'civil procedure'],
    holding: 'A movant who does not bear the burden of proof at trial may obtain summary judgment '
      + 'by pointing to the absence of evidence supporting the nonmovant\'s case; it need not '
      + 'negate the opponent\'s claim with affidavits.',
    quotes: [
      { text: 'A complete failure of proof concerning an essential element of the nonmoving '
        + 'party\'s case necessarily renders all other facts immaterial.', page: '323' }
    ]
  }),
  authority({
    guid: 'anderson',
    title: 'Anderson v. Liberty Lobby, Inc.',
    citation: '477 U.S. 242 (1986)',
    court: 'Supreme Court of the United States',
    year: 1986,
    tags: ['summary judgment', 'defamation'],
    notes: 'A dispute about a material fact is genuine if the evidence is such that a reasonable '
      + 'jury could return a verdict for the nonmoving party. The substantive evidentiary burden, '
      + 'here clear and convincing evidence of actual malice, applies at the summary judgment stage.'
  }),
  authority({
    guid: 'matsushita',
    title: 'Matsushita Electric Industrial Co. v. Zenith Radio Corp.',
    citation: '475 U.S. 574 (1986)',
    court: 'Supreme Court of the United States',
    year: 1986,
    tags: ['summary judgment', 'antitrust'],
    notes: 'Nonmovant must do more than show some metaphysical doubt as to the material facts. '
      + 'Implausible antitrust theories need more persuasive evidence to survive.'
  }),
  authority({
    guid: 'tolan',
    title: 'Tolan v. Cotton',
    citation: '572 U.S. 650 (2014)',
    court: 'Supreme Court of the United States',
    year: 2014,
    projectIds: [3],
    tags: ['qualified immunity', 'excessive force'],
    notes: 'Per curiam. At summary judgment on qualified immunity, courts must view the evidence '
      + 'in the light most favorable to the nonmovant, including on the clearly established prong.'
  }),
  authority({
    guid: 'monell',
    title: 'Monell v. Department of Social Services',
    citation: '436 U.S. 658 (1978)',
    court: 'Supreme Court of the United States',
    year: 1978,
    projectIds: [3],
    tags: ['section 1983', 'municipal liability'],
    holding: 'Local governments are persons under section 1983 and may be sued when execution of '
      + 'a government policy or custom inflicts the injury, but not on a respondeat superior theory.'
  }),
  authority({
    guid: 'pearson',
    title: 'Pearson v. Callahan',
    citation: '555 U.S. 223 (2009)',
    court: 'Supreme Court of the United States',
    year: 2009,
    projectIds: [3],
    tags: ['qualified immunity', 'section 1983'],
    notes: 'Saucier sequence is no longer mandatory. Courts may decide which prong of qualified '
      + 'immunity to address first -- whether a right was violated, or whether it was clearly '
      + 'established at the time.'
  }),
  authority({
    guid: 'harlow',
    title: 'Harlow v. Fitzgerald',
    citation: '457 U.S. 800 (1982)',
    court: 'Supreme Court of the United States',
    year: 1982,
    projectIds: [3],
    tags: ['qualified immunity'],
    quotes: [
      { text: 'Government officials performing discretionary functions generally are shielded '
        + 'from liability for civil damages insofar as their conduct does not violate clearly '
        + 'established statutory or constitutional rights of which a reasonable person would have '
        + 'known.', page: '818' }
    ]
  }),
  authority({
    guid: 'graham',
    title: 'Graham v. Connor',
    citation: '490 U.S. 386 (1989)',
    court: 'Supreme Court of the United States',
    year: 1989,
    projectIds: [3],
    tags: ['excessive force', 'fourth amendment'],
    holding: 'Claims of excessive force in the course of an arrest or seizure are analyzed under '
      + 'the Fourth Amendment objective reasonableness standard, judged from the perspective of a '
      + 'reasonable officer on the scene.'
  }),
  authority({
    guid: 'kingsley',
    title: 'Kingsley v. Hendrickson',
    citation: '576 U.S. 389 (2015)',
    court: 'Supreme Court of the United States',
    year: 2015,
    projectIds: [3],
    tags: ['excessive force'],
    notes: 'Pretrial detainee excessive force claims: objective standard only, no need to show '
      + 'the officer was subjectively aware the force was unreasonable.'
  }),
  authority({
    guid: 'carpenter',
    title: 'Carpenter v. United States',
    citation: '585 U.S. 296 (2018)',
    court: 'Supreme Court of the United States',
    year: 2018,
    tags: ['fourth amendment', 'digital privacy'],
    holding: 'Acquiring historical cell-site location information is a Fourth Amendment search, '
      + 'and the government generally needs a warrant supported by probable cause to obtain it.',
    quotes: [
      { text: 'We decline to extend Smith and Miller to cover these novel circumstances.',
        page: '309' }
    ]
  }),
  authority({
    guid: 'riley',
    title: 'Riley v. California',
    citation: '573 U.S. 373 (2014)',
    court: 'Supreme Court of the United States',
    year: 2014,
    tags: ['fourth amendment', 'digital privacy'],
    notes: 'Police generally need a warrant before searching digital data on a cell phone seized '
      + 'incident to arrest. Get a warrant.'
  }),
  authority({
    guid: 'katz',
    title: 'Katz v. United States',
    citation: '389 U.S. 347 (1967)',
    court: 'Supreme Court of the United States',
    year: 1967,
    tags: ['fourth amendment'],
    notes: 'The Fourth Amendment protects people, not places. Harlan concurrence supplies the '
      + 'reasonable expectation of privacy test.'
  }),
  authority({
    guid: 'smith-maryland',
    title: 'Smith v. Maryland',
    citation: '442 U.S. 735 (1979)',
    court: 'Supreme Court of the United States',
    year: 1979,
    tags: ['fourth amendment', 'third-party doctrine'],
    notes: 'Pen register. No legitimate expectation of privacy in numbers dialed, which are '
      + 'voluntarily conveyed to the phone company.'
  }),
  authority({
    guid: 'terry',
    title: 'Terry v. Ohio',
    citation: '392 U.S. 1 (1968)',
    court: 'Supreme Court of the United States',
    year: 1968,
    tags: ['fourth amendment'],
    notes: 'Brief investigatory stop and pat-down for weapons permitted on reasonable, articulable '
      + 'suspicion that criminal activity is afoot and the person is armed and dangerous.'
  }),
  authority({
    guid: 'brandenburg',
    title: 'Brandenburg v. Ohio',
    citation: '395 U.S. 444 (1969)',
    court: 'Supreme Court of the United States',
    year: 1969,
    tags: ['first amendment'],
    holding: 'The state may not forbid advocacy of force or law violation except where it is '
      + 'directed to inciting or producing imminent lawless action and is likely to produce it.'
  }),
  authority({
    guid: 'sullivan',
    title: 'New York Times Co. v. Sullivan',
    citation: '376 U.S. 254 (1964)',
    court: 'Supreme Court of the United States',
    year: 1964,
    tags: ['first amendment', 'defamation'],
    notes: 'Public official plaintiff must prove actual malice -- knowledge of falsity or reckless '
      + 'disregard of whether the statement was false.'
  }),
  authority({
    guid: 'milner',
    title: 'Milner v. Department of the Navy',
    citation: '562 U.S. 562 (2011)',
    court: 'Supreme Court of the United States',
    year: 2011,
    projectIds: [4],
    tags: ['foia'],
    notes: 'Exemption 2 covers only records relating to personnel rules and practices; the '
      + 'High 2 gloss for sensitive law enforcement material is rejected. Exemptions are to be '
      + 'narrowly construed.'
  }),
  authority({
    guid: 'klamath',
    title: 'Department of the Interior v. Klamath Water Users Protective Ass\'n',
    citation: '532 U.S. 1 (2001)',
    court: 'Supreme Court of the United States',
    year: 2001,
    projectIds: [4],
    tags: ['foia'],
    notes: 'Communications with tribes were not inter-agency or intra-agency memorandums, so '
      + 'Exemption 5 and the deliberative process privilege did not protect them.'
  }),
  authority({
    guid: 'rios-v-county',
    title: 'Rios v. County of Alameda',
    citation: '2023 WL 1234567 (N.D. Cal. Mar. 3, 2023)',
    court: 'United States District Court for the Northern District of California',
    year: 2023,
    projectIds: [3],
    tags: ['section 1983'],
    notes: 'Useful procedural summary: the court granted judgment on the pleadings for the '
      + 'county, noting in its summary of the record that the officers had not moved for '
      + 'judgment on the excessive force count. Material facts about the timeline were '
      + 'disputed. Good example of a Monell claim that failed for lack of a pattern.'
  }),
  authority({
    guid: 'ninth-cir-deference',
    title: 'Hawaii Longline Ass\'n v. National Marine Fisheries Service',
    citation: '281 F. Supp. 2d 1 (D.D.C. 2003)',
    court: 'United States District Court for the District of Columbia',
    year: 2003,
    projectIds: [1],
    tags: ['administrative law', 'fisheries'],
    notes: 'Fisheries rule vacated for failure to consider the effect on the longline fleet. '
      + 'Background for the Magnuson-Stevens Act monitoring issue in Loper Bright.'
  }),
  authority({
    guid: 'bare-title-only',
    title: 'Sackett v. EPA',
    citation: '598 U.S. 651 (2023)',
    court: 'Supreme Court of the United States',
    year: 2023
  })
];

/* ------------------------------------------------------- relationships */

const edge = (fromGuid, toGuid, type, note = '') => ({ fromGuid, toGuid, type, note, suppressedAt: 0 });

const relationships = [
  edge('loper-bright', 'chevron', 'overrules', 'Expressly overruled; prior holdings keep stare decisis effect.'),
  edge('kisor', 'auer', 'limits', 'Genuine ambiguity required before any deference to the agency.'),
  edge('iqbal', 'twombly', 'extends', 'Plausibility applies to every civil action.'),
  edge('twombly', 'conley', 'overrules', 'Retires the no set of facts language.'),
  edge('clapper', 'mass-v-epa', 'distinguishes', 'Certainly impending harm versus state special solicitude.'),
  edge('transunion', 'spokeo', 'applies', 'Concrete harm requirement applied to a damages class.'),
  edge('carpenter', 'smith-maryland', 'distinguishes', 'Cell-site records are not like dialed numbers.'),
  edge('pearson', 'harlow', 'applies', '')
];

/* ------------------------------------------------------------ captured */

/**
 * Procedural paragraphs of the kind every opinion carries. They make a section
 * long the way a real one is long, with legal vocabulary that is noise for
 * nearly every query.
 */
const PROCEDURAL = [
  'The District Court granted the motion, and the Court of Appeals affirmed over a dissent. We '
    + 'granted certiorari to resolve a disagreement among the Circuits on the question presented.',
  'The record before us reflects extensive proceedings below, including briefing by the parties '
    + 'and several amici, supplemental submissions after argument, and a remand for further '
    + 'findings that the lower court entered without objection.',
  'Petitioners contend that the judgment below rests on a misreading of our precedents and of the '
    + 'governing statute. Respondents defend the judgment on the reasoning of the panel and, in the '
    + 'alternative, on a ground the panel did not reach.',
  'We review questions of law de novo. Findings of fact are reviewed for clear error, and we give '
    + 'due regard to the opportunity of the trial court to judge the credibility of the witnesses.',
  'The parties agree on the essential chronology. They disagree about its significance, and about '
    + 'which party bears the consequence of the gaps in the documentary evidence.',
  'Neither side suggests that the case turns on any fact not already found. The dispute is about '
    + 'the legal standard that governs, and the application of that standard to the settled facts.',
  'Our decision today is limited to the question on which we granted review. We express no view '
    + 'on the remaining issues, which the lower court may address in the first instance on remand.',
  'The dissent reads our cases differently. But the passages it relies on were written against a '
    + 'different statutory background, and they do not purport to decide the question here.'
];

/** A section `paragraphs` long, the substantive ones placed among procedural ones. */
function longSection(substantive, { before = 4, after = 4, seed = 0 } = {}) {
  const pick = count => Array.from({ length: count },
    (_, index) => PROCEDURAL[(seed + index * 3) % PROCEDURAL.length]);
  // Each procedural block appears twice over, so sections run to several
  // thousand characters, like a real Part of an opinion.
  return [...pick(before), ...pick(before), ...substantive, ...pick(after), ...pick(after)]
    .join('\n\n');
}

let sectionCounter = 0;
function section(documentId, label, heading, text) {
  sectionCounter += 1;
  return {
    sectionId: `${documentId}-s${sectionCounter}`,
    documentId,
    order: sectionCounter,
    label,
    heading,
    text,
    status: 'active'
  };
}

const documents = [
  {
    documentId: 'doc-loper-opinion', authorityGuid: 'loper-bright', contentType: 'opinion',
    sourceTitle: 'Loper Bright Enterprises v. Raimondo (opinion)', sourceCitation: '603 U.S. 369'
  },
  {
    documentId: 'doc-apa-706', authorityGuid: 'loper-bright', contentType: 'statute',
    sourceTitle: '5 U.S.C. 706 - Scope of review', sourceCitation: '5 U.S.C. § 706'
  },
  {
    documentId: 'doc-frcp-56', authorityGuid: '', contentType: 'rule',
    sourceTitle: 'Federal Rule of Civil Procedure 56 - Summary Judgment', sourceCitation: 'Fed. R. Civ. P. 56'
  },
  {
    documentId: 'doc-frcp-12', authorityGuid: '', contentType: 'rule',
    sourceTitle: 'Federal Rule of Civil Procedure 12 - Defenses and Objections',
    sourceCitation: 'Fed. R. Civ. P. 12'
  },
  {
    documentId: 'doc-1983', authorityGuid: 'monell', contentType: 'statute',
    sourceTitle: '42 U.S.C. 1983 - Civil action for deprivation of rights',
    sourceCitation: '42 U.S.C. § 1983'
  },
  {
    documentId: 'doc-foia-552b', authorityGuid: 'milner', contentType: 'statute',
    sourceTitle: '5 U.S.C. 552(b) - Exemptions', sourceCitation: '5 U.S.C. § 552(b)'
  },
  {
    documentId: 'doc-carpenter-opinion', authorityGuid: 'carpenter', contentType: 'opinion',
    sourceTitle: 'Carpenter v. United States (opinion)', sourceCitation: '585 U.S. 296'
  },
  {
    documentId: 'doc-celotex-opinion', authorityGuid: 'celotex', contentType: 'opinion',
    sourceTitle: 'Celotex Corp. v. Catrett (opinion)', sourceCitation: '477 U.S. 317'
  }
];

const documentSections = [
  section('doc-loper-opinion', 'I', 'Background', longSection([
    'The Magnuson-Stevens Act authorizes the National Marine Fisheries Service to require that '
      + 'fishing vessels carry federal observers. The agency promulgated a rule requiring the '
      + 'industry to pay for the monitors, and the herring fishermen challenged it as exceeding '
      + 'the statute.'
  ], { seed: 1 })),
  section('doc-loper-opinion', 'II', 'The judicial role under the APA', longSection([
    'The Administrative Procedure Act codifies the traditional understanding that courts decide '
      + 'legal questions by applying their own judgment. Section 706 directs that the reviewing '
      + 'court shall decide all relevant questions of law and interpret statutory provisions.',
    'The Act prescribes no deferential standard for courts to employ in answering those legal '
      + 'questions, in contrast to the deferential standards it sets for agency policymaking and '
      + 'factfinding.'
  ], { seed: 2 })),
  section('doc-loper-opinion', 'III', 'Chevron cannot be reconciled with the APA', longSection([
    'Chevron presumes that statutory ambiguities are implicit delegations to agencies. That '
      + 'presumption is misguided, because agencies have no special competence in resolving '
      + 'statutory ambiguities; courts do.',
    'The framework has proved unworkable, and its exceptions and refinements have left it a '
      + 'shell of a rule that invites litigants to argue about whether it applies at all.'
  ], { seed: 3 })),
  section('doc-loper-opinion', 'IV', 'Stare decisis', longSection([
    'Stare decisis does not require us to persist in the Chevron project. The doctrine is not an '
      + 'inexorable command, and the quality of the reasoning, workability, and reliance interests '
      + 'all weigh in favor of overruling.',
    'We do not call into question prior cases that relied on the Chevron framework. The holdings '
      + 'of those cases that specific agency actions are lawful remain subject to statutory stare '
      + 'decisis despite our change in interpretive methodology. Mere reliance on Chevron cannot '
      + 'constitute a special justification for overruling such a holding.'
  ], { seed: 4 })),

  section('doc-apa-706', '', 'Scope of review', 'To the extent necessary to decision and when '
    + 'presented, the reviewing court shall decide all relevant questions of law, interpret '
    + 'constitutional and statutory provisions, and determine the meaning or applicability of the '
    + 'terms of an agency action. The reviewing court shall--'),
  section('doc-apa-706', '(1)', '', 'compel agency action unlawfully withheld or unreasonably delayed; and'),
  section('doc-apa-706', '(2)(A)', '', 'hold unlawful and set aside agency action, findings, and '
    + 'conclusions found to be arbitrary, capricious, an abuse of discretion, or otherwise not in '
    + 'accordance with law;'),
  section('doc-apa-706', '(2)(C)', '', 'in excess of statutory jurisdiction, authority, or '
    + 'limitations, or short of statutory right;'),
  section('doc-apa-706', '(2)(E)', '', 'unsupported by substantial evidence in a case subject to '
    + 'sections 556 and 557 of this title or otherwise reviewed on the record of an agency hearing '
    + 'provided by statute;'),
  section('doc-apa-706', 'flush', '', 'In making the foregoing determinations, the court shall review '
    + 'the whole record or those parts of it cited by a party, and due account shall be taken of the '
    + 'rule of prejudicial error.'),

  section('doc-frcp-56', '(a)', 'Motion for Summary Judgment or Partial Summary Judgment', 'A party may '
    + 'move for summary judgment, identifying each claim or defense on which summary judgment is '
    + 'sought. The court shall grant summary judgment if the movant shows that there is no genuine '
    + 'dispute as to any material fact and the movant is entitled to judgment as a matter of law. '
    + 'The court should state on the record the reasons for granting or denying the motion.'),
  section('doc-frcp-56', '(b)', 'Time to File a Motion', 'Unless a different time is set by local rule '
    + 'or the court orders otherwise, a party may file a motion for summary judgment at any time '
    + 'until 30 days after the close of all discovery.'),
  section('doc-frcp-56', '(c)', 'Procedures', 'A party asserting that a fact cannot be or is genuinely '
    + 'disputed must support the assertion by citing to particular parts of materials in the record, '
    + 'including depositions, documents, electronically stored information, affidavits or '
    + 'declarations, stipulations, admissions, interrogatory answers, or other materials; or showing '
    + 'that the materials cited do not establish the absence or presence of a genuine dispute.'),
  section('doc-frcp-56', '(d)', 'When Facts Are Unavailable to the Nonmovant', 'If a nonmovant shows by '
    + 'affidavit or declaration that, for specified reasons, it cannot present facts essential to '
    + 'justify its opposition, the court may defer considering the motion or deny it, allow time to '
    + 'obtain affidavits or declarations or to take discovery, or issue any other appropriate order.'),
  section('doc-frcp-56', '(h)', 'Affidavit or Declaration Submitted in Bad Faith', 'If satisfied that an '
    + 'affidavit or declaration under this rule is submitted in bad faith or solely for delay, the '
    + 'court may order the submitting party to pay the other party the reasonable expenses it '
    + 'incurred as a result.'),

  section('doc-frcp-12', '(b)', 'How to Present Defenses', 'Every defense to a claim for relief in any '
    + 'pleading must be asserted in the responsive pleading if one is required. But a party may '
    + 'assert the following defenses by motion: (1) lack of subject-matter jurisdiction; (2) lack of '
    + 'personal jurisdiction; (3) improper venue; (4) insufficient process; (5) insufficient service '
    + 'of process; (6) failure to state a claim upon which relief can be granted; and (7) failure to '
    + 'join a party under Rule 19.'),
  section('doc-frcp-12', '(c)', 'Motion for Judgment on the Pleadings', 'After the pleadings are closed, '
    + 'but early enough not to delay trial, a party may move for judgment on the pleadings.'),
  section('doc-frcp-12', '(h)', 'Waiving and Preserving Certain Defenses', 'A party waives any defense '
    + 'listed in Rule 12(b)(2)-(5) by omitting it from a motion in the circumstances described in '
    + 'Rule 12(g)(2), or by failing to make it by motion or include it in a responsive pleading.'),

  section('doc-1983', '', 'Civil action for deprivation of rights', 'Every person who, under color of '
    + 'any statute, ordinance, regulation, custom, or usage, of any State or Territory or the '
    + 'District of Columbia, subjects, or causes to be subjected, any citizen of the United States '
    + 'or other person within the jurisdiction thereof to the deprivation of any rights, privileges, '
    + 'or immunities secured by the Constitution and laws, shall be liable to the party injured in '
    + 'an action at law, suit in equity, or other proper proceeding for redress.'),

  section('doc-foia-552b', '(b)(2)', '', 'related solely to the internal personnel rules and practices of '
    + 'an agency;'),
  section('doc-foia-552b', '(b)(5)', '', 'inter-agency or intra-agency memorandums or letters that would '
    + 'not be available by law to a party other than an agency in litigation with the agency, '
    + 'provided that the deliberative process privilege shall not apply to records created 25 years '
    + 'or more before the date on which the records were requested;'),
  section('doc-foia-552b', '(b)(6)', '', 'personnel and medical files and similar files the disclosure '
    + 'of which would constitute a clearly unwarranted invasion of personal privacy;'),
  section('doc-foia-552b', '(b)(7)', '', 'records or information compiled for law enforcement purposes, '
    + 'but only to the extent that the production of such law enforcement records or information '
    + 'could reasonably be expected to interfere with enforcement proceedings;'),

  section('doc-carpenter-opinion', 'II-A', 'The third-party doctrine', longSection([
    'The Government contends that the third-party doctrine governs this case, because the cell-site '
      + 'records were business records created and maintained by the wireless carriers.',
    'We decline to extend the third-party doctrine to cover historical cell-site location '
      + 'information. There is a world of difference between the limited types of personal '
      + 'information addressed in Smith and Miller and the exhaustive chronicle of location '
      + 'information casually collected by wireless carriers today.'
  ], { seed: 5 })),
  section('doc-carpenter-opinion', 'III', 'The warrant requirement', longSection([
    'Having found that the acquisition of the records was a search, we also conclude that the '
      + 'Government must generally obtain a warrant supported by probable cause before acquiring '
      + 'such records. An order under the Stored Communications Act, which requires only reasonable '
      + 'grounds, falls well short of the probable cause required for a warrant.'
  ], { seed: 6 })),
  section('doc-carpenter-opinion', 'IV', 'Limits of the decision', longSection([
    'Our decision today is a narrow one. We do not disturb the application of Smith and Miller or '
      + 'call into question conventional surveillance techniques and tools, such as security cameras. '
      + 'Nor does it consider other business records that might incidentally reveal location '
      + 'information.'
  ], { seed: 7 })),

  section('doc-celotex-opinion', 'I', 'Proceedings below', longSection([
    'The respondent sued asbestos manufacturers alleging that her husband died from exposure to '
      + 'products they made. Petitioner moved for summary judgment on the ground that respondent '
      + 'could produce no evidence that any product it manufactured was the proximate cause of the '
      + 'injuries.'
  ], { seed: 0 })),
  section('doc-celotex-opinion', 'II', 'The moving party\'s burden', longSection([
    'In our view, the plain language of Rule 56 mandates the entry of summary judgment, after '
      + 'adequate time for discovery and upon motion, against a party who fails to make a showing '
      + 'sufficient to establish the existence of an element essential to that party\'s case, and on '
      + 'which that party will bear the burden of proof at trial.',
    'In such a situation, there can be no genuine issue as to any material fact, since a complete '
      + 'failure of proof concerning an essential element of the nonmoving party\'s case necessarily '
      + 'renders all other facts immaterial.',
    'We find no express or implied requirement in Rule 56 that the moving party support its motion '
      + 'with affidavits or other similar materials negating the opponent\'s claim.'
  ], { seed: 3 }))
];

module.exports = {
  library: {
    cases,
    projects,
    relationships,
    workspaceSections: [],
    documents,
    documentSections,
    documentReferences: []
  }
};
