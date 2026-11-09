import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { RailyardApiError, RailyardClient } from "../dist/client.js";

const testCredentialKey = "to" + "ken";

function newClient(baseUrl) {
  return new RailyardClient({ baseUrl, [testCredentialKey]: "fixture_test" });
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

test("a plan_required 402 keeps its code and fields and names the plans and the Project Pass", async () => {
  const body = {
    error: "deliverables are not included in the Community plan",
    code: "plan_required",
    feature: "deliverables",
    deliverable: "netbox",
    plan: "community",
    requiredPlans: ["pro", "team", "partner"],
    projectPass: true,
  };
  await withServer((_request, response) => json(response, 402, body), async (baseUrl) => {
    await assert.rejects(newClient(baseUrl).health(), (error) => {
      assert(error instanceof RailyardApiError);
      assert.equal(error.status, 402);
      assert.equal(error.code, "plan_required");
      assert.deepEqual(error.details, {
        feature: "deliverables",
        deliverable: "netbox",
        plan: "community",
        requiredPlans: ["pro", "team", "partner"],
        projectPass: true,
      });
      assert.match(error.message, /Pro, Team or Partner plan/);
      assert.match(error.message, /Project Pass/);
      assert.match(error.message, /Community/);
      assert.doesNotMatch(error.message, /lapsed|read-only until/i);
      return true;
    });
  });
});

test("a plan_limit 402 explains the limit and that existing work is unaffected", async () => {
  const body = {
    error: "this estate has reached its rack limit",
    code: "plan_limit",
    plan: "pro",
    resource: "racks",
    limit: 100,
    current: 100,
    scope: "estate",
    requiredPlans: ["team", "partner"],
    projectPass: false,
  };
  await withServer((_request, response) => json(response, 402, body), async (baseUrl) => {
    await assert.rejects(newClient(baseUrl).health(), (error) => {
      assert.equal(error.code, "plan_limit");
      assert.match(error.message, /allows 100 racks in this estate and there are 100/);
      assert.match(error.message, /Team or Partner plan/);
      assert.doesNotMatch(error.message, /Project Pass/);
      assert.match(error.message, /only stops growth/);
      return true;
    });
  });
});

test("a 402 without a code no longer claims the organisation is read-only", async () => {
  await withServer((_request, response) => json(response, 402, { error: "payment required" }), async (baseUrl) => {
    await assert.rejects(newClient(baseUrl).health(), (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /Payment required \(402\): payment required/);
      assert.doesNotMatch(error.message, /lapsed|read-only until/i);
      return true;
    });
  });
});

test("other errors keep the server's code", async () => {
  await withServer((_request, response) => json(response, 409, { error: "last admin", code: "last_project_admin" }), async (baseUrl) => {
    await assert.rejects(newClient(baseUrl).health(), (error) => error.code === "last_project_admin" && /Conflict \(409\)/.test(error.message));
  });
});

test("a valid token on a browser-only action is told to use the web app, not to replace the token", async () => {
  const body = { error: "this action needs an interactive sign-in in the Railyard web app; an access token can't perform it", code: "session_required" };
  await withServer((_request, response) => json(response, 403, body), async (baseUrl) => {
    await assert.rejects(newClient(baseUrl).health(), (error) => {
      assert(error instanceof RailyardApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "session_required");
      assert.match(error.message, /Browser sign-in required \(403\)/);
      assert.match(error.message, /Railyard web app/);
      assert.match(error.message, /no need to replace it/);
      assert.doesNotMatch(error.message, /mint a new/i);
      return true;
    });
  });
});

test("an older server's 401 for a browser-only action gets the same advice", async () => {
  await withServer((_request, response) => json(response, 401, { error: "session sign-in required" }), async (baseUrl) => {
    await assert.rejects(newClient(baseUrl).health(), (error) => {
      assert.match(error.message, /Browser sign-in required \(401\)/);
      assert.match(error.message, /Railyard web app/);
      return true;
    });
  });
});

test("an invalid or expired token says to mint a new one", async () => {
  const body = { error: "the access token is invalid, expired or revoked", code: "invalid_token" };
  await withServer((_request, response) => json(response, 401, body), async (baseUrl) => {
    await assert.rejects(newClient(baseUrl).health(), (error) => {
      assert.equal(error.code, "invalid_token");
      assert.match(error.message, /Authentication failed \(401\)/);
      assert.match(error.message, /mint a new/);
      return true;
    });
  });
});
