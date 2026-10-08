/**
 * The committed fixture vault. It's committed instead of generated so `npm test`
 * passes for anyone who installs this package, since an end user has no extension
 * checkout and no fake-indexeddb to write one with. The trade is that the vault
 * could drift from what the shipped writer produces today, which is why
 * tools/regen-fixture.js exists and why a vendor sync should be followed by a
 * regeneration.
 *
 * Everything in it is invented, and `recovery.txt` opens this throwaway vault
 * and nothing else.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');
const VAULT_FILE = path.join(FIXTURE_DIR, 'library.qlvault');

function missing() {
  throw new Error(
    `No fixture at ${VAULT_FILE}. It is committed with the package; if it is absent, `
    + 'rebuild it with: node tools/regen-fixture.js --repo <extension checkout>'
  );
}

function readFixture() {
  if (!fs.existsSync(VAULT_FILE)) missing();
  return {
    dir: FIXTURE_DIR,
    file: VAULT_FILE,
    recoveryCode: fs.readFileSync(path.join(FIXTURE_DIR, 'recovery.txt'), 'utf8').trim(),
    text: fs.readFileSync(VAULT_FILE, 'utf8'),
    portableExport: JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, 'portable-export.json'), 'utf8')
    )
  };
}

/** Async for the callers written against the old generating helper. */
async function ensureFixture() {
  return readFixture();
}

/** Write `text` to a scratch .qlvault the caller owns. */
function writeVariant(text, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `questlaw-${label}-`));
  const file = path.join(dir, 'library.qlvault');
  fs.writeFileSync(file, text);
  return file;
}

module.exports = { ensureFixture, readFixture, writeVariant, FIXTURE_DIR };
