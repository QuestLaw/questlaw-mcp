/**
 * questlaw-library-mcp: a read-only MCP server over a QuestLaw encrypted export.
 *
 * Configuration, all through the environment:
 *   QUESTLAW_VAULT_FILE        a .qlvault export, or a folder to take the newest from
 *   QUESTLAW_KEY_ACCOUNT       secret-store account holding the key (default "default")
 *   QUESTLAW_MAX_RESPONSE_BYTES  per-result byte budget (default 64 KiB)
 *
 * The key that opens the export comes from the OS secret store (see
 * src/credentials.js).
 *
 * Two kinds of failure are handled differently on purpose. A vendored module that
 * fails verification is a broken install, so the server exits, since no tool
 * call could succeed and nothing the user does in the client would help. A
 * missing export or rejected recovery code keeps the server up and answers every
 * tool with a structured error, because the user can fix those and needs to know
 * what to fix.
 */
'use strict';

const path = require('path');
const { createSnapshotStore } = require('./snapshot');
const { createTools, warmIndexes } = require('./tools');
const { createRpcServer } = require('./rpc');
const { resolveVaultKey } = require('./credentials');

const SERVER_INFO = Object.freeze({
  name: 'questlaw-library',
  version: require('../package.json').version
});

function logToStderr(message) {
  process.stderr.write(`questlaw-library-mcp: ${message}\n`);
}

function createServer({ log = logToStderr } = {}) {
  // The key is read by each load, after its consent check, never here: reading
  // it at startup asked the secret store for it before anyone had said yes. A
  // missing key is a runtime condition like a missing export, reported through
  // the tools with the command that fixes it, and picked up once it's stored.
  const store = createSnapshotStore({
    target: process.env.QUESTLAW_VAULT_FILE,
    resolveKey: resolveVaultKey,
    prepare: warmIndexes
  });
  const rpc = createRpcServer({ tools: createTools(store), serverInfo: SERVER_INFO, log });
  return { store, rpc };
}

async function main() {
  const { store, rpc } = createServer();
  // The read runs alongside the handshake, not in front of it, and the first tool
  // call is what waits. See createSnapshotStore().start().
  store.start().then(() => {
    const status = store.status();
    if (status.state === 'loaded') {
      const snapshot = store.require();
      logToStderr(`${snapshot.decrypted} records from ${path.basename(snapshot.sourceFile)} `
        + `in ${snapshot.readMs}ms`);
      return;
    }
    // Serve anyway. The tools report this in the client, where the user will see it.
    logToStderr(`library unavailable: ${status.error.code} - ${status.error.message}`);
    if (status.error.hint) logToStderr(status.error.hint);
  }).catch(error => logToStderr(`startup log failed: ${error.message}`));
  await rpc.listen();
}

module.exports = { createServer, main, SERVER_INFO };
