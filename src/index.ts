#!/usr/bin/env node
// Railyard MCP server (stdio).
//
// Exposes Railyard's project + organisation API to an MCP client (Claude Desktop, etc.)
// as tools: projects (list/read/create/update/rename/move/delete), validation and export,
// organisations, members and invitations, and billing state. Authentication is a Railyard
// personal access token — see README.md.
//
// Not exposed, deliberately: personal-access-token management, account deletion and the
// starter-example claim are gated to an interactive browser session server-side, so a token
// cannot drive them; the OAuth/magic-link routes and the Stripe webhook are not client-callable;
// and live collaboration is a WebSocket protocol, not a request/response tool.
//
// Transport is stdio: stdout is the JSON-RPC channel, so ALL diagnostics go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RailyardApiError, RailyardClient, type ExportFile, type Project } from "./client.js";

// ---- configuration (from the environment) -----------------------------------

const DEFAULT_BASE_URL = "http://localhost:8080";

const baseUrl = process.env.RAILYARD_BASE_URL?.trim() || DEFAULT_BASE_URL;
const token = process.env.RAILYARD_TOKEN?.trim() || "";
const defaultOrg = process.env.RAILYARD_ORG?.trim() || undefined;

if (!token) {
  console.error(
    "railyard-mcp: RAILYARD_TOKEN is not set. Mint a personal access token in Railyard " +
      "(User settings → Personal access tokens) and set RAILYARD_TOKEN to the ry_… secret.",
  );
  process.exit(1);
}
if (!token.startsWith("ry_")) {
  // Not fatal — but the server only accepts ry_-prefixed tokens, so warn early.
  console.error('railyard-mcp: warning — RAILYARD_TOKEN does not start with "ry_"; Railyard will reject it.');
}
if (!process.env.RAILYARD_BASE_URL) {
  console.error(`railyard-mcp: RAILYARD_BASE_URL not set; defaulting to ${DEFAULT_BASE_URL}.`);
}

const client = new RailyardClient({ baseUrl, token, defaultOrg });

// ---- tool result helpers ----------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a tool body, converting any thrown error into a readable isError result. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RailyardApiError) return fail(e.message);
    return fail(`Unexpected error: ${(e as Error).message}`);
  }
}

// ---- shared schema fragments ------------------------------------------------

const orgArg = z
  .string()
  .optional()
  .describe(
    "Organisation to target: an org id (org_…), slug, or name. " +
      "Defaults to RAILYARD_ORG, or to your first (personal) org if that is unset. " +
      "Use list_orgs to see the options.",
  );

const roleArg = z
  .enum(["viewer", "editor", "owner"])
  .describe("viewer = read-only, editor = can create and change projects, owner = full control including members and billing.");

/** Build a minimal, server-valid project document with a fresh client-minted id. */
function minimalProject(name: string): Project {
  const rand = Math.random().toString(36).slice(2, 8);
  const id = `prj_${Date.now().toString(36)}${rand}`;
  return {
    schemaVersion: "1",
    id,
    name,
    createdAt: new Date().toISOString(),
    locations: [],
    dataCentres: [],
    rows: [],
    racks: [],
    podPatterns: [],
    namingRules: [],
    catalogue: [],
    rackTypes: [],
    meetMeRooms: [],
    cables: [],
    powerLinks: [],
  };
}

/**
 * Resolve the document a validate/export call should operate on: either a stored project named
 * by `ref` (fetched), or an inline `project` document passed straight through — which lets a
 * caller check a draft it has not saved.
 */
async function documentFor(
  ref: string | undefined,
  inline: Record<string, unknown> | undefined,
  org?: string,
): Promise<Project> {
  if (inline) return inline as Project;
  if (!ref) {
    throw new RailyardApiError(400, "Pass either `ref` (a saved project's id or slug) or `project` (an inline document).");
  }
  return client.getProject(ref, org);
}

/**
 * Render an exported file for the model. Every current target emits text (CSV, YAML, JSON), so the
 * base64 payload is decoded; a large artefact is truncated with an explicit marker rather than
 * flooding the conversation — `download` the format from the app for the untruncated file.
 */
const MAX_FILE_CHARS = 60_000;

function renderExportFile(f: ExportFile): { name: string; mime: string; bytes: number; content: string; truncated?: true } {
  const raw = Buffer.from(f.contentBase64, "base64");
  const text = raw.toString("utf8");
  if (text.length <= MAX_FILE_CHARS) {
    return { name: f.name, mime: f.mime, bytes: raw.byteLength, content: text };
  }
  return {
    name: f.name,
    mime: f.mime,
    bytes: raw.byteLength,
    content: `${text.slice(0, MAX_FILE_CHARS)}\n… truncated (${raw.byteLength} bytes total) …`,
    truncated: true,
  };
}

// ---- server -----------------------------------------------------------------

const server = new McpServer(
  { name: "railyard-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---- read tools -------------------------------------------------------------

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    description:
      "Return the Railyard user the configured personal access token authenticates as " +
      "(id, email, name). Use this to confirm the token works and which account it belongs to.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  () => guard(async () => ok(await client.me())),
);

server.registerTool(
  "list_orgs",
  {
    title: "List organisations",
    description:
      "List the organisations the token's user belongs to, with each org's id, slug, role " +
      "(viewer/editor/owner), plan and billing status. The id or slug is what you pass as the " +
      "`org` argument to other tools.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  () => guard(async () => ok(await client.listOrgs())),
);

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description:
      "List projects in an organisation (id, name, slug, last-updated time). " +
      "Omit `org` to use the default organisation.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) => guard(async () => ok(await client.listProjects(org))),
);

server.registerTool(
  "get_project",
  {
    title: "Get project",
    description:
      "Fetch a project's full JSON document, addressed by its id or its URL slug. " +
      "The document is the complete estate model (locations, dataCentres, rows, racks with " +
      "placements, catalogue, cables, …) — the same shape update_project expects.",
    inputSchema: {
      ref: z.string().min(1).describe("The project's id (prj_…) or its URL slug."),
      org: orgArg,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ ref, org }) => guard(async () => ok(await client.getProject(ref, org))),
);

server.registerTool(
  "check_project_name",
  {
    title: "Check project name availability",
    description:
      "Check whether a project name is free in an organisation (and see the URL slug it would " +
      "get). Optionally `exclude` a project id so a rename that keeps its own name reads as available.",
    inputSchema: {
      name: z.string().min(1).describe("The candidate project name."),
      exclude: z.string().optional().describe("A project id to ignore in the collision check (for renames)."),
      org: orgArg,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ name, exclude, org }) => guard(async () => ok(await client.checkName(name, org, exclude))),
);

server.registerTool(
  "server_info",
  {
    title: "Server info",
    description:
      "Report the Railyard server's health and capabilities: version, the project schemaVersion it " +
      "understands, whether persistence (a database) and authentication are enabled, and whether " +
      "Stripe billing is configured. Useful to confirm the server is reachable and which features exist.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  () => guard(async () => ok(await client.health())),
);

// ---- validation & export ----------------------------------------------------
// Both operate on a document: `ref` fetches a saved project, or `project` passes an unsaved
// draft straight through. Neither changes anything stored.

server.registerTool(
  "list_export_formats",
  {
    title: "List export formats",
    description:
      "List the export targets this Railyard build supports — each format's id (what export_project " +
      "takes), a one-line description, and the file extension it produces.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  () => guard(async () => ok(await client.formats())),
);

server.registerTool(
  "validate_project",
  {
    title: "Validate project",
    description:
      "Run Railyard's design validation over a project and return the problems it finds: placements " +
      "outside their rack's U range, placements overlapping on a shared face, and racks with no " +
      "resolvable data centre. Each problem carries a severity (error = will export broken, " +
      "warning = a design smell that still exports), a code, a message, and the rack/placement it " +
      "concerns. Nothing is changed or rejected — this is the same check the app shows.",
    inputSchema: {
      ref: z.string().optional().describe("A saved project's id (prj_…) or slug to validate."),
      project: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("An inline project document to validate instead of a saved one (e.g. a draft before saving)."),
      org: orgArg,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ ref, project, org }) =>
    guard(async () => {
      const doc = await documentFor(ref, project, org);
      const res = await client.validate(doc);
      const problems = res.problems ?? [];
      const errors = problems.filter((p) => p.severity === "error").length;
      return ok({
        project: doc.name ?? doc.id,
        summary: problems.length
          ? `${problems.length} problem(s): ${errors} error(s), ${problems.length - errors} warning(s).`
          : "No problems found.",
        problems,
      });
    }),
);

server.registerTool(
  "export_project",
  {
    title: "Export project",
    description:
      "Export a project into a downstream format (see list_export_formats for the ids — e.g. " +
      "nautobot-csv, netbox-csv, designbuilder-yaml, json) and return the generated files' " +
      "content, plus any unresolved placements and warnings. A placement whose deviceTypeRef matches " +
      "no catalogue entry is REPORTED, never silently dropped: set placeholders=true to emit it as a " +
      "placeholder device type so the row still imports. Targets that need prerequisite objects " +
      "return the whole ordered bundle, not just the headline table. Large files are truncated in " +
      "the reply — the app's download gives the complete artefact.",
    inputSchema: {
      format: z.string().min(1).describe("Export format id, e.g. \"nautobot-csv\". Use list_export_formats to see them."),
      ref: z.string().optional().describe("A saved project's id (prj_…) or slug to export."),
      project: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("An inline project document to export instead of a saved one."),
      placeholders: z
        .boolean()
        .optional()
        .describe("Emit placements with no matching device type as placeholders (default false: they are skipped, but still reported)."),
      fallbackLocation: z
        .string()
        .optional()
        .describe("Location name given to racks with no resolvable site (default \"Railyard-Unassigned\")."),
      org: orgArg,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ format, ref, project, placeholders, fallbackLocation, org }) =>
    guard(async () => {
      const doc = await documentFor(ref, project, org);
      const res = await client.exportProject(doc, format, { placeholders, fallbackLocation });
      return ok({
        format: res.format,
        summary: res.summary,
        warnings: res.warnings,
        unresolved: res.unresolved,
        files: res.files.map(renderExportFile),
      });
    }),
);

// ---- write tools ------------------------------------------------------------

server.registerTool(
  "create_project",
  {
    title: "Create project",
    description:
      "Create a new, empty project with the given name and save it to the organisation. " +
      "Returns the new project's id and URL slug. Fails with a conflict if the name is already " +
      "taken in the org. (Write: requires the token user to have an editor/owner role in the org.)",
    inputSchema: {
      name: z.string().min(1).describe("Name for the new project."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ name, org }) =>
    guard(async () => {
      const project = minimalProject(name);
      const saved = await client.saveProject(project, org);
      return ok({ created: saved, id: saved.id, slug: saved.slug });
    }),
);

server.registerTool(
  "update_project",
  {
    title: "Update / overwrite project (DESTRUCTIVE)",
    description:
      "Save changes to an existing project via a full-document PUT. DESTRUCTIVE: the saved " +
      "document REPLACES the stored one. By default (merge=true) the given `project` fields are " +
      "shallow-merged over the current document (only the top-level keys you supply are replaced, " +
      "e.g. pass just {racks:[…]} to swap the racks) — recommended. With merge=false, `project` is " +
      "taken as the entire new document and must be a complete, valid project. The project's real id " +
      "is always preserved. If the project is currently open in a live collaboration session in the " +
      "app, that session may overwrite this save (and vice versa) — prefer editing when no one has it open.",
    inputSchema: {
      id: z.string().min(1).describe("The project's id (prj_…) or slug identifying which project to update."),
      project: z
        .record(z.string(), z.unknown())
        .describe(
          "Project fields. With merge=true, a partial set of top-level keys to overwrite " +
            "(e.g. {name, racks, catalogue}). With merge=false, the complete project document.",
        ),
      merge: z
        .boolean()
        .optional()
        .default(true)
        .describe("true (default): shallow-merge over the current doc. false: replace the whole document."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ id, project, merge, org }) =>
    guard(async () => {
      const doMerge = merge ?? true;
      // The PUT path must be the project's REAL id (it is not slug-resolved server-side, unlike GET).
      // Fetch the current doc when merging, or when the caller may have passed a slug, to pin the id.
      let realId = id;
      let current: Project | undefined;
      if (doMerge || !id.startsWith("prj_")) {
        current = await client.getProject(id, org);
        realId = current.id;
      }
      const doc: Project = doMerge
        ? ({ ...(current as Project), ...(project as Record<string, unknown>) } as Project)
        : ({ ...(project as Record<string, unknown>) } as Project);
      doc.id = realId; // never let a body id create a new row under a slug
      if (!doc.schemaVersion) doc.schemaVersion = current?.schemaVersion ?? "1";
      const saved = await client.saveProject(doc, org);
      return ok({ updated: saved, merged: doMerge });
    }),
);

server.registerTool(
  "rename_project",
  {
    title: "Rename project",
    description:
      "Rename a project. Updates both its display name and its URL slug together, after checking " +
      "the new name is unique in the org. Returns the new slug. (Write: editor/owner role required.)",
    inputSchema: {
      id: z.string().min(1).describe("The project's id (prj_…)."),
      name: z.string().min(1).describe("The new project name."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ id, name, org }) => guard(async () => ok(await client.renameProject(id, name, org))),
);

server.registerTool(
  "delete_project",
  {
    title: "Delete project (DESTRUCTIVE)",
    description:
      "Permanently delete a project and its entire estate. DESTRUCTIVE and NOT reversible — there " +
      "is no undo. Any live collaboration sessions on it are dropped. (Write: editor/owner role required.)",
    inputSchema: {
      id: z.string().min(1).describe("The project's id (prj_…) to delete."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ id, org }) =>
    guard(async () => {
      await client.deleteProject(id, org);
      return ok({ deleted: id });
    }),
);

server.registerTool(
  "move_project",
  {
    title: "Move project to another organisation",
    description:
      "Move a project out of its current organisation into another one the token user can write to. " +
      "`toOrg` is the destination org (id, slug or name); `org` is the source org it currently lives " +
      "in (defaults as usual). Requires an editor/owner role in BOTH organisations. If the name is " +
      "already taken in the destination the move conflicts (409) — pass `name` to rename the project " +
      "as part of the move; check_project_name against `toOrg` tells you in advance.",
    inputSchema: {
      id: z.string().min(1).describe("The project's id (prj_…) to move."),
      toOrg: z.string().min(1).describe("Destination organisation: id (org_…), slug, or name."),
      name: z.string().optional().describe("Optional new name, applied as part of the move (to settle a name clash in the destination)."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ id, toOrg, name, org }) => guard(async () => ok(await client.moveProject(id, toOrg, org, name))),
);

// ---- organisations ----------------------------------------------------------

server.registerTool(
  "create_org",
  {
    title: "Create organisation",
    description:
      "Create a new shared organisation; the token's user becomes its owner. Returns the org's id " +
      "and slug, which other tools accept as `org`. Note that adding members to it needs a Team or " +
      "Enterprise plan (see get_billing).",
    inputSchema: { name: z.string().min(1).describe("Name for the new organisation.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ name }) => guard(async () => ok(await client.createOrg(name))),
);

server.registerTool(
  "rename_org",
  {
    title: "Rename organisation",
    description: "Change an organisation's display name. Requires the OWNER role in it.",
    inputSchema: {
      org: z.string().min(1).describe("The organisation to rename: id (org_…), slug, or name."),
      name: z.string().min(1).describe("The new organisation name."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ org, name }) => guard(async () => ok(await client.renameOrg(org, name))),
);

server.registerTool(
  "delete_org",
  {
    title: "Delete organisation (DESTRUCTIVE)",
    description:
      "Permanently delete a shared organisation AND every project inside it. DESTRUCTIVE and NOT " +
      "reversible. Requires the OWNER role. A personal organisation cannot be deleted (400). " +
      "Move out any project you want to keep first (see move_project).",
    inputSchema: { org: z.string().min(1).describe("The organisation to delete: id (org_…), slug, or name.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ org }) =>
    guard(async () => {
      await client.deleteOrg(org);
      return ok({ deleted: org });
    }),
);

server.registerTool(
  "get_org_catalog",
  {
    title: "Get shared device-type library",
    description:
      "Read an organisation's shared device-type library — the catalogue of device types available " +
      "to every project in the org, separate from each project's own `catalogue`. Any member may read it.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) => guard(async () => ok(await client.orgCatalog(org))),
);

server.registerTool(
  "set_org_catalog",
  {
    title: "Replace shared device-type library (DESTRUCTIVE)",
    description:
      "Replace an organisation's shared device-type library with the given array. DESTRUCTIVE: this " +
      "is a whole-library write, not a merge — types absent from `catalogue` are removed. Read the " +
      "current library with get_org_catalog and send it back with your additions to preserve it. " +
      "Requires an editor/owner role.",
    inputSchema: {
      catalogue: z.array(z.unknown()).describe("The complete new library: a JSON array of device types, in the shape get_org_catalog returns."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ catalogue, org }) =>
    guard(async () => {
      await client.setOrgCatalog(catalogue, org);
      return ok({ saved: catalogue.length });
    }),
);

// ---- members & invitations --------------------------------------------------

server.registerTool(
  "list_members",
  {
    title: "List organisation members",
    description:
      "List an organisation's members — user id, email, name, role (viewer/editor/owner) and when " +
      "they joined. Any member may read the roster. The user id is what set_member_role and " +
      "remove_member take.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) => guard(async () => ok(await client.members(org))),
);

server.registerTool(
  "set_member_role",
  {
    title: "Change a member's role",
    description:
      "Change an existing member's role in an organisation. Requires the OWNER role. Demoting the " +
      "last remaining owner is refused (409) — promote someone else first. The member's live " +
      "collaboration sessions are dropped so they reconnect with the new role.",
    inputSchema: {
      userId: z.string().min(1).describe("The member's user id (usr_…) — from list_members."),
      role: roleArg,
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ userId, role, org }) =>
    guard(async () => {
      await client.setMemberRole(userId, role, org);
      return ok({ userId, role });
    }),
);

server.registerTool(
  "remove_member",
  {
    title: "Remove a member (DESTRUCTIVE)",
    description:
      "Remove a member from an organisation, revoking their access to all of its projects and " +
      "dropping their live sessions at once. Requires the OWNER role. Removing the last owner is " +
      "refused (409). The subscription's seat count is reconciled afterwards.",
    inputSchema: {
      userId: z.string().min(1).describe("The member's user id (usr_…) — from list_members."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ userId, org }) =>
    guard(async () => {
      await client.removeMember(userId, org);
      return ok({ removed: userId });
    }),
);

server.registerTool(
  "list_invites",
  {
    title: "List pending invitations",
    description:
      "List an organisation's pending invitations (email, role, when sent). Requires the OWNER role, " +
      "since the list holds the addresses of people who are not members yet.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) => guard(async () => ok(await client.invites(org))),
);

server.registerTool(
  "invite_member",
  {
    title: "Invite someone to an organisation",
    description:
      "Invite an email address to join an organisation at a role (default editor), and email them " +
      "the invitation where the server has mail configured. Requires the OWNER role, and a current " +
      "Team or Enterprise plan — a personal or Individual-plan org cannot add members (402), and " +
      "neither can one whose plan has lapsed. Re-inviting a still-pending email updates its role. " +
      "An address that is already a member is refused (409).",
    inputSchema: {
      email: z.string().min(1).describe("The invitee's email address."),
      role: roleArg
        .optional()
        .describe("Role to grant on acceptance: viewer (read-only), editor (can create and change projects) or owner (full control). Defaults to editor."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ email, role, org }) => guard(async () => ok(await client.createInvite(email, role, org))),
);

server.registerTool(
  "revoke_invite",
  {
    title: "Revoke a pending invitation",
    description:
      "Withdraw a pending invitation so it can no longer be accepted. Requires the OWNER role. " +
      "Has no effect on someone who has already joined — use remove_member for that.",
    inputSchema: {
      inviteId: z.string().min(1).describe("The invitation's id — from list_invites."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ({ inviteId, org }) =>
    guard(async () => {
      await client.revokeInvite(inviteId, org);
      return ok({ revoked: inviteId });
    }),
);

server.registerTool(
  "list_my_invites",
  {
    title: "List my pending invitations",
    description:
      "List invitations addressed to the token user's own email — organisations they have been " +
      "invited to but not yet joined. Pass an id from here to accept_invite.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  () => guard(async () => ok(await client.myInvites())),
);

server.registerTool(
  "accept_invite",
  {
    title: "Accept an invitation",
    description:
      "Accept an invitation addressed to the token user's email, joining that organisation at the " +
      "invited role. Returns the joined org. Refused (403) if the invitation was addressed to " +
      "someone else, and (402) if the organisation's plan has lapsed or been downgraded since the " +
      "invitation was sent.",
    inputSchema: { inviteId: z.string().min(1).describe("The invitation's id — from list_my_invites.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ inviteId }) => guard(async () => ok(await client.acceptInvite(inviteId))),
);

// ---- billing ----------------------------------------------------------------

server.registerTool(
  "get_billing",
  {
    title: "Get billing state",
    description:
      "Read an organisation's plan and billing state: plan (individual/team/enterprise), status " +
      "(trialing/active/past_due/canceled), seat count, trial end, current period end, whether it is " +
      "currently entitled to edit (a lapsed org is read-only and its writes return 402), whether the " +
      "caller may manage billing, and whether this server has Stripe self-serve configured at all. " +
      "Any member may read it.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) => guard(async () => ok(await client.billing(org))),
);

server.registerTool(
  "billing_manage_url",
  {
    title: "Get a Stripe billing link",
    description:
      "Mint a Stripe hosted-page URL for the organisation's OWNER to open in a browser: " +
      "action=subscribe opens Checkout to start a subscription, action=manage opens the Customer " +
      "Portal to change the card, switch plan or cancel. This only creates a link — it does not " +
      "charge anything or change the subscription; the owner completes or abandons that on Stripe's " +
      "page. Requires the OWNER role and Stripe configured on the server (503 otherwise). " +
      "action=subscribe conflicts (409) when a live subscription already exists — manage it instead; " +
      "action=manage needs an existing billing account (400 before the first subscription).",
    inputSchema: {
      action: z
        .enum(["subscribe", "manage"])
        .describe("subscribe = Stripe Checkout for a new subscription; manage = Customer Portal for an existing one."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ action, org }) =>
    guard(async () => ok(await client.billingURL(action === "subscribe" ? "checkout" : "portal", org))),
);

// ---- boot -------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`railyard-mcp: connected over stdio → ${baseUrl}${defaultOrg ? ` (default org: ${defaultOrg})` : ""}`);
}

main().catch((e) => {
  console.error("railyard-mcp: fatal:", (e as Error).message);
  process.exit(1);
});
