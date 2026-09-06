import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { hashCanonical } from "../../core/canonical.js";

const MAX_MANIFESTS = 64;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PROFILE_COMMANDS = 8;
const MAX_PROFILE_ARGS = 24;
const MAX_PROFILE_EVIDENCE_FILES = 24;
const MAX_PROFILE_VALUE_LENGTH = 512;

const PROFILE_COMMANDS = new Set([
  "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.exe",
  "uv", "uv.exe", "python", "python.exe", "python3", "pytest", "ruff", "mypy",
  "cargo", "cargo.exe", "go", "go.exe", "make", "gradle", "gradle.bat", "./gradlew",
  "mvn", "mvn.cmd", "./mvnw", "bundle", "dotnet", "dotnet.exe", "swift",
]);

export const REPOSITORY_EXECUTION_PROFILE_SCHEMA = "roster.repository-execution-profile.v1" as const;

export type RepositoryToolchainId = "node-npm" | "python-uv" | "onboarded";

export type RepositoryToolchainCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
};

export type RepositoryExecutionProfile = {
  readonly schema: typeof REPOSITORY_EXECUTION_PROFILE_SCHEMA;
  readonly version: 1;
  readonly source: "detected" | "onboarded";
  readonly repositoryFingerprint: string;
  readonly evidenceFiles: ReadonlyArray<string>;
  readonly evidenceHash: string;
  readonly installCommands: ReadonlyArray<RepositoryToolchainCommand>;
  readonly verifyCommands: ReadonlyArray<RepositoryToolchainCommand>;
  readonly contentHash: string;
};

export type RepositoryExecutionProfileInput = Omit<RepositoryExecutionProfile, "schema" | "version" | "contentHash">;

export type RepositoryToolchain = {
  readonly id: RepositoryToolchainId;
  readonly manifests: ReadonlyArray<string>;
  readonly installCommands: ReadonlyArray<RepositoryToolchainCommand>;
  readonly verifyCommands: ReadonlyArray<RepositoryToolchainCommand>;
};

export type RepositoryManifest = {
  readonly path: string;
  readonly content: string;
};

export type RepositoryToolchainInspection = {
  readonly manifests: ReadonlyArray<RepositoryManifest>;
  readonly dependencies: ReadonlyArray<string>;
  readonly toolchains: ReadonlyArray<RepositoryToolchain>;
};

const normalizeDependency = (value: string): string | undefined => {
  const normalized = value.trim().toLowerCase().match(/^[a-z0-9][a-z0-9._-]*/)?.[0];
  return normalized?.replaceAll("_", "-");
};

const packageJsonDependencies = (content: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(content) as {
      readonly dependencies?: Readonly<Record<string, unknown>>;
      readonly devDependencies?: Readonly<Record<string, unknown>>;
      readonly peerDependencies?: Readonly<Record<string, unknown>>;
      readonly scripts?: Readonly<Record<string, unknown>>;
    };
    return [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
      ...Object.keys(parsed.peerDependencies ?? {}),
    ].flatMap((value) => normalizeDependency(value) ?? []);
  } catch {
    return [];
  }
};

const pyprojectDependencies = (content: string): ReadonlyArray<string> =>
  [...content.matchAll(/["']([a-zA-Z0-9][a-zA-Z0-9._-]*(?:\[[^\]]+\])?(?:\s*[<>=!~][^"']*)?)["']/g)]
    .flatMap((match) => normalizeDependency(match[1] ?? "") ?? []);

const npmVerifyCommands = (content: string): ReadonlyArray<RepositoryToolchainCommand> => {
  try {
    const parsed = JSON.parse(content) as { readonly scripts?: Readonly<Record<string, unknown>> };
    const scripts = parsed.scripts ?? {};
    const declared = (name: string): boolean =>
      typeof scripts[name] === "string" && Boolean(scripts[name].trim());
    const names = declared("verify")
      ? ["verify"]
      : ["lint", "typecheck", "test", "build"].filter(declared);
    return names.map((name) => ({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", name],
    }));
  } catch {
    return [];
  }
};

const uvCommand = (args: ReadonlyArray<string>): RepositoryToolchainCommand => ({
  command: process.platform === "win32" ? "uv.exe" : "uv",
  args,
});

export const inspectRepositoryToolchainManifests = (
  manifests: ReadonlyArray<RepositoryManifest>,
  files: ReadonlyArray<string>,
): RepositoryToolchainInspection => {
  const byPath = new Map(manifests.map((manifest) => [manifest.path, manifest.content]));
  const packageJson = byPath.get("package.json");
  const pyproject = byPath.get("pyproject.toml");
  const toolchains: RepositoryToolchain[] = [];

  if (packageJson !== undefined && files.includes("package-lock.json")) {
    toolchains.push({
      id: "node-npm",
      manifests: ["package.json", "package-lock.json"],
      installCommands: [{
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
      }],
      verifyCommands: npmVerifyCommands(packageJson),
    });
  }

  if (pyproject !== undefined && files.includes("uv.lock")) {
    const uvRun = ["run", "--frozen", "--all-extras", "python", "-m"] as const;
    const verifyCommands: RepositoryToolchainCommand[] = [];
    if (/^\s*\[tool\.ruff(?:\.|\])/m.test(pyproject)) {
      verifyCommands.push(
        uvCommand([...uvRun, "ruff", "check", "."]),
        uvCommand([...uvRun, "ruff", "format", "--check", "."]),
      );
    }
    if (/^\s*\[tool\.mypy\]/m.test(pyproject)) {
      verifyCommands.push(uvCommand([...uvRun, "mypy"]));
    }
    if (/^\s*\[tool\.pytest(?:\.|\])/m.test(pyproject) || files.some((path) => /(^|\/)tests?(\/|$)/.test(path))) {
      verifyCommands.push(uvCommand([...uvRun, "pytest"]));
    }
    toolchains.push({
      id: "python-uv",
      manifests: ["pyproject.toml", "uv.lock"],
      installCommands: [uvCommand(["sync", "--frozen", "--all-extras"])],
      verifyCommands,
    });
  }

  const dependencies = manifests.flatMap((manifest) => manifest.path.endsWith("package.json")
    ? packageJsonDependencies(manifest.content)
    : manifest.path.endsWith("pyproject.toml")
      ? pyprojectDependencies(manifest.content)
      : []);
  return {
    manifests: [...manifests].sort((left, right) => left.path.localeCompare(right.path)),
    dependencies: [...new Set(dependencies)].sort(),
    toolchains,
  };
};

export const inspectRepositoryToolchains = async (
  repositoryRoot: string,
  knownFiles?: ReadonlyArray<string>,
): Promise<RepositoryToolchainInspection> => {
  const root = resolve(repositoryRoot);
  const files = [...new Set(knownFiles ?? ["package.json", "package-lock.json", "pyproject.toml", "uv.lock"])]
    .filter((path) => path && !path.startsWith("../") && !path.startsWith("/"));
  const manifestPaths = files
    .filter((path) => /(^|\/)(package\.json|pyproject\.toml)$/.test(path))
    .sort()
    .slice(0, MAX_MANIFESTS);
  const manifests = (await Promise.all(manifestPaths.map(async (path): Promise<RepositoryManifest | undefined> => {
    const absolutePath = join(root, path);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return undefined;
    const rootRelative = relative(root, absolutePath);
    if (!rootRelative || rootRelative.startsWith("..")) return undefined;
    const content = await readFile(absolutePath, "utf8").catch(() => undefined);
    return content === undefined ? undefined : { path, content };
  }))).filter((manifest): manifest is RepositoryManifest => manifest !== undefined);
  return inspectRepositoryToolchainManifests(manifests, files);
};

export const repositoryToolchainCommands = (
  inspection: RepositoryToolchainInspection,
  phase: "install" | "verify",
): ReadonlyArray<RepositoryToolchainCommand> => inspection.toolchains.flatMap((toolchain) =>
  phase === "install" ? toolchain.installCommands : toolchain.verifyCommands);

const normalizedRelativePath = (value: string, label: string, allowRoot = false): string => {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.length > MAX_PROFILE_VALUE_LENGTH || isAbsolute(trimmed)) {
    throw new Error(`${label} must be a bounded repository-relative path`);
  }
  const parts = trimmed.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === ".." || /[\u0000-\u001f]/.test(part))) {
    throw new Error(`${label} must stay inside the repository`);
  }
  const normalized = parts.join("/");
  if (!normalized && !allowRoot) throw new Error(`${label} must name a repository file`);
  return normalized || ".";
};

const normalizedProfileCommands = (
  phase: string,
  commands: ReadonlyArray<RepositoryToolchainCommand>,
): ReadonlyArray<RepositoryToolchainCommand> => {
  if (commands.length > MAX_PROFILE_COMMANDS) {
    throw new Error(`Repository execution profile has more than ${MAX_PROFILE_COMMANDS} ${phase} commands`);
  }
  return commands.map((entry) => {
    const command = entry.command.trim();
    if (!PROFILE_COMMANDS.has(command)) {
      throw new Error(`Repository execution profile command ${command || "<blank>"} is not allowlisted`);
    }
    if (entry.args.length > MAX_PROFILE_ARGS) {
      throw new Error(`Repository execution profile command ${command} has too many arguments`);
    }
    const args = entry.args.map((arg) => {
      if (!arg || arg.length > MAX_PROFILE_VALUE_LENGTH || /[\u0000-\u001f]/.test(arg)) {
        throw new Error(`Repository execution profile command ${command} has an invalid argument`);
      }
      return arg;
    });
    return {
      command,
      args,
      ...(entry.cwd ? { cwd: normalizedRelativePath(entry.cwd, `${phase} command cwd`, true) } : {}),
    };
  });
};

export const compileRepositoryExecutionProfile = (
  input: RepositoryExecutionProfileInput,
): RepositoryExecutionProfile => {
  if (input.source !== "detected" && input.source !== "onboarded") {
    throw new Error("Repository execution profile requires a valid source");
  }
  if (!/^[a-f0-9]{64}$/.test(input.repositoryFingerprint)) {
    throw new Error("Repository execution profile requires a SHA-256 repository fingerprint");
  }
  if (!/^[a-f0-9]{64}$/.test(input.evidenceHash)) {
    throw new Error("Repository execution profile requires a SHA-256 evidence hash");
  }
  if (input.evidenceFiles.length > MAX_PROFILE_EVIDENCE_FILES) {
    throw new Error(`Repository execution profile has more than ${MAX_PROFILE_EVIDENCE_FILES} evidence files`);
  }
  const evidenceFiles = [...new Set(input.evidenceFiles.map((path) =>
    normalizedRelativePath(path, "Repository execution profile evidence")))].sort();
  const installCommands = normalizedProfileCommands("install", input.installCommands);
  const verifyCommands = normalizedProfileCommands("verify", input.verifyCommands);
  if (!verifyCommands.length) throw new Error("Repository execution profile requires at least one verify command");
  const content = {
    schema: REPOSITORY_EXECUTION_PROFILE_SCHEMA,
    version: 1 as const,
    source: input.source,
    repositoryFingerprint: input.repositoryFingerprint,
    evidenceFiles,
    evidenceHash: input.evidenceHash,
    installCommands,
    verifyCommands,
  };
  return { ...content, contentHash: hashCanonical(content) };
};

export const detectedRepositoryExecutionProfile = (
  inspection: RepositoryToolchainInspection,
  repositoryFingerprint: string,
): RepositoryExecutionProfile | undefined => {
  const verifyCommands = repositoryToolchainCommands(inspection, "verify");
  if (!verifyCommands.length) return undefined;
  return compileRepositoryExecutionProfile({
    source: "detected",
    repositoryFingerprint,
    evidenceFiles: inspection.manifests.map((manifest) => manifest.path),
    evidenceHash: repositoryExecutionProfileEvidenceHash(inspection.manifests),
    installCommands: repositoryToolchainCommands(inspection, "install"),
    verifyCommands,
  });
};

export const parseRepositoryExecutionProfile = (value: unknown): RepositoryExecutionProfile | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profile = value as Partial<RepositoryExecutionProfile>;
  if (
    profile.schema !== REPOSITORY_EXECUTION_PROFILE_SCHEMA
    || profile.version !== 1
    || (profile.source !== "detected" && profile.source !== "onboarded")
    || typeof profile.repositoryFingerprint !== "string"
    || !Array.isArray(profile.evidenceFiles)
    || !profile.evidenceFiles.every((item) => typeof item === "string")
    || typeof profile.evidenceHash !== "string"
    || !Array.isArray(profile.installCommands)
    || !Array.isArray(profile.verifyCommands)
    || typeof profile.contentHash !== "string"
  ) return undefined;
  const command = (item: unknown): item is RepositoryToolchainCommand => Boolean(
    item && typeof item === "object" && !Array.isArray(item)
    && typeof (item as RepositoryToolchainCommand).command === "string"
    && Array.isArray((item as RepositoryToolchainCommand).args)
    && (item as RepositoryToolchainCommand).args.every((arg) => typeof arg === "string")
    && ((item as RepositoryToolchainCommand).cwd === undefined || typeof (item as RepositoryToolchainCommand).cwd === "string"),
  );
  if (!profile.installCommands.every(command) || !profile.verifyCommands.every(command)) return undefined;
  try {
    const compiled = compileRepositoryExecutionProfile({
      source: profile.source,
      repositoryFingerprint: profile.repositoryFingerprint,
      evidenceFiles: profile.evidenceFiles,
      evidenceHash: profile.evidenceHash,
      installCommands: profile.installCommands,
      verifyCommands: profile.verifyCommands,
    });
    return compiled.contentHash === profile.contentHash ? compiled : undefined;
  } catch {
    return undefined;
  }
};

export const repositoryExecutionProfileEvidenceHash = (
  evidence: ReadonlyArray<RepositoryManifest | { readonly path: string; readonly contentHash: string }>,
): string => hashCanonical([...evidence]
  .map((entry) => ({
    path: entry.path,
    contentHash: "contentHash" in entry ? entry.contentHash : hashCanonical(entry.content),
  }))
  .sort((left, right) => left.path.localeCompare(right.path)));

export const assertRepositoryExecutionProfileEvidence = async (
  repositoryRoot: string,
  profile: RepositoryExecutionProfile,
): Promise<void> => {
  const root = resolve(repositoryRoot);
  const evidence = (await Promise.all(profile.evidenceFiles.map(async (path): Promise<RepositoryManifest | undefined> => {
    const absolutePath = join(root, path);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) return undefined;
    const rootRelative = relative(root, absolutePath);
    if (!rootRelative || rootRelative.startsWith("..") || isAbsolute(rootRelative)) return undefined;
    const content = await readFile(absolutePath, "utf8").catch(() => undefined);
    return content === undefined ? undefined : { path, content };
  }))).filter((entry): entry is RepositoryManifest => entry !== undefined);
  if (evidence.length !== profile.evidenceFiles.length
    || repositoryExecutionProfileEvidenceHash(evidence) !== profile.evidenceHash) {
    throw new Error("Repository execution profile is stale; rescan the workspace toolchain evidence");
  }
};

export const repositoryExecutionProfileCommands = (
  profile: RepositoryExecutionProfile,
  phase: "install" | "verify",
): ReadonlyArray<RepositoryToolchainCommand> => phase === "install"
  ? profile.installCommands
  : profile.verifyCommands;

export const repositoryToolchainCommandCwd = (
  repositoryRoot: string,
  command: RepositoryToolchainCommand,
): string => {
  const root = resolve(repositoryRoot);
  const cwd = resolve(root, command.cwd ?? ".");
  const fromRoot = relative(root, cwd);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Repository toolchain command cwd escaped the repository root");
  }
  return cwd;
};

export const renderRepositoryToolchainCommand = (command: RepositoryToolchainCommand): string =>
  `${command.cwd ? `[${command.cwd}] ` : ""}${[command.command, ...command.args].join(" ")}`;
