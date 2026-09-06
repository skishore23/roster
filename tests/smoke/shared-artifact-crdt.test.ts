import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "../../src/core/canonical.ts";
import {
  createSharedArtifactUpdate,
  mergeSharedArtifactUpdates,
  SharedArtifactLedger,
  type ArtifactProjector,
} from "../../src/engine/artifact/shared-crdt.ts";

type Candidate = { readonly slot: string; readonly value: string };

const projector: ArtifactProjector<Candidate, Readonly<Record<string, string>>> = (updates, frontier) => {
  const current = updates.filter((update) =>
    update.frontierVersion === frontier.frontierVersion
    && update.topologyVersion === frontier.topologyVersion
  );
  const staleUpdateIds = updates
    .filter((update) => !current.includes(update))
    .map((update) => update.updateId);
  const bySlot = new Map<string, typeof current>();
  for (const update of current) bySlot.set(update.payload.slot, [...(bySlot.get(update.payload.slot) ?? []), update]);
  const value: Record<string, string> = {};
  const acceptedUpdateIds: string[] = [];
  const conflicts = [];
  for (const [slot, candidates] of bySlot) {
    const values = new Set(candidates.map((candidate) => candidate.payload.value));
    if (values.size > 1) {
      conflicts.push({
        conflictId: `conflict_${hashCanonical({ slot, values: [...values].sort() }).slice(0, 16)}`,
        kind: "slot",
        subjectId: slot,
        candidateUpdateIds: candidates.map((candidate) => candidate.updateId).sort(),
        candidateHashes: candidates.map((candidate) => candidate.payloadHash).sort(),
      });
      continue;
    }
    const candidate = candidates[0];
    if (candidate) {
      value[slot] = candidate.payload.value;
      acceptedUpdateIds.push(...candidates.map((entry) => entry.updateId));
    }
  }
  return {
    value,
    acceptedUpdateIds: acceptedUpdateIds.sort(),
    conflicts,
    invalidUpdateIds: [],
    staleUpdateIds: staleUpdateIds.sort(),
  };
};

const update = (nodeId: string, slot: string, value: string, topologyVersion = "topology-1") =>
  createSharedArtifactUpdate<Candidate>({
    artifactId: "run-1:document",
    artifactKind: "document",
    schemaVersion: "v1",
    frontierVersion: "frontier-1",
    topologyVersion,
    runId: "run-1",
    taskId: `task-${nodeId}`,
    nodeId,
    inputVersions: {},
    payload: { slot, value },
  });

test("shared artifact updates converge and remain independently extensible", () => {
  const first = new SharedArtifactLedger<Candidate>();
  const second = new SharedArtifactLedger<Candidate>();
  const a = first.add(update("a", "title", "Convergent systems"));
  const b = second.add(update("b", "body", "Agents extend a shared artifact."));
  const merged = mergeSharedArtifactUpdates(b, a, a);
  const left = new SharedArtifactLedger<Candidate>({ update: merged });
  const right = new SharedArtifactLedger<Candidate>();
  right.apply(a);
  right.apply(b);
  assert.deepEqual(left.updates(), right.updates());
  assert.deepEqual(
    left.project("run-1:document", { frontierVersion: "frontier-1", topologyVersion: "topology-1" }, projector),
    right.project("run-1:document", { frontierVersion: "frontier-1", topologyVersion: "topology-1" }, projector)
  );
  first.destroy(); second.destroy(); left.destroy(); right.destroy();
});

test("domain projection exposes concurrent semantic conflict", () => {
  const ledger = new SharedArtifactLedger<Candidate>();
  ledger.add(update("a", "title", "One title"));
  ledger.add(update("b", "title", "Another title"));
  const projection = ledger.project(
    "run-1:document",
    { frontierVersion: "frontier-1", topologyVersion: "topology-1" },
    projector
  );
  assert.equal(projection.conflicts.length, 1);
  assert.deepEqual(projection.value, {});
  ledger.destroy();
});

test("rebracketing changes projection applicability without rewriting CRDT history", () => {
  const ledger = new SharedArtifactLedger<Candidate>();
  const oldUpdate = update("a", "body", "old bracket", "topology-1");
  const newUpdate = update("b", "body", "new bracket", "topology-2");
  ledger.add(oldUpdate);
  ledger.add(newUpdate);
  const projection = ledger.project(
    "run-1:document",
    { frontierVersion: "frontier-1", topologyVersion: "topology-2" },
    projector
  );
  assert.deepEqual(projection.value, { body: "new bracket" });
  assert.deepEqual(projection.staleUpdateIds, [oldUpdate.updateId]);
  assert.equal(ledger.updates().length, 2);
  ledger.destroy();
});
