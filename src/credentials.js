/**
 * Where the vault-opening secret comes from.
 *
 * An export's vault key is wrapped with the user's 43-character account key, which
 * the extension shows under Settings, Encrypted library. Nobody types it from
 * memory, so `setup` asks for it once and keeps it in the operating system's
 * secret store.
 *
 * Every store is read through a frozen argv literal, with the account name as its
 * own argv entry and never interpolated into a command string, so a hostile
 * account name is an argument and not a command. test/module-graph.test.js pins
 * that shape. The name is also validated, because Windows joins it into a file
 * path, and argv separation does nothing for a name like "..\..\x".
 *
 * The environment fallback is for machines without a secret store, and it's off
 * unless QUESTLAW_ALLOW_ENV_KEY=1. That keeps the default install from putting a
 * library-opening secret into an MCP client's config file, which is the most
 * likely way it would leak.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { LibraryError } = require('./errors');

const SERVICE = 'questlaw-library-mcp';
const ENV_KEY = 'QUESTLAW_RECOVERY_CODE';
const ENV_OPT_IN = 'QUESTLAW_ALLOW_ENV_KEY';

/**
 * Absolute paths where the location is fixed, so a directory earlier on PATH can't
 * stand in for the secret store and be handed the account name or, on the write
 * side, the key itself. secret-tool has no fixed home across Linux distributions,
 * so it's still found on PATH.
 */
const SECURITY_BIN = '/usr/bin/security';
const POWERSHELL_BIN = path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * One entry per platform. `argv` is a function only so the account name gets its
 * own slot, and nothing here builds a string for a shell to parse.
 *
 * Windows reads a DPAPI blob written by `questlaw-library-mcp setup`. The
 * PowerShell body is a frozen literal and the account arrives through the child's
 * environment, so the script text never varies with input. There's no
 * -ExecutionPolicy flag, since execution policy governs script files and a
 * -Command string isn't one.
 */
const PROVIDERS = Object.freeze({
  darwin: Object.freeze({
    label: 'login keychain',
    command: SECURITY_BIN,
    argv: account => ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
    env: null,
    store: account =>
      `security add-generic-password -s ${SERVICE} -a ${account} -U -w`
  }),
  linux: Object.freeze({
    label: 'libsecret keyring',
    command: 'secret-tool',
    argv: account => ['lookup', 'service', SERVICE, 'account', account],
    env: null,
    store: account =>
      `secret-tool store --label='QuestLaw library key' service ${SERVICE} account ${account}`
  }),
  win32: Object.freeze({
    label: 'DPAPI credential file',
    command: POWERSHELL_BIN,
    argv: () => ['-NoProfile', '-NonInteractive', '-Command',
      // Frozen literal that reads $env:QUESTLAW_KEY_ACCOUNT and interpolates nothing.
      '$ErrorActionPreference = "Stop";'
      + '$p = Join-Path $env:APPDATA ("questlaw-library-mcp\\" + $env:QUESTLAW_KEY_ACCOUNT + ".dpapi");'
      + 'if (-not (Test-Path $p)) { exit 1 };'
      + '$b = [Convert]::FromBase64String((Get-Content -Raw $p).Trim());'
      + '$u = [System.Security.Cryptography.ProtectedData]::Unprotect('
      + '$b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);'
      + '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($u))'],
    env: account => ({ QUESTLAW_KEY_ACCOUNT: account }),
    // setup stores under QUESTLAW_KEY_ACCOUNT, so a bare command would file the
    // key under "default" for anyone using another account.
    store: account => (account === 'default'
      ? 'questlaw-library-mcp setup --key'
      : `questlaw-library-mcp setup --key, with QUESTLAW_KEY_ACCOUNT set to ${account}`)
  })
});

/**
 * Letters, digits, dot, underscore, and hyphen. That's enough for "default",
 * "work", or "client.2024", and leaves no separator, drive letter, or quote to
 * steer the Windows file path. A name made only of dots is still a path step.
 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** @throws {LibraryError} unless `name` is safe as both a store account and a file name */
function checkAccount(name) {
  const value = String(name);
  if (ACCOUNT_PATTERN.test(value) && !/^\.+$/.test(value)) return value;
  throw new LibraryError('invalid_key_account',
    `The secret-store account ${JSON.stringify(value.slice(0, 80))} can't be used.`, {
      hint: 'Set QUESTLAW_KEY_ACCOUNT to 1-64 letters, digits, dots, underscores, or '
        + 'hyphens, or unset it to use "default".'
    });
}

function account() {
  return checkAccount(String(process.env.QUESTLAW_KEY_ACCOUNT || 'default').trim() || 'default');
}

function provider() {
  return PROVIDERS[process.platform] || null;
}

/**
 * Returns '' when there's no stored secret. That's an ordinary state (the user
 * hasn't run setup yet), so the caller reports it with the command that fixes it
 * instead of this throwing.
 */
function readSecretStore(name, impl = provider()) {
  if (!impl) return '';
  try {
    return execFileSync(impl.command, impl.argv(name), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: impl.env ? { ...process.env, ...impl.env(name) } : process.env,
      timeout: 15000,
      windowsHide: true
    }).trim();
  } catch (_error) {
    return '';
  }
}

function envKey() {
  return String(process.env[ENV_KEY] || '').trim();
}

/**
 * @returns {string} the 43-character account key
 * @throws {LibraryError} when no custody path has one
 */
function resolveVaultKey() {
  const name = account();

  // The opt-in wins over the secret store. It's set deliberately to open some
  // other vault (a fixture, a second library), which would be impossible on a
  // machine with a stored key if the store were checked first.
  if (process.env[ENV_OPT_IN] === '1') {
    const override = envKey();
    if (override) return override;
  }

  const impl = provider();
  if (impl) {
    const stored = readSecretStore(name, impl);
    if (stored) return stored;
    throw new LibraryError(
      'account_key_unavailable',
      `No QuestLaw account key in the ${impl.label} for ${SERVICE}/${name}.`,
      { hint: `Run: questlaw-library-mcp setup    (or store it directly: ${impl.store(name)})` }
    );
  }

  // An unrecognised platform has no store, so the environment is the only path and needs no opt-in.
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  throw new LibraryError(
    'account_key_unavailable',
    `${ENV_KEY} is not set, and there is no secret store for platform ${process.platform}.`,
    {
      hint: `Set ${ENV_KEY}, and treat wherever you set it as holding a secret that decrypts `
        + 'the whole library.'
    }
  );
}

/** What `doctor` reports without revealing the secret itself. */
function custodyStatus() {
  const name = account();
  const impl = provider();
  const envPresent = Boolean(envKey());
  const envAllowed = process.env[ENV_OPT_IN] === '1';
  const stored = impl ? Boolean(readSecretStore(name, impl)) : false;
  const envWins = envPresent && (envAllowed || !impl);
  // resolveVaultKey() checks the opt-in first, so when both exist the environment
  // wins. Reporting the store would send someone chasing the wrong key.
  const source = envWins ? 'environment' : (stored ? 'store' : null);
  return {
    account: name,
    platform: process.platform,
    store: impl ? impl.label : null,
    storeHasKey: stored,
    envKeyPresent: envPresent,
    envKeyHonoured: envWins,
    source,
    storeCommand: impl ? impl.store(name) : null
  };
}

module.exports = {
  resolveVaultKey,
  readSecretStore,
  custodyStatus,
  provider,
  PROVIDERS,
  SERVICE,
  ENV_KEY,
  ENV_OPT_IN,
  account,
  checkAccount
};
