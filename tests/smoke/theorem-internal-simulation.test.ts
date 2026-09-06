import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  RecordingEntropySource,
  ReplayingEntropySource,
  type EntropySource,
} from "determined";

import { runTheoremRoster } from "../../src/agents/theorem.ts";
import type {
  TheoremPlatformTaskRuntime,
  TheoremTaskExecutionControl,
  TheoremTaskExecutionDetails,
} from "../../src/agents/theorem.platform.ts";
import { theoremRunStream } from "../../src/agents/theorem.streams.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import type { Branch, BranchStore, Receipt, Store } from "../../src/core/types.ts";
import { compositionLeaves, parseCompositionBracket } from "../../src/engine/orchestration/topology.ts";
import {
  decide as decideTheorem,
  initial as initialTheorem,
  reduce as reduceTheorem,
  type TheoremCmd,
  type TheoremEvent,
  type TheoremState,
} from "../../src/modules/theorem.ts";
import { loadTheoremPrompts } from "../../src/prompts/theorem.ts";
import { createTestTheoremExecutionPlanes } from "../support/theorem-platform.ts";

class SeededEntropySource implements EntropySource {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x6d2b79f5;
  }

  random(_reason: string): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

const hashJson = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

const createMemoryPersistence = <Event>() => {
  const chains = new Map<string, Receipt<Event>[]>();
  const branches = new Map<string, Branch>();
  const store: Store<Event> = {
    append: async (entry) => {
      const chain = chains.get(entry.stream) ?? [];
      chain.push(entry);
      chains.set(entry.stream, chain);
    },
    read: async (stream) => [...(chains.get(stream) ?? [])],
    take: async (stream, count) => (chains.get(stream) ?? []).slice(0, count),
    count: async (stream) => (chains.get(stream) ?? []).length,
    head: async (stream) => (chains.get(stream) ?? []).at(-1),
  };
  const branchStore: BranchStore = {
    save: async (branch) => {
      branches.set(branch.name, { ...branch });
    },
    get: async (name) => branches.get(name),
    list: async () => [...branches.values()].sort((left, right) => left.name.localeCompare(right.name)),
    children: async (parent) => [...branches.values()]
      .filter((branch) => branch.parent === parent)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  return { store, branchStore };
};

type FaultSpec = {
  readonly phase: string;
  readonly boundary: string;
  readonly match?: TheoremTaskExecutionDetails;
};

type DuplicateSpec = {
  readonly phase: string;
  readonly actor: string;
};

type SimulationTrace = {
  readonly seq: number;
  readonly kind: "checkpoint" | "failpoint" | "slot";
  readonly phase: string;
  readonly actor: string;
  readonly boundary: string;
  readonly details?: TheoremTaskExecutionDetails;
};

type ExecutorSnapshot = {
  readonly trace: ReadonlyArray<SimulationTrace>;
  readonly phasePeaks: Readonly<Record<string, number>>;
  readonly faultMatches: number;
  readonly duplicateSchedules: number;
};

const matchesFault = (
  fault: FaultSpec | undefined,
  phase: string,
  boundary: string,
  details?: TheoremTaskExecutionDetails,
): boolean => {
  if (!fault || fault.phase !== phase || boundary !== fault.boundary) return false;
  if (!fault.match) return true;
  if (!details) return false;
  return Object.entries(fault.match).every(([key, value]) =>
    value === "*" || details[key] === value);
};

const createDeterminedTaskRuntime = (opts: {
  readonly entropy: EntropySource;
  readonly fault?: FaultSpec;
  readonly duplicate?: DuplicateSpec;
}): { readonly execute: TheoremPlatformTaskRuntime; readonly snapshot: () => ExecutorSnapshot } => {
  const trace: SimulationTrace[] = [];
  const phasePeaks: Record<string, number> = {};
  const activeByPhase: Record<string, number> = {};
  let seq = 0;
  let faultMatches = 0;
  let duplicateSchedules = 0;

  const record = (
    kind: SimulationTrace["kind"],
    phase: string,
    actor: string,
    boundary: string,
    details?: TheoremTaskExecutionDetails
  ) => {
    seq += 1;
    trace.push({ seq, kind, phase, actor, boundary, ...(details ? { details: { ...details } } : {}) });
  };

  const yieldForSchedule = async (reason: string): Promise<void> => {
    const turns = Math.floor(opts.entropy.random(reason) * 5);
    for (let turn = 0; turn < turns; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const execute: TheoremPlatformTaskRuntime = async (input) => {
    const runOnce = async <Output>(
      actor: string,
      run: (control: TheoremTaskExecutionControl) => Promise<Output>,
    ): Promise<Output> => {
      await yieldForSchedule(
        `theorem:${input.phase}:${input.round ?? 0}:${actor}:start`,
      );
      const active = (activeByPhase[input.phase] ?? 0) + 1;
      activeByPhase[input.phase] = active;
      phasePeaks[input.phase] = Math.max(phasePeaks[input.phase] ?? 0, active);
      record("slot", input.phase, actor, "slot.acquired", { active });
      const boundary = async (
        kind: "checkpoint" | "failpoint",
        name: string,
        details?: TheoremTaskExecutionDetails,
      ): Promise<void> => {
        record(kind, input.phase, actor, name, details);
        await yieldForSchedule(
          `theorem:${input.phase}:${input.round ?? 0}:${actor}:${kind}:${name}`,
        );
        if (matchesFault(opts.fault, input.phase, name, details)) {
          faultMatches += 1;
          throw new Error(`injected theorem task fault at ${input.phase}.${name}`);
        }
      };
      const control: TheoremTaskExecutionControl = {
        checkpoint: (name, details) => boundary("checkpoint", name, details),
        failpoint: (name, details) => boundary("failpoint", name, details),
      };
      try {
        return await run(control);
      } finally {
        const remaining = Math.max(0, (activeByPhase[input.phase] ?? 1) - 1);
        activeByPhase[input.phase] = remaining;
        record("slot", input.phase, actor, "slot.released", { active: remaining });
      }
    };

    const primary = await runOnce(input.actor, input.run);
    if (
      opts.duplicate?.phase === input.phase
      && (
        input.actor === opts.duplicate.actor
        || input.actor.endsWith(`:${opts.duplicate.actor}`)
      )
    ) {
      duplicateSchedules += 1;
      await runOnce(`${input.actor}#duplicate`, input.run);
    }
    return primary;
  };

  return {
    execute,
    snapshot: () => ({
      trace: trace.map((entry) => ({ ...entry, ...(entry.details ? { details: { ...entry.details } } : {}) })),
      phasePeaks: { ...phasePeaks },
      faultMatches,
      duplicateSchedules,
    }),
  };
};

const deterministicTheoremText = async (opts: { readonly user: string }): Promise<string> => {
  const user = opts.user;
  if (user.includes("\"action\": \"continue\" | \"done\"")) {
    return JSON.stringify({
      action: "continue",
      reason: "exercise all collaboration phases",
      skip_lemma: false,
      skip_critique: false,
      skip_patch: false,
      skip_merge: false,
      focus: {},
    });
  }
  if (user.includes("\"attempt\": \"full attempt text\"")) {
    return JSON.stringify({
      attempt: "Assume P, then return that assumption to establish P implies P.",
      lemmas: ["identity implication"],
      gaps: ["make implication introduction explicit"],
      axiom_task: "Check this identity-implication branch.",
    });
  }
  if (user.includes("\"lemmas\": [") && user.includes("\"statement\"")) {
    return JSON.stringify({
      lemmas: [{ label: "L1", statement: "P implies P", usage: "all explorer branches" }],
    });
  }
  if (user.includes("\"issues\": [")) {
    return JSON.stringify({
      issues: [{ ref: "attempt", detail: "Make assumption discharge explicit.", severity: "minor" }],
      summary: "The route is valid after an explicit implication-introduction step.",
    });
  }
  if (user.includes("\"patch\": \"patched proof text\"")) {
    return JSON.stringify({
      patch: "Discharge the assumption explicitly after returning P.",
      remaining_gaps: [],
    });
  }
  if (user.includes("\"summary\": \"merged summary\"")) {
    return JSON.stringify({ summary: "Merged identity proof with explicit assumption discharge.", gaps: [] });
  }
  if (user.includes("\"status\": \"valid | needs | false\"")) {
    return JSON.stringify({
      status: "valid",
      notes: ["The identity implication is valid."],
      axiom_task: "Verify the final identity-implication proof.",
    });
  }
  if (user.includes("\"proof\": \"final proof text\"") || user.includes("\"proof\": \"revised proof text\"")) {
    return JSON.stringify({
      proof: "Assume P. The assumption itself proves P, so P implies P.",
      confidence: 0.97,
      gaps: [],
    });
  }
  return "{}";
};

const withDeterministicAmbient = async <Value>(run: () => Promise<Value>): Promise<Value> => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  const originalConsoleError = console.error;
  const originalPassK = process.env.THEOREM_PASS_K;
  let clock = 1_900_000_000_000;
  let randomState = 0x51ed270b;
  Date.now = () => {
    clock += 1;
    return clock;
  };
  Math.random = () => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  console.error = (..._args: unknown[]) => undefined;
  process.env.THEOREM_PASS_K = "1";
  try {
    return await run();
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    console.error = originalConsoleError;
    if (originalPassK === undefined) delete process.env.THEOREM_PASS_K;
    else process.env.THEOREM_PASS_K = originalPassK;
  }
};

type InvariantFailure = {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
};

type PlanSummary = {
  readonly round: number;
  readonly bracket: string;
  readonly steps: ReadonlyArray<{
    readonly mergeId: string;
    readonly inputRefs: ReadonlyArray<string>;
    readonly dependsOn: ReadonlyArray<string>;
  }>;
};

type TheoremSimulationReport = {
  readonly name: string;
  readonly expectedStatus: "completed" | "failed";
  readonly terminalStatus?: "running" | "failed" | "completed";
  readonly terminalNote?: string;
  readonly metrics: {
    readonly attempts: number;
    readonly delegations: number;
    readonly plans: number;
    readonly proposals: number;
    readonly applied: number;
    readonly rejected: number;
    readonly solutions: number;
    readonly completedStatuses: number;
    readonly failedStatuses: number;
  };
  readonly plans: ReadonlyArray<PlanSummary>;
  readonly proposedMerges: ReadonlyArray<string>;
  readonly appliedMerges: ReadonlyArray<string>;
  readonly rejectedMerges: ReadonlyArray<string>;
  readonly rebrackets: ReadonlyArray<{ readonly bracket: string; readonly note?: string }>;
  readonly attemptOrder: ReadonlyArray<string>;
  readonly mergeApplyOrder: ReadonlyArray<string>;
  readonly phasePeaks: Readonly<Record<string, number>>;
  readonly faultMatches: number;
  readonly duplicateSchedules: number;
  readonly chainChecks: ReadonlyArray<{ readonly stream: string; readonly ok: boolean; readonly count: number }>;
  readonly receiptDigest: string;
  readonly semanticDigest: string;
  readonly trace: ReadonlyArray<SimulationTrace>;
  readonly failures: ReadonlyArray<InvariantFailure>;
};

const eventsOf = <Type extends TheoremEvent["type"]>(
  events: ReadonlyArray<TheoremEvent>,
  type: Type
): Array<Extract<TheoremEvent, { readonly type: Type }>> =>
  events.filter((event): event is Extract<TheoremEvent, { readonly type: Type }> => event.type === type);

const runTheoremSimulation = async (opts: {
  readonly name: string;
  readonly entropy: EntropySource;
  readonly rounds?: number;
  readonly fault?: FaultSpec;
  readonly duplicate?: DuplicateSpec;
  readonly conflictingMergeDuplicate?: boolean;
}): Promise<TheoremSimulationReport> => withDeterministicAmbient(async () => {
  const rounds = opts.rounds ?? 1;
  const expectedStatus = opts.fault || opts.conflictingMergeDuplicate ? "failed" : "completed";
  const runId = "theorem_internal_dst";
  const baseStream = "theorem-simulation";
  const runStream = theoremRunStream(baseStream, runId);
  const persistence = createMemoryPersistence<TheoremEvent>();
  const runtime = createRuntime<TheoremCmd, TheoremEvent, TheoremState>(
    persistence.store,
    persistence.branchStore,
    decideTheorem,
    reduceTheorem,
    initialTheorem
  );
  const executor = createDeterminedTaskRuntime({
    entropy: opts.entropy,
    fault: opts.fault,
    duplicate: opts.duplicate,
  });
  const mergePromptCalls = new Map<string, number>();
  const llmText = async (input: { readonly user: string }): Promise<string> => {
    if (
      opts.conflictingMergeDuplicate
      && input.user.includes("\"summary\": \"merged summary\"")
    ) {
      const count = (mergePromptCalls.get(input.user) ?? 0) + 1;
      mergePromptCalls.set(input.user, count);
      if (count > 1) {
        return JSON.stringify({ summary: "A concurrent, divergent identity proof.", gaps: [] });
      }
    }
    return deterministicTheoremText(input);
  };

  const result = await runTheoremRoster({
    stream: baseStream,
    runId,
    problem: "For every recursive integer sequence, prove termination by an invariant and induction, construct a witness, and formalize the theorem in Lean while all work is scheduled.",
    config: {
      rounds,
      maxDepth: 2,
      memoryWindow: 60,
      branchThreshold: 2,
      maxParallel: 4,
    },
    runtime,
    prompts: loadTheoremPrompts(),
    llmText,
    model: "simulation-model",
    apiReady: true,
    now: Date.now,
    taskRuntime: executor.execute,
    createPlatformExecutionPlanes: createTestTheoremExecutionPlanes,
    axiomDelegate: async () => ({
      status: "completed",
      summary: "AXIOM checked the requested proof boundary.",
      outcome: "verified",
    }),
  });

  const branchMetadata = await runtime.branches();
  const streams = [...new Set([baseStream, runStream, ...branchMetadata.map((branch) => branch.name)])].sort();
  const streamChains = await Promise.all(streams.map(async (stream) => ({
    stream,
    chain: await runtime.chain(stream),
    verification: await runtime.verify(stream),
  })));
  const chainChecks = streamChains.map(({ stream, chain, verification }) => ({
    stream,
    ok: verification.ok,
    count: chain.length,
  }));
  const main = await runtime.chain(runStream);
  const mainEvents = main.map((entry) => entry.body).filter((event) => event.runId === runId);
  const branchEventTypes = new Set<TheoremEvent["type"]>([
    "attempt.proposed",
    "lemma.proposed",
    "critique.raised",
    "patch.applied",
  ]);
  const branchEvents = streamChains
    .filter(({ stream }) => stream !== baseStream && stream !== runStream)
    .flatMap(({ chain }) => chain.map((entry) => entry.body))
    .filter((event) => event.runId === runId && branchEventTypes.has(event.type));
  const allEvents = [...mainEvents, ...branchEvents];
  const team = eventsOf(mainEvents, "orchestration.configured").at(-1);
  const spawnedNodes = eventsOf(mainEvents, "node.spawned").map((event) => event.node);
  const reflections = eventsOf(mainEvents, "reflection.recorded");
  const topologies = eventsOf(mainEvents, "topology.selected");
  const attempts = eventsOf(allEvents, "attempt.proposed");
  const delegations = eventsOf(mainEvents, "subagent.merged");
  const planEvents = eventsOf(mainEvents, "merge.frontier.selected");
  const mergeIds = new Set(planEvents.flatMap((plan) => plan.steps.map((step) => step.mergeId)));
  const proposals = eventsOf(mainEvents, "composition.proposed").filter((event) => mergeIds.has(event.compositionId));
  const applied = eventsOf(mainEvents, "composition.certified").filter((event) => mergeIds.has(event.compositionId));
  const rejected = eventsOf(mainEvents, "composition.rejected").filter((event) => mergeIds.has(event.compositionId));
  const solutions = eventsOf(mainEvents, "solution.finalized");
  const statuses = eventsOf(mainEvents, "run.status");
  const rebrackets = eventsOf(mainEvents, "rebracket.applied");
  const terminal = statuses.at(-1);
  const plans: PlanSummary[] = planEvents.map((plan) => ({
    round: plan.round,
    bracket: plan.bracket,
    steps: plan.steps.map((step) => ({
      mergeId: step.mergeId,
      inputRefs: [...step.inputRefs],
      dependsOn: [...step.dependsOn],
    })),
  }));
  const snapshot = executor.snapshot();
  const proposedMerges = proposals.map((event) => event.compositionId);
  const appliedMerges = applied.map((event) => event.compositionId);
  const rejectedMerges = rejected.map((event) => `${event.compositionId}:${event.reason}`);
  const attemptOrder = snapshot.trace
    .filter((entry) => entry.phase === "attempt" && entry.boundary === "receipt.after")
    .map((entry) => entry.actor);
  const mergeApplyOrder = snapshot.trace
    .filter((entry) => entry.phase === "merge.commit" && entry.boundary === "apply.after")
    .map((entry) => entry.actor);

  const failures: InvariantFailure[] = [];
  const requireInvariant = (condition: boolean, code: string, message: string, details?: unknown) => {
    if (!condition) failures.push({ code, message, ...(details === undefined ? {} : { details }) });
  };

  requireInvariant(
    chainChecks.every((check) => check.ok),
    "receipt_chain_invalid",
    "Every main, index, and agent branch chain must verify.",
    chainChecks
  );
  const terminalStatuses = statuses.filter((event) => event.status !== "running");
  requireInvariant(
    terminal?.status === expectedStatus,
    "terminal_status_mismatch",
    `Expected terminal status ${expectedStatus}.`,
    terminal
  );
  requireInvariant(
    terminalStatuses.length === 1,
    "terminal_status_not_unique",
    "A run must record exactly one completed or failed terminal receipt.",
    terminalStatuses
  );
  requireInvariant(
    !(statuses.some((event) => event.status === "completed") && statuses.some((event) => event.status === "failed")),
    "contradictory_terminal_statuses",
    "A run cannot record both completed and failed terminal receipts."
  );
  if (expectedStatus === "failed") {
    if (opts.fault) {
      requireInvariant(
        snapshot.faultMatches >= 1,
        "fault_not_injected",
        "The selected fault boundary must be reached and injected.",
        { fault: opts.fault, matches: snapshot.faultMatches }
      );
    }
  } else {
    const explorerIds = new Set(spawnedNodes
      .filter((node) => node.metadata?.role === "explorer")
      .map((node) => node.id));
    const totalPlanSteps = plans.reduce((sum, plan) => sum + plan.steps.length, 0);
    requireInvariant(
      team?.nodes.length === 1 && team.nodes[0]?.id === "orchestrator",
      "initial_population_not_minimal",
      "Adaptive orchestration must configure only the coordinator before reflection.",
      team?.nodes
    );
    requireInvariant(
      explorerIds.size >= 4,
      "explorer_demand_not_materialized",
      "The objective must materialize its independent proof-route demand.",
      [...explorerIds]
    );
    requireInvariant(team?.limits.maxParallel === 4, "configured_parallelism_mismatch", "The run must persist maxParallel=4.");
    requireInvariant(
      attempts.length === attemptOrder.length
        && attempts.every((event) => explorerIds.has(event.agentId))
        && new Set(attempts.map((event) => event.claimId)).size === attempts.length,
      "attempt_coverage_mismatch",
      "Every adaptive explorer contribution must be unique and cross the scheduler boundary.",
      { attempts: attempts.length, scheduled: attemptOrder.length, explorerIds: [...explorerIds] }
    );
    requireInvariant(
      delegations.length === attempts.length + 1,
      "delegation_coverage_mismatch",
      "Every explorer attempt and final verification must cross the AXIOM delegation boundary.",
      { delegations: delegations.length, expected: attempts.length + 1 }
    );
    requireInvariant(
      Object.values(snapshot.phasePeaks).every((peak) => peak <= 4),
      "parallelism_limit_exceeded",
      "No phase may exceed the configured four active invocations.",
      snapshot.phasePeaks
    );
    requireInvariant(
      attemptOrder.length === attempts.length,
      "attempt_completion_trace_incomplete",
      "Every explorer receipt commit must appear in the scheduler trace.",
      attemptOrder
    );
    requireInvariant(
      reflections.length === rounds + 1,
      "reflection_count_mismatch",
      "The run must receipt initial population reflection and one course-correction reflection per round.",
      reflections.map((reflection) => reflection.iteration)
    );
    requireInvariant(
      topologies.length >= rounds,
      "topology_trace_missing",
      "The run must persist its adaptive composition topology.",
      topologies
    );
    requireInvariant(
      plans.length === rounds,
      "merge_plan_count_mismatch",
      "Every round must create one versioned merge plan.",
      plans
    );
    requireInvariant(
      proposals.length === totalPlanSteps,
      "merge_proposal_count_mismatch",
      "Every plan step must publish one canonical composition proposal after redelivery convergence.",
      { proposals: proposals.length, totalPlanSteps, duplicates: snapshot.duplicateSchedules }
    );
    requireInvariant(
      proposals.every((proposal) => applied.some((certification) =>
        certification.proposalId === proposal.proposalId
        && certification.compositionId === proposal.compositionId
        && certification.outputHash === proposal.outputHash
      )),
      "composition_certification_mismatch",
      "Every merge proposal must have one content-addressed certification.",
      { proposals, applied }
    );
    requireInvariant(
      applied.length === totalPlanSteps && new Set(appliedMerges).size === applied.length,
      "merge_not_applied_exactly_once",
      "Every planned composition must apply exactly once.",
      appliedMerges
    );
    requireInvariant(rejected.length === 0, "unexpected_merge_rejection", "A valid schedule must not reject a merge.", rejectedMerges);
    for (const plan of plans) {
      const order = new Map(
        appliedMerges.map((key, index) => [key, index] as const)
      );
      for (const step of plan.steps) {
        const stepKey = step.mergeId;
        for (const dependency of step.dependsOn) {
          const dependencyKey = dependency;
          requireInvariant(
            (order.get(dependencyKey) ?? Number.POSITIVE_INFINITY) < (order.get(stepKey) ?? -1),
            "merge_dependency_order_violated",
            `${stepKey} must apply after ${dependencyKey}.`,
            appliedMerges
          );
        }
      }
    }
    requireInvariant(solutions.length === 1, "solution_count_mismatch", "A successful run must finalize exactly one solution.");
  }

  const semanticDigest = hashJson({
    status: result.status,
    finalProof: result.finalProof,
    nodes: [...(team?.nodes ?? []), ...spawnedNodes].map((node) => ({
      id: node.id,
      role: node.metadata?.role,
      podId: node.metadata?.podId,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    attempts: attempts.map((event) => ({ agentId: event.agentId, content: event.content }))
      .sort((left, right) => left.agentId.localeCompare(right.agentId)),
    plans,
    applied: applied.map((event) => event.compositionId).sort(),
    rebrackets: rebrackets.map((event) => event.bracket),
    topologies: topologies.map((event) => ({ operation: event.operation, bracket: event.bracket })),
    reflections: reflections.map((event) => ({ iteration: event.iteration, actions: event.actions.map((action) => action.type) })),
    verification: eventsOf(mainEvents, "verification.report").map((event) => event.status),
  });
  const receiptDigest = hashJson({
    branches: branchMetadata.map((branch) => ({
      name: branch.name,
      parent: branch.parent,
      forkAt: branch.forkAt,
    })),
    streams: streamChains.map(({ stream, chain }) => ({
      stream,
      events: chain.map((entry) => entry.body),
    })),
  });

  return {
    name: opts.name,
    expectedStatus,
    terminalStatus: terminal?.status,
    terminalNote: terminal?.note,
    metrics: {
      attempts: attempts.length,
      delegations: delegations.length,
      plans: plans.length,
      proposals: proposals.length,
      applied: applied.length,
      rejected: rejected.length,
      solutions: solutions.length,
      completedStatuses: statuses.filter((event) => event.status === "completed").length,
      failedStatuses: statuses.filter((event) => event.status === "failed").length,
    },
    plans,
    proposedMerges,
    appliedMerges,
    rejectedMerges,
    rebrackets: rebrackets.map((event) => ({ bracket: event.bracket, note: event.note })),
    attemptOrder,
    mergeApplyOrder,
    phasePeaks: snapshot.phasePeaks,
    faultMatches: snapshot.faultMatches,
    duplicateSchedules: snapshot.duplicateSchedules,
    chainChecks,
    receiptDigest,
    semanticDigest,
    trace: snapshot.trace,
    failures,
  };
});

const assertPassingReport = (report: TheoremSimulationReport) => {
  assert.deepEqual(report.failures, [], JSON.stringify(report.failures, null, 2));
};

test("internal theorem simulation explores adaptive population schedules and replays accepted semantics exactly", { timeout: 120_000 }, async () => {
  const seeds = [1, 7, 19, 101];
  const reports: TheoremSimulationReport[] = [];

  for (const seed of seeds) {
    const recording = new RecordingEntropySource(new SeededEntropySource(seed));
    const first = await runTheoremSimulation({ name: `schedule-${seed}`, entropy: recording });
    assertPassingReport(first);
    const replay = await runTheoremSimulation({
      name: `schedule-${seed}`,
      entropy: new ReplayingEntropySource(recording.getRecords()),
    });
    const { receiptDigest: _firstReceiptDigest, ...firstAcceptedProjection } = first;
    const { receiptDigest: _replayReceiptDigest, ...replayAcceptedProjection } = replay;
    assert.deepEqual(
      replayAcceptedProjection,
      firstAcceptedProjection,
      `schedule ${seed} did not replay its accepted projection exactly`,
    );
    reports.push(first);
  }

  assert.equal(new Set(reports.map((report) => report.semanticDigest)).size, 1, "schedules did not converge semantically");
  assert.ok(new Set(reports.map((report) => report.attemptOrder.join(","))).size >= 3, "attempt interleavings were not explored");
  assert.ok(new Set(reports.map((report) => report.mergeApplyOrder.join(","))).size >= 2, "merge frontier orders were not explored");
  assert.equal(Math.max(...reports.map((report) => report.phasePeaks.attempt ?? 0)), 4, "search never reached maxParallel=4");
});

test("internal theorem simulation makes concurrent merge redelivery idempotent", { timeout: 120_000 }, async () => {
  const recording = new RecordingEntropySource(new SeededEntropySource(0xd00b1e));
  const options = {
    name: "duplicate-merge-delivery",
    duplicate: { phase: "merge", actor: "merge-r1-1" },
  } as const;
  const first = await runTheoremSimulation({ ...options, entropy: recording });
  assertPassingReport(first);
  assert.equal(first.duplicateSchedules, 1);
  assert.equal(first.proposedMerges.filter((key) => key === "merge-r1-1").length, 1);
  assert.equal(first.appliedMerges.filter((key) => key === "merge-r1-1").length, 1);
  assert.equal(
    first.trace.filter((entry) =>
      entry.phase === "merge"
      && entry.boundary === "crdt.apply.after"
      && entry.details?.mergeId === "merge-r1-1"
    ).length,
    2
  );
  const replay = await runTheoremSimulation({
    ...options,
    entropy: new ReplayingEntropySource(recording.getRecords()),
  });
  assert.deepEqual(replay, first);
});

test("internal theorem simulation preserves divergent merge deliveries as a CRDT conflict", { timeout: 120_000 }, async () => {
  const recording = new RecordingEntropySource(new SeededEntropySource(0xc0f11c7));
  const options = {
    name: "conflicting-merge-delivery",
    duplicate: { phase: "merge", actor: "merge-r1-1" },
    conflictingMergeDuplicate: true,
  } as const;
  const first = await runTheoremSimulation({ ...options, entropy: recording });
  assertPassingReport(first);
  assert.equal(first.terminalStatus, "failed");
  assert.equal(first.proposedMerges.filter((key) => key === "merge-r1-1").length, 0);
  assert.ok(first.rejectedMerges.includes("merge-r1-1:output_conflict"));
  assert.ok(!first.appliedMerges.includes("merge-r1-1"));
  assert.ok(!first.appliedMerges.includes("merge-r1-3"));
  const replay = await runTheoremSimulation({
    ...options,
    entropy: new ReplayingEntropySource(recording.getRecords()),
  });
  assert.deepEqual(replay, first);
});

test("internal theorem simulation injects failures at attempt, merge, and terminal commit boundaries", { timeout: 120_000 }, async () => {
  const campaigns: ReadonlyArray<{
    readonly seed: number;
    readonly name: string;
    readonly fault: FaultSpec;
    readonly assertState: (report: TheoremSimulationReport) => void;
  }> = [
    {
      seed: 0xa771,
      name: "attempt-provider-failure",
      fault: { phase: "attempt", boundary: "llm.before", match: { agentId: "*" } },
      assertState: (report) => {
        assert.equal(report.faultMatches, 4, "wildcard fault should fail the complete four-agent frontier");
        assert.ok(report.metrics.attempts < 4);
        assert.equal(report.metrics.plans, 0);
        assert.equal(report.metrics.solutions, 0);
      },
    },
    {
      seed: 0xbeef,
      name: "merge-crash-before-apply",
      fault: { phase: "merge.commit", boundary: "apply.before", match: { mergeId: "merge-r1-1" } },
      assertState: (report) => {
        assert.ok(!report.proposedMerges.includes("merge-r1-1"));
        assert.ok(!report.appliedMerges.includes("merge-r1-1"));
        assert.ok(!report.appliedMerges.includes("merge-r1-3"));
        assert.equal(report.metrics.solutions, 0);
      },
    },
    {
      seed: 0xf1a1,
      name: "terminal-crash-after-solution",
      fault: { phase: "finalize", boundary: "status.before", match: { agentId: "orchestrator" } },
      assertState: (report) => {
        assert.equal(report.metrics.solutions, 1);
        assert.equal(report.metrics.completedStatuses, 0);
        assert.equal(report.metrics.failedStatuses, 1);
      },
    },
  ];

  for (const campaign of campaigns) {
    const recording = new RecordingEntropySource(new SeededEntropySource(campaign.seed));
    const first = await runTheoremSimulation({
      name: campaign.name,
      entropy: recording,
      fault: campaign.fault,
    });
    assertPassingReport(first);
    assert.equal(first.terminalStatus, "failed");
    campaign.assertState(first);
    const replay = await runTheoremSimulation({
      name: campaign.name,
      entropy: new ReplayingEntropySource(recording.getRecords()),
      fault: campaign.fault,
    });
    assert.deepEqual(replay, first, `${campaign.name} did not replay exactly`);
  }
});

test("internal theorem simulation carries a selected rebracket into the next merge plan", { timeout: 120_000 }, async () => {
  const recording = new RecordingEntropySource(new SeededEntropySource(0x2ca7e));
  const first = await runTheoremSimulation({
    name: "two-round-rebracket",
    entropy: recording,
    rounds: 2,
  });
  assertPassingReport(first);
  assert.equal(first.plans.length, 2);
  const firstTree = parseCompositionBracket(first.plans[0]?.bracket ?? "");
  const secondTree = parseCompositionBracket(first.plans[1]?.bracket ?? "");
  assert.ok(firstTree && secondTree);
  assert.ok(first.rebrackets[0], "round one did not record a rebracket decision");
  assert.ok(compositionLeaves(secondTree).length >= compositionLeaves(firstTree).length);
  assert.ok(
    first.plans[1]?.bracket === first.rebrackets[0]?.bracket
      || compositionLeaves(secondTree).length === compositionLeaves(firstTree).length + 1,
    "round two ignored both the selected associator and reflected population graft"
  );
  const replay = await runTheoremSimulation({
    name: "two-round-rebracket",
    entropy: new ReplayingEntropySource(recording.getRecords()),
    rounds: 2,
  });
  assert.deepEqual(replay, first);
});
