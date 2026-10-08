/**
 * Reading the account key at a terminal. The prompt must show, and nothing typed
 * after it may reach the screen, since that is the key.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { askSecret } = require('../cli/prompt');

/** A terminal stand-in: input that claims to be a TTY, output that records everything. */
function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  let shown = '';
  const output = new PassThrough();
  output.on('data', chunk => { shown += chunk; });
  return { input, output, shown: () => shown };
}

test('a secret typed at a terminal is read but never echoed', async () => {
  const tty = terminal();
  // A letter that appears in neither the prompt nor readline's escape codes.
  const key = 'Q'.repeat(43);
  const answer = askSecret('Account key: ', tty);
  for (const ch of `${key}\r`) tty.input.write(ch);
  assert.equal(await answer, key);
  // readline positions the cursor with escape codes before drawing the prompt.
  assert.match(tty.shown(), /Account key: /, 'the prompt is shown');
  assert.ok(!tty.shown().includes('Q'), 'no typed character reaches the screen');
});

test('a piped secret is read whole, with nothing to hide', async () => {
  const input = new PassThrough();
  const answer = askSecret('ignored: ', { input, output: new PassThrough() });
  input.end(' piped-value \n');
  assert.equal(await answer, 'piped-value');
});
