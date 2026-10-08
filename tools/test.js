#!/usr/bin/env node
/**
 * Runs every test/*.test.js under `node --test`, naming the files itself.
 *
 * `node --test test/*.test.js` relied on something expanding the pattern. npm
 * runs scripts through cmd.exe on Windows, which never does, and node --test only
 * expands patterns itself from Node 22, so on Windows with Node 20 the pattern
 * arrived literally and no test ran. Listing the files works on every shell and
 * every supported Node.
 *
 *   node tools/test.js [node --test options]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(ROOT, 'test'))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join('test', name));

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files],
  { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
