import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RecordingEntropySource,
  SimulationImpl,
  type EntropySource,
  type Logger,
  type SimulationTask,
} from "determined";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import type { DelegationTools } from "../../src/adapters/delegation.ts";
import type { MemoryTools } from "../../src/adapters/memory-tools.ts";
import { runAxiom, normalizeAxiomConfig, type AxiomRunInput } from "../../src/agents/axiom.ts";
import { agentRunStream } from "../../src/agents/agent.streams.ts";
import { runTheoremRoster } from "../../src/agents/theorem.ts";
import { theoremRunStream } from "../../src/agents/theorem.streams.ts";
import {
  runWriterRoster,
  WRITER_DEFAULT_CONFIG,
  type WriterExecutionPlane,
} from "../../src/agents/writer.ts";
import { writerRunStream } from "../../src/agents/writer.streams.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
} from "../../src/engine/orchestration/task-graph-control.ts";
import { compositionLeaves, parseCompositionBracket } from "../../src/engine/orchestration/topology.ts";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
} from "../../src/engine/workspace/shared-workspace.ts";
import type { AgentCmd, AgentEvent, AgentState } from "../../src/modules/agent.ts";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent } from "../../src/modules/agent.ts";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../../src/modules/theorem.ts";
import { decide as decideTheorem, initial as initialTheorem, reduce as reduceTheorem } from "../../src/modules/theorem.ts";
import type { WriterCmd, WriterEvent, WriterState } from "../../src/modules/writer.ts";
import { decide as decideWriter, initial as initialWriter, reduce as reduceWriter } from "../../src/modules/writer.ts";
import { loadAxiomPrompts } from "../../src/prompts/axiom.ts";
import { loadTheoremPrompts } from "../../src/prompts/theorem.ts";
import { loadWriterPrompts } from "../../src/prompts/writer.ts";
import { createTestTheoremExecutionPlanes } from "../support/theorem-platform.ts";

class FixedEntropySource implements EntropySource {
  private index = 0;

  constructor(private readonly values: ReadonlyArray<number>) {
    assert.ok(values.length > 0, "fixed entropy requires at least one value");
  }

  random(_reason: string): number {
    const value = this.values[this.index % this.values.length];
    this.index += 1;
    assert.equal(typeof value, "number");
    return value;
  }
}

const silentLogger: Logger = {
  log: () => undefined,
  error: () => undefined,
};

const writerExecutionPlane = (runId: string): WriterExecutionPlane => {
  const taskGraph = new InMemoryTaskGraphControl();
  const ledger = new SharedWorkspaceLedger(`writer-test-workspace:${runId}`);
  return {
    taskGraph,
    dataReferences: new InMemoryDataReferenceStore(),
    createTaskContext: ({ node, definition, lease }) => createRosterTaskContext({
      node,
      ledger,
      fence: {
        runId,
        taskId: definition.taskId,
        nodeId: node.id,
        fence: BigInt(lease.fence),
        frontierVersion: definition.inputs.frontierVersion,
        topologyVersion: definition.inputs.topologyVersion,
        catalogVersion: definition.inputs.catalogVersion,
        runtimeBindingEpoch: definition.runtimeBindingEpoch,
        inputVersions: definition.inputs.inputVersions,
      },
      authority: {
        assertActive: async () => {
          const record = taskGraphTask(await taskGraph.snapshot(), definition.taskId);
          if (
            !record
            || (record.status !== "leased" && record.status !== "running")
            || record.leaseOwner !== lease.owner
            || record.leaseFence !== lease.fence
          ) {
            throw new Error(`Writer test task ${definition.taskId} lost its workspace fence`);
          }
        },
      },
    }),
  };
};

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const mkMemoryTools = (): MemoryTools => ({
  read: async () => [],
  search: async () => [],
  summarize: async () => ({ summary: "", entries: [] }),
  commit: async (input) => ({
    id: `mem_${Date.now().toString(36)}`,
    scope: input.scope,
    text: input.text,
    tags: input.tags,
    meta: input.meta,
    ts: Date.now(),
  }),
  diff: async () => [],
  reindex: async () => 0,
});

const mkDelegationTools = (): DelegationTools => ({
  "agent.delegate": async () => ({ output: "", summary: "" }),
  "agent.status": async () => ({ output: "", summary: "" }),
  "agent.inspect": async () => ({ output: "", summary: "" }),
});

const structuredFromText = (llmText: AxiomRunInput["llmText"]): AxiomRunInput["llmStructured"] =>
  (async ({ system, user }) => {
    const raw = await llmText({ system, user });
    return {
      parsed: JSON.parse(raw) as never,
      raw,
    };
  }) as AxiomRunInput["llmStructured"];

const theoremText = async (opts: { readonly user: string }): Promise<string> => {
  const user = opts.user;
  if (user.includes("\"action\": \"continue\" | \"done\"")) {
    return JSON.stringify({
      action: "continue",
      reason: "exercise one simulation round",
      skip_lemma: false,
      skip_critique: false,
      skip_patch: false,
      skip_merge: false,
      focus: {},
    });
  }
  if (user.includes("\"attempt\": \"full attempt text\"")) {
    return JSON.stringify({
      attempt: "For any proposition P, P implies P by assuming P and returning the assumption.",
      lemmas: ["identity implication"],
      gaps: [],
    });
  }
  if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
    return JSON.stringify({
      lemmas: [{ label: "L1", statement: "P -> P", usage: "identity implication" }],
    });
  }
  if (user.includes("\"issues\": [")) {
    return JSON.stringify({ issues: [], summary: "No issues found." });
  }
  if (user.includes("\"patch\": \"patched proof text\"")) {
    return JSON.stringify({ patch: "No changes required.", remaining_gaps: [] });
  }
  if (user.includes("\"summary\": \"merged summary\"")) {
    return JSON.stringify({ summary: "Merged identity proof.", gaps: [] });
  }
  if (user.includes("\"status\": \"valid | needs | false\"")) {
    return JSON.stringify({ status: "valid", notes: ["Identity implication is valid."] });
  }
  if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
    return JSON.stringify({
      proof: "Assume P. Then P follows immediately from the assumption.",
      confidence: 0.95,
      gaps: [],
    });
  }
  return "{}";
};

const rebracketTheoremText = async (opts: { readonly system?: string; readonly user: string }): Promise<string> => {
  const user = opts.user;
  const system = opts.system ?? "";
  if (user.includes("\"action\": \"continue\" | \"done\"")) {
    return JSON.stringify({
      action: "continue",
      reason: "force collaboration through critique, patch, merge, and rebracket",
      skip_lemma: false,
      skip_critique: false,
      skip_patch: false,
      skip_merge: false,
      focus: {
        explorer_a: "Use a direct implication proof.",
        explorer_b: "Use an assumption-introduction proof.",
        explorer_c: "Use a contradiction-free proof outline.",
      },
    });
  }
  if (user.includes("\"attempt\": \"full attempt text\"")) {
    const explorer = system.includes("Explorer A")
      ? "A"
      : system.includes("Explorer B")
        ? "B"
        : system.includes("Explorer C")
          ? "C"
          : "unknown";
    return JSON.stringify({
      attempt: `Explorer ${explorer}: Assume P, route ${explorer} returns P with a deliberately exposed justification gap.`,
      lemmas: [`L${explorer}: implication introduction for route ${explorer}`],
      gaps: [`route ${explorer} needs critique and repair`],
    });
  }
  if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
    return JSON.stringify({
      lemmas: [
        { label: "L1", statement: "P -> P follows from assuming P.", usage: "All explorer branches" },
      ],
    });
  }
  if (user.includes("\"issues\": [")) {
    return JSON.stringify({
      issues: ["The branch leaves its assumption-return step implicit."],
      summary: "Critique forces a repair for this explorer branch.",
    });
  }
  if (user.includes("\"patch\": \"patched proof text\"")) {
    return JSON.stringify({
      patch: "Patch: make the implication-introduction step explicit and return the assumption.",
      remaining_gaps: [],
    });
  }
  if (user.includes("\"summary\": \"merged summary\"")) {
    const bracket = user.match(/(?:Merge these leaves for|bracket).*?([ABCDo ()]+)/i)?.[1]?.trim();
    return JSON.stringify({
      summary: `Merged collaborative proof${bracket ? ` for ${bracket}` : ""}: patched explorer branches agree on P -> P.`,
      gaps: [],
    });
  }
  if (user.includes("\"status\": \"valid | needs | false\"")) {
    return JSON.stringify({ status: "valid", notes: ["Patched collaborative proof is valid."] });
  }
  if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
    return JSON.stringify({
      proof: "Assume P. The assumption itself proves P, so P -> P.",
      confidence: 0.96,
      gaps: [],
    });
  }
  return "{}";
};

test("simulation: theorem, writer, and axiom loops complete under scheduled concurrency", { timeout: 120_000 }, async () => {
  const dir = await mkTmp("receipt-agent-loop-simulation");
  const dataDir = path.join(dir, "data");
  const workspaceRoot = path.join(dir, "workspace");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  try {
    const branchStore = memoryBranchStore();
    const theoremRuntime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      memoryStore<TheoremEvent>(),
      branchStore,
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const writerRuntime = createRuntime<WriterCmd, WriterEvent, WriterState>(
      memoryStore<WriterEvent>(),
      branchStore,
      decideWriter,
      reduceWriter,
      initialWriter
    );
    const axiomRuntime = createRuntime<AgentCmd, AgentEvent, AgentState>(
      memoryStore<AgentEvent>(),
      branchStore,
      decideAgent,
      reduceAgent,
      initialAgent
    );

    const sim = new SimulationImpl(
      silentLogger,
      new RecordingEntropySource(new FixedEntropySource([0.17, 0.49, 0.83, 0.05, 0.61])),
      () => 0
    );
    const result = await sim.runTasks([
      {
        name: "theorem-loop",
        f: async (task: SimulationTask): Promise<void> => {
          await task.checkpoint("agent-loop:theorem:start");
          await runTheoremRoster({
            stream: "theorem",
            runId: "theorem_sim",
            problem: "Prove P -> P.",
            config: { rounds: 1, maxDepth: 1, memoryWindow: 20, branchThreshold: 2 },
            runtime: theoremRuntime,
            prompts: loadTheoremPrompts(),
            llmText: theoremText,
            model: "test-model",
            apiReady: true,
            createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
          });
          await task.checkpoint("agent-loop:theorem:done");
        },
      },
      {
        name: "writer-loop",
        f: async (task: SimulationTask): Promise<void> => {
          await task.checkpoint("agent-loop:writer:start");
          await runWriterRoster({
            stream: "writer",
            runId: "writer_sim",
            problem: "Write a concise note about deterministic simulations.",
            config: { ...WRITER_DEFAULT_CONFIG, maxParallel: 2 },
            runtime: writerRuntime,
            prompts: loadWriterPrompts(),
            llmText: async ({ user }) => `Simulated writer response for: ${user.slice(0, 80)}`,
            model: "test-model",
            apiReady: true,
            createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
            executionPlane: writerExecutionPlane("writer_sim"),
          });
          await task.checkpoint("agent-loop:writer:done");
        },
      },
      {
        name: "axiom-loop",
        f: async (task: SimulationTask): Promise<void> => {
          await task.checkpoint("agent-loop:axiom:start");
          const llmText: AxiomRunInput["llmText"] = async () => JSON.stringify({
            thought: "Finish the simulation run.",
            action: {
              type: "final",
              text: "Axiom simulation completed.",
            },
          });
          await runAxiom({
            stream: "agents/axiom",
            runId: "axiom_sim",
            problem: "Finish the simulated axiom run.",
            config: normalizeAxiomConfig({
              maxIterations: 1,
              workspace: ".",
              localValidationMode: "off",
            }),
            runtime: axiomRuntime,
            prompts: loadAxiomPrompts(),
            llmText,
            llmStructured: structuredFromText(llmText),
            model: "test-model",
            apiReady: true,
            memoryTools: mkMemoryTools(),
            delegationTools: mkDelegationTools(),
            workspaceRoot,
          });
          await task.checkpoint("agent-loop:axiom:done");
        },
      },
    ] as const);

    if (result.isErr()) throw result.error;

    const theoremChain = await theoremRuntime.chain(theoremRunStream("theorem", "theorem_sim"));
    const writerChain = await writerRuntime.chain(writerRunStream("writer", "writer_sim"));
    const axiomChain = await axiomRuntime.chain(agentRunStream("agents/axiom", "axiom_sim"));

    assert.ok(
      theoremChain.some((entry) => entry.body.type === "run.status" && entry.body.status === "completed"),
      "theorem loop did not complete"
    );
    assert.ok(
      writerChain.some((entry) => entry.body.type === "run.status" && entry.body.status === "completed"),
      "writer loop did not complete"
    );
    assert.ok(
      axiomChain.some((entry) => entry.body.type === "run.status" && entry.body.status === "completed"),
      "axiom loop did not complete"
    );
    assert.ok(
      theoremChain.some((entry) => entry.body.type === "orchestration.configured" && entry.body.domainId === "theorem"),
      "theorem did not use the generic orchestration protocol"
    );
    assert.ok(
      writerChain.some((entry) => entry.body.type === "orchestration.configured" && entry.body.domainId === "writer"),
      "writer did not use the generic orchestration protocol"
    );
    assert.ok(theoremChain.some((entry) => entry.body.type === "prompt.compiled"));
    assert.ok(writerChain.some((entry) => entry.body.type === "prompt.compiled"));
    assert.ok(theoremChain.some((entry) => entry.body.type === "task.graph.projected"));
    assert.equal(
      theoremChain.some((entry) =>
        ["task.delegated", "task.started", "task.completed", "task.failed"].includes(entry.body.type)
        || entry.body.type.startsWith("plan.")
      ),
      false,
      "theorem must use the platform task graph instead of legacy orchestration receipts",
    );
    assert.equal(
      writerChain.some((entry) =>
        ["task.delegated", "task.started", "task.completed", "task.failed"].includes(entry.body.type)
        || entry.body.type.startsWith("plan.")
      ),
      false,
      "writer must use the platform task graph instead of legacy orchestration receipts",
    );
    assert.ok(writerChain.some((entry) => entry.body.type === "task.graph.projected"));
    assert.ok(
      theoremChain.some((entry) => entry.body.type === "composition.certified" && entry.body.compositionId === "theorem.final")
    );
    assert.ok(
      writerChain.some((entry) => entry.body.type === "composition.certified" && entry.body.compositionId === "writer.final")
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("simulation: theorem collaboration rebrackets and uses the rotated merge lens", { timeout: 120_000 }, async () => {
  const dir = await mkTmp("receipt-theorem-rebracket-simulation");
  const dataDir = path.join(dir, "data");
  const oldPassK = process.env.THEOREM_PASS_K;
  process.env.THEOREM_PASS_K = "1";

  await fs.mkdir(dataDir, { recursive: true });

  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      memoryStore<TheoremEvent>(),
      memoryBranchStore(),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const sim = new SimulationImpl(
      silentLogger,
      new RecordingEntropySource(new FixedEntropySource([0.42, 0.09, 0.77, 0.31, 0.64])),
      () => 0
    );

    const result = await sim.runTasks([
      {
        name: "theorem-rebracket-loop",
        f: async (task: SimulationTask): Promise<void> => {
          await task.checkpoint("rebracket:run:start");
          await runTheoremRoster({
            stream: "theorem",
            runId: "theorem_rebracket_sim",
            problem: "Prove P -> P while reconciling three explorer strategies.",
            config: { rounds: 2, maxDepth: 2, memoryWindow: 60, branchThreshold: 2 },
            runtime,
            prompts: loadTheoremPrompts(),
            llmText: rebracketTheoremText,
            model: "test-model",
            apiReady: true,
            createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
          });
          await task.checkpoint("rebracket:run:done");
        },
      },
    ] as const);

    if (result.isErr()) throw result.error;

    const runStream = theoremRunStream("theorem", "theorem_rebracket_sim");
    const mainChain = await runtime.chain(runStream);
    const roundOneCutoff = mainChain.findIndex((entry) =>
      entry.body.type === "rebracket.applied"
      && /round r1:/i.test(entry.body.note ?? "")
    );
    assert.ok(roundOneCutoff >= 0, "missing round 1 rebracket receipt");

    const roundOneMain = mainChain.slice(0, roundOneCutoff + 1);
    const roundOneRebracket = roundOneMain[roundOneCutoff]?.body;
    assert.equal(roundOneRebracket?.type, "rebracket.applied");
    const expectedRoundOneBracket = roundOneRebracket.bracket;
    assert.ok(parseCompositionBracket(expectedRoundOneBracket));
    assert.match(roundOneRebracket.note ?? "", /associator/i);
    assert.match(roundOneRebracket.note ?? "", /round r1: score=/);

    const phases = mainChain
      .filter((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "task.graph.projected" }> } =>
        entry.body.type === "task.graph.projected"
      )
      .flatMap((entry) => entry.body.graph.tasks
        .filter((task) => /:r1:/.test(task.taskId))
        .map((task) => task.taskId.split(":", 1)[0]))
      .filter((phase, index, all) => all.indexOf(phase) === index);
    assert.deepEqual(
      phases.filter((phase) => phase === "attempt" || phase === "critique" || phase === "patch"),
      ["attempt", "critique", "patch"],
      "round 1 should run attempt, critique, and patch phases"
    );

    const scoredCandidates = mainChain.filter((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "merge.candidate.scored" }> } =>
      entry.body.type === "merge.candidate.scored"
    );
    assert.ok(scoredCandidates.length >= 1, "expected selected local rotation scoring receipt");
    assert.ok(
      scoredCandidates.some((entry) => entry.body.candidateId === expectedRoundOneBracket),
      "expected selected rebracket candidate to be scored"
    );

    const roundTwoPlan = mainChain.find((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "merge.frontier.selected" }> } =>
      entry.body.type === "merge.frontier.selected" && entry.body.round === 2
    );
    assert.ok(roundTwoPlan, "round 2 merge plan missing");
    const roundOneTree = parseCompositionBracket(expectedRoundOneBracket);
    const roundTwoTree = parseCompositionBracket(roundTwoPlan.body.bracket);
    assert.ok(roundOneTree && roundTwoTree);
    assert.ok(compositionLeaves(roundTwoTree).length >= compositionLeaves(roundOneTree).length);
    const roundTwoSummaries = mainChain.filter((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "summary.made" }> } =>
      entry.body.type === "summary.made"
      && /merge_r2_/i.test(entry.body.claimId)
    );
    assert.ok(
      roundTwoSummaries.some((entry) => entry.body.bracket === roundTwoPlan.body.bracket),
      "round 2 should merge with the reflected topology"
    );

    const finalStatus = mainChain.findLast((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "run.status" }> } =>
      entry.body.type === "run.status"
    );
    assert.equal(finalStatus?.body.status, "completed");
  } finally {
    if (oldPassK === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = oldPassK;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
