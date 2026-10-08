#!/usr/bin/env node

/**
 * Entry point. No arguments means serve, because that's how an MCP client
 * launches it, and the subcommands are for the person installing.
 *
 * This file routes and never writes. The read-only claim in
 * test/module-graph.test.js covers src/ and bin/, and the commands that do write
 * live in cli/.
 */
'use strict';

const USAGE = `questlaw-library-mcp - read-only MCP access to a QuestLaw vault

  questlaw-library-mcp              serve over stdio
  questlaw-library-mcp setup        disclosure, key custody, and client config
  questlaw-library-mcp doctor       diagnose an install
  questlaw-library-mcp consent      read the disclosure; --accept, --revoke, --status
  questlaw-library-mcp verify       check the vendored modules against their digests
  questlaw-library-mcp --version

Environment:
  QUESTLAW_VAULT_FILE          a .qlvault export, or a folder to take the newest from
                               (default ~/Downloads)
  QUESTLAW_KEY_ACCOUNT         secret-store account holding the key (default "default")
  QUESTLAW_MAX_RESPONSE_BYTES  per-result byte budget (default 65536)
  QUESTLAW_DISCLOSURE_ACK      set to "i-understand" to grant consent from the environment
  QUESTLAW_ALLOW_ENV_KEY       set to "1" to let QUESTLAW_RECOVERY_CODE supply the key
`;

async function dispatch(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case 'serve':
      return require('../src/server').main().then(() => 0);
    case 'setup':
      return require('../cli/setup').run(rest);
    case 'doctor':
      return require('../cli/doctor').run(rest);
    case 'consent':
      return require('../cli/consent').run(rest);
    case 'verify':
      return require('../cli/verify').run(rest);
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case '-v':
    case '--version':
      process.stdout.write(`${require('../package.json').version}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

dispatch(process.argv.slice(2)).then(code => {
  // Serving only resolves when the client disconnects.
  process.exitCode = code || 0;
}).catch(error => {
  process.stderr.write(`questlaw-library-mcp: ${error?.message || error}\n`);
  if (error?.hint) process.stderr.write(`  ${error.hint}\n`);
  process.exit(1);
});