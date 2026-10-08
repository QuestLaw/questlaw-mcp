/** Terminal input helpers. Only the CLI uses these, and the server never prompts. */
'use strict';

const readline = require('readline');
const { Writable } = require('stream');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

/**
 * Passes writes through to `target` until muted. readline echoes every keystroke
 * to its output, so muting the output after the prompt is drawn hides the typing
 * without reaching into readline's private methods.
 */
function mutableOutput(target) {
  let muted = false;
  const stream = new Writable({
    write(chunk, encoding, done) {
      if (!muted) target.write(chunk, encoding);
      done();
    }
  });
  stream.mute = () => { muted = true; };
  stream.unmute = () => { muted = false; };
  return stream;
}

/**
 * Read a secret without echoing it. Piped input has no echo to hide, so it's read
 * whole, which is how `echo $KEY | questlaw-library-mcp setup` works.
 */
function askSecret(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      input.setEncoding('utf8');
      input.on('data', chunk => { buffer += chunk; });
      input.on('end', () => resolve(buffer.trim()));
      input.on('error', reject);
    });
  }
  return new Promise(resolve => {
    const muted = mutableOutput(output);
    const rl = readline.createInterface({ input, output: muted, terminal: true });
    // Raw mode swallows Ctrl-C, so honour it here instead of leaving the prompt stuck.
    rl.on('SIGINT', () => {
      rl.close();
      output.write('\n');
      process.exit(130);
    });
    rl.question(question, answer => {
      muted.unmute();
      rl.close();
      output.write('\n');
      resolve(answer.trim());
    });
    // The prompt was written synchronously by question(), so everything after it is typing.
    muted.mute();
  });
}

async function confirm(question) {
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

module.exports = { ask, askSecret, confirm };
