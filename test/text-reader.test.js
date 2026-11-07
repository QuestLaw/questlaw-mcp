'use strict';

require('./helpers/consent');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTools } = require('../src/tools');
const { createRpcServer } = require('../src/rpc');
const { LIMITS, resultBytes, clip } = require('../src/limits');

function library(texts = []) {
  return { cases: [], projects: [], relationships: [], workspaceSections: [],
    documents: [{ documentId: 'd', sourceTitle: 'Synthetic source', sourceCitation: '123 U.S. 456' }],
    documentSections: texts.map((text, order) => ({ documentId: 'd', order, label: String(order), text })),
    documentReferences: [] };
}

function session(value) {
  let snapshot = { library: value };
  const tools = createTools({ ready: async () => snapshot });
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const call = (name, args = {}) => byName.get(name).run(args);
  return { call, follow: link => call(link.tool, link.arguments), tools,
    replace: value => { snapshot = { library: value }; } };
}

async function collect(client, link, maxChars) {
  const items = new Map();
  const snapshots = new Set();
  let calls = 0;
  while (link) {
    const args = { ...link.arguments, ...(maxChars === undefined ? {} : { maxChars }) };
    const result = await client.call(link.tool, args);
    assert.ok(resultBytes(result) <= LIMITS.responseBytes);
    assert.equal(Boolean(result.nextCall), result.hasMore);
    snapshots.add(result.snapshotId);
    let returned = 0;
    for (const part of result.parts) {
      const key = JSON.stringify([part.kind, part.sectionIndex, part.field, part.quoteIndex, part.relationshipIndex]);
      const item = items.get(key) || { text: '', part };
      assert.equal(part.start, item.text.length, 'no missing or repeated characters');
      assert.equal(part.end - part.start, part.text.length);
      item.text += part.text;
      returned += part.text.length;
      items.set(key, item);
    }
    assert.ok(returned <= args.maxChars);
    if (result.nextCall) assert.notEqual(result.nextCall.arguments.cursor, args.cursor);
    link = result.nextCall;
    assert.ok(++calls < 2000, 'continuation terminates');
  }
  assert.equal(snapshots.size, 1);
  for (const item of items.values()) assert.equal(item.text.length, item.part.totalChars);
  return [...items.values()];
}

test('every captured character is reachable, including long sections and empty sections', async () => {
  for (const length of [8001, 100000, 1000000]) {
    const texts = ['', 'Introduction\r\n\t', 'a'.repeat(length) + '😀\nEND', '', 'Same', 'Same'];
    const client = session(library(texts));
    const preview = await client.call('get_source_text', { documentId: 'd' });
    const items = await collect(client, preview.readText);
    assert.deepEqual(items.map(item => item.text), texts);
  }
});

test('small pages preserve surrogate pairs, CRLF, whitespace, and literal clipping notices', async () => {
  const text = ' A😀B\r\n e\u0301\t... [clipped, 99 more characters] \n';
  const client = session(library([text]));
  const preview = await client.call('get_source_text', { documentId: 'd' });
  const items = await collect(client, preview.readText, 2);
  assert.equal(items[0].text, text);
  assert.equal(clip('a'.repeat(7999) + '😀', 8000).charCodeAt(7999), '.'.charCodeAt(0));
});

test('legacy excerpts offer the exact unread tail instead of advancing past it', async () => {
  const texts = ['A'.repeat(300), 'B'.repeat(300)];
  const client = session(library(texts));
  const preview = await client.call('get_source_text', { documentId: 'd', maxChars: 100 });
  assert.equal(preview.nextOffset, 1, 'legacy row offsets retain their meaning');
  assert.equal(preview.sections[0].textTruncated, true);
  const tail = await client.follow(preview.sections[0].readMore);
  assert.equal(tail.parts[0].start, 100);
  assert.equal(tail.parts[0].text, texts[0].slice(100));
  assert.equal(tail.hasMore, false);
});

test('case reads include all notes, analysis, quotations, and live relationship notes', async () => {
  const value = library();
  const authority = { guid: 'c', title: 'Synthetic authority', notes: 'N'.repeat(9000),
    holding: ' H'.repeat(4000), keyFacts: '\tF'.repeat(3000), whyItMatters: 'W'.repeat(5000),
    quotes: Array.from({ length: 55 }, (_, i) => ({ id: 'q' + i, text: 'Q'.repeat(1600) + i, page: String(i) })) };
  value.cases = [authority, { guid: 'other', title: 'Other' }];
  value.relationships = [
    { fromGuid: 'c', toGuid: 'other', type: 'distinguishes', note: 'R'.repeat(7000) },
    { fromGuid: 'other', toGuid: 'c', type: 'follows', note: 'Inbound note' },
    { fromGuid: 'c', toGuid: 'other', note: 'Hidden', suppressedAt: 1 }
  ];
  const client = session(value);
  const preview = await client.call('get_case', { guid: 'c' });
  assert.ok(resultBytes(preview) <= LIMITS.responseBytes);
  assert.ok(preview.quotesOmitted > 0);
  assert.equal((await client.follow(preview.textTruncation.notes.readMore)).parts[0].start, 4000);
  const items = await collect(client, preview.readText);
  assert.deepEqual(items.map(item => item.text), [authority.notes, authority.holding,
    authority.keyFacts, authority.whyItMatters, ...authority.quotes.map(q => q.text),
    value.relationships[0].note, value.relationships[1].note]);
  const quote = items.find(item => item.part.quoteIndex === 54);
  assert.equal(quote.part.pincite, '54');
  assert.equal(items.at(-1).part.direction, 'inbound');
});

test('late source matches and missing section IDs open the correct original section', async () => {
  const tail = 'The raremarker is dispositive.';
  const client = session(library(['Introduction.', 'filler '.repeat(2000) + tail]));
  const result = await client.call('search_library', { query: 'raremarker', types: ['source'] });
  const hit = result.results[0];
  assert.equal(hit.label, '1');
  assert.equal(hit.sectionIndex, 1);
  const context = await client.follow(hit.matchedPassage.readMatch);
  assert.equal(context.parts[0].sectionIndex, 1);
  assert.ok(context.parts[0].start > 8000);
  assert.ok(context.parts[0].text.includes(tail));
  const query = await client.call('get_source_text', { documentId: 'd', query: 'raremarker' });
  assert.ok((await client.follow(query.sections[0].matchedPassage.readMatch)).parts[0].text.includes(tail));
});

test('repeated section IDs and tied section ordering do not alias search results', async () => {
  const value = library(['First text.', 'The raremarker lives here.']);
  value.documentSections.forEach(section => { section.sectionId = 'repeated'; section.order = 0; });
  const client = session(value);
  const hit = (await client.call('search_library', { query: 'raremarker', types: ['source'] })).results[0];
  assert.equal(hit.sectionIndex, 1);
  assert.equal((await client.follow(hit.readText)).parts[0].text, value.documentSections[1].text);
});

test('empty documents terminate and self-relationships appear once', async () => {
  const value = library();
  value.cases = [{ guid: 'c', title: 'Case' }];
  value.relationships = [{ fromGuid: 'c', toGuid: 'c', note: 'Self note', type: 'relates_to' }];
  const client = session(value);
  const source = await client.call('get_source_text', { documentId: 'd' });
  const empty = await client.follow(source.readText);
  assert.deepEqual(empty.parts, []);
  assert.equal(empty.hasMore, false);
  const authority = await client.call('get_case', { guid: 'c' });
  const items = await collect(client, authority.readText);
  assert.equal(items.filter(item => item.part.kind === 'relationship').length, 1);
});

test('source queries use the search engine phrase and shorthand rules', async () => {
  const client = session(library(['Summary judgment applies. Alpha is separate from beta.']));
  for (const [query, count] of [['MSJ', 1], ['"alpha beta"', 0], ['judgments', 1]]) {
    const source = await client.call('get_source_text', { documentId: 'd', query });
    const search = await client.call('search_library', { query, types: ['source'] });
    assert.equal(source.matchedSections, count);
    assert.equal(search.matched, count);
  }
});

test('joined quotation and relationship passages resolve to original text items', async () => {
  const value = library();
  value.cases = [{ guid: 'c', title: 'Case', quotes: [
    { text: 'Unrelated.' }, { text: 'filler '.repeat(1000) + 'rarequote', page: '91' }
  ] }, { guid: 'other', title: 'Other' }];
  value.relationships = [{ fromGuid: 'other', toGuid: 'c', type: 'follows',
    note: 'filler '.repeat(1000) + 'rareedge' }];
  const client = session(value);
  for (const [query, kind, ending] of [['rarequote', 'quote', 'rarequote'], ['rareedge', 'relationship', 'rareedge']]) {
    const result = await client.call('search_cases', { query });
    const row = result.results.find(row => row.guid === 'c');
    const read = await client.follow(row.matchedPassage.readMatch);
    assert.equal(read.parts[0].kind, kind);
    assert.ok(read.parts[0].text.endsWith(ending));
  }
});

test('cursors replay deterministically, allow page-size changes, and reject stale or altered targets', async () => {
  const value = library(['X'.repeat(20000)]);
  const client = session(value);
  const link = (await client.call('get_source_text', { documentId: 'd' })).readText;
  assert.deepEqual(await client.follow(link), await client.follow(link));
  const first = await client.call('read_library_text', { ...link.arguments, maxChars: 20 });
  const next = await client.call('read_library_text', { ...first.nextCall.arguments, maxChars: 100 });
  assert.equal(next.parts[0].start, 20);
  assert.equal(next.parts[0].end, 120);
  const [encoded, signature] = link.arguments.cursor.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url'));
  payload.scope.documentId = 'another';
  const altered = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + signature;
  await assert.rejects(client.call('read_library_text', { cursor: altered }), { code: 'invalid_cursor' });
  for (const cursor of ['', 'invalid', 'x'.repeat(4097)]) {
    await assert.rejects(client.call('read_library_text', { cursor }), { code: 'invalid_cursor' });
  }
  for (const maxChars of [1, 0, true, '20', 2.5, 65537]) {
    await assert.rejects(client.call('read_library_text', { ...link.arguments, maxChars }), { code: 'invalid_argument' });
  }
  await assert.rejects(client.call('read_library_text', { ...link.arguments, query: 'x' }), { code: 'invalid_argument' });
  client.replace(library(['Changed']));
  await assert.rejects(client.follow(first.nextCall), { code: 'stale_cursor' });
});

test('RPC guards oversized results and errors without truncating JSON', async () => {
  const rpc = createRpcServer({ serverInfo: {}, tools: [{ name: 'oversize', async run() {
    return { text: 'x'.repeat(LIMITS.responseBytes) };
  } }, { name: 'failure', async run() { throw new Error('x'.repeat(LIMITS.responseBytes)); } }] });
  for (const name of ['oversize', 'failure']) {
    const result = await rpc.dispatch('tools/call', { name });
    assert.ok(result.isError);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'response_too_large');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.responseBytes);
  }
});
