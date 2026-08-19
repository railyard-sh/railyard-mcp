# `mcp/` — the Railyard MCP server

`railyard-mcp`: a Model Context Protocol server (stdio) that gives an MCP client (Claude Desktop/Code,
Cursor, …) read + write access to Railyard **over the REST API**, authenticated with a personal access
token. TypeScript on `@modelcontextprotocol/sdk`.

- **Source**: `src/index.ts` (the server + all ~29 tools) and `src/client.ts` (a typed REST client — it's
  an accurate, compact description of the backend API; handy when documenting endpoints). Build: `npm run
  build` (`tsc` → `dist/`); entry `dist/index.js` (has a shebang; `bin` = `railyard-mcp`).
- **Config (env vars, read in `src/index.ts`)**: `RAILYARD_TOKEN` (**required** — a `ry_…` PAT minted in
  the app under User settings → Personal access tokens), `RAILYARD_BASE_URL` (optional; code default
  `http://localhost:8080`, docs use `https://railyard.sh`), `RAILYARD_ORG` (optional default org).
- **Install collateral**: `README.md` (full tool table + copy-paste client configs), `INSTALL.md` (get-token
  → add-server → verify), `manifest.json` (a `.mcpb`/DXT desktop-extension manifest for one-click Claude
  Desktop install), `LICENSE` (MIT).

## Not yet published

The `npx -y railyard-mcp` snippets **only work once the package is published to npm** — that's an operator
action (choose/confirm the public name, `npm publish`, and `npx @anthropic-ai/mcpb pack` to build the
`.mcpb`). Until then, use the from-source path (`node /abs/path/mcp/dist/index.js`).

## Notes

- The tool set covers projects, validation/export, orgs, members/invites and billing. It does **not** yet
  expose the newer org **device-roles** endpoints (`get/set_org_roles`) — add tools mirroring the catalogue
  ones if needed.
- Validate: `npm run build` + `npm run typecheck`. Don't `npm publish` without the operator's go-ahead.
