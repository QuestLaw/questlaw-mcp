/**
 * The transport's scheduling. Requests are handled as they arrive, a slow one
 * doesn't hold up the rest, a cancelled one isn't answered, and progress is
 * reported only when asked for and only ever upward.
 *
 * It's driven through in-memory streams with tools whose timing the test
 * controls, so none of it depends on how long a real decrypt takes.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

const { createRpcServer } = require('../src/rpc');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** A server over in-memory pipes, with every message it writes collected. */
function harness(tools) {
  const input = new PassThrough();
  const output = new PassThrough();
  const received = [];
  const waiters = [];
  let buffer = '';
  output.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      received.push(message);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const rpc = createRpcServer({ tools, serverInfo: { name: 'probe', version: '0' } });
  const listening = rpc.listen({ input, output });
  const send = message => input.write(`${JSON.stringify(message)}\n`);

  /** Resolves once `predicate` holds over everything received so far. */
  async function until(predicate) {
    while (!predicate(received)) await new Promise(resolve => waiters.push(resolve));
  }
  async function close() {
    input.end();
    await listening;
  }
  return { send, received, until, close };
}

const call = (id, name, meta) => ({
  jsonrpc: '2.0', id, method: 'tools/call',
  params: { name, arguments: {}, ...(meta ? { _meta: meta } : {}) }
});

test('a slow tool call does not hold up a ping behind it', async () => {
  const gate = deferred();
  const server = harness([{
    name: 'slow', description: 'waits', inputSchema: { type: 'object' },
    async run() { await gate.promise; return { done: true }; }
  }]);

  server.send(call(1, 'slow'));
  server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  await server.until(received => received.some(message => message.id === 2));
  assert.deepEqual(server.received.map(message => message.id), [2],
    'the ping must be answered while the tool call is still waiting');

  gate.resolve();
  await server.close();
  assert.deepEqual(server.received.map(message => message.id), [2, 1]);
});

test('a cancelled request is never answered', async () => {
  const gate = deferred();
  const server = harness([{
    name: 'slow', description: 'waits', inputSchema: { type: 'object' },
    async run() { await gate.promise; return { done: true }; }
  }]);

  server.send(call('a', 'slow'));
  server.send(call(7, 'slow'));
  server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'a' } });
  // A cancellation for a number must not cancel the string of the same digits.
  server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '7' } });
  server.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  await server.until(received => received.some(message => message.id === 3));

  gate.resolve();
  await server.close();
  assert.deepEqual(server.received.map(message => message.id).sort(), [3, 7]);
});

test('progress goes out only with a token, and only upward', async () => {
  const tool = {
    name: 'reports', description: 'reports progress', inputSchema: { type: 'object' },
    async run(_args, context) {
      const report = context.onProgress || (() => {});
      for (const progress of [1, 2, 2, 1, 5]) report({ progress, total: 5, message: `step ${progress}` });
      return { done: true };
    }
  };
  const server = harness([tool]);
  server.send(call(1, 'reports', { progressToken: 'tok' }));
  server.send(call(2, 'reports'));
  await server.close();

  const progress = server.received.filter(message => message.method === 'notifications/progress');
  assert.deepEqual(progress.map(message => message.params.progress), [1, 2, 5]);
  assert.ok(progress.every(message => message.params.progressToken === 'tok'
    && message.params.total === 5));
  // Progress for a request precedes its answer.
  const answer = server.received.findIndex(message => message.id === 1);
  const lastProgress = server.received.lastIndexOf(progress[progress.length - 1]);
  assert.ok(lastProgress < answer);
});

test('input closing waits for work still in flight', async () => {
  const gate = deferred();
  const server = harness([{
    name: 'slow', description: 'waits', inputSchema: { type: 'object' },
    async run() { await gate.promise; return { done: true }; }
  }]);
  server.send(call(1, 'slow'));
  const closed = server.close();
  setImmediate(() => gate.resolve());
  await closed;
  assert.deepEqual(server.received.map(message => message.id), [1]);
});

const ping = id => ({ jsonrpc: '2.0', id, method: 'ping' });
const errorCode = message => message.error?.code;

/**
 * The edges of JSON-RPC 2.0 and MCP framing. A null id is a request MCP forbids,
 * not a notification, so silence would leave the client waiting forever.
 */
test('malformed requests are answered as Invalid Request, never ignored', async () => {
  const rpc = createRpcServer({ tools: [], serverInfo: { name: 'probe', version: '0' } });
  const replies = [];
  const send = message => replies.push(message);

  for (const bad of [
    { jsonrpc: '2.0', id: null, method: 'ping' },
    { jsonrpc: '2.0', id: { nested: 1 }, method: 'ping' },
    { jsonrpc: '2.0', id: true, method: 'ping' },
    { jsonrpc: '2.0', id: 7 },
    { jsonrpc: '2.0', id: 8, method: 42 }
  ]) {
    replies.length = 0;
    await rpc.handleLine(JSON.stringify(bad), send);
    assert.equal(replies.length, 1, JSON.stringify(bad));
    assert.equal(errorCode(replies[0]), -32600, JSON.stringify(bad));
  }
  // An id that was usable is echoed, so the client can pair the error.
  replies.length = 0;
  await rpc.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 42 }), send);
  assert.equal(replies[0].id, 8);

  replies.length = 0;
  await rpc.handleLine('[]', send);
  assert.deepEqual(replies.map(errorCode), [-32600], 'an empty batch is an error');

  // A real notification still gets nothing back.
  replies.length = 0;
  await rpc.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), send);
  assert.deepEqual(replies, []);
});

test('initialize is refused inside a batch, and the rest of the batch still runs', async () => {
  const rpc = createRpcServer({ tools: [], serverInfo: { name: 'probe', version: '0' } });
  const replies = [];
  await rpc.handleLine(JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    ping(2)
  ]), message => replies.push(message));
  const [batch] = replies;
  assert.equal(batch[0].id, 1);
  assert.equal(errorCode(batch[0]), -32600);
  assert.deepEqual(batch[1], { jsonrpc: '2.0', id: 2, result: {} });
});

test('tools are served without an initialize first, since some clients skip it', async () => {
  const probe = { name: 'probe', description: 'answers', inputSchema: { type: 'object' },
    run: async () => ({ ok: true }) };
  const server = harness([probe]);
  server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  server.send(call(2, 'probe'));
  await server.until(received => received.length === 2);
  const byId = new Map(server.received.map(message => [message.id, message]));
  assert.equal(byId.get(1).result.tools[0].name, 'probe');
  assert.equal(byId.get(2).result.isError, undefined);
  await server.close();
});
