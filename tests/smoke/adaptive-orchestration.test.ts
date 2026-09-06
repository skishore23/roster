import assert from "node:assert/strict";
import test from "node:test";

import { materializeNodeDemand, reflectOnOrchestration } from "../../src/engine/orchestration/adaptive.ts";
import {
  balancedCompositionTree,
  compositionBracket,
  compositionLeaves,
  contractCompositionLeaf,
  graftCompositionLeaf,
  isCompositionContraction,
  isCompositionGraft,
  leftCombCompositionTree,
  parseCompositionBracket,
  tamariNeighbors,
  topologyPairKey,
} from "../../src/engine/orchestration/topology.ts";
import type { DomainPack } from "../../src/engine/orchestration/types.ts";
import {
  initialOrchestrationState,
  orchestrationConfiguredEvent,
  reduceOrchestration,
  reflectionRecordedEvent,
  topologySelectedEvent,
} from "../../src/modules/orchestration.ts";

const PACK: DomainPack = {
  id: "adaptive-test",
  version: "1",
  policyVersion: "adaptive-test-v1",
  coordinatorId: "coordinator",
  capabilities: [
    { id: "coordinate", description: "Coordinate work." },
    { id: "solve", description: "Solve one bounded objective." },
  ],
  nodes: [{
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native", profile: "adaptive-test.coordinator" },
  }],
  limits: { maxNodes: 12, maxTasks: 100, maxParallel: 4, maxDepth: 8 },
};

test("arbitrary Tamari neighbors preserve leaf order and connect K5", () => {
  const initial = leftCombCompositionTree(["a", "b", "c", "d", "e"]);
  const queue = [initial];
  const seen = new Map([[compositionBracket(initial), initial]]);
  while (queue.length > 0) {
    const tree = queue.shift();
    assert.ok(tree);
    for (const neighbor of tamariNeighbors(tree, "both")) {
      assert.deepEqual(compositionLeaves(neighbor.tree), ["a", "b", "c", "d", "e"]);
      const bracket = compositionBracket(neighbor.tree);
      if (seen.has(bracket)) continue;
      seen.set(bracket, neighbor.tree);
      queue.push(neighbor.tree);
    }
  }
  assert.equal(seen.size, 14, "K5 must contain Catalan(4) vertices");
});

test("reflection spawns demanded capability and chooses a local associator", () => {
  const tree = leftCombCompositionTree(["a", "b", "c"]);
  const decision = reflectOnOrchestration({
    runId: "adaptive-run",
    policyId: "adaptive",
    policyVersion: "1",
    iteration: 1,
    observation: {
      activeNodes: 1,
      pendingTasks: 1,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 1,
      evidenceGaps: 1,
      stagnationRounds: 1,
      goalSatisfied: false,
    },
    maxNodes: 12,
    unmetDemands: [{ capability: "solve", objective: "Try a route not represented in the frontier." }],
    topology: tree,
    affinities: new Map([[topologyPairKey("b", "c"), 4]]),
  });

  assert.deepEqual(decision.actions.map((action) => action.type), ["spawn", "rebracket", "replan"]);
  const rotation = decision.actions.find((action) => action.type === "rebracket");
  assert.ok(rotation && rotation.type === "rebracket");
  assert.equal(rotation.previousBracket, "((a o b) o c)");
  assert.equal(rotation.bracket, "(a o (b o c))");

  const demand = decision.actions.find((action) => action.type === "spawn");
  assert.ok(demand && demand.type === "spawn");
  const first = materializeNodeDemand({
    runId: "adaptive-run",
    reflectionId: decision.reflectionId,
    index: 0,
    coordinatorId: "coordinator",
    demand: demand.demand,
  });
  const replay = materializeNodeDemand({
    runId: "adaptive-run",
    reflectionId: decision.reflectionId,
    index: 0,
    coordinatorId: "coordinator",
    demand: demand.demand,
  });
  assert.deepEqual(first, replay);
  assert.deepEqual(first.capabilities, ["solve"]);
  assert.equal(first.name, "Solve Agent 1");
  assert.equal(first.metadata?.displayNameSource, "generated");
});

test("workspace node names are universal presentation metadata, not durable identity", () => {
  const base = {
    runId: "named-run",
    reflectionId: "reflection_named",
    index: 2,
    coordinatorId: "coordinator",
  } as const;
  const ada = materializeNodeDemand({
    ...base,
    demand: {
      capability: "research.evidence",
      objective: "Find primary evidence.",
      name: "  Ada,   Evidence Researcher  ",
      nameSource: "planner",
    },
  });
  const grace = materializeNodeDemand({
    ...base,
    demand: {
      capability: "research.evidence",
      objective: "Find primary evidence.",
      name: "Grace, Evidence Researcher",
      nameSource: "planner",
    },
  });

  assert.equal(ada.name, "Ada, Evidence Researcher");
  assert.equal(ada.metadata?.displayNameSource, "planner");
  assert.equal(grace.name, "Grace, Evidence Researcher");
  assert.equal(ada.id, grace.id, "renaming a persona must not create another logical node");
});

test("reflection cannot stop or retire while the frontier is unsafe", () => {
  const busy = reflectOnOrchestration({
    runId: "busy-run",
    policyId: "adaptive",
    policyVersion: "1",
    iteration: 1,
    observation: {
      activeNodes: 2,
      pendingTasks: 0,
      runningTasks: 1,
      failedTasks: 0,
      conflicts: 0,
      evidenceGaps: 0,
      stagnationRounds: 0,
      goalSatisfied: true,
    },
    maxNodes: 12,
    retirableNodeIds: ["worker"],
  });
  assert.deepEqual(busy.actions, [{ type: "continue" }]);

  const incomplete = reflectOnOrchestration({
    runId: "incomplete-run",
    policyId: "adaptive",
    policyVersion: "1",
    iteration: 1,
    observation: {
      activeNodes: 2,
      pendingTasks: 0,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 0,
      evidenceGaps: 1,
      stagnationRounds: 1,
      goalSatisfied: false,
    },
    maxNodes: 12,
    retirableNodeIds: ["worker"],
  });
  assert.deepEqual(incomplete.actions.map((action) => action.type), ["replan"]);
});

test("population and associahedron changes replay as validated receipts", () => {
  let state = reduceOrchestration(initialOrchestrationState, orchestrationConfiguredEvent("run", PACK), 1);
  const initialTree = balancedCompositionTree(["a", "b", "c"]);
  const initialTopology = topologySelectedEvent({
    runId: "run",
    operation: "initialize",
    bracket: compositionBracket(initialTree),
    leaves: compositionLeaves(initialTree),
    reason: "initial artifact frontier",
  });
  state = reduceOrchestration(state, initialTopology, 2);

  const decision = reflectOnOrchestration({
    runId: "run",
    policyId: "adaptive",
    policyVersion: "1",
    iteration: 1,
    observation: {
      activeNodes: 1,
      pendingTasks: 0,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 0,
      evidenceGaps: 1,
      stagnationRounds: 0,
      goalSatisfied: false,
    },
    maxNodes: PACK.limits.maxNodes,
    unmetDemands: [{ capability: "solve", objective: "Close the evidence gap." }],
  });
  state = reduceOrchestration(state, reflectionRecordedEvent("run", decision), 3);
  const spawn = decision.actions.find((action) => action.type === "spawn");
  assert.ok(spawn && spawn.type === "spawn");
  const worker = materializeNodeDemand({
    runId: "run",
    reflectionId: decision.reflectionId,
    index: 0,
    coordinatorId: PACK.coordinatorId,
    demand: spawn.demand,
  });
  state = reduceOrchestration(state, { type: "node.spawned", runId: "run", node: worker, reason: decision.reason }, 4);

  const grafted = graftCompositionLeaf(initialTree, "b", "d");
  const graft = topologySelectedEvent({
    runId: "run",
    previousTopologyId: initialTopology.topologyId,
    operation: "graft",
    previousBracket: initialTopology.bracket,
    bracket: compositionBracket(grafted),
    leaves: compositionLeaves(grafted),
    reason: "new independent artifact",
  });
  state = reduceOrchestration(state, graft, 5);
  assert.equal(state.topologyId, graft.topologyId);
  assert.equal(state.reflections.length, 1);
  assert.equal(state.nodes[worker.id]?.status, "active");

  const contractedTree = contractCompositionLeaf(grafted, "d");
  assert.ok(contractedTree);
  const contraction = topologySelectedEvent({
    runId: "run",
    previousTopologyId: graft.topologyId,
    operation: "contract",
    previousBracket: graft.bracket,
    bracket: compositionBracket(contractedTree),
    leaves: compositionLeaves(contractedTree),
    reason: "artifact subsumed by its parent",
  });
  state = reduceOrchestration(state, contraction, 6);
  assert.deepEqual(state.topologies[state.topologyId ?? ""]?.leaves, ["a", "b", "c"]);
  assert.deepEqual(parseCompositionBracket(contraction.bracket), contractedTree);
  assert.equal(isCompositionGraft(initialTree, grafted), true);
  assert.equal(isCompositionContraction(grafted, contractedTree), true);

  assert.throws(() => reduceOrchestration(state, topologySelectedEvent({
    runId: "run",
    previousTopologyId: contraction.topologyId,
    operation: "rotate",
    previousBracket: contraction.bracket,
    bracket: "((a o c) o b)",
    leaves: ["a", "c", "b"],
    direction: "up",
    reason: "invalid non-local permutation",
  }), 7), /valid Tamari rotation/);

  assert.throws(() => reduceOrchestration(state, topologySelectedEvent({
    runId: "run",
    previousTopologyId: contraction.topologyId,
    operation: "graft",
    previousBracket: contraction.bracket,
    bracket: "(d o (a o (b o c)))",
    leaves: ["d", "a", "b", "c"],
    reason: "invalid graft plus unrelated rebracketing",
  }), 8), /exactly one local leaf/);
});
