import assert from "node:assert/strict";
import test from "node:test";

import {
  RecordingEntropySource,
  ReplayingEntropySource,
  SimulationImpl,
  type EntropySource,
  type Logger,
  type SimulationTask,
  type TaskSpec,
} from "determined";

import { materializeNodeDemand, reflectOnOrchestration, type NodeDemand } from "../../src/engine/orchestration/adaptive.ts";
import {
  compositionBracket,
  compositionLeaves,
  contractCompositionLeaf,
  graftCompositionLeaf,
  leftCombCompositionTree,
  parseCompositionBracket,
  topologyPairKey,
  type CompositionTree,
} from "../../src/engine/orchestration/topology.ts";
import type { DomainPack, WorkspaceNode } from "../../src/engine/orchestration/types.ts";
import {
  initialOrchestrationState,
  orchestrationConfiguredEvent,
  reduceOrchestration,
  reflectionRecordedEvent,
  topologySelectedEvent,
  type OrchestrationEvent,
  type OrchestrationState,
} from "../../src/modules/orchestration.ts";

class SeededEntropySource implements EntropySource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
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

const silentLogger: Logger = {
  log: () => undefined,
  error: () => undefined,
};

const PACK: DomainPack = {
  id: "adaptive-simulation",
  version: "1",
  policyVersion: "adaptive-simulation-v1",
  coordinatorId: "coordinator",
  capabilities: [
    { id: "coordinate", description: "Coordinate an adaptive frontier." },
    { id: "investigate", description: "Investigate one independent part of the frontier." },
  ],
  nodes: [{
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native", profile: "adaptive-simulation.coordinator" },
  }],
  limits: { maxNodes: 128, maxTasks: 256, maxParallel: 12, maxDepth: 12 },
};

type ReceiptRecord = {
  readonly ts: number;
  readonly event: OrchestrationEvent;
};

type ScenarioResult = {
  readonly state: OrchestrationState;
  readonly records: ReadonlyArray<ReceiptRecord>;
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly completionOrder: ReadonlyArray<string>;
  readonly faultMatches: number;
};

const demands = (count: number): ReadonlyArray<NodeDemand> => Array.from({ length: count }, (_unused, index) => ({
  capability: "investigate",
  name: `Investigator ${index + 1}`,
  objective: `Explore frontier partition ${index + 1} without duplicating another partition.`,
  focus: `partition-${index + 1}`,
  group: `Pod ${Math.floor(index / 4) + 1}`,
}));

const replayRecords = (records: ReadonlyArray<ReceiptRecord>, duplicateEach = false): OrchestrationState => {
  let state = initialOrchestrationState;
  for (const record of records) {
    state = reduceOrchestration(state, record.event, record.ts);
    if (duplicateEach) state = reduceOrchestration(state, record.event, record.ts);
  }
  return state;
};

const evaluateNodes = async (input: {
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly entropy: EntropySource;
  readonly faultIndex: number;
}): Promise<{ readonly completionOrder: ReadonlyArray<string>; readonly faultMatches: number }> => {
  const target = input.nodes[input.faultIndex % input.nodes.length]?.id;
  let faultMatches = 0;
  const run = async (injectFault: boolean): Promise<{ readonly ok: boolean; readonly order: ReadonlyArray<string> }> => {
    const order: string[] = [];
    const specs: TaskSpec<string>[] = input.nodes.map((node): TaskSpec<string> => ({
      name: `evaluate:${node.id}`,
      f: async (task: SimulationTask): Promise<string> => {
        await task.checkpoint("evaluate.ready", { nodeId: node.id });
        await task.failpoint("evaluate.before", { nodeId: node.id });
        await task.checkpoint("evaluate.after", { nodeId: node.id });
        order.push(node.id);
        return node.id;
      },
    }));
    const simulation = new SimulationImpl(silentLogger, input.entropy, (...log) => {
      const details = log[1] as Readonly<Record<string, unknown>> | undefined;
      if (!injectFault || log[0] !== "evaluate.before" || details?.nodeId !== target) return 0;
      faultMatches += 1;
      return 1;
    });
    const result = await simulation.runTasks(specs);
    return { ok: result.isOk(), order };
  };

  const failed = await run(true);
  assert.equal(failed.ok, false, "the selected node boundary must fail");
  const retried = await run(false);
  assert.equal(retried.ok, true, "the evaluation frontier must succeed on retry");
  assert.equal(new Set(retried.order).size, input.nodes.length);
  return { completionOrder: retried.order, faultMatches };
};

const runScenario = async (input: {
  readonly demandCount: number;
  readonly entropy: EntropySource;
  readonly faultIndex: number;
}): Promise<ScenarioResult> => {
  const runId = `adaptive-${input.demandCount}`;
  const records: ReceiptRecord[] = [];
  let state = initialOrchestrationState;
  let ts = 0;
  const apply = (event: OrchestrationEvent): void => {
    ts += 1;
    records.push({ ts, event });
    state = reduceOrchestration(state, event, ts);
  };

  apply(orchestrationConfiguredEvent(runId, PACK));
  let topology: CompositionTree = leftCombCompositionTree(["seed_a", "seed_b", "review"]);
  let topologyEvent = topologySelectedEvent({
    runId,
    operation: "initialize",
    bracket: compositionBracket(topology),
    leaves: compositionLeaves(topology),
    reason: "initialize the independent artifact frontier",
  });
  apply(topologyEvent);

  const initialDecision = reflectOnOrchestration({
    runId,
    policyId: "adaptive-simulation",
    policyVersion: "1",
    iteration: 1,
    observation: {
      activeNodes: 1,
      pendingTasks: input.demandCount,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 1,
      evidenceGaps: input.demandCount,
      stagnationRounds: 1,
      goalSatisfied: false,
    },
    maxNodes: PACK.limits.maxNodes,
    unmetDemands: demands(input.demandCount),
    topology,
    affinities: new Map([[topologyPairKey("seed_b", "review"), 8]]),
  });
  apply(reflectionRecordedEvent(runId, initialDecision));

  const rotation = initialDecision.actions.find((action) => action.type === "rebracket");
  assert.ok(rotation && rotation.type === "rebracket");
  const rotated = parseCompositionBracket(rotation.bracket);
  assert.ok(rotated);
  topology = rotated;
  topologyEvent = topologySelectedEvent({
    runId,
    previousTopologyId: topologyEvent.topologyId,
    operation: "rotate",
    previousBracket: rotation.previousBracket,
    bracket: rotation.bracket,
    leaves: compositionLeaves(topology),
    direction: rotation.direction,
    score: rotation.score,
    reason: "reflection selected a local associator",
  });
  apply(topologyEvent);

  const nodes = initialDecision.actions
    .filter((action): action is Extract<(typeof initialDecision.actions)[number], { readonly type: "spawn" }> => action.type === "spawn")
    .map((action, index) => materializeNodeDemand({
      runId,
      reflectionId: initialDecision.reflectionId,
      index,
      coordinatorId: PACK.coordinatorId,
      demand: action.demand,
    }));
  assert.equal(nodes.length, input.demandCount);

  for (const node of nodes) {
    apply({ type: "node.spawned", runId, node, reason: initialDecision.reason });
    const previousBracket = compositionBracket(topology);
    topology = graftCompositionLeaf(topology, "review", node.id, "before");
    topologyEvent = topologySelectedEvent({
      runId,
      previousTopologyId: topologyEvent.topologyId,
      operation: "graft",
      previousBracket,
      bracket: compositionBracket(topology),
      leaves: compositionLeaves(topology),
      reason: `${node.name} added an independent artifact boundary`,
    });
    apply(topologyEvent);
  }

  const evaluation = await evaluateNodes({
    nodes,
    entropy: input.entropy,
    faultIndex: input.faultIndex,
  });

  const retirableNodeIds = nodes.length > 2
    ? [nodes[0]?.id, nodes.at(-1)?.id].filter((nodeId): nodeId is string => Boolean(nodeId))
    : [];
  const consolidation = reflectOnOrchestration({
    runId,
    policyId: "adaptive-simulation",
    policyVersion: "1",
    iteration: 2,
    observation: {
      activeNodes: 1 + nodes.length,
      pendingTasks: 0,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 0,
      evidenceGaps: 0,
      stagnationRounds: 0,
      goalSatisfied: false,
    },
    maxNodes: PACK.limits.maxNodes,
    retirableNodeIds,
    topology,
  });
  apply(reflectionRecordedEvent(runId, consolidation));

  for (const action of consolidation.actions) {
    if (action.type !== "retire") continue;
    apply({ type: "node.retired", runId, nodeId: action.nodeId, reason: consolidation.reason });
    const previousBracket = compositionBracket(topology);
    const contracted = contractCompositionLeaf(topology, action.nodeId);
    assert.ok(contracted);
    topology = contracted;
    topologyEvent = topologySelectedEvent({
      runId,
      previousTopologyId: topologyEvent.topologyId,
      operation: "contract",
      previousBracket,
      bracket: compositionBracket(topology),
      leaves: compositionLeaves(topology),
      reason: `${action.nodeId} was redundant after consolidation`,
    });
    apply(topologyEvent);
  }

  const terminal = reflectOnOrchestration({
    runId,
    policyId: "adaptive-simulation",
    policyVersion: "1",
    iteration: 3,
    observation: {
      activeNodes: Object.values(state.nodes).filter((node) => node.status === "active").length,
      pendingTasks: 0,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 0,
      evidenceGaps: 0,
      stagnationRounds: 0,
      goalSatisfied: true,
    },
    maxNodes: PACK.limits.maxNodes,
    topology,
  });
  apply(reflectionRecordedEvent(runId, terminal));
  assert.deepEqual(terminal.actions, [{ type: "stop" }]);

  return {
    state,
    records,
    nodes,
    completionOrder: evaluation.completionOrder,
    faultMatches: evaluation.faultMatches,
  };
};

test("adaptive simulator grows, rotates, contracts, and exactly replays variable populations", { timeout: 120_000 }, async () => {
  for (const demandCount of [1, 5, 31, 63]) {
    const recording = new RecordingEntropySource(new SeededEntropySource(0xa110 + demandCount));
    const first = await runScenario({ demandCount, entropy: recording, faultIndex: demandCount - 1 });
    assert.equal(first.faultMatches, 1);
    assert.equal(first.nodes.length, demandCount);
    assert.equal(first.state.reflections.length, 3);
    assert.deepEqual(replayRecords(first.records), first.state);
    assert.deepEqual(replayRecords(first.records, true), first.state);

    const replay = await runScenario({
      demandCount,
      entropy: new ReplayingEntropySource(recording.getRecords()),
      faultIndex: demandCount - 1,
    });
    assert.deepEqual(replay.records, first.records);
    assert.deepEqual(replay.state, first.state);
    assert.deepEqual(replay.completionOrder, first.completionOrder);
  }
});

test("adaptive simulator explores schedules without changing converged coordination state", { timeout: 120_000 }, async () => {
  const orders = new Set<string>();
  let reference: OrchestrationState | undefined;
  for (const [index, seed] of [0x101, 0x202, 0x303, 0x404, 0x505, 0x606].entries()) {
    const result = await runScenario({
      demandCount: 11,
      entropy: new SeededEntropySource(seed),
      faultIndex: index,
    });
    assert.equal(result.faultMatches, 1);
    orders.add(result.completionOrder.join(","));
    if (!reference) reference = result.state;
    else assert.deepEqual(result.state, reference);
  }
  assert.ok(orders.size >= 3, "the simulator did not explore enough node interleavings");
});
