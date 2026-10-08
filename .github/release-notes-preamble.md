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
npx questlaw-library-mcp verify
```
