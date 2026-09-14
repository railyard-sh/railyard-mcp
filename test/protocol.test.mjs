import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("auth helper prints the token setup URL without requiring a token", async () => {
  const response = await runNode(
    [new URL("../dist/index.js", import.meta.url).pathname, "auth", "--no-open"],
    {
      RAILYARD_TOKEN: "",
      RAILYARD_BASE_URL: "https://railyard.sh",
      RAILYARD_ORG: "acme",
    },
  );

  assert.equal(response.code, 0);
  assert.match(response.stdout, /https:\/\/railyard\.sh\/o\/acme\/user/);
  assert.match(response.stdout, /RAILYARD_TOKEN/);
  assert.equal(response.stderr, "");
});

test("auth helper defaults to hosted Railyard and login remains an alias", async () => {
  for (const command of ["auth", "login"]) {
    const response = await runNode(
      [new URL("../dist/index.js", import.meta.url).pathname, command, "--no-open"],
      { RAILYARD_TOKEN: "", RAILYARD_BASE_URL: "", RAILYARD_ORG: "" },
    );

    assert.equal(response.code, 0);
    assert.match(response.stdout, /https:\/\/railyard\.sh\//);
    assert.equal(response.stderr, "");
  }
});

test("stdio startup never writes authentication instructions to stdout", async () => {
  const response = await runNode(
    [new URL("../dist/index.js", import.meta.url).pathname],
    { RAILYARD_TOKEN: "", RAILYARD_BASE_URL: "", RAILYARD_ORG: "" },
  );

  assert.equal(response.code, 1);
  assert.equal(response.stdout, "");
  assert.match(response.stderr, /railyard-mcp auth/);
});

test("stdio initialization exposes revision-safe project, catalogue and role tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname],
    env: {
      RAILYARD_TOKEN: "fixture_contract_test",
      RAILYARD_BASE_URL: "http://127.0.0.1:1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "railyard-mcp-contract-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const response = await client.listTools();
    const tools = new Map(response.tools.map((tool) => [tool.name, tool]));

    for (const name of ["get_project", "update_project", "get_org_catalog", "set_org_catalog", "get_org_roles", "set_org_roles"]) {
      assert(tools.has(name), `missing ${name}`);
    }
    assert(tools.get("update_project").inputSchema.properties.revision);
    assert(tools.get("set_org_catalog").inputSchema.required.includes("revision"));
    assert(tools.get("set_org_roles").inputSchema.required.includes("revision"));
  } finally {
    await client.close();
  }
});
