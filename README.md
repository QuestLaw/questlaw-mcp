# QuestLaw Library MCP

[![CI](https://github.com/questlaw/questlaw-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/questlaw/questlaw-mcp/actions/workflows/ci.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

- [QuestLaw Library MCP](#questlaw-library-mcp)
  - [Overview](#overview)
  - [Quick start](#quick-start)
  - [Set up and install](#set-up-and-install)
  - [Using the server](#using-the-server)
  - [Development and release](#development-and-release)
  - [License](#license)

## Overview

A read-only MCP server that lets an AI client search and read your QuestLaw research library.

### Project status

QuestLaw MCP is an experimental, open-source project for connecting your [QuestLaw](https://questlaw.io) library to AI tools.

The server decrypts your library on your own machine, from a `.qlvault` export generated via the extension. It is read-only and makes no network connections.

#### Disclaimer

This project is not part of the official, supported QuestLaw product suite.

Using it decrypts your library on your computer and gives the readable contents to the AI client you connect it to. That client sends what it reads to its provider. The server itself sends nothing anywhere, but it cannot control what the client or the provider does with what it receives. Please use it with that in mind, and read [SECURITY.md](SECURITY.md) before you connect a library that holds sensitive information.

### How it works

1. In QuestLaw, use the **Export** tool to create an encrypted file of your library (`questlaw-backup-<date>.qlvault`).
2. The server looks for the newest export file in the folder you choose.
3. It decrypts the file _in memory_ with your account key. Your library is never written to disk unencrypted.
4. It builds a search index and answers tool calls.

```
QuestLaw extension          your machine                         AI client
+--------------+            +---------------------------+        +----------+
| encrypted    |  export    | questlaw-library-mcp      | stdio  | Claude,  |
| library      |----------->|                           |<------>| ChatGPT, |
| (IndexedDB)  | .qlvault   | 1. reads the export       |  MCP   | ...      |
+--------------+   file     | 2. unwrap with your key   |        +----------+
                            | 3. decrypt in memory      |
      account key --------->| 4. build a search index   |
   (OS secret store)        | 5. answer tool calls      |
                            +---------------------------+
                            no network connections, no writes
```

## Quick start

```sh
npx -y questlaw-library-mcp@0.5.0 setup
```

`setup` shows the disclosure and asks you to accept it, stores your account key in
the OS secret store, finds your newest export, test-decrypts it, and prints the
configuration for your client. To check an install later:

```sh
npx -y questlaw-library-mcp@0.5.0 doctor
```

From a clone, run the same commands as `node bin/questlaw-library-mcp.js setup` and
`node bin/questlaw-library-mcp.js doctor`. Once `doctor` passes, choose an install
method below.

## Set up and install

### Requirements

- **Node.js 20 or newer.** Version 24 or newer is preferred.
- **A QuestLaw library export.** See
  [Getting your library out of QuestLaw](#getting-your-library-out-of-questlaw).
- **Your 43-character account key.** See [Your account key](#your-account-key).
- **An MCP client.** For example, Claude Desktop, Claude Code, Codex, or any client
  that supports MCP over stdio. ChatGPT requires a
  [Secure MCP Tunnel](#chatgpt).

### Getting your library out of QuestLaw

In the extension, choose **export a backup**. An encrypted library produces a file
named `questlaw-backup-<date>.qlvault`. If you turn on daily backup in the
extension's settings, the extension writes a new file each day, so the AI client
sees recent research without any work from you.

By default, the server reads the newest `.qlvault` in `~/Downloads`. To change that,
set `QUESTLAW_VAULT_FILE` to a specific file or to a different folder.

The server reads a copy of your library from the time of the export, not your live
library. If you add research after the export, the model can't see it until you
export again.

> **Word add-in users:** this server reads only the `.qlvault` export. It has no
> access to your Word documents, and using it with Microsoft Copilot does not change that.

### Your account key

An export's vault key is wrapped with your 43-character account key, so the server
needs that key to open an export. Get it from the extension, under **Settings,
Encrypted library, Show account key**, and then store it:

```sh
npx -y questlaw-library-mcp@0.5.0 setup
```

#### Where the key is kept

| Platform | Store                            |
| -------- | -------------------------------- |
| macOS    | login keychain                   |
| Windows  | DPAPI blob under `%APPDATA%`     |
| Linux    | libsecret, through `secret-tool` |

On macOS and Linux, the key is passed to the store on stdin. On Windows, it is
passed through the child process environment. It never appears in a command line.

**The account key opens every export of your library, so treat it like a
password.** You can supply it through `QUESTLAW_RECOVERY_CODE` instead, but the
server ignores that variable unless you also set `QUESTLAW_ALLOW_ENV_KEY=1`.

### Install

#### Claude Code plugin

The plugin includes the server and a skill that explains to the model how search
works. Download `questlaw-mcp-claude-plugin-<version>.zip` from
[Releases](https://github.com/questlaw/questlaw-mcp/releases), or build it
with `npm run plugin`.

Upload the ZIP through Claude's **Plugins, Upload plugin** control (under
**Customize** or **Settings**, depending on the client). The same ZIP works for
Claude Desktop plugin uploads, Cowork, and Claude Code. The local MCP server runs in
Cowork and Claude Code, and plugin skills also work in chat. See
[Anthropic's plugin guide](https://support.claude.com/en/articles/13837440-use-plugins-in-claude).

The plugin takes no configuration. It reads the newest `.qlvault` in `~/Downloads`,
the key from the `default` account in the secret store, and the consent that
`setup` recorded. Run `setup` before you upload it.

To replace an installed copy, uninstall it before you upload the new archive:

```sh
claude plugin uninstall questlaw-library
```

#### Claude Desktop

- **Plugin upload:** use `questlaw-mcp-claude-plugin-<version>.zip`, as described above.
- **Desktop extension:** use `questlaw-mcp-claude-desktop-<version>.mcpb` from
  [Releases](https://github.com/questlaw/questlaw-mcp/releases), or build it
  with `npm run bundle`. Install it through Desktop's extension installer, and type
  `i-understand` in the required disclosure field.

Either way, store your key first with `setup`.

#### Claude Code without the plugin

```sh
claude mcp add questlaw-library -- npx -y questlaw-library-mcp@0.5.0
```

#### Codex

```sh
codex mcp add questlaw-library -- npx -y questlaw-library-mcp@0.5.0
```

Or add it to `~/.codex/config.toml` directly:

```toml
[mcp_servers.questlaw-library]
command = "npx"
args = ["-y", "questlaw-library-mcp@0.5.0"]

[mcp_servers.questlaw-library.env]
QUESTLAW_VAULT_FILE = "/absolute/path/to/export_folder"
```

Codex saves `env` values in `config.toml` as plain text. Put your export path there
if you like, but keep the account key in the OS secret store. The
`QUESTLAW_ALLOW_ENV_KEY` setting exists to stop the key from ending up in a file
like this one.

The ChatGPT desktop app includes the Codex engine and reads the same
`~/.codex/config.toml`. If you add the server through Codex, it works in the Codex
part of the desktop app, but not in ordinary ChatGPT chats. For those, see the next
section.

#### ChatGPT

ChatGPT can't start a local server itself. Instead, it connects through OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels),
a connection that only goes outbound from your machine. You need developer mode in
ChatGPT and access to the OpenAI developer platform.

**One-time setup:**

1. On platform.openai.com, create a tunnel (its ID starts with `tunnel_`) and a
   runtime API key.
2. Install [tunnel-client](https://github.com/openai/tunnel-client/releases/latest),
   either from that page or with `brew install tunnel-client`.
3. Create a profile. Replace the tunnel ID and both paths with your own:

```sh
export CONTROL_PLANE_API_KEY="sk-..."

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile questlaw \
  --tunnel-id tunnel_YOUR_TUNNEL_ID \
  --mcp-command "/path/to/node /absolute/path/to/questlaw-mcp/bin/questlaw-library-mcp.js"

tunnel-client doctor --profile questlaw --explain
```

4. In ChatGPT, turn on **Settings, Security and Login, Developer mode**.
5. In ChatGPT on the web, create a developer mode app, choose **Tunnel** as the
   connection, and pick the tunnel you created. At the time of writing, this option
   is available on the web but not in the desktop app.

**Each time you want to use it**, start the tunnel and leave it running:

```sh
tunnel-client run --profile questlaw
```

The tunnel client starts the MCP server for you. To check that both are running:

```sh
pgrep -fl "tunnel-client|questlaw-library-mcp"
```

#### Any other stdio MCP client

```json
{
  "mcpServers": {
    "questlaw-library": {
      "command": "npx",
      "args": ["-y", "questlaw-library-mcp@0.5.0"]
    }
  }
}
```

Add an `env` block only to change a default:

```json
{
  "mcpServers": {
    "questlaw-library": {
      "command": "npx",
      "args": ["-y", "questlaw-library-mcp@0.5.0"],
      "env": {
        "QUESTLAW_VAULT_FILE": "/absolute/path/to/export_folder"
      }
    }
  }
}
```

The version is pinned so an install runs exactly the release you checked. To
upgrade, change the version in your client configuration.

Default file locations:

| Client                   | Path                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| Claude Desktop (macOS)   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Claude Code              | `~/.claude.json`                                                  |
| Codex                    | `~/.codex/config.toml`                                            |
| ChatGPT                  | No configuration file. See [ChatGPT](#chatgpt)                    |

The `setup` command prints the exact configuration for your machine.

#### Checking an install

```sh
npx -y questlaw-library-mcp@0.5.0 doctor
```

```
  ok   vendored modules: 4 verified, from questlaw-extension @ 58d523c9 (synced 2026-10-07)
  ok   disclosure: accepted 2026-09-14T22:09:34.603Z
  ok   account key: found in login keychain as "default"
  ok   library export: questlaw-backup-2026-09-09.qlvault, 2.01 MiB, exported 11 days ago
  ok   decrypt: 341 records in 354ms -- 32 cases, 4 projects, 6 relationships, ...

5 passed, 0 warnings, 0 failing
```

## Using the server

### Available tools

| Tool                     | Arguments                                                        | Purpose                                                                     |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `library_overview`       | none                                                             | What the library holds, its projects, courts, and tags, and the export date |
| `list_cases`             | `project`, `court`, `tag`, `sort`, `limit`, `offset`             | Every authority, or a filtered subset, in pages                             |
| `search_library`         | `query`, `types`, `limit`, `offset`                              | One ranked search across everything                                         |
| `search_cases`           | `query`, `project`, `court`, `tag`, `limit`, `offset`            | Saved authorities that match                                                |
| `get_case`               | `guid*`                                                          | One authority in full, with notes, quotations, and related cases            |
| `search_quotes`          | `query`, `limit`, `offset`                                       | Saved quotations that match                                                 |
| `list_project_cases`     | `projectId*`, `sort`, `limit`, `offset`                          | Everything filed under one project                                          |
| `get_source_text`        | `documentId*`, `outline`, `query`, `maxChars`, `offset`, `limit` | Captured text of a statute, regulation, rule, or opinion                    |
| `find_citation_mentions` | `text*`, `limit`, `offset`                                       | Every place a draft cites an authority already in the library               |
| `reload_snapshot`        | none                                                             | Read the newest export from disk again                                      |

An asterisk marks a required argument. The `types` argument accepts any of `case`,
`quote`, and `source`. The `tag` filter matches a whole tag, ignoring case, and the
`court` filter matches any part of a court name.

A typical session starts with `library_overview`, which describes the library. Then
the model calls `search_library` to find something, and `get_case` or
`get_source_text` to read it in full. To list the library instead of searching it,
the model can call `list_cases` with no arguments, and it pages through every
authority, including the ones filed under no project.

Search has a few limits that affect how you phrase a query:

- Search matches words, not meaning, so a query needs the words the user would have
  written.
- Court names are a filter argument, not search text. Almost every court name
  contains "United States", "Court", or "District", so searching those words would
  match almost everything.
- There are no wildcards. A query with no real words lists the library and says so,
  instead of reporting that nothing matched.

Tool results contain text you did not write, such as captured opinions, alongside
your own notes. Treat that text as material to read, not instructions to follow.
[SECURITY.md](SECURITY.md) explains why.

### Configuration

All configuration is through environment variables, and a default install needs
none of them.

| Variable                      | Default                   | What it does                                                         |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------- |
| `QUESTLAW_VAULT_FILE`         | `~/Downloads`             | A `.qlvault` export, or a folder to take the newest from             |
| `QUESTLAW_KEY_ACCOUNT`        | `default`                 | Secret store account holding the key: letters, digits, `.`, `_`, `-` |
| `QUESTLAW_MAX_RESPONSE_BYTES` | `65536`                   | Byte limit per result, kept between 8 KiB and 1 MiB                  |
| `QUESTLAW_DISCLOSURE_ACK`     | unset                     | `i-understand` grants consent from the environment                   |
| `QUESTLAW_ALLOW_ENV_KEY`      | unset                     | `1` lets `QUESTLAW_RECOVERY_CODE` supply the key                     |
| `QUESTLAW_RECOVERY_CODE`      | unset                     | The key itself. Ignored unless the setting above is `1`              |
| `QUESTLAW_CONFIG_DIR`         | `~/.questlaw-library-mcp` | Where consent is recorded                                            |

### Command line

```
questlaw-library-mcp              serve over stdio
questlaw-library-mcp setup        disclosure, key custody, and client config
questlaw-library-mcp doctor       diagnose an install
questlaw-library-mcp consent      read the disclosure; --accept, --revoke, --status
questlaw-library-mcp verify       check the vendored modules against their digests
questlaw-library-mcp --version
```

The `setup` command accepts `--yes` to accept the defaults without asking, and
`--key` to replace a stored key. The `verify` command accepts `--json`.

### Troubleshooting

Start by running `doctor`. The table below lists the error codes the server returns.

| Code                                   | Means                                          | Fix                                                          |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `disclosure_not_accepted`              | Consent has not been given                     | `questlaw-library-mcp consent`                               |
| `account_key_unavailable`              | No key in the secret store                     | `questlaw-library-mcp setup`                                 |
| `invalid_key_account`                  | `QUESTLAW_KEY_ACCOUNT` has unusable characters | Use 1-64 letters, digits, `.`, `_`, or `-`                   |
| `recovery_unwrap_failed`               | The key did not open this export               | Check the key. After a key rotation, use the current key     |
| `recovery_code_malformed`              | Not 43 base64url characters                    | Copy it again, with no spaces or line breaks                 |
| `vault_file_missing`                   | No `.qlvault` where the server looked          | Export a backup, or set `QUESTLAW_VAULT_FILE`                |
| `vault_file_unreadable`                | The file system refused to open the file       | Check the path and its permissions                           |
| `invalid_export_file`                  | Not a readable export                          | Use an unedited `questlaw-backup-*.qlvault`                  |
| `vault_integrity_failed`               | The export failed an integrity check           | Export a fresh backup                                        |
| `vendor_integrity_failed`              | A vendored module does not match its digest    | Reinstall from a trusted source. **Do not run this install** |
| `case_not_found`, `document_not_found` | No record with that id                         | Search first, and pass the id from a result exactly as given |
| `invalid_argument`, `input_too_large`  | Bad tool arguments                             | The message names the argument                               |

In a desktop client, give an absolute path to `node` if you run the server from a
clone. Claude Desktop and the ChatGPT desktop app start servers without loading
your shell profile, so a bare `node` from a version manager is not found. The
secret store commands are called by absolute path on macOS (`/usr/bin/security`)
and Windows (`powershell.exe` under `%SystemRoot%`). On Linux, `secret-tool` must be
on the default `PATH`.

## Development and release

```sh
git clone https://github.com/questlaw/questlaw-mcp.git
cd questlaw-mcp
npm test
```

The server has no runtime dependencies and no build step. `npm install` adds
eslint, which only `npm run lint` uses.

| Command                 | What it does                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm test`              | Runs the test suite against the committed fixture                                                         |
| `npm run lint`          | Runs eslint (after `npm install`)                                                                         |
| `npm run check`         | Runs verify, the vendor drift check, and the tests. Required before publishing                            |
| `npm run eval`          | Measures search relevance against the recorded baseline                                                   |
| `npm run bench`         | Maintainers only: builds a 2,000-case library and measures it                                             |
| `npm run bundle`        | Builds `dist/questlaw-mcp-claude-desktop-<version>.mcpb` for Claude Desktop                               |
| `npm run plugin`        | Builds `dist/questlaw-mcp-claude-plugin-<version>.zip` for Claude plugin uploads, Cowork, and Claude Code |
| `npm run vendor:sync`   | Maintainers only: copies the four core modules again from a checkout                                      |
| `npm run vendor:check`  | Fails if the vendored copies no longer match the checkout                                                 |
| `npm run fixture:regen` | Maintainers only: rebuilds the committed test fixture                                                     |

[CONTRIBUTING.md](CONTRIBUTING.md) covers the workflow for a change.
[REFERENCE.md](REFERENCE.md) describes the export format, the decryption steps, the
record schema, the vendored modules, the project layout, and the rules the tests
enforce. Read it before you change anything under `src/` or `vendor/`.

To point a client at your clone instead of at npm:

```json
{
  "mcpServers": {
    "questlaw-library": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/questlaw-mcp/bin/questlaw-library-mcp.js"]
    }
  }
}
```

`npm run bundle` packs only the files listed under `files` in `package.json`,
checks that the manifest version matches, confirms that the entry point and every
vendored module are present, and writes the `.mcpb`. It needs the system `zip`
command. On Windows, use `npx @anthropic-ai/mcpb pack` instead.

`npm run plugin` puts `.claude-plugin/plugin.json`, `.mcp.json`, and `skills/` at
the ZIP root, and nests the files npm would publish under `runtime/`, because
[Claude rejects uploaded plugins with a top-level `bin/` directory](https://code.claude.com/docs/en/plugins-reference#plugin-directory-structure).
Never put `${user_config.*}` in the plugin's `.mcp.json`. REFERENCE.md explains why,
under "Traps".

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

The license covers the four files in `vendor/questlaw/`, which are copied from the
QuestLaw browser extension's source and published with this package on purpose.
