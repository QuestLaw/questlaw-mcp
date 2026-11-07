/** Lossless, snapshot-bound reads. Cursors contain identifiers and positions, never research text. */
'use strict';

const { randomBytes, createHmac, timingSafeEqual } = require('crypto');
const { LibraryError } = require('./errors');
const { LIMITS, clip, safeEnd, fittingChars, resultBytes, tooLarge } = require('./limits');
const { pincite } = require('./projections');
const { Search } = require('./core-modules');

const KEY = randomBytes(32);
const SESSION = randomBytes(8).toString('hex');
const STATES = new WeakMap();
const FIELDS = ['notes', 'holding', 'keyFacts', 'whyItMatters'];

function stateFor(snapshot) {
  let state = STATES.get(snapshot);
  if (!state) {
    state = { id: randomBytes(12).toString('hex'), targets: new Map() };
    STATES.set(snapshot, state);
  }
  return state;
}

function sign(payload) {
  return createHmac('sha256', KEY).update(payload).digest();
}

function readCall(snapshot, scope, unit = 0, start = 0, maxChars = LIMITS.textPageChars) {
  const payload = Buffer.from(JSON.stringify({
    v: 1, session: SESSION, snapshot: stateFor(snapshot).id, scope, unit, start
  })).toString('base64url');
  return { tool: 'read_library_text', arguments: {
    cursor: `${payload}.${sign(payload).toString('base64url')}`, maxChars
  } };
}

function cursorError(code = 'invalid_cursor') {
  return new LibraryError(code, code === 'stale_cursor'
    ? 'The library snapshot or server session changed during this read.'
    : 'The text cursor is invalid.', {
    hint: 'Repeat the original search, get_case, or get_source_text call and use its new readText/readMatch call. Do not combine text from different snapshots.'
  });
}

function decode(snapshot, cursor) {
  if (typeof cursor !== 'string' || cursor.length > 4096
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw cursorError();
  const [payload, signature] = cursor.split('.');
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch (_) { throw cursorError(); }
  if (!value || value.v !== 1) throw cursorError();
  if (value.session !== SESSION) throw cursorError('stale_cursor');
  const actual = Buffer.from(signature, 'base64url');
  const expected = sign(payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw cursorError();
  if (value.snapshot !== stateFor(snapshot).id) throw cursorError('stale_cursor');
  if (!Number.isSafeInteger(value.unit) || value.unit < 0
      || !Number.isSafeInteger(value.start) || value.start < 0) throw cursorError();
  return value;
}

function documentParts(index, scope) {
  const document = index.documents.get(scope.documentId);
  if (!document) throw cursorError();
  const sections = index.sectionsByDocument.get(scope.documentId) || [];
  const selected = scope.kind === 'section'
    ? [[scope.sectionIndex, sections[scope.sectionIndex]]]
    : sections.map((section, position) => [position, section]);
  if (selected.some(([, section]) => !section)) throw cursorError();
  return selected.map(([sectionIndex, section]) => ({
    kind: 'source', documentId: scope.documentId, sectionIndex,
    sectionId: section.sectionId || '', label: clip(section.label, 160),
    heading: clip(section.heading, 240), citation: clip(document.sourceCitation, 240),
    text: String(section.text || '')
  }));
}

function authorityParts(index, guid) {
  const authority = index.cases.get(guid);
  if (!authority) throw cursorError();
  const parts = FIELDS.map(field => ({ kind: 'field', guid, field,
    text: String(authority[field] || '') }));
  for (const [quoteIndex, quote] of (authority.quotes || []).entries()) {
    parts.push({ kind: 'quote', guid, quoteIndex,
      quoteId: quote.id || '', pincite: clip(pincite(quote), 160),
      citation: clip(quote.citation || Search.getBestCitation(authority), 240), text: String(quote.text || '') });
  }
  const seen = new Set();
  for (const [relationshipIndex, edge] of (index.edgesByGuid.get(guid) || []).entries()) {
    if (seen.has(edge)) continue;
    seen.add(edge);
    const outbound = String(edge.fromGuid) === guid;
    parts.push({ kind: 'relationship', guid, relationshipIndex,
      direction: outbound ? 'outbound' : 'inbound', type: clip(edge.type, 120),
      otherGuid: String(outbound ? edge.toGuid : edge.fromGuid), text: String(edge.note || '') });
  }
  return parts;
}

/** Catalogs hold references to existing strings and are cached only on the current snapshot. */
function partsFor(snapshot, index, scope) {
  const cache = stateFor(snapshot).targets;
  const key = JSON.stringify(scope);
  if (cache.has(key)) return cache.get(key);
  let parts;
  if (scope.kind === 'document' || scope.kind === 'section') parts = documentParts(index, scope);
  else if (scope.kind === 'case') parts = authorityParts(index, scope.guid);
  else if (['field', 'quote', 'relationship'].includes(scope.kind)) {
    const all = partsFor(snapshot, index, { kind: 'case', guid: scope.guid });
    parts = all.filter(part => scope.kind === 'field' ? part.field === scope.field
      : scope.kind === 'quote' ? part.kind === 'quote' && part.quoteIndex === scope.quoteIndex
        : part.kind === 'relationship' && part.relationshipIndex === scope.relationshipIndex);
    if (parts.length !== 1) throw cursorError();
  } else throw cursorError();
  cache.set(key, parts);
  return parts;
}

function pageSize(args) {
  if (Object.keys(args).some(key => !['cursor', 'maxChars'].includes(key))) {
    throw new LibraryError('invalid_argument', 'Only cursor and maxChars are accepted.');
  }
  const maximum = args.maxChars ?? LIMITS.textPageChars;
  if (!Number.isSafeInteger(maximum) || maximum < 2 || maximum > LIMITS.maxTextPageChars) {
    throw new LibraryError('invalid_argument', `maxChars must be an integer from 2 to ${LIMITS.maxTextPageChars}.`);
  }
  return maximum;
}

function validatePosition(catalog, unit, start) {
  if (unit > catalog.length || (unit === catalog.length && start !== 0)) throw cursorError();
  if (unit < catalog.length && (start > catalog[unit].text.length
      || safeEnd(catalog[unit].text, start) !== start)) throw cursorError();
}

function readText(snapshot, index, args) {
  const maximum = pageSize(args);
  const decoded = decode(snapshot, args.cursor);
  const { scope } = decoded;
  const catalog = partsFor(snapshot, index, scope);
  let { unit, start } = decoded;
  validatePosition(catalog, unit, start);
  const parts = [];
  let remaining = maximum;
  const response = (shown, nextUnit, nextStart) => ({
    scope, snapshotId: stateFor(snapshot).id, hasMore: nextUnit < catalog.length,
    ...(nextUnit < catalog.length
      ? { nextCall: readCall(snapshot, scope, nextUnit, nextStart, maximum) } : {}),
    parts: shown
  });
  while (unit < catalog.length && remaining > 0 && parts.length < LIMITS.maxRows) {
    const part = catalog[unit];
    const available = Math.min(remaining, part.text.length - start);
    const candidate = count => {
      const end = safeEnd(part.text, start + count);
      const fragment = { ...part, start, end, totalChars: part.text.length, text: part.text.slice(start, end) };
      return response([...parts, fragment], end === part.text.length ? unit + 1 : unit,
        end === part.text.length ? 0 : end);
    };
    const count = fittingChars(available, candidate);
    const end = safeEnd(part.text, start + count);
    if (resultBytes(candidate(count)) > LIMITS.responseBytes
        || (end === start && start < part.text.length)) {
      if (!parts.length) throw tooLarge();
      break;
    }
    parts.push(candidate(count).parts.at(-1));
    remaining -= end - start;
    if (end === part.text.length) { unit += 1; start = 0; }
    else { start = end; break; }
  }
  const result = response(parts, unit, start);
  if (resultBytes(result) > LIMITS.responseBytes) throw tooLarge();
  return result;
}

module.exports = { readCall, readText, FIELDS };
