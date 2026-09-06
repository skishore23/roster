import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { mapWithConcurrency, normalizeTheoremConfig, runTheoremRoster } from "../../src/agents/theorem.ts";
import { theoremBranchStream, theoremRunStream } from "../../src/agents/theorem.streams.ts";
import { receipt } from "../../src/core/chain.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { Chain } from "../../src/core/types.ts";
import { buildVersionedMergePlan } from "../../src/engine/merge/versioned-contract.ts";
import { certifyComposition, createCompositionProposal } from "../../src/engine/orchestration/composition.ts";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import { ROSTER_NODE_TASK_HANDLER } from "../../src/engine/platform/roster-platform.ts";
import type { LlmTextRequest } from "../../src/engine/runtime/model.ts";
import {
  deriveTheoremNodeDemands,
  materializeTheoremNode,
  theoremAdaptiveDomain,
} from "../../src/domains/theorem.ts";
import { reflectOnOrchestration } from "../../src/engine/orchestration/adaptive.ts";
import { balancedCompositionTree, compositionBracket, compositionLeaves } from "../../src/engine/orchestration/topology.ts";
import {
  decide as decideTheorem,
  initial as initialTheorem,
  reduce as reduceTheorem,
  type TheoremCmd,
  type TheoremEvent,
  type TheoremState,
} from "../../src/modules/theorem.ts";
import {
  compositionCertifiedEvent,
  compositionProposedEvent,
  orchestrationConfiguredEvent,
  reflectionRecordedEvent,
  taskGraphProjectedEvent,
  topologySelectedEvent,
} from "../../src/modules/orchestration.ts";
import { createTestTheoremExecutionPlanes } from "../support/theorem-platform.ts";
import { loadTheoremPrompts } from "../../src/prompts/theorem.ts";
import { theoremChatHtml } from "../../src/views/theorem.ts";

const deterministicTheoremText = async (opts: { readonly user: string }): Promise<string> => {
  const user = opts.user;
  if (user.includes("\"action\": \"continue\" | \"done\"")) {
    return JSON.stringify({
      action: "continue",
      reason: "exercise the complete collaboration path",
      skip_lemma: false,
      skip_critique: false,
      skip_patch: false,
      skip_merge: false,
      focus: {},
    });
  }
  if (user.includes("\"attempt\": \"full attempt text\"")) {
    return JSON.stringify({
      attempt: "Assume P and return that assumption to establish P implies P.",
      lemmas: ["identity implication"],
      gaps: [],
    });
  }
  if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
    return JSON.stringify({
      lemmas: [{ label: "L1", statement: "P implies P", usage: "all explorer branches" }],
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

test("theorem population follows objective demand instead of a roster size", () => {
  const simple = deriveTheoremNodeDemands("Prove P implies P.", 8);
  const complex = deriveTheoremNodeDemands(
    "For every recursive integer sequence, prove termination by an invariant and induction, construct a witness, and formalize the theorem in Lean.",
    8
  );
  const simpleExplorers = simple.filter((demand) => demand.role === "explorer");
  const complexExplorers = complex.filter((demand) => demand.role === "explorer");
  const explicitlyRequested = deriveTheoremNodeDemands(
    "Prove P implies P while reconciling three explorer strategies.",
    8
  ).filter((demand) => demand.role === "explorer");
  const pythagoras = deriveTheoremNodeDemands("prove Pythagoras theorem", 3)
    .filter((demand) => demand.role === "explorer");
  assert.equal(simpleExplorers.length, 1);
  assert.equal(complexExplorers.length, 4);
  assert.equal(explicitlyRequested.length, 3);
  assert.equal(pythagoras.length, 1, "the word theorem must not fill the parallelism cap");
  assert.equal(new Set(complexExplorers.map((demand) => demand.focus)).size, complexExplorers.length);
  assert.equal(normalizeTheoremConfig({ maxParallel: 0 }).maxParallel, 1);

  const domain = theoremAdaptiveDomain(4);
  assert.deepEqual(domain.pack.nodes.map((node) => node.id), ["orchestrator"]);
  const reflection = reflectOnOrchestration({
    runId: "population",
    policyId: "theorem-population",
    policyVersion: domain.pack.policyVersion,
    iteration: 1,
    observation: {
      activeNodes: 1,
      pendingTasks: complex.length,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 0,
      evidenceGaps: complex.length,
      stagnationRounds: 0,
      goalSatisfied: false,
    },
    maxNodes: domain.pack.limits.maxNodes,
    unmetDemands: complex,
  });
  const spawned = reflection.actions
    .filter((action) => action.type === "spawn")
    .map((action, index) => action.type === "spawn" ? materializeTheoremNode({
      runId: "population",
      reflectionId: reflection.reflectionId,
      index,
      demand: action.demand as (typeof complex)[number],
    }) : undefined)
    .filter((agent) => agent !== undefined);
  assert.equal(spawned.length, complex.length);
  assert.equal(new Set(spawned.map((agent) => agent.id)).size, spawned.length);
  assert.doesNotMatch(loadTheoremPrompts().user.orchestrate, /explorer_[abc]/);
});

test("orchestrator can grow a minimal theorem team without filling the parallel cap", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-orchestrator-growth-"));
  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      memoryStore<TheoremEvent>(),
      memoryBranchStore(),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const llmText = async (opts: LlmTextRequest): Promise<string> => {
      if (opts.user.includes("\"action\": \"continue\" | \"done\"")) {
        const initialDecision = opts.user.includes("Attempts:\n(none yet)");
        return JSON.stringify({
          action: initialDecision ? "continue" : "done",
          reason: initialDecision ? "Two independent geometric routes are useful." : "The routes are sufficient.",
          skip_lemma: false,
          skip_critique: false,
          skip_patch: false,
          skip_merge: false,
          spawn: initialDecision
            ? [{ focus: "Use similar triangles." }, { focus: "Use a dissection argument." }]
            : [],
          focus: {},
        });
      }
      if (opts.user.includes("\"attempt\": \"full attempt text\"")) {
        return JSON.stringify({ attempt: "A bounded Pythagoras route.", lemmas: [], gaps: [] });
      }
      if (opts.user.includes("\"status\": \"valid | needs | false\"")) {
        return JSON.stringify({ status: "valid", notes: ["Valid."] });
      }
      if (opts.user.includes("\"proof\": \"final proof text\"")) {
        return JSON.stringify({ proof: "A complete Pythagoras proof.", confidence: 0.8, gaps: [] });
      }
      return "{}";
    };
    const runId = "orchestrator_growth";
    const runStream = theoremRunStream("theorem", runId);
    await runTheoremRoster({
      stream: "theorem",
      runId,
      problem: "prove Pythagoras theorem",
      config: normalizeTheoremConfig({ rounds: 1, maxParallel: 5 }),
      runtime,
      prompts: loadTheoremPrompts(),
      llmText,
      model: "test-model",
      apiReady: true,
      createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
    });

    const chain = await runtime.chain(runStream);
    const explorers = chain.filter(
      (entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "node.spawned" }> } =>
        entry.body.type === "node.spawned" && entry.body.node.metadata?.role === "explorer"
    );
    assert.equal(explorers.length, 3);
    assert.ok(chain.some((entry) =>
      entry.body.type === "reflection.recorded" && entry.body.policyId === "theorem-orchestrator-population"
    ));
    assert.equal(chain.filter((entry) => entry.body.type === "topology.selected" && entry.body.operation === "graft").length, 2);
    assert.equal((await runtime.state(runStream)).status, "completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("simple theorem runs spawn roles on demand and expose model trust, gaps, and usage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-demand-theorem-"));
  const dataDir = path.join(dir, "data");
  await fs.mkdir(dataDir, { recursive: true });

  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      memoryStore<TheoremEvent>(),
      memoryBranchStore(),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const llmText = async (opts: LlmTextRequest): Promise<string> => {
      await opts.onUsage?.({
        model: "test-model",
        inputTokens: 6,
        cachedInputTokens: 0,
        outputTokens: 4,
        reasoningTokens: 0,
        totalTokens: 10,
      });
      if (opts.user.includes("\"action\": \"continue\" | \"done\"")) {
        return JSON.stringify({
          action: "done",
          reason: "The direct argument is sufficient.",
          skip_lemma: false,
          skip_critique: false,
          skip_patch: false,
          skip_merge: false,
          focus: {},
        });
      }
      if (opts.user.includes("\"attempt\": \"full attempt text\"")) {
        return JSON.stringify({
          attempt: "Assume P. The assumption itself proves P.",
          lemmas: [],
          gaps: [],
        });
      }
      if (opts.user.includes("\"status\": \"valid | needs | false\"")) {
        return JSON.stringify({ status: "valid", notes: ["The argument is valid as written."] });
      }
      if (opts.user.includes("\"proof\": \"final proof text\"")) {
        return JSON.stringify({
          proof: "Assume P. Then P follows from the assumption.",
          confidence: 0.9,
          gaps: ["No formal proof artifact was produced."],
        });
      }
      return "{}";
    };

    const runId = "demand_driven_simple";
    const runStream = theoremRunStream("theorem", runId);
    await runTheoremRoster({
      stream: "theorem",
      runId,
      problem: "Prove P implies P.",
      config: normalizeTheoremConfig({ rounds: 3, maxParallel: 8 }),
      runtime,
      prompts: loadTheoremPrompts(),
      llmText,
      model: "test-model",
      apiReady: true,
      createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
    });

    const chain = await runtime.chain(runStream);
    const state = await runtime.state(runStream);
    const spawnedRoles = chain
      .filter((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "node.spawned" }> } =>
        entry.body.type === "node.spawned")
      .map((entry) => entry.body.node.metadata?.role);
    assert.deepEqual(new Set(spawnedRoles), new Set(["explorer", "synthesizer", "verifier"]));
    assert.equal(chain.some((entry) => entry.body.type === "lemma.proposed"), false);
    assert.equal(chain.some((entry) => entry.body.type === "critique.raised"), false);
    assert.equal(chain.some((entry) => entry.body.type === "patch.applied"), false);
    assert.equal(chain.some((entry) => entry.body.type === "merge.frontier.selected"), false);

    assert.equal(state.status, "completed");
    assert.equal(state.verification?.status, "valid");
    assert.equal(state.verification?.trust, "model");
    assert.deepEqual(state.solution?.gaps, ["No formal proof artifact was produced."]);
    const usage = chain.filter(
      (entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "model.usage" }> } =>
        entry.body.type === "model.usage"
    );
    assert.ok(usage.length > 0);
    assert.equal(usage.reduce((total, entry) => total + entry.body.totalTokens, 0), usage.length * 10);
    const finalProposal = chain.find((entry) =>
      entry.body.type === "composition.proposed" && entry.body.compositionId === "theorem.final"
    );
    assert.ok(finalProposal && finalProposal.body.type === "composition.proposed");
    assert.deepEqual(finalProposal.body.evidence.map((item) => item.kind), ["model-verification"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("theorem run contracts one malformed explorer and completes from surviving branches", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-resilient-theorem-"));
  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      memoryStore<TheoremEvent>(),
      memoryBranchStore(),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const llmText = async (opts: LlmTextRequest): Promise<string> => {
      if (opts.user.includes("\"action\": \"continue\" | \"done\"")) {
        return JSON.stringify({
          action: "done",
          reason: "Surviving direct routes are sufficient.",
          skip_lemma: false,
          skip_critique: false,
          skip_patch: false,
          skip_merge: false,
          spawn: [],
          focus: {},
        });
      }
      if (opts.user.includes("\"attempt\": \"full attempt text\"")) {
        if (opts.system?.includes("Explorer B")) return "malformed branch output";
        return JSON.stringify({
          attempt: "A valid independent route.",
          lemmas: [],
          gaps: [],
        });
      }
      if (opts.user.includes("\"status\": \"valid | needs | false\"")) {
        return JSON.stringify({ status: "valid", notes: ["The surviving route is valid."] });
      }
      if (opts.user.includes("\"proof\": \"final proof text\"")) {
        return JSON.stringify({ proof: "A complete proof from surviving routes.", confidence: 0.8, gaps: [] });
      }
      return "{}";
    };

    const runId = "resilient_explorer_failure";
    const runStream = theoremRunStream("theorem", runId);
    await runTheoremRoster({
      stream: "theorem",
      runId,
      problem: "Prove a claim using three explorer strategies.",
      config: normalizeTheoremConfig({ rounds: 1, maxParallel: 3 }),
      runtime,
      prompts: loadTheoremPrompts(),
      llmText,
      model: "test-model",
      apiReady: true,
      createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
    });

    const chain = await runtime.chain(runStream);
    const state = await runtime.state(runStream);
    assert.equal(state.status, "completed");
    assert.equal(chain
      .filter((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "task.graph.projected" }> } =>
        entry.body.type === "task.graph.projected")
      .reduce((total, entry) =>
        total + entry.body.graph.tasks.filter((task) => task.status === "failed").length, 0), 1);
    assert.equal(chain.filter((entry) => entry.body.type === "node.retired").length, 1);
    assert.equal(chain.some((entry) => entry.body.type === "topology.selected" && entry.body.operation === "contract"), true);
    assert.equal(chain.some((entry) => entry.body.type === "composition.certified" && entry.body.compositionId === "theorem.final"), true);
    const activeExplorers = Object.values(state.orchestration.nodes).filter((node) =>
      node.metadata?.role === "explorer" && node.status === "active"
    );
    assert.equal(activeExplorers.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("theorem preserves one budget_exhausted failure instead of replacing it with runtime_error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-budget-theorem-"));
  const previous = process.env.ROSTER_MAX_LLM_CALLS;
  process.env.ROSTER_MAX_LLM_CALLS = "1";
  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      memoryStore<TheoremEvent>(),
      memoryBranchStore(),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    const runId = "budget_failure_identity";
    const runStream = theoremRunStream("theorem", runId);
    const result = await runTheoremRoster({
      stream: "theorem",
      runId,
      problem: "Prove P implies P.",
      config: normalizeTheoremConfig({ rounds: 1, maxParallel: 1 }),
      runtime,
      prompts: loadTheoremPrompts(),
      llmText: async () => JSON.stringify({
        action: "continue",
        reason: "Begin the first route.",
        skip_lemma: false,
        skip_critique: false,
        skip_patch: false,
        skip_merge: false,
        spawn: [],
        focus: {},
      }),
      model: "test-model",
      apiReady: true,
      createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
    });

    const chain = await runtime.chain(runStream);
    const failures = chain.filter((entry) => entry.body.type === "failure.report");
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.failureClass, "budget_exhausted");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.body.type === "failure.report" && failures[0].body.failure.failureClass, "budget_exhausted");
  } finally {
    if (previous === undefined) delete process.env.ROSTER_MAX_LLM_CALLS;
    else process.env.ROSTER_MAX_LLM_CALLS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("dynamic agent execution respects the configured concurrency boundary", async () => {
  let active = 0;
  let peak = 0;
  const output = await mapWithConcurrency(
    Array.from({ length: 20 }, (_, index) => index),
    4,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value % 3));
      active -= 1;
      return value * 2;
    }
  );
  assert.equal(peak, 4);
  assert.deepEqual(output, Array.from({ length: 20 }, (_, index) => index * 2));
});

test("bounded execution drains active workers before propagating an injected failure", async () => {
  const started: number[] = [];
  let active = 0;
  await assert.rejects(
    mapWithConcurrency(Array.from({ length: 10 }, (_, index) => index), 3, async (value) => {
      started.push(value);
      active += 1;
      try {
        if (value === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw new Error("injected worker failure");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return value;
      } finally {
        active -= 1;
      }
    }),
    /injected worker failure/
  );
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(active, 0);
});

test("replaying the same theorem merge plan does not erase domain summaries", () => {
  const plan = buildVersionedMergePlan({
    runId: "replayed-plan",
    round: 1,
    bracket: "((A o B) o (C o D))",
    tree: [["A", "B"], ["C", "D"]],
    maxDepth: 2,
    sourceVersions: {
      "pod:A": "a1",
      "pod:B": "b1",
      "pod:C": "c1",
      "pod:D": "d1",
    },
  });
  const step = plan.steps[0];
  assert.ok(step);
  const planEvent: TheoremEvent = {
    type: "merge.frontier.selected",
    runId: "replayed-plan",
    agentId: "orchestrator",
    planVersion: plan.planVersion,
    round: plan.round,
    bracket: plan.bracket,
    sourceVersions: plan.sourceVersions,
    steps: plan.steps,
  };
  let state = reduceTheorem(initialTheorem, planEvent, 1);
  state = reduceTheorem(state, {
    type: "summary.made",
    runId: "replayed-plan",
    agentId: "synthesizer",
    claimId: "output-1",
    bracket: step.bracket,
    content: "left-output",
    uses: ["a", "b"],
  }, 2);
  state = reduceTheorem(state, planEvent, 3);
  assert.equal(state.summaries["output-1"]?.content, "left-output");
});

test("theorem UI projects spawned agents, topology, active tasks, and merge conflicts", () => {
  const stream = "agents/theorem/runs/dynamic_ui";
  const runId = "dynamic_ui";
  const domain = theoremAdaptiveDomain(4);
  const demands = deriveTheoremNodeDemands("Prove a hard theorem using induction and an invariant.", 4);
  const agents = demands.map((demand, index) => materializeTheoremNode({
    runId,
    reflectionId: "reflection_ui",
    index,
    demand,
  }));
  const registry = domain.registry.extendNodes(agents);
  const explorer = agents.find((agent) => agent.role === "explorer");
  const synthesizer = agents.find((agent) => agent.role === "synthesizer");
  assert.ok(explorer && synthesizer);
  const tree = balancedCompositionTree([
    ...agents.filter((agent) => agent.role === "explorer").map((agent) => agent.id),
    "review",
  ]);
  const plan = buildVersionedMergePlan({
    runId,
    round: 1,
    bracket: compositionBracket(tree),
    tree,
    maxDepth: 2,
    sourceVersions: Object.fromEntries(compositionLeaves(tree).map((leaf) => [`pod:${leaf}`, `${leaf}-v1`])),
    leafLabel: (leaf) => leaf === "review" ? "Review and synthesis" : agents.find((agent) => agent.id === leaf)?.name ?? leaf,
  });
  const first = plan.steps[0];
  const second = plan.steps[1];
  assert.ok(first && second);
  const inputVersions = { left: "a1", right: "b1" };
  const proposal = createCompositionProposal({
    compositionId: first.mergeId,
    planVersion: plan.planVersion,
    nodeId: synthesizer.id,
    capability: "compose",
    boundaryHash: first.boundaryHash,
    inputVersions,
    content: "left-v1",
    evidence: [],
  });
  const certification = certifyComposition({
    registry,
    contract: {
      compositionId: first.mergeId,
      planVersion: plan.planVersion,
      boundaryHash: first.boundaryHash,
      inputVersions,
    },
    proposal,
  });
  assert.equal(certification.ok, true);
  if (!certification.ok) return;
  const taskDefinition = createDynamicTaskDefinition({
    taskId: `attempt:r1:${explorer.id}`,
    semanticKey: `attempt:r1:${explorer.id}`,
    nodeId: explorer.id,
    capability: "solve",
    objective: "Develop an independent proof route.",
    handler: ROSTER_NODE_TASK_HANDLER,
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: { mode: "none" },
    dependencies: [],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: {},
      dataReferences: [],
      frontierVersion: "frontier-r1",
      topologyVersion: "topology-r1",
      catalogVersion: "theorem@3",
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 1, maximumBackoffMs: 1 },
    timeoutMs: 30_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });
  let prev: string | undefined;
  let ts = 0;
  const emit = (body: TheoremEvent) => {
    ts += 1;
    const next = receipt(stream, prev, body, ts);
    prev = next.hash;
    return next;
  };
  const chain: Chain<TheoremEvent> = [
    emit({ type: "problem.set", runId, problem: "Prove a hard theorem.", agentId: "orchestrator" }),
    emit(orchestrationConfiguredEvent(runId, domain.pack)),
    ...agents.map((node) => emit({ type: "node.spawned", runId, node, reason: "objective demand" })),
    emit(topologySelectedEvent({
      runId,
      operation: "initialize",
      bracket: compositionBracket(tree),
      leaves: compositionLeaves(tree),
      reason: "adaptive frontier",
    })),
    emit(reflectionRecordedEvent(runId, reflectOnOrchestration({
      runId,
      policyId: "theorem-test",
      policyVersion: domain.pack.policyVersion,
      iteration: 1,
      observation: {
        activeNodes: agents.length + 1,
        pendingTasks: 1,
        runningTasks: 0,
        failedTasks: 0,
        conflicts: 0,
        evidenceGaps: 1,
        stagnationRounds: 0,
        goalSatisfied: false,
      },
      maxNodes: domain.pack.limits.maxNodes,
      topology: tree,
    }))),
    emit({ type: "run.status", runId, status: "running", agentId: "orchestrator" }),
    emit(taskGraphProjectedEvent(runId, {
      runId,
      policy: {
        maxTasks: 16,
        maxDepth: 4,
        maxFanout: 4,
        maxInflight: 2,
        maxReady: 16,
        maxBlocked: 16,
        maxAttempts: 1,
        maxContextBytes: 1_000_000,
        maxCostMicros: 1_000_000,
        maxTokens: 100_000,
        maxWallTimeMs: 30_000,
      },
      tasks: [{
        definition: taskDefinition,
        status: "running",
        attempt: 1,
        leaseFence: 1,
        leaseOwner: "test-dispatcher",
      }],
      expansions: [],
      acceptedCostMicros: 0,
      acceptedTokens: 0,
      outcomeDataReferences: [],
    })),
    emit({
      type: "merge.frontier.selected",
      runId,
      agentId: "orchestrator",
      planVersion: plan.planVersion,
      round: plan.round,
      bracket: plan.bracket,
      sourceVersions: plan.sourceVersions,
      steps: plan.steps,
    }),
    emit(compositionProposedEvent(runId, proposal)),
    emit(compositionCertifiedEvent(runId, certification.certification)),
    emit({
      type: "composition.rejected",
      runId,
      compositionId: second.mergeId,
      reason: "stale_plan",
      detail: "composition boundary changed",
    }),
    emit({
      type: "subagent.merged",
      runId,
      agentId: "orchestrator",
      subJobId: "axiom-job-failed",
      subRunId: "axiom-run-failed",
      task: "Verify the candidate",
      summary: "status: failed",
      outcome: "failed",
    }),
    emit({
      type: "model.usage",
      runId,
      call: 1,
      model: "test-model",
      inputTokens: 80,
      cachedInputTokens: 0,
      outputTokens: 40,
      reasoningTokens: 0,
      totalTokens: 120,
    }),
  ];

  const html = theoremChatHtml(chain);
  assert.match(html, new RegExp(`<dt>Members<\\/dt><dd>${agents.length + 1}<\\/dd>`));
  assert.match(html, /Explorer 1/);
  assert.match(html, /Independent proof routes/);
  assert.match(html, /Review and synthesis/);
  assert.match(html, /Reflection/);
  assert.match(html, /Iteration 1/);
  assert.match(html, new RegExp(`K<sub>${compositionLeaves(tree).length}<\\/sub>`));
  assert.match(html, /Attempt R1 Solve/);
  assert.match(html, /data-status="running"/);
  assert.match(html, /certified/);
  assert.match(html, /composition boundary changed/);
  assert.match(html, /<dt>Degraded<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Tokens<\/dt><dd>120<\/dd>/);
  assert.match(html, /Delegated Axiom Run Failed/);
  assert.match(html, /data-status="failed"/);
  assert.doesNotMatch(html, /team\.configured|agent\.status|merge\.output/);
});

test("adaptive theorem run keeps execution bounded and applies every planned composition exactly once", { timeout: 120_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-dynamic-theorem-"));
  const dataDir = path.join(dir, "data");
  await fs.mkdir(dataDir, { recursive: true });

  try {
    const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
      memoryStore<TheoremEvent>(),
      memoryBranchStore(),
      decideTheorem,
      reduceTheorem,
      initialTheorem
    );
    let activeAttemptCalls = 0;
    let peakAttemptCalls = 0;
    const llmText = async (opts: { readonly system?: string; readonly user: string }): Promise<string> => {
      const isAttempt = opts.user.includes("\"attempt\": \"full attempt text\"");
      if (isAttempt) {
        activeAttemptCalls += 1;
        peakAttemptCalls = Math.max(peakAttemptCalls, activeAttemptCalls);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      try {
        return await deterministicTheoremText(opts);
      } finally {
        if (isAttempt) activeAttemptCalls -= 1;
      }
    };

    const runId = "adaptive_agent_contract";
    const runStream = theoremRunStream("theorem", runId);
    await runTheoremRoster({
      stream: "theorem",
      runId,
      problem: "For a recursive integer process, prove termination using an invariant and induction, then formalize the theorem in Lean.",
      config: {
        rounds: 1,
        maxDepth: 2,
        memoryWindow: 60,
        branchThreshold: 2,
        maxParallel: 4,
      },
      runtime,
      prompts: loadTheoremPrompts(),
      llmText,
      model: "test-model",
      apiReady: true,
      createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
    });

    const main = await runtime.chain(runStream);
    const teamReceipt = main.find(
      (entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "orchestration.configured" }> } =>
        entry.body.type === "orchestration.configured"
    );
    assert.ok(teamReceipt, "missing adaptive domain receipt");
    assert.deepEqual(teamReceipt.body.nodes.map((node) => node.id), ["orchestrator"]);
    assert.equal(teamReceipt.body.limits.maxParallel, 4);

    const spawned = main
      .filter((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "node.spawned" }> } =>
        entry.body.type === "node.spawned")
      .map((entry) => entry.body.node);
    const explorerIds = spawned.filter((agent) => agent.metadata?.role === "explorer").map((agent) => agent.id);
    assert.ok(explorerIds.length >= 3);
    assert.ok(spawned.some((agent) => agent.metadata?.role === "critic"));
    const branchChains = await Promise.all(
      explorerIds.map((agentId) => runtime.chain(theoremBranchStream(runStream, agentId)))
    );
    const attempts = branchChains.flat().filter((entry) => entry.body.type === "attempt.proposed");
    assert.equal(attempts.length, explorerIds.length);
    assert.equal(new Set(attempts.map((entry) => entry.body.agentId)).size, explorerIds.length);
    assert.equal(peakAttemptCalls, explorerIds.length);

    const attemptGraphs = main
      .filter((entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "task.graph.projected" }> } =>
        entry.body.type === "task.graph.projected")
      .map((entry) => entry.body.graph.tasks.filter((task) => task.taskId.startsWith("attempt:")))
      .filter((tasks) => tasks.length > 0);
    assert.ok(attemptGraphs.length > 0);
    assert.ok(attemptGraphs.every((tasks) => tasks.length <= 4));
    assert.ok(attemptGraphs.some((tasks) => tasks.every((task) => task.status === "accepted")));

    const planReceipt = main.find(
      (entry): entry is typeof entry & { body: Extract<TheoremEvent, { type: "merge.frontier.selected" }> } =>
        entry.body.type === "merge.frontier.selected"
    );
    assert.ok(planReceipt, "missing merge plan receipt");
    const topology = main.find((entry) => entry.body.type === "topology.selected");
    assert.ok(topology && topology.body.type === "topology.selected");
    assert.equal(topology.body.leaves.length, explorerIds.length + 1);
    assert.ok(main.some((entry) => entry.body.type === "reflection.recorded"));
    const mergeIds = new Set(planReceipt.body.steps.map((step) => step.mergeId));
    const proposed = main.filter((entry) =>
      entry.body.type === "composition.proposed" && mergeIds.has(entry.body.compositionId)
    );
    const applied = main.filter((entry) =>
      entry.body.type === "composition.certified" && mergeIds.has(entry.body.compositionId)
    );
    const rejected = main.filter((entry) =>
      entry.body.type === "composition.rejected" && mergeIds.has(entry.body.compositionId)
    );
    assert.equal(proposed.length, planReceipt.body.steps.length);
    assert.equal(applied.length, planReceipt.body.steps.length);
    assert.equal(new Set(applied.map((entry) => entry.body.compositionId)).size, applied.length);
    assert.equal(rejected.length, 0);
    assert.ok(main.some((entry) => entry.body.type === "solution.finalized"));
    assert.ok(main.some((entry) => entry.body.type === "run.status" && entry.body.status === "completed"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
