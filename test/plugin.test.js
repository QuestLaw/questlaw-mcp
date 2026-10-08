/**
 * The Claude plugin archive. It's checked against the manifest schema's rules
 * instead of fetching the schema, because the suite runs without a network. The
 * assertions cover what the schema constrains plus two easy mistakes that stay
 * invisible until a user enables the plugin, a user_config reference that names
 * no declared option and an MCP entry point that isn't in the archive.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugin');
const read = file => JSON.parse(fs.readFileSync(path.join(PLUGIN, file), 'utf8'));

const manifest = read('.claude-plugin/plugin.json');
const mcp = read('.mcp.json');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('the manifest satisfies the required fields and naming rules', () => {
  assert.equal(typeof manifest.name, 'string');
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'name must be kebab-case');
  assert.equal(manifest.version, pkg.version, 'plugin and package versions must agree');
  assert.ok(manifest.description.length > 20);
  assert.equal(typeof manifest.author, 'object');
});

/**
 * Per the schema's own wording, a manifest `mcpServers` path is additive to the
 * root .mcp.json, not a replacement. Naming the same file in both places
 * registers the server twice.
 */
test('the manifest does not re-declare the auto-discovered .mcp.json', () => {
  assert.equal(manifest.mcpServers, undefined);
  assert.ok(fs.existsSync(path.join(PLUGIN, '.mcp.json')));
});

test('the MCP config points at a file the archive carries', () => {
  const server = mcp.mcpServers['questlaw-library'];
  assert.ok(server, '.mcp.json must define questlaw-library');
  assert.equal(server.command, 'node');
  assert.match(server.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\//,
    'the entry point must be plugin-root relative, not an absolute path');
  // A literal placeholder the plugin loader substitutes, not a template string.
  // eslint-disable-next-line no-template-curly-in-string
  const entry = server.args[0].replace('${CLAUDE_PLUGIN_ROOT}/runtime/', '');
  assert.match(server.args[0], /\/runtime\//, 'the npm payload belongs under runtime/');
  assert.ok(fs.existsSync(path.join(ROOT, entry)), `${entry} must exist`);
  assert.ok(pkg.files.some(f => entry === f || entry.startsWith(`${f}/`)),
    `${entry} must be covered by package.json files, or it will not ship`);
});

// Inspect the actual ZIP, including hidden files, not just the scaffold. Windows
// uses the official packer, and the repository's builders require system zip.
test('the built upload archive has no top-level bin and its declared server works', {
  skip: process.platform === 'win32' ? 'requires system zip and unzip' : false
}, async t => {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-plugin.js')], {
    cwd: ROOT, encoding: 'utf8'
  });
  const archive = path.join(ROOT, 'dist', `questlaw-mcp-claude-plugin-${pkg.version}.zip`);
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
    .trim().split('\n').map(entry => entry.replace(/^\.\//, ''));
  assert.ok(entries.includes('.claude-plugin/plugin.json'), 'manifest must be at the archive root');
  assert.ok(entries.includes('.mcp.json'), 'MCP config must be at the archive root');
  assert.ok(entries.includes('skills/questlaw-library/SKILL.md'));
  assert.ok(!entries.some(entry => entry === 'bin' || entry.startsWith('bin/')),
    'claude.ai rejects top-level bin/ even when its executable is also declared');
  assert.ok(!entries.some(entry => /(^|\/)(\.DS_Store|__MACOSX)(\/|$)/.test(entry)),
    'Finder metadata must not ship');

  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'questlaw-plugin-test-'));
  t.after(() => fs.rmSync(extracted, { recursive: true, force: true }));
  execFileSync('unzip', ['-q', archive, '-d', extracted]);
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(extracted, '.claude-plugin', 'plugin.json'), 'utf8')), manifest);
  const config = JSON.parse(fs.readFileSync(path.join(extracted, '.mcp.json'), 'utf8'));
  const server = config.mcpServers['questlaw-library'];
  // eslint-disable-next-line no-template-curly-in-string
  const args = server.args.map(arg => arg.replace('${CLAUDE_PLUGIN_ROOT}', extracted));
  assert.ok(fs.existsSync(args[0]), 'the declared entry point must ship');
  const verification = spawnSync(process.execPath, [...args, 'verify'], {
    cwd: extracted, encoding: 'utf8', timeout: 10000
  });
  assert.equal(verification.status, 0, verification.stderr);

  const { ensureFixture } = require('./helpers/vault-fixture');
  const { CONSENTED_ENV } = require('./helpers/consent');
  const fixture = await ensureFixture();
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'plugin-test', version: '1' }
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'library_overview', arguments: {}
    } }
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: extracted, encoding: 'utf8', timeout: 15000,
    input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
    env: { ...process.env, ...CONSENTED_ENV,
      QUESTLAW_VAULT_FILE: fixture.file,
      QUESTLAW_RECOVERY_CODE: fixture.recoveryCode,
      QUESTLAW_ALLOW_ENV_KEY: '1',
      QUESTLAW_KEY_ACCOUNT: 'questlaw-mcp-test-absent-account'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const responses = new Map(result.stdout.trim().split('\n')
    .map(line => JSON.parse(line)).map(message => [message.id, message]));
  assert.equal(responses.get(1).result.serverInfo.version, pkg.version);
  assert.deepEqual(responses.get(2).result.tools.map(tool => tool.name).sort(),
    JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'))
      .tools.map(tool => tool.name).sort());
  assert.equal(responses.get(3).result.isError, undefined);
  assert.equal(JSON.parse(responses.get(3).result.content[0].text).counts.cases, 4);
});

/**
 * The regression this file exists for. A ${user_config.*} reference in .mcp.json
 * stops the server from starting when the values were never collected, and the
 * desktop-app upload path installs and enables a plugin without running the
 * enable-time prompt. Nothing reports it. `claude plugin details` still counts
 * the MCP server, `claude mcp list` omits it, and --debug prints nothing, so the
 * session gets the skill, the skill talks about tools, and the tools aren't there.
 *
 * Proven by experiment: the identical server with the references removed
 * registers its tools immediately.
 *
 * Every value this server needs has a working default, so it takes none.
 */
test('the MCP config depends on no user_config value', () => {
  const serialized = JSON.stringify(mcp);
  assert.ok(!serialized.includes('user_config'),
    'a user_config reference silently disables the server on an uploaded install');
});

test('the manifest declares no userConfig', () => {
  assert.equal(manifest.userConfig, undefined,
    'nothing here needs prompting: the vault path, key account, and consent all have defaults');
});

test('the server starts with no environment beyond its defaults', () => {
  const server = mcp.mcpServers['questlaw-library'];
  for (const value of Object.values(server.env || {})) {
    assert.ok(!/\$\{/.test(value), `${value} is an unresolved substitution`);
  }
});

/**
 * Consent still gates everything, it just isn't collected by the plugin.
 * src/consent.js reads a file the `consent` command writes, so an uploaded install
 * that was never consented serves nothing and says why.
 */
test('the plugin does not bypass the disclosure gate', () => {
  const serialized = JSON.stringify(mcp);
  assert.ok(!serialized.includes('QUESTLAW_DISCLOSURE_ACK'),
    'the plugin must not grant consent on the user\'s behalf');
  const consent = fs.readFileSync(path.join(ROOT, 'src', 'consent.js'), 'utf8');
  assert.match(consent, /function requireConsent/, 'the gate must still exist');
});

test('the account key is never collected by the plugin', () => {
  const serialized = JSON.stringify(manifest);
  assert.ok(!/recovery_code|account_key|RECOVERY_CODE/i.test(serialized),
    'the key stays in the OS secret store; the plugin must not ask for or carry it');
  assert.ok(!/sensitive/.test(serialized),
    'no sensitive option is needed, because no secret passes through the plugin');
});

const SKILL = fs.readFileSync(
  path.join(PLUGIN, 'skills', 'questlaw-library', 'SKILL.md'), 'utf8');

test('the bundled skill declares itself and teaches the search rules', () => {
  assert.match(SKILL, /^---\n/, 'needs frontmatter');
  assert.match(SKILL, /\nname: questlaw-library\n/);
  assert.match(SKILL, /\ndescription: .{40,}/);
  // The three things a tool description has no room to say.
  assert.match(SKILL, /lexical|BM25/i, 'must say search is lexical');
  assert.match(SKILL, /matched/, 'must explain matched vs returned');
  assert.match(SKILL, /reload_snapshot/, 'must cover the stale-snapshot case');
});

/**
 * The drift behind the report this skill was rewritten against: a tool exists,
 * the skill never mentions it, and a model spends twenty calls doing by hand what
 * one call does. A tool nobody is told about may as well not ship.
 */
test('the skill names every tool the server serves', () => {
  require('./helpers/consent');
  const { createTools } = require('../src/tools');
  const served = createTools({
    require: () => { throw new Error('not loaded'); },
    status: () => ({ state: 'unavailable', error: null }),
    load: async () => {},
    ready: async () => {}
  }).map(tool => tool.name);

  for (const name of served) {
    assert.ok(SKILL.includes(name), `SKILL.md never mentions ${name}`);
  }
});

/**
 * What the report showed a model can't work out on its own. Each is a specific
 * wrong turn: brute-forcing keywords because nothing enumerates, never seeing the
 * unfiled records, stopping at page one, and reporting a working note as if the
 * case held it.
 */
test('the skill teaches the four things a tool description cannot', () => {
  assert.match(SKILL, /no required arguments|takes \*\*no required arguments\*\*/i,
    'must say the library can be listed without a query');
  assert.match(SKILL, /project: "none"/,
    'must say how to reach authorities filed under no project');
  assert.match(SKILL, /nextOffset/, 'must say how to know there is a next page');
  assert.match(SKILL, /summarySource/,
    'must say a summary is the user\'s words, and which field they are');
});
