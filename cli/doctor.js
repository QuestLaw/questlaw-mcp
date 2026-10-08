/**
 * Diagnoses an install, in the order the server does. Each check reports pass,
 * fail, or warn, with the command that fixes a fail. The exit code is the number
 * of failures, so it's usable in CI as well as by someone who can't work out why
 * their client shows no tools.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const checks = [];
const record = (name, state, detail, fix) => checks.push({ name, state, detail, fix });

function checkVendor() {
  try {
    const core = require('../src/core-modules');
    const { provenance } = core;
    record('vendored modules', 'pass',
      `4 verified, from ${provenance.repository} @ ${provenance.commit.slice(0, 8)} `
      + `(synced ${provenance.syncedAt})`);
    return core;
  } catch (error) {
    record('vendored modules', 'fail', `${error.code}: ${error.message}`,
      'Reinstall the package, or run: node tools/vendor-sync.js');
    return null;
  }
}

function checkConsent() {
  const { consentState } = require('../src/consent');
  const state = consentState();
  if (state.granted) {
    record('disclosure', 'pass',
      state.via === 'environment' ? 'accepted via environment' : `accepted ${state.at}`);
  } else {
    record('disclosure', 'fail', 'not accepted; the server will serve nothing',
      'questlaw-library-mcp consent');
  }
}

function checkCustody() {
  const { custodyStatus } = require('../src/credentials');
  let status;
  try {
    status = custodyStatus();
  } catch (error) {
    // An unusable account name is refused before any store is asked.
    record('account key', 'fail', `${error.code}: ${error.message}`, error.hint || '');
    return null;
  }
  if (status.source === 'environment') {
    const shadowed = status.storeHasKey
      ? ` It takes precedence over the key already in the ${status.store}.`
      : '';
    record('account key', 'warn',
      'taken from QUESTLAW_RECOVERY_CODE; whatever holds that variable holds a secret '
      + `that decrypts the whole library.${shadowed}`,
      'questlaw-library-mcp setup    (moves it into the OS secret store)');
  } else if (status.source === 'store') {
    record('account key', 'pass', `found in ${status.store} as "${status.account}"`);
  } else if (status.envKeyPresent) {
    record('account key', 'fail',
      'QUESTLAW_RECOVERY_CODE is set but ignored without QUESTLAW_ALLOW_ENV_KEY=1',
      'questlaw-library-mcp setup');
  } else {
    record('account key', 'fail', `nothing in ${status.store || 'any store'} for "${status.account}"`,
      'questlaw-library-mcp setup');
  }
  return status;
}

function checkVaultFile() {
  const { findVaultFile, DEFAULT_TARGET } = require('../src/snapshot');
  const target = process.env.QUESTLAW_VAULT_FILE || DEFAULT_TARGET;
  try {
    const file = findVaultFile(target);
    const stat = fs.statSync(file);
    const ageDays = (Date.now() - stat.mtimeMs) / 86400000;
    const detail = `${path.basename(file)}, ${(stat.size / 1048576).toFixed(2)} MiB, `
      + `exported ${ageDays < 1 ? 'today' : `${Math.floor(ageDays)} day${ageDays < 2 ? '' : 's'} ago`}`;
    if (ageDays > 14) {
      record('library export', 'warn', `${detail} -- the AI will answer from stale research`,
        'Export a fresh backup from the extension, or enable daily backup in its settings.');
    } else {
      record('library export', 'pass', detail);
    }
    return file;
  } catch (error) {
    record('library export', 'fail', `${error.code}: ${error.message}`,
      error.hint || 'Export a backup from the extension.');
    return null;
  }
}

async function checkDecrypt(file, custody) {
  if (!file) return;
  const { consentState } = require('../src/consent');
  if (!consentState().granted || !custody?.source) {
    record('decrypt', 'warn', 'skipped: consent or key is missing');
    return;
  }
  const { resolveVaultKey } = require('../src/credentials');
  const { readEncryptedLibrary } = require('../src/reader');
  const startedAt = Date.now();
  try {
    const result = await readEncryptedLibrary(file, resolveVaultKey());
    const counts = Object.entries(result.library)
      .filter(([, rows]) => rows.length)
      .map(([name, rows]) => `${rows.length} ${name}`)
      .join(', ');
    record('decrypt', 'pass',
      `${result.decrypted} records in ${Date.now() - startedAt}ms -- ${counts || 'library is empty'}`);
  } catch (error) {
    record('decrypt', 'fail', `${error.code}: ${error.message}`, error.hint || '');
  }
}

async function run() {
  process.stdout.write('questlaw-library-mcp doctor\n\n');
  checkVendor();
  checkConsent();
  const custody = checkCustody();
  const file = checkVaultFile();
  await checkDecrypt(file, custody);

  const mark = { pass: '  ok  ', warn: ' warn ', fail: ' FAIL ' };
  for (const check of checks) {
    process.stdout.write(`${mark[check.state]} ${check.name}: ${check.detail}\n`);
    if (check.fix && check.state !== 'pass') process.stdout.write(`        fix: ${check.fix}\n`);
  }

  const failures = checks.filter(check => check.state === 'fail').length;
  const warnings = checks.filter(check => check.state === 'warn').length;
  process.stdout.write(`\n${checks.length - failures - warnings} passed, `
    + `${warnings} warning${warnings === 1 ? '' : 's'}, ${failures} failing\n`);
  return failures;
}

module.exports = { run };