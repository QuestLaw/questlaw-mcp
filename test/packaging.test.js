/**
 * What ships, and whether the three manifests agree. package.json, server.json,
 * and manifest.json each carry a version and a name, and the registry rejects a
 * mismatch at publish time, after the npm package is already out. Catching it
 * here means a failed test instead of a published version that can't be registered.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

const pkg = read('package.json');
const server = read('server.json');
const manifest = read('manifest.json');

test('all three manifests carry the same version', () => {
  assert.equal(server.version, pkg.version, 'server.json version');
  assert.equal(manifest.version, pkg.version, 'manifest.json version');
  const npmPackage = server.packages.find(entry => entry.registryType === 'npm');
  assert.equal(npmPackage.version, pkg.version, 'server.json npm package version');
  assert.equal(npmPackage.identifier, pkg.name, 'server.json npm identifier');
});

/**
 * The repository moved once already, and every manifest carried its own copy of
 * the URL and license. One source of truth, package.json, and every other copy
 * has to agree with it.
 */
test('every manifest names the same license and repository', () => {
  const plugin = read('plugin/.claude-plugin/plugin.json');
  const repo = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  assert.match(repo, /^https:\/\/github\.com\/[^/]+\/[^/]+$/, 'package.json repository.url');

  assert.equal(pkg.license, 'GPL-3.0-or-later');
  assert.equal(manifest.license, pkg.license, 'manifest.json license');
  assert.equal(plugin.license, pkg.license, 'plugin.json license');

  assert.equal(server.repository.url, repo, 'server.json repository.url');
  assert.equal(plugin.repository, repo, 'plugin.json repository');
  assert.equal(pkg.bugs.url, `${repo}/issues`, 'package.json bugs.url');
  assert.equal(manifest.support, `${repo}/issues`, 'manifest.json support');
  assert.equal(manifest.documentation, `${repo}#readme`, 'manifest.json documentation');
  // The registry only lets a GitHub namespace publish for its own owner.
  const owner = repo.split('/')[3];
  assert.ok(server.name.startsWith(`io.github.${owner}/`), 'server.json name namespace');
});

test('the registry name matches the mcpName the registry verifies against', () => {
  // The registry reads mcpName from the published npm package and refuses the
  // publish if it differs from server.json's name.
  assert.equal(pkg.mcpName, server.name);
  assert.match(server.name, /^[a-z0-9.-]+\/[a-z0-9-]+$/);
});

test('the bundle entry point is a file the bundle actually contains', () => {
  const entry = manifest.server.entry_point;
  assert.ok(fs.existsSync(path.join(ROOT, entry)), `${entry} must exist`);
  const shipped = pkg.files.some(pattern => entry === pattern || entry.startsWith(`${pattern}/`));
  assert.ok(shipped, `${entry} must be covered by package.json files`);
});

test('every runtime directory the server requires is shipped', () => {
  // A published package that omits vendor/ installs cleanly and then refuses to
  // start, because the integrity gate finds nothing to verify.
  for (const required of ['bin', 'cli', 'src', 'vendor']) {
    assert.ok(pkg.files.includes(required), `package.json files must include ${required}`);
  }
});

test('nothing carrying library data or key material is shipped', () => {
  for (const pattern of pkg.files) {
    assert.ok(!pattern.startsWith('test'), 'test fixtures must not ship');
    assert.ok(!pattern.includes('fixture'), 'fixtures must not ship');
  }
});

test('the bundle declares the disclosure as required configuration', () => {
  const ack = manifest.user_config.disclosure_ack;
  assert.ok(ack, 'manifest must collect the disclosure acknowledgement');
  assert.equal(ack.required, true, 'the disclosure must be required, not optional');
  assert.match(manifest.server.mcp_config.env.QUESTLAW_DISCLOSURE_ACK,
    /\$\{user_config\.disclosure_ack\}/);
  // The text must say where the data goes, not just that it is shared.
  assert.match(ack.description, /Anthropic|provider/i);
});

test('the Desktop vault picker uses a supported home-directory default', () => {
  // DOWNLOADS is supported in mcp_config but not in user_config defaults.
  // eslint-disable-next-line no-template-curly-in-string
  assert.equal(manifest.user_config.vault_location.default, '${HOME}/Downloads');
});

test('the documented tools are the tools the server serves', () => {
  require('./helpers/consent');
  const { createTools } = require('../src/tools');
  const served = createTools({
    require: () => { throw new Error('not loaded'); },
    status: () => ({ state: 'unavailable', error: null }),
    load: async () => {},
    ready: async () => {}
  }).map(tool => tool.name).sort();
  assert.deepEqual(manifest.tools.map(tool => tool.name).sort(), served);
});

/**
 * Installing the package installs nothing else, which is the whole claim. eslint
 * is the one development dependency, for contributors who lint, and nothing a
 * development install puts in the tree may reach the published package.
 */
test('the package declares no runtime dependencies, and nothing dev-only ships', () => {
  assert.deepEqual(pkg.dependencies, {});
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies), ['eslint'],
    'a new devDependency is a decision; add it here deliberately');
  for (const devOnly of ['node_modules', 'tools', 'test', 'eslint.config.js', 'package-lock.json']) {
    assert.ok(!pkg.files.some(pattern => pattern === devOnly || pattern.startsWith(`${devOnly}/`)),
      `${devOnly} must not ship`);
  }
});

/**
 * `npx -y questlaw-mcp` with no version runs whatever the registry calls
 * latest, on every client start. Every install snippet names the version it was
 * written for, so a bad release reaches nobody who didn't choose it, and a version
 * bump that forgets the docs fails here.
 */
test('every install command is pinned to this version', () => {
  const spec = `${pkg.name}@${pkg.version}`;
  const { clientConfig, PACKAGE_SPEC } = require('../cli/setup');
  assert.equal(PACKAGE_SPEC, spec);
  assert.deepEqual(clientConfig('').mcpServers['questlaw-library'].args, ['-y', spec]);

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const mentions = [...readme.matchAll(new RegExp(`${pkg.name}(@[\\w.-]+)?(?=["\\s])`, 'g'))]
    .filter(match => /npx|"-y"/.test(readme.slice(Math.max(0, match.index - 12), match.index)));
  assert.ok(mentions.length >= 5, 'README carries the npx install snippets');
  for (const match of mentions) assert.equal(match[0], spec, `README: ${match[0]}`);
});

test('publishing is gated on the checks passing', () => {
  assert.match(pkg.scripts.prepublishOnly, /npm run check/);
  assert.match(pkg.scripts.check, /verify/);
  assert.match(pkg.scripts.check, /vendor:check/);
  assert.match(pkg.scripts.check, /test/);
});
