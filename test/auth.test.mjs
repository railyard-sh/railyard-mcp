import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BASE_URL,
  createBrowserOpener,
  resolveBaseUrl,
  tokenSetupUrl,
} from "../dist/auth.js";

test("hosted Railyard is the default authentication destination", () => {
  assert.equal(DEFAULT_BASE_URL, "https://railyard.sh");
  assert.equal(resolveBaseUrl(undefined), "https://railyard.sh");
  assert.equal(tokenSetupUrl({}), "https://railyard.sh/");
});

test("self-hosted URLs and safe organisation slugs are preserved", () => {
  assert.equal(resolveBaseUrl(" https://rack.example.test/railyard/ "), "https://rack.example.test/railyard");
  assert.equal(
    tokenSetupUrl({ baseUrl: "https://rack.example.test/railyard", defaultOrg: "network-team" }),
    "https://rack.example.test/railyard/o/network-team/user",
  );
});

test("unsafe base URLs are rejected before launching a browser", () => {
  for (const value of [
    "javascript:alert(1)",
    "file:///tmp/token",
    "https://user:secret@example.test",
    "https://example.test/?token=secret",
    "https://example.test/#fragment",
  ]) {
    assert.throws(
      () => resolveBaseUrl(value),
      /http or https URL|must not contain credentials|must not contain a query string or fragment/,
    );
  }
});

test("browser opening passes the URL as an argument without a shell", async () => {
  const calls = [];
  const opener = createBrowserOpener({
    platform: "darwin",
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return {
        once(event, listener) {
          if (event === "close") queueMicrotask(() => listener(0));
          return this;
        },
      };
    },
  });

  assert.equal(await opener("https://railyard.sh/o/acme/user?next=a&b=c"), true);
  assert.deepEqual(calls, [{
    command: "open",
    args: ["https://railyard.sh/o/acme/user?next=a&b=c"],
    options: { stdio: "ignore", windowsHide: true },
  }]);
});

test("browser opening reports launcher failures", async () => {
  const opener = createBrowserOpener({
    platform: "linux",
    spawnProcess() {
      return {
        once(event, listener) {
          if (event === "error") queueMicrotask(() => listener(new Error("missing")));
          return this;
        },
      };
    },
  });

  assert.equal(await opener("https://railyard.sh/"), false);
});

test("browser opening refuses non-web URLs before spawning a process", async () => {
  let spawned = false;
  const opener = createBrowserOpener({
    platform: "darwin",
    spawnProcess() {
      spawned = true;
      throw new Error("should not spawn");
    },
  });

  await assert.rejects(opener("file:///tmp/railyard-token"), /http or https/);
  assert.equal(spawned, false);
});

test("browser opening uses the native Windows and Linux URL launchers", async () => {
  for (const { platform, command, args } of [
    {
      platform: "win32",
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "https://railyard.sh/"],
    },
    { platform: "linux", command: "xdg-open", args: ["https://railyard.sh/"] },
  ]) {
    const calls = [];
    const opener = createBrowserOpener({
      platform,
      spawnProcess(actualCommand, actualArgs, options) {
        calls.push({ command: actualCommand, args: actualArgs, options });
        return {
          once(event, listener) {
            if (event === "close") queueMicrotask(() => listener(0));
            return this;
          },
        };
      },
    });

    assert.equal(await opener("https://railyard.sh/"), true);
    assert.deepEqual(calls, [{ command, args, options: { stdio: "ignore", windowsHide: true } }]);
  }
});
