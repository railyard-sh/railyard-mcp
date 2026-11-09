# Install the Railyard MCP server

Connect Codex, Claude Desktop, Claude Code, Cursor, or any MCP client to your Railyard
projects and organisations. Three steps: **get a token → add the server → verify**.

The package requires Node.js 20 or newer.

The server needs three settings, only the first of which is required:

| Setting | Env var | Required | Meaning |
| --- | --- | --- | --- |
| Token | `RAILYARD_TOKEN` | **yes** | Your `ry_…` personal access token. |
| Base URL | `RAILYARD_BASE_URL` | no | Defaults to `https://railyard.sh`. Set it only for a self-hosted or local Railyard backend. Must be `https://`; plain `http://` is accepted only for this machine (`localhost`, `127.0.0.1`, `::1`). |
| Default org | `RAILYARD_ORG` | no | Org id, slug or name to target when a tool call doesn't name one. Defaults to your personal org. |

---

## 1. Get a personal access token

Quick path:

```bash
npx -y railyard-mcp@0.2.1 auth
```

That opens Railyard in your browser so you can sign in and reach token setup. If no browser is available,
run `npx -y railyard-mcp@0.2.1 auth --no-open` and copy the printed URL instead.

Manual path:

1. Sign in to Railyard in your browser (e.g. <https://railyard.sh>).
2. Open **User settings → Personal access tokens**.
3. Create a token, name it, and **copy the `ry_…` secret** — it is shown **once**.

Treat it like a password: it authenticates as you across every org you belong to.
If it ever leaks, revoke it from that same screen and mint a new one.

---

## 2. Add the server to your client

Pick your client. Every snippet uses `npx -y railyard-mcp@0.2.1`, which downloads and runs
that exact published version on demand — no manual install or build. Replace
`ry_your_token_here` with your token. The hosted URL is already the default; add
`RAILYARD_BASE_URL` only if you use a self-hosted or local Railyard instance.

> **Pin a version, and check where it came from.** The server holds your token, so run a
> version you chose rather than whatever is newest: keep the `@<version>` in
> `railyard-mcp@<version>` (`npm view railyard-mcp version` shows the latest) and change it
> deliberately when you upgrade. Releases are published from GitHub Actions with npm
> provenance. To check a version before you use it:
>
> ```bash
> mkdir railyard-mcp-check && cd railyard-mcp-check
> npm init -y >/dev/null && npm install --ignore-scripts railyard-mcp@0.2.1
> npm audit signatures   # look for "verified attestation" on railyard-mcp
> ```
>
> The package page on npmjs.com also shows the provenance, linking the version to the
> commit and workflow run that built it. Versions published before the release workflow
> (0.2.1 and earlier) carry npm's registry signature but no provenance attestation.

> **Running from source instead?** If you have this repo checked out and haven't
> published to npm, swap `"command": "npx", "args": ["-y", "railyard-mcp@0.2.1"]` for
> `"command": "node", "args": ["/absolute/path/to/railyard-mcp/dist/index.js"]`
> (after `npm install && npm run build` in this repo). For the `claude mcp add` form,
> replace `-- npx -y railyard-mcp@0.2.1` with `-- node /absolute/path/to/railyard-mcp/dist/index.js`.

### Claude Desktop — one-click bundle (easiest)

If you have the packaged extension (`railyard-mcp-<version>.mcpb`): open **Claude Desktop →
Settings → Extensions**, drag the `.mcpb` file in (or use **Install extension**),
then paste your token. Leave the optional base URL at its hosted default unless you
self-host. Done — no JSON.

Download the bundle only from the
[GitHub releases](https://github.com/railyard-sh/railyard-mcp/releases), and check it first:
each release attaches a `SHA256SUMS` file and a signed build attestation.

```bash
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS
gh attestation verify railyard-mcp-0.2.1.mcpb --repo railyard-sh/railyard-mcp
```

*(The release workflow builds this bundle from `manifest.json` with `@anthropic-ai/mcpb pack`.)*

### Claude Desktop — manual config

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "railyard": {
      "command": "npx",
      "args": ["-y", "railyard-mcp@0.2.1"],
      "env": {
        "RAILYARD_TOKEN": "ry_your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop. The Railyard tools appear in the tools menu.

### Claude Code

One command (writes it to your config for you):

```bash
claude mcp add railyard \
  --env RAILYARD_TOKEN=ry_your_token_here \
  -- npx -y railyard-mcp@0.2.1
```

Then check it registered with `claude mcp list`. To share it with a repo instead,
add `--scope project` (writes a `.mcp.json` — keep real tokens out of committed files).

### Codex CLI

Need Codex first? Install the Codex CLI:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

One command (writes it to your Codex config for you):

```bash
codex mcp add railyard \
  --env RAILYARD_TOKEN=ry_your_token_here \
  -- npx -y railyard-mcp@0.2.1
```

Then check it registered with `codex mcp list`. To see every MCP command Codex supports,
run `codex mcp --help`.

`codex mcp login railyard` is only for MCP servers that advertise OAuth. Railyard currently
uses a PAT, so use `npx -y railyard-mcp@0.2.1 auth` to open Railyard in your browser, then paste
the resulting token into the `RAILYARD_TOKEN` env var above.

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (this project):

```json
{
  "mcpServers": {
    "railyard": {
      "command": "npx",
      "args": ["-y", "railyard-mcp@0.2.1"],
      "env": {
        "RAILYARD_TOKEN": "ry_your_token_here"
      }
    }
  }
}
```

Reload Cursor, then enable **railyard** under **Settings → MCP**.

### Any other stdio MCP client

Launch this command with the env vars set; the client speaks MCP to it over stdio:

```
command: npx
args:    ["-y", "railyard-mcp@0.2.1"]
env:     RAILYARD_TOKEN=ry_your_token_here
         RAILYARD_ORG=my-team-slug   # optional
```

---

## 3. Verify

Ask your assistant to run the **`whoami`** tool (or "who am I on Railyard?"). It should
return your Railyard user id, email and name — that confirms the token and URL work.
Then try **`list_projects`** to see your projects.

Not working?

- **401 / authentication failed** — the token is wrong, expired or revoked. Mint a fresh
  one. Make sure it starts with `ry_`.
- **Could not reach Railyard** — hosted installs use `https://railyard.sh` automatically.
  If you set `RAILYARD_BASE_URL`, check that it points at a running backend with a database
  configured; the project/org API only exists in that mode.
- **`npx` can't find the package** — check registry/network configuration and confirm the
  published version with `npm view railyard-mcp version`; use the from-source path above while
  validating an unreleased version.
- **`RAILYARD_BASE_URL must use https://`** — the token goes with every request, so plain
  `http://` is refused unless the server is on this machine. Use the server's `https://` address.
- **Railyard answered with a redirect** — the server never follows redirects, so the token can't
  be sent anywhere else. Set `RAILYARD_BASE_URL` to the address the redirect points at (for
  example the `https://` form, or the URL without a trailing path the proxy rewrites).

Full tool reference and the auth model are in the [README](./README.md).
