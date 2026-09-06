import process from "node:process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDesktopSidecarStateApi,
  normalizeDesktopOnboardingState,
} from "./index.js";
import { desktopRuntimeEnvironment } from "./runtime-config.js";
import { readCodingBuildManifest } from "../runtime/coding-build.js";
import { applyRosterLocalOnlyEnvironment } from "../runtime/local-only.js";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Roster desktop runtime requires ${name}`);
  return value;
};

const parentProcessId = Number(requiredEnvironment("ROSTER_DESKTOP_PARENT_PID"));
if (!Number.isSafeInteger(parentProcessId) || parentProcessId <= 1) {
  throw new Error("Roster desktop runtime requires a valid parent process id");
}

const parentWatchdog = setInterval(() => {
  try {
    process.kill(parentProcessId, 0);
  } catch {
    clearInterval(parentWatchdog);
    process.kill(process.pid, "SIGTERM");
  }
}, 1_000);
parentWatchdog.unref();

const dataDirectory = requiredEnvironment("ROSTER_DESKTOP_DATA_DIR");
const repositoryPath = requiredEnvironment("ROSTER_DESKTOP_REPOSITORY");
const runtimeProfilesJson = process.env.ROSTER_DESKTOP_RUNTIME_PROFILES?.trim() || "[]";
const defaultRuntimeId = requiredEnvironment("ROSTER_DESKTOP_DEFAULT_RUNTIME_ID");
const port = Number(requiredEnvironment("ROSTER_DESKTOP_PORT"));
const state = createDesktopSidecarStateApi(dataDirectory);
const onboarding = await state.saveOnboarding(normalizeDesktopOnboardingState({
  selectedRepository: {
    path: repositoryPath,
    name: process.env.ROSTER_DESKTOP_REPOSITORY_NAME?.trim() || repositoryPath,
  },
  runtimeProfiles: JSON.parse(runtimeProfilesJson),
  defaultRuntimeId,
}));
const bootstrap = await state.bootstrap({
  uri: requiredEnvironment("ROSTER_SPACETIME_URI"),
  database: requiredEnvironment("ROSTER_SPACETIME_DATABASE"),
  confirmedReads: process.env.ROSTER_SPACETIME_CONFIRMED_READS !== "0",
});
const runtime = desktopRuntimeEnvironment({
  dataDirectory,
  device: bootstrap.device,
  onboarding,
  spacetime: bootstrap.spacetime,
  port,
  inheritedPath: process.env.PATH,
});

process.chdir(runtime.cwd);
const codingBuild = readCodingBuildManifest();
process.stdout.write(`Roster Coding build ${codingBuild.fingerprint}\n`);
Object.assign(process.env, runtime.env);
process.env.ROSTER_API_TOKEN = requiredEnvironment("ROSTER_DESKTOP_HTTP_TOKEN");
process.env.ROSTER_HTTP_HOST = "127.0.0.1";
// Keep this key present so repository-local dotenv cannot supply a remote origin.
process.env.ROSTER_PUBLIC_ORIGIN = "";
delete process.env.ROSTER_DESKTOP_HTTP_TOKEN;
// The customer repository is the runtime cwd. Pin built-in discovery to the
// packaged modules so repository-local src/agents or dist/agents cannot shadow
// Roster's trusted application agents.
process.env.ROSTER_AGENT_MODULES_DIR = fileURLToPath(new URL("../agents", import.meta.url));
applyRosterLocalOnlyEnvironment();
process.env.CANVAS_CSRF_SECRET ??= randomBytes(32).toString("base64url");

await import("../server.js");
