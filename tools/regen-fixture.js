#!/usr/bin/env node
/**
 * Rebuilds the committed test fixture from a QuestLaw extension checkout.
 *
 * The fixture is committed so `npm test` works for anyone who installs this
 * package, with no checkout and no network. It's regenerated deliberately (after
 * a vendor sync, or when a new record type needs covering) so the committed vault
 * is always something the shipped writer actually produced.
 *
 *   node tools/regen-fixture.js --repo <path>      (or set QUESTLAW_REPO)
 *
 * It needs the checkout's dev dependencies (fake-indexeddb), because the vault is
 * written by the shipped stack and not a stand-in.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');
const { findCheckout } = require('./checkout');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(PACKAGE_ROOT, 'test', 'fixtures');
const MODULES = ['src/core/private-work-product-crypto.js', 'tests/helpers/encrypted-library.js'];

function resolveRepo() {
  const explicitIndex = process.argv.indexOf('--repo');
  return findCheckout(MODULES, explicitIndex >= 0 ? process.argv[explicitIndex + 1] : '');
}

const LONG_NOTE = 'The panel splits on whether the statute is genuinely ambiguous. '
  + 'Track the concurrence, which would reach the same result on the text alone. '.repeat(60);

/** Research with one of every record type the reader groups. */
async function populate(db) {
  await db.createProject({ id: 1, name: 'Chevron deference brief', color: '#2f6f4f' });
  await db.createProject({ id: 2, name: 'Standing / mootness' });

  await db.saveCase({
    guid: 'case-loper-bright',
    title: 'Loper Bright Enterprises v. Raimondo',
    citation: '603 U.S. 369 (2024)',
    court: 'U.S. Supreme Court',
    year: 2024,
    projectIds: [1],
    tags: ['administrative law', 'deference'],
    holding: 'Courts decide statutory questions independently; Chevron is overruled.',
    whyItMatters: 'Removes the deference step from every agency-authority argument.',
    notes: 'Overrules Chevron. APA section 706 does the work. Watch the stare decisis '
      + 'carve-out at 412.'
  });
  await db.addQuote('case-loper-bright', {
    text: 'Courts must exercise their independent judgment in deciding whether an agency has '
      + 'acted within its statutory authority.',
    page: '412',
    citation: '603 U.S. 369, 412 (2024)'
  });
  await db.addQuote('case-loper-bright', { text: 'Chevron is overruled.', page: '412' });

  await db.saveCase({
    guid: 'case-lujan',
    title: 'Lujan v. Defenders of Wildlife',
    citation: '504 U.S. 555 (1992)',
    court: 'U.S. Supreme Court',
    year: 1992,
    projectIds: [2],
    tags: ['standing'],
    keyFacts: 'Environmental groups challenged a rule limiting the ESA to domestic action.',
    notes: 'Three-part injury/causation/redressability test at 560-61.'
  });
  await db.addQuote('case-lujan', {
    text: 'The party invoking federal jurisdiction bears the burden of establishing these elements.',
    page: '561'
  });

  // Long note and long quote: the fixture the response caps are measured against.
  await db.saveCase({
    guid: 'case-verbose',
    title: 'Verbose Holdings LLC v. Administrator',
    citation: '77 F.4th 100 (9th Cir. 2023)',
    court: '9th Cir.',
    year: 2023,
    projectIds: [1],
    tags: ['deference'],
    notes: LONG_NOTE
  });
  await db.addQuote('case-verbose', { text: `Independent judgment. ${LONG_NOTE}`, page: '118' });

  // No project and no quotes, the sparsest shape every projection must survive.
  await db.saveCase({ guid: 'case-bare', title: 'Bare Record v. Nobody' });

  await db.addRelationship({
    fromGuid: 'case-loper-bright',
    toGuid: 'case-lujan',
    type: 'distinguishes',
    note: 'Different threshold question.'
  });

  await db.saveWorkspaceSection({
    id: 'sec-argument-1',
    name: 'Argument I: no deference owed',
    notes: 'Open with Loper Bright, then the statutory text.'
  });

  await db.saveDocumentStructure({
    document: {
      documentId: 'doc-apa-706',
      authorityGuid: 'case-loper-bright',
      contentType: 'statute',
      sourceTitle: '5 U.S.C. 706 - Scope of review',
      sourceCitation: '5 U.S.C. sec. 706',
      sourceUrl: 'https://www.law.cornell.edu/uscode/text/5/706',
      platform: 'westlaw'
    },
    documentSections: [
      {
        label: '(a)',
        text: 'To the extent necessary to decision and when presented, the reviewing court shall '
          + 'decide all relevant questions of law, interpret constitutional and statutory '
          + 'provisions, and determine the meaning or applicability of the terms of an agency action.'
      },
      {
        label: '(2)(A)',
        text: 'The reviewing court shall hold unlawful and set aside agency action, findings, and '
          + 'conclusions found to be arbitrary, capricious, an abuse of discretion, or otherwise '
          + 'not in accordance with law.'
      }
    ],
    documentReferences: [
      { referenceText: '5 U.S.C. 706(2)(A)', referenceKind: 'statute', sectionId: '' }
    ]
  });

  // A captured opinion body. portableCollections() filters this contentType out
  // of the ordinary JSON export but the .qlvault carries it. The consent copy
  // rests on that, and test/reader.test.js holds it in place.
  await db.saveDocumentStructure({
    document: {
      documentId: 'doc-loper-opinion',
      authorityGuid: 'case-loper-bright',
      contentType: 'case',
      sourceTitle: 'Loper Bright Enterprises v. Raimondo (opinion)',
      sourceUrl: 'https://example.invalid/loper'
    },
    documentSections: [
      { label: 'II.B', text: 'The full opinion paragraph body text lives here, verbatim.' }
    ]
  });
}

async function main() {
  const repo = resolveRepo();
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
  if (typeof global.structuredClone === 'undefined') {
    global.structuredClone = value => JSON.parse(JSON.stringify(value));
  }
  let fakeIndexedDb;
  try {
    fakeIndexedDb = require(path.join(repo, 'node_modules/fake-indexeddb'));
  } catch (error) {
    throw new Error(`fake-indexeddb is not loadable from ${repo} (${error.message}). `
      + 'The fixture is written by the shipped vault stack, so run `npm ci` in the checkout.');
  }
  global.indexedDB = fakeIndexedDb.indexedDB;
  global.IDBKeyRange = fakeIndexedDb.IDBKeyRange;

  const { createEncryptedLibrary } = require(path.join(repo, 'tests/helpers/encrypted-library'));
  const library = await createEncryptedLibrary();
  try {
    await populate(library.db);
    const exported = await library.vault.exportEncrypted();
    const portable = await library.db.exportAll();
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'library.qlvault'), exported);
    fs.writeFileSync(path.join(FIXTURE_DIR, 'recovery.txt'), `${library.recoveryCode}\n`);
    fs.writeFileSync(path.join(FIXTURE_DIR, 'portable-export.json'),
      `${JSON.stringify(portable, null, 2)}\n`);
    fs.writeFileSync(path.join(FIXTURE_DIR, 'README.md'),
      '# Test fixture\n\n'
      + 'A synthetic QuestLaw library, written by the shipped vault stack via\n'
      + '`tools/regen-fixture.js`. Every case in it is invented.\n\n'
      + '`recovery.txt` is the account key for THIS throwaway vault and opens nothing else.\n'
      + 'It is committed on purpose so `npm test` works with no checkout and no network.\n\n'
      + 'Regenerate after a vendor sync:\n\n'
      + '```sh\nnode tools/regen-fixture.js --repo <extension checkout>\n```\n');
    process.stdout.write(`fixture: wrote ${FIXTURE_DIR} from ${repo}\n`);
    process.stdout.write(`  library.qlvault ${Buffer.byteLength(exported)} bytes\n`);
  } finally {
    await library.destroy();
  }
}

main().catch(error => {
  process.stderr.write(`fixture: ${error.message}\n`);
  process.exit(1);
});
