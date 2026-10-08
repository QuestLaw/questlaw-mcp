/**
 * The disclosure gate. This server hands the decrypted contents of a legal
 * research library to an AI client, and that client uploads what it reads to its
 * provider. The .qlvault carries more than the ordinary JSON export, since
 * portableCollections() filters captured opinion bodies out of the export and the
 * encrypted one keeps them, so "you already export this" isn't an accurate thing
 * to assume on the user's behalf.
 *
 * So nothing is served until someone says yes once, and the yes is recorded where
 * it can be shown back to them. There are two ways to give it, matching the two
 * ways to install:
 *
 *   - `questlaw-library-mcp consent --accept` writes a file, for the manual
 *     install where there's a terminal to read the disclosure in.
 *   - QUESTLAW_DISCLOSURE_ACK=i-understand, which the bundle's required
 *     configuration field sets when the user types those words. The client shows
 *     the disclosure in its own UI. The field is a typed string rather than a
 *     boolean because MCPB doesn't define how a boolean reaches the environment,
 *     or whether an unticked required box counts as answered, and any value other
 *     than the exact phrase fails closed.
 *
 * This module only reads. The CLI writes, and the write-path test keeps that
 * boundary honest.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LibraryError } = require('./errors');

const ENV_ACK = 'QUESTLAW_DISCLOSURE_ACK';
const ENV_ACK_VALUE = 'i-understand';

/** Current disclosure text. Bumping this revision re-asks. */
const DISCLOSURE_REVISION = 1;

const DISCLOSURE = [
  'This connector decrypts your QuestLaw library and hands its contents to the AI',
  'client you attach it to. That client sends what it reads to its provider.',
  '',
  'What becomes readable:',
  '  - every saved authority, with your notes and analysis',
  '  - every saved quotation, with its pincite',
  '  - your projects, matters, tags, and workspace sections',
  '  - the full captured text of statutes, regulations, rules, and opinions',
  '',
  'The encrypted export carries more than QuestLaw\'s ordinary JSON export does:',
  'captured opinion bodies are filtered out of that export and kept in this one.',
  '',
  'QuestLaw\'s privacy commitments cover QuestLaw. They do not extend to the AI',
  'client, its provider, or anything either does with what you send. If your',
  'library holds client confidences, that is the decision in front of you.',
  '',
  'This connector is read-only and never writes to your library.'
].join('\n');

function configDir() {
  const override = String(process.env.QUESTLAW_CONFIG_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.questlaw-library-mcp');
}

function consentFile() {
  return path.join(configDir(), 'consent.json');
}

/** @returns {{granted: boolean, via: string, at: string, revision: number}} */
function consentState() {
  if (String(process.env[ENV_ACK] || '').trim() === ENV_ACK_VALUE) {
    return { granted: true, via: 'environment', at: '', revision: DISCLOSURE_REVISION };
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(consentFile(), 'utf8'));
  } catch (_) {
    return { granted: false, via: '', at: '', revision: 0 };
  }
  // An older revision isn't consent to the current text.
  if (record?.accepted !== true || record.revision !== DISCLOSURE_REVISION) {
    return {
      granted: false, via: 'file', at: String(record?.at || ''), revision: Number(record?.revision) || 0
    };
  }
  return { granted: true, via: 'file', at: String(record.at || ''), revision: record.revision };
}

/** @throws {LibraryError} when consent has not been given */
function requireConsent() {
  const state = consentState();
  if (state.granted) return state;
  throw new LibraryError('disclosure_not_accepted',
    'This connector has not been authorised to share your library with an AI client. '
      + 'Nothing has been read or sent.', {
      hint: 'Run `questlaw-library-mcp consent` to read the disclosure and accept it, '
        + `or set ${ENV_ACK}=${ENV_ACK_VALUE} if your client collected that agreement already.`,
      detail: state.revision && state.revision !== DISCLOSURE_REVISION
        ? `accepted revision ${state.revision}, current is ${DISCLOSURE_REVISION}`
        : ''
    });
}

module.exports = {
  DISCLOSURE, DISCLOSURE_REVISION, ENV_ACK, ENV_ACK_VALUE, configDir, consentFile, consentState,
  requireConsent
};
