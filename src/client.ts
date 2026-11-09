// A small, typed HTTP client for the Railyard REST API.
//
// One place owns all of the wire concerns:
//   - authentication  — every request carries `Authorization: Bearer ry_…` (a Railyard
//     personal access token). The token authenticates as its owning user across all of
//     that user's organisations. It is NEVER logged.
//   - org selection    — org-scoped calls carry the `X-Org-Id` header, which the server
//     membership-checks (403 if the caller is not a member). The header must be an org
//     *id*; a slug or name supplied by the caller is resolved to an id via GET /api/orgs.
//   - error surfacing  — non-2xx responses ({"error": "...", "code"?: "...", …}) become
//     RailyardApiError with a human-readable, status-aware message the tools relay straight to
//     the model. The server's machine-readable `code` and any structured fields (a 402's
//     requiredPlans, limit, current…) are kept on the error rather than flattened into text.

// ---- wire types (mirrors of backend structs) --------------------------------

/** A signed-in user. Mirror of store.User (GET /api/me). */
export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  createdAt: string;
}

/** An organisation the user belongs to. Mirror of store.Org (GET /api/orgs). */
export interface Org {
  id: string;
  name: string;
  slug: string;
  role?: string; // viewer | editor | owner
  personal: boolean;
  plan: string; // community | pro | team | partner | enterprise
  status: string; // trialing | active | past_due | canceled
  trialEndsAt?: string;
  createdAt: string;
}

/** A project list-row. Mirror of store.ProjectMeta (GET /api/projects). */
export interface ProjectMeta {
  id: string;
  name: string;
  slug: string;
  updatedAt: string;
}

/**
 * A Railyard project document. Mirror of model.Project — the full JSON that round-trips
 * through the frontend, the API and the CLI. Only the invariants the server enforces are
 * required here (schemaVersion + id); everything else is optional so partial updates and
 * minimal creates type-check. Unknown top-level keys are rejected by the server
 * (model.Load uses DisallowUnknownFields), so callers must stick to these fields.
 */
export interface Project {
  schemaVersion: string;
  id: string;
  name?: string;
  organisation?: string;
  createdAt?: string;
  updatedAt?: string;
  example?: {
    template: "data-centre";
    version: number;
  };
  containers?: unknown[];
  containerTypes?: string[];
  locations?: unknown[];
  dataCentres?: unknown[];
  rows?: unknown[];
  racks?: unknown[];
  podPatterns?: unknown[];
  namingRules?: unknown[];
  naming?: unknown;
  catalogue?: unknown[];
  rackTypes?: unknown[];
  meetMeRooms?: unknown[];
  cables?: unknown[];
  powerLinks?: unknown[];
  reviewDismissals?: string[];
  deviceRoles?: string[];
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A replacement resource together with the strong revision token required to update it. */
export interface Revisioned<T> {
  value: T;
  etag: string;
}

/** Response of PUT /api/projects/{id}. */
export interface SaveResult {
  id: string;
  slug: string;
}

/** Response of GET /api/projects/check. */
export interface NameCheck {
  slug: string;
  available: boolean;
}

/** A member of an org. Mirror of store.Member (GET /api/orgs/{id}/members). */
export interface Member {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string;
  role: string; // viewer | editor | owner
  joinedAt: string;
}

/** A pending invitation. Mirror of store.Invite. The bearer token is never returned. */
export interface Invite {
  id: string;
  orgId: string;
  orgName?: string;
  email: string;
  role: string;
  createdAt: string;
}

/** An org's billing state. Mirror of api.billingView (GET /api/orgs/{id}/billing). */
export interface Billing {
  plan: string; // community | pro | team | partner | enterprise
  status: string; // trialing | active | past_due | canceled
  seats: number;
  trialEndsAt?: string;
  currentPeriodEnd?: string;
  hasSubscription: boolean;
  /** The paid subscription is current. False never means read-only: a lapsed plan falls back to
   *  Community rules, so designs stay editable and only paid features stop. */
  entitled: boolean;
  canManage: boolean; // the caller is an owner
  configured: boolean; // Stripe self-serve is enabled on this server
  /** What the organisation may do now (plan, limits, deliverables, branches, …). Newer servers. */
  entitlements?: Record<string, unknown>;
  /** The plans an owner can buy at checkout here ([] when billing is off). Newer servers. */
  checkoutPlans?: string[];
}

/** Server capability report. Mirror of GET /api/health (no build version, by design). */
export interface Health {
  status: string; // ok
  mode?: string; // hosted (a database is configured) | local
  schemaVersion: string;
  persistence: boolean; // a database is configured
  auth: boolean;
  landing: boolean;
  billing: boolean; // Stripe self-serve is configured
  projectWorkflows?: boolean; // branches, merge requests and project access management
  mcp?: boolean; // the hosted /mcp connector is enabled
}

/** An available export target. Mirror of api.formatInfo (GET /api/formats). */
export interface FormatInfo {
  format: string;
  description: string;
  fileExt: string;
}

/** A design-level validation finding. Mirror of model.Problem (POST /api/validate). */
export interface Problem {
  severity: "error" | "warning";
  code: string;
  message: string;
  rackId?: string;
  placementId?: string;
}

/** A placement whose deviceTypeRef matched no catalogue entry. Mirror of export.Unresolved. */
export interface Unresolved {
  rackName: string;
  placementId: string;
  label: string;
  ref: string;
  heightU: number;
  placeheld: boolean;
}

/** One artefact of an export bundle; content is base64 on the wire. */
export interface ExportFile {
  name: string;
  mime: string;
  contentBase64: string;
}

/** Response of POST /api/export. */
export interface ExportResult {
  format: string;
  summary: string;
  unresolved: Unresolved[];
  warnings: string[];
  files: ExportFile[];
}

/** Options accepted by POST /api/export as query parameters. */
export interface ExportOptions {
  /** Emit unresolved placements as placeholder device types instead of skipping them. */
  placeholders?: boolean;
  /** Location name used for racks with no resolvable site. */
  fallbackLocation?: string;
}

// ---- errors -----------------------------------------------------------------

/**
 * An error carrying the HTTP status so tools can present it plainly. status 0 = transport failure.
 * `code` is the server's machine-readable code (e.g. "plan_required") and `details` every other
 * structured field of its error body, so a caller can act on them without parsing the message.
 */
export class RailyardApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly bodyText?: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RailyardApiError";
  }
}

/** A server error body: {"error": "...", "code"?: "...", ...structured fields}. */
export interface ServerError {
  message: string;
  code?: string;
  /** Every field other than error and code, as the server sent it. */
  details?: Record<string, unknown>;
}

/** Parse a server error body, keeping its code and structured fields; falls back to the raw text. */
export function parseServerError(text: string): ServerError {
  if (!text) return { message: "" };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { error, code, ...rest } = parsed as Record<string, unknown>;
      if (typeof error === "string" || typeof code === "string") {
        return {
          message: typeof error === "string" ? error : "",
          ...(typeof code === "string" && code ? { code } : {}),
          ...(Object.keys(rest).length ? { details: rest } : {}),
        };
      }
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  return { message: text.slice(0, 500) };
}

/** Display names for plan ids. The server's catalogue (GET /api/plans) is authoritative. */
const PLAN_NAMES: Record<string, string> = {
  community: "Community",
  "project-pass": "Project Pass",
  pro: "Pro",
  team: "Team",
  partner: "Partner",
  "self-hosted": "Self-hosted",
  enterprise: "Enterprise",
};

/** A plan's display name, or its id when this build does not know it. */
export function planName(id: string): string {
  return PLAN_NAMES[id] ?? id;
}

/** "Pro, Team or Partner". */
function orList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

const FEATURE_NAMES: Record<string, string> = {
  deliverables: "Deliverables (build pack, schedules, labels, power report, NetBox and Nautobot bundles) are",
  branches: "Branches are",
  mergeRequests: "Merge requests are",
  liveCollaboration: "Live collaboration is",
};

/**
 * Explain a 402. Railyard never makes data read-only for billing: a 402 refuses a paid feature
 * (plan_required) or growth past a plan limit (plan_limit). The design stays editable and its raw
 * JSON export stays free, so the message says so rather than calling the organisation lapsed.
 */
function describePaymentRequired(err: ServerError): string {
  const head = `Payment required (402)${err.message ? `: ${err.message}` : ""}`;
  const d = err.details ?? {};
  const required = Array.isArray(d.requiredPlans)
    ? d.requiredPlans.filter((p): p is string => typeof p === "string").map(planName)
    : [];
  const options = [
    required.length ? `move to the ${orList(required)} plan` : "",
    d.projectPass === true ? "buy a Project Pass for this estate (a one-off purchase for a project in a personal space)" : "",
  ].filter(Boolean);
  const upgrade = options.length
    ? ` To unlock it, ${options.join(", or ")} in the Railyard app.`
    : " A paid plan is needed; see the billing settings in the Railyard app.";
  const current = typeof d.plan === "string" ? ` (current plan: ${planName(d.plan)})` : "";
  if (err.code === "plan_required") {
    const what = (typeof d.feature === "string" && FEATURE_NAMES[d.feature]) || "This feature is";
    return `${head}. ${what} not included in this plan${current}.${upgrade} Nothing was changed: the design stays editable and its raw JSON export stays free.`;
  }
  if (err.code === "plan_limit") {
    const resource = typeof d.resource === "string" ? d.resource : "this resource";
    const where = d.scope === "estate" ? " in this estate" : d.scope === "organisation" ? " in this organisation" : "";
    const counts = typeof d.limit === "number"
      ? ` The plan${current} allows ${d.limit} ${resource}${where}` +
        (typeof d.current === "number" ? ` and there are ${d.current}` : "") + "."
      : "";
    return `${head}. Plan limit reached for ${resource}.${counts}${upgrade} A limit only stops growth: existing work stays editable and exportable.`;
  }
  return `${head}.${upgrade} Railyard never makes a design read-only for billing; its raw JSON export stays free.`;
}

/**
 * The answer for an action Railyard keeps to a signed-in browser. The token is valid, so the message
 * must not send the user off to mint another one.
 */
const SESSION_REQUIRED_ADVICE =
  "This action needs a signed-in browser: do it in the Railyard web app. An access token can't perform it, " +
  "and RAILYARD_TOKEN itself is fine, so there is no need to replace it.";

/** Older servers answered a token on a browser-only route with this 401 rather than 403 session_required. */
const LEGACY_SESSION_REQUIRED = "session sign-in required";

/** Turn an HTTP status + body into a readable, actionable message. */
function describeError(status: number, text: string): string {
  const parsed = parseServerError(text);
  const detail = parsed.message;
  const suffix = detail ? `: ${detail}` : "";
  switch (status) {
    case 400:
      return `Bad request (400)${suffix}`;
    case 401:
      if (detail === LEGACY_SESSION_REQUIRED) return `Browser sign-in required (401). ${SESSION_REQUIRED_ADVICE}`;
      return `Authentication failed (401)${suffix}. RAILYARD_TOKEN is missing, mistyped, expired or revoked: mint a new "ry_…" personal access token in the Railyard app (User settings → Personal access tokens).`;
    case 402:
      return describePaymentRequired(parsed);
    case 403:
      if (parsed.code === "session_required") return `Browser sign-in required (403)${suffix}. ${SESSION_REQUIRED_ADVICE}`;
      return `Forbidden (403)${suffix}. The token's user is not a member of this organisation, or lacks the role this action needs (writes need editor+).`;
    case 404:
      return `Not found (404)${suffix}.`;
    case 409:
      // Conflicts differ by endpoint — a name already taken, a duplicate subscription, the last
      // owner, an email that is already a member — so the server's own message carries the detail.
      return `Conflict (409)${suffix}`;
    case 412:
      return `Revision conflict (412)${suffix}. Reload the resource and reapply your changes; no changes were saved.`;
    case 413:
      return `Payload too large (413)${suffix}.`;
    case 428:
      return `Revision required (428)${suffix}. Reload the resource to get its ETag before saving; no changes were saved.`;
    case 429:
      return `Rate limited (429)${suffix}.`;
    case 501:
      return `Not implemented (501)${suffix}.`;
    case 503:
      return `Unavailable (503)${suffix}. The feature is not configured on this server, or the server is briefly unavailable; try again shortly.`;
    default:
      return `Railyard API error (${status})${suffix}`;
  }
}

// ---- client -----------------------------------------------------------------

export interface RailyardClientOptions {
  baseUrl: string;
  token: string;
  /** Default org (id or slug) used when a tool call omits an explicit org. */
  defaultOrg?: string;
}

interface RequestOptions {
  body?: unknown;
  orgId?: string;
  ifMatch?: string;
}

interface RequestResult<T> {
  value: T;
  response: Response;
}

/** A non-2xx response as a RailyardApiError, keeping the server's code and structured fields. */
function apiError(status: number, text: string): RailyardApiError {
  const parsed = parseServerError(text);
  return new RailyardApiError(status, describeError(status, text), text, parsed.code, parsed.details);
}

/** A file the server sent as the response body (a deliverable download). */
export interface DownloadedFile {
  /** From Content-Disposition, or "" when the server gave none. */
  filename: string;
  /** The Content-Type without parameters, e.g. "application/zip". */
  contentType: string;
  bytes: Buffer;
}

/** The filename in a Content-Disposition header (RFC 6266: filename*= wins over filename=). */
export function dispositionFilename(header: string | null): string {
  if (!header) return "";
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // a malformed escape — fall back to the plain parameter
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return (plain?.[1] ?? plain?.[2] ?? "").trim();
}

const revisionETagPattern = /^"\d+"$/;

function checkedRevisionETag(value: string): string {
  const revision = value.trim();
  if (!revisionETagPattern.test(revision)) {
    throw new RailyardApiError(400, 'Revision must be a quoted numeric ETag such as "7".');
  }
  return revision;
}

export class RailyardClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly defaultOrg?: string;
  private orgsCache?: Org[];

  constructor(opts: RailyardClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.defaultOrg = opts.defaultOrg?.trim() || undefined;
  }

  private async send(method: string, path: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      // The token is the credential; it is never written to logs.
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (opts.orgId) headers["X-Org-Id"] = opts.orgId;
    if (opts.ifMatch) headers["If-Match"] = checkedRevisionETag(opts.ifMatch);
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    return fetch(`${this.baseUrl}${path}`, { method, headers, body: payload });
  }

  private async requestResult<T>(method: string, path: string, opts: RequestOptions = {}): Promise<RequestResult<T>> {
    let res: Response;
    try {
      res = await this.send(method, path, opts);
    } catch (e) {
      throw new RailyardApiError(0, `Could not reach Railyard at ${this.baseUrl} — ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw apiError(res.status, text);
    if (!text) return { value: undefined as T, response: res }; // 204 No Content (e.g. delete)
    try {
      return { value: JSON.parse(text) as T, response: res };
    } catch {
      return { value: text as unknown as T, response: res };
    }
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestResult<T>(method, path, opts)).value;
  }

  /** Send a request whose success body is a file (bytes, not JSON). Errors behave as request(). */
  async download(method: string, path: string, opts: RequestOptions = {}): Promise<DownloadedFile> {
    let res: Response;
    try {
      res = await this.send(method, path, opts);
    } catch (e) {
      throw new RailyardApiError(0, `Could not reach Railyard at ${this.baseUrl} — ${(e as Error).message}`);
    }
    if (!res.ok) throw apiError(res.status, await res.text());
    return {
      filename: dispositionFilename(res.headers.get("Content-Disposition")),
      contentType: (res.headers.get("Content-Type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase(),
      bytes: Buffer.from(await res.arrayBuffer()),
    };
  }

  private async requestRevisioned<T>(method: string, path: string, opts: RequestOptions = {}): Promise<Revisioned<T>> {
    const result = await this.requestResult<T>(method, path, opts);
    const etag = result.response.headers.get("ETag")?.trim() ?? "";
    if (!revisionETagPattern.test(etag)) {
      const message = method === "GET"
        ? `Railyard returned ${method} ${path} without a valid revision ETag; refusing an unsafe replacement write.`
        : `Railyard accepted ${method} ${path} but omitted the new revision ETag. The write may have succeeded; reload the resource before making another change.`;
      throw new RailyardApiError(
        502,
        message,
      );
    }
    return { value: result.value, etag };
  }

  // ---- org resolution -------------------------------------------------------

  /** List the token user's organisations, caching the result for slug→id resolution. */
  async listOrgs(): Promise<Org[]> {
    const orgs = await this.request<Org[]>("GET", "/api/orgs");
    this.orgsCache = orgs;
    return orgs;
  }

  /**
   * Resolve an org reference (id, slug or name) to the org id the API expects in X-Org-Id.
   * Returns undefined when no reference is given AND no default is set, letting the server
   * fall back to the user's first (personal) org.
   */
  async resolveOrgId(ref?: string): Promise<string | undefined> {
    const wanted = (ref ?? this.defaultOrg)?.trim();
    if (!wanted) return undefined;
    const orgs = this.orgsCache ?? (await this.listOrgs());
    const match =
      orgs.find((o) => o.id === wanted) ??
      orgs.find((o) => o.slug === wanted) ??
      orgs.find((o) => o.name === wanted);
    if (match) return match.id;
    // Not in the list. If it already looks like an id, pass it through (membership is still
    // server-checked); otherwise fail with the set of orgs the user can actually use.
    if (wanted.startsWith("org_")) return wanted;
    const available = orgs.map((o) => `${o.slug} (${o.id})`).join(", ") || "none";
    throw new RailyardApiError(404, `No organisation matches "${wanted}". Available: ${available}.`);
  }

  /**
   * Resolve an org reference to a concrete id for the routes that carry the org in the PATH
   * (/api/orgs/{id}/…). Those have no server-side default, so where resolveOrgId would return
   * undefined this falls back to the user's first org — the same default the header routes apply.
   */
  async requireOrgId(ref?: string): Promise<string> {
    const resolved = await this.resolveOrgId(ref);
    if (resolved) return resolved;
    const orgs = this.orgsCache ?? (await this.listOrgs());
    if (orgs.length === 0) {
      throw new RailyardApiError(404, "The token's user belongs to no organisation.");
    }
    return orgs[0].id;
  }

  // ---- typed endpoints ------------------------------------------------------

  /** GET /api/me — the user the token authenticates as. */
  me(): Promise<User> {
    return this.request<User>("GET", "/api/me");
  }

  /** GET /api/projects — project list for an org. */
  async listProjects(orgRef?: string): Promise<ProjectMeta[]> {
    const orgId = await this.resolveOrgId(orgRef);
    return this.request<ProjectMeta[]>("GET", "/api/projects", { orgId });
  }

  /** GET /api/projects/{ref} — full document, addressed by id or slug. */
  async getProject(ref: string, orgRef?: string): Promise<Project> {
    const orgId = await this.resolveOrgId(orgRef);
    return this.request<Project>("GET", `/api/projects/${encodeURIComponent(ref)}`, { orgId });
  }

  /** GET a project together with the ETag required for a safe replacement. */
  async getProjectWithRevision(ref: string, orgRef?: string): Promise<Revisioned<Project>> {
    const orgId = await this.resolveOrgId(orgRef);
    return this.requestRevisioned<Project>("GET", `/api/projects/${encodeURIComponent(ref)}`, { orgId });
  }

  /** GET /api/projects/check — is a name's slug free in the org? */
  async checkName(name: string, orgRef?: string, exclude?: string): Promise<NameCheck> {
    const orgId = await this.resolveOrgId(orgRef);
    const q = new URLSearchParams({ name });
    if (exclude) q.set("exclude", exclude);
    return this.request<NameCheck>("GET", `/api/projects/check?${q.toString()}`, { orgId });
  }

  /** PUT /api/projects/{id} — save the full document (create or overwrite). */
  async saveProject(project: Project, orgRef?: string): Promise<SaveResult> {
    const orgId = await this.resolveOrgId(orgRef);
    return this.request<SaveResult>("PUT", `/api/projects/${encodeURIComponent(project.id)}`, {
      orgId,
      body: project,
    });
  }

  /** PUT an existing project only if the revision read by the caller is still current. */
  async saveProjectAtRevision(project: Project, etag: string, orgRef?: string): Promise<Revisioned<SaveResult>> {
    const revision = checkedRevisionETag(etag);
    const orgId = await this.resolveOrgId(orgRef);
    return this.requestRevisioned<SaveResult>("PUT", `/api/projects/${encodeURIComponent(project.id)}`, {
      orgId,
      body: project,
      ifMatch: revision,
    });
  }

  /**
   * Read, immutably merge or replace, then conditionally save an existing project.
   * expectedRevision lets a caller protect work derived from an earlier get_project response.
   */
  async updateProject(
    ref: string,
    fields: Record<string, unknown>,
    merge = true,
    orgRef?: string,
    expectedRevision?: string,
  ): Promise<Revisioned<SaveResult>> {
    const expected = expectedRevision ? checkedRevisionETag(expectedRevision) : undefined;
    const current = await this.getProjectWithRevision(ref, orgRef);
    if (expected && expected !== current.etag) {
      throw new RailyardApiError(
        412,
        `Revision conflict (412): the project changed after revision ${expected}. Reload it and reapply your changes; no changes were saved.`,
      );
    }
    const candidate = merge ? { ...current.value, ...fields } : { ...fields };
    const project = {
      ...candidate,
      id: current.value.id,
      schemaVersion:
        typeof candidate.schemaVersion === "string" && candidate.schemaVersion
          ? candidate.schemaVersion
          : current.value.schemaVersion,
    } as Project;
    return this.saveProjectAtRevision(project, current.etag, orgRef);
  }

  /** POST /api/projects/{id}/rename — change the name + URL slug. */
  async renameProject(id: string, name: string, orgRef?: string): Promise<{ slug: string }> {
    const orgId = await this.resolveOrgId(orgRef);
    return this.request<{ slug: string }>("POST", `/api/projects/${encodeURIComponent(id)}/rename`, {
      orgId,
      body: { name },
    });
  }

  // ---- stateless: server info, validation and export ------------------------
  // These four endpoints need no org and no authentication — they operate on a document the
  // caller supplies, which is why the CLI and the local-first frontend can use them too.

  /** GET /api/health — version, schema version, and which features this server has configured. */
  health(): Promise<Health> {
    return this.request<Health>("GET", "/api/health");
  }

  /** GET /api/formats — the export targets this build supports. */
  formats(): Promise<FormatInfo[]> {
    return this.request<FormatInfo[]>("GET", "/api/formats");
  }

  /** POST /api/validate — design-level problems (never mutates, never rejects a valid document). */
  async validate(project: Project): Promise<{ problems: Problem[] | null }> {
    return this.request<{ problems: Problem[] | null }>("POST", "/api/validate", { body: project });
  }

  /** POST /api/export?format=… — render a project into a downstream format. */
  async exportProject(project: Project, format: string, opts: ExportOptions = {}): Promise<ExportResult> {
    const q = new URLSearchParams({ format });
    if (opts.placeholders) q.set("placeholders", "1");
    if (opts.fallbackLocation) q.set("fallbackLocation", opts.fallbackLocation);
    return this.request<ExportResult>("POST", `/api/export?${q.toString()}`, { body: project });
  }

  // ---- organisations --------------------------------------------------------
  // Org-management routes name the org in the PATH, not the X-Org-Id header, so every one of
  // these resolves the reference to a concrete id first.

  /** GET /api/orgs/{id}/catalog and the ETag required to replace it (any member). */
  async getOrgCatalogWithRevision(orgRef?: string): Promise<Revisioned<unknown[]>> {
    const orgId = await this.requireOrgId(orgRef);
    return this.requestRevisioned<unknown[]>("GET", `/api/orgs/${encodeURIComponent(orgId)}/catalog`);
  }

  /** PUT /api/orgs/{id}/catalog — replace the shared device-type library (editor+). */
  async setOrgCatalog(catalogue: unknown[], etag: string, orgRef?: string): Promise<Revisioned<void>> {
    const revision = checkedRevisionETag(etag);
    const orgId = await this.requireOrgId(orgRef);
    return this.requestRevisioned<void>("PUT", `/api/orgs/${encodeURIComponent(orgId)}/catalog`, {
      body: catalogue,
      ifMatch: revision,
    });
  }

  /** GET /api/orgs/{id}/roles — shared device-role vocabulary plus its revision. */
  async getOrgRolesWithRevision(orgRef?: string): Promise<Revisioned<string[]>> {
    const orgId = await this.requireOrgId(orgRef);
    return this.requestRevisioned<string[]>("GET", `/api/orgs/${encodeURIComponent(orgId)}/roles`);
  }

  /** PUT /api/orgs/{id}/roles — conditionally replace the shared device-role vocabulary. */
  async setOrgRoles(roles: string[], etag: string, orgRef?: string): Promise<Revisioned<void>> {
    const revision = checkedRevisionETag(etag);
    const orgId = await this.requireOrgId(orgRef);
    return this.requestRevisioned<void>("PUT", `/api/orgs/${encodeURIComponent(orgId)}/roles`, {
      body: [...roles],
      ifMatch: revision,
    });
  }

  // ---- members & invitations ------------------------------------------------

  /** GET /api/orgs/{id}/members — the roster (any member may read it). */
  async members(orgRef?: string): Promise<Member[]> {
    const orgId = await this.requireOrgId(orgRef);
    return this.request<Member[]>("GET", `/api/orgs/${encodeURIComponent(orgId)}/members`);
  }

  /** GET /api/orgs/{id}/invites — pending invitations for an org (owner-only). */
  async invites(orgRef?: string): Promise<Invite[]> {
    const orgId = await this.requireOrgId(orgRef);
    return this.request<Invite[]>("GET", `/api/orgs/${encodeURIComponent(orgId)}/invites`);
  }

  /** GET /api/invites — the token user's own pending invitations (matched by verified email). */
  myInvites(): Promise<Invite[]> {
    return this.request<Invite[]>("GET", "/api/invites");
  }

  // ---- billing --------------------------------------------------------------

  /** GET /api/orgs/{id}/billing — plan, status, seats and entitlement (any member may read). */
  async billing(orgRef?: string): Promise<Billing> {
    const orgId = await this.requireOrgId(orgRef);
    return this.request<Billing>("GET", `/api/orgs/${encodeURIComponent(orgId)}/billing`);
  }

}
