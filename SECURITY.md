# Security policy

## Reporting a vulnerability

Report problems privately through GitHub's
[security advisories](https://github.com/questlaw/questlaw-mcp/security/advisories/new).
Please don't open a public issue for anything that affects the confidentiality of a
user's library or the handling of their account key.

You can expect a reply within a week. One person maintains the project with help
from the community, so fixes may take time.

## Supported versions

Only the most recent minor release is supported, and fixes are not backported.

## What the project protects

The library is decrypted on the user's own machine, from an export the user already
creates, with an account key kept in the OS secret store. The server only reads, and
no code in it writes to a library. It opens no network connections.

Tests check each of the following properties:

| Property | Enforced by | How to check it yourself |
| --- | --- | --- |
| The server cannot reach the network or write files | `test/module-graph.test.js` records every module the server loads and rejects network builtins and filesystem write calls in `src/` and `bin/` | Read the test, then `npm test` |
| The package installs no third-party code at runtime | There are no `dependencies`, and `test/packaging.test.js` checks this. eslint is a development dependency and is not published | `npm ls --omit=dev --all` |
| Nothing is read or served until the user consents | `src/consent.js` requires the disclosure to be accepted before the key is read from the secret store or the export is opened, and a running server stops serving on the next call after consent is revoked | `node bin/questlaw-library-mcp.js consent --revoke` |
| The four vendored modules that decrypt a library are intact | `src/core-modules.js` checks a sha256 for each file against `vendor/PROVENANCE.json` before loading them | `npx questlaw-library-mcp verify` |

### What the vendor digest check does and does not prove

The digests in `vendor/PROVENANCE.json` ship in the same package as the files they
describe. Anyone who can change a vendored file in a package can also change its
digest, so the check detects accidental drift and corruption. It is not protection
against a tampered package.

To check that what you installed is what this repository built, use the signed
provenance instead:

- **Release downloads** (`.mcpb`, plugin `.zip`) carry a build provenance
  attestation made by the release workflow. Verify one with
  `gh attestation verify <file> --repo questlaw/questlaw-mcp`, and compare
  it against `SHA256SUMS`.
- **The npm package** is published with npm provenance. After installing, run
  `npm audit signatures`.

Don't run an install that fails either check, or that fails `verify`. Reinstall
from a release that passes.

## What the project does not protect

**The project can't protect your library after the server returns it to the AI
client.** The AI client sends what it reads to its provider, and what it reads
includes notes, analysis, and the full captured text of opinions. The encrypted
`.qlvault` export contains more than QuestLaw's ordinary JSON export, which removes
captured opinion text.

No technical control in this project changes that, so the disclosure is a required
configuration field instead of a line in a readme. If a library holds client
confidences, the user has to decide under their professional responsibility rules
whether to send it to an AI provider, and software can't make that decision.

**Tool output can carry prompt injection.** Every result is built from text the
user saved, and much of that text came from someone else: captured opinions,
statutes, and web pages, and quotations taken from them. The user's own notes are
in the same results. Any of it can contain sentences written to look like
instructions to a model. The server returns that text as data and does not try to
detect or remove such sentences. A client that lets a model act on tool output, for
example by running other tools, sending messages, or editing files, should treat
this server's results as untrusted input.

The project also doesn't cover the security of the machine the server runs on, the
OS secret store that holds the account key, or anything the AI client or its
provider does with what it receives.
