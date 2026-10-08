/**
 * Writes the account key into the platform secret store. The read side lives in
 * src/credentials.js. This is the only place that writes key material, it runs
 * from the CLI with the user present, and the key reaches every store through
 * stdin or the child's environment, never through argv or a shell string.
 */
'use strict';

const { execFileSync } = require('child_process');
const { SERVICE, provider, checkAccount } = require('../src/credentials');

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function assertKey(key) {
  if (!KEY_PATTERN.test(key)) {
    throw new Error('That is not a QuestLaw account key: expected 43 base64url characters, '
      + `got ${key.length}.`);
  }
}

/**
 * Windows stores a DPAPI blob under %APPDATA%. The PowerShell body is a frozen
 * literal so the account and the key arrive through the child's environment.
 */
const WINDOWS_STORE_SCRIPT = '$ErrorActionPreference = "Stop";'
  + '$dir = Join-Path $env:APPDATA "questlaw-library-mcp";'
  + 'New-Item -ItemType Directory -Force -Path $dir | Out-Null;'
  + '$p = Join-Path $dir ($env:QUESTLAW_KEY_ACCOUNT + ".dpapi");'
  + '$b = [System.Text.Encoding]::UTF8.GetBytes($env:QUESTLAW_KEY_VALUE);'
  + '$e = [System.Security.Cryptography.ProtectedData]::Protect('
  + '$b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);'
  + 'Set-Content -Path $p -Value ([Convert]::ToBase64String($e)) -NoNewline';

/**
 * Every command comes from the read side's table, so the two sides can't disagree
 * about which binary they trust. The account is checked here as well as on read,
 * because the Windows write joins it into the path it creates.
 */
function storeKey(account, key) {
  assertKey(key);
  checkAccount(account);
  const impl = provider();
  if (!impl) {
    throw new Error(`No secret store is implemented for platform ${process.platform}. `
      + 'Set QUESTLAW_RECOVERY_CODE and QUESTLAW_ALLOW_ENV_KEY=1 instead, and treat that '
      + 'environment as holding a secret that decrypts the whole library.');
  }

  if (process.platform === 'darwin') {
    // `-w <value>` would put the key in this machine's process list while the call
    // runs. `-w` with no value prompts on the tty and asks twice, so the key is
    // piped twice and never reaches argv.
    execFileSync(impl.command, ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w'],
      { input: `${key}\n${key}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
    return impl.label;
  }

  if (process.platform === 'linux') {
    execFileSync(impl.command,
      ['store', '--label=QuestLaw library key', 'service', SERVICE, 'account', account],
      { input: key, stdio: ['pipe', 'ignore', 'pipe'] });
    return impl.label;
  }

  execFileSync(impl.command, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_STORE_SCRIPT], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: { ...process.env, QUESTLAW_KEY_ACCOUNT: account, QUESTLAW_KEY_VALUE: key }
  });
  return impl.label;
}

module.exports = { storeKey, assertKey, KEY_PATTERN, WINDOWS_STORE_SCRIPT };
