import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CrdtMergeLedger,
  createCrdtMergeProposal,
  createMergeProposalUpdate,
  mergeCrdtUpdates,
  type CrdtMergeProposal,
} from "../../src/engine/merge/crdt-ledger.ts";
import { buildVersionedMergePlan } from "../../src/engine/merge/versioned-contract.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const plan = buildVersionedMergePlan({
  runId: "crdt-merge",
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

const proposal = (opts: {
  readonly mergeId: string;
  readonly inputVersions: ReadonlyArray<string>;
  readonly content: string;
  readonly inputClaimIds?: ReadonlyArray<string>;
}): CrdtMergeProposal => {
  const step = plan.steps.find((candidate) => candidate.mergeId === opts.mergeId);
  assert.ok(step);
  return createCrdtMergeProposal({
    mergeId: step.mergeId,
    planVersion: plan.planVersion,
    inputVersions: opts.inputVersions,
    outputHash: hash(opts.content),
    boundaryHash: step.boundaryHash,
    content: opts.content,
    inputClaimIds: opts.inputClaimIds ?? [],
  });
};

test("Yjs merge ledger converges under reordered and repeated updates", () => {
  const [left, right, root] = plan.steps;
  assert.ok(left && right && root);
  const leftProposal = proposal({
    mergeId: left.mergeId,
    inputVersions: ["a1", "b1"],
    content: "left",
    inputClaimIds: ["a", "b"],
  });
  const rightProposal = proposal({
    mergeId: right.mergeId,
    inputVersions: ["c1", "d1"],
    content: "right",
    inputClaimIds: ["c", "d"],
  });
  const rootProposal = proposal({
    mergeId: root.mergeId,
    inputVersions: [leftProposal.outputHash, rightProposal.outputHash],
    content: "root",
    inputClaimIds: [leftProposal.proposalId, rightProposal.proposalId],
  });
  const updates = [leftProposal, rightProposal, rootProposal].map(createMergeProposalUpdate);

  const first = new CrdtMergeLedger();
  for (const update of updates) first.apply(update);
  const second = new CrdtMergeLedger();
  for (const update of [updates[2], updates[0], updates[2], updates[1], updates[0]]) {
    assert.ok(update);
    second.apply(update);
  }

  assert.deepEqual(second.proposals(), first.proposals());
  assert.deepEqual(second.project(plan), first.project(plan));
  assert.deepEqual(
    plan.steps.map((step) => first.project(plan).steps[step.mergeId]?.status),
    ["accepted", "accepted", "accepted"]
  );

  const compacted = mergeCrdtUpdates([updates[2], updates[0], updates[1], updates[0]].filter(Boolean));
  const restored = new CrdtMergeLedger(compacted);
  assert.deepEqual(restored.project(plan), first.project(plan));
  first.destroy();
  second.destroy();
  restored.destroy();
});

test("Yjs merge ledger collapses identical delivery and joins compatible evidence", () => {
  const left = plan.steps[0];
  assert.ok(left);
  const firstProposal = proposal({
    mergeId: left.mergeId,
    inputVersions: ["a1", "b1"],
    content: "same output",
    inputClaimIds: ["a"],
  });
  const evidenceVariant = proposal({
    mergeId: left.mergeId,
    inputVersions: ["a1", "b1"],
    content: "same output",
    inputClaimIds: ["b"],
  });
  const duplicateUpdate = createMergeProposalUpdate(firstProposal);
  const ledger = new CrdtMergeLedger();
  ledger.apply(duplicateUpdate);
  ledger.apply(duplicateUpdate);
  ledger.apply(createMergeProposalUpdate(evidenceVariant));

  assert.equal(ledger.proposals().length, 2);
  const projected = ledger.project(plan).steps[left.mergeId];
  assert.equal(projected?.status, "accepted");
  if (projected?.status === "accepted") {
    assert.deepEqual(projected.proposal.inputClaimIds, ["a", "b"]);
    assert.equal(projected.proposalIds.length, 2);
  }
  ledger.destroy();
});

test("Yjs merge ledger preserves divergent outputs as a multi-value conflict", () => {
  const left = plan.steps[0];
  assert.ok(left);
  const firstProposal = proposal({
    mergeId: left.mergeId,
    inputVersions: ["a1", "b1"],
    content: "route one",
  });
  const secondProposal = proposal({
    mergeId: left.mergeId,
    inputVersions: ["a1", "b1"],
    content: "route two",
  });
  const firstUpdate = createMergeProposalUpdate(firstProposal);
  const secondUpdate = createMergeProposalUpdate(secondProposal);
  const forward = new CrdtMergeLedger(mergeCrdtUpdates([firstUpdate, secondUpdate]));
  const reverse = new CrdtMergeLedger(mergeCrdtUpdates([secondUpdate, firstUpdate]));

  const forwardProjection = forward.project(plan);
  assert.deepEqual(reverse.project(plan), forwardProjection);
  const projected = forwardProjection.steps[left.mergeId];
  assert.equal(projected?.status, "conflict");
  if (projected?.status === "conflict") {
    assert.equal(projected.proposals.length, 2);
    assert.deepEqual(projected.outputHashes, [firstProposal.outputHash, secondProposal.outputHash].sort());
  }
  assert.equal(forwardProjection.steps[plan.steps[2]?.mergeId ?? ""]?.status, "pending");
  forward.destroy();
  reverse.destroy();
});

test("Yjs merge ledger excludes proposals with incompatible input versions", () => {
  const left = plan.steps[0];
  assert.ok(left);
  const invalid = proposal({
    mergeId: left.mergeId,
    inputVersions: ["stale-a", "b1"],
    content: "stale",
  });
  const ledger = new CrdtMergeLedger(createMergeProposalUpdate(invalid));
  const projection = ledger.project(plan);
  assert.equal(projection.steps[left.mergeId]?.status, "invalid");
  assert.deepEqual(projection.invalidProposals.map((entry) => entry.reason), ["input_conflict"]);
  ledger.destroy();
});

test("Yjs merge ledger retains stale and premature proposals without applying them", () => {
  const [left, _right, root] = plan.steps;
  assert.ok(left && root);
  const stalePlanProposal = createCrdtMergeProposal({
    mergeId: left.mergeId,
    planVersion: `${plan.planVersion}-stale`,
    inputVersions: ["a1", "b1"],
    outputHash: hash("stale plan"),
    boundaryHash: left.boundaryHash,
    content: "stale plan",
    inputClaimIds: [],
  });
  const unknownProposal = createCrdtMergeProposal({
    mergeId: "merge-unknown",
    planVersion: plan.planVersion,
    inputVersions: ["a1", "b1"],
    outputHash: hash("unknown"),
    boundaryHash: "unknown-boundary",
    content: "unknown",
    inputClaimIds: [],
  });
  const boundaryConflict = createCrdtMergeProposal({
    mergeId: left.mergeId,
    planVersion: plan.planVersion,
    inputVersions: ["a1", "b1"],
    outputHash: hash("wrong boundary"),
    boundaryHash: "wrong-boundary",
    content: "wrong boundary",
    inputClaimIds: [],
  });
  const prematureRoot = createCrdtMergeProposal({
    mergeId: root.mergeId,
    planVersion: plan.planVersion,
    inputVersions: ["left", "right"],
    outputHash: hash("premature root"),
    boundaryHash: root.boundaryHash,
    content: "premature root",
    inputClaimIds: [],
  });
  const ledger = new CrdtMergeLedger(mergeCrdtUpdates([
    stalePlanProposal,
    unknownProposal,
    boundaryConflict,
    prematureRoot,
  ].map(createMergeProposalUpdate)));
  const projection = ledger.project(plan);

  assert.equal(ledger.proposals().length, 4);
  assert.equal(projection.steps[left.mergeId]?.status, "invalid");
  assert.equal(projection.steps[root.mergeId]?.status, "pending");
  assert.deepEqual(projection.invalidProposals.map((entry) => entry.reason), ["boundary_conflict"]);
  ledger.destroy();
});
