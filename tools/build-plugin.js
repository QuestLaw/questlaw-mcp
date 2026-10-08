#!/usr/bin/env node
/**
 * Packs a Claude plugin archive, the .zip that Settings -> Plugins -> Upload
 * local plugin accepts.
 *
 * This differs from the .mcpb. A .mcpb is a Claude Desktop MCP bundle, while a
 * plugin is a Claude Code / claude.ai workspace package that can carry skills
 * alongside its MCP server. Both wrap the same server from package.json's `files`
 * list. The plugin nests that package under runtime/ because a top-level bin/
 * exposes implicit PATH commands and is rejected by claude.ai and Cowork.
 *
 * The skill matters as much as the server. It teaches a model that search is
 * lexical, that quoted phrases are required, and that `matched` is the true
 * count, none of which a tool description has room to say.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_SRC = path.join(ROOT, 'plugin');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.join(ROOT, 'dist', `questlaw-mcp-claude-plugin-${pkg.version}.zip`);
const copyOptions = {
  recursive: true,
  filter: source => !['.DS_Store', '__MACOSX'].includes(path.basename(source))
};

function haveZip() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  if (!haveZip()) {
    process.stderr.write('plugin: the `zip` command is required.\n');
    process.exit(1);
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'questlaw-plugin-'));
  try {
    // The plugin scaffold: manifest, MCP config, skill.
    fs.cpSync(PLUGIN_SRC, staging, copyOptions);

    // Keep the npm layout intact under runtime/ so all relative requires work.
    // Its executable is declared in .mcp.json, never added to the plugin PATH.
    const runtime = path.join(staging, 'runtime');
    fs.mkdirSync(runtime);
    for (const entry of [...pkg.files, 'package.json']) {
      const source = path.join(ROOT, entry);
      if (!fs.existsSync(source)) continue;
      fs.cpSync(source, path.join(runtime, entry), copyOptions);
    }
    if (fs.existsSync(path.join(staging, 'bin'))) {
      throw new Error('top-level bin/ is forbidden in uploaded Claude plugins; declare executables in .mcp.json');
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(staging, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (manifest.version !== pkg.version) {
      throw new Error(`plugin.json says ${manifest.version}, package.json says ${pkg.version}`);
    }

    // Verify against what is staged, not the working tree.
    const mcp = JSON.parse(fs.readFileSync(path.join(staging, '.mcp.json'), 'utf8'));
    const server = mcp.mcpServers['questlaw-library'];
    // A literal placeholder the plugin loader substitutes, not a template string.
    // eslint-disable-next-line no-template-curly-in-string
    const entryPoint = server.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
    if (!fs.existsSync(path.join(staging, entryPoint))) {
      throw new Error(`the MCP entry point ${entryPoint} is not in the archive`);
    }
    for (const file of JSON.parse(
      fs.readFileSync(path.join(runtime, 'vendor', 'PROVENANCE.json'), 'utf8')
    ).files) {
      if (!fs.existsSync(path.join(runtime, 'vendor', 'questlaw', file.file))) {
        throw new Error(`vendored ${file.file} is not in the archive`);
      }
    }
    // Every user_config reference must name a declared option, or the server
    // starts with an unsubstituted literal in its environment.
    for (const value of Object.values(server.env || {})) {
      const match = /^\$\{user_config\.([a-z_]+)\}$/.exec(value);
      if (match && !manifest.userConfig?.[match[1]]) {
        throw new Error(`.mcp.json uses user_config.${match[1]}, which plugin.json does not declare`);
      }
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.rmSync(OUT, { force: true });
    execFileSync('zip', ['-q', '-r', '-X', OUT, '.'], { cwd: staging });

    process.stdout.write(`plugin: ${path.relative(ROOT, OUT)}  `
      + `${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB\n`);
    process.stdout.write('  Upload: Settings -> Plugins -> Upload local plugin\n');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`plugin: ${error.message}\n`);
  process.exit(1);
}
