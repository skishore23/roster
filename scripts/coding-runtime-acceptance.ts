import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  runCodingAgent,
  type CodingWorkerRuntime,
} from "../src/domains/coding.js";
import { inspectCodingWorkspace } from "../src/domains/coding-workspace.js";
import { InMemoryDataReferenceStore } from "../src/engine/dataflow/data-reference-store.js";
import type { RosterPlatformExecutionOptions } from "../src/engine/platform/roster-platform.js";
import { InMemoryTaskGraphControl } from "../src/engine/orchestration/task-graph-control.js";
import { createStandardNodeRuntimeRegistry } from "../src/engine/runtime/standard-node-runtimes.js";
import {
  createRosterTaskContext,
  SharedWorkspaceLedger,
} from "../src/engine/workspace/shared-workspace.js";

const execFileAsync = promisify(execFile);
const runtimeKinds: ReadonlyArray<CodingWorkerRuntime> = [
  "codex-cli",
  "claude-code",
  "pi-agent",
  "hermes-agent",
];

const selectedKinds = (): ReadonlyArray<CodingWorkerRuntime> => {
  const requested = process.env.ROSTER_CODING_ACCEPTANCE_RUNTIMES?.trim() || "all";
  if (requested === "all") return runtimeKinds;
  const values = [...new Set(requested.split(",").map((value) => value.trim()).filter(Boolean))];
  for (const value of values) {
    if (!runtimeKinds.some((kind) => kind === value)) {
      throw new Error(`Unsupported coding acceptance runtime ${value}`);
    }
  }
  return values as ReadonlyArray<CodingWorkerRuntime>;
};

const executionPlanes = (runId: string) => {
  const taskGraph = new InMemoryTaskGraphControl();
  const dataReferences = new InMemoryDataReferenceStore();
  const ledger = new SharedWorkspaceLedger(`coding-acceptance-${runId}`);
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
          throw new Error(`Task ${definition.taskId} lost its workspace fence`);
        }
      },
    },
  });
  return { taskGraph, dataReferences, createTaskContext };
};

const git = async (
  directory: string,
  args: ReadonlyArray<string>,
): Promise<string> => (await execFileAsync("git", [...args], {
  cwd: directory,
  timeout: 15_000,
  maxBuffer: 4 * 1_048_576,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
})).stdout.trim();

type AcceptanceResult = {
  readonly runtimeKind: CodingWorkerRuntime;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly status?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly error?: string;
  readonly logTail?: ReadonlyArray<string>;
};

const runAcceptance = async (
  runtimeKind: CodingWorkerRuntime,
): Promise<AcceptanceResult> => {
  const maximumDurationMs = Number(
    process.env.ROSTER_CODING_ACCEPTANCE_MAX_DURATION_MS ?? 240_000,
  );
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1_000) {
    throw new Error("ROSTER_CODING_ACCEPTANCE_MAX_DURATION_MS must be an integer of at least 1000");
  }
  const directory = await mkdtemp(join(tmpdir(), `roster-coding-${runtimeKind}-`));
  const runId = `coding-acceptance-${runtimeKind}-${Date.now()}`;
  const expected = `Runtime acceptance: ${runtimeKind}`;
  const logs: string[] = [];
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(
      `${runtimeKind} coding acceptance exceeded ${maximumDurationMs}ms`,
    )),
    maximumDurationMs,
  );
  try {
    await git(directory, ["init", "--initial-branch=main"]);
    await git(directory, ["config", "user.name", "Roster Acceptance"]);
    await git(directory, ["config", "user.email", "roster-acceptance@example.invalid"]);
    await writeFile(
      join(directory, "README.md"),
      "# Runtime Acceptance\n\nRuntime acceptance: pending\n",
      "utf8",
    );
    await git(directory, ["add", "README.md"]);
    await git(directory, ["commit", "-m", "Acceptance fixture"]);
    const baseline = await git(directory, ["rev-parse", "HEAD"]);
    const profile = await inspectCodingWorkspace(directory);
    const primary = profile.nodes.find((node) => node.capabilities.includes("implement"));
    if (!primary) throw new Error("Acceptance fixture did not materialize an implementation node");
    const planes = executionPlanes(runId);
    const execution = await runCodingAgent({
      runId,
      signal: controller.signal,
      objective: [
        "In README.md replace the exact line `Runtime acceptance: pending`",
        `with \`${expected}\`.`,
        "Do not change any other line or file and do not create a commit.",
      ].join(" "),
      workingDirectory: directory,
      workerRuntime: runtimeKind,
      reviewPolicy: "fast",
      coordination: { reviewMode: "fast", validationScope: "focused" },
      workspaceNodes: profile.nodes,
      selectedNodeIds: [primary.id],
      primaryNodeId: primary.id,
      maxNodes: profile.nodes.length,
      maxParallel: 1,
      ...(runtimeKind === "codex-cli"
        ? { codexReasoningEffort: "low" as const }
        : {}),
      ...(runtimeKind === "pi-agent"
        ? {
            piProvider: process.env.ROSTER_CODING_ACCEPTANCE_PI_PROVIDER?.trim() || "openai-codex",
            piModel: process.env.ROSTER_CODING_ACCEPTANCE_PI_MODEL?.trim() || "gpt-5.4-mini",
            piThinking: "minimal",
            piProjectTrust: "approve" as const,
            piNoExtensions: true,
          }
        : {}),
      ...planes,
      nodeRuntimes: createStandardNodeRuntimeRegistry(),
      onNodeLog: (entry) => {
        const text = entry.text.trim();
        if (!text) return;
        logs.push(`${entry.runtime}:${entry.stream}:${text.slice(0, 500)}`);
        if (logs.length > 20) logs.shift();
      },
    });
    const head = await git(directory, ["rev-parse", "HEAD"]);
    const changedFiles = (await git(directory, ["diff", "--name-only"]))
      .split("\n")
      .filter(Boolean);
    const readme = await readFile(join(directory, "README.md"), "utf8");
    if (execution.status !== "completed") {
      const failedTasks = execution.snapshot.tasks
        .filter((task) => task.status === "failed")
        .map((task) => ({
          taskId: task.definition.taskId,
          error: task.error,
        }));
      throw new Error(
        `Coding lifecycle ended with status ${execution.status}: ${
          execution.completion.blocked ?? "no completion reason"
        }; failedTasks=${JSON.stringify(failedTasks)}; outputs=${JSON.stringify(execution.outputs)}`,
      );
    }
    if (head !== baseline) throw new Error("Worker created a commit without publishing authority");
    if (readme !== `# Runtime Acceptance\n\n${expected}\n`) {
      throw new Error(`README mutation did not match the exact requested value: ${JSON.stringify(readme)}`);
    }
    if (changedFiles.length !== 1 || changedFiles[0] !== "README.md") {
      throw new Error(`Worker changed files outside the requested surface: ${changedFiles.join(", ")}`);
    }
    return {
      runtimeKind,
      passed: true,
      durationMs: Date.now() - startedAt,
      status: execution.status,
      changedFiles,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      runtimeKind,
      passed: false,
      durationMs: Date.now() - startedAt,
      error: detail.length > 2_000 ? `${detail.slice(0, 2_000)}…` : detail,
      logTail: logs,
    };
  } finally {
    clearTimeout(timeout);
    await rm(directory, { recursive: true, force: true });
  }
};

const results: AcceptanceResult[] = [];
for (const runtimeKind of selectedKinds()) results.push(await runAcceptance(runtimeKind));

const summary = {
  schemaVersion: "roster.coding-runtime-acceptance.v1",
  passed: results.every((result) => result.passed),
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;
