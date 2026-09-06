import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const EXTERNAL = process.argv.includes("--external");
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const LOG_TAIL_BYTES = 32 * 1024;

const commandText = (command, args) => [command, ...args].join(" ");

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    reject(new Error(`Could not start ${commandText(command, args)}: ${error.message}`));
  });
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(
      `${commandText(command, args)} ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}`,
    ));
  });
});

const runCaptured = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => {
    reject(new Error(`Could not start ${commandText(command, args)}: ${error.message}`));
  });
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve({ stdout, stderr });
      return;
    }
    reject(new Error([
      `${commandText(command, args)} ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}`,
      stdout,
      stderr,
    ].filter(Boolean).join("\n")));
  });
});

const requireMigrationRow = (label, output, rowId, status) => {
  if (!output.includes(`"${rowId}"`) || !output.includes(`"${status}"`)) {
    throw new Error(`${label} was not preserved across the SpacetimeDB continuity upgrade\n${output}`);
  }
  const emptyDefaults = output.match(/""/g)?.length ?? 0;
  if (emptyDefaults < 3) {
    throw new Error(`${label} did not receive empty room-lane migration defaults\n${output}`);
  }
};

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate a local SpacetimeDB verification port"));
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

const ping = async (uri) => {
  const response = await fetch(`${uri.replace(/\/$/, "")}/v1/ping`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`SpacetimeDB ping returned HTTP ${response.status}`);
};

const waitForServer = async (uri, child, serverLog) => {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`SpacetimeDB exited before becoming ready\n${serverLog()}`);
    }
    try {
      await ping(uri);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out waiting for SpacetimeDB at ${uri}\n${serverLog()}`);
};

const stopProcessGroup = async (child) => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return;
  }
  const settled = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
  ]);
  if (settled || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await exited;
};

const verifyAgainstExternalServer = async () => {
  const uri = process.env.SPACETIMEDB_URI?.trim() || "http://127.0.0.1:3000";
  try {
    await ping(uri);
  } catch (error) {
    throw new Error([
      `Roster verification could not reach SpacetimeDB at ${uri}.`,
      "Start and publish the configured control plane first, or run `npm run verify` for an isolated in-memory verification stack.",
      `Cause: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n"));
  }
  await run(NPM, ["run", "verify:code"]);
};

const verifyWithEphemeralServer = async () => {
  const port = await freePort();
  const uri = `http://127.0.0.1:${port}`;
  const database = `roster-verify-${process.pid}-${Date.now().toString(36)}`;
  const upgradeDatabase = `${database}-upgrade`;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "roster-verify-"));
  const dataDirectory = path.join(tempDirectory, "spacetime-data");
  const tokenPath = path.join(tempDirectory, "service.token");
  let outputTail = "";
  let errorTail = "";
  let server;

  try {
    server = spawn("spacetime", [
      "start",
      "--listen-addr", `127.0.0.1:${port}`,
      "--data-dir", dataDirectory,
      "--in-memory",
      "--non-interactive",
    ], {
      cwd: ROOT,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.setEncoding("utf8");
    server.stderr.setEncoding("utf8");
    server.stdout.on("data", (chunk) => { outputTail = appendTail(outputTail, chunk); });
    server.stderr.on("data", (chunk) => { errorTail = appendTail(errorTail, chunk); });
    const startError = new Promise((_, reject) => {
      server.once("error", (error) => reject(new Error(
        `Could not start the SpacetimeDB CLI. Install the pinned CLI before running verification: ${error.message}`,
      )));
    });
    await Promise.race([
      waitForServer(uri, server, () => `${outputTail}\n${errorTail}`.trim()),
      startError,
    ]);

    console.log(`Roster verification control plane: ${uri} (${database})`);
    await run(NPM, ["--prefix", "spacetimedb", "run", "build"]);
    await runCaptured("spacetime", [
      "publish", upgradeDatabase,
      "--server", uri,
      "--module-path", "tests/fixtures/spacetimedb-continuity-v1",
      "--yes",
      "--no-config",
    ]);
    await run("spacetime", [
      "call", "--server", uri, "--no-config",
      upgradeDatabase, "seed_continuity_upgrade",
    ]);
    await runCaptured("spacetime", [
      "publish", upgradeDatabase,
      "--server", uri,
      "--module-path", "spacetimedb",
      "--yes",
      "--no-config",
    ]);
    const migratedInbox = await runCaptured("spacetime", [
      "sql", "--server", uri, "--no-config", upgradeDatabase,
      "SELECT id, status, lane_id, room_id, run_id FROM roster_node_inbox_item WHERE id = 'migration-inbox'",
    ]);
    const migratedWake = await runCaptured("spacetime", [
      "sql", "--server", uri, "--no-config", upgradeDatabase,
      "SELECT id, status, lane_id, room_id, run_id FROM roster_node_wake WHERE id = 'migration-wake'",
    ]);
    requireMigrationRow("continuity inbox row", migratedInbox.stdout, "migration-inbox", "consumed");
    requireMigrationRow("continuity wake row", migratedWake.stdout, "migration-wake", "completed");
    console.log("Roster continuity schema upgrade: preserved pre-lane rows with additive defaults");
    await run("spacetime", [
      "publish", database,
      "--server", uri,
      "--module-path", "spacetimedb",
      "--yes",
    ]);
    await run(NPM, ["run", "verify:code"], {
      env: {
        ...process.env,
        SPACETIMEDB_URI: uri,
        SPACETIMEDB_PUBLIC_URI: uri,
        SPACETIMEDB_DATABASE: database,
        SPACETIMEDB_TOKEN: "",
        SPACETIMEDB_TOKEN_PATH: tokenPath,
        SPACETIMEDB_CONNECT_TIMEOUT_MS: "10000",
        ROSTER_WORKSPACE_ID: `verify/${process.pid}`,
      },
    });
  } finally {
    await stopProcessGroup(server);
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
};

try {
  if (EXTERNAL) await verifyAgainstExternalServer();
  else await verifyWithEphemeralServer();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
