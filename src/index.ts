#!/usr/bin/env node
// Railyard MCP server (stdio).
//
// Exposes Railyard's project + organisation API to an MCP client (Claude Desktop, etc.)
// as tools: projects (list/read/create/update/rename), validation and export, organisations and
// their shared libraries, the member and invitation lists, and billing state. Authentication is a
// Railyard personal access token — see README.md.
//
// Not exposed, deliberately: Railyard keeps owner-level and irreversible actions to an interactive
// browser session, and answers a token with 403 session_required, so no tool offers them: deleting
// or moving a project, creating or deleting an organisation, changing members or invitations,
// accepting an invitation, opening billing, managing tokens and deleting the account. The
// OAuth/magic-link routes and the Stripe webhook are not client-callable, and live collaboration is
// a WebSocket protocol, not a request/response tool.
//
// Transport is stdio: stdout is the JSON-RPC channel, so ALL diagnostics go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { helpText, resolveBaseUrl, runAuthHelper } from "./auth.js";
import { RailyardApiError, RailyardClient, type ExportFile, type Project } from "./client.js";
import { DELIVERABLE_KINDS, FORMAT_KINDS, exportDeliverable, isUnknownRoute } from "./deliverables.js";
import { minimalProject } from "./project.js";

// ---- configuration (from the environment) -----------------------------------

let baseUrl: string;
try {
  baseUrl = resolveBaseUrl(process.env.RAILYARD_BASE_URL);
} catch (error) {
  console.error(`railyard-mcp: ${(error as Error).message}.`);
  process.exit(1);
}
const token = process.env.RAILYARD_TOKEN?.trim() || "";
const defaultOrg = process.env.RAILYARD_ORG?.trim() || undefined;

const [mode, ...modeArgs] = process.argv.slice(2);
if (mode === "auth" || mode === "login") {
  try {
    await runAuthHelper(modeArgs, { baseUrl, defaultOrg });
  } catch (error) {
    console.error(`railyard-mcp: ${(error as Error).message}.`);
    process.exit(1);
  }
  process.exit(0);
}
if (mode === "--help" || mode === "-h" || mode === "help") {
  console.log(helpText());
  process.exit(0);
}

if (!token) {
  console.error(
    "railyard-mcp: RAILYARD_TOKEN is not set. Mint a personal access token in Railyard " +
      "(User settings → Personal access tokens) and set RAILYARD_TOKEN to the ry_… secret. " +
      "Run `npx -y railyard-mcp auth` to open Railyard in your browser.",
  );
  process.exit(1);
}
if (!token.startsWith("ry_")) {
  // Not fatal — but the server only accepts ry_-prefixed tokens, so warn early.
  console.error('railyard-mcp: warning — RAILYARD_TOKEN does not start with "ry_"; Railyard will reject it.');
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

/**
 * Run a tool body, converting any thrown error into a readable isError result. When the server
 * gave a machine-readable code, it and the error's structured fields follow the message as JSON,
 * so the model can act on them (a 402's requiredPlans and projectPass, a limit and its count).
 */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RailyardApiError) {
      if (!e.code) return fail(e.message);
      return fail(`${e.message}\n${JSON.stringify({ status: e.status, code: e.code, ...(e.details ?? {}) })}`);
    }
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

const revisionArg = z
  .string()
  .regex(/^"\d+"$/)
  .describe('The quoted numeric ETag returned by the matching read tool, for example "7".');

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

/** Told to the client at initialisation, so the model sends the user to the app instead of retrying. */
const BROWSER_ONLY_INSTRUCTIONS =
  "Railyard keeps some actions to a signed-in browser, and refuses them for this server's access token " +
  "(403 session_required): deleting or moving a project, creating or deleting an organisation, changing " +
  "members, roles or invitations, accepting or declining an invitation, and subscribing or managing billing. " +
  "No tool here performs them. When the user asks for one, tell them to do it in the Railyard web app; " +
  "the token is fine and needs no replacing.";

const server = new McpServer(
  { name: "railyard-mcp", version: "0.2.1" },
  { capabilities: { tools: {} }, instructions: BROWSER_ONLY_INSTRUCTIONS },
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
      "Fetch a project's full JSON document and revision ETag, addressed by id or URL slug. " +
      "The project contains the complete estate model, including the flexible container hierarchy, " +
      "racks and placements, device roles, review dismissals, cabling and power. Pass `revision` to " +
      "update_project when applying work derived from this response so concurrent changes are not overwritten.",
    inputSchema: {
      ref: z.string().min(1).describe("The project's id (prj_…) or its URL slug."),
      org: orgArg,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ ref, org }) =>
    guard(async () => {
      const current = await client.getProjectWithRevision(ref, org);
      return ok({ project: current.value, revision: current.etag });
    }),
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
      "Report the Railyard server's health and capabilities: its mode (hosted or local), the project " +
      "schemaVersion it understands, whether persistence (a database) and authentication are enabled, " +
      "and whether Stripe billing, project workflows (branches and merge requests) and the hosted MCP " +
      "connector are on. Useful to confirm the server is reachable and which features exist.",
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
      "takes), a one-line description, and the file extension it produces. json (the raw Project " +
      "JSON) is free on every plan; netbox-csv, nautobot-csv and designbuilder-yaml are deliverables " +
      "on a server with billing on (see export_deliverable).",
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
      "Run the current Railyard server-side soft validation over a project: rack placement/site " +
      "findings and power-model problems. Structurally invalid documents, including malformed " +
      "hierarchy or cabling references, are rejected before this report. Each raw problem carries a " +
      "severity, stable code, message and relevant rack or placement ids. Nothing is saved; the " +
      "interactive app may group or dismiss eligible review findings separately.",
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
      "content, plus any unresolved placements and warnings where the server reports them. json is " +
      "the raw Project JSON: free on every plan, for a saved project or an inline document. The " +
      "NetBox, Nautobot and Design Builder formats are deliverables: for a saved project (`ref`) " +
      "they are generated from the stored document and need a plan or Project Pass that includes " +
      "deliverables when the server has billing on (402 plan_required otherwise, naming the plans " +
      "that would). An inline `project` (not saved) can only be exported as json when the server " +
      "has billing on; save it and pass `ref` instead. A placement whose deviceTypeRef matches no " +
      "catalogue entry is REPORTED, never silently dropped: set placeholders=true to emit it as a " +
      "placeholder device type so the row still imports. Large files are truncated in the reply — " +
      "the app's download gives the complete artefact.",
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
      const kind = FORMAT_KINDS[format];
      if (kind && ref && !project) {
        try {
          const res = await exportDeliverable(client, { ref, kind, org, options: { placeholders, fallbackLocation } });
          return ok({ format, ...res });
        } catch (e) {
          // A server that predates the deliverables route still exports through /api/export.
          if (!isUnknownRoute(e)) throw e;
        }
      }
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

server.registerTool(
  "export_deliverable",
  {
    title: "Export a deliverable",
    description:
      "Generate a deliverable from a saved project's stored document (main, or a merge request's " +
      "draft with changeRequestId): build-pack (PDF), build-pack-preview (one rack, watermarked; " +
      "needs rackId), cable-schedule, cable-labels, power-schedule, power-report, netbox, nautobot " +
      "or designbuilder. On a server with billing on, deliverables need the Pro, Team or Partner " +
      "plan, or a Project Pass on that estate, and the estate must be within its plan's rack limit; " +
      "otherwise Railyard answers 402 (plan_required or plan_limit) naming the plans that would " +
      "allow it — nothing is changed and the design stays editable. build-pack-preview is available " +
      "on every plan. Text files are returned inline (truncated when large); a binary file such as " +
      "the build-pack PDF is returned as base64 when small, or pass saveTo to write every file to a " +
      "local directory and get its path back. The raw Project JSON is not a deliverable: use " +
      "export_project with format json.",
    inputSchema: {
      kind: z.enum(DELIVERABLE_KINDS).describe("Which deliverable to generate."),
      ref: z.string().min(1).describe("A saved project's id (prj_…), slug or name."),
      changeRequestId: z.string().optional().describe("Generate from this merge request's draft instead of main."),
      rackId: z.string().optional().describe("build-pack-preview: the rack to preview."),
      netboxVersion: z.string().optional().describe("netbox: the NetBox release to target, e.g. \"4.2\"."),
      placeholders: z
        .boolean()
        .optional()
        .describe("netbox/nautobot/designbuilder: emit placements with no matching device type as placeholders."),
      fallbackLocation: z
        .string()
        .optional()
        .describe("netbox/nautobot/designbuilder: location name for racks with no resolvable site."),
      saveTo: z
        .string()
        .optional()
        .describe("A local directory to write the files into (created if missing; existing files are never overwritten)."),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  ({ kind, ref, changeRequestId, rackId, netboxVersion, placeholders, fallbackLocation, saveTo, org }) =>
    guard(async () =>
      ok(
        await exportDeliverable(
          client,
          { ref, kind, org, changeRequestId, options: { rackId, netboxVersion, placeholders, fallbackLocation } },
          saveTo,
        ),
      ),
    ),
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
      "is always preserved. Concurrent browser or MCP saves are guarded by revision checks: a stale " +
      "update is refused instead of overwriting newer work.",
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
      revision: revisionArg
        .optional()
        .describe(
          "Revision returned by get_project. When present, the update is refused if the project changed " +
            "since that read. When omitted, update_project safely reads the latest revision immediately before saving.",
        ),
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ id, project, merge, revision, org }) =>
    guard(async () => {
      const doMerge = merge ?? true;
      const saved = await client.updateProject(id, project, doMerge, org, revision);
      return ok({ updated: saved.value, revision: saved.etag, merged: doMerge });
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

// ---- organisations ----------------------------------------------------------

server.registerTool(
  "get_org_catalog",
  {
    title: "Get shared device-type library",
    description:
      "Read an organisation's shared device-type library — the catalogue of device types available " +
      "to every project in the org, separate from each project's own `catalogue`. Returns the complete " +
      "`catalogue` plus its `revision`; pass that revision to set_org_catalog. Any member may read it.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) =>
    guard(async () => {
      const current = await client.getOrgCatalogWithRevision(org);
      return ok({ catalogue: current.value, revision: current.etag });
    }),
);

server.registerTool(
  "set_org_catalog",
  {
    title: "Replace shared device-type library (DESTRUCTIVE)",
    description:
      "Replace an organisation's shared device-type library with the given array. DESTRUCTIVE: this " +
      "is a whole-library write, not a merge — types absent from `catalogue` are removed. Read the " +
      "current library with get_org_catalog and send it back with your additions plus its `revision`. " +
      "The write fails rather than overwriting a concurrent change. Requires an editor/owner role.",
    inputSchema: {
      catalogue: z.array(z.unknown()).describe("The complete new library: a JSON array of device types, in the shape get_org_catalog returns."),
      revision: revisionArg,
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ catalogue, revision, org }) =>
    guard(async () => {
      const saved = await client.setOrgCatalog(catalogue, revision, org);
      return ok({ saved: catalogue.length, revision: saved.etag });
    }),
);

server.registerTool(
  "get_org_roles",
  {
    title: "Get shared device roles",
    description:
      "Read an organisation's shared device-role vocabulary. Returns the complete `roles` array and " +
      "its `revision`; pass that revision to set_org_roles. Project-level deviceRoles are layered on top.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) =>
    guard(async () => {
      const current = await client.getOrgRolesWithRevision(org);
      return ok({ roles: current.value, revision: current.etag });
    }),
);

server.registerTool(
  "set_org_roles",
  {
    title: "Replace shared device roles (DESTRUCTIVE)",
    description:
      "Replace an organisation's shared device-role vocabulary. This is a whole-array write: read it " +
      "with get_org_roles, preserve the entries you still need, and pass back that response's revision. " +
      "The write fails rather than overwriting a concurrent change. Requires an editor/owner role.",
    inputSchema: {
      roles: z.array(z.string().trim().min(1)).describe("The complete new shared device-role vocabulary."),
      revision: revisionArg,
      org: orgArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ roles, revision, org }) =>
    guard(async () => {
      const saved = await client.setOrgRoles(roles, revision, org);
      return ok({ saved: roles.length, revision: saved.etag });
    }),
);

// ---- members & invitations --------------------------------------------------

server.registerTool(
  "list_members",
  {
    title: "List organisation members",
    description:
      "List an organisation's members — user id, email, name, role (viewer/editor/owner) and when " +
      "they joined. Any member may read the roster. Changing a role or removing a member is done by " +
      "an owner in the Railyard web app; an access token can't.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) => guard(async () => ok(await client.members(org))),
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
  "list_my_invites",
  {
    title: "List my pending invitations",
    description:
      "List invitations addressed to the token user's own email — organisations they have been " +
      "invited to but not yet joined. The user accepts or declines one in the Railyard web app; an " +
      "access token can't.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  () => guard(async () => ok(await client.myInvites())),
);

// ---- billing ----------------------------------------------------------------

server.registerTool(
  "get_billing",
  {
    title: "Get billing state",
    description:
      "Read an organisation's plan and billing state: plan (community/pro/team/partner/enterprise), " +
      "status (trialing/active/past_due/canceled), seat count, trial end, current period end, whether " +
      "the paid subscription is current (`entitled`), what the organisation may do now " +
      "(`entitlements`: rack limit per estate, editors, deliverables, branches, merge requests, live " +
      "collaboration), the plans an owner can buy here (`checkoutPlans`), whether the caller may " +
      "manage billing, and whether this server has Stripe self-serve configured at all. A lapsed plan " +
      "never makes designs read-only: it falls back to Community rules and only paid features stop. " +
      "Any member may read it.",
    inputSchema: { org: orgArg },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ({ org }) => guard(async () => ok(await client.billing(org))),
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
