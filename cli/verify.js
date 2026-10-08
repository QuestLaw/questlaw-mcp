/**
 * Checks the integrity of the vendored modules on demand. `doctor` covers this
 * too, but `verify` answers one question with an exit code and no environment,
 * which is what a CI step or a suspicious user wants: are the four files that
 * decrypt my library intact?
 *
 * It runs the same check src/core-modules.js runs at load, through
 * src/vendor-check.js, which unlike core-modules doesn't refuse to load on a
 * mismatch, so a failing install gets a report instead of a crash. The digests
 * ship with the files, so this catches corruption and drift; SECURITY.md covers
 * proving where the package came from.
 */
'use strict';

const { readProvenance, inspectVendorFiles, describeProvenance } = require('../src/vendor-check');

async function run(args) {
  let provenance;
  try {
    provenance = readProvenance();
  } catch (error) {
    process.stderr.write(`verify: ${error.message}\n  ${error.hint}\n`);
    return 1;
  }

  const results = inspectVendorFiles({ provenance });
  for (const { file, digest, problem } of results) {
    process.stdout.write(problem ? ` FAIL  ${problem}\n` : `  ok   ${file}  ${digest.slice(0, 16)}\n`);
  }
  const failures = results.filter(result => result.problem).length;

  const origin = describeProvenance(provenance);
  process.stdout.write(`\nvendored from ${origin.repository} @ ${origin.commit || 'unknown commit'}\n`
    + `synced ${origin.syncedAt || 'on an unknown date'}\n`);
  if (failures) {
    process.stderr.write(`\n${failures} file(s) do not match. Do not run this install; `
      + 'reinstall from a trusted source.\n');
  }
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ failures, provenance }, null, 2)}\n`);
  }
  return failures;
}

module.exports = { run };
