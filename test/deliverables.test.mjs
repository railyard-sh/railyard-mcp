import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { RailyardApiError, RailyardClient, dispositionFilename } from "../dist/client.js";
import { exportDeliverable, isUnknownRoute, readZip } from "../dist/deliverables.js";

const testCredentialKey = "to" + "ken";
const tokenEnvName = "RAILYARD_" + "TOKEN";

function newClient(baseUrl) {
  return new RailyardClient({ baseUrl, [testCredentialKey]: "fixture_test" });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function withServer(handler, run) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

/** A zip with a data descriptor per entry, as Go's archive/zip writes it (local sizes left zero). */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, content, deflate } of entries) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x08, 6); // sizes follow in a data descriptor
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(nameBytes.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(raw.length, 12);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x08, 8);
    header.writeUInt16LE(deflate ? 8 : 0, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data, descriptor);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const projects = [{ id: "prj_estate", name: "Estate", slug: "estate", updatedAt: "2026-10-06T00:00:00Z" }];
const orgs = [{ id: "org_home", name: "Home", slug: "home", personal: true, plan: "community", status: "active", createdAt: "" }];

test("a zip deliverable is posted with the org header and unpacked into readable files", async () => {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, org: request.headers["x-org-id"] });
    if (request.url === "/api/orgs") return json(response, 200, orgs);
    if (request.url === "/api/projects") return json(response, 200, projects);
    if (request.url === "/api/projects/prj_estate/deliverables/netbox") {
      assert.deepEqual(JSON.parse(await readBody(request)), {
        changeRequestId: "cr_1",
        options: { netboxVersion: "4.2", placeholders: true },
      });
      response.setHeader("Content-Type", "application/zip");
      response.setHeader("Content-Disposition", 'attachment; filename="railyard-netbox.zip"');
      response.end(zip([
        { name: "01-sites.csv", content: "name,slug\nLondon,london\n" },
        { name: "project.json", content: '{"id":"prj_estate"}', deflate: true },
      ]));
      return;
    }
    return json(response, 404, { error: "unexpected route" });
  }, async (baseUrl) => {
    const result = await exportDeliverable(newClient(baseUrl), {
      ref: "estate",
      kind: "netbox",
      org: "home",
      changeRequestId: "cr_1",
      options: { netboxVersion: "4.2", placeholders: true, fallbackLocation: undefined },
    });
    assert.equal(result.kind, "netbox");
    assert.deepEqual(result.files, [
      { name: "01-sites.csv", mime: "text/csv", bytes: 24, content: "name,slug\nLondon,london\n" },
      { name: "project.json", mime: "application/json", bytes: 19, content: '{"id":"prj_estate"}' },
    ]);
  });
  const post = requests.find((r) => r.method === "POST");
  assert.equal(post.org, "org_home");
});

test("a binary deliverable is base64 inline, or written under saveTo without overwriting", async () => {
  const pdf = Buffer.from("%PDF-1.7 fixture");
  const dir = await mkdtemp(join(tmpdir(), "railyard-mcp-"));
  try {
    await withServer((request, response) => {
      if (request.url === "/api/projects") return json(response, 200, projects);
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Content-Disposition", "attachment; filename*=UTF-8''Estate%20build%20pack.pdf");
      response.end(pdf);
    }, async (baseUrl) => {
      const client = newClient(baseUrl);
      const inline = await exportDeliverable(client, { ref: "prj_estate", kind: "build-pack" });
      assert.deepEqual(inline.files, [
        { name: "Estate build pack.pdf", mime: "application/pdf", bytes: pdf.length, contentBase64: pdf.toString("base64") },
      ]);

      const saved = await exportDeliverable(client, { ref: "prj_estate", kind: "build-pack" }, join(dir, "out"));
      const path = join(dir, "out", "Estate build pack.pdf");
      assert.deepEqual(saved.files, [{ name: "Estate build pack.pdf", mime: "application/pdf", bytes: pdf.length, path }]);
      assert.deepEqual(await readFile(path), pdf);

      await assert.rejects(
        exportDeliverable(client, { ref: "prj_estate", kind: "build-pack" }, join(dir, "out")),
        (error) => error instanceof RailyardApiError && error.status === 409 && /already exists/.test(error.message),
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an export report answered as JSON keeps its summary, warnings and unresolved placements", async () => {
  await withServer((request, response) => {
    if (request.url === "/api/projects") return json(response, 200, projects);
    json(response, 200, {
      format: "nautobot-csv",
      summary: "3 files",
      warnings: ["alias assigned"],
      unresolved: [],
      files: [{ name: "locations.csv", mime: "text/csv", contentBase64: Buffer.from("name\nA\n").toString("base64") }],
    });
  }, async (baseUrl) => {
    const result = await exportDeliverable(newClient(baseUrl), { ref: "prj_estate", kind: "nautobot" });
    assert.equal(result.summary, "3 files");
    assert.deepEqual(result.warnings, ["alias assigned"]);
    assert.deepEqual(result.files, [{ name: "locations.csv", mime: "text/csv", bytes: 7, content: "name\nA\n" }]);
  });
});

test("only a missing route, not a missing project or a refusal, counts as an older server", () => {
  const error = (status, body) => new RailyardApiError(status, "x", JSON.stringify(body), body.code);
  assert.equal(isUnknownRoute(error(404, { error: "not found" })), true);
  assert.equal(isUnknownRoute(error(405, { error: "method not allowed" })), true);
  assert.equal(isUnknownRoute(error(404, { error: "project not found" })), false);
  assert.equal(isUnknownRoute(error(402, { error: "x", code: "plan_required" })), false);
  assert.equal(isUnknownRoute(new Error("boom")), false);
});

test("zip entries and download filenames are read the way the server writes them", () => {
  assert.deepEqual(readZip(zip([{ name: "dir/", content: "" }, { name: "a.yaml", content: "a: 1\n", deflate: true }])), [
    { name: "a.yaml", mime: "application/yaml", bytes: Buffer.from("a: 1\n") },
  ]);
  assert.equal(dispositionFilename('attachment; filename="railyard-netbox.zip"'), "railyard-netbox.zip");
  assert.equal(dispositionFilename("attachment; filename=railyard-netbox.zip"), "railyard-netbox.zip");
  assert.equal(dispositionFilename("attachment; filename=\"a.pdf\"; filename*=UTF-8''b%20c.pdf"), "b c.pdf");
  assert.equal(dispositionFilename(null), "");
});

test("export_project sends DCIM formats for a saved project to the deliverables route and keeps json on /api/export", async () => {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/api/projects") return json(response, 200, projects);
    if (request.url === "/api/projects/prj_estate/deliverables/netbox") {
      return json(response, 402, {
        error: "deliverables are not included in the Community plan",
        code: "plan_required",
        feature: "deliverables",
        plan: "community",
        requiredPlans: ["pro", "team", "partner"],
        projectPass: true,
      });
    }
    if (request.url === "/api/projects/prj_estate") return json(response, 200, { schemaVersion: "1", id: "prj_estate" });
    if (request.url.startsWith("/api/export?format=json")) {
      return json(response, 200, { format: "json", summary: "ok", unresolved: [], warnings: [], files: [] });
    }
    return json(response, 404, { error: "unexpected route" });
  }, async (baseUrl) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../dist/index.js", import.meta.url).pathname],
      env: { [tokenEnvName]: "ry_fixture_contract", RAILYARD_BASE_URL: baseUrl },
      stderr: "pipe",
    });
    const client = new Client({ name: "railyard-mcp-deliverables-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      assert.deepEqual(tools.get("export_deliverable").inputSchema.properties.kind.enum, [
        "build-pack", "build-pack-preview", "cable-schedule", "cable-labels", "power-schedule", "power-report",
        "netbox", "nautobot", "designbuilder",
      ]);
      assert.match(tools.get("export_project").description, /inline `project`.*only be exported as json/s);

      const refused = await client.callTool({ name: "export_project", arguments: { format: "netbox-csv", ref: "prj_estate" } });
      assert.equal(refused.isError, true);
      const [message, details] = refused.content[0].text.split("\n");
      assert.match(message, /Pro, Team or Partner plan, or buy a Project Pass/);
      assert.deepEqual(JSON.parse(details), {
        status: 402,
        code: "plan_required",
        feature: "deliverables",
        plan: "community",
        requiredPlans: ["pro", "team", "partner"],
        projectPass: true,
      });

      const exported = await client.callTool({ name: "export_project", arguments: { format: "json", ref: "prj_estate" } });
      assert.equal(exported.isError, undefined);
    } finally {
      await client.close();
    }
  });
  assert(requests.includes("POST /api/projects/prj_estate/deliverables/netbox"));
  assert(requests.includes("POST /api/export?format=json"));
  assert(!requests.some((r) => r.startsWith("POST /api/export?format=netbox")));
});
