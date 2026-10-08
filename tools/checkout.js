/**
 * Finds the QuestLaw extension checkout, for the maintainer tools that need one.
 *
 * Only tools/ uses this. The shipped server needs no checkout (that's what
 * vendor/ is for), and nothing under src/, cli/, or bin/ may require this.
 *
 * The checkout has to be named, with --repo or QUESTLAW_REPO. Callers go on to
 * require() code out of it, so it is never found by scanning sibling directories:
 * a scan would run whatever the first matching folder beside this one contains,
 * and on the maintainer's machine it matched a folder whose name gave no hint it
 * was the extension.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** The named checkout, or '' when nothing names one. */
function namedCheckout(explicit = '') {
  const named = explicit || process.env.QUESTLAW_REPO || '';
  return named ? path.resolve(named) : '';
}

/**
 * @param {string[]} required repo-relative paths that must all exist
 * @param {string} [explicit] a path from the command line, which wins over QUESTLAW_REPO
 */
function findCheckout(required, explicit = '') {
  const repo = namedCheckout(explicit);
  const missing = repo ? required.filter(relative => !fs.existsSync(path.join(repo, relative))) : [];
  if (repo && !missing.length) return repo;
  const error = new Error(repo
    ? `${repo} is not a QuestLaw extension checkout: it has no ${missing.join(', ')}.`
    : 'This needs a QuestLaw extension checkout. Pass --repo <path> or set QUESTLAW_REPO.');
  error.code = 'checkout_not_found';
  throw error;
}

/** The writer stack, for tools that need to produce a real .qlvault. */
function loadWriterStack(repo) {
  const { TextEncoder, TextDecoder } = require('util');
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
  if (typeof global.structuredClone === 'undefined') {
    global.structuredClone = value => JSON.parse(JSON.stringify(value));
  }
  let fake;
  try {
    fake = require(path.join(repo, 'node_modules/fake-indexeddb'));
  } catch (error) {
    throw new Error(`fake-indexeddb is not loadable from ${repo} (${error.message}). `
      + 'Run `npm ci` in the checkout: vaults are written by the shipped stack, not a stand-in.');
  }
  global.indexedDB = fake.indexedDB;
  global.IDBKeyRange = fake.IDBKeyRange;
  return require(path.join(repo, 'tests/helpers/encrypted-library'));
}

module.exports = { findCheckout, namedCheckout, loadWriterStack, PACKAGE_ROOT: ROOT };
