import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the desktop manifest lists every registered MCP tool", async () => {
  const [source, rawManifest] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(rawManifest);
  const registered = [...source.matchAll(/server\.registerTool\(\s*\n\s*"([^"]+)"/g)].map((match) => match[1]).sort();
  const documented = manifest.tools.map((tool) => tool.name).sort();

  assert.deepEqual(documented, registered);
});

test("package, server and desktop manifest versions stay aligned", async () => {
  const [source, rawManifest, rawPackage] = await Promise.all([
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(rawManifest);
  const packageJSON = JSON.parse(rawPackage);

  assert.equal(manifest.version, packageJSON.version);
  assert.match(source, new RegExp(`name: "railyard-mcp", version: "${packageJSON.version.replaceAll(".", "\\.")}"`));
});
