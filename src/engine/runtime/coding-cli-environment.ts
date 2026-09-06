import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { parse } from "dotenv";

import { BUILTIN_CODING_RUNTIME_DESCRIPTORS } from "./coding-runtime-discovery.js";

export const ROSTER_CODING_VALIDATION_ENV_FILE = "ROSTER_CODING_VALIDATION_ENV_FILE";
export const ROSTER_CODING_VALIDATION_ENV_KEYS = "ROSTER_CODING_VALIDATION_ENV_KEYS";
const MAX_VALIDATION_ENV_FILE_BYTES = 64 * 1024;
const MAX_VALIDATION_ENV_KEYS = 32;
const MAX_VALIDATION_ENV_VALUE_BYTES = 16 * 1024;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const BLOCKED_VALIDATION_ENV_KEYS = new Set([
  "BASH_ENV",
  "CLASSPATH",
  "ENV",
  "GIT_EXEC_PATH",
  "HOME",
  "JAVA_TOOL_OPTIONS",
  "NODE_OPTIONS",
  "PATH",
  "PERL5LIB",
  "PERL5OPT",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYLIB",
  "RUBYOPT",
  "SHELL",
  "ZDOTDIR",
  "_JAVA_OPTIONS",
]);

const executableExtensions = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ReadonlyArray<string> => platform === "win32"
  ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  : [""];

const containsCodingCli = (
  directory: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean => {
  const extensions = executableExtensions(env, platform);
  return BUILTIN_CODING_RUNTIME_DESCRIPTORS.some((descriptor) => extensions.some((extension) => {
    const command = descriptor.command[0];
    const executable = join(directory, platform === "win32" ? `${command}${extension}` : command);
    try {
      accessSync(executable, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
};

const installedApplicationDirectories = (platform: NodeJS.Platform): ReadonlyArray<string> =>
  platform === "darwin"
    ? [
        "/Applications/ChatGPT.app/Contents/Resources",
        "/Applications/Codex.app/Contents/Resources",
        join(homedir(), "Applications/ChatGPT.app/Contents/Resources"),
        join(homedir(), "Applications/Codex.app/Contents/Resources"),
      ]
    : [];

/**
 * Produces the trusted environment fragment shared by coding runtime discovery
 * and child-process execution. Existing PATH precedence is preserved; an
 * explicit Roster path is prepended and signed desktop application resources
 * are appended only when they contain a supported executable.
 */
export const resolveCodingCliEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  applicationDirectories: ReadonlyArray<string> = installedApplicationDirectories(platform),
): NodeJS.ProcessEnv => {
  const configured = (env.ROSTER_CODING_CLI_PATH ?? "")
    .split(delimiter)
    .filter((directory) => isAbsolute(directory) && containsCodingCli(directory, env, platform));
  const existing = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const applications = applicationDirectories
    .filter((directory) => isAbsolute(directory) && containsCodingCli(directory, env, platform));
  const pathEntries = [...new Set([...configured, ...existing, ...applications])];
  return {
    PATH: pathEntries.join(delimiter),
    ...(env.PATHEXT ? { PATHEXT: env.PATHEXT } : {}),
  };
};

/**
 * Reads only explicitly named values from one operator-selected dotenv file.
 * The returned fragment is intended for the non-model repository validation
 * command runtime, never for coding CLI adapters.
 */
export const resolveCodingValidationEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Buffer = (path) => readFileSync(path),
): NodeJS.ProcessEnv => {
  const configuredPath = env[ROSTER_CODING_VALIDATION_ENV_FILE]?.trim();
  const configuredKeys = env[ROSTER_CODING_VALIDATION_ENV_KEYS]?.trim();
  if (!configuredPath && !configuredKeys) return {};
  if (!configuredPath || !configuredKeys) {
    throw new Error(
      `${ROSTER_CODING_VALIDATION_ENV_FILE} and ${ROSTER_CODING_VALIDATION_ENV_KEYS} must be configured together`,
    );
  }
  if (!isAbsolute(configuredPath)) {
    throw new Error(`${ROSTER_CODING_VALIDATION_ENV_FILE} must be an absolute path`);
  }
  const keys = [...new Set(configuredKeys.split(",").map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0 || keys.length > MAX_VALIDATION_ENV_KEYS) {
    throw new Error(`${ROSTER_CODING_VALIDATION_ENV_KEYS} must select between 1 and ${MAX_VALIDATION_ENV_KEYS} keys`);
  }
  for (const key of keys) {
    if (!ENVIRONMENT_KEY.test(key) || BLOCKED_VALIDATION_ENV_KEYS.has(key) || key.startsWith("DYLD_")
      || key.startsWith("LD_") || key.startsWith("GIT_CONFIG_")
      || key.toLowerCase().startsWith("npm_config_")) {
      throw new Error(`${ROSTER_CODING_VALIDATION_ENV_KEYS} contains unsafe key ${key}`);
    }
  }
  const contents = read(configuredPath);
  if (contents.byteLength > MAX_VALIDATION_ENV_FILE_BYTES) {
    throw new Error(`${ROSTER_CODING_VALIDATION_ENV_FILE} exceeds ${MAX_VALIDATION_ENV_FILE_BYTES} bytes`);
  }
  const parsed = parse(contents);
  const selected: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = parsed[key];
    if (value === undefined) {
      throw new Error(`${ROSTER_CODING_VALIDATION_ENV_FILE} does not define selected key ${key}`);
    }
    if (Buffer.byteLength(value) > MAX_VALIDATION_ENV_VALUE_BYTES) {
      throw new Error(`Validation environment value ${key} exceeds ${MAX_VALIDATION_ENV_VALUE_BYTES} bytes`);
    }
    selected[key] = value;
  }
  return selected;
};
