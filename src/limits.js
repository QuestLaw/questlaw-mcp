/**
 * Every ceiling in one place. A 2,000-case library serializes to about 3.5 MiB,
 * roughly a million tokens, so dumping it isn't an option. Retrieval is capped by
 * bytes instead of row count, since one case with a 40 KiB note costs more than
 * forty bare ones.
 *
 * A truncated result always says so and says how to get the rest.
 */
'use strict';

const { LibraryError } = require('./errors');

const KiB = 1024;

function clampEnv(name, fallback, min, max) {
  const raw = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

const LIMITS = Object.freeze({
  /** Serialized bytes of one tool result. The only tunable ceiling. */
  responseBytes: clampEnv('QUESTLAW_MAX_RESPONSE_BYTES', 64 * KiB, 8 * KiB, 1024 * KiB),
  /** Rows a list tool will return, however small the rows are. */
  maxRows: 50,
  defaultRows: 25,
  /** Per-field clips, applied before the response budget so one field can't eat it. */
  notesChars: 4000,
  quoteChars: 1500,
  sectionChars: 8000,
  textPageChars: 4000,
  maxTextPageChars: 65536,
  /** The one-line gist carried on every case row, so a list is readable on its own. */
  summaryChars: 320,
  detailQuotes: 40,
  overviewTags: 50,
  overviewCourts: 25,
  mentionContextChars: 120,
  /** Draft text accepted by find_citation_mentions. */
  inputTextBytes: 256 * KiB,
  /**
   * One JSON-RPC line. The largest real message is that draft, and JSON can
   * escape each byte of it to six (\u0000), so this leaves room for a full draft
   * while stopping a client that never sends a newline from growing memory forever.
   */
  maxMessageBytes: 4 * 1024 * KiB
});

/** Room reserved for the truncation sentence, which is written after capping. */
const TRUNCATION_NOTE_BYTES = 512;

/** The actual MCP result, including escaping the JSON carried inside its text block. */
function toolResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

const resultBytes = value => Buffer.byteLength(JSON.stringify(toolResult(value)));
// Marginal bytes of a value inside the JSON-in-JSON text block.
const encodedBytes = value => Buffer.byteLength(JSON.stringify(JSON.stringify(value))) - 2;

function tooLarge() {
  return new LibraryError('response_too_large', 'This result cannot fit the response byte budget.', {
    hint: 'Use a smaller limit or maxChars, or follow readText/readMore with read_library_text.'
  });
}

/** Do not cut between the two code units of a Unicode surrogate pair. */
function safeEnd(text, end) {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])
      && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1;
  return end;
}

/** Largest candidate that fits; builders must grow monotonically with the count. */
function fittingChars(maximum, build, budget = LIMITS.responseBytes) {
  // Finishing a target can remove continuation metadata, making the last candidate smaller.
  if (resultBytes(build(maximum)) <= budget) return maximum;
  let low = 0;
  let high = maximum;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (resultBytes(build(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * What's left for rows once the surrounding fields are paid for. An echoed query
 * can be four kilobytes by itself, so this is measured instead of guessed, which
 * is what makes responseBytes a real ceiling.
 */
function rowBudget(envelope) {
  return LIMITS.responseBytes - resultBytes(envelope) - TRUNCATION_NOTE_BYTES;
}

/** Clips to `maxChars` and says how much was cut. */
function clip(value, maxChars) {
  const text = String(value == null ? '' : value);
  if (text.length <= maxChars) return text;
  const end = safeEnd(text, maxChars);
  return `${text.slice(0, end)}... [clipped, ${text.length - end} more characters]`;
}

/**
 * Takes rows until the serialized budget is spent. An oversized first row is an
 * explicit failure, never an exception to the budget or a non-progressing page.
 */
function capRows(rows, byteLimit = LIMITS.responseBytes) {
  const kept = [];
  let bytes = 2;
  for (const row of rows) {
    const size = encodedBytes(row) + 1;
    if (bytes + size > byteLimit) {
      if (!kept.length) throw tooLarge();
      break;
    }
    kept.push(row);
    bytes += size;
  }
  return kept;
}

/** Search rows are previews with independent readText links. Shorten their text
 * before admitting a pathological escaped quotation as the first row. */
function fitListRow(row, budget) {
  if (encodedBytes(row) + 3 <= budget) return row;
  const shorten = value => {
    if (Array.isArray(value)) return value.map(shorten);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'text' || key === 'summary' ? clip(item, 240) : shorten(item)]));
  };
  const reduced = { ...shorten(row), previewTruncated: true };
  if (encodedBytes(reduced) + 3 > budget) throw tooLarge();
  return reduced;
}

/**
 * The standard list envelope. `matched` is the true count, so a model can tell
 * "these are all of them" from "narrow your query".
 *
 * A tool that passes `offset` gets paging: whenever the page stops short of
 * `matched`, the result names the `nextOffset` that continues it. Without that, a
 * short page looked the same as silently lost results.
 */
function listResult(rows, matched, extra = {}) {
  const budget = rowBudget({ matched, returned: matched, results: [], ...extra });
  const kept = capRows(rows.map(row => fitListRow(row, budget)), budget);
  const result = { matched, returned: kept.length, results: kept, ...extra };
  const paged = Number.isInteger(extra.offset);
  const seen = (paged ? extra.offset : 0) + kept.length;

  if (seen < matched) {
    // Rows cut by the byte budget (not `limit`) need a smaller page, and telling
    // the caller to raise limit there sends them in circles.
    const budgetCapped = kept.length < rows.length;
    if (paged) {
      result.nextOffset = seen;
      result.truncated = `Showing ${extra.offset}-${seen - 1} of ${matched}. `
        + (budgetCapped
          ? `The response byte budget ended this page; call again with offset ${seen} for the rest.`
          : `Call again with offset ${seen} for the rest, or raise limit `
            + `(max ${LIMITS.maxRows}).`);
    } else {
      result.truncated = budgetCapped
        ? `Returned ${kept.length} of ${matched} matches; the response byte budget ran out. `
          + 'Narrow the query or lower limit.'
        : `Returned ${kept.length} of ${matched} matches. Raise limit (max ${LIMITS.maxRows}) `
          + 'or narrow the query.';
    }
  }
  return result;
}

module.exports = {
  LIMITS, clip, capRows, rowBudget, listResult, toolResult, resultBytes,
  encodedBytes, safeEnd, fittingChars, tooLarge
};
