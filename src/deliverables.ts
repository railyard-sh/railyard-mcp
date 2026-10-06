// Deliverables: the paid outputs Railyard generates from a STORED project — the build pack PDF,
// cable schedule, cable and rack labels, power schedule, power report, and the NetBox and Nautobot
// bulk-import bundles (Design Builder YAML counts as Nautobot).
//
// They come from POST /api/projects/{id}/deliverables/{kind} with the org in X-Org-Id. On a server
// with billing on, that answers 402 plan_required / plan_limit when the plan (or a Project Pass on
// the estate) does not include them; with billing off every deliverable is available. The raw
// Project JSON is not a deliverable: it stays on POST /api/export and is free everywhere.
//
// The response body is the file itself: a single file, or a zip for a multi-file bundle. Older
// servers answered the DCIM formats as JSON from /api/export, so a JSON body in that shape is read
// too, and isUnknownRoute() lets export_project fall back to /api/export on a server that predates
// the deliverables route.

import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  parseServerError,
  RailyardApiError,
  type DownloadedFile,
  type ExportResult,
  type RailyardClient,
  type Unresolved,
} from "./client.js";

export const DELIVERABLE_KINDS = [
  "build-pack",
  "build-pack-preview",
  "cable-schedule",
  "cable-labels",
  "power-schedule",
  "power-report",
  "netbox",
  "nautobot",
  "designbuilder",
] as const;

export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/** export_project format ids that are deliverables, and the deliverable kind each maps to. */
export const FORMAT_KINDS: Readonly<Record<string, DeliverableKind>> = {
  "netbox-csv": "netbox",
  "nautobot-csv": "nautobot",
  "designbuilder-yaml": "designbuilder",
};

/** Options sent as the request body's `options`; only the ones given are sent. */
export interface DeliverableOptions {
  /** build-pack-preview: the rack to preview. */
  rackId?: string;
  /** netbox: the NetBox release to target, e.g. "4.2". */
  netboxVersion?: string;
  /** DCIM bundles: emit unresolved placements as placeholder device types. */
  placeholders?: boolean;
  /** DCIM bundles: location name for racks with no resolvable site. */
  fallbackLocation?: string;
}

export interface DeliverableRequest {
  /** A saved project's id, slug or name. */
  ref: string;
  kind: DeliverableKind;
  org?: string;
  /** Generate from this merge request's draft instead of main. */
  changeRequestId?: string;
  options?: DeliverableOptions;
}

/** One file of a deliverable, as the tool reports it. */
export interface RenderedFile {
  name: string;
  mime: string;
  bytes: number;
  /** Decoded text, for text formats (CSV, YAML, JSON, Markdown…). */
  content?: string;
  /** Base64, for a small binary file (a PDF) when no saveTo directory was given. */
  contentBase64?: string;
  /** Where the file was written, when a saveTo directory was given. */
  path?: string;
  truncated?: true;
  note?: string;
}

export interface DeliverableResult {
  kind: DeliverableKind;
  /** Present when the server answered with an export report rather than a bare file. */
  summary?: string;
  warnings?: string[];
  unresolved?: Unresolved[];
  files: RenderedFile[];
}

interface RawFile {
  name: string;
  mime: string;
  bytes: Buffer;
}

/** Text is decoded into the reply up to this many characters, then truncated with a marker. */
const MAX_TEXT_CHARS = 60_000;
/** A binary file up to this size is returned as base64; a larger one needs saveTo. */
const MAX_INLINE_BINARY_BYTES = 256 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

function mimeFor(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function isText(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    ["application/json", "application/yaml", "application/x-yaml", "application/xml", "image/svg+xml"].includes(mime)
  );
}

/**
 * A saved project's id for the deliverables route: a slug or name is matched against the org's
 * project list; anything unmatched is passed through so the server answers for it.
 */
async function projectId(client: RailyardClient, ref: string, org?: string): Promise<string> {
  const projects = await client.listProjects(org);
  const match =
    projects.find((p) => p.id === ref) ?? projects.find((p) => p.slug === ref) ?? projects.find((p) => p.name === ref);
  return match?.id ?? ref;
}

/** POST /api/projects/{id}/deliverables/{kind} and return the file the server sent. */
export async function requestDeliverable(client: RailyardClient, req: DeliverableRequest): Promise<DownloadedFile> {
  const orgId = await client.resolveOrgId(req.org);
  const id = await projectId(client, req.ref, req.org);
  const options = Object.fromEntries(
    Object.entries(req.options ?? {}).filter(([, value]) => value !== undefined && value !== "" && value !== false),
  );
  const body = {
    ...(req.changeRequestId ? { changeRequestId: req.changeRequestId } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
  return client.download("POST", `/api/projects/${encodeURIComponent(id)}/deliverables/${req.kind}`, { orgId, body });
}

/**
 * True when a deliverables request failed because the server has no such route (it predates
 * deliverables), as opposed to a refusal or a missing project. The catch-all answers a bare
 * {"error":"not found"} or "method not allowed" with no code; a missing project says
 * "project not found", and a plan refusal is a 402.
 */
export function isUnknownRoute(error: unknown): boolean {
  if (!(error instanceof RailyardApiError) || (error.status !== 404 && error.status !== 405) || error.code) {
    return false;
  }
  const message = parseServerError(error.bodyText ?? "").message.trim().toLowerCase();
  return message === "" || message === "not found" || message === "method not allowed" || message.startsWith("404 page not found");
}

/** Read the entries of a zip archive (stored or deflated; no zip64), skipping directories. */
export function readZip(buf: Buffer): RawFile[] {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new RailyardApiError(502, "Railyard sent a zip archive this client could not read.");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files: RawFile[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) {
      throw new RailyardApiError(502, "Railyard sent a zip archive with a malformed directory.");
    }
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    // Sizes come from the central directory: Go's archive/zip writes them after the data
    // (a data descriptor), leaving the local header's copy zero.
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    let bytes: Buffer;
    if (method === 0) bytes = Buffer.from(data);
    else if (method === 8) bytes = inflateRawSync(data);
    else throw new RailyardApiError(502, `Railyard sent a zip entry (${name}) with an unsupported compression method.`);
    files.push({ name, mime: mimeFor(name), bytes });
  }
  return files;
}

/** Split a downloaded deliverable into its files, plus the export report when the server sent one. */
export function unpack(
  file: DownloadedFile,
  kind: DeliverableKind,
): { files: RawFile[]; report?: Pick<ExportResult, "summary" | "warnings" | "unresolved"> } {
  if (file.contentType === "application/json") {
    try {
      const parsed = JSON.parse(file.bytes.toString("utf8")) as Partial<ExportResult>;
      if (parsed && Array.isArray(parsed.files)) {
        return {
          files: parsed.files.map((f) => ({ name: f.name, mime: f.mime, bytes: Buffer.from(f.contentBase64, "base64") })),
          report: { summary: parsed.summary ?? "", warnings: parsed.warnings ?? [], unresolved: parsed.unresolved ?? [] },
        };
      }
    } catch {
      // not an export report — treat it as a single JSON file below
    }
  }
  const zip = file.contentType === "application/zip" || file.bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (zip) return { files: readZip(file.bytes) };
  const name = file.filename || `railyard-${kind}`;
  return { files: [{ name, mime: file.contentType || mimeFor(name), bytes: file.bytes }] };
}

/** A filename safe to create inside the saveTo directory. */
function safeName(name: string): string {
  const flat = name.replace(/[\\/]+/g, "_").replace(/^\.+/, "").trim();
  return flat || "railyard-deliverable";
}

/**
 * Present files for the model: write them under saveTo when given (never overwriting), else decode
 * text inline (truncated past MAX_TEXT_CHARS) and return a small binary file as base64.
 */
export async function present(files: RawFile[], saveTo?: string): Promise<RenderedFile[]> {
  const dir = saveTo ? resolve(saveTo) : undefined;
  if (dir) await mkdir(dir, { recursive: true });
  const out: RenderedFile[] = [];
  for (const f of files) {
    const base = { name: f.name, mime: f.mime, bytes: f.bytes.byteLength };
    if (dir) {
      const path = join(dir, safeName(f.name));
      try {
        await writeFile(path, f.bytes, { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          throw new RailyardApiError(409, `Not saved: ${path} already exists. Choose another saveTo directory.`);
        }
        throw e;
      }
      out.push({ ...base, path });
      continue;
    }
    if (isText(f.mime)) {
      const text = f.bytes.toString("utf8");
      out.push(
        text.length <= MAX_TEXT_CHARS
          ? { ...base, content: text }
          : { ...base, content: `${text.slice(0, MAX_TEXT_CHARS)}\n… truncated (${f.bytes.byteLength} bytes total) …`, truncated: true },
      );
      continue;
    }
    out.push(
      f.bytes.byteLength <= MAX_INLINE_BINARY_BYTES
        ? { ...base, contentBase64: f.bytes.toString("base64") }
        : { ...base, note: `Binary file of ${f.bytes.byteLength} bytes not returned inline; pass saveTo to write it to disk.` },
    );
  }
  return out;
}

/** Fetch a deliverable and present its files: the whole path export tools take. */
export async function exportDeliverable(
  client: RailyardClient,
  req: DeliverableRequest,
  saveTo?: string,
): Promise<DeliverableResult> {
  const downloaded = await requestDeliverable(client, req);
  const { files, report } = unpack(downloaded, req.kind);
  return { kind: req.kind, ...(report ?? {}), files: await present(files, saveTo) };
}
