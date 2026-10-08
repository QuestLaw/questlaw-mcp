# Contributing

## Running it

The server has no runtime dependencies, so the tests need no install step:

```sh
npm run verify   # the vendored modules match their recorded digests
npm test         # the suite
npm run check    # verify + vendor drift + test, the pre-publish gate
npm run eval     # search relevance against the recorded baseline
```

To lint, install the one development dependency, eslint, first:

```sh
npm install
npm run lint
```

eslint never ships. `package.json` `files` leaves it out, and
`test/packaging.test.js` fails if a runtime dependency appears or a development
file would be published. CI lints every pull request.

If you change ranking, tokenizing, or snippets, measure the change with
`npm run eval`. The tests fail if any relevance score drops below
`test/eval/baseline.json`. If you accept a lower score on purpose, record the new
scores with `npm run eval -- --write`, and explain why in the pull request.

You need Node 20 or newer. CI runs the tests on Node 20 (the minimum) and 24 on Linux, macOS,
and Windows.

Everything above works from a clone alone. Three commands are for the maintainer
only, because they load code from the private QuestLaw browser extension that
`vendor/` was copied from: `vendor:sync`, `fixture:regen`, and `bench` (which
writes its test library with the extension's own vault code). Each needs the
checkout named explicitly, with `--repo <path>` or `QUESTLAW_REPO=<path>`. The
tools never search for one, because they `require()` code from it. Contributors
don't need any of the three, because the vendored modules and the test fixture are
both committed. If your change needs one, say so in the pull request, and the
maintainer will run it.

## The vendored modules

`vendor/questlaw/` holds four files copied exactly from the QuestLaw browser
extension. **Never edit them here.** Fix them upstream, and then run, in order:

```sh
QUESTLAW_REPO=<extension checkout> npm run vendor:sync
QUESTLAW_REPO=<extension checkout> npm run fixture:regen
QUESTLAW_REPO=<extension checkout> npm run check
```

The sync rewrites `vendor/PROVENANCE.json` with a new digest and the upstream
commit. `npm run vendor:check` compares the vendored files with the named
checkout. If none is named, it reports that it skipped the check, and
`--require-repo` makes that case an error. With `QUESTLAW_REPO` set, `npm test`
also checks for drift.

## Changes to the manifests

`package.json`, `server.json`, `manifest.json`, and
`plugin/.claude-plugin/plugin.json` each carry a name, a version, a license, and the
repository URL, and `test/packaging.test.js` checks that they agree. The MCP
registry rejects a mismatch at publish time, which happens after the npm package is
already published, so it is cheaper to catch the mismatch in the test.

If you add or rename a tool, update the `tools` array in `manifest.json`. The same
test checks that the listed tools match the tools the server serves.

## Releasing

1. Update the version in all four manifests.
2. Update the pinned `questlaw-library-mcp@<version>` install commands in
   `README.md`. `test/packaging.test.js` fails until they match.
3. Update `CHANGELOG.md`.
4. Run `npm run check`.
5. Tag and push: `git tag v0.5.1 && git push origin v0.5.1`

The tag starts `.github/workflows/release.yml`, which rebuilds the bundle and the
plugin, writes `SHA256SUMS`, attests each file's build provenance, and creates the
GitHub release. Publishing to npm is a separate workflow that you run by hand.
