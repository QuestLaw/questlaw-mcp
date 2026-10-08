/**
 * Hashes the vendored modules against vendor/PROVENANCE.json.
 *
 * Kept apart from src/core-modules.js, which runs this check as it loads and
 * refuses to continue on a mismatch, so `verify` and `doctor` can use the same
 * check on an install that fails it and report what's wrong instead of exiting
 * on require. Nothing here runs at import.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LibraryError } = require('./errors');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'questlaw');
const PROVENANCE_FILE = path.join(__dirname, '..', 'vendor', 'PROVENANCE.json');

const MODULE_FILES = Object.freeze({
  Crypto: 'private-work-product-crypto.js',
  Protocol: 'private-vault-protocol-v2.js',
  Backup: 'private-vault-backup.js',
  Search: 'search.js'
});

function readProvenance(file = PROVENANCE_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new LibraryError('vendor_provenance_missing',
      'vendor/PROVENANCE.json is missing, so the vendored modules cannot be verified.',
      { hint: 'Reinstall the package.', cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new LibraryError('vendor_provenance_invalid', 'vendor/PROVENANCE.json is not readable JSON.',
      { hint: 'Reinstall the package.', cause: error });
  }
}

/**
 * One result per file, with its digest when it could be read. Inputs are
 * parameters so tests can run it against a scratch directory, because a test must
 * never mutate the shipped vendor/ while `node --test` runs other files in
 * parallel. The files checked are the ones the server loads, not whatever the
 * provenance happens to list, so a provenance entry that went missing fails
 * instead of quietly shrinking the check.
 *
 * @returns {{file: string, digest: string, problem: string}[]}
 */
function inspectVendorFiles({ vendorDir = VENDOR_DIR, provenance, files = Object.values(MODULE_FILES) }) {
  const recorded = Array.isArray(provenance?.files) ? provenance.files : [];
  const expected = new Map(recorded.map(entry => [entry?.file, entry]));
  return files.map(file => {
    const record = expected.get(file);
    if (!record) return { file, digest: '', problem: `${file}: no digest recorded` };
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(vendorDir, file));
    } catch (_) {
      return { file, digest: '', problem: `${file}: missing from vendor/questlaw/` };
    }
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const problem = digest === record.sha256 ? ''
      : `${file}: sha256 ${digest.slice(0, 12)} does not match the recorded ${String(record.sha256).slice(0, 12)}`;
    return { file, digest, problem };
  });
}

/** @returns {string[]} one sentence per problem, empty if verified */
function checkVendorFiles(options) {
  return inspectVendorFiles(options).map(result => result.problem).filter(Boolean);
}

/** Where the copies came from, with every field defaulted so a damaged file still reads. */
function describeProvenance(provenance) {
  return {
    repository: provenance?.upstream?.repository || 'the QuestLaw extension',
    commit: String(provenance?.upstream?.commit || ''),
    syncedAt: String(provenance?.syncedAt || '')
  };
}

module.exports = {
  VENDOR_DIR, PROVENANCE_FILE, MODULE_FILES, readProvenance, inspectVendorFiles, checkVendorFiles,
  describeProvenance
};
