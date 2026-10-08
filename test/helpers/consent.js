/**
 * Grants disclosure consent for a test file that needs a loaded library.
 *
 * It's required at the top of those files instead of set once for the whole run,
 * so a file that does NOT require it genuinely runs without consent, which keeps
 * test/consent.test.js from being vacuous.
 */
'use strict';

const { ENV_ACK, ENV_ACK_VALUE } = require('../../src/consent');

process.env[ENV_ACK] = ENV_ACK_VALUE;

/** Spread into the env of a child process that must also be consented. */
const CONSENTED_ENV = Object.freeze({ [ENV_ACK]: ENV_ACK_VALUE });

module.exports = { CONSENTED_ENV };
