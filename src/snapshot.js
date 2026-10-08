/**
 * Finds, loads, and holds the one decrypted snapshot this process serves. The
 * library is read once at startup and kept in memory, never written to disk in
 * cleartext, since re-reading takes about a second and a cache would be a
 * plaintext copy of the whole library.
 *
 * A load failure doesn't end the process. A missing export or a wrong recovery
 * code is something the user can fix, but only if the server stays alive to
 * explain it.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readEncryptedLibrary } = require('./reader');
const { requireConsent } = require('./consent');
const { LibraryError, asLibraryError } = require('./errors');

const VAULT_EXTENSION = '.qlvault';

function expandHome(target) {
  // MCPB supports HOME in user_config defaults but not DOWNLOADS. Older installs
  // saved the DOWNLOADS token literally, sometimes with a slash prepended by the
  // directory picker, so recover just that default.
  // eslint-disable-next-line no-template-curly-in-string
  if (target === '${DOWNLOADS}' || target === '/${DOWNLOADS}') {
    return path.join(os.homedir(), 'Downloads');
  }
  // The client may substitute user_config without expanding the default's nested placeholder.
  // eslint-disable-next-line no-template-curly-in-string
  if (target.startsWith('${HOME}/')) return path.join(os.homedir(), target.slice(8));
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return target;
}

// The extension's backups land in the browser's download folder, so a normal
// install needs no configuration.
const DEFAULT_TARGET = '~/Downloads';

/** A file path, or the newest .qlvault inside a directory. */
function findVaultFile(target) {
  const configured = String(target || '').trim() || DEFAULT_TARGET;
  const resolved = path.resolve(expandHome(configured));

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new LibraryError('vault_file_missing', `Nothing exists at ${resolved}.`, {
      hint: 'Export a backup from the extension, then point QUESTLAW_VAULT_FILE at it.',
      cause: error
    });
  }
  if (stat.isFile()) return resolved;

  // A download folder changes under us: a browser can delete or rename a file
  // between the listing and the stat, and a directory can be named x.qlvault.
  // Neither is an export, and neither should fail the read of one that is.
  let newest = null;
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.name.endsWith(VAULT_EXTENSION)) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const file = path.join(resolved, entry.name);
    let entryStat;
    try {
      entryStat = fs.statSync(file);
    } catch (_) {
      continue;
    }
    if (entryStat.isFile() && (!newest || entryStat.mtimeMs > newest.mtimeMs)) {
      newest = { file, mtimeMs: entryStat.mtimeMs };
    }
  }
  if (!newest) {
    throw new LibraryError('vault_file_missing', `No ${VAULT_EXTENSION} file in ${resolved}.`, {
      hint: 'Export a backup from the extension. With daily backup enabled the extension '
        + 'writes questlaw-backup-<date>.qlvault on its own.'
    });
  }
  return newest.file;
}

/** Identifies one export on disk by path, size, and modification time. An unchanged signature lets a call skip re-reading. */
function fileSignature(file) {
  const stat = fs.statSync(file);
  return { file, bytes: stat.size, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
}

const sameSignature = (left, right) => Boolean(left && right)
  && left.file === right.file && left.bytes === right.bytes && left.mtimeMs === right.mtimeMs;

/**
 * @param {object} options
 * @param {string} [options.recoveryCode] the key itself, for tests and tools that hold one
 * @param {() => string} [options.resolveKey] reads the key from where it's kept
 */
async function loadSnapshot({ target, recoveryCode, resolveKey, onProgress }) {
  // Consent comes before the key is read or the file is opened, so an unaccepted
  // install asks the secret store for nothing and decrypts nothing. The key is
  // resolved here, per read, and not once at startup, so the order holds on
  // every path into a read.
  requireConsent();
  // "No key" is more actionable than "that code did not unwrap this export", so
  // a key custody failure is reported before looking for the file.
  const key = recoveryCode || (typeof resolveKey === 'function' ? resolveKey() : '');
  const file = findVaultFile(target);
  // Taken before the read, so a file replaced mid-read counts as changed on the next call.
  const signature = fileSignature(file);
  const startedAt = Date.now();
  const result = await readEncryptedLibrary(file, key, { onProgress });
  return {
    ...result,
    sourceFile: file,
    sourceBytes: signature.bytes,
    signature,
    exportedAt: signature.mtime.toISOString(),
    loadedAt: new Date().toISOString(),
    readMs: Date.now() - startedAt
  };
}

/**
 * Read stages as one rising count a client can draw a progress bar from. The
 * four stages before the records are one step each, every record is one more, and
 * preparing the indexes is the last.
 */
const STEPS_BEFORE_RECORDS = 4;

function progressFromStage(stage, state) {
  switch (stage.stage) {
    case 'parsed':
      state.records = Number(stage.records) || 0;
      return { progress: 1, message: 'Reading the export' };
    case 'unwrapped': return { progress: 2, message: 'Unlocking the library' };
    case 'head': return { progress: 3, message: 'Checking the manifest' };
    case 'shards': return { progress: STEPS_BEFORE_RECORDS, message: 'Decrypting records' };
    case 'records':
      return { progress: STEPS_BEFORE_RECORDS + (Number(stage.decrypted) || 0), message: 'Decrypting records' };
    case 'indexing':
      return { progress: STEPS_BEFORE_RECORDS + state.records + 1, message: 'Building the search index' };
    default: return null;
  }
}

/** How long a checked export counts as current before the disk is looked at again. */
const FRESHNESS_INTERVAL_MS = 2000;

/**
 * Failures the user fixes outside the client, with `consent` or `setup`, and not
 * by exporting again. A read that failed on one of these is retried on the next
 * call after the freshness interval, instead of waiting for a new export.
 */
const RETRY_WITHOUT_NEW_EXPORT = new Set([
  'disclosure_not_accepted', 'account_key_unavailable', 'invalid_key_account'
]);

/**
 * Holds either a snapshot or the reason there isn't one. Every tool reads through
 * require(), so a failed load gives one clear error everywhere.
 *
 * @param {object} config
 * @param {(snapshot: object) => void} [config.prepare] runs on a new snapshot
 *   before it's served, so derived indexes are built by the read and not by the
 *   first query
 * @param {number} [config.freshnessIntervalMs] minimum gap between checks for a
 *   newer export
 */
function createSnapshotStore(config) {
  let snapshot = null;
  let failure = null;
  let firstLoad = null;
  let inFlight = null;
  // The export the last read attempted, whether or not it succeeded. A failed
  // file isn't retried on every call, but a changed one is.
  let attempted = null;
  let checkedAt = 0;
  const listeners = new Set();
  const freshnessIntervalMs = config.freshnessIntervalMs ?? FRESHNESS_INTERVAL_MS;

  function emit(stage) {
    for (const listener of listeners) {
      try { listener(stage); } catch (_) { /* a reporter never breaks a read */ }
    }
  }

  async function readOnce() {
    const state = { records: 0 };
    const report = stage => {
      const progress = progressFromStage(stage, state);
      if (progress) emit({ ...progress, total: STEPS_BEFORE_RECORDS + state.records + 1 });
    };
    try {
      const next = await loadSnapshot({ ...config, onProgress: report });
      attempted = next.signature;
      report({ stage: 'indexing' });
      if (typeof config.prepare === 'function') config.prepare(next);
      // The previous snapshot stays live until the new one is complete, indexes
      // included, so a reload is atomic.
      snapshot = next;
      failure = null;
      checkedAt = Date.now();
      return snapshot;
    } catch (error) {
      failure = asLibraryError(error);
      try { attempted = fileSignature(findVaultFile(config.target)); } catch (_) { attempted = null; }
      checkedAt = Date.now();
      // Withdrawn consent ends serving, rather than leaving the old library up.
      if (failure.code === 'disclosure_not_accepted') snapshot = null;
      // A failed reload keeps the library that already decrypted, since losing it
      // because the newest export is unreadable would be worse. The error still
      // reaches the caller and status() keeps reporting it.
      if (snapshot) {
        throw new LibraryError(failure.code, `${failure.message} Still serving the snapshot read `
          + `at ${snapshot.loadedAt}.`, { hint: failure.hint, detail: failure.detail, cause: failure });
      }
      throw failure;
    }
  }

  /** One read at a time. A second caller joins the read already running. */
  function load() {
    if (!inFlight) inFlight = readOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  /**
   * Begins the first read without waiting for it. A 20,000-record library takes
   * about eleven seconds to read (tools/bench.js measures 0.56 ms/record), and a
   * client with no reply to `initialize` in that time treats the server as dead.
   * So the transport comes up immediately and the first tool call is what waits.
   */
  function start() {
    if (!firstLoad) firstLoad = load().then(() => true, () => false);
    return firstLoad;
  }

  /**
   * Whether to read again: a different export has appeared since the last read,
   * or the last read failed on consent or the key, which the user may have fixed
   * since. It's a directory listing and one stat, cheap enough to run before every
   * call, which is how a fresh backup gets picked up without anyone calling
   * reload_snapshot.
   */
  function needsRead() {
    if (Date.now() - checkedAt < freshnessIntervalMs) return false;
    checkedAt = Date.now();
    if (!snapshot && failure && RETRY_WITHOUT_NEW_EXPORT.has(failure.code)) return true;
    let current;
    try {
      current = fileSignature(findVaultFile(config.target));
    } catch (_) {
      // Nothing there now. A loaded library keeps serving, and an unloaded one
      // already has its error.
      return false;
    }
    return !sameSignature(current, attempted);
  }

  /**
   * The snapshot, once any read in progress finishes, re-reading first if a newer
   * export has appeared. If that export fails to read, the call still succeeds
   * with the library in memory, and status() records why it wasn't replaced.
   *
   * @param {{onProgress?: (progress: object) => void}} [options]
   */
  async function ready({ onProgress } = {}) {
    if (typeof onProgress === 'function') listeners.add(onProgress);
    try {
      if (firstLoad) await firstLoad;
      if (inFlight) await inFlight.catch(() => {});
      withdrawIfRevoked();
      if ((firstLoad || snapshot || failure) && needsRead()) await load().catch(() => {});
    } finally {
      listeners.delete(onProgress);
    }
    return require_();
  }

  /**
   * `consent --revoke` promises the server will serve nothing, and that has to
   * hold for a server already running, not only the next one. So every call
   * re-checks consent, a small file read, and a revoked server lets go of the
   * decrypted library instead of keeping it for a later yes.
   */
  function withdrawIfRevoked() {
    if (!snapshot) return;
    try {
      requireConsent();
    } catch (error) {
      snapshot = null;
      failure = asLibraryError(error);
      checkedAt = Date.now();
    }
  }

  async function reload({ onProgress } = {}) {
    if (typeof onProgress === 'function') listeners.add(onProgress);
    try {
      return await load();
    } finally {
      listeners.delete(onProgress);
    }
  }

  function require_() {
    if (snapshot) return snapshot;
    if (failure) throw failure;
    throw new LibraryError('library_not_loaded', 'The library has not been read yet.', {
      hint: 'Call reload_snapshot.'
    });
  }

  function status() {
    if (!snapshot) return { state: 'unavailable', error: failure ? failure.toJSON() : null };
    return {
      state: 'loaded',
      sourceFile: snapshot.sourceFile,
      exportedAt: snapshot.exportedAt,
      loadedAt: snapshot.loadedAt,
      records: snapshot.decrypted,
      ...(failure ? { lastReloadError: failure.toJSON() } : {})
    };
  }

  return { start, ready, load, reload, require: require_, status };
}

module.exports = { createSnapshotStore, findVaultFile, loadSnapshot, DEFAULT_TARGET };
