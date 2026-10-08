/**
 * The wire, driven the way a client drives it: a real process, real stdio, real
 * newline-delimited JSON-RPC. Everything else in this suite calls functions, so
 * this is the only place that proves what an MCP client connects to works.
 */
'use strict';

// A loaded library needs disclosure consent, and test/consent.test.js covers refusing it.
require('./helpers/consent');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

const { ensureFixture } = require('./helpers/vault-fixture');

const BIN = path.join(__dirname, '..', 'bin', 'questlaw-library-mcp.js');

/** Feed `lines` to a fresh server and collect everything it writes back. */
function drive(lines, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const arrived = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
      // Responses go out as they finish, so a quick ping can overtake a tool call
      // still waiting on the decrypt. The id pairs a response with its request,
      // and notifications are kept apart in arrival order.
      const responses = arrived.filter(message => 'id' in message || Array.isArray(message));
      resolve({
        code,
        stderr,
        arrived,
        notifications: arrived.filter(message => !('id' in message) && !Array.isArray(message)),
        messages: responses.sort((left, right) => Number(left.id) - Number(right.id))
      });
    });
    child.stdin.end(lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  });
}

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const callTool = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });
const payload = message => JSON.parse(message.result.content[0].text);

let env;
test.before(async () => {
  const fixture = await ensureFixture();
  // Custody is the keychain by default and the environment path is opt-in, which
  // is exactly what a test fixture needs. The account is one no machine will have
  // an item for, so a developer with a real key stored gets the same result as CI.
  env = {
    QUESTLAW_VAULT_FILE: fixture.file,
    QUESTLAW_RECOVERY_CODE: fixture.recoveryCode,
    QUESTLAW_ALLOW_ENV_KEY: '1',
    QUESTLAW_KEY_ACCOUNT: 'questlaw-mcp-test-absent-account'
  };
});

test('the client handshake works end to end', async () => {
  const { code, messages, stderr } = await drive([
    request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1' }
    }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    request(2, 'tools/list'),
    callTool(3, 'library_overview'),
    request(4, 'ping')
  ], env);

  assert.equal(code, 0);
  // A notification gets no reply, so four requests must produce four messages.
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map(message => message.id), [1, 2, 3, 4]);

  assert.equal(messages[0].result.protocolVersion, '2024-11-05');
  assert.equal(messages[0].result.serverInfo.name, 'questlaw-library');
  assert.ok(messages[0].result.capabilities.tools);

  assert.equal(messages[1].result.tools.length, 10);
  assert.ok(messages[1].result.tools.every(tool => tool.name && tool.description && tool.inputSchema));
  // Nothing here writes or reaches the network, and a client that is told so can
  // stop asking the user to approve a read of their own library.
  assert.ok(messages[1].result.tools.every(tool =>
    tool.annotations.readOnlyHint === true
    && tool.annotations.destructiveHint === false
    && tool.annotations.openWorldHint === false
    && typeof tool.annotations.title === 'string'));

  assert.equal(payload(messages[2]).counts.cases, 4);
  assert.deepEqual(messages[3].result, {});
  assert.match(stderr, /15 records from library\.qlvault/);
});

test('a progress token on the first call reports the read as it happens', async () => {
  const { messages, notifications } = await drive([
    { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'library_overview', arguments: {}, _meta: { progressToken: 'load-1' } } }
  ], env);

  assert.equal(payload(messages[0]).counts.cases, 4);
  const progress = notifications.filter(message => message.method === 'notifications/progress');
  assert.ok(progress.length >= 2, 'expected progress through the read');
  assert.ok(progress.every(message => message.params.progressToken === 'load-1'));
  const values = progress.map(message => message.params.progress);
  assert.deepEqual(values, [...values].sort((left, right) => left - right));
  assert.equal(new Set(values).size, values.length, 'progress must rise with every notification');
  const last = progress[progress.length - 1].params;
  assert.equal(last.progress, last.total, 'the last step is the whole read');
});

test('tool results are compact JSON, measured the way the budget measures them', async () => {
  const { messages } = await drive([callTool(1, 'search_cases', { query: 'standing' })], env);
  const text = messages[0].result.content[0].text;
  assert.equal(text, JSON.stringify(JSON.parse(text)));
});

test('an unknown protocol version gets one we do support', async () => {
  const { messages } = await drive([
    request(1, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} }),
    request(2, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  ], env);
  assert.equal(messages[0].result.protocolVersion, '2025-06-18');
  assert.equal(messages[1].result.protocolVersion, '2025-06-18');
});

test('a failing tool answers as a result, not as a dead connection', async () => {
  const { code, messages } = await drive([
    callTool(1, 'get_case', { guid: 'nope' }),
    callTool(2, 'search_cases', { query: 'deference' })
  ], env);

  assert.equal(code, 0);
  assert.equal(messages[0].result.isError, true);
  const { error } = payload(messages[0]);
  assert.equal(error.code, 'case_not_found');
  assert.match(error.hint, /search_cases/);
  // The connection survives the failure: the next call still works.
  assert.equal(payload(messages[1]).matched, 2);
});

test('protocol-level mistakes come back as JSON-RPC errors', async () => {
  const { messages } = await drive([
    request(1, 'no/such/method'),
    callTool(2, 'no_such_tool'),
    request(3, 'tools/call', { name: 'search_cases', arguments: 'not-an-object' })
  ], env);

  assert.equal(messages[0].error.code, -32601);
  assert.equal(messages[1].error.code, -32601);
  assert.match(messages[1].error.message, /no_such_tool/);
  assert.equal(messages[2].error.code, -32600);
});

test('malformed input does not take the server down', async () => {
  const child = spawn(process.execPath, [BIN], { env: { ...process.env, ...env }, stdio: 'pipe' });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const closed = new Promise(resolve => child.on('close', resolve));
  child.stdin.write('this is not json\n');
  child.stdin.write('\n');
  child.stdin.end(`${JSON.stringify(request(9, 'ping'))}\n`);
  const code = await closed;

  const messages = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(code, 0);
  assert.equal(messages[0].error.code, -32700);
  assert.deepEqual(messages[1], { jsonrpc: '2.0', id: 9, result: {} });
});

/**
 * A client that never sends a newline must not grow the server's memory without
 * end. The over-long line is dropped as it arrives and answered once, and the
 * connection carries on. Bytes are decoded per line, so a character split across
 * two writes arrives whole.
 */
test('an over-long line is refused without ending the connection', async () => {
  const { LIMITS } = require('../src/limits');
  const child = spawn(process.execPath, [BIN], { env: { ...process.env, ...env }, stdio: 'pipe' });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const closed = new Promise(resolve => child.on('close', resolve));

  const block = Buffer.alloc(1024 * 1024, 0x61);
  for (let written = 0; written <= LIMITS.maxMessageBytes; written += block.length) {
    child.stdin.write(block);
  }
  child.stdin.write('\n');
  // A two-byte character split across two writes.
  const accented = Buffer.from(`${JSON.stringify(callTool(5, 'search_cases', { query: 'r\u00e9gime' }))}\n`);
  const split = accented.indexOf(0xc3) + 1;
  child.stdin.write(accented.subarray(0, split));
  child.stdin.end(Buffer.concat([accented.subarray(split), Buffer.from(`${JSON.stringify(request(6, 'ping'))}\r\n`)]));
  const code = await closed;

  const messages = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(code, 0);
  assert.equal(messages[0].id, null);
  assert.equal(messages[0].error.code, -32600);
  assert.match(messages[0].error.message, /larger than/);
  const byId = new Map(messages.map(message => [message.id, message]));
  assert.equal(payload(byId.get(5)).query, 'r\u00e9gime', 'the split character survived');
  assert.deepEqual(byId.get(6), { jsonrpc: '2.0', id: 6, result: {} }, 'a CRLF line still parses');
});

test('a batch is answered as a batch, without the notifications', async () => {
  const child = spawn(process.execPath, [BIN], { env: { ...process.env, ...env }, stdio: 'pipe' });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const closed = new Promise(resolve => child.on('close', resolve));
  child.stdin.end(`${JSON.stringify([
    request(1, 'ping'),
    { jsonrpc: '2.0', method: 'notifications/cancelled' },
    callTool(2, 'search_cases', { query: 'standing' })
  ])}\n`);
  await closed;

  const [batch] = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch.map(message => message.id), [1, 2]);
});

/**
 * The failure a user is most likely to cause. The server must stay up and say
 * what's wrong through the client, because that's the only place the user is
 * looking, and a process that exits at startup shows up as "server disconnected".
 */
test('a rejected recovery code leaves a server that can explain itself', async () => {
  const { code, messages, stderr } = await drive([
    callTool(1, 'library_overview'),
    callTool(2, 'reload_snapshot')
  ], { ...env, QUESTLAW_RECOVERY_CODE: 'A'.repeat(43) });

  assert.equal(code, 0);
  assert.match(stderr, /library unavailable: recovery_unwrap_failed/);
  for (const message of messages) {
    assert.equal(message.result.isError, true);
    assert.equal(payload(message).error.code, 'recovery_unwrap_failed');
    assert.match(payload(message).error.hint, /43 characters/);
  }
});

test('a missing export is reported, not crashed on', async () => {
  const { code, messages } = await drive(
    [callTool(1, 'library_overview')],
    { ...env, QUESTLAW_VAULT_FILE: '/nonexistent/questlaw' });

  assert.equal(code, 0);
  assert.equal(payload(messages[0]).error.code, 'vault_file_missing');
});

test('the handshake does not depend on the library being readable', async () => {
  const { messages } = await drive([
    request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
    request(2, 'tools/list'),
    callTool(3, 'library_overview')
  ], { ...env, QUESTLAW_VAULT_FILE: '/nonexistent/questlaw' });

  // A client can connect, list tools, and be told what is wrong, instead of
  // seeing a dead server.
  assert.equal(messages[0].result.serverInfo.name, 'questlaw-library');
  assert.equal(messages[1].result.tools.length, 10);
  assert.equal(payload(messages[2]).error.code, 'vault_file_missing');
});

/**
 * The default install has no key in its config. Without the opt-in the
 * environment is ignored, and the server says which command stores one.
 */
test('an environment key is ignored unless it is opted into', async () => {
  const { code, messages, stderr } = await drive([callTool(1, 'library_overview')],
    { ...env, QUESTLAW_ALLOW_ENV_KEY: '' });

  assert.equal(code, 0);
  const { error } = payload(messages[0]);
  assert.equal(error.code, 'account_key_unavailable');
  assert.match(error.hint, /questlaw-library-mcp setup/);
  assert.match(stderr, /account_key_unavailable/);
});
