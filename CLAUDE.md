# `mcp/` — the Railyard MCP server

`railyard-mcp`: a Model Context Protocol server (stdio) that gives an MCP client (Claude Desktop/Code,
Cursor, …) read + write access to Railyard **over the REST API**, authenticated with a personal access
token. TypeScript on `@modelcontextprotocol/sdk`.

- **Source**: `src/index.ts` (the server + all ~31 tools), `src/client.ts` (the typed REST client and
  revision contract), `src/auth.ts` (base URL validation — https, or http only to loopback — and
  the explicit browser helper), `src/instructions.ts` (the server's MCP `instructions`), and
  `src/project.ts` (the canonical empty project factory). The client is an accurate, compact
  description of the backend API. Build: `npm run build` (`tsc` → `dist/`); entry `dist/index.js`
  (has a shebang; `bin` = `railyard-mcp`).
- **Config (env vars, read in `src/index.ts`)**: `RAILYARD_TOKEN` (**required** — a `ry_…` PAT minted in
  the app under User settings → Personal access tokens), `RAILYARD_BASE_URL` (optional; defaults to
  `https://railyard.sh` and is only needed for self-hosted/local backends), `RAILYARD_ORG` (optional
  default org).
- **Install collateral**: `README.md` (full tool table + copy-paste client configs), `INSTALL.md` (get-token
  → add-server → verify), `manifest.json` (a `.mcpb`/DXT desktop-extension manifest for one-click Claude
  Desktop install), `LICENSE` (MIT).

## Publishing

The public package is `railyard-mcp`. Publishing a GitHub release `v<version>` runs
`.github/workflows/release.yml`: npm trusted publishing with provenance, and the `.mcpb` with
`SHA256SUMS` and a build attestation attached to the release. Releasing remains an explicit operator
action; never publish or create a release from an agent task without approval. Pin every action to a
full commit SHA with a version comment (a test checks this). Use the from-source path
(`node /abs/path/railyard-mcp/dist/index.js`) while validating unreleased changes.

## Notes

- Every tool's MCP annotations are pinned in `test/annotations.test.mjs`; add a row there for a new tool.
  Error text from the server is sanitised and capped in `client.ts` (`parseServerError`); never relay a
  raw response body. Requests use `redirect: "error"`.
- Project, org catalogue and org role replacements are optimistic-concurrency resources. Preserve GET
  ETags and send them through `If-Match`; never add an unconditional overwrite path.
- Validate: `npm test` + `npm run test:coverage` (Node 22+) + `npm run typecheck` +
  `npm audit --audit-level=moderate`. Don't `npm publish` without the operator's go-ahead.
