#!/usr/bin/env node
/**
 * Copies the four core modules out of a QuestLaw extension checkout into vendor/.
 *
 * Vendoring is what lets someone with no checkout install this package, which
 * covers every real user and outside contributor. The modules are copied byte for
 * byte and never edited here, since the extension remains their only owner. What
 * keeps the copy honest is PROVENANCE.json, a sha256 per file plus the upstream
 * commit, checked at load by src/core-modules.js and against upstream by
 * test/vendor.test.js whenever a checkout is named.
 *
 *   node tools/vendor-sync.js [--repo <path>] [--check] [--require-repo]
 *
 * The checkout comes from --repo or QUESTLAW_REPO and is never searched for.
 * --check exits non-zero on drift instead of writing. Where no checkout is named
 * (CI, a published install) there's nothing to compare against, so --check
 * reports that and passes, and --require-repo makes that case an error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { findCheckout, namedCheckout } = require('./checkout');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(PACKAGE_ROOT, 'vendor', 'questlaw');
const PROVENANCE = path.join(PACKAGE_ROOT, 'vendor', 'PROVENANCE.json');

/**
 * Order matters only for humans reading the file. protocol-v2 requires
 * ./private-work-product-crypto relatively, which resolves because all four land
 * in one flat directory.
 */
const MODULES = Object.freeze([
  'src/core/private-work-product-crypto.js',
  'src/core/private-vault-protocol-v2.js',
  'src/core/private-vault-backup.js',
  'src/core/search.js'
]);

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function parseArgs(argv) {
  const args = { repo: '', check: false, requireRepo: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--require-repo') args.requireRepo = true;
    else if (argv[i] === '--repo') { args.repo = argv[i + 1] || ''; i += 1; }
    else if (argv[i].startsWith('--repo=')) args.repo = argv[i].slice('--repo='.length);
  }
  return args;
}

function resolveRepo(explicit) {
  return findCheckout(MODULES, explicit);
}

function upstreamCommit(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

function upstreamDirty(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', ...MODULES],
      { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch (_) {
    return false;
  }
}

function readProvenance() {
  try {
    return JSON.parse(fs.readFileSync(PROVENANCE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Drift can only be measured against the upstream checkout, which exists on a
  // maintainer's machine and nowhere else (not CI, not a published install). So
  // with none named, report and pass instead of failing, like the equivalent case
  // in test/vendor.test.js. The digests themselves are still enforced by `verify`
  // and that same test file, and this check only asks whether upstream has moved
  // since the sync. A checkout that is named but wrong is still an error, and
  // --require-repo makes a missing one an error too.
  if (args.check && !args.requireRepo && !namedCheckout(args.repo)) {
    process.stdout.write('vendor: no QuestLaw extension checkout named (--repo or QUESTLAW_REPO); '
      + 'skipping the upstream drift check (digests are still verified)\n');
    return;
  }

  const repo = resolveRepo(args.repo);
  const commit = upstreamCommit(repo);
  const dirty = upstreamDirty(repo);

  const files = MODULES.map(relative => {
    const source = path.join(repo, relative);
    const bytes = fs.readFileSync(source);
    return {
      file: path.basename(relative),
      source: relative,
      sha256: sha256(bytes),
      bytes: bytes.length,
      content: bytes
    };
  });

  if (args.check) {
    const recorded = readProvenance();
    if (!recorded) {
      process.stderr.write('vendor: no PROVENANCE.json; run without --check first\n');
      process.exit(1);
    }
    const drift = [];
    for (const entry of files) {
      const known = recorded.files.find(item => item.file === entry.file);
      if (!known) drift.push(`${entry.file}: not vendored`);
      else if (known.sha256 !== entry.sha256) drift.push(`${entry.file}: upstream changed`);
    }
    if (drift.length) {
      process.stderr.write(`vendor: drift against ${repo}\n  ${drift.join('\n  ')}\n`
        + 'Run: node tools/vendor-sync.js\n');
      process.exit(1);
    }
    process.stdout.write(`vendor: in sync with ${repo}${commit ? ` @ ${commit.slice(0, 8)}` : ''}\n`);
    return;
  }

  if (dirty) {
    process.stderr.write(
      'vendor: WARNING one of the four modules is uncommitted upstream. The recorded commit '
      + 'will not describe what was copied.\n'
    );
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  for (const entry of files) {
    fs.writeFileSync(path.join(VENDOR_DIR, entry.file), entry.content);
  }

  const provenance = {
    note: 'Generated by tools/vendor-sync.js. Do not edit these files here; '
      + 'the QuestLaw application owns them. Fix upstream, then re-run the sync.',
    upstream: {
      repository: 'questlaw-extension',
      commit,
      dirtyAtSync: dirty
    },
    syncedAt: new Date().toISOString().slice(0, 10),
    files: files.map(({ file, source, sha256: digest, bytes }) =>
      ({ file, source, sha256: digest, bytes }))
  };
  fs.writeFileSync(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);

  process.stdout.write(
    `vendor: wrote ${files.length} modules from ${repo}${commit ? ` @ ${commit.slice(0, 8)}` : ''}\n`
  );
  for (const entry of files) {
    process.stdout.write(`  ${entry.file}  ${entry.bytes} bytes  ${entry.sha256.slice(0, 12)}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`vendor: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { MODULES, VENDOR_DIR, PROVENANCE, sha256 };
