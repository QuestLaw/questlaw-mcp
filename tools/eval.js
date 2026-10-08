#!/usr/bin/env node
/**
 * Print search relevance against the recorded baseline.
 *
 *   node tools/eval.js            report, with the change from the baseline
 *   node tools/eval.js --worst    also list the queries that score lowest
 *   node tools/eval.js --write    record the current scores as the baseline
 *
 * test/relevance.test.js fails when a score drops below the baseline, so ranking
 * changes have to be measured, and a deliberate trade is recorded with --write
 * where review can see it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { evaluate } = require('../test/eval/run');

const BASELINE = path.join(__dirname, '..', 'test', 'eval', 'baseline.json');

const result = evaluate();
const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;

function delta(now, before) {
  if (before === undefined) return '';
  const change = now - before;
  if (Math.abs(change) < 0.00005) return '        ';
  return ` (${change > 0 ? '+' : ''}${change.toFixed(3)})`;
}

function line(label, scores, before = {}) {
  const cells = ['ndcg', 'records', 'mrr', 'recall', 'snippet']
    .filter(metric => scores[metric] !== undefined)
    .map(metric => `${metric} ${scores[metric].toFixed(3)}${delta(scores[metric], before[metric])}`);
  return `  ${label.padEnd(14)} n=${String(scores.queries).padStart(2)}  ${cells.join('  ')}`;
}

process.stdout.write('search relevance\n');
process.stdout.write(`${line('overall', result.overall, baseline?.overall)}\n`);
for (const [kind, scores] of Object.entries(result.byKind)) {
  process.stdout.write(`${line(kind, scores, baseline?.byKind?.[kind])}\n`);
}

if (process.argv.includes('--worst')) {
  process.stdout.write('\nlowest nDCG@10:\n');
  for (const row of [...result.perQuery].sort((a, b) => a.ndcg - b.ndcg).slice(0, 15)) {
    const top = row.top.map(hit => (hit.type === 'case' ? hit.ref
      : hit.type === 'quote' ? `quote:${hit.ref.guid}` : `${hit.ref.documentId}`)).join(', ');
    process.stdout.write(`  ${row.ndcg.toFixed(2)}  [${row.kind}] ${row.query}\n        top: ${top}\n`);
  }
}

if (process.argv.includes('--write')) {
  const { overall, byKind } = result;
  fs.writeFileSync(BASELINE, `${JSON.stringify({ overall, byKind }, null, 2)}\n`);
  process.stdout.write(`\nbaseline written to ${path.relative(process.cwd(), BASELINE)}\n`);
}
