#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  runCodingAgent,
  verifyCodingFrontierEvidence,
  type CodingCodexReasoningEffort,
  type CodingWorkerRuntime,
} from "../src/domains/coding.js";
import {
  discoverCodingRepositorySkills,
  inspectCodingWorkspace,
} from "../src/domains/coding-workspace.js";
import { InMemoryDataReferenceStore } from "../src/engine/dataflow/data-reference-store.js";
import type { RosterPlatformExecutionOptions } from "../src/engine/platform/roster-platform.js";
import { InMemoryTaskGraphControl } from "../src/engine/orchestration/task-graph-control.js";
import { createStandardNodeRuntimeRegistry } from "../src/engine/runtime/standard-node-runtimes.js";
import {
  createRosterTaskContext,
  SharedWorkspaceLedger,
} from "../src/engine/workspace/shared-workspace.js";

const execFileAsync = promisify(execFile);

type Flags = Readonly<Record<string, string | boolean>>;

type UsageTotals = {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

const parseArgs = (argv: ReadonlyArray<string>): Flags => {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
};

const stringFlag = (flags: Flags, key: string): string | undefined => {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
};

const requiredPath = (flags: Flags, key: string): string => {
  const value = stringFlag(flags, key)?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return resolve(value);
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const gitRaw = async (
  directory: string,
  args: ReadonlyArray<string>,
): Promise<string> => (await execFileAsync("git", [...args], {
  cwd: directory,
  timeout: 30_000,
  maxBuffer: 8 * 1_048_576,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
})).stdout;

const git = async (
  directory: string,
  args: ReadonlyArray<string>,
): Promise<string> => (await gitRaw(directory, args)).trim();

const ensureGitBaseline = async (workspace: string): Promise<string> => {
  if (!await isDirectory(join(workspace, ".git"))) {
    await git(workspace, ["init", "--initial-branch=main"]);
  }
  await git(workspace, ["config", "user.name", "Roster TeamBench"]);
  await git(workspace, ["config", "user.email", "roster-teambench@example.invalid"]);
  await git(workspace, ["add", "-A"]);
  const hasHead = await git(workspace, ["rev-parse", "--verify", "HEAD"])
    .then(() => true)
    .catch(() => false);
  if (!hasHead || (await git(workspace, ["status", "--porcelain"]))) {
    await git(workspace, ["commit", "-m", "TeamBench fixture"]);
  }
  return await git(workspace, ["rev-parse", "HEAD"]);
};

const executionPlanes = (runId: string) => {
  const taskGraph = new InMemoryTaskGraphControl();
  const dataReferences = new InMemoryDataReferenceStore();
  const ledger = new SharedWorkspaceLedger(`teambench:${runId}`);
  const createTaskContext: RosterPlatformExecutionOptions["createTaskContext"] = ({
    node,
    definition,
    lease,
  }) => createRosterTaskContext({
    node,
    ledger,
    fence: {
      runId,
      taskId: definition.taskId,
      nodeId: definition.nodeId,
      fence: BigInt(lease.fence),
      runtimeBindingEpoch: definition.runtimeBindingEpoch,
      frontierVersion: definition.inputs.frontierVersion,
      topologyVersion: definition.inputs.topologyVersion,
      catalogVersion: definition.inputs.catalogVersion,
      inputVersions: definition.inputs.inputVersions,
    },
    authority: {
      assertActive: async () => {
        const snapshot = await taskGraph.snapshot();
        const record = snapshot.tasks.find((candidate) =>
          candidate.definition.taskId === definition.taskId);
        if (
          !record
          || (record.status !== "leased" && record.status !== "running")
          || record.leaseFence !== lease.fence
        ) {
          throw new Error(`Task ${definition.taskId} lost its TeamBench workspace fence`);
        }
      },
    },
  });
  return { taskGraph, dataReferences, createTaskContext };
};

const usage = (): string => [
  "npm run eval:teambench:roster -- --task-dir <TeamBench task> --run-dir <prepared TeamBench run>",
  "  [--runtime codex-cli|claude-code|pi-agent|hermes-agent]",
  "  [--model <runtime model>] [--reasoning low|medium|high|xhigh|max]",
  "  [--output <summary.json>]",
  "",
  "The prepared run must contain workspace/, reports/, submission/, and run_meta.json.",
].join("\n");

const main = async (): Promise<void> => {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const taskDir = requiredPath(flags, "task-dir");
  const runDir = requiredPath(flags, "run-dir");
  const workspace = join(runDir, "workspace");
  const reports = join(runDir, "reports");
  const submission = join(runDir, "submission");
  for (const path of [taskDir, runDir, workspace, reports, submission]) {
    if (!await isDirectory(path)) throw new Error(`Required directory is missing: ${path}`);
  }

  const runtime = (stringFlag(flags, "runtime") ?? "codex-cli") as CodingWorkerRuntime;
  if (!["codex-cli", "claude-code", "pi-agent", "hermes-agent"].includes(runtime)) {
    throw new Error(`Unsupported runtime ${runtime}`);
  }
  const reasoning = (stringFlag(flags, "reasoning") ?? "high") as CodingCodexReasoningEffort;
  if (!["low", "medium", "high", "xhigh", "max"].includes(reasoning)) {
    throw new Error(`Unsupported Codex reasoning effort ${reasoning}`);
  }

  const taskId = basename(taskDir);
  const harnessRevision = await git(taskDir, ["rev-parse", "HEAD"]).catch(() => "unknown");
  const runMeta = JSON.parse(await readFile(join(runDir, "run_meta.json"), "utf8")) as {
    readonly run_id?: string;
    readonly seed?: number;
  };
  const harnessRunId = runMeta.run_id?.trim() || basename(runDir);
  const runId = `teambench-${taskId}-${harnessRunId}`;
  const specification = await readFile(join(taskDir, "spec.md"), "utf8");
  const brief = await readFile(join(taskDir, "brief.md"), "utf8");
  const baselineCommit = await ensureGitBaseline(workspace);
  const profile = await inspectCodingWorkspace(workspace);
  const primary = profile.nodes.find((node) => node.capabilities.includes("implement"));
  if (!primary) throw new Error("TeamBench workspace did not materialize an implementation node");
  const selectedNodes = profile.nodes.filter((node) =>
    node.capabilities.some((capability) =>
      ["implement", "review", "respond", "remediate", "certify"].includes(capability)));
  const planes = executionPlanes(runId);
  const logs: string[] = [];
  const usageTotals: UsageTotals = {
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  const startedAt = Date.now();
  let executionError: string | undefined;
  let execution: Awaited<ReturnType<typeof runCodingAgent>> | undefined;

  try {
    execution = await runCodingAgent({
      runId,
      objective: [
        `Complete TeamBench task ${taskId}.`,
        "",
        "Full specification:",
        specification,
        "",
        "User-facing brief:",
        brief,
        "",
        "Work only inside the supplied repository. Implement every requirement, run the relevant tests,",
        "preserve unrelated behavior, and do not create a Git commit. The external TeamBench grader is authoritative.",
      ].join("\n"),
      workingDirectory: workspace,
      workerRuntime: runtime,
      reviewerRuntime: runtime === "claude-code" ? "claude-code" : "codex-cli",
      ...(runtime === "codex-cli"
        ? {
            codexModel: stringFlag(flags, "model") ?? "gpt-5.6-sol",
            reviewerCodexModel: stringFlag(flags, "reviewer-model") ?? "gpt-5.6-sol",
            codexReasoningEffort: reasoning,
          }
        : {}),
      ...(runtime === "claude-code"
        ? { claudeModel: stringFlag(flags, "model") ?? "sonnet" }
        : {}),
      reviewPolicy: "reviewed",
      coordination: { reviewMode: "reviewed", validationScope: "focused" },
      workspaceNodes: profile.nodes,
      selectedNodeIds: selectedNodes.map((node) => node.id),
      primaryNodeId: primary.id,
      maxNodes: profile.nodes.length,
      maxParallel: Math.min(2, profile.nodes.length),
      maxWallTimeMs: 30 * 60_000,
      repositorySkills: await discoverCodingRepositorySkills(workspace),
      ...planes,
      nodeRuntimes: createStandardNodeRuntimeRegistry(),
      onNodeLog: (entry) => {
        const text = entry.text.trim();
        if (!text) return;
        const usageMatch = /Turn completed · (\{.*\})/u.exec(text);
        if (usageMatch?.[1]) {
          try {
            const usage = JSON.parse(usageMatch[1]) as Record<string, unknown>;
            const add = (key: string): number =>
              typeof usage[key] === "number" ? usage[key] : 0;
            usageTotals.turns += 1;
            usageTotals.inputTokens += add("input_tokens");
            usageTotals.cachedInputTokens += add("cached_input_tokens");
            usageTotals.cacheWriteInputTokens += add("cache_write_input_tokens");
            usageTotals.outputTokens += add("output_tokens");
            usageTotals.reasoningOutputTokens += add("reasoning_output_tokens");
          } catch {
            // Preserve the raw line in the bounded log tail when usage is malformed.
          }
        }
        logs.push(`${entry.runtime}:${entry.stream}:${text.slice(0, 1_000)}`);
        if (logs.length > 200) logs.shift();
      },
    });
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  }

  const orchestrationStatus = execution?.status ?? "failed";
  let trustedFrontierHash: string | undefined;
  let frontierEvidence: ReturnType<typeof verifyCodingFrontierEvidence> | undefined;
  if (execution?.status === "completed") {
    await git(workspace, ["add", "-A", "--", "."]);
    const trustedPatch = await gitRaw(workspace, [
      "--no-pager", "diff", "--cached", "--binary", "--full-index", baselineCommit, "--",
    ]);
    trustedFrontierHash = createHash("sha256").update(trustedPatch).digest("hex");
    frontierEvidence = verifyCodingFrontierEvidence(execution.outputs, trustedFrontierHash);
  }
  const verified = orchestrationStatus === "completed" && frontierEvidence?.valid === true;
  await mkdir(submission, { recursive: true });
  await writeFile(join(submission, "attestation.json"), JSON.stringify({
    task_id: taskId,
    run_id: harnessRunId,
    verdict: verified ? "pass" : "fail",
    checklist: [{
      id: "roster_execution",
      ok: verified,
      note: executionError
        ?? execution?.completion.blocked
        ?? frontierEvidence?.reason
        ?? "Roster coding graph completed and its frontier matched the host-owned Git index",
    }],
    condition: "adaptive_roster",
  }, null, 2), "utf8");

  const changedFiles = (await git(workspace, ["diff", "HEAD", "--name-only"]))
    .split("\n")
    .filter(Boolean);
  const tasks = execution?.snapshot.tasks.map((task) => ({
    taskId: task.definition.taskId,
    nodeId: task.definition.nodeId,
    capability: task.definition.capability,
    status: task.status,
    attempts: task.attempts,
    error: task.error,
  })) ?? [];
  const summary = {
    schemaVersion: "roster.teambench-run.v1",
    benchmark: {
      suite: "TeamBench",
      harnessRevision,
      taskId,
      seed: runMeta.seed ?? 0,
      harnessRunId,
    },
    condition: {
      id: "adaptive-roster",
      runtime,
      model: stringFlag(flags, "model")
        ?? (runtime === "codex-cli" ? "gpt-5.6-sol" : runtime === "claude-code" ? "sonnet" : "default"),
      reasoning: runtime === "codex-cli" ? reasoning : undefined,
      reviewMode: "reviewed",
      validationScope: "focused",
    },
    outcome: {
      orchestrationStatus,
      verifiedStatus: verified ? "completed" : "failed",
      completionReason: execution?.completion.blocked ?? frontierEvidence?.reason,
      error: executionError,
      durationMs: Date.now() - startedAt,
      baselineCommit,
      changedFiles,
      outputKeys: Object.keys(execution?.outputs ?? {}).sort(),
      usage: usageTotals,
      hostFrontier: {
        ...(trustedFrontierHash ? { trustedFrontierHash } : {}),
        valid: frontierEvidence?.valid ?? false,
        ...(frontierEvidence?.reason ? { reason: frontierEvidence.reason } : {}),
      },
    },
    topology: {
      nodeIds: selectedNodes.map((node) => node.id),
      primaryNodeId: primary.id,
      tasks,
    },
    logTail: logs.slice(-40),
  };
  const encoded = `${JSON.stringify(summary, null, 2)}\n`;
  const output = stringFlag(flags, "output");
  if (output) {
    const outputPath = resolve(output);
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, encoded, "utf8");
  }
  console.log(encoded);
  if (!verified) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
