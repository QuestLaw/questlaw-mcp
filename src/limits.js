/**
 * Every ceiling in one place. A 2,000-case library serializes to about 3.5 MiB,
 * roughly a million tokens, so dumping it isn't an option. Retrieval is capped by
 * bytes instead of row count, since one case with a 40 KiB note costs more than
 * forty bare ones.
 *
 * A truncated result always says so and says how to get the rest.
 */
'use strict';

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
  /** The one-line gist carried on every case row, so a list is readable on its own. */
  summaryChars: 320,
  detailQuotes: 40,
  overviewTags: 50,
  overviewCourts: 25,
  mentionContextChars: 120,
  /** Past this much captured text in one answer, say that an excerpt was available. */
  longDocumentChars: 20000,
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
const TRUNCATION_NOTE_BYTES = 200;

/**
 * What's left for rows once the surrounding fields are paid for. An echoed query
 * can be four kilobytes by itself, so this is measured instead of guessed, which
 * is what makes responseBytes a real ceiling.
 */
function rowBudget(envelope) {
  return LIMITS.responseBytes - Buffer.byteLength(JSON.stringify(envelope)) - TRUNCATION_NOTE_BYTES;
}

/** Clips to `maxChars` and says how much was cut. */
function clip(value, maxChars) {
  const text = String(value == null ? '' : value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [clipped, ${text.length - maxChars} more characters]`;
}

/**
 * Takes rows until the serialized budget is spent. It always returns at least one
 * row, since fields are already clipped and a single row is bounded.
 */
function capRows(rows, byteLimit = LIMITS.responseBytes) {
  const kept = [];
  let bytes = 2;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (kept.length && bytes + size > byteLimit) break;
    kept.push(row);
    bytes += size;
  }
  return kept;
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
  const kept = capRows(rows, rowBudget({ matched, returned: matched, results: [], ...extra }));
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

module.exports = { LIMITS, clip, capRows, rowBudget, listResult };
