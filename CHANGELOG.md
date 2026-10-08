# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GPL-3.0-or-later `LICENSE`, replacing `UNLICENSED`.
- CI on Node 20 and 24 across Linux, macOS and Windows.
- Tagged releases carrying the Claude Desktop extension
  (`questlaw-mcp-claude-desktop-<version>.mcpb`), the Claude plugin
  (`questlaw-mcp-claude-plugin-<version>.zip`) and `SHA256SUMS`. File names say
  which client each one is for.
- `SECURITY.md`, `CONTRIBUTING.md` and this changelog.
- CodeQL and OpenSSF Scorecard analysis, and Dependabot for GitHub Actions.
- Progress notifications. If a `tools/call` with `_meta.progressToken` has to wait
  for the library to be read, the server reports each stage of the read, including
  building the search index.
- A relevance evaluation set (`test/eval/`, `npm run eval`) of 68 graded queries
  over a 38-authority corpus, with a baseline that `npm test` enforces.
- Search understands practitioner shorthand in both directions, e.g., `MSJ`, `QI`,
  `CSLI`, `APA`, `FOIA`, and `12(b)(6)`. Results report how the shorthand was read
  in `readAs`.
- `search_library` returns one row for each authority or captured document. Other
  matching quotations or sections are listed under the row as `alsoMatched`.
- The server supports `notifications/cancelled`, and it doesn't answer a cancelled
  request.
- The server reads a newer export in the configured folder on the next tool call,
  without `reload_snapshot`. If the newer export can't be read, the server keeps
  using the library already in memory, and `library_overview` reports the problem
  under `snapshot.newerExportUnreadable`.
- Release downloads carry a signed build provenance attestation, verifiable with
  `gh attestation verify`.
- CI lints every pull request. eslint is the one devDependency and never ships.

### Changed

- The Claude plugin ZIP nests the npm payload under `runtime/` and declares its
  entry point in `.mcp.json`, avoiding the top-level `bin/` directory that Claude
  Desktop/claude.ai plugin uploads reject. The build excludes Finder metadata;
  archive tests verify the root manifest and run the packaged server over stdio.
- Installation docs distinguish plugin ZIP uploads from Desktop `.mcpb` extensions.

- When no upstream checkout exists, `vendor:check` now reports that and passes,
  instead of failing, so `npm run check` can run on CI. `--require-repo` makes it
  fail again. The recorded digests are still checked everywhere.
- The project moved to `questlaw/questlaw-mcp`. Repository URLs in every
  manifest point there, and the MCP registry name is now
  `io.github.questlaw/questlaw-library`.
- Records and manifest shards are decrypted concurrently. A cold read of the
  2,000-case benchmark fell from about 1.1 s to 0.7 s.
- The search index is built while the library is read, instead of on the first
  query.
- Search finds other forms of a word. For example, `moot` finds `mootness`, and
  `redressability` finds `redress`. A misspelling with only one possible correction
  is treated as nearly certain, and search also finds the other forms of the
  corrected word.
- A document where the query words appear close together ranks above a document
  where the same words are far apart.
- Question words, e.g., `what`, `does`, and `how`, no longer count as search terms.
- Snippets show the passage with the most distinct query terms, instead of the
  first place a query word appears. On queries that look for a passage, the snippet
  now shows the answering sentence 100% of the time, up from 60%.
- `find_citation_mentions` finds a citation in any spelling (`603 US 369` for a
  saved `603 U.S. 369 (2024)`), with or without a pincite, and reports every
  occurrence rather than the first. It scans in one pass: 19 ms instead of 2.3 s
  for a 252 KB draft against 20,000 authorities. A row whose spelling differs from
  the library's carries `libraryCitation`.
- The `tag` filter matches a whole tag, ignoring case, instead of any tag
  containing the text. `tag: "law"` no longer matches `administrative law`.
- Tool schemas declare `limit`, `offset`, and `maxChars` as bounded integers and
  allow no undeclared arguments. `true`, `"1e1"`, and fractions are refused instead
  of being read as numbers.
- `setup` and the README pin installs to the exact version
  (`npx -y questlaw-library-mcp@<version>`).
- The secret store is called by absolute path on macOS (`/usr/bin/security`) and
  Windows (`powershell.exe` under `%SystemRoot%`), and the PowerShell calls no
  longer pass `-ExecutionPolicy Bypass`, which did nothing for `-Command`.
- The server no longer loads `readline`, which narrows its builtin modules to
  `child_process`, `crypto`, `fs`, `os`, and `path`.
- Maintainer tools use the extension checkout named by `--repo` or `QUESTLAW_REPO`
  and no longer search sibling directories for one.
- Vendored `search.js` synced from upstream (a faster whitespace fold, no change in
  behavior), and the test fixture regenerated with the current writer.
- Documentation describes only what this server does locally, and no longer makes
  claims about QuestLaw's servers.

### Removed

- `tools/fetch-account-key.js`. Get the account key from the extension's settings.
- `tools/lint.js`. `npm run lint` runs the installed eslint directly.

### Fixed

- The server read the account key from the secret store at startup, before
  checking consent. The key is now read by each load, after the consent check, so
  an install without consent asks the store for nothing.
- `consent --revoke` now stops a running server on its next call, which drops the
  decrypted library, as the revoke message already said. Before, a running server
  kept serving until it restarted.
- A key stored with `setup`, or consent given, while the server is running is
  picked up on the next call. Before, both needed a restart.
- `QUESTLAW_KEY_ACCOUNT` is validated, because Windows joins it into a file path,
  and a name such as `..\..\x` reached outside the key directory. A bad name fails
  as `invalid_key_account`.
- A JSON-RPC request with `"id": null` is answered as Invalid Request instead of
  being treated as a notification and never answered. An input line over 4 MiB is
  dropped as it arrives instead of being buffered without limit, an empty batch is
  an error, and `initialize` is refused inside a batch.
- The newest export is found past a directory named `*.qlvault` or a file that
  disappears while the folder is listed, instead of failing the read.
- GitHub workflows pass the release tag to the shell through the environment, not
  by expanding it inside the script.
- `verify` reports a damaged `PROVENANCE.json` instead of crashing, and checks the
  four files the server loads rather than whatever the provenance lists.
- `npm run bench` crashed when it reached `library_overview`.

- The Desktop extension's export-folder default uses `${HOME}/Downloads`, which
  MCPB supports in user configuration. The server also resolves literal
  `${DOWNLOADS}` and `/${DOWNLOADS}` values saved by older installs, instead of
  reporting `vault_file_missing` for the unexpanded placeholder.
- Requests are handled as they arrive. Before the fix, each request waited for the
  one before it, so a tool call that was waiting for the first decrypt delayed
  `ping`, `tools/list`, and every other request.
- Snippet positions moved by one word at every hyphen in long captured sections,
  so the snippet appeared away from the match.
- A one-word question such as "what" was corrected to the stopword "that".
- Tool results are sent as compact JSON. They used to be indented, and because the
  64 KiB response budget is measured on compact JSON, a full page went about 20%
  over the budget.

## [0.5.0]

These notes were written by comparing the 0.4.1 and 0.5.0 bundles, because the git
history starts after those releases.

### Added

- `list_cases` lists every authority in the library without a query. It supports
  filters, sorting, and pages.
- Filtering by project, court and tag on `search_cases`.
- `library_overview` now reports courts and how much is filed under nothing.
- `get_case` now returns the summary, projects and related authorities.
- `get_source_text` now serves an outline or a query-matched section, not only a
  section by number.

### Changed

- Reworked ranking and result shaping in `src/search-index.js`, `src/projections.js`
  and `src/limits.js`.

## [0.4.1]

- Earlier development. The project's history begins here, and releases before the
  changelog are recorded only in their bundles.

[Unreleased]: https://github.com/questlaw/questlaw-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/questlaw/questlaw-mcp/releases/tag/v0.5.0
[0.4.1]: https://github.com/questlaw/questlaw-mcp/releases/tag/v0.4.1
