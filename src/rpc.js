/**
 * MCP over stdio: newline-delimited JSON-RPC 2.0.
 *
 * This is hand-rolled instead of using the SDK. The transport is about thirty
 * lines of framing, and the package's main claim is that it has no dependencies
 * and no network, which every added package weakens.
 *
 * stdout carries protocol traffic only. Anything a human reads goes to stderr,
 * which MCP clients show in their logs.
 */
'use strict';

const { asLibraryError } = require('./errors');
const { LIMITS } = require('./limits');

// Tools-only servers behave the same across these. Echo the client's version if
// we know it, otherwise answer with our newest.
const SUPPORTED_PROTOCOLS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;
const INTERNAL_ERROR = -32603;

/** Ids can be strings or numbers, and 1 and "1" are different requests. */
function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.rpcCode = code;
  }
}

function createRpcServer({ tools, serverInfo, log = () => {} }) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));

  async function dispatch(method, params, context = {}) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion)
            ? params.protocolVersion
            : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo
        };
      case 'tools/list':
        return {
          // Every tool only reads one decrypted snapshot, so each says so. A client
          // that knows a call can't change anything or reach the network can skip
          // asking permission for it.
          tools: tools.map(({ name, title, description, inputSchema }) => ({
            name,
            ...(title ? { title } : {}),
            description,
            inputSchema,
            annotations: {
              ...(title ? { title } : {}),
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false
            }
          }))
        };
      case 'tools/call':
        return callTool(params, context);
      case 'ping':
        return {};
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async function callTool(params, context = {}) {
    const tool = byName.get(params?.name);
    if (!tool) throw new RpcError(METHOD_NOT_FOUND, `Unknown tool: ${params?.name}`);
    const args = params?.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) {
      throw new RpcError(INVALID_REQUEST, 'Tool arguments must be an object.');
    }
    try {
      const value = await tool.run(args, { onProgress: context.onProgress });
      // Compact, because the byte budget in src/limits.js is measured compact.
      // Indenting put a full page about a fifth over the ceiling and cost tokens for nothing.
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      // A tool failure is data for the model to reason about, not a broken
      // connection, so it comes back as a result with isError.
      const structured = asLibraryError(error);
      log(`tool ${tool.name} failed: ${structured.code} ${structured.message}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: structured.toJSON() }) }],
        isError: true
      };
    }
  }

  /**
   * Requests still being worked on, by id. A notifications/cancelled naming one
   * marks it, and a cancelled request is never answered, since the specification
   * says not to respond once the sender no longer wants the result.
   */
  const pending = new Map();

  function handleNotification(request) {
    if (request.method === 'notifications/cancelled') {
      const entry = pending.get(requestKey(request.params?.requestId));
      if (entry) entry.cancelled = true;
    }
  }

  /**
   * Progress for one request, when the caller sent a progressToken. The
   * specification requires the value to rise with every notification, so anything
   * that doesn't is dropped here instead of trusting every producer.
   */
  function progressReporter(request, notify) {
    const token = request.params?._meta?.progressToken;
    if (token === undefined || token === null || !notify) return undefined;
    let last = -Infinity;
    return ({ progress, total, message }) => {
      if (!Number.isFinite(progress) || progress <= last) return;
      last = progress;
      notify({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress,
          ...(Number.isFinite(total) ? { total } : {}),
          ...(message ? { message } : {})
        }
      });
    };
  }

  const invalidRequest = (message, id = null) =>
    ({ jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message } });

  /** The error for a message that has an id but can't be run, or null when it can. */
  function malformed(request, inBatch) {
    // MCP forbids a null id, and answering with null would pair the reply with nothing.
    if (typeof request.id !== 'string' && typeof request.id !== 'number') {
      return invalidRequest('Request id must be a string or a number.');
    }
    if (typeof request.method !== 'string') {
      return invalidRequest('Request method must be a string.', request.id);
    }
    // The specification puts initialize outside any batch, since everything
    // else in the batch would race the handshake it depends on.
    if (inBatch && request.method === 'initialize') {
      return invalidRequest('initialize must not be sent in a batch.', request.id);
    }
    return null;
  }

  async function handleRequest(request, notify, { inBatch = false } = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return invalidRequest('Invalid request.');
    }
    // Only a message with no id at all is a notification, and it gets no reply.
    if (!('id' in request)) {
      handleNotification(request);
      return null;
    }
    const problem = malformed(request, inBatch);
    if (problem) return problem;
    const key = requestKey(request.id);
    const entry = { cancelled: false };
    pending.set(key, entry);
    try {
      const context = { onProgress: progressReporter(request, message => {
        if (!entry.cancelled) notify(message);
      }) };
      const result = await dispatch(request.method, request.params, context);
      return entry.cancelled ? null : { jsonrpc: '2.0', id: request.id, result };
    } catch (error) {
      if (entry.cancelled) return null;
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: error.rpcCode || INTERNAL_ERROR, message: error.message }
      };
    } finally {
      if (pending.get(key) === entry) pending.delete(key);
    }
  }

  /** One input line: a request, a notification, or a batch of either. */
  async function handleLine(line, send) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error.' } });
      return;
    }
    if (Array.isArray(parsed)) {
      if (!parsed.length) {
        send(invalidRequest('An empty batch is not a request.'));
        return;
      }
      const responses = (await Promise.all(parsed.map(item =>
        handleRequest(item, send, { inBatch: true })))).filter(Boolean);
      if (responses.length) send(responses);
      return;
    }
    const response = await handleRequest(parsed, send);
    if (response) send(response);
  }

  /**
   * Handles every line as it arrives instead of waiting for the one before it.
   * The first tool call waits for the whole decrypt (about eleven seconds on a
   * 20,000-record library), and handling lines in turn left ping, tools/list, and
   * cancellations queued behind it, which gets a live server declared dead.
   * Responses go out in whatever order they finish, which JSON-RPC allows since
   * the id pairs them.
   *
   * Nothing waits for initialize. Some clients skip it, and every method here
   * works the same either way.
   *
   * Lines are split here rather than by readline, which buffers a line of any
   * length. A line past LIMITS.maxMessageBytes is dropped as it arrives and
   * answered with one error, so a client that never sends a newline costs a
   * bounded amount of memory. Bytes are decoded only once a line is whole, so a
   * character split across two reads stays intact.
   */
  async function listen({ input = process.stdin, output = process.stdout } = {}) {
    const send = message => {
      // A client that closed the pipe is a disconnect, not a crash.
      try { output.write(`${JSON.stringify(message)}\n`); } catch (_) { /* closed */ }
    };
    const inFlight = new Set();
    let parts = [];
    let size = 0;
    let oversized = false;

    const take = part => {
      if (oversized || !part.length) return;
      size += part.length;
      if (size > LIMITS.maxMessageBytes) { oversized = true; parts = []; } else parts.push(part);
    };
    const endLine = () => {
      const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
      const dropped = oversized;
      parts = [];
      size = 0;
      oversized = false;
      if (dropped) {
        send(invalidRequest(`Message is larger than ${LIMITS.maxMessageBytes} bytes.`));
        return;
      }
      if (!line.trim()) return;
      const work = handleLine(line, send)
        .catch(error => log(`request failed: ${error.message}`))
        .finally(() => inFlight.delete(work));
      inFlight.add(work);
    };

    for await (const raw of input) {
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
      let start = 0;
      for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, start)) {
        take(chunk.subarray(start, newline));
        endLine();
        start = newline + 1;
      }
      take(chunk.subarray(start));
    }
    // A last line with no newline after it is still a message.
    if (size || oversized) endLine();
    // Input closed. Finish what was asked before exiting.
    await Promise.all(inFlight);
  }

  return { listen, handleLine, dispatch, SUPPORTED_PROTOCOLS };
}

module.exports = { createRpcServer, SUPPORTED_PROTOCOLS, LATEST_PROTOCOL };
