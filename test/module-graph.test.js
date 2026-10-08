/**
 * Structural proof of the two claims made to a user: this process can't reach the
 * network and can't write to the library. Both are checked, not just stated. The
 * graph is recorded by hooking Module._load while the server is required, so it
 * reflects what the server actually loads and not what its imports appear to say.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// This package sits inside the checkout it reads from, so its own files are under
// REPO too. Only what it borrows from outside the package matters.
const PACKAGE_ROOT = path.resolve(__dirname, '..');

const NETWORK_BUILTINS = ['http', 'https', 'http2', 'net', 'tls', 'dns', 'dgram', 'inspector'];

/**
 * Frozen. Adding a builtin here is deliberate, and a prompt to ask what new
 * capability the process just gained.
 *
 * child_process was added with keychain custody. src/credentials.js shells out to
 * `security` to read the account key, it's the only execFileSync in src/, its
 * argv is a fixed literal, and the test below pins that.
 */
// readline left when src/rpc.js began splitting lines itself, to cap their length.
const ALLOWED_BUILTINS = ['child_process', 'crypto', 'fs', 'os', 'path'];

/**
 * A module already in require.cache doesn't re-execute, so its own requires never
 * reach the hook. Anything loaded before recording would silently shrink the
 * graph and weaken every assertion below, so the cache is emptied of this package
 * and the checkout first.
 */
function purgeCache() {
  for (const file of Object.keys(require.cache)) {
    if (file.startsWith(`${PACKAGE_ROOT}${path.sep}`) || file.includes(`${path.sep}src${path.sep}core${path.sep}`)) {
      delete require.cache[file];
    }
  }
}

function recordGraph(entry) {
  purgeCache();
  const builtins = new Set();
  const files = new Set();
  const original = Module._load;
  Module._load = function hooked(request, parent, isMain) {
    const bare = String(request).replace(/^node:/, '');
    if (Module.builtinModules.includes(bare)) {
      builtins.add(bare);
    } else {
      try {
        files.add(Module._resolveFilename(request, parent, isMain));
      } catch (_) {
        files.add(String(request));
      }
    }
    return original.apply(this, arguments);
  };
  try {
    require(entry);
  } finally {
    Module._load = original;
  }
  return { builtins: [...builtins].sort(), files: [...files].sort() };
}

const graph = recordGraph('../src/server.js');
const { VENDOR_DIR, MODULE_FILES } = require('../src/core-modules');

test('no network module is anywhere in the graph', () => {
  assert.deepEqual(graph.builtins.filter(name => NETWORK_BUILTINS.includes(name)), []);
});

test('the builtin surface is exactly what was signed off', () => {
  assert.deepEqual(graph.builtins, ALLOWED_BUILTINS);
});

test('no third-party package is loaded', () => {
  assert.deepEqual(graph.files.filter(file => file.includes('node_modules')), []);
});

/**
 * Vendoring makes this absolute. Once the four modules live inside the package,
 * nothing the server loads should come from elsewhere, and a file outside this
 * directory means the package reached into a checkout, a global install, or
 * something worse.
 */
test('the server loads nothing from outside this package', () => {
  const outside = graph.files.filter(file => !file.startsWith(`${PACKAGE_ROOT}${path.sep}`));
  assert.deepEqual(outside, []);
});

test('exactly the four vendored modules are loaded, and nothing else is vendored', () => {
  const loaded = graph.files
    .filter(file => file.startsWith(`${VENDOR_DIR}${path.sep}`))
    .map(file => path.basename(file))
    .sort();
  assert.deepEqual(loaded, Object.values(MODULE_FILES).slice().sort());

  // A fifth file in vendor/ would ship without being verified at load, because
  // the integrity gate only walks MODULE_FILES.
  const present = fs.readdirSync(VENDOR_DIR).filter(name => name.endsWith('.js')).sort();
  assert.deepEqual(present, Object.values(MODULE_FILES).slice().sort());
});

test('nothing from the extension stateful layers is reachable', () => {
  const stateful = graph.files
    .filter(file => file.includes(`${path.sep}src${path.sep}lib${path.sep}`)
      || file.includes(`${path.sep}src${path.sep}background${path.sep}`));
  assert.deepEqual(stateful, []);
});

/**
 * Read-only is structural. No code path in this process opens the vault, or
 * anything else, for writing. Tests and dev tools write fixtures, so only the
 * shipped source is scanned.
 */
test('the shipped source contains no filesystem write call', () => {
  const writeApi = /\b(writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync|unlink|unlinkSync|rmSync|rmdirSync|mkdirSync|mkdtempSync|copyFileSync|renameSync|truncate|open)\s*\(/;
  const offenders = [];
  for (const dir of ['src', 'bin']) {
    for (const name of fs.readdirSync(path.join(__dirname, '..', dir))) {
      if (!name.endsWith('.js')) continue;
      const file = path.join(dir, name);
      const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      if (writeApi.test(source)) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * The one subprocess in the shipped server, and the shape of every command it can
 * run. A secret store is read by shelling out, so an injection would live here if
 * there were one.
 */
test('the only subprocess is a fixed-argv secret-store read', () => {
  const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'credentials.js'), 'utf8');
  const calls = [...source.matchAll(/exec(?:File)?(?:Sync)?\s*\(/g)];
  assert.equal(calls.length, 1, 'src/ must contain exactly one subprocess call');
  assert.match(source, /execFileSync\(impl\.command, impl\.argv\(name\)/);
  assert.ok(!/\bexec\s*\(|\bexecSync\s*\(|\bspawn\s*\(/.test(source),
    'no shell-interpreting spawn');

  for (const name of fs.readdirSync(path.join(PACKAGE_ROOT, 'src'))) {
    if (name === 'credentials.js' || !name.endsWith('.js')) continue;
    const other = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', name), 'utf8');
    assert.ok(!/child_process/.test(other), `${name} must not reach child_process`);
  }
});

/**
 * The account name is the only caller-controlled value that reaches a command
 * line. On every platform it must arrive as its own argv entry, so a name that
 * tries to be a flag, a quote, or a second command stays one opaque string.
 * Windows matters most, because its argv carries a PowerShell script. The account
 * goes through the child's environment instead, and the script body must not vary
 * with it.
 */
test('a hostile account name stays one argument on every platform', () => {
  const { PROVIDERS } = require('../src/credentials');
  const hostile = '"; Remove-Item C:\\ -Recurse; #';

  for (const [platform, impl] of Object.entries(PROVIDERS)) {
    assert.equal(typeof impl.command, 'string', `${platform}: command must be a literal`);
    assert.ok(!/[\s;|&$`]/.test(impl.command), `${platform}: command must be one path, no shell syntax`);

    const argv = impl.argv(hostile);
    assert.ok(Array.isArray(argv), `${platform}: argv must be an array`);
    for (const entry of argv) assert.equal(typeof entry, 'string');

    const carriers = argv.filter(entry => entry.includes(hostile));
    if (platform === 'win32') {
      // The script is frozen, so the name must not appear in argv at all.
      assert.deepEqual(carriers, [], 'win32 must not interpolate the account into argv');
      assert.deepEqual(impl.env(hostile), { QUESTLAW_KEY_ACCOUNT: hostile });
    } else {
      assert.equal(carriers.length, 1, `${platform}: exactly one argv entry carries the name`);
      assert.equal(carriers[0], hostile, `${platform}: the name is the whole entry, unconcatenated`);
    }
  }
});

/**
 * The frozen script text on Windows. Pinned because the argv's safety rests
 * entirely on this body never being built from input.
 */
test('the Windows script body is constant across account names', () => {
  const { PROVIDERS } = require('../src/credentials');
  const a = PROVIDERS.win32.argv('alice');
  const b = PROVIDERS.win32.argv('"; whoami; #');
  assert.deepEqual(a, b);
});

/**
 * Where a store's binary has one fixed home, it's called by that path, so a
 * directory placed earlier on PATH can't impersonate it. secret-tool has no fixed
 * home across distributions and stays a bare name. -ExecutionPolicy only governs
 * script files, so on a -Command call it would be a flag that does nothing while
 * reading like a bypass.
 */
test('secret-store binaries are absolute where their home is fixed', () => {
  const { PROVIDERS } = require('../src/credentials');
  assert.equal(PROVIDERS.darwin.command, '/usr/bin/security');
  assert.match(PROVIDERS.win32.command,
    /^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(PROVIDERS.linux.command, 'secret-tool');

  assert.ok(!PROVIDERS.win32.argv('x').some(entry => /ExecutionPolicy/i.test(entry)));
  const keystore = fs.readFileSync(path.join(PACKAGE_ROOT, 'cli', 'keystore.js'), 'utf8');
  assert.ok(!/ExecutionPolicy/i.test(keystore), 'the write side passes no execution policy either');
  // The write side takes its binary from the read side's table, never a bare name.
  assert.equal((keystore.match(/execFileSync\(impl\.command,/g) || []).length, 3);
  assert.ok(!/execFileSync\('/.test(keystore), 'no literal command on the write side');
});

/**
 * Source hygiene. A raw control character in a source file is invisible in a
 * diff, makes grep and git treat the file as binary, and doesn't survive every
 * editor. A sentinel that needs one is built with String.fromCharCode at runtime
 * instead (see SEGMENT_BREAK in src/tokenize.js). This caught a real regression
 * while that sentinel was being added.
 *
 * Checked by code point so this file doesn't itself contain the escapes it bans.
 */
function firstControlCharacter(source) {
  for (let position = 0; position < source.length; position += 1) {
    const code = source.charCodeAt(position);
    // Tab, newline, and carriage return are ordinary whitespace.
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return code;
  }
  return -1;
}

test('no shipped source file contains a raw control character', () => {
  const offenders = [];
  for (const dir of ['src', 'bin', 'cli', 'tools', 'test']) {
    const base = path.join(PACKAGE_ROOT, dir);
    for (const name of fs.readdirSync(base)) {
      if (!name.endsWith('.js')) continue;
      const code = firstControlCharacter(fs.readFileSync(path.join(base, name), 'utf8'));
      if (code >= 0) offenders.push(`${dir}/${name}: code point ${code}`);
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * The ranked index is the one part of the server that holds a second copy of the
 * library in memory, so it must not reach for anything new to do it.
 */
test('search adds no capability to the graph', () => {
  const searchGraph = recordGraph('../src/search-index.js');
  assert.deepEqual(searchGraph.builtins.filter(name => NETWORK_BUILTINS.includes(name)), []);
  assert.deepEqual(searchGraph.files.filter(file => file.includes('node_modules')), []);
  assert.deepEqual(
    searchGraph.files.filter(file => !file.startsWith(`${PACKAGE_ROOT}${path.sep}`)), []);
});
