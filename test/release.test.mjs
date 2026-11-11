import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("every workflow action is pinned to a full commit SHA with a version comment", async () => {
  const dir = new URL(".github/workflows/", root);
  const files = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name));
  assert(files.includes("release.yml"));
  for (const name of files) {
    const source = await readFile(new URL(name, dir), "utf8");
    for (const [, ref] of source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+.*)$/gm)) {
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/, `${name}: ${ref}`);
    }
  }
});

test("npm releases use trusted publishing with provenance and locked installs", async () => {
  const release = await read(".github/workflows/release.yml");
  assert.match(release, /^on:\n {2}release:\n {4}types: \[published\]/m);
  assert.match(release, /npm publish --provenance --access public/);
  assert.match(release, /id-token: write/);
  assert.match(release, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.doesNotMatch(release, /npm install(?! --ignore-scripts)/);
  assert.match(release, /sha256sum .*> SHA256SUMS/);
  for (const name of ["ci.yml", "release.yml"]) {
    const workflow = await read(`.github/workflows/${name}`);
    assert.match(workflow, /run: npm ci/, name);
  }
});

test("install docs pin the package to the current version", async () => {
  const { version } = JSON.parse(await read("package.json"));
  for (const path of ["README.md", "INSTALL.md"]) {
    const doc = await read(path);
    assert.doesNotMatch(doc, /npx (-y )?railyard-mcp(?!@)/, `${path} has an unpinned npx railyard-mcp`);
    assert.doesNotMatch(doc, /"railyard-mcp"\]/, `${path} has an unpinned railyard-mcp in args`);
    const pins = [...doc.matchAll(/railyard-mcp(?:@|-)(\d+\.\d+\.\d+[\w.-]*?)(?=\.mcpb|[^\w.-]|\.?$)/gm)].map((match) => match[1]);
    assert(pins.length > 0, `${path} pins no version`);
    for (const pin of pins) assert.equal(pin, version, `${path} pins railyard-mcp@${pin}`);
    assert.match(doc, /npm audit signatures/, `${path} explains how to verify provenance`);
  }
});
