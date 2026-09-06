import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export type CodingRuntimeAccess = "read-only" | "workspace-write";

export type CodingRuntimeDiscoveryDescriptor = {
  /** Stable Roster runtime kind or package-owned adapter kind. */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** Executable followed by any immutable command prefix. */
  readonly command: readonly [string, ...ReadonlyArray<string>];
  readonly versionArguments?: ReadonlyArray<string>;
  readonly access: ReadonlyArray<CodingRuntimeAccess>;
  readonly source: "builtin" | "manifest";
};

export type CodingRuntimeDiscoveryManifest = {
  readonly schema: "roster.coding-runtime-discovery.v1";
  readonly runtimes: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
    readonly command: readonly [string, ...ReadonlyArray<string>];
    readonly versionArguments?: ReadonlyArray<string>;
    readonly access: ReadonlyArray<CodingRuntimeAccess>;
  }>;
};

export type DiscoveredCodingRuntime = {
  readonly descriptor: CodingRuntimeDiscoveryDescriptor;
  readonly available: boolean;
  /**
   * Ready means the executable accepted its bounded, non-authenticating
   * version probe. An available runtime may remain selectable when an older
   * CLI does not implement that probe.
   */
  readonly ready: boolean;
  readonly executablePath?: string;
  readonly version?: string;
  readonly readiness: "ready" | "probe-failed" | "not-installed";
};

const RUNTIME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_RUNTIME_DESCRIPTORS = 64;
const MAX_DESCRIPTOR_TEXT = 240;
const MAX_COMMAND_PARTS = 24;
const MAX_COMMAND_PART_LENGTH = 1_024;
const MAX_VERSION_LENGTH = 160;
const VERSION_PROBE_TIMEOUT_MS = 2_500;
const VERSION_PROBE_MAX_BYTES = 8 * 1_024;
const execFileAsync = promisify(execFile);

export const BUILTIN_CODING_RUNTIME_DESCRIPTORS = [
  {
    id: "pi-agent",
    label: "Pi Code · AFT",
    detail: "Pi runtime with curated AST, search, and LSP tools",
    command: ["pi"],
    versionArguments: ["--version"],
    access: ["read-only", "workspace-write"],
    source: "builtin",
  },
  {
    id: "hermes-agent",
    label: "Hermes Agent",
    detail: "Nous Hermes in quiet one-shot mode",
    command: ["hermes"],
    versionArguments: ["--version"],
    access: ["read-only", "workspace-write"],
    source: "builtin",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    detail: "Installed implementation runtime",
    command: ["claude"],
    versionArguments: ["--version"],
    access: ["read-only", "workspace-write"],
    source: "builtin",
  },
  {
    id: "codex-cli",
    label: "Codex · Sol high",
    detail: "Installed implementation runtime",
    command: ["codex"],
    versionArguments: ["--version"],
    access: ["read-only", "workspace-write"],
    source: "builtin",
  },
] as const satisfies ReadonlyArray<CodingRuntimeDiscoveryDescriptor>;

const boundedText = (value: unknown, field: string, optional = false): string | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_DESCRIPTOR_TEXT) {
    throw new Error(`Coding runtime ${field} must be a non-blank string of at most ${MAX_DESCRIPTOR_TEXT} characters`);
  }
  return value.trim();
};

const commandParts = (
  value: unknown,
  field: string,
): readonly [string, ...ReadonlyArray<string>] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMAND_PARTS) {
    throw new Error(`Coding runtime ${field} must contain 1-${MAX_COMMAND_PARTS} command parts`);
  }
  const parts = value.map((part) => {
    if (typeof part !== "string" || !part.trim() || part.length > MAX_COMMAND_PART_LENGTH || part.includes("\0")) {
      throw new Error(`Coding runtime ${field} contains an invalid command part`);
    }
    return part;
  });
  return parts as [string, ...ReadonlyArray<string>];
};

const versionArguments = (value: unknown): ReadonlyArray<string> => {
  if (value === undefined) return ["--version"];
  if (!Array.isArray(value) || value.length > MAX_COMMAND_PARTS) {
    throw new Error(`Coding runtime versionArguments must contain at most ${MAX_COMMAND_PARTS} parts`);
  }
  return value.map((part) => {
    if (typeof part !== "string" || part.length > MAX_COMMAND_PART_LENGTH || part.includes("\0")) {
      throw new Error("Coding runtime versionArguments contains an invalid part");
    }
    return part;
  });
};

const accessModes = (value: unknown): ReadonlyArray<CodingRuntimeAccess> => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Coding runtime access must declare read-only, workspace-write, or both");
  }
  const modes = [...new Set(value)];
  if (modes.some((mode) => mode !== "read-only" && mode !== "workspace-write")) {
    throw new Error("Coding runtime access contains an unsupported mode");
  }
  return modes as ReadonlyArray<CodingRuntimeAccess>;
};

export const parseCodingRuntimeDiscoveryManifest = (
  value: unknown,
): ReadonlyArray<CodingRuntimeDiscoveryDescriptor> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Coding runtime discovery manifest must be an object");
  }
  const manifest = value as Partial<CodingRuntimeDiscoveryManifest>;
  if (manifest.schema !== "roster.coding-runtime-discovery.v1") {
    throw new Error("Coding runtime discovery manifest has an unsupported schema");
  }
  if (!Array.isArray(manifest.runtimes) || manifest.runtimes.length > MAX_RUNTIME_DESCRIPTORS) {
    throw new Error(`Coding runtime discovery manifest supports at most ${MAX_RUNTIME_DESCRIPTORS} runtimes`);
  }
  const ids = new Set<string>();
  return manifest.runtimes.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Coding runtime descriptor must be an object");
    }
    const id = boundedText(entry.id, "id")!;
    if (!RUNTIME_ID_PATTERN.test(id)) throw new Error(`Coding runtime id ${id} is invalid`);
    if (ids.has(id)) throw new Error(`Coding runtime id ${id} is duplicated`);
    ids.add(id);
    const label = boundedText(entry.label, "label")!;
    const detail = boundedText(entry.detail, "detail", true) ?? "Installed custom runtime";
    return {
      id,
      label,
      detail,
      command: commandParts(entry.command, "command"),
      versionArguments: versionArguments(entry.versionArguments),
      access: accessModes(entry.access),
      source: "manifest" as const,
    };
  });
};

const executableExtensions = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ReadonlyArray<string> => platform === "win32"
  ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  : [""];

const executablePath = async (
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> => {
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter((directory) => isAbsolute(directory))
        .flatMap((directory) => executableExtensions(env, platform)
          .map((extension) => join(directory, platform === "win32" ? `${command}${extension}` : command)));
  const accessMode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  for (const candidate of candidates) {
    if (await access(candidate, accessMode).then(() => true, () => false)) return candidate;
  }
  return undefined;
};

const versionProbeEnvironment = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv => ({
  PATH: env.PATH ?? "",
  ...(env.PATHEXT ? { PATHEXT: env.PATHEXT } : {}),
  ...(env.LANG ? { LANG: env.LANG } : {}),
  ...(env.LC_ALL ? { LC_ALL: env.LC_ALL } : {}),
  ...(platform === "win32" && env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
  ...(platform === "win32" && env.WINDIR ? { WINDIR: env.WINDIR } : {}),
});

const normalizedVersion = (stdout: string, stderr: string): string | undefined => {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find(Boolean);
  return line ? line.slice(0, MAX_VERSION_LENGTH) : undefined;
};

const discoverDescriptor = async (
  descriptor: CodingRuntimeDiscoveryDescriptor,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<DiscoveredCodingRuntime> => {
  const path = await executablePath(descriptor.command[0], env, platform);
  if (!path) {
    return {
      descriptor,
      available: false,
      ready: false,
      readiness: "not-installed",
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      path,
      [...descriptor.command.slice(1), ...(descriptor.versionArguments ?? ["--version"])],
      {
        env: versionProbeEnvironment(env, platform),
        timeout: VERSION_PROBE_TIMEOUT_MS,
        maxBuffer: VERSION_PROBE_MAX_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    return {
      descriptor,
      available: true,
      ready: true,
      readiness: "ready",
      executablePath: path,
      ...(normalizedVersion(stdout, stderr) ? { version: normalizedVersion(stdout, stderr) } : {}),
    };
  } catch {
    return {
      descriptor,
      available: true,
      ready: false,
      readiness: "probe-failed",
      executablePath: path,
    };
  }
};

export class CodingRuntimeDiscoveryRegistry {
  readonly #descriptors: ReadonlyArray<CodingRuntimeDiscoveryDescriptor>;

  constructor(
    descriptors: ReadonlyArray<CodingRuntimeDiscoveryDescriptor> = BUILTIN_CODING_RUNTIME_DESCRIPTORS,
  ) {
    if (descriptors.length > MAX_RUNTIME_DESCRIPTORS) {
      throw new Error(`Coding runtime discovery registry supports at most ${MAX_RUNTIME_DESCRIPTORS} descriptors`);
    }
    const ids = new Set<string>();
    for (const descriptor of descriptors) {
      if (ids.has(descriptor.id)) throw new Error(`Coding runtime id ${descriptor.id} is duplicated`);
      ids.add(descriptor.id);
    }
    this.#descriptors = [...descriptors];
  }

  descriptors(): ReadonlyArray<CodingRuntimeDiscoveryDescriptor> {
    return [...this.#descriptors];
  }

  extend(descriptors: ReadonlyArray<CodingRuntimeDiscoveryDescriptor>): CodingRuntimeDiscoveryRegistry {
    return new CodingRuntimeDiscoveryRegistry([...this.#descriptors, ...descriptors]);
  }

  async discover(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ): Promise<ReadonlyArray<DiscoveredCodingRuntime>> {
    return Promise.all(this.#descriptors.map((descriptor) => discoverDescriptor(descriptor, env, platform)));
  }
}

export const createCodingRuntimeDiscoveryRegistry = (
  descriptors: ReadonlyArray<CodingRuntimeDiscoveryDescriptor> = BUILTIN_CODING_RUNTIME_DESCRIPTORS,
): CodingRuntimeDiscoveryRegistry => new CodingRuntimeDiscoveryRegistry(descriptors);
