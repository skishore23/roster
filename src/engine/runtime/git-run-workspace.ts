import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { runCommand } from "./command-node-runtime.js";
import {
  assertRepositoryExecutionProfileEvidence,
  inspectRepositoryToolchains,
  repositoryExecutionProfileCommands,
  repositoryToolchainCommandCwd,
  repositoryToolchainCommands,
  type RepositoryExecutionProfile,
} from "./repository-toolchain.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DEPENDENCY_INSTALL_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_DEPENDENCY_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_RETAINED_RUN_PATCHES = 100;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const ZERO_OBJECT_ID = "0000000000000000000000000000000000000000";

const git = async (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  const result = await execFileAsync("git", [...args], {
    cwd,
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return result.stdout;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const repositoryKey = (repositoryRoot: string): string =>
  createHash("sha256").update(resolve(repositoryRoot)).digest("hex").slice(0, 20);

const pruneRunPatches = async (root: string): Promise<void> => {
  const patchDir = join(root, "patches");
  const entries = await readdir(patchDir, { withFileTypes: true }).catch(() => []);
  const patches = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".patch"))
    .map(async (entry) => {
      const path = join(patchDir, entry.name);
      const info = await stat(path).catch(() => undefined);
      return info ? { path, mtimeMs: info.mtimeMs } : undefined;
    }));
  const stale = patches
    .filter((entry): entry is { readonly path: string; readonly mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(MAX_RETAINED_RUN_PATCHES);
  await Promise.all(stale.map((entry) => rm(entry.path, { force: true })));
};

export type GitRunWorkspacePaths = {
  readonly root: string;
  readonly workspace: string;
  readonly patch: string;
  readonly metadata: string;
};

export const gitRunBranchName = (runId: string): string => {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid coding run id "${runId}"`);
  return `roster/${runId}`;
};

/** Stable Git ref owned by one durable Coding room. */
export const gitRoomBranchName = (roomId: string): string => {
  if (!RUN_ID_PATTERN.test(roomId)) throw new Error(`Invalid coding room id "${roomId}"`);
  return `roster/rooms/${roomId}`;
};

export type GitRoomBranch = {
  readonly repositoryRoot: string;
  readonly roomId: string;
  readonly branchName: string;
  readonly commit: string;
  readonly targetBranch?: string;
  readonly targetCommit?: string;
};

/**
 * Creates or verifies the durable branch attached to one room. A recorded
 * frontier is authoritative: an out-of-band ref move is rejected instead of
 * being accepted by arrival order or whichever process inspected Git last.
 */
export const ensureGitRoomBranch = async (input: {
  readonly repositoryRoot: string;
  readonly roomId: string;
  readonly recorded?: Omit<GitRoomBranch, "repositoryRoot" | "roomId">;
}): Promise<GitRoomBranch & { readonly created: boolean }> => {
  const repositoryRoot = resolve(input.repositoryRoot);
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const topLevel = (await git(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(resolve(topLevel)) !== canonicalRepositoryRoot) {
    throw new Error("Coding room branch must be created from the repository root");
  }
  const branchName = gitRoomBranchName(input.roomId);
  if (input.recorded) {
    if (input.recorded.branchName !== branchName || !COMMIT_PATTERN.test(input.recorded.commit)) {
      throw new Error(`Coding room ${input.roomId} has invalid Git frontier metadata`);
    }
    if ((input.recorded.targetBranch && !input.recorded.targetCommit)
      || (!input.recorded.targetBranch && input.recorded.targetCommit)
      || (input.recorded.targetCommit && !COMMIT_PATTERN.test(input.recorded.targetCommit))) {
      throw new Error(`Coding room ${input.roomId} has an invalid delivery target`);
    }
    const branchCommit = await git(repositoryRoot, [
      "rev-parse", `refs/heads/${branchName}^{commit}`,
    ]).then((value) => value.trim(), () => undefined);
    if (branchCommit !== input.recorded.commit) {
      throw new Error(
        branchCommit
          ? `Coding room branch ${branchName} moved outside its certified frontier`
          : `Coding room branch ${branchName} no longer exists`,
      );
    }
    return {
      repositoryRoot,
      roomId: input.roomId,
      ...input.recorded,
      created: false,
    };
  }

  const existingCommit = await git(repositoryRoot, [
    "rev-parse", `refs/heads/${branchName}^{commit}`,
  ]).then((value) => value.trim(), () => undefined);
  if (existingCommit) {
    throw new Error(
      `Coding room branch ${branchName} exists without a durable room frontier; inspect it before retrying`,
    );
  }
  const commit = (await git(repositoryRoot, ["rev-parse", "HEAD^{commit}"])).trim();
  const currentBranch = (await git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => "")).trim();
  await git(repositoryRoot, ["update-ref", `refs/heads/${branchName}`, commit, ZERO_OBJECT_ID]);
  return {
    repositoryRoot,
    roomId: input.roomId,
    branchName,
    commit,
    ...(currentBranch ? { targetBranch: currentBranch, targetCommit: commit } : {}),
    created: true,
  };
};

/** Advances only the exact room ref from one certified frontier to the next. */
export const advanceGitRoomBranch = async (input: {
  readonly repositoryRoot: string;
  readonly roomId: string;
  readonly expectedCommit: string;
  readonly certifiedCommit: string;
}): Promise<GitRoomBranch> => {
  if (!COMMIT_PATTERN.test(input.expectedCommit) || !COMMIT_PATTERN.test(input.certifiedCommit)) {
    throw new Error("Coding room frontier contains an invalid commit");
  }
  const repositoryRoot = resolve(input.repositoryRoot);
  if (!await gitCommitIsAncestor(repositoryRoot, input.expectedCommit, input.certifiedCommit)) {
    throw new Error("The certified room commit is not based on the current room frontier");
  }
  const branchName = gitRoomBranchName(input.roomId);
  await git(repositoryRoot, [
    "update-ref",
    `refs/heads/${branchName}`,
    input.certifiedCommit,
    input.expectedCommit,
  ]);
  return {
    repositoryRoot,
    roomId: input.roomId,
    branchName,
    commit: input.certifiedCommit,
  };
};

/**
 * Projects the safe delivery state for a run whose source checkout had no
 * named target branch. The certified run ref remains durable, but Roster must
 * not guess which operator branch should receive it.
 */
export const gitRunDetachedSourceIntegrationStatus = (input: {
  readonly runId: string;
  readonly expectedCommit: string;
  readonly baselineBranch?: string;
  readonly branchName?: string;
}): GitRunIntegrationStatus | undefined => {
  if (input.baselineBranch) return undefined;
  const branchName = input.branchName ?? gitRunBranchName(input.runId);
  return {
    runId: input.runId,
    branchName,
    commit: input.expectedCommit,
    integrated: false,
    canIntegrate: false,
    reason: `This room started from a detached HEAD, so it has no delivery target. Work remains preserved on ${branchName}; attach or create a target branch when you are ready to deliver the room frontier.`,
  };
};

export const gitRunWorkspacePaths = (
  repositoryRoot: string,
  runId: string,
): GitRunWorkspacePaths => {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid coding run id "${runId}"`);
  const root = join(tmpdir(), "roster-coding", repositoryKey(repositoryRoot));
  return {
    root,
    workspace: join(root, "checkouts", runId),
    patch: join(root, "patches", `${runId}.patch`),
    metadata: join(root, "metadata", `${runId}.json`),
  };
};

export type GitRunWorkspace = {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly workingDirectory: string;
  readonly patchPath: string;
  readonly branchName: string;
  readonly baselineBranch?: string;
  readonly baselineCommit: string;
  readonly sourceCheckoutDirty: boolean;
};

export type GitRunIntegrationStatus = {
  readonly runId: string;
  readonly branchName: string;
  readonly commit: string;
  readonly currentBranch?: string;
  readonly integrated: boolean;
  readonly canIntegrate: boolean;
  readonly alreadyIntegrated?: boolean;
  readonly reason?: string;
};

type GitRunWorkspaceMetadata = {
  readonly schema: "roster.git-run-workspace.v1";
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly branchName: string;
  readonly baselineBranch?: string;
  readonly baselineCommit: string;
};

export type GitRunCommitOutcome = {
  readonly commit: string;
  readonly outcome: "committed" | "no_changes";
  readonly noChanges: boolean;
};

type DependencyInstaller = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}) => Promise<void>;

/** Immutable index snapshot that the trusted Roster boundary reviewed. */
export type GitRunPreparedCommit = {
  readonly patch: string;
  readonly patchHash: string;
  readonly tree: string;
};

const writeAtomicFile = async (path: string, contents: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const writeWorkspaceMetadata = async (
  path: string,
  metadata: GitRunWorkspaceMetadata,
): Promise<void> => {
  await writeAtomicFile(path, `${JSON.stringify(metadata)}\n`);
};

const readWorkspaceMetadata = async (path: string): Promise<GitRunWorkspaceMetadata | undefined> => {
  if (!await exists(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Coding run workspace metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Coding run workspace metadata must be an object");
  }
  const candidate = parsed as Readonly<Record<string, unknown>>;
  if (
    candidate.schema !== "roster.git-run-workspace.v1"
    || typeof candidate.runId !== "string"
    || typeof candidate.repositoryRoot !== "string"
    || typeof candidate.branchName !== "string"
    || (candidate.baselineBranch !== undefined && typeof candidate.baselineBranch !== "string")
    || typeof candidate.baselineCommit !== "string"
    || !COMMIT_PATTERN.test(candidate.baselineCommit)
  ) {
    throw new Error("Coding run workspace metadata has an invalid shape");
  }
  return candidate as GitRunWorkspaceMetadata;
};

const assertRecoverableWorkspace = async (
  workspacePath: string,
  branchName: string,
): Promise<void> => {
  const topLevel = (await git(workspacePath, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(resolve(topLevel)) !== await realpath(workspacePath)) {
    throw new Error(`Stale coding workspace ${workspacePath} is not the expected Git worktree`);
  }
  const checkedOutBranch = (await git(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => "")).trim();
  if (checkedOutBranch !== branchName) {
    throw new Error(`Stale coding workspace ${workspacePath} is checked out on ${checkedOutBranch || "a detached HEAD"}`);
  }
};

/**
 * Creates a temporary checkout for one durable run branch. The primary
 * checkout may be dirty because the isolated worktree is created from the
 * committed HEAD. Uncommitted source-checkout edits never enter the agent
 * branch or its certified frontier; integration separately requires the
 * source checkout to be clean and unchanged.
 */
export const createGitRunWorkspace = async (input: {
  readonly repositoryRoot: string;
  readonly runId: string;
  /** Optional room-owned branch whose exact frontier becomes this run's base. */
  readonly baseBranch?: string;
  readonly expectedBaseCommit?: string;
}): Promise<GitRunWorkspace> => {
  const repositoryRoot = resolve(input.repositoryRoot);
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const topLevel = (await git(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(resolve(topLevel)) !== canonicalRepositoryRoot) {
    throw new Error("Coding workspace must be created from the repository root");
  }
  const sourceCheckoutDirty = Boolean((await git(repositoryRoot, [
    "status", "--porcelain=v1", "--untracked-files=all",
  ])).trim());
  const sourceBranch = (await git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => "")).trim();
  const baselineBranch = input.baseBranch?.trim() || sourceBranch;
  if (input.baseBranch) await git(repositoryRoot, ["check-ref-format", "--branch", baselineBranch]);
  const requestedBaselineCommit = input.expectedBaseCommit?.trim();
  if (requestedBaselineCommit && !COMMIT_PATTERN.test(requestedBaselineCommit)) {
    throw new Error("Coding run expected base commit is invalid");
  }
  const baselineCommit = (await git(repositoryRoot, [
    "rev-parse",
    baselineBranch ? `refs/heads/${baselineBranch}^{commit}` : "HEAD^{commit}",
  ])).trim();
  if (requestedBaselineCommit && baselineCommit !== requestedBaselineCommit) {
    throw new Error(`Coding room branch ${baselineBranch} moved before run placement`);
  }
  const paths = gitRunWorkspacePaths(repositoryRoot, input.runId);
  const branchName = gitRunBranchName(input.runId);
  await Promise.all([
    mkdir(join(paths.root, "checkouts"), { recursive: true }),
    mkdir(join(paths.root, "patches"), { recursive: true }),
    mkdir(join(paths.root, "metadata"), { recursive: true }),
  ]);
  await pruneRunPatches(paths.root);
  const existingMetadata = await readWorkspaceMetadata(paths.metadata);
  const existingBranch = await git(repositoryRoot, [
    "show-ref", "--verify", `refs/heads/${branchName}`,
  ]).then(() => true, () => false);
  const existingWorkspace = await exists(paths.workspace);

  if ((existingBranch || existingWorkspace) && !existingMetadata) {
    throw new Error(
      `Coding run ${input.runId} has Git state without trusted recovery metadata; remove ${branchName} and ${paths.workspace} manually after inspection`,
    );
  }

  if (existingMetadata) {
    if (
      existingMetadata.runId !== input.runId
      || existingMetadata.branchName !== branchName
      || await realpath(existingMetadata.repositoryRoot).catch(() => undefined) !== canonicalRepositoryRoot
    ) {
      throw new Error(`Coding run ${input.runId} recovery metadata does not match this repository and branch`);
    }
    if (existingMetadata.baselineBranch !== (baselineBranch || undefined)) {
      throw new Error(
        `Coding run ${input.runId} started from ${existingMetadata.baselineBranch ?? "a detached HEAD"}; its base placement changed before recovery`,
      );
    }
    if (requestedBaselineCommit && existingMetadata.baselineCommit !== requestedBaselineCommit) {
      throw new Error(`Coding run ${input.runId} recovery frontier does not match the room branch`);
    }
    await git(repositoryRoot, ["cat-file", "-e", `${existingMetadata.baselineCommit}^{commit}`]);

    if (existingWorkspace) {
      await assertRecoverableWorkspace(paths.workspace, branchName);
      const workspaceHead = (await git(paths.workspace, ["rev-parse", "HEAD"])).trim();
      if (workspaceHead !== existingMetadata.baselineCommit) {
        throw new Error(
          `Coding run branch ${branchName} advanced outside the recoverable pre-commit boundary; inspect its retained patch manually`,
        );
      }
    } else if (existingBranch) {
      const branchHead = (await git(repositoryRoot, ["rev-parse", branchName])).trim();
      if (branchHead !== existingMetadata.baselineCommit) {
        throw new Error(
          `Coding run branch ${branchName} advanced outside the recoverable pre-commit boundary; inspect its retained patch manually`,
        );
      }
      await git(repositoryRoot, ["worktree", "prune"]).catch(() => undefined);
      await git(repositoryRoot, ["worktree", "add", paths.workspace, branchName]);
    } else {
      await git(repositoryRoot, [
        "worktree", "add", "-b", branchName, paths.workspace, existingMetadata.baselineCommit,
      ]);
    }

    return {
      runId: input.runId,
      repositoryRoot,
      workingDirectory: paths.workspace,
      patchPath: paths.patch,
      branchName,
      ...(existingMetadata.baselineBranch ? { baselineBranch: existingMetadata.baselineBranch } : {}),
      baselineCommit: existingMetadata.baselineCommit,
      sourceCheckoutDirty,
    };
  }

  const metadata: GitRunWorkspaceMetadata = {
    schema: "roster.git-run-workspace.v1",
    runId: input.runId,
    repositoryRoot: canonicalRepositoryRoot,
    branchName,
    ...(baselineBranch ? { baselineBranch } : {}),
    baselineCommit,
  };
  await writeWorkspaceMetadata(paths.metadata, metadata);
  await rm(paths.patch, { force: true });

  let branchCreated = false;
  try {
    await git(repositoryRoot, ["worktree", "add", "-b", branchName, paths.workspace, baselineCommit]);
    branchCreated = true;
    return {
      runId: input.runId,
      repositoryRoot,
      workingDirectory: paths.workspace,
      patchPath: paths.patch,
      branchName,
      ...(baselineBranch ? { baselineBranch } : {}),
      baselineCommit,
      sourceCheckoutDirty,
    };
  } catch (error) {
    await git(repositoryRoot, ["worktree", "remove", "--force", paths.workspace]).catch(() => undefined);
    await rm(paths.workspace, { recursive: true, force: true });
    if (branchCreated) {
      await git(repositoryRoot, ["branch", "-D", branchName]).catch(() => undefined);
    }
    await rm(paths.metadata, { force: true });
    throw error;
  }
};

const installDependencies: DependencyInstaller = async (input) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(
    `Coding workspace dependency installation timed out after ${input.timeoutMs}ms`,
  )), input.timeoutMs);
  timeout.unref();
  try {
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const result = await runCommand({
      command: input.command,
      args: input.args,
      stdin: "",
      cwd: input.cwd,
      signal,
      maxOutputBytes: MAX_DEPENDENCY_INSTALL_OUTPUT_BYTES,
      maxCaptureBytes: MAX_DEPENDENCY_INSTALL_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "unknown package-manager error").trim().slice(0, 4_000);
      throw new Error(detail);
    }
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000);
    throw new Error(`Coding workspace dependency installation failed: ${detail || "unknown package-manager error"}`);
  } finally {
    clearTimeout(timeout);
  }
};

const cleanGeneratedDependencyTrees = async (
  workspace: GitRunWorkspace,
): Promise<void> => {
  const trackedPaths = (await git(workspace.workingDirectory, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
  const dependencyDirectories = new Set(trackedPaths.flatMap((path) => {
    const directory = dirname(path);
    if (path === "package-lock.json" || path.endsWith("/package-lock.json")) {
      return [directory === "." ? "node_modules" : `${directory}/node_modules`];
    }
    if (path === "uv.lock" || path.endsWith("/uv.lock")) {
      return [directory === "." ? ".venv" : `${directory}/.venv`];
    }
    return [];
  }));
  for (const directory of dependencyDirectories) {
    if (!await exists(join(workspace.workingDirectory, directory))) continue;
    const baselineEntries = (await git(workspace.workingDirectory, [
      "ls-tree", "-r", "--name-only", workspace.baselineCommit, "--", directory,
    ])).trim();
    if (!baselineEntries) {
      // A coding worker may have staged the install tree while computing its
      // own frontier. Restore the trusted baseline index first so `git clean`
      // can still recognize those files as generated and untracked.
      await git(workspace.workingDirectory, [
        "reset", "--quiet", workspace.baselineCommit, "--", directory,
      ]);
    }
    // The isolated checkout starts from committed HEAD. These untracked and
    // ignored trees are therefore runtime placement created by the recognized
    // installer, never part of the authored Git frontier. Baseline-tracked
    // dependency trees are not reset, and `git clean` retains their files.
    await git(workspace.workingDirectory, [
      "clean", "-fdx", "-q", "--", directory,
    ]);
  }
};

/**
 * Materializes dependencies inside the isolated checkout. Commands come from
 * a current typed execution profile or deterministic lockfile detection;
 * repository prose never becomes executable input.
 */
export const prepareGitRunWorkspaceDependencies = async (
  workspace: GitRunWorkspace,
  options: {
    readonly installer?: DependencyInstaller;
    readonly timeoutMs?: number;
    readonly executionProfile?: RepositoryExecutionProfile;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> => {
  if (options.executionProfile) {
    await assertRepositoryExecutionProfileEvidence(workspace.workingDirectory, options.executionProfile);
  }
  const commands = options.executionProfile
    ? repositoryExecutionProfileCommands(options.executionProfile, "install")
    : repositoryToolchainCommands(await inspectRepositoryToolchains(workspace.workingDirectory), "install");
  const installer = options.installer ?? installDependencies;
  for (const command of commands) {
    await installer({
      ...command,
      cwd: repositoryToolchainCommandCwd(workspace.workingDirectory, command),
      timeoutMs: Math.max(1_000, Math.min(
        options.timeoutMs ?? DEFAULT_DEPENDENCY_INSTALL_TIMEOUT_MS,
        15 * 60_000,
      )),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
};

/**
 * Stages every bounded run change and freezes the exact index tree reviewed by
 * Roster. The patch is overwritten atomically even when empty so a reverted
 * recovery cannot expose an older delta.
 */
const captureGitRunIndex = async (workspace: GitRunWorkspace): Promise<GitRunPreparedCommit> => {
  await cleanGeneratedDependencyTrees(workspace);
  await git(workspace.workingDirectory, ["add", "-A", "--", "."]);
  const patch = await git(workspace.workingDirectory, [
    "--no-pager", "diff", "--cached", "--binary", "--full-index", workspace.baselineCommit, "--",
  ]);
  const tree = (await git(workspace.workingDirectory, ["write-tree"])).trim();
  await writeAtomicFile(workspace.patchPath, patch);
  return {
    patch,
    patchHash: createHash("sha256").update(patch).digest("hex"),
    tree,
  };
};

/** Captures tracked, deleted, and previously untracked run changes in one patch. */
export const captureGitRunPatch = async (workspace: GitRunWorkspace): Promise<string> =>
  (await captureGitRunIndex(workspace)).patch;

export const prepareGitRunCommit = async (
  workspace: GitRunWorkspace,
): Promise<GitRunPreparedCommit> => {
  await cleanGeneratedDependencyTrees(workspace);
  await assertRecoverableWorkspace(workspace.workingDirectory, workspace.branchName);
  const head = (await git(workspace.workingDirectory, ["rev-parse", "HEAD"])).trim();
  if (head !== workspace.baselineCommit) {
    throw new Error(
      `Coding run branch ${workspace.branchName} contains a commit that was not certified by Roster`,
    );
  }
  return captureGitRunIndex(workspace);
};

/** Commits the certified delta to the run branch without touching the caller's branch. */
export const commitGitRunBranch = async (
  workspace: GitRunWorkspace,
  message = `Roster coding run ${workspace.runId}`,
  prepared?: GitRunPreparedCommit,
): Promise<GitRunCommitOutcome> => {
  const snapshot = prepared ?? await prepareGitRunCommit(workspace);
  const frozenPatch = await git(workspace.workingDirectory, [
    "--no-pager", "diff", "--binary", "--full-index", workspace.baselineCommit, snapshot.tree, "--",
  ]);
  const frozenPatchHash = createHash("sha256").update(frozenPatch).digest("hex");
  if (frozenPatch !== snapshot.patch || frozenPatchHash !== snapshot.patchHash) {
    throw new Error("Coding run prepared frontier does not match its immutable Git tree");
  }
  await assertRecoverableWorkspace(workspace.workingDirectory, workspace.branchName);
  const head = (await git(workspace.workingDirectory, ["rev-parse", "HEAD"])).trim();
  if (head !== workspace.baselineCommit) {
    throw new Error(
      `Coding run branch ${workspace.branchName} contains a commit that was not certified by Roster`,
    );
  }
  const branchHead = (await git(workspace.repositoryRoot, [
    "rev-parse", `refs/heads/${workspace.branchName}^{commit}`,
  ])).trim();
  if (branchHead !== workspace.baselineCommit) {
    throw new Error(`Coding run branch ${workspace.branchName} moved before Roster certification`);
  }
  if (!snapshot.patch) return { commit: head, outcome: "no_changes", noChanges: true };
  const subject = message.trim().replace(/\s+/g, " ").slice(0, 120)
    || `Roster coding run ${workspace.runId}`;
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: "Roster Runtime",
    GIT_AUTHOR_EMAIL: "roster-runtime@localhost",
    GIT_COMMITTER_NAME: "Roster Runtime",
    GIT_COMMITTER_EMAIL: "roster-runtime@localhost",
  };
  const commit = (await git(workspace.workingDirectory, [
    "commit-tree", snapshot.tree, "-p", workspace.baselineCommit, "-m", subject,
  ], identity)).trim();
  // Revalidate placement, then advance only the exact run ref with a
  // compare-and-swap. A detached/substituted HEAD can never receive the
  // certified commit, and a concurrent ref move fails instead of being lost.
  await assertRecoverableWorkspace(workspace.workingDirectory, workspace.branchName);
  await git(workspace.repositoryRoot, [
    "update-ref",
    `refs/heads/${workspace.branchName}`,
    commit,
    workspace.baselineCommit,
  ]);
  return {
    commit,
    outcome: "committed",
    noChanges: false,
  };
};

export const disposeGitRunWorkspace = async (
  workspace: GitRunWorkspace,
  options: { readonly keepBranch?: boolean } = {},
): Promise<void> => {
  await git(workspace.repositoryRoot, ["worktree", "remove", "--force", workspace.workingDirectory])
    .catch(() => undefined);
  await rm(workspace.workingDirectory, { recursive: true, force: true });
  await git(workspace.repositoryRoot, ["worktree", "prune"]).catch(() => undefined);
  if (options.keepBranch === false) {
    await git(workspace.repositoryRoot, ["branch", "-D", workspace.branchName]).catch(() => undefined);
    await rm(gitRunWorkspacePaths(workspace.repositoryRoot, workspace.runId).metadata, { force: true });
  }
};

export const readGitRunPatch = async (
  repositoryRoot: string,
  runId: string,
): Promise<string | undefined> => {
  const path = gitRunWorkspacePaths(repositoryRoot, runId).patch;
  return await exists(path) ? readFile(path, "utf8") : undefined;
};

export const gitRunWorkspaceExists = async (
  repositoryRoot: string,
  runId: string,
): Promise<boolean> => exists(gitRunWorkspacePaths(repositoryRoot, runId).workspace);

export const gitRunBranchExists = async (
  repositoryRoot: string,
  runId: string,
): Promise<boolean> => git(repositoryRoot, [
  "show-ref", "--verify", `refs/heads/${gitRunBranchName(runId)}`,
]).then(() => true, () => false);

export const gitBranchExists = async (
  repositoryRoot: string,
  branchName: string,
): Promise<boolean> => {
  await git(repositoryRoot, ["check-ref-format", "--branch", branchName]);
  return git(repositoryRoot, [
    "show-ref", "--verify", `refs/heads/${branchName}`,
  ]).then(() => true, () => false);
};

const gitCommitIsAncestor = async (
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> => execFileAsync("git", [
  "merge-base", "--is-ancestor", ancestor, descendant,
], {
  cwd: repositoryRoot,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  maxBuffer: MAX_GIT_OUTPUT_BYTES,
}).then(() => true, () => false);

/**
 * Projects whether a certified run commit can be safely fast-forwarded into
 * the operator's current branch. This is derived Git state, not orchestration
 * authority: the exact commit still comes from the completed job result.
 */
export const gitRunIntegrationStatus = async (input: {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly expectedCommit: string;
  readonly baselineBranch: string;
  readonly baselineCommit: string;
  /** Defaults to the temporary run branch; room-backed runs supply their room branch. */
  readonly branchName?: string;
}): Promise<GitRunIntegrationStatus> => {
  if (!COMMIT_PATTERN.test(input.expectedCommit) || !COMMIT_PATTERN.test(input.baselineCommit)) {
    throw new Error("Coding run has an invalid certified commit");
  }
  const repositoryRoot = resolve(input.repositoryRoot);
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const topLevel = (await git(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(resolve(topLevel)) !== canonicalRepositoryRoot) {
    throw new Error("Coding run integration must be performed from the repository root");
  }
  const branchName = input.branchName ?? gitRunBranchName(input.runId);
  await git(repositoryRoot, ["check-ref-format", "--branch", branchName]);
  const currentBranchValue = (await git(repositoryRoot, ["branch", "--show-current"])).trim();
  const currentBranch = currentBranchValue || undefined;
  const currentCommit = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  const targetCommit = await git(repositoryRoot, [
    "rev-parse", `refs/heads/${input.baselineBranch}^{commit}`,
  ]).then((value) => value.trim(), () => undefined);
  const alreadyIntegrated = targetCommit !== undefined && (
    targetCommit === input.expectedCommit
    || await gitCommitIsAncestor(repositoryRoot, input.expectedCommit, targetCommit)
  );
  const branchCommit = await git(repositoryRoot, ["rev-parse", `refs/heads/${branchName}^{commit}`])
    .then((value) => value.trim(), () => undefined);
  const base = {
    runId: input.runId,
    branchName,
    commit: input.expectedCommit,
    ...(currentBranch ? { currentBranch } : {}),
  };
  if (alreadyIntegrated) {
    return { ...base, integrated: true, canIntegrate: false };
  }
  if (!branchCommit) {
    return { ...base, integrated: false, canIntegrate: false, reason: `Run branch ${branchName} no longer exists.` };
  }
  if (branchCommit !== input.expectedCommit) {
    return {
      ...base,
      integrated: false,
      canIntegrate: false,
      reason: `Run branch ${branchName} no longer points at its certified commit.`,
    };
  }
  if (!targetCommit) {
    return {
      ...base,
      integrated: false,
      canIntegrate: false,
      reason: `Delivery target ${input.baselineBranch} no longer exists.`,
    };
  }
  if (currentBranch !== input.baselineBranch) {
    return {
      ...base,
      integrated: false,
      canIntegrate: false,
      reason: `Check out ${input.baselineBranch} before applying this run.`,
    };
  }
  const status = (await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).trim();
  if (status) {
    return {
      ...base,
      integrated: false,
      canIntegrate: false,
      reason: "Commit or stash current repository changes before applying this run.",
    };
  }
  if (!await gitCommitIsAncestor(repositoryRoot, input.baselineCommit, targetCommit)
    || !await gitCommitIsAncestor(repositoryRoot, targetCommit, input.expectedCommit)) {
    return {
      ...base,
      integrated: false,
      canIntegrate: false,
      reason: `Branch ${currentBranch} moved after this run started and diverged from the certified room frontier. Rebase ${branchName} and certify it again.`,
    };
  }
  if (currentCommit !== targetCommit) {
    return { ...base, integrated: false, canIntegrate: false, reason: `Working tree ${currentBranch} is not at its branch ref.` };
  }
  if (!await gitCommitIsAncestor(repositoryRoot, input.baselineCommit, input.expectedCommit)) {
    return { ...base, integrated: false, canIntegrate: false, reason: "The certified commit is not based on the recorded target." };
  }
  return { ...base, integrated: false, canIntegrate: true };
};

const removeIntegratedRunBranch = async (input: {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly branchName: string;
  readonly expectedCommit: string;
  readonly currentBranch?: string;
}): Promise<void> => {
  if (input.currentBranch === input.branchName) return;
  const repositoryRoot = resolve(input.repositoryRoot);
  const branchCommit = await git(repositoryRoot, [
    "rev-parse", `refs/heads/${input.branchName}^{commit}`,
  ]).then((value) => value.trim(), () => undefined);
  if (branchCommit !== input.expectedCommit) return;
  await git(repositoryRoot, ["branch", "-D", input.branchName]);
  await rm(gitRunWorkspacePaths(repositoryRoot, input.runId).metadata, { force: true });
};

/** Fast-forwards the exact recorded target ref to one certified run commit. */
export const integrateGitRunBranch = async (input: {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly expectedCommit: string;
  readonly baselineBranch: string;
  readonly baselineCommit: string;
  readonly branchName?: string;
  /** Room branches survive delivery so later room turns keep the same frontier. */
  readonly keepBranch?: boolean;
}): Promise<GitRunIntegrationStatus> => {
  const status = await gitRunIntegrationStatus(input);
  if (status.integrated) {
    if (!input.keepBranch) {
      await removeIntegratedRunBranch({
        ...input,
        branchName: status.branchName,
        currentBranch: status.currentBranch,
      });
    }
    return { ...status, alreadyIntegrated: true };
  }
  if (!status.canIntegrate) throw new Error(status.reason ?? "Coding run cannot be applied safely");
  const repositoryRoot = resolve(input.repositoryRoot);
  const targetRef = `refs/heads/${input.baselineBranch}`;
  const targetCommit = (await git(repositoryRoot, ["rev-parse", `${targetRef}^{commit}`])).trim();
  // Update the named target with an exact-old-value CAS. Unlike `git merge`,
  // this cannot advance a different branch if another process changes HEAD
  // between validation and mutation.
  await git(repositoryRoot, [
    "update-ref", targetRef, input.expectedCommit, targetCommit,
  ]);
  const checkedOutBranch = (await git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => "")).trim();
  if (checkedOutBranch === input.baselineBranch) {
    // `update-ref` intentionally does not touch the index or worktree. This
    // plumbing operation updates them to the explicit certified tree without
    // moving whichever branch HEAD may refer to.
    await git(repositoryRoot, ["read-tree", "--reset", "-u", input.expectedCommit]);
  }
  const integrated = await gitRunIntegrationStatus(input);
  if (!integrated.integrated) throw new Error("Git fast-forward completed without reaching the certified commit");
  if (!input.keepBranch) {
    await removeIntegratedRunBranch({
      ...input,
      branchName: status.branchName,
      currentBranch: integrated.currentBranch,
    });
  }
  return { ...integrated, alreadyIntegrated: false };
};
