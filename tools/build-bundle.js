#!/usr/bin/env node
/**
 * Packs a .mcpb bundle, the one-click install for Claude Desktop. An .mcpb is a
 * zip of the package plus manifest.json, and only what package.json declares in
 * `files` goes in, so the fixture vault, tests, and tooling stay out of an install.
 *
 * It uses the system `zip` because adding a zip library to a package that claims
 * to have no dependencies would be a poor trade for one build step.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.join(ROOT, 'dist', `questlaw-mcp-claude-desktop-${pkg.version}.mcpb`);

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
    process.stderr.write('bundle: the `zip` command is required.\n'
      + '  macOS and most Linux ship it. On Windows, use the official packer:\n'
      + '    npx @anthropic-ai/mcpb pack\n');
    process.exit(1);
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'questlaw-mcpb-'));
  try {
    for (const entry of [...pkg.files, 'package.json']) {
      const source = path.join(ROOT, entry);
      if (!fs.existsSync(source)) continue;
      const target = path.join(staging, entry);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true });
    }

    // Verify what will ship, not the working tree.
    const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
    if (manifest.version !== pkg.version) {
      throw new Error(`manifest.json says ${manifest.version}, package.json says ${pkg.version}`);
    }
    const entryPoint = path.join(staging, manifest.server.entry_point);
    if (!fs.existsSync(entryPoint)) {
      throw new Error(`entry_point ${manifest.server.entry_point} is not in the bundle`);
    }
    for (const file of JSON.parse(
      fs.readFileSync(path.join(staging, 'vendor', 'PROVENANCE.json'), 'utf8')
    ).files) {
      if (!fs.existsSync(path.join(staging, 'vendor', 'questlaw', file.file))) {
        throw new Error(`vendored ${file.file} is not in the bundle`);
      }
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.rmSync(OUT, { force: true });
    execFileSync('zip', ['-q', '-r', '-X', OUT, '.'], { cwd: staging });

    const bytes = fs.statSync(OUT).size;
    process.stdout.write(`bundle: ${path.relative(ROOT, OUT)}  ${(bytes / 1024).toFixed(0)} KiB\n`);
    process.stdout.write('  Install: open it with Claude Desktop, or drag it onto the app.\n');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`bundle: ${error.message}\n`);
  process.exit(1);
}
