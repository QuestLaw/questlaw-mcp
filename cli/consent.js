/**
 * Shows the disclosure and records the answer. This is the writing half of
 * src/consent.js. It lives here because the server is structurally read-only, and
 * test/module-graph.test.js enforces that by scanning src/ and bin/ for write
 * calls.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  DISCLOSURE, DISCLOSURE_REVISION, ENV_ACK, ENV_ACK_VALUE, configDir, consentFile, consentState
} = require('../src/consent');
const { confirm } = require('./prompt');

/**
 * Records an acceptance. Declining writes nothing, and withdrawing deletes the
 * file, so `accepted` is only ever true here.
 */
function record() {
  const file = consentFile();
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const entry = { accepted: true, revision: DISCLOSURE_REVISION, at: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  return file;
}

async function run(args) {
  const state = consentState();

  if (args.includes('--revoke')) {
    try {
      fs.unlinkSync(consentFile());
      process.stdout.write('Disclosure consent revoked. The server will serve nothing until it is accepted again.\n');
    } catch (_) {
      process.stdout.write('No recorded consent to revoke.\n');
    }
    if (state.via === 'environment') {
      process.stdout.write(`Note: ${ENV_ACK} is set in this environment and still grants consent on its own.\n`);
    }
    return 0;
  }

  if (args.includes('--status')) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return state.granted ? 0 : 1;
  }

  process.stdout.write(`\n${DISCLOSURE}\n\n`);

  if (state.granted && state.via === 'environment') {
    process.stdout.write(`${ENV_ACK}=${ENV_ACK_VALUE} is set, so consent is already granted `
      + 'by this environment.\n');
    return 0;
  }
  if (state.granted) {
    process.stdout.write(`Already accepted on ${state.at}.\nUse --revoke to withdraw it.\n`);
    return 0;
  }

  const accepted = args.includes('--accept') || await confirm(
    'Do you want this connector to share the library above with your AI client?'
  );
  if (!accepted) {
    process.stdout.write('\nNot accepted. Nothing will be read or shared.\n');
    return 1;
  }
  const file = record();
  // Show an absolute path unless the file is inside the working directory.
  const relative = path.relative(process.cwd(), file);
  const shown = relative && !relative.startsWith('..') ? relative : file;
  process.stdout.write(`\nAccepted, recorded in ${shown}.\n`
    + 'Revoke at any time with: questlaw-library-mcp consent --revoke\n');
  return 0;
}

module.exports = { run, record };