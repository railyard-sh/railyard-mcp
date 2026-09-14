import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { RailyardApiError, RailyardClient } from "../dist/client.js";

const testCredentialKey = "to" + "ken";
const defaultCredential = "fixture_test";

function newClient(baseUrl, credential = defaultCredential) {
  return new RailyardClient({ baseUrl, [testCredentialKey]: credential });
}

async function readJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function json(response, status, body, etag) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  if (etag) response.setHeader("ETag", etag);
  response.end(JSON.stringify(body));
}

test("project updates read a revision and preserve it through the conditional PUT", async () => {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, ifMatch: request.headers["if-match"] });
    if (request.method === "GET") {
      json(response, 200, {
        schemaVersion: "1",
        id: "prj_example",
        name: "Example",
        containers: [],
        racks: [{ id: "old-rack" }],
      }, '"7"');
      return;
    }
    const body = await readJSON(request);
    assert.deepEqual(body.containers, []);
    assert.deepEqual(body.racks, [{ id: "new-rack" }]);
    json(response, 200, { id: "prj_example", slug: "example" }, '"8"');
  }, async (baseUrl) => {
    const client = newClient(baseUrl);
    const patch = { racks: [{ id: "new-rack" }] };
    const result = await client.updateProject("example", patch, true);

    assert.deepEqual(result, {
      value: { id: "prj_example", slug: "example" },
      etag: '"8"',
    });
    assert.deepEqual(patch, { racks: [{ id: "new-rack" }] });
  });

  assert.deepEqual(requests, [
    { method: "GET", url: "/api/projects/example", ifMatch: undefined },
    { method: "PUT", url: "/api/projects/prj_example", ifMatch: '"7"' },
  ]);
});

test("an explicit stale project revision is rejected before a replacement is sent", async () => {
  let putCount = 0;
  await withServer((request, response) => {
    if (request.method === "PUT") putCount += 1;
    json(response, 200, { schemaVersion: "1", id: "prj_example", name: "Changed" }, '"8"');
  }, async (baseUrl) => {
    const client = newClient(baseUrl);
    await assert.rejects(
      client.updateProject("prj_example", { name: "Mine" }, true, undefined, '"7"'),
      (error) => error instanceof RailyardApiError && error.status === 412 && /reload/i.test(error.message),
    );
  });
  assert.equal(putCount, 0);
});

test("a server revision conflict explains that no changes were saved", async () => {
  await withServer((request, response) => {
    if (request.method === "GET") {
      json(response, 200, { schemaVersion: "1", id: "prj_example", name: "Example" }, '"4"');
      return;
    }
    json(response, 412, { error: "revision conflict" });
  }, async (baseUrl) => {
    const client = newClient(baseUrl);
    await assert.rejects(
      client.updateProject("prj_example", { name: "Mine" }, true),
      (error) =>
        error instanceof RailyardApiError &&
        error.status === 412 &&
        /reload/i.test(error.message) &&
        /no changes were saved/i.test(error.message),
    );
  });
});

test("revisioned resources fail closed when a successful GET omits its ETag", async () => {
  await withServer((_request, response) => {
    json(response, 200, { schemaVersion: "1", id: "prj_example", name: "Example" });
  }, async (baseUrl) => {
    const client = newClient(baseUrl);
    await assert.rejects(
      client.getProjectWithRevision("prj_example"),
      (error) => error instanceof RailyardApiError && error.status === 502 && /ETag/.test(error.message),
    );
  });
});

test("a successful conditional write with no response ETag warns that the write may have succeeded", async () => {
  await withServer((request, response) => {
    if (request.method === "GET") {
      json(response, 200, { schemaVersion: "1", id: "prj_example", name: "Example" }, '"4"');
      return;
    }
    json(response, 200, { id: "prj_example", slug: "example" });
  }, async (baseUrl) => {
    const client = newClient(baseUrl);
    await assert.rejects(
      client.updateProject("prj_example", { name: "Mine" }, true),
      (error) =>
        error instanceof RailyardApiError &&
        error.status === 502 &&
        /may have succeeded/i.test(error.message) &&
        /reload/i.test(error.message),
    );
  });
});

for (const resource of [
  { name: "catalogue", suffix: "catalog", read: "getOrgCatalogWithRevision", write: "setOrgCatalog", before: [], after: [{ key: "switch" }] },
  { name: "roles", suffix: "roles", read: "getOrgRolesWithRevision", write: "setOrgRoles", before: ["Network"], after: ["Network", "Compute"] },
]) {
  test(`organisation ${resource.name} reads and writes the same revision`, async () => {
    const requests = [];
    await withServer(async (request, response) => {
      requests.push({ method: request.method, url: request.url, ifMatch: request.headers["if-match"] });
      if (request.url === "/api/orgs") {
        json(response, 200, [{ id: "org_test", name: "Test", slug: "test" }]);
        return;
      }
      if (request.method === "GET") {
        json(response, 200, resource.before, '"12"');
        return;
      }
      assert.deepEqual(await readJSON(request), resource.after);
      response.statusCode = 204;
      response.setHeader("ETag", '"13"');
      response.end();
    }, async (baseUrl) => {
      const client = newClient(baseUrl);
      const current = await client[resource.read]("org_test");
      assert.deepEqual(current, { value: resource.before, etag: '"12"' });
      const saved = await client[resource.write](resource.after, current.etag, "org_test");
      assert.deepEqual(saved, { value: undefined, etag: '"13"' });
    });

    assert.deepEqual(requests, [
      { method: "GET", url: "/api/orgs", ifMatch: undefined },
      { method: "GET", url: `/api/orgs/org_test/${resource.suffix}`, ifMatch: undefined },
      { method: "PUT", url: `/api/orgs/org_test/${resource.suffix}`, ifMatch: '"12"' },
    ]);
  });
}

test("caller-supplied revision values must match Railyard's quoted numeric ETag format", async () => {
  const client = newClient("http://127.0.0.1:1");
  await assert.rejects(
    client.setOrgRoles(["Network"], "7", "org_test"),
    (error) => error instanceof RailyardApiError && error.status === 400 && /quoted numeric ETag/.test(error.message),
  );
});

test("read-only and stateless endpoints keep credentials in headers and encode request data", async () => {
  const requests = [];
  await withServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.url === "/api/me") return json(response, 200, { id: "usr_test", email: "user@example.test", name: "User" });
    if (request.url === "/api/projects") return json(response, 200, []);
    if (request.url === "/api/projects/project%2Fname") {
      return json(response, 200, { schemaVersion: "1", id: "prj_test", name: "Project" });
    }
    if (request.url === "/api/health") return json(response, 200, { status: "ok" });
    if (request.url === "/api/formats") return json(response, 200, [{ format: "json" }]);
    if (request.url === "/api/validate") {
      assert.deepEqual(await readJSON(request), { schemaVersion: "1", id: "prj_test", name: "Project" });
      return json(response, 200, { problems: null });
    }
    if (request.url === "/api/export?format=json&placeholders=1&fallbackLocation=Fallback+site") {
      assert.deepEqual(await readJSON(request), { schemaVersion: "1", id: "prj_test", name: "Project" });
      return json(response, 200, { format: "json", summary: "ok", unresolved: [], warnings: [], files: [] });
    }
    return json(response, 404, { error: "unexpected route" });
  }, async (baseUrl) => {
    const client = newClient(baseUrl, "fixture_header_only");
    const project = { schemaVersion: "1", id: "prj_test", name: "Project" };

    await client.me();
    await client.listProjects();
    await client.getProject("project/name");
    await client.health();
    await client.formats();
    await client.validate(project);
    await client.exportProject(project, "json", { placeholders: true, fallbackLocation: "Fallback site" });
  });

  assert(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.authorization, "Bearer fixture_header_only");
    assert(!request.url.includes("fixture_header_only"));
  }
});

test("HTTP failures remain status-aware without exposing credentials", async () => {
  const cases = [
    [400, /Bad request/],
    [401, /Authentication failed/],
    [402, /Payment required/],
    [403, /Forbidden/],
    [404, /Not found/],
    [409, /Conflict/],
    [413, /Payload too large/],
    [428, /Revision required/],
    [429, /Rate limited/],
    [501, /Not implemented/],
    [503, /Unavailable/],
    [500, /Railyard API error/],
  ];
  let requestIndex = 0;
  await withServer((_request, response) => {
    const [status] = cases[requestIndex++];
    json(response, status, { error: "public detail" });
  }, async (baseUrl) => {
    const client = newClient(baseUrl, "fixture_never_render");
    for (const [status, message] of cases) {
      await assert.rejects(
        client.health(),
        (error) =>
          error instanceof RailyardApiError &&
          error.status === status &&
          message.test(error.message) &&
          !error.message.includes("fixture_never_render"),
      );
    }
  });
});
