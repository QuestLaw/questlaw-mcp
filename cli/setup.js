/**
 * Gets someone from "installed" to "working" in one pass. Order matters. The
 * disclosure comes before the key, because someone who declines should never have
 * been asked to hand over a secret. The decrypt smoke test comes before the
 * config snippet, because a snippet that can't work is worse than none, since the
 * failure would surface later inside a client with none of this context.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { askSecret, ask, confirm } = require('./prompt');
const { storeKey, KEY_PATTERN } = require('./keystore');
const consentCli = require('./consent');
const { consentState, DISCLOSURE } = require('../src/consent');
const { custodyStatus, account } = require('../src/credentials');
const { name: PACKAGE_NAME, version: PACKAGE_VERSION } = require('../package.json');

const out = text => process.stdout.write(text);

/**
 * Pinned to the version running this setup. An unpinned `npx -y` resolves
 * whatever the registry says is latest on every client start, so a compromised
 * or broken release would reach every install without anyone choosing it.
 */
const PACKAGE_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

function clientConfig(vaultTarget) {
  const env = {};
  if (vaultTarget) env.QUESTLAW_VAULT_FILE = vaultTarget;
  const acct = account();
  if (acct !== 'default') env.QUESTLAW_KEY_ACCOUNT = acct;
  return {
    mcpServers: {
      'questlaw-library': {
        command: 'npx',
        args: ['-y', PACKAGE_SPEC],
        ...(Object.keys(env).length ? { env } : {})
      }
    }
  };
}

function configLocations() {
  const home = os.homedir();
  const codex = path.join(home, '.codex', 'config.toml');
  if (process.platform === 'darwin') {
    return {
      'Claude Desktop': path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json'),
      'Claude Code': path.join(home, '.claude.json'),
      Codex: codex
    };
  }
  if (process.platform === 'win32') {
    return {
      'Claude Desktop': path.join(process.env.APPDATA || home, 'Claude', 'claude_desktop_config.json'),
      'Claude Code': path.join(home, '.claude.json'),
      Codex: codex
    };
  }
  return {
    'Claude Code': path.join(home, '.claude.json'),
    Codex: codex
  };
}

async function ensureConsent(args) {
  if (consentState().granted) {
    out('Disclosure: already accepted.\n\n');
    return true;
  }
  out(`\n${DISCLOSURE}\n\n`);
  const accepted = args.includes('--yes') || await confirm(
    'Do you want this connector to share the library above with your AI client?'
  );
  if (!accepted) {
    out('\nNot accepted. Nothing was stored and nothing will be read.\n');
    return false;
  }
  consentCli.record();
  out('\nDisclosure accepted.\n\n');
  return true;
}

async function ensureKey(args) {
  const status = custodyStatus();
  if (status.storeHasKey && !args.includes('--key')) {
    out(`Account key: already in the ${status.store} as "${status.account}".\n`
      + '  Replace it by re-running with --key.\n\n');
    return true;
  }
  out('Account key\n'
    + '  Your export is opened with a 43-character account key. Get yours from the\n'
    + '  extension: Settings -> Encrypted library -> Show account key.\n'
    + '  It is stored in your operating system\'s secret store, never in a config file.\n\n');
  const key = await askSecret('  Account key (input hidden): ');
  if (!key) {
    out('\nNo key entered. Nothing was stored.\n');
    return false;
  }
  if (!KEY_PATTERN.test(key)) {
    out(`\nThat is ${key.length} characters; an account key is 43. Nothing was stored.\n`);
    return false;
  }
  const label = storeKey(status.account, key);
  out(`\n  Stored in the ${label} as "${status.account}".\n\n`);
  return true;
}

async function ensureVault(args) {
  const { findVaultFile, DEFAULT_TARGET } = require('../src/snapshot');
  let target = process.env.QUESTLAW_VAULT_FILE || '';
  if (!target && !args.includes('--yes')) {
    out('Library export\n'
      + '  The extension writes questlaw-backup-<date>.qlvault when you export a backup,\n'
      + '  and daily on its own once backup is enabled in its settings.\n\n');
    target = await ask(`  Folder or file to read [${DEFAULT_TARGET}]: `);
  }
  target = target || DEFAULT_TARGET;
  try {
    const file = findVaultFile(target);
    const stat = fs.statSync(file);
    out(`  Found ${path.basename(file)} (${(stat.size / 1048576).toFixed(2)} MiB, `
      + `exported ${stat.mtime.toISOString().slice(0, 10)}).\n\n`);
    return target;
  } catch (error) {
    out(`  ${error.message}\n  ${error.hint || ''}\n\n`);
    return target;
  }
}

async function smokeTest(target) {
  const { resolveVaultKey } = require('../src/credentials');
  const { findVaultFile } = require('../src/snapshot');
  const { readEncryptedLibrary } = require('../src/reader');
  try {
    const startedAt = Date.now();
    const result = await readEncryptedLibrary(findVaultFile(target), resolveVaultKey());
    out(`Decrypt test: ${result.decrypted} records in ${Date.now() - startedAt}ms `
      + `(${result.library.cases.length} authorities, `
      + `${result.library.documentSections.length} captured sections).\n\n`);
    return true;
  } catch (error) {
    out(`Decrypt test FAILED: ${error.code}: ${error.message}\n`);
    if (error.hint) out(`  ${error.hint}\n`);
    out('\n');
    return false;
  }
}

async function run(args) {
  out('questlaw-library-mcp setup\n');
  if (!await ensureConsent(args)) return 1;
  if (!await ensureKey(args)) return 1;
  const target = await ensureVault(args);
  const ok = await smokeTest(target);

  out('Add this to your MCP client:\n\n');
  out(`${JSON.stringify(clientConfig(process.env.QUESTLAW_VAULT_FILE || target), null, 2)}\n\n`);
  for (const [client, file] of Object.entries(configLocations())) {
    out(`  ${client}: ${file}\n`);
  }
  out('\nOr in one command:\n'
    + `  claude mcp add questlaw-library -- npx -y ${PACKAGE_SPEC}\n`
    + `  codex mcp add questlaw-library -- npx -y ${PACKAGE_SPEC}\n`);
  out('\nRecheck any time with: questlaw-library-mcp doctor\n');
  return ok ? 0 : 1;
}

module.exports = { run, clientConfig, configLocations, PACKAGE_SPEC };