/**
 * The vendored copies are the whole decryption chain, so they get their own tests
 * instead of being trusted because they were copied once.
 *
 * Three claims: the recorded digests match the files that ship, the loader
 * refuses a file that doesn't match, and (when a checkout is named) the copies
 * are still byte-identical to upstream.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { checkVendorFiles, MODULE_FILES } = require('../src/core-modules');

const FILES = Object.values(MODULE_FILES);

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(PACKAGE_ROOT, 'vendor', 'questlaw');
const PROVENANCE = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, 'vendor', 'PROVENANCE.json'), 'utf8')
);

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

test('every vendored file matches its recorded digest', () => {
  assert.ok(PROVENANCE.files.length >= 4, 'provenance must cover every vendored module');
  for (const entry of PROVENANCE.files) {
    const bytes = fs.readFileSync(path.join(VENDOR_DIR, entry.file));
    assert.equal(sha256(bytes), entry.sha256, `${entry.file} digest`);
    assert.equal(bytes.length, entry.bytes, `${entry.file} size`);
  }
});

test('provenance names where each file came from and at what commit', () => {
  assert.match(PROVENANCE.upstream.commit, /^[0-9a-f]{40}$/);
  assert.equal(PROVENANCE.upstream.dirtyAtSync, false,
    'vendoring from a dirty checkout records a commit that does not describe the bytes');
  for (const entry of PROVENANCE.files) {
    assert.match(entry.source, /^src\/core\/[a-z0-9-]+\.js$/);
  }
});

/**
 * The gate is exercised against a scratch directory instead of tampering with the
 * shipped vendor/, because test files run in parallel and mutating a module
 * another test is loading is a race, not a test.
 *
 * checkVendorFiles is the same function core-modules.js calls at load, so
 * covering it covers the gate.
 */
function scratchVendor(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'questlaw-vendor-'));
  for (const entry of PROVENANCE.files) {
    fs.copyFileSync(path.join(VENDOR_DIR, entry.file), path.join(dir, entry.file));
  }
  mutate(dir);
  return dir;
}

test('a tampered vendored file is rejected', () => {
  const dir = scratchVendor(target =>
    fs.appendFileSync(path.join(target, 'search.js'), '\n// tampered\n'));
  try {
    const problems = checkVendorFiles({
      vendorDir: dir, provenance: PROVENANCE, files: FILES
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^search\.js: sha256 .* does not match the recorded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a vendored file that went missing is reported, not skipped', () => {
  const dir = scratchVendor(target => fs.unlinkSync(path.join(target, 'search.js')));
  try {
    const problems = checkVendorFiles({
      vendorDir: dir, provenance: PROVENANCE, files: FILES
    });
    assert.deepEqual(problems, ['search.js: missing from vendor/questlaw/']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file with no recorded digest is rejected rather than trusted', () => {
  const problems = checkVendorFiles({
    vendorDir: VENDOR_DIR,
    provenance: { files: PROVENANCE.files.filter(entry => entry.file !== 'search.js') },
    files: FILES
  });
  assert.deepEqual(problems, ['search.js: no digest recorded']);
});

test('the shipped vendor directory verifies clean', () => {
  assert.deepEqual(
    checkVendorFiles({ vendorDir: VENDOR_DIR, provenance: PROVENANCE, files: FILES }),
    []
  );
});

/**
 * Drift, checked only where a checkout is named with QUESTLAW_REPO. On an end
 * user's machine there is none and this skips, and a maintainer who names one
 * catches a vendored copy left behind by an upstream change. The checkout is
 * never searched for, the same rule tools/checkout.js follows.
 */
test('the vendored copies still match upstream', t => {
  const repo = process.env.QUESTLAW_REPO ? path.resolve(process.env.QUESTLAW_REPO) : '';
  if (!repo) return t.skip('no QuestLaw extension checkout named in QUESTLAW_REPO');
  assert.ok(fs.existsSync(path.join(repo, 'src/core/search.js')),
    `QUESTLAW_REPO=${repo} is not a QuestLaw extension checkout`);

  const drift = PROVENANCE.files.filter(entry =>
    sha256(fs.readFileSync(path.join(repo, entry.source))) !== entry.sha256);
  assert.deepEqual(drift.map(entry => entry.file), [],
    'upstream moved; run: npm run vendor:sync');
});
