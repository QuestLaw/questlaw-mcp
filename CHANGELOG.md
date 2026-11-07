# Changelog

## 0.5.2

### Added

- `read_library_text` retrieves exact stored source text, notes, analysis, quotations, and live relationship notes in bounded pages. Existing previews supply `readText`, `readMore`, and match-specific read calls.
- Snapshot-bound continuations detect changed exports instead of combining text from different snapshots.

### Fixed

- Text beyond a section's 8,000-character preview is accessible without pagination
- Source queries use the search engine's phrase, shorthand, and word-form rules.
- Search resolves the correct source section even when IDs are absent or repeated.
- Response budgets account for serialized MCP output and JSON escaping; oversized results fail explicitly. Clipping no longer splits Unicode surrogate pairs.

Earlier release history is available in [GitHub Releases](https://github.com/QuestLaw/questlaw-mcp/releases).
