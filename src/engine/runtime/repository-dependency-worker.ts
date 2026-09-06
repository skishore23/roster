import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { JsonValue } from "../orchestration/types.js";
import type {
  CommandExecution,
  CommandRunner,
} from "./command-node-runtime.js";
import { runCommand } from "./command-node-runtime.js";
import {
  parseRepositoryExecutionProfile,
  repositoryExecutionProfileEvidenceHash,
  type RepositoryExecutionProfile,
} from "./repository-toolchain.js";
import type { RosterFunctionProviderControl } from "../functions/function-directory.js";

const execFileAsync = promisify(execFile);

export const CODING_DEPENDENCY_RESOLUTION_OPERATION = "resolve-v1" as const;
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/" as const;

const MANIFEST_PATH = "package.json";
const LOCK_PATH = "package-lock.json";
const MAX_MANIFEST_BYTES = 2 * 1_048_576;
const MAX_LOCK_BYTES = 64 * 1_048_576;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1_024;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const NPM_CI_PROFILE_ARGS = ["ci", "--prefer-offline", "--no-audit", "--no-fund"] as const;

type PackageManifest = Readonly<Record<string, unknown>>;

export type RepositoryDependencyResolutionReceipt = {
  readonly manifestHashBefore: string;
  readonly manifestHashAfter: string;
  readonly lockHashBefore: string;
  readonly lockHashAfter: string;
  readonly changed: boolean;
  readonly audit: {
    readonly info: number;
    readonly low: number;
    readonly moderate: number;
    readonly high: number;
    readonly critical: number;
    readonly total: number;
  };
  readonly commands: {
    readonly lockfile: number;
    readonly materialize: number;
    readonly audit: number;
  };
  readonly durationMs: number;
};

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const boundedFile = async (path: string, maximumBytes: number, label: string): Promise<string> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return readFile(path, "utf8");
};

const parsedObject = (content: string, label: string): Readonly<Record<string, unknown>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
};

const dependencySpecs = (manifest: PackageManifest): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error(`package.json ${field} must be an object`);
    }
    for (const [name, spec] of Object.entries(entries)) {
      if (typeof spec !== "string" || !spec.trim()) {
        throw new Error(`package.json ${field}.${name} must be a non-empty string`);
      }
      result.set(`${field}:${name}`, spec.trim());
    }
  }
  return result;
};

const REGISTRY_VERSION_SPEC = /^[A-Za-z0-9*^~<>=|! ._+\-]+$/u;
const NPM_ALIAS_SPEC = /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9*^~<>=|! ._+\-]+)?$/iu;

const isRegistryDependencySpec = (spec: string): boolean => {
  const normalized = spec.trim();
  if (!normalized || normalized.includes("\\") || normalized.includes("\0")) return false;
  if (normalized.startsWith("npm:")) return NPM_ALIAS_SPEC.test(normalized);
  if (normalized.includes(":") || normalized.includes("/") || normalized.startsWith(".")) return false;
  return REGISTRY_VERSION_SPEC.test(normalized);
};

const assertManifestDependencyFrontier = (
  baselineContent: string,
  currentContent: string,
): void => {
  const baseline = dependencySpecs(parsedObject(baselineContent, "baseline package.json"));
  const current = dependencySpecs(parsedObject(currentContent, "package.json"));
  for (const [key, spec] of current) {
    if (isRegistryDependencySpec(spec)) continue;
    if (baseline.get(key) !== spec) {
      throw new Error(`package.json introduces or changes non-registry dependency ${key}`);
    }
  }
};

const resolvedValues = (value: unknown, output: Set<string>): void => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) resolvedValues(item, output);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "resolved" && typeof entry === "string" && entry.trim()) output.add(entry.trim());
    else resolvedValues(entry, output);
  }
};

const lockResolvedValues = (content: string, label: string): ReadonlySet<string> => {
  const values = new Set<string>();
  resolvedValues(parsedObject(content, label), values);
  return values;
};

const allowedBaselineResolutions = (baselineLock: string): {
  readonly origins: ReadonlySet<string>;
  readonly opaque: ReadonlySet<string>;
} => {
  const origins = new Set<string>();
  const opaque = new Set<string>();
  for (const resolved of lockResolvedValues(baselineLock, "baseline package-lock.json")) {
    try {
      origins.add(new URL(resolved).origin);
    } catch {
      opaque.add(resolved);
    }
  }
  return { origins, opaque };
};

const assertLockResolutionFrontier = (
  baseline: ReturnType<typeof allowedBaselineResolutions>,
  currentLock: string,
): void => {
  const publicOrigin = new URL(PUBLIC_NPM_REGISTRY).origin;
  for (const resolved of lockResolvedValues(currentLock, "package-lock.json")) {
    try {
      const url = new URL(resolved);
      if (url.origin !== publicOrigin && !baseline.origins.has(url.origin)) {
        throw new Error(`package-lock.json expands resolved hosts to ${url.origin}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("package-lock.json expands")) throw error;
      if (!baseline.opaque.has(resolved)) {
        throw new Error("package-lock.json expands non-registry resolved dependencies");
      }
    }
  }
};

const scrubbedPath = (): string => {
  const path = process.env.PATH;
  if (!path || path.length > 16_384 || path.includes("\0")) {
    throw new Error("Dependency resolution requires a bounded executable PATH");
  }
  return path;
};

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: scrubbedPath(),
  GIT_OPTIONAL_LOCKS: "0",
});

const git = async (root: string, args: ReadonlyArray<string>): Promise<string> => {
  const result = await execFileAsync("git", [...args], {
    cwd: root,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: MAX_LOCK_BYTES,
  });
  return result.stdout;
};

const assertTrackedRootFiles = async (root: string): Promise<void> => {
  await git(root, ["ls-files", "--error-unmatch", "--", MANIFEST_PATH, LOCK_PATH])
    .catch(() => {
      throw new Error("Dependency resolution requires Git-tracked root package.json and package-lock.json");
    });
};

const baselineFile = (root: string, path: string): Promise<string> =>
  git(root, ["show", `HEAD:${path}`]).catch(() => {
    throw new Error(`Dependency resolution requires ${path} in the baseline commit`);
  });

const assertNodeNpmProfile = async (
  root: string,
  profileInput: RepositoryExecutionProfile,
  baselineManifest: string,
  baselineLock: string,
): Promise<void> => {
  const profile = parseRepositoryExecutionProfile(profileInput);
  if (!profile || profile.contentHash !== profileInput.contentHash) {
    throw new Error("Dependency resolution requires a valid repository execution profile");
  }
  if (!profile.evidenceFiles.includes(MANIFEST_PATH)
    || !profile.evidenceFiles.includes(LOCK_PATH)
    || !profile.installCommands.some((command) =>
      (command.command === "npm" || command.command === "npm.cmd")
      && command.cwd === undefined
      && command.args.length === NPM_CI_PROFILE_ARGS.length
      && command.args.every((arg, index) => arg === NPM_CI_PROFILE_ARGS[index]))) {
    throw new Error("Dependency resolution requires a validated root node-npm execution profile");
  }
  const evidence = await Promise.all(profile.evidenceFiles.map(async (path) => ({
    path,
    content: path === MANIFEST_PATH
      ? baselineManifest
      : path === LOCK_PATH
        ? baselineLock
        : await boundedFile(join(root, path), MAX_MANIFEST_BYTES, `Execution-profile evidence ${path}`),
  })));
  if (repositoryExecutionProfileEvidenceHash(evidence) !== profile.evidenceHash) {
    throw new Error("Repository execution profile is stale; rescan the workspace toolchain evidence");
  }
};

const auditCounts = (stdout: string): RepositoryDependencyResolutionReceipt["audit"] => {
  const audit = parsedObject(stdout, "npm audit output");
  const metadata = audit.metadata;
  const vulnerabilities = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Readonly<Record<string, unknown>>).vulnerabilities
    : undefined;
  if (!vulnerabilities || typeof vulnerabilities !== "object" || Array.isArray(vulnerabilities)) {
    throw new Error("npm audit output omitted vulnerability counts");
  }
  const count = (name: string): number => {
    const value = (vulnerabilities as Readonly<Record<string, unknown>>)[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`npm audit output contains invalid ${name} vulnerability count`);
    }
    return value;
  };
  return {
    info: count("info"),
    low: count("low"),
    moderate: count("moderate"),
    high: count("high"),
    critical: count("critical"),
    total: count("total"),
  };
};

const successfulCommand = async (
  runner: CommandRunner,
  execution: CommandExecution,
  label: string,
): Promise<Awaited<ReturnType<CommandRunner>>> => {
  const result = await runner(execution);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.exitCode)}`);
  }
  return result;
};

const assertControlActive = (control: RosterFunctionProviderControl): void => {
  if (control.signal.aborted) {
    throw control.signal.reason instanceof Error
      ? control.signal.reason
      : new Error("Dependency resolution was canceled");
  }
};

export const createRepositoryDependencyResolver = (input: {
  readonly workingDirectory: string;
  readonly executionProfile: RepositoryExecutionProfile;
  readonly runner?: CommandRunner;
}): ((value: JsonValue, control: RosterFunctionProviderControl) => Promise<JsonValue>) => {
  const requestedRoot = resolve(input.workingDirectory);
  const runner = input.runner ?? runCommand;
  const attemptedManifestFrontiers = new Set<string>();

  return async (value, control) => {
    const startedAt = Date.now();
    assertControlActive(control);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1
      || (value as Readonly<Record<string, JsonValue>>).operation !== CODING_DEPENDENCY_RESOLUTION_OPERATION) {
      throw new Error(`Dependency resolution input must be exactly {"operation":"${CODING_DEPENDENCY_RESOLUTION_OPERATION}"}`);
    }
    const root = await realpath(requestedRoot);
    await assertTrackedRootFiles(root);
    const manifestPath = join(root, MANIFEST_PATH);
    const lockPath = join(root, LOCK_PATH);
    const [baselineManifest, baselineLock, manifestBefore, lockBefore] = await Promise.all([
      baselineFile(root, MANIFEST_PATH),
      baselineFile(root, LOCK_PATH),
      boundedFile(manifestPath, MAX_MANIFEST_BYTES, MANIFEST_PATH),
      boundedFile(lockPath, MAX_LOCK_BYTES, LOCK_PATH),
    ]);
    const manifestHashBefore = sha256(manifestBefore);
    if (attemptedManifestFrontiers.has(manifestHashBefore)) {
      throw new Error("Dependency resolution already attempted this manifest frontier");
    }
    attemptedManifestFrontiers.add(manifestHashBefore);
    await assertNodeNpmProfile(root, input.executionProfile, baselineManifest, baselineLock);
    assertManifestDependencyFrontier(baselineManifest, manifestBefore);
    const baselineResolutions = allowedBaselineResolutions(baselineLock);
    assertControlActive(control);

    const tempRoot = await mkdtemp(join(root, ".roster-dependency-resolution-"));
    const tempHome = join(tempRoot, "home");
    const tempCache = join(tempRoot, "cache");
    const tempDirectory = join(tempRoot, "tmp");
    const userConfig = join(tempRoot, "npmrc");
    try {
      await Promise.all([
        mkdir(tempHome),
        mkdir(tempCache),
        mkdir(tempDirectory),
        writeFile(userConfig, `registry=${PUBLIC_NPM_REGISTRY}\nignore-scripts=true\n`, {
          encoding: "utf8",
          mode: 0o600,
        }),
      ]);
      const env: NodeJS.ProcessEnv = {
        PATH: scrubbedPath(),
        HOME: tempHome,
        TMPDIR: tempDirectory,
        npm_config_userconfig: userConfig,
        npm_config_cache: tempCache,
        npm_config_registry: PUBLIC_NPM_REGISTRY,
        npm_config_ignore_scripts: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      };
      const command = process.platform === "win32" ? "npm.cmd" : "npm";
      const execute = (args: ReadonlyArray<string>): CommandExecution => ({
        command,
        args,
        stdin: "",
        cwd: root,
        env,
        replaceEnvironment: true,
        signal: control.signal,
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        maxTransportBytes: MAX_COMMAND_OUTPUT_BYTES,
        maxCaptureBytes: MAX_COMMAND_OUTPUT_BYTES,
      });
      const lockResult = await successfulCommand(runner, execute([
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]), "npm lockfile resolution");
      const [manifestAfterResolution, lockAfterResolution] = await Promise.all([
        boundedFile(manifestPath, MAX_MANIFEST_BYTES, MANIFEST_PATH),
        boundedFile(lockPath, MAX_LOCK_BYTES, LOCK_PATH),
      ]);
      if (manifestAfterResolution !== manifestBefore) {
        throw new Error("npm lockfile resolution unexpectedly changed package.json");
      }
      assertManifestDependencyFrontier(baselineManifest, manifestAfterResolution);
      assertLockResolutionFrontier(baselineResolutions, lockAfterResolution);
      assertControlActive(control);
      const materializeResult = await successfulCommand(runner, execute([
        "ci",
        "--ignore-scripts",
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
      ]), "npm dependency materialization");
      const auditResult = await runner(execute(["audit", "--omit=dev", "--json"]));
      if (auditResult.exitCode !== 0 && auditResult.exitCode !== 1) {
        throw new Error(`npm audit failed with exit code ${String(auditResult.exitCode)}`);
      }
      const [manifestAfter, lockAfter] = await Promise.all([
        boundedFile(manifestPath, MAX_MANIFEST_BYTES, MANIFEST_PATH),
        boundedFile(lockPath, MAX_LOCK_BYTES, LOCK_PATH),
      ]);
      if (manifestAfter !== manifestBefore || lockAfter !== lockAfterResolution) {
        throw new Error("Dependency materialization changed the resolved manifest frontier");
      }
      return {
        manifestHashBefore,
        manifestHashAfter: sha256(manifestAfter),
        lockHashBefore: sha256(lockBefore),
        lockHashAfter: sha256(lockAfter),
        changed: lockBefore !== lockAfter,
        audit: auditCounts(auditResult.stdout),
        commands: {
          lockfile: lockResult.exitCode ?? -1,
          materialize: materializeResult.exitCode ?? -1,
          audit: auditResult.exitCode ?? -1,
        },
        durationMs: Math.max(0, Date.now() - startedAt),
      } satisfies RepositoryDependencyResolutionReceipt;
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
};
