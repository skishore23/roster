import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const STARTUP_TIMEOUT_MS = 180_000;
const MAX_STARTUP_LOG_BYTES = 64 * 1024;
const LOCAL_CONTROL_STATE = path.join(".spacetime", "coding-local.json");
const LOCAL_CONTROL_SCHEMA = "roster.coding-local.v1";
const LOCAL_DATABASE_PATTERN = /^roster-local-[a-f0-9]{12}$/u;

export type CodingServerBootstrap = {
  readonly owned: boolean;
  readonly origin: string;
  readonly close: () => Promise<void>;
};

export type CodingServerBootstrapOptions = {
  readonly origin?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly entryPath?: string;
  readonly command?: { readonly executable: string; readonly args: ReadonlyArray<string> };
  readonly fetch?: typeof fetch;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly onStatus?: (message: string) => void;
};

const boundedTail = (current: string, chunk: string): string => {
  const combined = `${current}${chunk}`;
  return Buffer.byteLength(combined) <= MAX_STARTUP_LOG_BYTES
    ? combined
    : Buffer.from(combined).subarray(-MAX_STARTUP_LOG_BYTES).toString("utf8");
};

const normalizedOrigin = (raw: string | undefined, env: NodeJS.ProcessEnv): URL => {
  const value = raw?.trim() || env.ROSTER_API_URL?.trim() || `http://127.0.0.1:${env.PORT ?? "8787"}`;
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error("Roster Coding URL must not contain credentials");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Automatic Coding startup requires a server origin without a path, query, or fragment");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Roster Coding server origins must use http or https");
  }
  return parsed;
};

const isLoopbackHttp = (origin: URL): boolean =>
  origin.protocol === "http:"
  && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(origin.hostname);

const ready = async (origin: URL, requestFetch: typeof fetch): Promise<boolean> => {
  try {
    const response = await requestFetch(new URL("/readyz", origin), {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const defaultCommand = (entryPath: string): { readonly executable: string; readonly args: ReadonlyArray<string> } => {
  const resolved = path.resolve(entryPath);
  return resolved.endsWith(".ts")
    ? { executable: process.execPath, args: ["--import", "tsx", resolved, "up"] }
    : { executable: process.execPath, args: [resolved, "up"] };
};

const waitForExit = (child: ChildProcess, timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => resolve(false), timeoutMs);
  child.once("exit", () => {
    clearTimeout(timer);
    resolve(true);
  });
});

type LocalControlSelection = {
  readonly schema: typeof LOCAL_CONTROL_SCHEMA;
  readonly database: string;
  readonly tokenPath: string;
};

const localControlSelection = (value: unknown): LocalControlSelection => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local Coding control-plane selection is malformed");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.schema !== LOCAL_CONTROL_SCHEMA
    || typeof candidate.database !== "string"
    || !LOCAL_DATABASE_PATTERN.test(candidate.database)
    || candidate.tokenPath !== `.spacetime/${candidate.database}.token`) {
    throw new Error("Local Coding control-plane selection is malformed");
  }
  return {
    schema: LOCAL_CONTROL_SCHEMA,
    database: candidate.database,
    tokenPath: candidate.tokenPath,
  };
};

const readLocalControlSelection = async (cwd: string): Promise<LocalControlSelection | undefined> => {
  try {
    return localControlSelection(JSON.parse(await fs.readFile(path.join(cwd, LOCAL_CONTROL_STATE), "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const newLocalControlSelection = (): LocalControlSelection => {
  const database = `roster-local-${randomBytes(6).toString("hex")}`;
  return {
    schema: LOCAL_CONTROL_SCHEMA,
    database,
    tokenPath: `.spacetime/${database}.token`,
  };
};

const persistLocalControlSelection = async (cwd: string, selection: LocalControlSelection): Promise<void> => {
  const directory = path.join(cwd, ".spacetime");
  const target = path.join(cwd, LOCAL_CONTROL_STATE);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
};

const databaseOwnershipConflict = (detail: string): boolean =>
  /not authorized to perform action on database[\s\S]*update database|database[\s\S]*belongs to another identity/iu.test(detail);

const withLocalControlSelection = (
  env: NodeJS.ProcessEnv,
  selection: LocalControlSelection | undefined,
): NodeJS.ProcessEnv => selection ? {
  ...env,
  SPACETIMEDB_DATABASE: selection.database,
  SPACETIMEDB_TOKEN: "",
  SPACETIMEDB_TOKEN_PATH: selection.tokenPath,
} : env;

const startCodingServer = async (input: {
  readonly command: { readonly executable: string; readonly args: ReadonlyArray<string> };
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly origin: URL;
  readonly requestFetch: typeof fetch;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly onStatus?: (message: string) => void;
}): Promise<CodingServerBootstrap> => {
  const child = spawn(input.command.executable, [...input.command.args], {
    cwd: input.cwd,
    env: {
      ...input.env,
      PORT: input.origin.port || "80",
      ROSTER_API_URL: input.origin.origin,
      ROSTER_CODING_LOCAL_ONLY: input.env.ROSTER_CODING_LOCAL_ONLY ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout = boundedTail(stdout, chunk); });
  child.stderr?.on("data", (chunk: string) => { stderr = boundedTail(stderr, chunk); });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGINT");
    if (await waitForExit(child, 5_000)) return;
    child.kill("SIGTERM");
    if (await waitForExit(child, 3_000)) return;
    child.kill("SIGKILL");
    await waitForExit(child, 1_000);
  };

  const deadline = Date.now() + input.timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const detail = (stderr || stdout).trim().slice(-4_000);
        throw new Error(`Automatic Roster startup exited before readiness${detail ? `:\n${detail}` : ""}`);
      }
      if (await ready(input.origin, input.requestFetch)) {
        input.onStatus?.(`Roster is ready at ${input.origin.origin}.`);
        return { owned: true, origin: input.origin.origin, close };
      }
      await delay(input.intervalMs);
    }
    const detail = (stderr || stdout).trim().slice(-4_000);
    throw new Error(`Timed out starting Roster at ${input.origin.origin}${detail ? `:\n${detail}` : ""}`);
  } catch (error) {
    await close();
    throw error;
  }
};

/** Starts the complete local stack only when no compatible server is ready. */
export const ensureCodingServer = async (
  options: CodingServerBootstrapOptions = {},
): Promise<CodingServerBootstrap> => {
  const env = options.env ?? process.env;
  const origin = normalizedOrigin(options.origin, env);
  const requestFetch = options.fetch ?? fetch;
  if (await ready(origin, requestFetch)) {
    return { owned: false, origin: origin.origin, close: async () => undefined };
  }
  if (!isLoopbackHttp(origin)) {
    throw new Error(`Roster is not ready at ${origin.origin}; automatic startup is available only for loopback HTTP`);
  }
  if (env.ROSTER_CODING_AUTOSTART === "0") {
    throw new Error(`Roster is not ready at ${origin.origin}; start it with \`roster up\``);
  }

  const entryPath = options.entryPath ?? process.argv[1];
  if (!entryPath && !options.command) throw new Error("Cannot locate the Roster CLI entry point for automatic startup");
  const command = options.command ?? defaultCommand(entryPath!);
  const cwd = options.cwd ?? process.cwd();
  const explicitControlPlane = Boolean(
    env.SPACETIMEDB_DATABASE?.trim()
    || env.SPACETIMEDB_TOKEN?.trim()
    || env.SPACETIMEDB_TOKEN_PATH?.trim(),
  );
  const savedSelection = explicitControlPlane ? undefined : await readLocalControlSelection(cwd);
  options.onStatus?.("Starting the local Roster and SpacetimeDB stack…");
  const timeoutMs = Math.max(5_000, Math.min(options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS, 300_000));
  const intervalMs = Math.max(25, Math.min(options.pollIntervalMs ?? 250, 2_000));
  try {
    return await startCodingServer({
      command,
      cwd,
      env: withLocalControlSelection(env, savedSelection),
      origin,
      requestFetch,
      timeoutMs,
      intervalMs,
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (explicitControlPlane || !databaseOwnershipConflict(detail)) throw error;
    const recoveredSelection = newLocalControlSelection();
    options.onStatus?.(
      `The previous local database belongs to another SpacetimeDB identity. `
      + `It will be preserved; starting a fresh local Coding control plane instead…`,
    );
    const recovered = await startCodingServer({
      command,
      cwd,
      env: withLocalControlSelection(env, recoveredSelection),
      origin,
      requestFetch,
      timeoutMs,
      intervalMs,
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    });
    try {
      await persistLocalControlSelection(cwd, recoveredSelection);
      return recovered;
    } catch (persistError) {
      await recovered.close();
      throw persistError;
    }
  }
};
