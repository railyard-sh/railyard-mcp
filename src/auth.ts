import { spawn } from "node:child_process";

export const DEFAULT_BASE_URL = "https://railyard.sh";

type Platform = NodeJS.Platform;

type SpawnedProcess = {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
};

type SpawnProcess = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: true },
) => SpawnedProcess;

type BrowserDependencies = {
  platform?: Platform;
  spawnProcess?: SpawnProcess;
};

type AuthOptions = {
  baseUrl?: string;
  defaultOrg?: string;
};

type AuthHelperDependencies = {
  openBrowser?: (url: string) => Promise<boolean>;
  write?: (message: string) => void;
};

/** Parse and normalise a configured Railyard origin without accepting executable URL schemes. */
export function resolveBaseUrl(value: string | undefined): string {
  const candidate = value?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("RAILYARD_BASE_URL must be a valid http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("RAILYARD_BASE_URL must be a valid http or https URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("RAILYARD_BASE_URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("RAILYARD_BASE_URL must not contain a query string or fragment");
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

/** Resolve the nearest token-settings page possible without needing an authenticated API call. */
export function tokenSetupUrl(options: AuthOptions): string {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const org = options.defaultOrg?.trim();
  if (!org || !/^[a-z0-9][a-z0-9-]*$/.test(org)) return `${baseUrl}/`;
  return `${baseUrl}/o/${encodeURIComponent(org)}/user`;
}

function launcherFor(platform: Platform, url: string): [command: string, args: string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

function openableBrowserUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("browser auth URL must be an http or https URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("browser auth URL must not contain credentials");
  }
  return parsed.toString();
}

/**
 * Build the small OS-browser adapter. The URL is always a distinct process argument and the
 * process never uses a shell, so URL punctuation cannot be interpreted as a command.
 */
export function createBrowserOpener(dependencies: BrowserDependencies = {}): (url: string) => Promise<boolean> {
  const platform = dependencies.platform ?? process.platform;
  const spawnProcess: SpawnProcess = dependencies.spawnProcess ?? ((command, args, options) => spawn(command, args, options));

  return async (url: string): Promise<boolean> => {
    const safeUrl = openableBrowserUrl(url);
    const [command, args] = launcherFor(platform, safeUrl);
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (opened: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(opened);
      };

      try {
        const child = spawnProcess(command, args, { stdio: "ignore", windowsHide: true });
        child.once("error", () => finish(false));
        child.once("close", (code) => finish(code === 0));
      } catch {
        finish(false);
      }
    });
  };
}

export const openInBrowser = createBrowserOpener();

/** Run the interactive convenience command without ever writing to the MCP stdout channel. */
export async function runAuthHelper(
  args: string[],
  options: AuthOptions,
  dependencies: AuthHelperDependencies = {},
): Promise<void> {
  const unsupported = args.filter((arg) => arg !== "--no-open");
  if (unsupported.length > 0) {
    throw new Error(`Unknown auth option: ${unsupported[0]}`);
  }

  const url = tokenSetupUrl(options);
  const write = dependencies.write ?? ((message: string) => console.log(message));
  const shouldOpen = !args.includes("--no-open");
  const opened = shouldOpen ? await (dependencies.openBrowser ?? openInBrowser)(url) : false;

  write(
    opened
      ? `Opened Railyard in your browser for token setup:\n${url}`
      : `Open this URL to create a Railyard personal access token:\n${url}`,
  );
  write(
    "\nCreate a token, copy the ry_... secret, then set RAILYARD_TOKEN in your MCP client config. " +
      "If this opened the project list, use User settings -> API tokens.",
  );
}

export function helpText(): string {
  return `Railyard MCP server

Usage:
  railyard-mcp                 Start the stdio MCP server
  railyard-mcp auth            Open Railyard in your browser for token setup
  railyard-mcp login           Alias for auth
  railyard-mcp auth --no-open  Print the token setup URL without opening a browser

Environment:
  RAILYARD_TOKEN      ry_... personal access token required for MCP tools
  RAILYARD_BASE_URL   Railyard base URL, defaults to ${DEFAULT_BASE_URL}
  RAILYARD_ORG        Optional default org slug, name or id`;
}
