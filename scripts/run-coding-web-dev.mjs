import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const DEFAULT_BUILD_COMMAND = {
  command: npm,
  args: ["run", "build:coding-client"],
};
const DEFAULT_SERVER_COMMAND = {
  command: process.execPath,
  args: ["--watch", "--import", "tsx", "src/local.ts"],
};

export async function runCodingWebDev(options = {}) {
  const buildCommand = options.buildCommand ?? DEFAULT_BUILD_COMMAND;
  const serverCommand = options.serverCommand ?? DEFAULT_SERVER_COMMAND;
  let activeChild;
  let requestedSignal;

  const forwardSignal = (signal) => {
    requestedSignal ??= signal;
    activeChild?.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const run = ({ command, args }) => new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: "inherit",
    });
    activeChild = child;
    if (requestedSignal) child.kill(requestedSignal);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      resolve({ code, signal });
    });
  });

  try {
    const buildResult = await run(buildCommand);
    if (buildResult.signal || buildResult.code !== 0) return buildResult;
    if (requestedSignal) return { code: null, signal: requestedSignal };
    return await run(serverCommand);
  } catch (error) {
    console.error(error);
    return { code: 1, signal: null };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export function applyCodingWebDevExit(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

const launchedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (launchedPath === import.meta.url) {
  applyCodingWebDevExit(await runCodingWebDev());
}
