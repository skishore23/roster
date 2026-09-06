import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "../../src/core/canonical.ts";
import {
  createDistributedControlProjector,
  createDistributedControlProposal,
  createDistributedControlUpdate,
  DistributedControlLedger,
  type DistributedControlPayload,
} from "../../src/engine/orchestration/distributed-control.ts";
import { reconcileDistributedControl } from "../../src/engine/orchestration/distributed-control-runtime.ts";
import { mergeSharedArtifactUpdates } from "../../src/engine/artifact/shared-crdt.ts";

const frontier = { frontierVersion: "frontier-1", topologyVersion: "topology-1" } as const;
const roles = { painter: "artist", critic: "critic", director: "director", finisher: "finisher" } as const;
const artifactId = "run-1:distributed-control";

const update = (nodeId: string, taskId: string, payload: DistributedControlPayload) => createDistributedControlUpdate({
  artifactId,
  runId: "run-1",
  taskId,
  nodeId,
  ...frontier,
  inputVersions: { scene: "scene-v1" },
  payload,
});

test("a critic cannot unilaterally command the run", () => {
  const proposal = createDistributedControlProposal({
    authorNodeId: "critic",
    authorRole: "critic",
    rationale: "The silhouette needs another detail pass.",
    action: {
      type: "spawn_tasks",
      joinStrategy: "all",
      tasks: [{
        taskId: "detail-pass-1", role: "artist", capability: "paint.detail", kind: "detail",
        objective: "Add subject-specific detail without covering the focal face.", dependencies: [], estimatedCostMicros: 100_000,
      }],
    },
    evidenceRefs: ["review-1"],
  });
  const ledger = new DistributedControlLedger();
  try {
    ledger.add(update("critic", "review-1", proposal));
    const projection = ledger.project(artifactId, frontier, createDistributedControlProjector({ nodeRoles: roles }));
    assert.equal(projection.value.proposals[0]?.status, "pending");
    assert.equal(projection.value.acceptedActions.length, 0);
  } finally {
    ledger.destroy();
  }
});

test("one critic objection contributes evidence but cannot veto peer-supported work", () => {
  const proposal = createDistributedControlProposal({
    authorNodeId: "painter", authorRole: "artist", rationale: "Explore a second silhouette.",
    action: {
      type: "spawn_tasks", joinStrategy: "best-score",
      tasks: [{
        taskId: "silhouette-2", role: "artist", capability: "paint.alternative", kind: "alternative",
        objective: "Try a stronger silhouette.", dependencies: [], estimatedCostMicros: 90_000,
      }],
    },
    evidenceRefs: ["scene-v1"],
  });
  const ledger = new DistributedControlLedger();
  try {
    ledger.add(update("painter", "paint-1", proposal));
    ledger.add(update("director", "direction-1", {
      kind: "endorsement", proposalId: proposal.proposalId, nodeId: "director", nodeRole: "director",
      verdict: "endorse", reason: "A bounded alternative is worth testing.", evidenceRefs: ["scene-v1"],
    }));
    ledger.add(update("critic", "review-1", {
      kind: "endorsement", proposalId: proposal.proposalId, nodeId: "critic", nodeRole: "critic",
      verdict: "object", reason: "Prefer repairing the current silhouette.", evidenceRefs: ["review-1"],
    }));
    const projection = ledger.project(artifactId, frontier, createDistributedControlProjector({ nodeRoles: roles }));
    assert.equal(projection.value.proposals[0]?.status, "accepted");
  } finally {
    ledger.destroy();
  }
});

test("an agent that equivocates has all of its votes excluded", () => {
  const proposal = createDistributedControlProposal({
    authorNodeId: "painter", authorRole: "artist", rationale: "Add a bounded detail pass.",
    action: {
      type: "spawn_tasks", joinStrategy: "all",
      tasks: [{
        taskId: "detail-2", role: "artist", capability: "paint.detail", kind: "detail",
        objective: "Add texture accents.", dependencies: [], estimatedCostMicros: 70_000,
      }],
    },
    evidenceRefs: ["scene-v1"],
  });
  const ledger = new DistributedControlLedger();
  try {
    ledger.add(update("painter", "paint-1", proposal));
    for (const verdict of ["endorse", "object"] as const) {
      ledger.add(update("critic", `review-${verdict}`, {
        kind: "endorsement", proposalId: proposal.proposalId, nodeId: "critic", nodeRole: "critic",
        verdict, reason: `Critic vote: ${verdict}.`, evidenceRefs: ["review-1"],
      }));
    }
    const projection = ledger.project(artifactId, frontier, createDistributedControlProjector({ nodeRoles: roles }));
    assert.equal(projection.value.proposals[0]?.status, "pending");
    assert.equal(projection.invalidUpdateIds.length, 2);
  } finally {
    ledger.destroy();
  }
});

test("peer agents converge on parallel alternatives and can recursively extend accepted work", () => {
  const proposal = createDistributedControlProposal({
    authorNodeId: "painter",
    authorRole: "artist",
    rationale: "Compare three compositions before committing to the next frontier.",
    action: {
      type: "spawn_tasks",
      joinStrategy: "best-score",
      tasks: [1, 2, 3].map((index) => ({
        taskId: `alternative-${index}`, role: "artist", capability: "paint.alternative", kind: "alternative" as const,
        objective: `Produce composition alternative ${index}.`, dependencies: [], estimatedCostMicros: 120_000,
      })),
    },
    evidenceRefs: ["scene-v1"],
  });
  const endorsement: DistributedControlPayload = {
    kind: "endorsement", proposalId: proposal.proposalId, nodeId: "critic", nodeRole: "critic",
    verdict: "endorse", reason: "Alternatives directly test the composition issue.", evidenceRefs: ["review-1"],
  };
  const encoded = [update("painter", "paint-1", proposal), update("critic", "review-1", endorsement)].map((item) => {
    const ledger = new DistributedControlLedger();
    try { return ledger.add(item); } finally { ledger.destroy(); }
  });
  const left = new DistributedControlLedger(mergeSharedArtifactUpdates(encoded[0]!, encoded[1]!));
  const right = new DistributedControlLedger(mergeSharedArtifactUpdates(encoded[1]!, encoded[0]!));
  try {
    const projector = createDistributedControlProjector({ nodeRoles: roles });
    const first = left.project(artifactId, frontier, projector);
    const second = right.project(artifactId, frontier, projector);
    assert.equal(first.value.proposals[0]?.status, "accepted");
    assert.equal(first.value.acceptedActions[0]?.action.type, "spawn_tasks");
    assert.equal(first.value.acceptedActions[0]?.action.type === "spawn_tasks" && first.value.acceptedActions[0].action.joinStrategy, "best-score");
    assert.equal(first.versionHash, second.versionHash);
    assert.equal(hashCanonical(first.value), hashCanonical(second.value));
  } finally {
    left.destroy();
    right.destroy();
  }
});

test("protected global changes require independent roles and conflicting joins remain unresolved", () => {
  const proposals = ["consensus", "best-score"].map((strategy, index) => createDistributedControlProposal({
    authorNodeId: index === 0 ? "painter" : "critic",
    authorRole: index === 0 ? "artist" : "critic",
    rationale: `Use ${strategy} for the next composition frontier.`,
    action: { type: "set_join_strategy", strategy: strategy as "consensus" | "best-score", reason: "Current merge is ambiguous." },
    evidenceRefs: ["scene-v1"],
  }));
  const ledger = new DistributedControlLedger();
  try {
    for (const proposal of proposals) {
      ledger.add(update(proposal.authorNodeId, `propose-${proposal.proposalId}`, proposal));
      for (const [nodeId, nodeRole] of [["director", "director"], ["finisher", "finisher"]] as const) {
        ledger.add(update(nodeId, `vote-${proposal.proposalId}-${nodeId}`, {
          kind: "endorsement", proposalId: proposal.proposalId, nodeId, nodeRole,
          verdict: "endorse", reason: "The evidence supports evaluating this join.", evidenceRefs: ["scene-v1"],
        }));
      }
    }
    const projection = ledger.project(artifactId, frontier, createDistributedControlProjector({ nodeRoles: roles }));
    assert.equal(projection.conflicts.length, 1);
    assert.ok(projection.value.proposals.every((proposal) => proposal.status === "conflicted"));
    assert.equal(projection.value.acceptedActions.length, 0);
  } finally {
    ledger.destroy();
  }
});

test("the runtime services converged actions once without becoming the decision maker", async () => {
  const calls: string[] = [];
  const projection = {
    proposals: [],
    acceptedActions: [{
      proposalId: "proposal-one",
      action: {
        type: "retire_node" as const,
        nodeId: "painter",
        reason: "Its responsibility was consolidated by peers.",
      },
    }],
  };
  const effects = {
    spawnTasks: async () => { calls.push("spawn"); },
    retireNode: async () => { calls.push("retire"); },
    transferBudget: async () => { calls.push("budget"); },
    setJoinStrategy: async () => { calls.push("join"); },
    certifyFrontier: async () => { calls.push("certify"); },
  };
  const certification = { certifiedVersionHash: "version-1", projectionVersionHash: "version-1", conflictCount: 0 };
  const once = await reconcileDistributedControl({ projection, effects, ...certification });
  const twice = await reconcileDistributedControl({ projection, effects, state: once, ...certification });
  assert.deepEqual(calls, ["retire"]);
  assert.deepEqual(twice.appliedProposalIds, ["proposal-one"]);
});

test("the runtime refuses to execute an uncertified local view", async () => {
  await assert.rejects(() => reconcileDistributedControl({
    projection: { proposals: [], acceptedActions: [] },
    certifiedVersionHash: "", projectionVersionHash: "local-view", conflictCount: 0,
    effects: {
      spawnTasks: async () => {}, retireNode: async () => {}, transferBudget: async () => {},
      setJoinStrategy: async () => {}, certifyFrontier: async () => {},
    },
  }), /uncertified/);
});

test("the runtime refuses an empty projection even when its hash is presented as certified", async () => {
  await assert.rejects(() => reconcileDistributedControl({
    projection: { proposals: [], acceptedActions: [] },
    certifiedVersionHash: "version-1", projectionVersionHash: "version-1", conflictCount: 0,
    effects: {
      spawnTasks: async () => {}, retireNode: async () => {}, transferBudget: async () => {},
      setJoinStrategy: async () => {}, certifyFrontier: async () => {},
    },
  }), /without an accepted action/);
});
