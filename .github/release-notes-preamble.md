## 0.5.2 — complete stored text retrieval

- The 8,000-character source retrieval issue is fixed.

- Source queries now share search's phrase, shorthand, and word-form rules. This
release also fixes section identification, Unicode clipping, and response budgets.
See [the changelog](https://github.com/QuestLaw/questlaw-mcp/blob/v0.5.2/CHANGELOG.md).

## Updating

- **npm / npx:** change your MCP configuration to `questlaw-mcp@0.5.2`, then
  restart or reconnect your MCP client.
- **Uploaded Claude plugin:** replace the installed copy with the new plugin ZIP.
- **Claude Desktop extension:** install the new MCPB through the extension installer.
- Your stored account key and library export normally do not need changes.
- Confirm that `read_library_text` is available. It follows the server-supplied
  `readText`, `readMore`, `readMatch`, and `nextCall` objects.

## Which file do I download?

| If you use                                     | Download                                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| Claude Code, Cowork, or a Claude plugin upload | `questlaw-mcp-claude-plugin-<version>.zip`              |
| Claude Desktop, as a one-click extension       | `questlaw-mcp-claude-desktop-<version>.mcpb`            |
| Codex, ChatGPT, or any other MCP client        | No download. Run it with `npx`, as the README describes |

Run `setup` once before you install either file, so your account key is stored.

## Verifying this download

Every `.mcpb` and `.zip` attached below carries a signed build provenance
attestation, made by this repository's release workflow from the tagged commit.
Check one before you install it:

```sh
gh attestation verify <file> --repo questlaw/questlaw-mcp
```

Every file is also listed in `SHA256SUMS`. The checksums ship beside the files they
describe, so they catch a corrupted download, while the attestation shows who
built it:

```sh
sha256sum -c SHA256SUMS --ignore-missing
```

After you install it, confirm that the four vendored modules that decrypt your
library are intact:

```sh
npx -y questlaw-mcp@0.5.2 verify
```
