import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

export type CodingMcpTransport = "stdio" | "http" | "sse" | "unknown";
export type CodingMcpServerStatus = "enabled" | "disabled" | "pending-approval";
export type CodingMcpServerSource = "runtime" | "user" | "workspace";

export type DiscoveredCodingMcpServer = {
  /** Provider-local display name. Commands, URLs, headers, and environment stay private. */
  readonly name: string;
  readonly transport: CodingMcpTransport;
  readonly status: CodingMcpServerStatus;
  readonly source: CodingMcpServerSource;
};

export type CodingMcpDiscovery = {
  readonly mode: "native" | "extension" | "unsupported";
  readonly readiness:
    | "discovered"
    | "none"
    | "probe-failed"
    | "runtime-unavailable"
    | "extension-managed"
    | "not-supported";
  readonly servers: ReadonlyArray<DiscoveredCodingMcpServer>;
  readonly truncated: boolean;
};

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
};

export type CodingMcpDiscoveryOptions = {
  readonly runtimeId: string;
  readonly executablePath?: string;
  readonly runtimeAvailable: boolean;
  readonly workingDirectory?: string;
  readonly homeDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: (
    executablePath: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => Promise<CommandResult>;
};

const MAX_MCP_SERVERS = 64;
const MAX_MCP_NAME_LENGTH = 120;
const MAX_CONFIG_BYTES = 2 * 1_048_576;
const MAX_PROBE_BYTES = 512 * 1_024;
const MCP_PROBE_TIMEOUT_MS = 3_000;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const execFileAsync = promisify(execFile);

const boundedName = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > MAX_MCP_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) return undefined;
  return name;
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const transport = (value: unknown): CodingMcpTransport => {
  const entry = record(value);
  const declared = typeof entry?.type === "string" ? entry.type.toLowerCase() : "";
  if (declared.includes("stdio") || typeof entry?.command === "string") return "stdio";
  if (declared.includes("sse")) return "sse";
  if (declared.includes("http") || typeof entry?.url === "string") return "http";
  return "unknown";
};

const boundedServers = (
  servers: ReadonlyArray<DiscoveredCodingMcpServer>,
): { readonly servers: ReadonlyArray<DiscoveredCodingMcpServer>; readonly truncated: boolean } => {
  const unique = new Map<string, DiscoveredCodingMcpServer>();
  for (const server of servers) {
    const key = `${server.source}\u0000${server.name}`;
    if (!unique.has(key)) unique.set(key, server);
  }
  const ordered = [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
  return {
    servers: ordered.slice(0, MAX_MCP_SERVERS),
    truncated: ordered.length > MAX_MCP_SERVERS,
  };
};

const safeProbeEnvironment = (
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): NodeJS.ProcessEnv => ({
  PATH: env.PATH ?? "",
  HOME: homeDirectory,
  ...(env.LANG ? { LANG: env.LANG } : {}),
  ...(env.LC_ALL ? { LC_ALL: env.LC_ALL } : {}),
  ...(env.PATHEXT ? { PATHEXT: env.PATHEXT } : {}),
  ...(env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? { CODEX_HOME: env.CODEX_HOME } : {}),
  ...(env.HERMES_HOME && isAbsolute(env.HERMES_HOME) ? { HERMES_HOME: env.HERMES_HOME } : {}),
});

const defaultRun: NonNullable<CodingMcpDiscoveryOptions["run"]> = async (
  executablePath,
  args,
  options,
) => {
  const result = await execFileAsync(executablePath, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: MCP_PROBE_TIMEOUT_MS,
    maxBuffer: MAX_PROBE_BYTES,
    windowsHide: true,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const codexServers = (value: unknown): ReadonlyArray<DiscoveredCodingMcpServer> => {
  if (!Array.isArray(value)) throw new Error("Codex MCP discovery must return an array");
  return value.flatMap((candidate): ReadonlyArray<DiscoveredCodingMcpServer> => {
    const entry = record(candidate);
    const name = boundedName(entry?.name);
    if (!entry || !name) return [];
    return [{
      name,
      transport: transport(entry.transport),
      status: entry.enabled === false ? "disabled" : "enabled",
      source: "runtime",
    }];
  });
};

const hermesServers = (output: string): ReadonlyArray<DiscoveredCodingMcpServer> => {
  const plain = output.replace(ANSI_ESCAPE, "");
  if (/No MCP servers configured\./u.test(plain)) return [];
  return plain.split(/\r?\n/u).flatMap((line): ReadonlyArray<DiscoveredCodingMcpServer> => {
    const match = line.match(/^\s{2}(.+?)\s{2,}(.+?)\s{2,}(.+?)\s{2,}([✓✗]\s+(?:enabled|disabled))\s*$/u);
    if (!match) return [];
    const name = boundedName(match[1]);
    if (!name || name === "Name" || /^─+$/u.test(name)) return [];
    const endpoint = match[2]?.trim().toLowerCase() ?? "";
    return [{
      name,
      transport: endpoint.startsWith("http://") || endpoint.startsWith("https://") ? "http" : "stdio",
      status: match[4]?.includes("disabled") ? "disabled" : "enabled",
      source: "runtime",
    }];
  });
};

const readBoundedJson = async (path: string): Promise<unknown | undefined> => {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_CONFIG_BYTES) throw new Error("MCP configuration is not a bounded file");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
};

const serversFromRecord = (
  value: unknown,
  source: CodingMcpServerSource,
  statusFor: (name: string) => CodingMcpServerStatus = () => "enabled",
): ReadonlyArray<DiscoveredCodingMcpServer> => {
  const entries = record(value);
  if (!entries) return [];
  return Object.entries(entries).flatMap(([candidateName, configuration]): ReadonlyArray<DiscoveredCodingMcpServer> => {
    const name = boundedName(candidateName);
    if (!name || !record(configuration)) return [];
    return [{ name, transport: transport(configuration), status: statusFor(name), source }];
  });
};

const stringSet = (value: unknown): ReadonlySet<string> => new Set(
  Array.isArray(value) ? value.flatMap((candidate) => boundedName(candidate) ?? []) : [],
);

const claudeServers = async (
  homeDirectory: string,
  workingDirectory: string,
): Promise<{ readonly servers: ReadonlyArray<DiscoveredCodingMcpServer>; readonly failed: boolean }> => {
  let failed = false;
  let userState: unknown;
  let workspaceState: unknown;
  try {
    userState = await readBoundedJson(join(homeDirectory, ".claude.json"));
  } catch {
    failed = true;
  }
  try {
    workspaceState = await readBoundedJson(join(workingDirectory, ".mcp.json"));
  } catch {
    failed = true;
  }
  const user = record(userState);
  const project = record(record(user?.projects)?.[resolve(workingDirectory)]);
  const enabled = stringSet(project?.enabledMcpjsonServers);
  const disabled = stringSet(project?.disabledMcpjsonServers);
  const projectStatus = (name: string): CodingMcpServerStatus =>
    disabled.has(name) ? "disabled" : enabled.has(name) ? "enabled" : "pending-approval";
  return {
    servers: [
      ...serversFromRecord(user?.mcpServers, "user"),
      ...serversFromRecord(project?.mcpServers, "workspace"),
      ...serversFromRecord(record(workspaceState)?.mcpServers, "workspace", projectStatus),
    ],
    failed,
  };
};

const result = (
  mode: CodingMcpDiscovery["mode"],
  readiness: CodingMcpDiscovery["readiness"],
  servers: ReadonlyArray<DiscoveredCodingMcpServer> = [],
): CodingMcpDiscovery => ({ mode, readiness, ...boundedServers(servers) });

/**
 * Discovers non-secret MCP configuration metadata for one local coding runtime.
 * Discovery never turns a configured server into Roster execution authority.
 */
export const discoverCodingMcpConfiguration = async (
  options: CodingMcpDiscoveryOptions,
): Promise<CodingMcpDiscovery> => {
  if (options.runtimeId === "pi-agent") return result("extension", "extension-managed");
  if (options.runtimeId !== "codex-cli"
    && options.runtimeId !== "claude-code"
    && options.runtimeId !== "hermes-agent") return result("unsupported", "not-supported");
  if (!options.runtimeAvailable || !options.executablePath) return result("native", "runtime-unavailable");

  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  try {
    if (options.runtimeId === "claude-code") {
      const discovered = await claudeServers(homeDirectory, workingDirectory);
      const bounded = boundedServers(discovered.servers);
      if (bounded.servers.length) {
        return { mode: "native", readiness: "discovered", ...bounded };
      }
      return result("native", discovered.failed ? "probe-failed" : "none");
    }
    const run = options.run ?? defaultRun;
    const command = options.runtimeId === "codex-cli"
      ? ["mcp", "list", "--json"]
      : ["mcp", "list"];
    const probe = await run(options.executablePath, command, {
      cwd: workingDirectory,
      env: safeProbeEnvironment(options.env ?? process.env, homeDirectory),
    });
    const servers = options.runtimeId === "codex-cli"
      ? codexServers(JSON.parse(probe.stdout) as unknown)
      : hermesServers(probe.stdout);
    return result("native", servers.length ? "discovered" : "none", servers);
  } catch {
    return result("native", "probe-failed");
  }
};
