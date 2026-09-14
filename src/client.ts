// A small, typed HTTP client for the Railyard REST API.
//
// One place owns all of the wire concerns:
//   - authentication  — every request carries `Authorization: Bearer ry_…` (a Railyard
//     personal access token). The token authenticates as its owning user across all of
//     that user's organisations. It is NEVER logged.
//   - org selection    — org-scoped calls carry the `X-Org-Id` header, which the server
//     membership-checks (403 if the caller is not a member). The header must be an org
//     *id*; a slug or name supplied by the caller is resolved to an id via GET /api/orgs.
//   - error surfacing  — non-2xx responses ({"error": "..."}) become RailyardApiError with
//     a human-readable, status-aware message the tools relay straight to the model.

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
  plan: string; // individual | team | enterprise
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
  plan: string; // individual | team | enterprise
  status: string; // trialing | active | past_due | canceled
  seats: number;
  trialEndsAt?: string;
  currentPeriodEnd?: string;
  hasSubscription: boolean;
  entitled: boolean; // currently allowed to edit
  canManage: boolean; // the caller is an owner
  configured: boolean; // Stripe self-serve is enabled on this server
}

/** Server capability/readiness report. Mirror of GET /api/health. */
export interface Health {
  status: string; // ok | degraded
  version: string;
  schemaVersion: string;
  persistence: boolean; // a database is configured and reachable
  auth: boolean;
  landing: boolean;
  billing: boolean; // Stripe self-serve is configured
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

/** An error carrying the HTTP status so tools can present it plainly. status 0 = transport failure. */
export class RailyardApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly bodyText?: string,
  ) {
    super(message);
    this.name = "RailyardApiError";
  }
}

/** Pull the server's {"error": "..."} message out of a body, falling back to the raw text. */
function serverMessage(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed && typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    // not JSON — fall through to the raw text
  }
  return text.slice(0, 500);
}

/** Turn an HTTP status + body into a readable, actionable message. */
function describeError(status: number, text: string): string {
  const detail = serverMessage(text);
  const suffix = detail ? `: ${detail}` : "";
  switch (status) {
    case 400:
      return `Bad request (400)${suffix}`;
    case 401:
      return `Authentication failed (401)${suffix}. Check RAILYARD_TOKEN is a current "ry_…" personal access token.`;
    case 402:
      return `Payment required (402)${suffix}. This organisation's plan has lapsed, so it is read-only until renewed.`;
    case 403:
      return `Forbidden (403)${suffix}. The token's user is not a member of this organisation, or lacks the role this action needs (writes need editor+; member, invite and billing changes need owner).`;
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
      return `Unavailable (503)${suffix}. The feature is not configured on this server.`;
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
    if (!res.ok) {
      throw new RailyardApiError(res.status, describeError(res.status, text), text);
    }
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

  /** DELETE /api/projects/{id} — permanently remove the project. */
  async deleteProject(id: string, orgRef?: string): Promise<void> {
    const orgId = await this.resolveOrgId(orgRef);
    await this.request<void>("DELETE", `/api/projects/${encodeURIComponent(id)}`, { orgId });
  }

  /**
   * POST /api/projects/{id}/move — move the project from one org into another. `name` optionally
   * renames it as part of the move, which is how a clash with an existing name in the target org
   * is resolved in one step.
   */
  async moveProject(
    id: string,
    toOrgRef: string,
    fromOrgRef?: string,
    name?: string,
  ): Promise<{ id: string; orgId: string; slug: string }> {
    const fromOrgId = await this.resolveOrgId(fromOrgRef);
    const toOrgId = await this.requireOrgId(toOrgRef);
    return this.request<{ id: string; orgId: string; slug: string }>(
      "POST",
      `/api/projects/${encodeURIComponent(id)}/move`,
      { orgId: fromOrgId, body: { orgId: toOrgId, ...(name ? { name } : {}) } },
    );
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

  /** POST /api/orgs — create a shared org; the caller becomes its owner. */
  createOrg(name: string): Promise<Org> {
    return this.request<Org>("POST", "/api/orgs", { body: { name } });
  }

  /** PATCH /api/orgs/{id} — change an org's display name (owner-only). */
  async renameOrg(orgRef: string, name: string): Promise<Org> {
    const orgId = await this.requireOrgId(orgRef);
    return this.request<Org>("PATCH", `/api/orgs/${encodeURIComponent(orgId)}`, { body: { name } });
  }

  /** DELETE /api/orgs/{id} — delete a shared org and every project in it (owner-only). */
  async deleteOrg(orgRef: string): Promise<void> {
    const orgId = await this.requireOrgId(orgRef);
    await this.request<void>("DELETE", `/api/orgs/${encodeURIComponent(orgId)}`);
  }

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

  /** PUT /api/orgs/{id}/members/{userId} — change a member's role (owner-only). */
  async setMemberRole(userId: string, role: string, orgRef?: string): Promise<void> {
    const orgId = await this.requireOrgId(orgRef);
    await this.request<void>("PUT", `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
      body: { role },
    });
  }

  /** DELETE /api/orgs/{id}/members/{userId} — remove a member (owner-only). */
  async removeMember(userId: string, orgRef?: string): Promise<void> {
    const orgId = await this.requireOrgId(orgRef);
    await this.request<void>("DELETE", `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`);
  }

  /** GET /api/orgs/{id}/invites — pending invitations for an org (owner-only). */
  async invites(orgRef?: string): Promise<Invite[]> {
    const orgId = await this.requireOrgId(orgRef);
    return this.request<Invite[]>("GET", `/api/orgs/${encodeURIComponent(orgId)}/invites`);
  }

  /** POST /api/orgs/{id}/invites — invite an email to join at a role (owner-only). */
  async createInvite(email: string, role: string | undefined, orgRef?: string): Promise<Invite> {
    const orgId = await this.requireOrgId(orgRef);
    return this.request<Invite>("POST", `/api/orgs/${encodeURIComponent(orgId)}/invites`, {
      body: { email, ...(role ? { role } : {}) },
    });
  }

  /** DELETE /api/orgs/{id}/invites/{inviteId} — withdraw a pending invitation (owner-only). */
  async revokeInvite(inviteId: string, orgRef?: string): Promise<void> {
    const orgId = await this.requireOrgId(orgRef);
    await this.request<void>(
      "DELETE",
      `/api/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
    );
  }

  /** GET /api/invites — the token user's own pending invitations (matched by verified email). */
  myInvites(): Promise<Invite[]> {
    return this.request<Invite[]>("GET", "/api/invites");
  }

  /** POST /api/invites/{id}/accept — accept an invitation addressed to the token user's email. */
  async acceptInvite(inviteId: string): Promise<Org> {
    const org = await this.request<Org>("POST", `/api/invites/${encodeURIComponent(inviteId)}/accept`, { body: {} });
    this.orgsCache = undefined; // the user is in a new org now — don't resolve against a stale list
    return org;
  }

  // ---- billing --------------------------------------------------------------

  /** GET /api/orgs/{id}/billing — plan, status, seats and entitlement (any member may read). */
  async billing(orgRef?: string): Promise<Billing> {
    const orgId = await this.requireOrgId(orgRef);
    return this.request<Billing>("GET", `/api/orgs/${encodeURIComponent(orgId)}/billing`);
  }

  /**
   * POST /api/orgs/{id}/billing/{checkout|portal} — mint a Stripe hosted-page URL for the owner to
   * open in a browser. Minting a URL neither charges nor changes the subscription; the owner
   * completes (or abandons) the change on Stripe's page.
   */
  async billingURL(kind: "checkout" | "portal", orgRef?: string): Promise<{ url: string }> {
    const orgId = await this.requireOrgId(orgRef);
    return this.request<{ url: string }>("POST", `/api/orgs/${encodeURIComponent(orgId)}/billing/${kind}`, {
      body: {},
    });
  }
}
