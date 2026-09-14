# Railyard MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an MCP client
(Codex, Claude Desktop, Claude Code, or any other) **read and write** access to your Railyard
projects and organisations. It talks to a running Railyard backend over its REST API and
authenticates with a **personal access token** (PAT).

It speaks MCP over **stdio** and is written in TypeScript against the official
`@modelcontextprotocol/sdk`.

> **Just want to install it?** Jump to [Install](#install) below, or follow the
> standalone [INSTALL.md](./INSTALL.md) — get a token, paste one config block, verify
> with `whoami`.

---

## What it can do

**Projects**

| Tool | Kind | Description |
| --- | --- | --- |
| `list_projects` | read | Projects in an org (id, name, slug, updated-at). |
| `get_project` | read | A project's full JSON document and revision ETag, by id **or** slug. |
| `check_project_name` | read | Whether a name is free in an org (and the slug it would get). |
| `create_project` | write | Create a new, empty project and save it. |
| `update_project` | write · **destructive** | Conditionally save a project via full-document PUT. Merges partial fields by default; can replace the whole document. |
| `rename_project` | write | Change a project's name + URL slug. |
| `delete_project` | write · **destructive** | Permanently delete a project. No undo. |
| `move_project` | write | Move a project into another org you can write to, optionally renaming it in the same step. |

**Validation & export** — these operate on a document, so each takes either a saved project
(`ref`) or an inline `project` you have not saved yet. Neither changes anything stored.

| Tool | Kind | Description |
| --- | --- | --- |
| `validate_project` | read | Current server-side rack-layout/site and power findings for a saved or inline project; structural hierarchy/cabling errors are rejected first. |
| `list_export_formats` | read | The export targets this build supports (`nautobot-csv`, `netbox-csv`, `designbuilder-yaml`, `json`). |
| `export_project` | read | Render a project into a format and return the files' content, unresolved placements and warnings. |

**Organisations, members & billing**

| Tool | Kind | Description |
| --- | --- | --- |
| `whoami` | read | The user your token authenticates as (id, email, name). |
| `server_info` | read | Server health: version, schema version, and whether persistence, auth and billing are configured. |
| `list_orgs` | read | Organisations you belong to — id, slug, role, plan, billing status. |
| `create_org` | write | Create a shared org; you become its owner. |
| `rename_org` | write · owner | Change an org's display name. |
| `delete_org` | write · **destructive** · owner | Delete a shared org **and every project in it**. No undo. |
| `get_org_catalog` | read | The org's shared device-type library and revision ETag. |
| `set_org_catalog` | write · **destructive** | Conditionally replace that library wholesale (not a merge). |
| `get_org_roles` | read | The org's shared device-role vocabulary and revision ETag. |
| `set_org_roles` | write · **destructive** | Conditionally replace the shared role vocabulary wholesale. |
| `list_members` | read | Roster: user id, email, role, joined-at. |
| `set_member_role` | write · owner | Change a member's role. |
| `remove_member` | write · **destructive** · owner | Remove a member and drop their live sessions. |
| `list_invites` | read · owner | An org's pending invitations. |
| `invite_member` | write · owner | Invite an email at a role (needs a current Team/Enterprise plan). |
| `revoke_invite` | write · owner | Withdraw a pending invitation. |
| `list_my_invites` | read | Invitations addressed to *your* email. |
| `accept_invite` | write | Accept one, joining that org. |
| `get_billing` | read | Plan, status, seats, trial/period end, and whether the org is currently entitled to edit. |
| `billing_manage_url` | write · owner | Mint a Stripe Checkout or Customer Portal URL to open in a browser. Creates a link only — it charges nothing. |

The destructive tools (`update_project`, `delete_project`, `delete_org`, `set_org_catalog`,
`set_org_roles`, `remove_member`) are annotated with the MCP `destructiveHint`, so clients that surface tool
safety hints will flag them.

**Not exposed, deliberately.** Personal-access-token management, account deletion and the
starter-example claim are gated to an interactive browser session server-side — a token cannot
drive them (see [Auth model](#auth-model-why-a-pat)). The OAuth/magic-link routes and the Stripe
webhook are not client-callable. Live collaboration is a WebSocket protocol rather than
request/response, so it has no tool; see the caveat on concurrent edits below.

**Org selection.** Every org-scoped tool accepts an optional `org` argument (an org **id**,
**slug**, or **name**). When omitted it falls back to the `RAILYARD_ORG` environment variable,
and if that too is unset, to your first (personal) organisation. Slugs/names are resolved to
the org id the API needs (via `GET /api/orgs`) automatically.

---

## Setup

### 1. Requirements

- Node.js 20 or newer.
- A Railyard account and personal access token. The server connects to
  `https://railyard.sh` by default. Set `RAILYARD_BASE_URL` only when using a self-hosted
  or local backend with persistence and authentication enabled.

### 2. Mint a personal access token

Quick path:

```bash
npx -y railyard-mcp auth
```

That opens Railyard in your browser. Sign in, open User settings if needed, create a token,
and copy the `ry_…` secret. In headless environments, run `npx -y railyard-mcp auth --no-open`
and copy the printed URL.

Manual path:

1. Sign in to Railyard in your browser.
2. Go to **User settings → Personal access tokens**.
3. Create a token, give it a name, and **copy the `ry_…` secret** — it is shown **once**,
   at creation. The server only stores its hash; you cannot retrieve it again.

Treat this secret like a password (see [Auth model](#auth-model-why-a-pat) below).

### 3. Install and build

Only needed to **run from source** (or to develop). If you install the published package
with `npx -y railyard-mcp`, skip this; npm fetches the packaged `dist/` files for you.

```bash
cd railyard-mcp
npm install
npm run build
```

This compiles `src/` to `dist/`. The entry point is `dist/index.js`.

### 4. Configure the environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `RAILYARD_TOKEN` | **yes** | Your `ry_…` personal access token. |
| `RAILYARD_BASE_URL` | no | Railyard base URL. Defaults to `https://railyard.sh`; override it only for self-hosted or local Railyard. |
| `RAILYARD_ORG` | no | Default org (id or slug) for org-scoped tools. |

You can smoke-test it from a shell:

```bash
RAILYARD_TOKEN=ry_xxx npm start
# (it waits on stdio for an MCP client; Ctrl-C to exit)
```

---

## Install

Pick your client and paste one config block. For a friendly step-by-step walkthrough
see the standalone [INSTALL.md](./INSTALL.md); the essentials are below.

**Two ways to run it:**

- **Published (recommended):** `npx -y railyard-mcp` downloads and runs the package on
  demand — no clone, no build. Requires the package to be on npm (see
  [For operators](#for-operators-publishing) if it isn't yet).
- **From source (works today):** run the built entry point directly with
  `node /absolute/path/to/railyard-mcp/dist/index.js` after `npm install && npm run build`
  in this repo (see [Setup](#setup)). Substitute that `command`/`args` in any snippet below.

The published package uses the **hosted** URL `https://railyard.sh` automatically. For a
self-hosted or local backend, add `RAILYARD_BASE_URL` with your own URL (for example,
`http://localhost:8080`). `RAILYARD_ORG` is optional — add it to pin a default organisation.

### Claude Desktop — one-click bundle (`.mcpb`)

The easiest path, no JSON. Open **Claude Desktop → Settings → Extensions**, then drag in
(or **Install extension**) the packaged `railyard-mcp.mcpb` bundle and fill in the token.
Leave the optional base URL at its hosted default unless you self-host. The bundle is built
from [`manifest.json`](./manifest.json) — see [For operators](#for-operators-publishing).

### Claude Desktop — manual config

Add the server under `mcpServers` in `claude_desktop_config.json`:

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
        "RAILYARD_ORG": "my-team-slug"
      }
    }
  }
}
```

Restart Claude Desktop after editing. The Railyard tools then appear in the tools menu.

_From source:_ replace the two command lines with
`"command": "node", "args": ["/absolute/path/to/railyard-mcp/dist/index.js"]`.

### Claude Code

Register it in one command:

```bash
claude mcp add railyard \
  --env RAILYARD_TOKEN=ry_your_token_here \
  -- npx -y railyard-mcp
```

Check it with `claude mcp list`. Add `--scope project` to write a shared `.mcp.json`
instead of your user config (keep real tokens out of committed files). From source, swap
the trailing `-- npx -y railyard-mcp` for `-- node /absolute/path/to/railyard-mcp/dist/index.js`.

A project-level `.mcp.json` takes the same shape as the Claude Desktop block above.

### Codex CLI

Need Codex first? Install the Codex CLI:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Register it in one command:

```bash
codex mcp add railyard \
  --env RAILYARD_TOKEN=ry_your_token_here \
  -- npx -y railyard-mcp
```

Check it with `codex mcp list`. Run `codex mcp --help` to see the rest of the Codex MCP
commands. From source, swap the trailing `-- npx -y railyard-mcp` for
`-- node /absolute/path/to/railyard-mcp/dist/index.js`.

`codex mcp login railyard` is only for MCP servers that advertise OAuth. Railyard currently
uses a PAT, so use `npx -y railyard-mcp auth` to open Railyard in your browser, then paste
the resulting token into the `RAILYARD_TOKEN` env var above.

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), then enable
**railyard** under **Settings → MCP**:

```json
{
  "mcpServers": {
    "railyard": {
      "command": "npx",
      "args": ["-y", "railyard-mcp"],
      "env": {
        "RAILYARD_TOKEN": "ry_your_token_here"
      }
    }
  }
}
```

### Any other stdio MCP client

Launch this command with the environment set; the client speaks MCP to it over stdio:

```
command: npx
args:    ["-y", "railyard-mcp"]
env:     RAILYARD_TOKEN=ry_your_token_here
         RAILYARD_ORG=my-team-slug        # optional
```

> Prefer not to commit real tokens. Keep `RAILYARD_TOKEN` in a private/user-scoped config,
> or inject it from your environment rather than checking it into a shared config file.

### Verify

Run the **`whoami`** tool (or ask "who am I on Railyard?"). It returns your Railyard user
id, email and name — confirming the token and URL work. Then try **`list_projects`**.

---

## Auth model — why a PAT

**A personal access token is the right credential for an MCP server; a session cookie is not.**

- **Non-interactive.** An MCP server runs headless. It cannot complete an interactive
  SSO/OAuth or magic-link sign-in to obtain a session cookie, and a copied cookie is a
  short-lived, browser-bound artefact that expires and can't be rotated cleanly. A PAT is a
  long-lived credential minted *for* programmatic use — exactly this case.
- **It's the backend's intended programmatic credential.** Railyard's API accepts
  `Authorization: Bearer ry_…` on every org-scoped route as a first-class alternative to the
  browser session cookie. This server sends that header on every request.
- **Safer blast radius by design.** Railyard deliberately gates *token management* itself
  (creating or revoking PATs) behind an interactive **browser session only** — a PAT cannot
  mint or revoke tokens. So even if this server's token leaked, an attacker could not use it
  to create more tokens or lock you out of revoking it; you revoke it from the browser.

**What the token carries.** A PAT authenticates as **you**, across **all** your organisations,
with your full role in each. There are **no per-token scopes or expiry yet** — so:

- **Treat the token like a password.** Don't commit it, log it, or paste it into shared
  configs. This server never writes the token to its logs.
- **Scope it operationally.** Only point this server at orgs you intend it to touch (set
  `RAILYARD_ORG`, and be deliberate with write tools). Remember the token can still reach any
  org you belong to if a tool call names one.
- **Rotate on suspicion.** If a token may be exposed, revoke it in **User settings →
  Personal access tokens** and mint a new one. Revocation is immediate.

**Future hardening (not built yet):** per-token scopes (e.g. read-only, or org-restricted)
and configurable expiry would let you hand this server a narrower credential. Today a PAT is
all-or-nothing, which is why the guidance above matters.

---

## How org access & errors map

- **`X-Org-Id` header.** Project-scoped calls send the resolved org **id** in `X-Org-Id`; the
  org-management routes carry it in the path instead. Either way the backend membership-checks
  it and returns **403** if the token's user isn't a member.
- **Roles.** Reads need any membership. Project writes need **editor** or **owner** — a
  **viewer** gets a 403. Managing the org itself (rename/delete, members, invitations, billing)
  is **owner**-only.
- **Billing.** If an org's plan has lapsed it becomes read-only and writes return **402**.
  Inviting members additionally needs a current **Team or Enterprise** plan (402 otherwise).
- **Errors are readable.** HTTP failures are surfaced as `isError` tool results with a plain
  message, e.g. *"Forbidden (403): not a member of this organisation"*, *"Conflict (409): a
  project with that name already exists"*, *"Authentication failed (401): …"*.

---

## Notes & caveats

- **`update_project` is a revision-safe whole-document save.** The API's save endpoint is a `PUT` of the
  entire project JSON. To make partial edits safe, `update_project` defaults to
  `merge=true`: it fetches the current document and shallow-merges the top-level keys you
  supply (so `{racks:[…]}` replaces only the racks). Pass `merge=false` to replace the whole
  document, in which case you must provide a complete, valid project. `get_project` returns a
  `revision`; pass it to `update_project` when the edit was derived from that read. The update is
  refused with 412 if something else saved first. Omitting it still performs a fresh conditional
  read immediately before saving.
- **Shared catalogues and roles are revision-safe whole-array writes.** `set_org_catalog` and
  `set_org_roles` replace their entire arrays. Read the matching resource first, preserve every
  entry you still need, and pass its returned `revision` to the set tool. A concurrent change is
  refused instead of being overwritten.
- **Live collaboration.** If a project is open in a live collaboration session in the app,
  coordinate with the people editing it. Revision checks prevent a stale MCP save from silently
  overwriting a newer room save, but they cannot decide whose intended change should win.
- **Export output is truncated.** A large artefact is cut off in the tool reply with an
  explicit marker (the byte count is always reported in full). Use the app's download for the
  complete file.
- **`export_project` never silently drops data.** A placement whose `deviceTypeRef` matches no
  catalogue entry comes back under `unresolved` rather than vanishing; pass
  `placeholders: true` to emit it as a placeholder device type so the row still imports.
- **Schema.** Documents use `schemaVersion: "1"` and the backend rejects unknown top-level
  fields. The current shape includes `containers`, `containerTypes`, `deviceRoles`,
  `reviewDismissals`, cabling and power data. Use the `project` object returned by `get_project`
  rather than the surrounding revision envelope as the update body.

## For operators (publishing)

Two distribution channels, both from this `mcp/` directory. Neither is done automatically —
these are the manual operator steps.

**npm** (enables `npx -y railyard-mcp` and the config blocks above):

```bash
npm publish            # runs the build first via prepublishOnly; add --access public if you scope the name
```

`package.json` ships only `dist/`, `manifest.json`, `README.md`, `INSTALL.md` and `LICENSE` (see its
`files`), and the `prepare`/`prepublishOnly` scripts rebuild `dist/` so it is always fresh
on publish. The public package name is the unscoped `railyard-mcp`. Publishing remains an
explicit operator action; verify the version, changelog and package contents first.

**Claude Desktop bundle** (`.mcpb`, the one-click install):

```bash
npm run build                       # produce dist/
npx @anthropic-ai/mcpb pack         # bundles manifest.json + dist/ + deps into railyard-mcp.mcpb
```

The bundle is described by [`manifest.json`](./manifest.json): it declares the Node entry
point and a `user_config` that prompts for the token (stored securely) and an optional base
URL that defaults to the hosted service. Distribute the resulting `.mcpb` file for
drag-and-drop install.

## Development

```bash
npm run build      # compile once
npm run dev        # compile on change (tsc --watch)
npm test           # build and run API-contract tests
npm run test:coverage # enforce at least 80% line coverage (Node 22+)
npm run typecheck  # type-check without emitting
```

Source layout:

- `src/client.ts` — the typed HTTP client. All auth (`Authorization: Bearer`), org
  resolution (`X-Org-Id`), revision preconditions (`ETag` / `If-Match`), and error mapping
  live here, in one place.
- `src/auth.ts` — hosted/self-hosted URL validation plus the explicit cross-platform browser
  helper used by `railyard-mcp auth`.
- `src/project.ts` — the canonical empty project factory used by `create_project`.
- `src/index.ts` — the MCP server: tool definitions (zod schemas + annotations) and stdio wiring.
