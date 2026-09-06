import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceGitRoomBranch,
  captureGitRunPatch,
  commitGitRunBranch,
  createGitRunWorkspace,
  disposeGitRunWorkspace,
  ensureGitRoomBranch,
  gitRunBranchExists,
  gitRunDetachedSourceIntegrationStatus,
  gitRunIntegrationStatus,
  gitRoomBranchName,
  gitRunWorkspacePaths,
  integrateGitRunBranch,
  prepareGitRunCommit,
  prepareGitRunWorkspaceDependencies,
  readGitRunPatch,
} from "../../src/engine/runtime/git-run-workspace.ts";
import {
  prepareCodingAgentGitRun,
  type CodingAgentExecutionResult,
} from "../../src/domains/coding.ts";
import {
  compileRepositoryExecutionProfile,
  repositoryExecutionProfileEvidenceHash,
} from "../../src/engine/runtime/repository-toolchain.ts";
import { createCodexCliNodeRuntimeAdapter } from "../../src/engine/runtime/agent-cli-node-runtime.ts";
import { NodeRuntimeRegistry } from "../../src/engine/runtime/node-runtime.ts";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const result = await execFileAsync("git", [...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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

test("Git coding runs branch from a detached source HEAD without mutating the source checkout", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-detached-source-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Fixture\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    await git(repositoryRoot, ["switch", "--detach"]);
    const sourceHead = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "detached-source" });
    try {
      assert.equal(workspace.baselineBranch, undefined);
      assert.equal(workspace.baselineCommit, sourceHead);
      assert.equal((await git(repositoryRoot, ["branch", "--show-current"])).trim(), "");
      assert.equal((await git(repositoryRoot, ["rev-parse", "HEAD"])).trim(), sourceHead);
      assert.equal(
        (await git(workspace.workingDirectory, ["branch", "--show-current"])).trim(),
        workspace.branchName,
      );
      assert.equal(await gitRunBranchExists(repositoryRoot, "detached-source"), true);
      assert.deepEqual(gitRunDetachedSourceIntegrationStatus({
        runId: workspace.runId,
        expectedCommit: sourceHead,
        baselineBranch: workspace.baselineBranch,
      }), {
        runId: workspace.runId,
        branchName: workspace.branchName,
        commit: sourceHead,
        integrated: false,
        canIntegrate: false,
        reason: `This room started from a detached HEAD, so it has no delivery target. Work remains preserved on ${workspace.branchName}; attach or create a target branch when you are ready to deliver the room frontier.`,
      });
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("room-owned branches preserve a certified frontier across isolated agent runs", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-room-branch-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Room\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    const sourceCommit = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const sourceBranch = (await git(repositoryRoot, ["branch", "--show-current"])).trim();
    const room = await ensureGitRoomBranch({ repositoryRoot, roomId: "room-one" });
    assert.equal(room.created, true);
    assert.equal(room.branchName, gitRoomBranchName("room-one"));
    assert.equal(room.commit, sourceCommit);
    assert.equal(room.targetBranch, sourceBranch);
    assert.equal(room.targetCommit, sourceCommit);

    const run = await createGitRunWorkspace({
      repositoryRoot,
      runId: "room-run-one",
      baseBranch: room.branchName,
      expectedBaseCommit: room.commit,
    });
    await writeFile(join(run.workingDirectory, "room-result.md"), "certified room delta\n");
    const certifiedCommit = (await commitGitRunBranch(run)).commit;
    await advanceGitRoomBranch({
      repositoryRoot,
      roomId: room.roomId,
      expectedCommit: room.commit,
      certifiedCommit,
    });
    await disposeGitRunWorkspace(run, { keepBranch: false });

    assert.equal((await git(repositoryRoot, ["rev-parse", "HEAD"])).trim(), sourceCommit);
    assert.equal(await exists(join(repositoryRoot, "room-result.md")), false);
    assert.equal(
      (await git(repositoryRoot, ["rev-parse", `refs/heads/${room.branchName}`])).trim(),
      certifiedCommit,
    );
    const recovered = await ensureGitRoomBranch({
      repositoryRoot,
      roomId: room.roomId,
      recorded: {
        branchName: room.branchName,
        commit: certifiedCommit,
        targetBranch: room.targetBranch,
        targetCommit: room.targetCommit,
      },
    });
    assert.equal(recovered.created, false);

    const nextRun = await createGitRunWorkspace({
      repositoryRoot,
      runId: "room-run-two",
      baseBranch: room.branchName,
      expectedBaseCommit: certifiedCommit,
    });
    assert.equal(await exists(join(nextRun.workingDirectory, "room-result.md")), true);
    await disposeGitRunWorkspace(nextRun, { keepBranch: false });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("room-owned branches start from detached HEAD without inventing a delivery target", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-detached-room-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Detached room\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    await git(repositoryRoot, ["switch", "--detach"]);
    const room = await ensureGitRoomBranch({ repositoryRoot, roomId: "detached-room" });
    assert.equal(room.branchName, gitRoomBranchName("detached-room"));
    assert.equal(room.targetBranch, undefined);
    assert.equal(room.targetCommit, undefined);
    assert.equal((await git(repositoryRoot, ["branch", "--show-current"])).trim(), "");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("room delivery fast-forwards a target repeatedly while keeping the room branch", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-room-delivery-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Delivery\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    const room = await ensureGitRoomBranch({ repositoryRoot, roomId: "delivery-room" });
    assert.ok(room.targetBranch && room.targetCommit);
    let frontier = room.commit;
    for (const [index, filename] of ["first.md", "second.md"].entries()) {
      const runId = `delivery-run-${index + 1}`;
      const run = await createGitRunWorkspace({
        repositoryRoot,
        runId,
        baseBranch: room.branchName,
        expectedBaseCommit: frontier,
      });
      await writeFile(join(run.workingDirectory, filename), `${index + 1}\n`);
      const certifiedCommit = (await commitGitRunBranch(run)).commit;
      await advanceGitRoomBranch({
        repositoryRoot,
        roomId: room.roomId,
        expectedCommit: frontier,
        certifiedCommit,
      });
      await disposeGitRunWorkspace(run, { keepBranch: false });
      frontier = certifiedCommit;
      const delivery = {
        repositoryRoot,
        runId,
        expectedCommit: certifiedCommit,
        baselineBranch: room.targetBranch,
        baselineCommit: room.targetCommit,
        branchName: room.branchName,
        keepBranch: true,
      };
      assert.equal((await gitRunIntegrationStatus(delivery)).canIntegrate, true);
      assert.equal((await integrateGitRunBranch(delivery)).integrated, true);
      assert.equal(await gitRunBranchExists(repositoryRoot, runId), false);
      assert.equal(
        (await git(repositoryRoot, ["rev-parse", `refs/heads/${room.branchName}`])).trim(),
        certifiedCommit,
      );
    }
    assert.equal(await exists(join(repositoryRoot, "first.md")), true);
    assert.equal(await exists(join(repositoryRoot, "second.md")), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("concurrent CLI workers stage linked-worktree frontiers in private Git indexes and object stores", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-private-git-plane-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Fixture\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    const workspace = await createGitRunWorkspace({
      repositoryRoot,
      runId: "private-git-plane",
    });
    try {
      await writeFile(join(workspace.workingDirectory, "worker-delta.md"), "bounded delta\n");
      assert.equal((await git(
        workspace.workingDirectory,
        ["diff", "--cached", "--name-only"],
      )).trim(), "");
      const commonDirectoryOutput = (
        await git(workspace.workingDirectory, ["rev-parse", "--git-common-dir"])
      ).trim();
      const commonObjectDirectory = join(
        resolve(workspace.workingDirectory, commonDirectoryOutput),
        "objects",
      );
      const taskGitPlanes: Array<{
        readonly indexFile: string;
        readonly objectDirectory: string;
        readonly alternates: string;
        readonly tree: string;
      }> = [];
      const runtimes = new NodeRuntimeRegistry([
        createCodexCliNodeRuntimeAdapter({
          runner: async (execution) => {
            assert.equal(execution.cwd, workspace.workingDirectory);
            const indexFile = execution.env?.GIT_INDEX_FILE;
            const objectDirectory = execution.env?.GIT_OBJECT_DIRECTORY;
            const alternates = execution.env?.GIT_ALTERNATE_OBJECT_DIRECTORIES;
            assert.ok(indexFile);
            assert.ok(objectDirectory);
            assert.ok(alternates);
            assert.equal(await stat(objectDirectory).then((entry) => entry.isDirectory()), true);
            assert.match(alternates, new RegExp(commonObjectDirectory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
            const taskEnvironment = { ...process.env, ...execution.env };
            await execFileAsync("git", ["add", "-A", "--", "."], {
              cwd: execution.cwd,
              env: taskEnvironment,
            });
            const tree = String((await execFileAsync("git", ["write-tree"], {
              cwd: execution.cwd,
              env: taskEnvironment,
            })).stdout).trim();
            assert.match(
              String((await execFileAsync("git", ["ls-tree", "--name-only", tree], {
                cwd: execution.cwd,
                env: taskEnvironment,
              })).stdout),
              /worker-delta\.md/u,
            );
            taskGitPlanes.push({ indexFile, objectDirectory, alternates, tree });
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: "done" },
              }),
              stderr: "",
            };
          },
        }),
      ]);
      const executeWorker = (taskId: string) => runtimes.execute({
        runId: "private-git-plane",
        node: {
          id: "implementer",
          name: "Implementer",
          capabilities: ["implement"],
          runtime: {
            kind: "codex-cli",
            metadata: {
              workingDirectory: workspace.workingDirectory,
              sandbox: "workspace-write",
            },
          },
        },
        task: {
          taskId,
          nodeId: "implementer",
          capability: "implement",
        },
        input: { objective: "Hash the shared task frontier." },
        resultContract: { mode: "text", outputKey: "result" },
        execute: async () => "native",
      });
      await Promise.all([executeWorker("worker-a"), executeWorker("worker-b")]);

      assert.equal(taskGitPlanes.length, 2);
      assert.notEqual(taskGitPlanes[0]?.indexFile, taskGitPlanes[1]?.indexFile);
      assert.notEqual(taskGitPlanes[0]?.objectDirectory, taskGitPlanes[1]?.objectDirectory);
      assert.equal(taskGitPlanes[0]?.tree, taskGitPlanes[1]?.tree);
      assert.equal((await git(
        workspace.workingDirectory,
        ["diff", "--cached", "--name-only"],
      )).trim(), "");
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("read-only certification transports a mutation frontier across distinct private Git indexes", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-private-frontier-transport-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Fixture\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    const workspace = await createGitRunWorkspace({
      repositoryRoot,
      runId: "private-frontier-transport",
    });
    try {
      await writeFile(join(workspace.workingDirectory, "result.md"), "reviewed delta\n");
      const privateIndexes: string[] = [];
      let mutationFrontierHash = "";
      const runtimes = new NodeRuntimeRegistry([
        createCodexCliNodeRuntimeAdapter({
          runner: async (execution) => {
            const indexFile = execution.env?.GIT_INDEX_FILE;
            assert.ok(indexFile);
            privateIndexes.push(indexFile);
            const taskEnvironment = { ...process.env, ...execution.env };
            if (privateIndexes.length === 1) {
              await execFileAsync("git", ["add", "-A", "--", "."], {
                cwd: workspace.workingDirectory,
                env: taskEnvironment,
              });
              const patch = String((await execFileAsync("git", [
                "--no-pager", "diff", "--cached", "--binary", "--full-index", "HEAD", "--",
              ], {
                cwd: workspace.workingDirectory,
                env: taskEnvironment,
              })).stdout);
              mutationFrontierHash = createHash("sha256").update(patch).digest("hex");
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  type: "item.completed",
                  item: {
                    type: "agent_message",
                    text: JSON.stringify({
                      final_report: { status: "verified", frontierHash: mutationFrontierHash },
                    }),
                  },
                }),
                stderr: "",
              };
            }
            assert.notEqual(indexFile, privateIndexes[0]);
            assert.equal(String((await execFileAsync("git", [
              "diff", "--cached", "--name-only",
            ], {
              cwd: workspace.workingDirectory,
              env: taskEnvironment,
            })).stdout).trim(), "");
            assert.match(execution.stdin, new RegExp(mutationFrontierHash));
            assert.match(execution.stdin, /Do not run `git add`/);
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                type: "item.completed",
                item: {
                  type: "agent_message",
                  text: JSON.stringify({
                    endorsement: {
                      verdict: "approve",
                      frontierHash: mutationFrontierHash,
                      summary: "The read-only worktree delta is correct.",
                      evidence: ["result.md"],
                    },
                  }),
                },
              }),
              stderr: "",
            };
          },
        }),
      ]);
      const mutation = await runtimes.execute<{
        readonly final_report: { readonly status: string; readonly frontierHash: string };
      }>({
        runId: "private-frontier-transport",
        node: {
          id: "implementation",
          name: "Implementation",
          capabilities: ["implement"],
          runtime: {
            kind: "codex-cli",
            metadata: {
              workingDirectory: workspace.workingDirectory,
              sandbox: "workspace-write",
            },
          },
        },
        task: {
          taskId: "remediate",
          nodeId: "implementation",
          capability: "implement",
          objective: "Stage and identify the mutation frontier.",
        },
        input: { request: "Produce the reviewed delta." },
        resultContract: {
          mode: "json",
          outputKey: "final_report",
          schema: { type: "object", required: ["final_report"] },
        },
        execute: async () => ({ final_report: { status: "unexpected", frontierHash: "" } }),
      });
      const certification = await runtimes.execute<{
        readonly endorsement: {
          readonly verdict: string;
          readonly frontierHash: string;
        };
      }>({
        runId: "private-frontier-transport",
        node: {
          id: "quality",
          name: "Quality",
          capabilities: ["certify"],
          runtime: {
            kind: "codex-cli",
            metadata: {
              workingDirectory: workspace.workingDirectory,
              sandbox: "read-only",
            },
          },
        },
        task: {
          taskId: "certify-quality",
          nodeId: "quality",
          capability: "certify",
          objective: [
            "Review the actual worktree delta with read-only commands.",
            "Use final_report.frontierHash as the candidate frontier identifier.",
            "Do not run `git add` or derive the identifier from this execution's private index.",
          ].join(" "),
        },
        input: { final_report: mutation.final_report },
        resultContract: {
          mode: "json",
          outputKey: "endorsement",
          schema: { type: "object", required: ["endorsement"] },
        },
        execute: async () => ({
          endorsement: { verdict: "unexpected", frontierHash: "" },
        }),
      });

      assert.equal(privateIndexes.length, 2);
      assert.notEqual(privateIndexes[0], privateIndexes[1]);
      assert.equal(certification.endorsement.verdict, "approve");
      assert.equal(certification.endorsement.frontierHash, mutation.final_report.frontierHash);
      assert.equal((await git(
        workspace.workingDirectory,
        ["diff", "--cached", "--name-only"],
      )).trim(), "");
      assert.match(await git(
        workspace.workingDirectory,
        ["status", "--short"],
      ), /\?\? result\.md/u);
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("CLI Git isolation fails closed when a discovered repository cannot be prepared", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "roster-private-git-failure-"));
  let launches = 0;
  const executeAt = async (workingDirectory: string, taskId: string) => {
    const runtimes = new NodeRuntimeRegistry([
      createCodexCliNodeRuntimeAdapter({
        runner: async () => {
          launches += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "unexpected" },
            }),
            stderr: "",
          };
        },
      }),
    ]);
    return runtimes.execute({
      runId: "private-git-failure",
      node: {
        id: "implementer",
        name: "Implementer",
        capabilities: ["implement"],
        runtime: {
          kind: "codex-cli",
          metadata: { workingDirectory, sandbox: "workspace-write" },
        },
      },
      task: { taskId, nodeId: "implementer", capability: "implement" },
      resultContract: { mode: "text", outputKey: "result" },
      execute: async () => "native",
    });
  };
  try {
    const brokenRepository = join(fixtureRoot, "broken");
    const brokenSubdirectory = join(brokenRepository, "packages", "app");
    await mkdir(brokenSubdirectory, { recursive: true });
    await writeFile(
      join(brokenRepository, ".git"),
      "gitdir: /definitely/missing/roster-git-admin\n",
    );
    await assert.rejects(
      executeAt(brokenSubdirectory, "broken-probe"),
      /Cannot resolve Git administration/u,
    );

    const unbornRepository = join(fixtureRoot, "unborn");
    const unbornSubdirectory = join(unbornRepository, "packages", "app");
    await mkdir(unbornSubdirectory, { recursive: true });
    await git(unbornRepository, ["init"]);
    await assert.rejects(
      executeAt(unbornSubdirectory, "unborn-index"),
      /Cannot initialize private Git index/u,
    );
    assert.equal(launches, 0);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Git coding workspaces install lockfile-pinned npm dependencies inside the isolated checkout", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-dependencies-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await writeFile(join(repositoryRoot, "package-lock.json"), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n');
    await git(repositoryRoot, ["add", "package.json", "package-lock.json"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-dependencies" });
    try {
      let received: {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly timeoutMs: number;
      } | undefined;
      await prepareGitRunWorkspaceDependencies(workspace, {
        timeoutMs: 12_000,
        installer: async (input) => { received = input; },
      });
      assert.equal(received?.command, process.platform === "win32" ? "npm.cmd" : "npm");
      assert.deepEqual(received?.args, ["ci", "--prefer-offline", "--no-audit", "--no-fund"]);
      assert.equal(received?.cwd, workspace.workingDirectory);
      assert.equal(received?.timeoutMs, 12_000);
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding dependency setup propagates cancellation into the installer", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-dependency-cancel-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await writeFile(join(repositoryRoot, "package-lock.json"), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n');
    await git(repositoryRoot, ["add", "package.json", "package-lock.json"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-dependency-cancel" });
    const controller = new AbortController();
    controller.abort(new Error("dependency setup canceled"));
    try {
      await assert.rejects(
        prepareGitRunWorkspaceDependencies(workspace, {
          signal: controller.signal,
          installer: async ({ signal }) => {
            assert.equal(signal, controller.signal);
            throw signal?.reason;
          },
        }),
        /dependency setup canceled/,
      );
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding handoff removes installer-owned dependency trees before freezing the frontier", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-dependency-frontier-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Fixture\n");
    await writeFile(join(repositoryRoot, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    await writeFile(join(repositoryRoot, "package-lock.json"), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n');
    await git(repositoryRoot, ["add", "README.md", "package.json", "package-lock.json"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const workspace = await createGitRunWorkspace({
      repositoryRoot,
      runId: "coding-dependency-frontier",
    });
    try {
      await prepareGitRunWorkspaceDependencies(workspace, {
        installer: async ({ cwd }) => {
          await mkdir(join(cwd, "node_modules", "fixture"), { recursive: true });
          await writeFile(join(cwd, "node_modules", "fixture", "index.js"), "generated\n");
        },
      });
      await writeFile(join(workspace.workingDirectory, "README.md"), "# Fixture\n\nImproved.\n");
      // Workers may stage their own frontier before returning. Roster must
      // still remove installer output that was absent from the trusted base.
      await git(workspace.workingDirectory, ["add", "-A", "--", "."]);

      const patch = await captureGitRunPatch(workspace);
      assert.match(patch, /Improved/);
      assert.doesNotMatch(patch, /node_modules/);
      assert.equal(await exists(join(workspace.workingDirectory, "node_modules")), false);
      const committed = await commitGitRunBranch(workspace, "Roster: clean dependency frontier");
      assert.equal(
        await git(repositoryRoot, ["show", `${committed.commit}:README.md`]),
        "# Fixture\n\nImproved.\n",
      );
      await assert.rejects(
        git(repositoryRoot, ["show", `${committed.commit}:node_modules/fixture/index.js`]),
      );
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding workspaces install lockfile-pinned Python dependencies with uv", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-python-dependencies-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "pyproject.toml"), "[project]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
    await writeFile(join(repositoryRoot, "uv.lock"), "version = 1\nrevision = 1\n");
    await git(repositoryRoot, ["add", "pyproject.toml", "uv.lock"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-python-dependencies" });
    try {
      const received: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
      await prepareGitRunWorkspaceDependencies(workspace, {
        installer: async ({ command, args }) => { received.push({ command, args }); },
      });
      assert.deepEqual(received, [{
        command: process.platform === "win32" ? "uv.exe" : "uv",
        args: ["sync", "--frozen", "--all-extras"],
      }]);
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding workspaces consume an onboarded profile in its bounded repository directory", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-onboarded-dependencies-"));
  const packageJson = JSON.stringify({ scripts: { verify: "node --test" } });
  try {
    await git(repositoryRoot, ["init"]);
    await mkdir(join(repositoryRoot, "tools"));
    await writeFile(join(repositoryRoot, "tools", ".keep"), "");
    await writeFile(join(repositoryRoot, "package.json"), packageJson);
    await git(repositoryRoot, ["add", "package.json", "tools/.keep"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    const executionProfile = compileRepositoryExecutionProfile({
      source: "onboarded",
      repositoryFingerprint: "b".repeat(64),
      evidenceFiles: ["package.json"],
      evidenceHash: repositoryExecutionProfileEvidenceHash([{ path: "package.json", content: packageJson }]),
      installCommands: [{ command: "npm", args: ["ci"], cwd: "tools" }],
      verifyCommands: [{ command: "npm", args: ["run", "verify"] }],
    });
    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-onboarded-dependencies" });
    try {
      let receivedCwd: string | undefined;
      await prepareGitRunWorkspaceDependencies(workspace, {
        executionProfile,
        installer: async ({ cwd }) => { receivedCwd = cwd; },
      });
      assert.equal(receivedCwd, join(workspace.workingDirectory, "tools"));
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding runs commit certified deltas to durable branches without changing the current branch", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-workspace-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-test" });
    try {
      assert.equal(workspace.branchName, "roster/coding-test");
      assert.equal((await git(workspace.workingDirectory, ["branch", "--show-current"])).trim(), workspace.branchName);
      assert.equal((await git(workspace.workingDirectory, ["status", "--porcelain"])).trim(), "");

      await writeFile(join(workspace.workingDirectory, "run-output.md"), "agent delta\n");
      const patch = await captureGitRunPatch(workspace);
      assert.match(patch, /run-output\.md/);
      const committed = await commitGitRunBranch(workspace, "Roster: add run output");
      assert.equal(committed.outcome, "committed");
      assert.equal(committed.noChanges, false);
      assert.equal((await git(workspace.workingDirectory, ["rev-parse", "HEAD"])).trim(), committed.commit);
      assert.equal((await git(repositoryRoot, ["status", "--porcelain"])).trim(), "");
      assert.equal(await exists(join(repositoryRoot, "run-output.md")), false);
      assert.equal(
        await git(repositoryRoot, ["show", `${workspace.branchName}:run-output.md`]),
        "agent delta\n",
      );
    } finally {
      await disposeGitRunWorkspace(workspace);
      assert.equal(await exists(workspace.workingDirectory), false);
      assert.equal(await gitRunBranchExists(repositoryRoot, "coding-test"), true);
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding runs recover a crashed worktree without discarding its uncommitted delta", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-recover-worktree-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const first = await createGitRunWorkspace({ repositoryRoot, runId: "coding-recover-live" });
    await writeFile(join(first.workingDirectory, "partial.md"), "recover me\n");
    const recovered = await createGitRunWorkspace({ repositoryRoot, runId: first.runId });
    try {
      assert.equal(recovered.workingDirectory, first.workingDirectory);
      assert.equal(recovered.baselineCommit, first.baselineCommit);
      assert.equal(await readFile(join(recovered.workingDirectory, "partial.md"), "utf8"), "recover me\n");
    } finally {
      await disposeGitRunWorkspace(recovered, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding runs reattach an unchanged durable branch after checkout cleanup", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-reattach-branch-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const first = await createGitRunWorkspace({ repositoryRoot, runId: "coding-recover-branch" });
    await disposeGitRunWorkspace(first);

    const recovered = await createGitRunWorkspace({ repositoryRoot, runId: first.runId });
    try {
      assert.equal((await git(recovered.workingDirectory, ["rev-parse", "HEAD"])).trim(), first.baselineCommit);
      assert.equal(await readFile(join(recovered.workingDirectory, "README.md"), "utf8"), "# Project\n");
    } finally {
      await disposeGitRunWorkspace(recovered, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding runs certify a no-op objective without creating an empty commit", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-noop-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-noop" });
    const outcome = await commitGitRunBranch(workspace);
    assert.deepEqual(outcome, {
      commit: workspace.baselineCommit,
      outcome: "no_changes",
      noChanges: true,
    });
    await disposeGitRunWorkspace(workspace, { keepBranch: false });

    const status = await gitRunIntegrationStatus({
      repositoryRoot,
      runId: workspace.runId,
      expectedCommit: outcome.commit,
      baselineBranch: workspace.baselineBranch,
      baselineCommit: workspace.baselineCommit,
    });
    assert.equal(status.integrated, true);
    assert.equal(status.canIntegrate, false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding runs atomically replace a recovered patch with an empty frontier", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-empty-patch-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-reverted" });
    try {
      const transient = join(workspace.workingDirectory, "transient.md");
      await writeFile(transient, "temporary\n");
      assert.match(await captureGitRunPatch(workspace), /transient\.md/);
      await rm(transient);
      assert.equal(await captureGitRunPatch(workspace), "");
      assert.equal(await readGitRunPatch(repositoryRoot, workspace.runId), "");
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git certification rejects detached placement and commits only a prepared immutable tree", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-ref-cas-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const detached = await createGitRunWorkspace({ repositoryRoot, runId: "coding-detached" });
    await writeFile(join(detached.workingDirectory, "detached.md"), "must not land\n");
    await git(detached.workingDirectory, ["switch", "--detach", detached.baselineCommit]);
    await assert.rejects(commitGitRunBranch(detached), /detached HEAD/);
    assert.equal(
      (await git(repositoryRoot, ["rev-parse", `refs/heads/${detached.branchName}`])).trim(),
      detached.baselineCommit,
    );
    await disposeGitRunWorkspace(detached, { keepBranch: false });

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-prepared-tree" });
    const resultPath = join(workspace.workingDirectory, "result.md");
    await writeFile(resultPath, "reviewed frontier\n");
    const prepared = await prepareGitRunCommit(workspace);
    await writeFile(resultPath, "late unreviewed mutation\n");
    const outcome = await commitGitRunBranch(workspace, "Roster: exact frontier", prepared);
    assert.equal(await git(repositoryRoot, ["show", `${outcome.commit}:result.md`]), "reviewed frontier\n");
    assert.equal(await readGitRunPatch(repositoryRoot, workspace.runId), prepared.patch);
    await disposeGitRunWorkspace(workspace, { keepBranch: false });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding runs reject commits created outside the Roster certification boundary", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-untrusted-commit-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-untrusted-commit" });
    try {
      await writeFile(join(workspace.workingDirectory, "runtime-commit.md"), "not certified\n");
      await git(workspace.workingDirectory, ["add", "runtime-commit.md"]);
      await git(workspace.workingDirectory, [
        "-c", "user.name=Runtime Process",
        "-c", "user.email=runtime@example.invalid",
        "commit", "--no-gpg-sign", "-m", "runtime bypass",
      ]);
      const forgedPatch = await captureGitRunPatch(workspace);
      const metadataPath = gitRunWorkspacePaths(repositoryRoot, workspace.runId).metadata;
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      const runtimeCommit = (await git(workspace.workingDirectory, ["rev-parse", "HEAD"])).trim();
      await writeFile(metadataPath, `${JSON.stringify({
        ...metadata,
        certifiedCommit: runtimeCommit,
        certifiedPatchHash: createHash("sha256").update(forgedPatch).digest("hex"),
      })}\n`);
      await assert.rejects(
        commitGitRunBranch(workspace),
        /contains a commit that was not certified by Roster/,
      );
      assert.match(await readGitRunPatch(repositoryRoot, workspace.runId) ?? "", /runtime-commit\.md/);
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("Git coding runs isolate committed HEAD while the primary checkout is dirty", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-dirty-root-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n\nUncommitted work.\n");

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-dirty-test" });
    try {
      assert.equal(workspace.sourceCheckoutDirty, true);
      assert.equal(await readFile(join(workspace.workingDirectory, "README.md"), "utf8"), "# Project\n");
      assert.equal(await readFile(join(repositoryRoot, "README.md"), "utf8"), "# Project\n\nUncommitted work.\n");
    } finally {
      await disposeGitRunWorkspace(workspace, { keepBranch: false });
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("coding handler Git finalization retains normal failed-plan and failed-frontier patches", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-failed-branch-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const cases: ReadonlyArray<{
      readonly runId: string;
      readonly execution: CodingAgentExecutionResult;
      readonly expectedError: RegExp;
    }> = [
      {
        runId: "coding-failed-plan",
        execution: {
          runId: "coding-failed-plan",
          platformId: "coding-agent",
          platformVersion: "3.0.0",
          status: "failed",
          completion: { done: false, blocked: "coding graph did not complete" },
          outputs: {},
          snapshot: {} as CodingAgentExecutionResult["snapshot"],
        },
        expectedError: /coding graph did not complete/,
      },
      {
        runId: "coding-failed-frontier",
        execution: {
          runId: "coding-failed-frontier",
          platformId: "coding-agent",
          platformVersion: "3.0.0",
          status: "completed",
          completion: { done: true },
          outputs: {},
          snapshot: {} as CodingAgentExecutionResult["snapshot"],
        },
        expectedError: /final_report is missing valid Git frontier evidence/,
      },
    ];

    for (const scenario of cases) {
      const workspace = await createGitRunWorkspace({ repositoryRoot, runId: scenario.runId });
      await writeFile(join(workspace.workingDirectory, "partial.md"), `${scenario.runId}\n`);
      const finalization = await prepareCodingAgentGitRun({
        workspace,
        execution: scenario.execution,
        runId: scenario.runId,
        runStream: `agents/coding-agent/runs/${scenario.runId}`,
      });
      assert.equal(finalization.status, "failed");
      if (finalization.status === "failed") assert.match(finalization.result.error, scenario.expectedError);
      await disposeGitRunWorkspace(workspace, { keepBranch: false });

      assert.equal(await gitRunBranchExists(repositoryRoot, scenario.runId), false);
      assert.match(await readGitRunPatch(repositoryRoot, scenario.runId) ?? "", /partial\.md/);
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("certified Git coding runs integrate by an explicit idempotent fast-forward", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-integrate-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);

    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-integrate-test" });
    await writeFile(join(workspace.workingDirectory, "result.md"), "certified delta\n");
    const commit = (await commitGitRunBranch(workspace, "Roster: certified result")).commit;
    await disposeGitRunWorkspace(workspace);
    const input = {
      repositoryRoot,
      runId: workspace.runId,
      expectedCommit: commit,
      baselineBranch: workspace.baselineBranch,
      baselineCommit: workspace.baselineCommit,
    };

    const ready = await gitRunIntegrationStatus(input);
    assert.equal(ready.canIntegrate, true);
    assert.equal(ready.integrated, false);
    const integrated = await integrateGitRunBranch(input);
    assert.equal(integrated.integrated, true);
    assert.equal(integrated.alreadyIntegrated, false);
    assert.equal((await git(repositoryRoot, ["rev-parse", "HEAD"])).trim(), commit);
    assert.equal(await exists(join(repositoryRoot, "result.md")), true);
    assert.equal((await git(repositoryRoot, ["status", "--porcelain"])).trim(), "");
    assert.equal(await gitRunBranchExists(repositoryRoot, workspace.runId), false);

    const repeated = await integrateGitRunBranch(input);
    assert.equal(repeated.integrated, true);
    assert.equal(repeated.alreadyIntegrated, true);

    await writeFile(join(repositoryRoot, "later.md"), "later target-branch work\n");
    await git(repositoryRoot, ["add", "later.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User",
      "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "later work",
    ]);
    const afterLaterWork = await gitRunIntegrationStatus(input);
    assert.equal(afterLaterWork.integrated, true);
    assert.equal(afterLaterWork.canIntegrate, false);

    await git(repositoryRoot, ["switch", "-c", "release"]);
    const afterBranchSwitch = await gitRunIntegrationStatus(input);
    assert.equal(afterBranchSwitch.currentBranch, "release");
    assert.equal(afterBranchSwitch.integrated, true);
    assert.equal(afterBranchSwitch.canIntegrate, false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("integration status is derived from the recorded target ref, not another branch", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-run-target-ref-"));
  try {
    await git(repositoryRoot, ["init"]);
    await writeFile(join(repositoryRoot, "README.md"), "# Project\n");
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, [
      "-c", "user.name=Test User", "-c", "user.email=test@example.invalid",
      "commit", "--no-gpg-sign", "-m", "base",
    ]);
    const workspace = await createGitRunWorkspace({ repositoryRoot, runId: "coding-target-ref" });
    await writeFile(join(workspace.workingDirectory, "result.md"), "targeted delta\n");
    const expectedCommit = (await commitGitRunBranch(workspace)).commit;
    await disposeGitRunWorkspace(workspace);
    const input = {
      repositoryRoot,
      runId: workspace.runId,
      expectedCommit,
      baselineBranch: workspace.baselineBranch,
      baselineCommit: workspace.baselineCommit,
    };

    await git(repositoryRoot, ["switch", "-c", "release"]);
    await git(repositoryRoot, ["merge", "--ff-only", expectedCommit]);
    const wrongTarget = await gitRunIntegrationStatus(input);
    assert.equal(wrongTarget.currentBranch, "release");
    assert.equal(wrongTarget.integrated, false);
    assert.equal(wrongTarget.canIntegrate, false);
    assert.match(wrongTarget.reason ?? "", /Check out .* before applying/);
    await assert.rejects(integrateGitRunBranch(input), /Check out .* before applying/);
    assert.equal(await gitRunBranchExists(repositoryRoot, workspace.runId), true);

    await git(repositoryRoot, ["switch", workspace.baselineBranch]);
    const integrated = await integrateGitRunBranch(input);
    assert.equal(integrated.integrated, true);
    assert.equal((await git(repositoryRoot, ["rev-parse", `refs/heads/${workspace.baselineBranch}`])).trim(), expectedCommit);
    assert.equal(await gitRunBranchExists(repositoryRoot, workspace.runId), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
