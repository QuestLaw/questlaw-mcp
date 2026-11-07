#!/usr/bin/env node
/** Synthetic continuation cost without encryption, index-build, or host latency.
 * Run: node tools/bench-retrieval.js
 * Nothing is persisted and no real library or account key is used. */
'use strict';

const { createHash } = require('crypto');
const { createTools } = require('../src/tools');

process.env.QUESTLAW_DISCLOSURE_ACK = 'i-understand';

async function measure(label, texts) {
  const library = { cases: [], projects: [], relationships: [], workspaceSections: [],
    documents: [{ documentId: 'synthetic' }],
    documentSections: texts.map((text, order) => ({ documentId: 'synthetic', order, text })),
    documentReferences: [] };
  const snapshot = { library };
  const tools = new Map(createTools({ ready: async () => snapshot }).map(tool => [tool.name, tool]));
  let next = (await tools.get('get_source_text').run({ documentId: 'synthetic', outline: true })).readText;
  const times = [];
  const digest = createHash('sha256');
  const initialHeap = process.memoryUsage().heapUsed;
  let maxHeap = initialHeap;
  let chars = 0;
  while (next) {
    const started = process.hrtime.bigint();
    const result = await tools.get(next.tool).run(next.arguments);
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    for (const part of result.parts) { digest.update(part.text); chars += part.text.length; }
    next = result.nextCall;
    maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
  }
  const expected = createHash('sha256');
  for (const text of texts) expected.update(text);
  if (digest.digest('hex') !== expected.digest('hex')) throw new Error('Lossy retrieval');
  times.sort((a, b) => a - b);
  const rounded = number => Number(number.toFixed(3));
  process.stdout.write(JSON.stringify({ label, chars, calls: times.length,
    medianMs: rounded(times[Math.floor(times.length / 2)]),
    p95Ms: rounded(times[Math.floor(times.length * 0.95)]),
    observedHeapGrowthMiB: rounded((maxHeap - initialHeap) / 1048576)
  }) + '\n');
}

async function main() {
  await measure('1 MiB section', ['word '.repeat(209715)]);
  await measure('10 MiB section', ['word '.repeat(2097152)]);
  await measure('5000 sections', Array.from({ length: 5000 }, (_, i) => `Text ${i}\n`));
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
