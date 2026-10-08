# Reference for agents working on this server

Read this before changing anything under `src/` or `vendor/`. It describes the file
format the server reads, the decryption chain, the record schema, the search index,
and the rules the test suite enforces. The README covers installing and using the
server, and this document covers how it works inside.

## What this package is

`questlaw-library-mcp` is a read-only MCP server. It finds one encrypted export
file written by the QuestLaw browser extension, decrypts the whole file into
memory, builds a search index over the result, and answers ten tool calls over
stdio. Nothing is written back to the library, and nothing is written to disk in
cleartext.

The server has no network code, no filesystem write call, and no runtime
dependencies. Three test files check those properties, and they are listed under
"Invariants the tests enforce".

## Who owns what

The browser extension lives in a separate, private repository. This package doesn't
need it at runtime, because `vendor/` holds everything the server requires.
The extension owns the data model, the cryptography, and the export format. Four
of its files are copied byte for byte into `vendor/questlaw/`, and they are never
edited here.

| Vendored file | What it does |
| --- | --- |
| `private-work-product-crypto.js` | QL-PWP-1 envelopes, key derivation, record decryption, recovery unwrap |
| `private-vault-protocol-v2.js` | Head and manifest shard shapes, and the checks that verify them |
| `private-vault-backup.js` | Streaming parser for the canonical export file |
| `search.js` | Citation selection: which of a case's citation fields it is known by |

`vendor/PROVENANCE.json` records a sha256 and the upstream commit for each file.
`src/core-modules.js` hashes all four before it requires any of them, and a
mismatch throws `vendor_integrity_failed`, and there is no fallback. To change one of
these files, fix it upstream and then run `npm run vendor:sync`, `npm run
fixture:regen`, and `npm run check` in that order.

## The .qlvault export format

The extension writes `questlaw-backup-<date>.qlvault` into the browser download
folder, either when the user exports a backup or once a day when daily backup is
enabled. The server reads the newest `.qlvault` in `~/Downloads` unless
`QUESTLAW_VAULT_FILE` names a different file or folder.

The file is canonical JSON, which means the top-level keys appear in a fixed sorted
order and the exact bytes matter. Reformatting the file breaks it, because digests
are taken over the exact serialized bytes. A reformatted file fails
with `invalid_export_file` rather than decrypting.

`Backup.CanonicalEncryptedBackupParser` streams the file and emits the two large
arrays through callbacks, so a large export is never held in memory twice. The
table lists the top-level fields in the order the parser expects them.

| Field | Type | What it holds |
| --- | --- | --- |
| `head` | string | The encrypted head envelope, as canonical JSON |
| `headDigest` | string | base64url sha256 of the `head` string |
| `headVersion` | integer | Version of the head record |
| `kind` | string | Always `questlaw-private-vault-export` |
| `protocolVersion` | integer | Always `2` |
| `records` | array | One row per record, each `{blindId, envelope}` |
| `recoveryWrappedVaultKey` | string | The vault key wrapped with the account key |
| `shards` | array | Manifest shards, each `{envelope, shardDigest, shardNumber, shardVersion}` |
| `vaultGeneration` | integer | Increments on every key rotation |
| `vaultId` | string | Identifies the library, and is bound into every derived key |

The format caps a vault at 20,000 records and 256 manifest shards. A record
envelope may be up to 6 MiB, and the whole encrypted payload may be up to 512 MiB.

## The decryption chain

`src/reader.js` runs five steps in order, and any failure stops the read. The steps
match `restoreFromParser` in the extension, except that the server uses the
recovery unwrap instead of the device unwrap. The browser creates the device wrap
key as non-extractable, so the key can't leave the browser, and a Node process can't
use the device path at all.

First, the parser reads the file and rejects anything whose `kind` or
`protocolVersion` is wrong. Second, `unwrapVaultKeyWithRecovery` derives a wrapping
key from the account key and unwraps the 32-byte vault key. Third, the head is
decrypted and checked against `headDigest`, which authenticates all 256 manifest
buckets at once. Fourth, every shard is decrypted and verified against the head, and
the shard set is checked for completeness. Fifth, each record row is matched to its
manifest entry by blind id, checked for size and digest, and decrypted.

The record count in the manifest must equal the number of rows in the file, and
every row must match an entry. Together, the two checks make the mapping one to
one, so every manifest entry is read and every record is listed.

The vault key is zeroed with `fill(0)` after the read. Zeroing shortens the time
the key sits in memory, but it guarantees nothing, because Node may already have
copied the bytes during the unwrap.

## The cryptography, in brief

The suite is `QL-PWP-1`, version 1. Keys are derived with HKDF-SHA-256, records are
encrypted with AES-GCM-256, and data encryption keys are wrapped with AES-KW-256.

The account key is 32 random bytes written as 43 unpadded base64url characters.
`src/reader.js` checks the shape with `/^[A-Za-z0-9_-]{43}$/` before any crypto
runs, so a typo fails as `recovery_code_malformed` rather than as a wrong key.

Key derivation binds three things together, and all three must match or the unwrap
fails. The salt is a digest over `{suite, vaultId}`, the info string is
`questlaw/private-work-product/v1/<purpose>`, and for the recovery path the purpose
is `recovery-key-wrap/generation/<vaultGeneration>`. Because the generation is part
of the purpose, an account key from before a rotation fails on a newer export with
the same unexplained error code as a wrong key. `unwrapFailure()` in
`src/reader.js` tells the user which of the two cases happened, so keep it.

Each record is addressed by a blind identifier rather than by its real id. The blind
id is an HMAC over `{id, kind, vaultId}` under a derived key, so the file reveals
neither record ids nor record types to anyone without the vault key. The additional
authenticated data on each envelope fixes the blind id, the record version, the
vault generation, and the purpose. As a result, nobody can swap a head, a shard, or
a record for another one.

A replay registry tracks every blind id during the record pass. Every record has a
distinct blind id, so a repeated id means the file is malformed, and the read fails.

## Record types and collections

`COLLECTION_BY_RECORD_TYPE` in `src/reader.js` maps the seven record types the
server keeps onto the seven collections every tool reads from.

| Record type in the vault | Collection on the snapshot |
| --- | --- |
| `case` | `cases` |
| `project` | `projects` |
| `relationship` | `relationships` |
| `workspace-section` | `workspaceSections` |
| `document` | `documents` |
| `document-section` | `documentSections` |
| `document-reference` | `documentReferences` |

Any other record type is counted in `skippedRecordTypes` and dropped. In practice,
the only other type is `private-state`, which holds interface state such as the active
workspace and which panels are collapsed. It is dropped during the read rather than
filtered later, so it never reaches a projection.

## Field schema

Field names come from the extension and are not normalized on the way in. Most
fields are optional, and a record written by an older version of the extension may
be missing fields that a newer one always writes. Every reader in `src/` treats a
missing field as empty.

### cases

An authority the user saved, together with their own notes and quotations.

| Field | Notes |
| --- | --- |
| `guid` | The identifier `get_case` takes, and the only stable key |
| `title`, `court`, `jurisdictionText`, `year`, `docketNumber` | Descriptive fields |
| `citation`, `cite`, `functionalCite`, `parallelCitations` | Four citation fields, resolved in that order by `Search.getBestCitation` |
| `projectIds` | Array of project ids. `projectId` is a legacy single-project field that some records still carry |
| `tags` | Array of strings |
| `notes`, `notesHtml` | The user's own notes. Only `notes` is indexed |
| `holding`, `keyFacts`, `whyItMatters` | User-written analysis, usually empty |
| `stance`, `factualSimilarity`, `elementAnalysis`, `authorityKey` | Interface state that no tool returns |
| `dateAdded`, `lastModified` | Millisecond timestamps |
| `quotes` | Array of quotations, described below |

### quotes, nested inside a case

| Field | Notes |
| --- | --- |
| `id` | Present on newer records. The search index falls back to the array position |
| `text` | The quoted passage |
| `highlightText` | What the user selected on the page, which can differ from `text` |
| `citation` | A full citation for the quotation, including its pincite |
| `page` | The pincite. `citationComponents.pincite` is the fallback, and `pincite()` in `src/projections.js` reads both |
| `citationComponents` | Parsed citation parts, including `volume`, `reporter`, `page`, `pincite`, `court`, and `year` |
| `addedAt` | Millisecond timestamp |

### projects

| Field | Notes |
| --- | --- |
| `id`, `uid` | Either one is accepted as a project key by `list_project_cases`, `list_cases`, and `search_cases`. `"none"` selects the authorities in no project at all |
| `name`, `color`, `workspaceType` | Descriptive fields |
| `legalTest`, `legalTests`, `factPattern` | Matter analysis that no tool returns |

### documents and documentSections

A document is one captured source, and its sections are the text of that source in
reading order.

| Field | Notes |
| --- | --- |
| `documentId` | The identifier `get_source_text` takes |
| `authorityGuid` | Links the document back to a case, and is how `get_case` finds captured sources |
| `contentType` | `statute`, `regulation`, `court_rule`, `case`, and others |
| `sourceTitle`, `sourceCitation`, `sourceUrl`, `platform`, `publisherTitle` | Descriptive fields |
| `capturedAt`, `currentness`, `provenance` | Capture metadata that no tool returns |

A section carries `sectionId`, `documentId`, `parentSectionId`, `order`, `depth`,
`label`, `labelKind`, `heading`, `text`, and `status`. Sections are sorted by
`order` when the snapshot index is built, and `get_source_text` pages through them
by position rather than by `sectionId`.

### relationships

A relationship is a link between two authorities. It has a `fromGuid`, a `toGuid`, a
`type` such as `distinguishes` or `follows`, and the user's `note` explaining it. It
also has `suppressedAt`. A link with a non-zero `suppressedAt` or any `deletedAt` is
not live, and it is dropped. `edgesByAuthority()` in `src/search-index.js` indexes
the live links from both ends. Both `indexFor()` and the search index read links
through it, so the two always agree about which links count.

`get_case` returns them under `related`, and the index carries them as the case
field `related` at weight 2, so the note is searchable from either end and a
snippet on it reports `field: "related"`.

Direction is easy to get wrong. "Loper Bright distinguishes Lujan" and "Lujan
distinguishes Loper Bright" are different claims, so `relatedAuthority()` composes the sentence
once in stored `from -> to` order and returns it as `reads`. `title` is always the
authority at the far end, and `direction` is `outbound` when the authority being
read is the `from` end. A caller that only reads `reads` cannot invert the claim.

### workspaceSections, documentReferences

Both are decrypted, grouped, and counted by `library_overview`, and no tool returns
their contents. Workspace sections hold `name` and `notes`, which are outline notes
for a brief. They are the largest body of research in the vault that no tool reads
yet. To expose them, you would add a projection, a tool, and index fields.

## What the encrypted export carries that the JSON export does not

`portableCollections()` in the extension keeps only three content types of
`documents` in the JSON export, which are `statute`, `regulation`, and `court_rule`. Sections and references
belonging to any other document are dropped along with it. The `.qlvault` keeps
everything, so captured opinion bodies are present in the encrypted export and
absent from the ordinary JSON export.

The disclosure exists because of this difference, and the disclosure text states it
in a sentence that `test/consent.test.js` checks word for word. Changing the
sentence breaks the test on purpose. `test/reader.test.js` checks the same fact from
the other side, by asserting that a captured opinion body is still present after the
read. The committed fixture covers both
cases, because it contains one `statute` document that the JSON export keeps and one
`case` document that the JSON export drops.

## The search index

`src/search-index.js` builds one BM25F index per snapshot. BM25F is a standard
ranking formula that scores each field of a document separately and weights the
fields. The index holds three kinds of document:

- each case, as one document
- each quotation that has text, as its own document
- each non-empty section, as a source document

The index is held in a `WeakMap` keyed by the snapshot, so a reload discards the old
index along with the old data.

Field weights decide ranking, so when results come back in the wrong order, check
the weights first.

| Kind | Fields and weights |
| --- | --- |
| `case` | title 8, citation 6, tags 5, holding 4, keyFacts 3, whyItMatters 3, court 2, notes 2, related 2, quotes 1.5 |
| `quote` | text 4, citation 3, caseTitle 2 |
| `source` | heading 5, docTitle 4, docCitation 4, text 2 |

The `court` field is indexed without the words that every court name shares.
`genericCourtTerms()` drops a fixed list of stemmed words, which are court, united,
states, district, appeals, circuit, and division. In a library with at least eight
courts, it also drops any other word that appears in more than half of the court
names. Words that contain a digit are never dropped, so a circuit number and a year
stay in the index.

The list exists because "United States Court of Appeals for the Ninth Circuit" and
"United States District Court for the District of Massachusetts" share four words.
Before the change, a query like `circuit court appeals` matched every federal
authority with a believable score. IDF, the part of BM25 that discounts common
words, can't fix the problem alone, because in a 30-record library those words are
not rare enough to discount. The words that remain are the ones that tell one court
from another. To filter by court, a caller uses the `court` argument on
`search_cases` and `list_cases` instead. A dropped query word that matched nothing
else is returned in `ignoredCourtTerms`, and the tools turn it into a `note` that
names the filter.

A query that parses to no terms at all, e.g., an empty query, punctuation, or `*`,
lists documents instead of failing. `search()` returns every document of the
requested types in stored order, with `browsed: true`, `relevance: null`, and no
snippet, and the tools add a `note` that explains what happened. The server used to
return zero hits for `*`, which looked the same as an empty library, and callers
then guessed keyword after keyword to find out what was there.

BM25 uses k1 of 1.2 and b of 0.75. A satisfied quoted phrase multiplies the score by
2.5, and a document that fails any quoted phrase is dropped rather than demoted.

Every query term is expanded into related words before scoring, and every related
word scores lower than the word as typed. If the index holds the term, the term also
matches its longer forms at half weight, using the suffix table
`DERIVATIONAL_SUFFIXES`. For example, `moot` finds `mootness`, and `reasonable`
finds `reasonableness`. A known term is never cut down to a shorter one, because
`judgment` minus `-ment` is `judg`, which is also the stem of `judged`. If the index
has never seen the term, the term goes through three steps:

1. **Shared prefix expansion.** This step connects real word pairs such as
   `deferential` and `deference`, where neither word is a prefix of the other.
2. **The word family, with suffixes removed.** For example, `redressability`
   matches `redress`. The server always adds these words, but they don't count as
   having found the term.
3. **Damerau edit distance.** This step runs only when prefix expansion finds
   nothing. A swap of two adjacent letters counts as one edit, so `jugdment` finds
   `judgment`. A typo with exactly one correction is weighted 0.8, and a typo with
   several corrections gives each one a weight of 0.3. The corrected word then
   matches its own related words, so `plausable` finds `plausibility` through
   `plausible`. Stopwords are never offered as corrections, so `what` is not
   treated as a typo for `that`.

`src/legal-terms.js` expands practitioner shorthand, and it is the only place where
search uses a list written by hand. `MSJ`, `QI`, `CSLI`, `APA`, `FOIA` and a few others search for
what they stand for, and the spelled-out form also searches for the shorthand.
`12(b)(6)` reads as "failure to state a claim". Readings score at 0.8 and come back
in `readAs`, which the tools pass on. Shorthand with more than one meaning, such as
`PI`, is left out on purpose, because a wrong reading ranks the wrong authorities.

When unquoted query words appear within two positions of each other in one field,
the document's score rises by up to half. For example, "arbitrary and capricious"
counts as close together. The increase depends on how many pairs of neighboring
query words the document keeps together, and only the 500 best candidates are
checked.

`search_library` passes `group: true`, so each record takes one row. An authority's
matching quotations are grouped under the authority, and a captured document's
matching sections are grouped under its best section. The grouped hits are returned
as `grouped`, which holds the first three, and `groupedTotal`, and the tool shows
them as `alsoMatched`. A captured document is not grouped under the authority it was
saved with, because a statute captured while reading an opinion is still a separate
statute.

A snippet is the stretch of about 240 characters that contains the most weight of
distinct query terms, with rarer terms weighing more. It is not simply the first
place a query word appears. The server maps word positions back to characters by
repeating the same splits the tokenizer uses. An earlier version counted words
separated by spaces instead, which drifted by one at every hyphen, and in a long
opinion section it put the snippet several paragraphs away from the match.

### Citation mentions

`find_citation_mentions` doesn't use the index above or the vendored exact-string
scan. `src/citations.js` folds each stored citation (`Search.getBestCitation` and
every entry of `parallelCitations`) to lowercase letters and digits, with accents
removed as the tokenizer removes them, and drops a trailing parenthetical, so
`603 U.S. 369 (2024)` is stored as `603us369`. The draft is folded the same way,
and a citation matches wherever its folded form starts and ends on a word boundary
of the folded draft. So `603 US 369`, `603 U. S. 369`, and `603 U.S. 369, 412`
all match, and `1603 U.S. 369` does not.

Folded citations are bucketed by their first three characters when the snapshot
is read, so a scan is one pass over the draft whatever the library's size. The
vendored scan ran one `indexOf` per citation over the whole draft: on 20,000
authorities and a 252 KB draft it took 2.3 seconds and reported one mention, where
the index takes about 19 ms and reports all 2,900. Every occurrence is reported,
in order, and paged with `limit` and `offset`. A row's `citation` is the text as
the draft wrote it, and `libraryCitation` is added when the library spells it
differently. Where a short and a long citation of the same case both match at one
place, the case is reported once, under the longer one.

### Measuring relevance

`test/eval/` holds a plaintext corpus of 38 authorities and 8 captured documents.
It also holds 68 queries with graded judgments, grouped by kind: names, citations,
doctrine, typos, word forms, shorthand, proximity, phrases, passages, mixed
searches, and notes. `npm run eval` prints nDCG@10, record-level nDCG@10, MRR@10,
recall@25, and the share of passage queries whose snippet shows the answer, each
next to the recorded baseline. These are standard search quality measures, and
higher is better for all of them. `npm run eval -- --worst` lists the queries that
score lowest. `test/relevance.test.js` fails when any score drops below
`test/eval/baseline.json`. A deliberate trade is recorded with `npm run eval --
--write`, so the new numbers show up in the diff.

The corpus and its judgments were written by hand for this purpose. They catch
regressions and show whether a change helps, but they are not a real library.
Queries from real use would improve the set more than anything else.

## The tokenizer

`src/tokenize.js` normalizes text before splitting it into words, and the
normalization is what lets search find legal citations.

A run of single letter abbreviations is joined, so `u.s.` becomes `us` and
`f.supp.` becomes `fsupp`. A letter followed by a period and a digit joins, so
`f.3d` becomes `f3d`. A section symbol becomes the word `section`, and a doubled
one becomes `sections`. A volume, reporter, and page run additionally emits one
joined term at the position of its first word, so `603 U.S. 369`, `603 U. S. 369`,
and `603 US 369` all produce `603us369` and match each other exactly.

Stemming, which reduces words to a common base form, is kept light on purpose. It
covers plurals and the common verb endings instead of using a full Porter stemmer,
because heavy stemming damages legal vocabulary.
Endings in `ss`, `us`, and `is` are not treated as plurals, which is what keeps
`amicus`, `class`, and `analysis` intact.

The file has two details that look odd, and the code depends on both. First, the
marker that separates segments is built with `String.fromCharCode(0)` instead of
written as a literal, because a literal NUL byte in source makes git and grep treat
the file as binary. `test/module-graph.test.js` scans every `.js` file under `src`,
`bin`, `cli`, `tools`, and `test` for raw control characters, and it fails if it
finds one. Second, the marker advances the position counter by 100, which stops a
phrase search from matching words that run from the end of one saved quotation into
the start of the next.

## Response shape and limits

`src/limits.js` holds every size limit. Results are limited by serialized bytes
instead of by row count, because one authority with a 40 KiB note uses more of the
budget than forty authorities with no notes. A 2,000-case library serializes to
about 3.5 MiB, or roughly a million tokens, so the server can't return a whole
library of any realistic size.

The byte budget defaults to 64 KiB, and it is the only limit you can change. You
set it with `QUESTLAW_MAX_RESPONSE_BYTES`, which is kept between 8 KiB and 1 MiB.
Rows are limited to 50, and each field is shortened before the budget applies, so
one field can't use up the whole budget. Every list result reports `matched`, which is the true count, alongside
`returned`. A truncated result always says how to get the rest, and
`get_source_text` returns a `nextOffset` rather than dropping the tail.

Every list tool takes an `offset` and returns it. When a page stops before
`matched` is reached, because of either the caller's `limit` or the byte budget,
the result carries `nextOffset` and a `truncated` sentence naming the call that continues it.
`listResult()` emits `nextOffset` only for tools that passed an `offset`, so a tool
that cannot page never advertises paging.

Input is bounded too. `src/rpc.js` splits stdin into lines itself and drops any
line longer than `LIMITS.maxMessageBytes` (4 MiB) as it arrives, answering it with
one Invalid Request error, so a client that never sends a newline can't grow the
server's memory without limit. A request with a null or non-scalar id, a missing
method, an empty batch, or `initialize` inside a batch is answered as Invalid
Request. Nothing waits for `initialize`, because some clients skip it.

`caseSummary()` adds a `summary` and a `summarySource` to every case row. The server
generates nothing for the summary. It takes the first non-empty field out of
`holding`, `whyItMatters`, `keyFacts`, `notes`, and the first saved quotation, and it
cuts the text to `LIMITS.summaryChars`, at the end of a sentence when possible.
`summarySource` is included because a working note and a holding mean different
things in a brief. An empty `summary` is returned instead of left out, because
knowing that the user wrote nothing on a record saves a `get_case` call.

`get_source_text` has four ways to return less than everything: `outline: true` for
structure with no text, `query` for only the sections that match it, `maxChars` for a
character budget across the page, and `offset` with `limit` for ordinary paging.
Every section carries its `index` in the document and its true `chars`, so an excerpt
can always be turned back into a full read of one section.

`src/projections.js` decides what a tool may return about a record. Summaries
identify the authority, and details show what it says. Fields such as `stance`,
`elementAnalysis`, and `authorityKey` mean nothing outside the extension, so they
are never returned, and the byte budget is spent on research instead.

## The consent gate

`src/consent.js` reads consent and `cli/consent.js` writes it, and the split exists
because `test/module-graph.test.js` asserts that no shipped source file under `src/`
or `bin/` contains a filesystem write call.

`requireConsent()` runs at the top of `loadSnapshot()`, before the key is read and
before the file is opened. The order is important, because a server that decrypts
the library and then refuses to answer has already done what consent is meant to
prevent. Reading the key counts too: it can show a keychain prompt and hands the key
to the process. So `createServer()` doesn't read the key at startup. It gives the
store `resolveVaultKey`, and each load calls it after the consent check.
`test/consent.test.js` runs the real server wiring without consent and asserts the
key reader is never called.

Consent is checked again on every tool call, which is one small file read. If it
has been revoked, the store drops the decrypted library and every tool answers
`disclosure_not_accepted`, including `reload_snapshot`, which otherwise keeps
serving the old library when a reload fails. Once consent is given again, the next
call reads the export afresh.

Consent arrives one of two ways. `questlaw-library-mcp consent` writes
`~/.questlaw-library-mcp/consent.json`, and `QUESTLAW_DISCLOSURE_ACK=i-understand`
grants it from the environment, which is what the Claude Desktop bundle's required
configuration field sets. Bumping `DISCLOSURE_REVISION` invalidates every recorded
acceptance, because an older revision is not consent to the current text.

## Key custody

`src/credentials.js` reads the account key from the operating system secret store
through a frozen command table, with one entry per platform. macOS uses the login
keychain through `/usr/bin/security`, Linux uses libsecret through `secret-tool`,
and Windows reads a DPAPI blob through a constant PowerShell body that interpolates
nothing, run by the `powershell.exe` under `%SystemRoot%`. Binaries with a fixed
home are called by absolute path, so a directory earlier on `PATH` can't stand in
for the store. `secret-tool` has no fixed home across distributions. The write side,
`cli/keystore.js`, takes its commands from the same table.

The account name is the only variable, and it is always its own argv entry. Two
tests check this. The first passes a malicious account name through every platform
entry and asserts that it stays one argument. The second asserts that the Windows
script body doesn't change with input. Windows also joins the name into a file path
(`<account>.dpapi`), which argv separation doesn't protect, so `checkAccount()`
allows only 1 to 64 letters, digits, dots, underscores, and hyphens, and not a name
made only of dots. Both the read and the write side check it, and a bad name fails
as `invalid_key_account` before any store is run.

`QUESTLAW_RECOVERY_CODE` is a fallback and is ignored unless
`QUESTLAW_ALLOW_ENV_KEY=1` is also set. The opt-in is checked before the secret
store, because you only set it to open a vault other than the stored one, such as
the test fixture. A default install therefore cannot end up with a
library-opening secret sitting in an MCP client's configuration file.

## Error handling

`src/errors.js` defines one error shape for the whole package. Every failure a user
can cause reaches the client as a stable `code`, a sentence the model can relay, and
a `hint` naming the next action. The underlying protocol or crypto code goes into
`detail`, so a bug report can name the exact check that failed, without showing a
crypto error code to a lawyer.

The server handles two kinds of failure differently on purpose. A vendored module
that fails verification means the install is broken, so the process exits, because
no tool call could succeed and nothing the user does inside the client would help. A missing
export or a rejected account key keeps the server up and answers every tool with a
structured error, because the user can fix both and can only be told through the
client they are already talking to. A read that failed on consent or a missing key
is retried on the next call after the two-second freshness interval, so running
`consent` or `setup` while the server is up takes effect without a restart.

A tool failure comes back as a result carrying `isError`, not as a JSON-RPC error,
so the model can respond to the error instead of treating the connection as broken.

## Invariants the tests enforce

The suite runs with no checkout and no network, because
`test/fixtures/library.qlvault` is committed. A change that breaks one of the
following tests also breaks a promise the README makes to users.

- `test/module-graph.test.js` records the module graph by hooking `Module._load`
  while the server is required. It asserts that no network builtin appears, that the
  builtin surface is exactly `child_process`, `crypto`, `fs`, `os`, and `path`,
  that nothing outside the package is loaded, and that no shipped source
  file contains a filesystem write call or a raw control character.
- `test/vendor.test.js` checks each digest, checks that the loader refuses a
  mismatch, and, when a checkout happens to be present, checks the copies still
  match upstream.
- `test/negative-controls.test.js` tampers with the fixture thirteen ways and
  asserts each one is refused, covering a wrong key, a rewritten head digest, a
  bumped generation, a swapped pair of records, and a truncated file. A final
  control asserts that an untampered read still works after all of them.
- `test/plugin.test.js` asserts that the plugin's `.mcp.json` contains no
  `user_config` reference, that the manifest declares no `userConfig`, and that no
  environment value carries an unresolved `${...}`.
- `test/packaging.test.js` asserts that `package.json`, `manifest.json`, and
  `server.json` agree on a version, that `mcpName` matches the registry name, and
  that nothing carrying library data or key material ships.

## Traps

Don't put `${user_config.*}` in the plugin's `.mcp.json`. The server won't start
when those values were never collected, and they never are, because uploading a
plugin installs and enables it without showing the prompt that collects them.
Nothing reports the failure. `claude plugin details` still counts the MCP server,
`claude mcp list` leaves it out, and `--debug` prints nothing. So the user gets the
skill, which describes tools that aren't there. Every value the plugin needs has a
working default, so the plugin takes no configuration at all.

Reading Chrome's IndexedDB directly does not work. The device wrap key is created as
non-extractable, and `assertDeviceWrapKey` checks it again.
`test/negative-controls.test.js` proves that the browser refuses to export the key
at any privilege level. The recovery path is the only way to open the library from
outside the browser.

Nothing under `src/`, `cli/`, or `bin/` may require anything in `tools/`. Those
scripts are for maintainers, `tools/checkout.js` loads code from a QuestLaw
extension checkout, and none of it ships in the npm package.

## Where things live

```
bin/          entry point; routes subcommands, never writes
src/          the server. read-only, offline, no dependencies
  server.js       wiring and startup
  rpc.js          MCP stdio transport: newline-delimited JSON-RPC 2.0
  tools.js        the ten tools
  citations.js    where a draft cites the library, for find_citation_mentions
  snapshot.js     finding, loading, and holding the decrypted library
  reader.js       the decryption chain
  search-index.js BM25F index and query planner
  legal-terms.js  practitioner shorthand and what it stands for
  tokenize.js     legal-aware tokenizing and stemming
  projections.js  what a tool is allowed to say about a record
  limits.js       every ceiling in one place
  credentials.js  reading the platform secret store
  consent.js      the disclosure gate, read side only
  errors.js       one error shape
  core-modules.js loads vendor/ and verifies it
  vendor-check.js the digest check itself, shared with `verify`
cli/          commands that may write: setup, doctor, consent, verify, keystore
plugin/       Claude Code plugin scaffold: manifest, .mcp.json, and the skill
tools/        development only: vendor sync, fixture regen, bench, eval, builds
vendor/       the four QuestLaw modules, with provenance
test/         the suite, the committed fixture, and eval/ (the relevance set)
```
