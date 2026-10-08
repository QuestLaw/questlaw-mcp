/**
 * The four QuestLaw modules this package reads through, loaded from vendor/.
 *
 * They're vendored instead of required from a checkout because a real install
 * has no checkout. Someone running `npx questlaw-library-mcp` has this package
 * and nothing else. The QuestLaw extension is still the only owner, so these
 * copies are byte-for-byte and never edited. tools/vendor-sync.js refreshes them,
 * and `--check` fails CI when upstream moves.
 *
 * Every file is hashed before it's required, and a mismatch is fatal, with no
 * degraded mode. The digests ship in the same package as the files, so this
 * catches drift and corruption (a bad sync, a truncated install, an edit made
 * here by mistake), not a deliberate tamper: whoever can change a file in the
 * package can change its digest too. Proof of origin comes from outside the
 * package, from the release attestations and npm provenance (SECURITY.md). The
 * check takes about a millisecond.
 */
'use strict';

const path = require('path');
const { LibraryError } = require('./errors');
const {
  VENDOR_DIR, MODULE_FILES, readProvenance, checkVendorFiles, describeProvenance
} = require('./vendor-check');

/** The load-time gate: verify the shipped vendor directory or refuse to run. */
function verifyVendor() {
  const provenance = readProvenance();
  const problems = checkVendorFiles({ provenance });

  if (problems.length) {
    throw new LibraryError(
      'vendor_integrity_failed',
      `The vendored QuestLaw modules failed verification: ${problems.join('; ')}.`,
      {
        hint: 'These four files are the whole decryption chain, so a mismatch is not run '
          + 'past. Reinstall the package from a trusted source.',
        detail: problems.join('; ')
      }
    );
  }
  return provenance;
}

const provenance = verifyVendor();

const core = Object.freeze({
  VENDOR_DIR,
  MODULE_FILES,
  provenance: Object.freeze({
    ...describeProvenance(provenance),
    files: Object.freeze((provenance.files || []).map(entry => Object.freeze({ ...entry })))
  }),
  checkVendorFiles,
  Crypto: require(path.join(VENDOR_DIR, MODULE_FILES.Crypto)),
  Protocol: require(path.join(VENDOR_DIR, MODULE_FILES.Protocol)),
  Backup: require(path.join(VENDOR_DIR, MODULE_FILES.Backup)),
  Search: require(path.join(VENDOR_DIR, MODULE_FILES.Search))
});

module.exports = core;
