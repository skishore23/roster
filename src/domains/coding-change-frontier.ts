import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const CODING_CHANGE_FRONTIER_FUNCTION_ID =
  "coding::change-frontier.read" as const;
export const CODING_CHANGE_FRONTIER_SCHEMA =
  "roster.coding.change-frontier.v1" as const;

const DEFAULT_PATCH_BYTES = 64 * 1_024;
const MAX_PATCH_BYTES = 256 * 1_024;
const MAX_CHANGED_FILES = 256;
const MAX_GIT_METADATA_BYTES = 8 * 1_048_576;
const MAX_GIT_PATH_BYTES = 16 * 1_024;
const execFileAsync = promisify(execFile);

export type CodingChangeFrontierOperation = "summary" | "patch";

export type CodingChangeFrontier = {
  readonly schema: typeof CODING_CHANGE_FRONTIER_SCHEMA;
  readonly baselineCommit: string;
  readonly candidateTree: string;
  readonly patchHash: string;
  readonly patchBytes: number;
  readonly changedFiles: ReadonlyArray<string>;
  readonly omittedChangedFiles: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly selectedPath?: string;
  readonly patch: string;
  readonly selectedPatchBytes: number;
  readonly patchTruncated: boolean;
};

type GitOutput = {
  readonly bytes: number;
  readonly hash: string;
  readonly captured: Buffer;
  readonly truncated: boolean;
};

type GitNames = {
  readonly names: ReadonlyArray<string>;
  readonly total: number;
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Coding ChangeFrontier capture was aborted");

const assertActive = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError(signal);
};

const gitText = async (
  root: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> => {
  assertActive(signal);
  const result = await execFileAsync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: MAX_GIT_METADATA_BYTES,
    ...(signal ? { signal } : {}),
  });
  return result.stdout;
};

const hashGitOutput = (
  root: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  captureBytes: number,
  signal?: AbortSignal,
): Promise<GitOutput> => new Promise((resolveOutput, reject) => {
  assertActive(signal);
  const child = spawn("git", args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(signal ? { signal } : {}),
  });
  const hash = createHash("sha256");
  const captured: Buffer[] = [];
  const errors: Buffer[] = [];
  let capturedBytes = 0;
  let errorBytes = 0;
  let bytes = 0;
  let settled = false;
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  child.once("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.byteLength;
    if (capturedBytes >= captureBytes) return;
    const remaining = captureBytes - capturedBytes;
    const selected = chunk.subarray(0, remaining);
    captured.push(selected);
    capturedBytes += selected.byteLength;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorBytes >= 64 * 1_024) return;
    const selected = chunk.subarray(0, (64 * 1_024) - errorBytes);
    errors.push(selected);
    errorBytes += selected.byteLength;
  });
  child.once("close", (code) => {
    if (settled) return;
    if (code !== 0) {
      fail(new Error(
        `Git ChangeFrontier command failed (${code ?? "signal"}): ${Buffer.concat(errors).toString("utf8").trim()}`,
      ));
      return;
    }
    settled = true;
    resolveOutput({
      bytes,
      hash: hash.digest("hex"),
      captured: Buffer.concat(captured),
      truncated: bytes > capturedBytes,
    });
  });
});

const collectGitNames = (
  root: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<GitNames> => new Promise((resolveNames, reject) => {
  assertActive(signal);
  const child = spawn("git", args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(signal ? { signal } : {}),
  });
  const names: string[] = [];
  const errors: Buffer[] = [];
  let carry: Buffer = Buffer.alloc(0);
  let errorBytes = 0;
  let total = 0;
  let settled = false;
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    child.kill();
    reject(error);
  };
  child.once("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) return;
    carry = carry.byteLength ? Buffer.concat([carry, chunk]) : chunk;
    let separator = carry.indexOf(0);
    while (separator >= 0) {
      const path = carry.subarray(0, separator);
      if (path.byteLength > MAX_GIT_PATH_BYTES) {
        fail(new Error(`Coding ChangeFrontier path exceeds ${MAX_GIT_PATH_BYTES} bytes`));
        return;
      }
      if (path.byteLength > 0) {
        total += 1;
        if (names.length < MAX_CHANGED_FILES) names.push(path.toString("utf8"));
      }
      carry = carry.subarray(separator + 1);
      separator = carry.indexOf(0);
    }
    if (carry.byteLength > MAX_GIT_PATH_BYTES) {
      fail(new Error(`Coding ChangeFrontier path exceeds ${MAX_GIT_PATH_BYTES} bytes`));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorBytes >= 64 * 1_024) return;
    const selected = chunk.subarray(0, (64 * 1_024) - errorBytes);
    errors.push(selected);
    errorBytes += selected.byteLength;
  });
  child.once("close", (code) => {
    if (settled) return;
    if (code !== 0) {
      fail(new Error(
        `Git ChangeFrontier command failed (${code ?? "signal"}): ${Buffer.concat(errors).toString("utf8").trim()}`,
      ));
      return;
    }
    if (carry.byteLength > 0) {
      fail(new Error("Git ChangeFrontier returned an unterminated changed path"));
      return;
    }
    settled = true;
    resolveNames({ names, total });
  });
});

const selectedRepositoryPath = (
  root: string,
  requestedPath: string | undefined,
): string | undefined => {
  if (requestedPath === undefined) return undefined;
  const normalized = requestedPath.trim();
  if (!normalized || isAbsolute(normalized) || normalized.includes("\u0000")) {
    throw new Error("Coding ChangeFrontier path must be a non-empty repository-relative path");
  }
  const candidate = resolve(root, normalized);
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Coding ChangeFrontier path escapes the authorized repository root");
  }
  return fromRoot.split(sep).join("/");
};

const boundedPatchBytes = (value: number | undefined): number => {
  const candidate = value ?? DEFAULT_PATCH_BYTES;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_PATCH_BYTES) {
    throw new Error(`Coding ChangeFrontier maxBytes must be between 1 and ${MAX_PATCH_BYTES}`);
  }
  return candidate;
};

const shortStat = (
  value: string,
): { readonly insertions: number; readonly deletions: number } => ({
  insertions: Number(/\b(\d+) insertion(?:s)?\(\+\)/u.exec(value)?.[1] ?? 0),
  deletions: Number(/\b(\d+) deletion(?:s)?\(-\)/u.exec(value)?.[1] ?? 0),
});

/**
 * Materializes the live worktree into an execution-private Git index, then
 * identifies the resulting immutable tree and exact binary patch. It never
 * mutates the checkout's real index.
 */
export const captureCodingChangeFrontier = async (input: {
  readonly workingDirectory: string;
  readonly baselineCommit: string;
  readonly operation?: CodingChangeFrontierOperation;
  readonly path?: string;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}): Promise<CodingChangeFrontier> => {
  const root = await realpath(resolve(input.workingDirectory));
  const baseline = input.baselineCommit.trim().toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseline)) {
    throw new Error("Coding ChangeFrontier baselineCommit must be a full Git object id");
  }
  const operation = input.operation ?? "summary";
  if (operation !== "summary" && operation !== "patch") {
    throw new Error("Coding ChangeFrontier operation must be summary or patch");
  }
  const selectedPath = selectedRepositoryPath(root, input.path);
  const maximumBytes = boundedPatchBytes(input.maxBytes);
  const temporary = await mkdtemp(join(tmpdir(), "roster-change-frontier-"));
  const objectDirectory = join(temporary, "objects");
  await mkdir(objectDirectory);
  try {
    const baseEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const resolvedBaseline = (await gitText(
      root,
      ["rev-parse", "--verify", `${baseline}^{commit}`],
      baseEnvironment,
      input.signal,
    )).trim().toLowerCase();
    const head = (await gitText(
      root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      baseEnvironment,
      input.signal,
    )).trim().toLowerCase();
    if (resolvedBaseline !== baseline || head !== baseline) {
      throw new Error(
        `Coding ChangeFrontier baseline ${baseline} is stale for checkout HEAD ${head}`,
      );
    }
    const commonObjects = resolve(root, (await gitText(
      root,
      ["rev-parse", "--git-path", "objects"],
      baseEnvironment,
      input.signal,
    )).trim());
    const environment = {
      ...baseEnvironment,
      GIT_INDEX_FILE: join(temporary, "index"),
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: commonObjects,
    };
    await gitText(root, ["read-tree", baseline], environment, input.signal);
    await gitText(root, ["add", "-A", "--", "."], environment, input.signal);
    const candidateTree = (await gitText(
      root,
      ["write-tree"],
      environment,
      input.signal,
    )).trim().toLowerCase();
    const diffArguments = [
      "--no-pager",
      "diff",
      "--binary",
      "--full-index",
      baseline,
      candidateTree,
      "--",
    ];
    const identity = await hashGitOutput(root, diffArguments, environment, 0, input.signal);
    const names = await collectGitNames(
      root,
      ["diff", "--name-only", "-z", "--no-renames", baseline, candidateTree, "--"],
      environment,
      input.signal,
    );
    const stats = shortStat(await gitText(
      root,
      ["diff", "--shortstat", "--no-renames", baseline, candidateTree, "--"],
      environment,
      input.signal,
    ));
    const selected = operation === "patch"
      ? await hashGitOutput(
          root,
          [...diffArguments, ...(selectedPath ? [selectedPath] : [])],
          environment,
          maximumBytes,
          input.signal,
        )
      : { bytes: 0, captured: Buffer.alloc(0), truncated: false };
    return {
      schema: CODING_CHANGE_FRONTIER_SCHEMA,
      baselineCommit: baseline,
      candidateTree,
      patchHash: identity.hash,
      patchBytes: identity.bytes,
      changedFiles: names.names,
      omittedChangedFiles: Math.max(0, names.total - names.names.length),
      insertions: stats.insertions,
      deletions: stats.deletions,
      ...(selectedPath ? { selectedPath } : {}),
      patch: selected.captured.toString("utf8"),
      selectedPatchBytes: selected.bytes,
      patchTruncated: selected.truncated,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
