import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const REPOSITORY_ROOT = path.resolve(APP_ROOT, "../..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const LOG_TAIL_BYTES = 32 * 1024;

export const desktopDevControlPlane = ({ pid, now, port }) => {
  const uri = `http://127.0.0.1:${port}`;
  const database = `roster-desktop-dev-${pid}-${now.toString(36)}`;
  return {
    uri,
    database,
    environment: {
      ROSTER_SPACETIME_MODE: "local",
      ROSTER_SPACETIME_LOCAL_URI: uri,
      ROSTER_SPACETIME_LOCAL_DATABASE: database,
    },
  };
};

export const spacetimeStartArguments = ({ port, dataDirectory }) => [
  "start",
  "--listen-addr",
  `127.0.0.1:${port}`,
  "--data-dir",
  dataDirectory,
  "--in-memory",
  "--non-interactive",
];

export const spacetimePublishArguments = ({ uri, database }) => [
  "publish",
  database,
  "--server",
  uri,
  "--module-path",
  "spacetimedb",
  "--yes",
  "--no-config",
];

const commandText = (command, args) => [command, ...args].join(" ");

const run = (command, args, { cwd = APP_ROOT, env = process.env } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", (error) => {
      reject(new Error(`Could not start ${commandText(command, args)}: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${commandText(command, args)} ${
          signal ? `was stopped by ${signal}` : `exited with code ${code}`
        }`,
      ));
    });
  });

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate a local SpacetimeDB development port"));
      return;
    }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const appendTail = (current, chunk) => {
  const combined = `${current}${chunk}`;
  return combined.length <= LOG_TAIL_BYTES
    ? combined
    : combined.slice(combined.length - LOG_TAIL_BYTES);
};

const isOwnedTempDirectory = (directory) => {
  const resolved = path.resolve(directory);
  return path.dirname(resolved) === path.resolve(os.tmpdir())
    && path.basename(resolved).startsWith("roster-desktop-dev-");
};

const startCleanupWatchdog = (tempDirectory) => {
  const watchdog = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--cleanup-temp", tempDirectory],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  watchdog.unref();
  watchdog.stdin.unref();
};

const cleanTempDirectoryAfterParentExit = async (tempDirectory) => {
  if (!isOwnedTempDirectory(tempDirectory)) {
    throw new Error("Refusing to clean a directory outside Roster's temporary development area");
  }
  await new Promise((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
    process.stdin.resume();
  });
  await fs.rm(tempDirectory, { recursive: true, force: true });
};

const waitForServer = async (uri, child, serverLog) => {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`SpacetimeDB exited before becoming ready\n${serverLog()}`);
    }
    try {
      const response = await fetch(`${uri}/v1/ping`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for SpacetimeDB at ${uri}\n${serverLog()}`);
};

const stopProcess = async (child) => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const settled = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
  ]);
  if (settled || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await exited;
};

const runDesktopDevelopment = async () => {
  await run(NPM, ["run", "sidecar:stage"]);

  const port = await freePort();
  const controlPlane = desktopDevControlPlane({ pid: process.pid, now: Date.now(), port });
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "roster-desktop-dev-"));
  startCleanupWatchdog(tempDirectory);
  const dataDirectory = path.join(tempDirectory, "spacetime-data");
  let outputTail = "";
  let errorTail = "";
  let server;
  let desktop;
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all([
      stopProcess(desktop),
      stopProcess(server),
    ]);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);

  try {
    server = spawn("spacetime", spacetimeStartArguments({ port, dataDirectory }), {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.setEncoding("utf8");
    server.stderr.setEncoding("utf8");
    server.stdout.on("data", (chunk) => { outputTail = appendTail(outputTail, chunk); });
    server.stderr.on("data", (chunk) => { errorTail = appendTail(errorTail, chunk); });
    const startError = new Promise((_, reject) => {
      server.once("error", (error) => reject(new Error(
        `Could not start the SpacetimeDB CLI. Install it before running Roster: ${error.message}`,
      )));
    });
    await Promise.race([
      waitForServer(controlPlane.uri, server, () => `${outputTail}\n${errorTail}`.trim()),
      startError,
    ]);
    if (stopping) return;

    await run("spacetime", spacetimePublishArguments(controlPlane), {
      cwd: REPOSITORY_ROOT,
    });
    if (stopping) return;
    console.log(
      `Roster desktop control plane: ${controlPlane.uri} (${controlPlane.database})`,
    );

    desktop = spawn(NPM, ["exec", "--", "tauri", "dev"], {
      cwd: APP_ROOT,
      env: { ...process.env, ...controlPlane.environment },
      detached: false,
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      desktop.once("error", (error) => reject(new Error(
        `Could not start the Roster desktop application: ${error.message}`,
      )));
      desktop.once("exit", (code, signal) => {
        if (code === 0 || stopping) resolve();
        else reject(new Error(
          `Roster desktop ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}`,
        ));
      });
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
    await stopProcess(desktop);
    await stopProcess(server);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
};

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  try {
    if (process.argv[2] === "--cleanup-temp" && process.argv[3]) {
      await cleanTempDirectoryAfterParentExit(process.argv[3]);
    } else {
      await runDesktopDevelopment();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
