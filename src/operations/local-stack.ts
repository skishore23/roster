import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveSpacetimeControlConfig } from "../adapters/spacetimedb-control.js";
import { applyRosterLocalOnlyEnvironment } from "../runtime/local-only.js";

const MINIMUM_NODE = [22, 19, 0] as const;
const EXPECTED_SPACETIME_VERSION = "2.6.1";
const COMMAND_TIMEOUT_MS = 5_000;
const START_TIMEOUT_MS = 30_000;

export type DiagnosticLevel = "pass" | "warning" | "fail";

export type RosterDiagnostic = {
  readonly id: string;
  readonly label: string;
  readonly level: DiagnosticLevel;
  readonly detail: string;
  readonly required: boolean;
  readonly repair?: string;
};

export type RosterDiagnosticReport = {
  readonly ok: boolean;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly checks: ReadonlyArray<RosterDiagnostic>;
};

type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

const commandResult = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<CommandResult> => new Promise((resolve) => {
  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
    return;
  }
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? COMMAND_TIMEOUT_MS);
  child.once("error", (error) => {
    clearTimeout(timeout);
    resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
  });
  child.once("close", (code) => {
    clearTimeout(timeout);
    resolve({ code, stdout, stderr });
  });
});

const runInherited = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { cwd, env, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${command} ${args.join(" ")} ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}`));
  });
});

const nodeVersionPasses = (version: string): boolean => {
  const parsed = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    const actual = parsed[index] ?? 0;
    const required = MINIMUM_NODE[index];
    if (actual > required) return true;
    if (actual < required) return false;
  }
  return true;
};

const ping = async (url: string, timeoutMs = 1_500): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok
      ? { ok: true, detail: `HTTP ${response.status}` }
      : { ok: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
};

const commandCheck = async (
  id: string,
  label: string,
  command: string,
  args: ReadonlyArray<string>,
  required: boolean,
  repair: string,
): Promise<RosterDiagnostic> => {
  const result = await commandResult(command, args);
  const output = (result.stdout || result.stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ");
  return result.code === 0
    ? { id, label, level: "pass", detail: output || "available", required }
    : { id, label, level: required ? "fail" : "warning", detail: "not available", required, repair };
};

export const collectRosterDiagnostics = async (
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RosterDiagnosticReport> => {
  const spacetime = resolveSpacetimeControlConfig(env);
  const port = Number.parseInt(env.PORT ?? "8787", 10);
  const rosterUri = `http://127.0.0.1:${Number.isFinite(port) ? port : 8787}`;
  const nodeCheck: RosterDiagnostic = nodeVersionPasses(process.version)
    ? { id: "node", label: "Node.js", level: "pass", detail: process.version, required: true }
    : {
        id: "node",
        label: "Node.js",
        level: "fail",
        detail: `${process.version}; 22.19.0 or newer is required`,
        required: true,
        repair: "Install Node.js 22.19.0 or newer.",
      };
  const [spacetimeCli, git, codex, claude, pi, gh, database, server] = await Promise.all([
    commandCheck("spacetime-cli", "SpacetimeDB CLI", "spacetime", ["--version"], true, "Install the pinned SpacetimeDB CLI 2.6.1."),
    commandCheck("git", "Git repository", "git", ["-C", cwd, "rev-parse", "--show-toplevel"], true, "Run Roster from a Git repository."),
    commandCheck("codex", "Codex CLI", "codex", ["--version"], false, "Install Codex or select another coding runtime."),
    commandCheck("claude", "Claude Code", "claude", ["--version"], false, "Install Claude Code or select another review runtime."),
    commandCheck("pi", "Pi", "pi", ["--version"], false, "Install Pi or select another coding runtime."),
    commandCheck("github", "GitHub CLI", "gh", ["--version"], false, "Install and authenticate gh for remote publishing."),
    ping(`${spacetime.uri.replace(/\/$/, "")}/v1/ping`),
    ping(`${rosterUri}/readyz`),
  ]);
  const spacetimeVersion = spacetimeCli.level === "pass" && spacetimeCli.detail.includes(EXPECTED_SPACETIME_VERSION)
    ? spacetimeCli
    : spacetimeCli.level === "pass"
      ? {
          ...spacetimeCli,
          level: "fail" as const,
          detail: `${spacetimeCli.detail}; expected ${EXPECTED_SPACETIME_VERSION}`,
          repair: `Run spacetime version install ${EXPECTED_SPACETIME_VERSION} --use --yes.`,
        }
      : spacetimeCli;
  const databaseCheck: RosterDiagnostic = database.ok
    ? { id: "database", label: "SpacetimeDB server", level: "pass", detail: `${spacetime.uri} · ${spacetime.database}`, required: true }
    : {
        id: "database",
        label: "SpacetimeDB server",
        level: "fail",
        detail: `${spacetime.uri} · ${database.detail}`,
        required: true,
        repair: "Run `roster up` to start and publish the local control plane.",
      };
  const serverCheck: RosterDiagnostic = server.ok
    ? { id: "server", label: "Roster server", level: "pass", detail: rosterUri, required: false }
    : {
        id: "server",
        label: "Roster server",
        level: "warning",
        detail: `${rosterUri} · not running`,
        required: false,
        repair: "Run `roster up`.",
      };
  const credentialCheck: RosterDiagnostic = env.OPENAI_API_KEY?.trim()
    ? { id: "openai", label: "OpenAI credential", level: "pass", detail: "configured", required: false }
    : {
        id: "openai",
        label: "OpenAI credential",
        level: "warning",
        detail: "OPENAI_API_KEY is not configured",
        required: false,
        repair: "Set OPENAI_API_KEY before starting model-backed runs.",
      };
  const checks = [nodeCheck, spacetimeVersion, databaseCheck, serverCheck, git, credentialCheck, codex, claude, pi, gh];
  return {
    ok: checks.every((check) => !check.required || check.level === "pass"),
    ready: checks.every((check) => !check.required || check.level === "pass") && serverCheck.level === "pass",
    checkedAt: new Date().toISOString(),
    checks,
  };
};

export const formatRosterDiagnostics = (report: RosterDiagnosticReport): string => {
  const icon = (level: DiagnosticLevel): string => level === "pass" ? "✓" : level === "warning" ? "!" : "×";
  const rows = report.checks.map((check) => {
    const repair = check.repair && check.level !== "pass" ? `\n    ${check.repair}` : "";
    return `${icon(check.level)} ${check.label}: ${check.detail}${repair}`;
  });
  return [`Roster status: ${report.ready ? "ready" : report.ok ? "setup complete; server stopped" : "needs attention"}`, ...rows].join("\n");
};

const ensureProjectRoot = (cwd: string): void => {
  for (const relative of ["package.json", "spacetimedb/package.json"]) {
    if (!fs.existsSync(path.join(cwd, relative))) throw new Error(`Roster project file is missing: ${relative}`);
  }
};

export const setupRosterProject = async (
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly install?: boolean; readonly publish?: boolean } = {},
): Promise<void> => {
  ensureProjectRoot(cwd);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (options.install !== false) {
    await runInherited(npm, ["install"], cwd, env);
    await runInherited(npm, ["--prefix", "spacetimedb", "install"], cwd, env);
    if (fs.existsSync(path.join(cwd, "packages/pi-roster/package.json"))) {
      await runInherited(npm, ["--prefix", "packages/pi-roster", "install"], cwd, env);
    }
  }
  await runInherited(npm, ["run", "spacetime:build"], cwd, env);
  await runInherited(npm, ["run", "spacetime:generate"], cwd, env);
  if (options.publish !== false) {
    const config = resolveSpacetimeControlConfig(env);
    const server = await ping(`${config.uri.replace(/\/$/, "")}/v1/ping`);
    if (server.ok) {
      await runInherited("spacetime", [
        "publish", config.database,
        "--server", config.uri,
        "--module-path", "spacetimedb",
        "--yes",
      ], cwd, env);
    } else {
      console.log(`SpacetimeDB is not running at ${config.uri}; roster up will publish ${config.database} when it starts.`);
    }
  }
  await runInherited(npm, ["run", "build"], cwd, env);
};

const localListenAddress = (uri: string): string => {
  const parsed = new URL(uri);
  if (!(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) {
    throw new Error(`roster up cannot start a remote SpacetimeDB server at ${uri}`);
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `127.0.0.1:${port}`;
};

const waitForPing = async (url: string, child?: ChildProcess): Promise<void> => {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error("SpacetimeDB exited before becoming ready");
    if ((await ping(url, 1_000)).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const terminate = (child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): void => {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
};

/** Built local entrypoint that keeps Coding on installed CLI runtimes. */
export const rosterLocalServerEntrypoint = (cwd: string): string =>
  path.join(cwd, "dist/local.js");

/** Local server environment with repository-installed CLIs ahead of inherited PATH. */
export const rosterLocalServerEnvironment = (
  cwd: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => applyRosterLocalOnlyEnvironment({
  ...env,
  PATH: [path.join(cwd, "node_modules", ".bin"), env.PATH]
    .filter((entry): entry is string => Boolean(entry))
    .join(path.delimiter),
});

export const runRosterStack = async (
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  ensureProjectRoot(cwd);
  const config = resolveSpacetimeControlConfig(env);
  const pingUrl = `${config.uri.replace(/\/$/, "")}/v1/ping`;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let database: ChildProcess | undefined;
  let server: ChildProcess | undefined;
  let stopping = false;
  const stop = (signal: NodeJS.Signals = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    terminate(server, signal);
    terminate(database, signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  try {
    if (!(await ping(pingUrl)).ok) {
      database = spawn("spacetime", [
        "start",
        "--listen-addr", localListenAddress(config.uri),
        "--non-interactive",
      ], { cwd, env, stdio: "inherit" });
      await waitForPing(pingUrl, database);
    }
    await runInherited(npm, ["run", "spacetime:build"], cwd, env);
    await runInherited("spacetime", [
      "publish", config.database,
      "--server", config.uri,
      "--module-path", "spacetimedb",
      "--yes",
    ], cwd, env);
    await runInherited(npm, ["run", "build"], cwd, env);
    const port = Number.parseInt(env.PORT ?? "8787", 10);
    const readyUrl = `http://127.0.0.1:${Number.isFinite(port) ? port : 8787}/readyz`;
    if ((await ping(readyUrl)).ok) {
      console.log(`Roster is already ready at ${readyUrl.replace(/\/readyz$/, "")}`);
      return;
    }
    server = spawn(process.execPath, [rosterLocalServerEntrypoint(cwd)], {
      cwd,
      env: rosterLocalServerEnvironment(cwd, env),
      stdio: "inherit",
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      server?.once("error", reject);
      server?.once("exit", resolve);
    });
    if (!stopping && code !== 0) throw new Error(`Roster server exited with code ${code}`);
  } finally {
    stop();
  }
};
