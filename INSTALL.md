# Install the Railyard MCP server

Connect Claude Desktop, Claude Code, Cursor, or any MCP client to your Railyard
projects and organisations. Three steps: **get a token → add the server → verify**.

The server needs three settings, only the first of which is required:

| Setting | Env var | Required | Meaning |
| --- | --- | --- | --- |
| Token | `RAILYARD_TOKEN` | **yes** | Your `ry_…` personal access token. |
| Base URL | `RAILYARD_BASE_URL` | no | Your Railyard URL. `https://railyard.sh` for the hosted service; your own URL if self-hosted. Defaults to `http://localhost:8080`. |
| Default org | `RAILYARD_ORG` | no | Org id, slug or name to target when a tool call doesn't name one. Defaults to your personal org. |

---

## 1. Get a personal access token

1. Sign in to Railyard in your browser (e.g. <https://railyard.sh>).
2. Open **User settings → Personal access tokens**.
3. Create a token, name it, and **copy the `ry_…` secret** — it is shown **once**.

Treat it like a password: it authenticates as you across every org you belong to.
If it ever leaks, revoke it from that same screen and mint a new one.

---

## 2. Add the server to your client

Pick your client. Every snippet uses `npx -y railyard-mcp`, which downloads and runs
the published package on demand — no manual install or build. Replace
`ry_your_token_here` with your token, and set the base URL to your Railyard.

> **Running from source instead?** If you have this repo checked out and haven't
> published to npm, swap `"command": "npx", "args": ["-y", "railyard-mcp"]` for
> `"command": "node", "args": ["/absolute/path/to/railyard-mcp/dist/index.js"]`
> (after `npm install && npm run build` in this repo). For the `claude mcp add` form,
> replace `-- npx -y railyard-mcp` with `-- node /absolute/path/to/railyard-mcp/dist/index.js`.

### Claude Desktop — one-click bundle (easiest)

If you have the packaged extension (`railyard-mcp.mcpb`): open **Claude Desktop →
Settings → Extensions**, drag the `.mcpb` file in (or use **Install extension**),
then paste your token and base URL into the fields it shows. Done — no JSON.

*(Operators build this bundle from `manifest.json` with `npx @anthropic-ai/mcpb pack`.)*

### Claude Desktop — manual config

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "railyard": {
      "command": "npx",
      "args": ["-y", "railyard-mcp"],
      "env": {
        "RAILYARD_TOKEN": "ry_your_token_here",
        "RAILYARD_BASE_URL": "https://railyard.sh"
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
  --env RAILYARD_BASE_URL=https://railyard.sh \
  -- npx -y railyard-mcp
```

Then check it registered with `claude mcp list`. To share it with a repo instead,
add `--scope project` (writes a `.mcp.json` — keep real tokens out of committed files).

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (this project):

```json
{
  "mcpServers": {
    "railyard": {
      "command": "npx",
      "args": ["-y", "railyard-mcp"],
      "env": {
        "RAILYARD_TOKEN": "ry_your_token_here",
        "RAILYARD_BASE_URL": "https://railyard.sh"
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
args:    ["-y", "railyard-mcp"]
env:     RAILYARD_TOKEN=ry_your_token_here
         RAILYARD_BASE_URL=https://railyard.sh
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
- **Could not reach Railyard** — check `RAILYARD_BASE_URL` points at a running backend
  (with a database configured; the project/org API only exists in that mode).
- **`npx` can't find the package** — it isn't published to npm yet; use the from-source
  path above (`node /absolute/path/to/mcp/dist/index.js`).

Full tool reference and the auth model are in the [README](./README.md).
