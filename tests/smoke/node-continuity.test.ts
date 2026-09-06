import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import { createDynamicTaskDefinition } from "../../src/engine/orchestration/task-graph.ts";
import { defineRosterPlatform } from "../../src/engine/platform/roster-platform.ts";
import { RosterNodeContinuityPlatform } from "../../src/engine/platform/node-continuity-platform.ts";
import {
  nodePrivateMemoryScopeId,
  scopeRosterMemoryRepositoryToNode,
  type RosterMemoryRepository,
} from "../../src/engine/runtime/node-memory-plane.ts";
import {
  createNodeContinuityManifest,
  createNodeInboxDelivery,
  InMemoryNodeContinuityControl,
  normalizeWorkspaceNodeContinuityPolicy,
  projectNodeContinuitySummary,
  reduceNodeContinuity,
  requestNodeWake,
  type NodeContinuityEvent,
  type NodeContinuityState,
} from "../../src/engine/workspace/node-continuity.ts";
import { normalizeWorkspaceNode } from "../../src/engine/workspace/node.ts";

const registered = (occurredAt = 1_000): NodeContinuityEvent => ({
  type: "node.continuity.registered",
  workspaceId: "workspace-alpha",
  nodeId: "researcher",
  nodeRevision: 1,
  policy: normalizeWorkspaceNodeContinuityPolicy({
    mode: "workspace",
    maxCausalDepth: 2,
    maxWakesPerWindow: 2,
    wakeWindowMs: 60_000,
  }),
  occurredAt,
});

const initialState = (): NodeContinuityState => reduceNodeContinuity(undefined, registered());

test("workspace continuity is a typed node policy independent from runtime placement", () => {
  const node = normalizeWorkspaceNode({
    id: "researcher",
    name: "Researcher",
    capabilities: ["research"],
    runtime: { kind: "codex-cli", profile: "research" },
    continuity: { mode: "workspace", maxCausalDepth: 3 },
  });
  assert.equal(node.continuity?.mode, "workspace");
  assert.equal(node.continuity?.memory, "private");
  assert.equal(node.continuity?.maxCausalDepth, 3);
  assert.equal(node.runtime.kind, "codex-cli");
});

test("next-on-change registration advances a changed canonical node exactly once", async () => {
  const control = new InMemoryNodeContinuityControl();
  const initial = normalizeWorkspaceNode({
    id: "workspace.implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["implement", "respond"],
    runtime: { kind: "pi-agent" },
    continuity: { mode: "workspace" },
  });
  await control.register({
    workspaceId: "workspace-alpha",
    node: initial,
    nodeRevision: 1,
    occurredAt: 1_000,
  });
  const changed = normalizeWorkspaceNode({
    ...initial,
    capabilities: ["implement", "investigate", "respond"],
  });

  const revised = await control.register({
    workspaceId: "workspace-alpha",
    node: changed,
    nodeRevision: "next-on-change",
    occurredAt: 1_100,
  });
  const replayed = await control.register({
    workspaceId: "workspace-alpha",
    node: changed,
    nodeRevision: "next-on-change",
    occurredAt: 1_200,
  });

  assert.equal(revised.nodeRevision, 2);
  assert.equal(replayed.nodeRevision, 2);
});

test("inbox delivery, wake admission, and completion replay deterministically", () => {
  let state = initialState();
  const delivery = createNodeInboxDelivery(state, {
    deliveryId: "delivery-1",
    cause: "direct",
    scope: { laneId: "room-alpha", roomId: "room-alpha", runId: "run-alpha" },
    sourceId: "message-1",
    sourceVersion: "1",
    sourceHash: "sha256-message-1",
    payloadReference: "artifact:message-1",
    causalDepth: 0,
    deliveredAt: 1_100,
  });
  state = reduceNodeContinuity(state, delivery);
  assert.equal(state.status, "waiting");
  assert.deepEqual(state.pendingInbox.map((item) => item.deliveryId), ["delivery-1"]);
  assert.equal(reduceNodeContinuity(state, delivery), state, "exact delivery replay must be idempotent");

  const decision = requestNodeWake(state, { requestId: "wake-request-1", requestedAt: 1_200 });
  assert.equal(decision.admitted, true);
  if (!decision.admitted) return;
  state = reduceNodeContinuity(state, decision.event);
  const manifest = createNodeContinuityManifest(state);
  assert.equal(manifest.nodeId, "researcher");
  assert.equal(manifest.inbox[0]?.sourceHash, "sha256-message-1");
  assert.match(manifest.manifestId, /^node_continuity_manifest_/);

  state = reduceNodeContinuity(state, {
    type: "node.wake.admitted",
    wakeId: decision.event.wake.wakeId,
    occurredAt: 1_300,
  });
  assert.equal(state.status, "working");
  state = reduceNodeContinuity(state, {
    type: "node.wake.completed",
    wakeId: decision.event.wake.wakeId,
    consumedDeliveryIds: ["delivery-1"],
    occurredAt: 1_400,
  });
  assert.equal(state.status, "dormant");
  assert.equal(state.pendingInbox.length, 0);
});

test("an explicit retry can supersede the exact failed wake without replaying its delivery", async () => {
  const control = new InMemoryNodeContinuityControl();
  const node = normalizeWorkspaceNode({
    id: "researcher",
    name: "Researcher",
    capabilities: ["research"],
    runtime: { kind: "roster-native" },
    continuity: { mode: "workspace", maxInboxItemsPerWake: 1 },
  });
  await control.register({ workspaceId: "workspace-alpha", node, nodeRevision: 1, occurredAt: 1_000 });
  const first = await control.deliverAndRequestWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    deliveryId: "delivery-failed",
    cause: "direct",
    scope: { laneId: "room-alpha", roomId: "room-alpha", runId: "run-failed" },
    sourceId: "message-failed",
    sourceVersion: "route-failed",
    sourceHash: "hash-failed",
    causalDepth: 0,
    deliveredAt: 1_100,
    wake: { requestId: "wake-failed", requestedAt: 1_100 },
  });
  assert.equal(first.wake.admitted, true);
  const wakeId = first.state.activeWake!.wakeId;
  await control.admitWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    wakeId,
    admittedAt: 1_200,
  });
  const failed = await control.failWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    wakeId,
    error: "review requested changes",
    occurredAt: 1_300,
  });
  assert.deepEqual(failed.pendingInbox.map((item) => item.deliveryId), ["delivery-failed"]);
  const resolved = await control.resolveFailedWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    wakeId,
    resolution: "superseded",
    occurredAt: 1_400,
  });
  assert.equal(resolved.status, "dormant");
  assert.equal(resolved.pendingInbox.length, 0);

  const retry = await control.deliverAndRequestWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    deliveryId: "delivery-retry",
    cause: "direct",
    scope: { laneId: "room-alpha", roomId: "room-alpha", runId: "run-retry" },
    sourceId: "message-retry",
    sourceVersion: "route-retry",
    sourceHash: "hash-retry",
    causalDepth: 0,
    deliveredAt: 1_500,
    wake: { requestId: "wake-retry", requestedAt: 1_500 },
  });
  assert.equal(retry.wake.admitted, true);
  assert.equal(retry.state.activeWake?.runId, "run-retry");
  assert.deepEqual(
    (await control.manifest("workspace-alpha", node.id, retry.state.activeWake!.wakeId))
      .inbox.map((item) => item.deliveryId),
    ["delivery-retry"],
  );
});

test("one active wake and causal bounds prevent recursive agent loops", () => {
  let state = initialState();
  state = reduceNodeContinuity(state, createNodeInboxDelivery(state, {
    deliveryId: "delivery-bounded",
    cause: "stream",
    scope: { laneId: "room-bounded", roomId: "room-bounded" },
    sourceId: "peer-message",
    sourceVersion: "1",
    sourceHash: "peer-hash",
    causalParentId: "delivery-parent",
    causalDepth: 2,
    deliveredAt: 2_000,
  }));
  assert.throws(() => createNodeInboxDelivery(state, {
    deliveryId: "delivery-too-deep",
    cause: "stream",
    scope: { laneId: "room-bounded", roomId: "room-bounded" },
    sourceId: "peer-message-2",
    sourceVersion: "1",
    sourceHash: "peer-hash-2",
    causalParentId: "delivery-bounded",
    causalDepth: 3,
    deliveredAt: 2_100,
  }), /maxCausalDepth/);
  const first = requestNodeWake(state, { requestId: "wake-one", requestedAt: 2_200 });
  assert.equal(first.admitted, true);
  if (!first.admitted) return;
  state = reduceNodeContinuity(state, first.event);
  assert.deepEqual(requestNodeWake(state, {
    requestId: "wake-two",
    requestedAt: 2_300,
  }), { admitted: false, reason: "already-active" });
});

test("busy nodes preserve room lanes and continue with the oldest waiting room", async () => {
  const control = new InMemoryNodeContinuityControl();
  const node = normalizeWorkspaceNode({
    id: "researcher",
    name: "Researcher",
    capabilities: ["research"],
    runtime: { kind: "roster-native" },
    continuity: { mode: "workspace", maxInboxItemsPerWake: 1 },
  });
  await control.register({ workspaceId: "workspace-alpha", node, nodeRevision: 1, occurredAt: 3_000 });
  const first = await control.deliverAndRequestWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    deliveryId: "delivery-room-a",
    cause: "direct",
    scope: { laneId: "room-a", roomId: "room-a", runId: "run-a" },
    sourceId: "message-a",
    sourceVersion: "1",
    sourceHash: "hash-a",
    causalDepth: 0,
    deliveredAt: 3_100,
    wake: { requestId: "wake-room-a", requestedAt: 3_100 },
  });
  assert.equal(first.wake.admitted, true);
  assert.equal(first.state.activeWake?.laneId, "room-a");
  await control.admitWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    wakeId: first.state.activeWake!.wakeId,
    admittedAt: 3_200,
  });
  const second = await control.deliverAndRequestWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    deliveryId: "delivery-room-b",
    cause: "direct",
    scope: { laneId: "room-b", roomId: "room-b", runId: "run-b" },
    sourceId: "message-b",
    sourceVersion: "1",
    sourceHash: "hash-b",
    causalDepth: 0,
    deliveredAt: 3_300,
    wake: { requestId: "wake-room-b", requestedAt: 3_300 },
  });
  assert.deepEqual(second.wake, { admitted: false, reason: "already-active" });
  assert.deepEqual(second.state.pendingInbox.map((item) => item.scope.roomId), ["room-a", "room-b"]);

  const continued = await control.completeWake({
    workspaceId: "workspace-alpha",
    nodeId: node.id,
    wakeId: first.state.activeWake!.wakeId,
    consumedDeliveryIds: ["delivery-room-a"],
    occurredAt: 3_400,
  });
  assert.equal(continued.status, "queued");
  assert.equal(continued.activeWake?.laneId, "room-b");
  assert.deepEqual((await control.manifest(
    "workspace-alpha",
    node.id,
    continued.activeWake!.wakeId,
  )).inbox.map((item) => item.deliveryId), ["delivery-room-b"]);
  assert.deepEqual(projectNodeContinuitySummary(continued).lanes.map((lane) => ({
    roomId: lane.roomId,
    active: lane.active,
  })), [{ roomId: "room-b", active: true }]);
});

test("commitments and private memory frontier are pinned into the wake manifest", () => {
  let state = initialState();
  state = reduceNodeContinuity(state, {
    type: "node.commitment.changed",
    commitment: {
      commitmentId: "commitment-1",
      objective: "Follow up after the evidence arrives.",
      status: "waiting",
      revision: 1,
      sourceId: "handoff-1",
      updatedAt: 1_050,
    },
    occurredAt: 1_050,
  });
  state = reduceNodeContinuity(state, {
    type: "node.memory.frontier.updated",
    frontier: {
      scopeId: "node:workspace-alpha:researcher",
      snapshotVersion: "memory-v4",
      updatedAt: 1_060,
    },
    occurredAt: 1_060,
  });
  state = reduceNodeContinuity(state, createNodeInboxDelivery(state, {
    deliveryId: "delivery-evidence",
    cause: "state",
    scope: { laneId: "room-evidence", roomId: "room-evidence" },
    sourceId: "evidence-1",
    sourceVersion: "2",
    sourceHash: "evidence-hash",
    causalDepth: 0,
    deliveredAt: 1_100,
  }));
  const decision = requestNodeWake(state, { requestId: "wake-evidence", requestedAt: 1_200 });
  assert.equal(decision.admitted, true);
  if (!decision.admitted) return;
  state = reduceNodeContinuity(state, decision.event);
  const manifest = createNodeContinuityManifest(state);
  assert.equal(manifest.commitments[0]?.commitmentId, "commitment-1");
  assert.equal(manifest.memoryFrontier?.snapshotVersion, "memory-v4");
});

test("the platform binds a wake to the actual node and exact continuity reference", async () => {
  const platform = defineRosterPlatform({
    id: "continuity-platform",
    version: "1",
    policyVersion: "1",
    coordinatorId: "researcher",
    coordinatorCapability: "respond",
    capabilities: [{ id: "respond", description: "Respond to a bounded wake." }],
    nodes: [
      {
        id: "researcher",
        name: "Researcher",
        capabilities: ["respond"],
        runtime: { kind: "roster-native" },
        continuity: { mode: "workspace" },
      },
      {
        id: "ephemeral",
        name: "Ephemeral",
        capabilities: ["respond"],
        runtime: { kind: "roster-native" },
      },
    ],
    maxNodes: 2,
    policy: {
      maxTasks: 8,
      maxDepth: 2,
      maxInflight: 1,
      maxAttempts: 2,
      maxContextBytes: 1_000_000,
      maxCostMicros: 1_000_000,
      maxTokens: 100_000,
      maxWallTimeMs: 60_000,
    },
  });
  const service = new RosterNodeContinuityPlatform({
    workspaceId: "workspace-alpha",
    platform,
    control: new InMemoryNodeContinuityControl(),
    dataReferences: new InMemoryDataReferenceStore(),
  });
  const registeredStates = await service.registerWorkspaceNodes({ occurredAt: 10_000 });
  assert.deepEqual(registeredStates.map((state) => state.nodeId), ["researcher"]);
  const delivered = await service.deliver({
    nodeId: "researcher",
    deliveryId: "platform-delivery",
    cause: "direct",
    scope: { laneId: "room-platform", roomId: "room-platform" },
    sourceId: "platform-message",
    sourceVersion: "1",
    sourceHash: "platform-message-hash",
    causalDepth: 0,
    deliveredAt: 10_100,
    wake: { requestId: "platform-wake", requestedAt: 10_200 },
  });
  assert.equal(delivered.wake?.admitted, true);
  const prepared = await service.prepareWake("researcher");
  await service.deliver({
    nodeId: "researcher",
    deliveryId: "later-delivery",
    cause: "task",
    scope: { laneId: "room-later", roomId: "room-later" },
    sourceId: "later-task",
    sourceVersion: "1",
    sourceHash: "later-task-hash",
    causalDepth: 0,
    deliveredAt: 10_300,
  });
  const replayedPrepared = await service.prepareWake("researcher");
  assert.equal(replayedPrepared.manifest.manifestId, prepared.manifest.manifestId);
  assert.deepEqual(
    replayedPrepared.manifest.inbox.map((item) => item.deliveryId),
    ["platform-delivery"],
    "later inbox delivery must not change the admitted wake manifest",
  );
  const definition = createDynamicTaskDefinition({
    taskId: "wake-task",
    semanticKey: "wake-task",
    nodeId: "researcher",
    capability: "respond",
    objective: "Respond to the exact admitted wake.",
    handler: { kind: "roster.node", version: "1" },
    acceptance: { policyId: "roster.accept.default", policyVersion: "1" },
    result: { mode: "text", outputKey: "reply" },
    dependencies: [],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: { continuity: prepared.reference.contentHash },
      dataReferences: [prepared.reference],
      frontierVersion: "frontier-1",
      topologyVersion: "topology-1",
      catalogVersion: "catalog-1",
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 30_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });
  service.assertWakeTask(prepared, definition);
  assert.throws(() => service.assertWakeTask(prepared, {
    ...definition,
    nodeId: "ephemeral",
  }), /launders researcher through ephemeral/);
});

test("node-private memory rejects another logical node before repository access", async () => {
  let searched = false;
  const scopeId = nodePrivateMemoryScopeId("workspace-alpha", "researcher");
  const repository: RosterMemoryRepository = {
    scopes: async () => [{
      scopeId,
      kind: "memory",
      label: "Private memory",
      description: "Accepted node memory.",
      writable: true,
    }],
    search: async () => {
      searched = true;
      return [];
    },
    open: async () => [],
    diff: async () => [],
  };
  const scoped = scopeRosterMemoryRepositoryToNode({
    repository,
    workspaceId: "workspace-alpha",
    nodeId: "researcher",
  });
  const signal = new AbortController().signal;
  await assert.rejects(scoped.search({ scopeId, query: "history", limit: 5 }, {
    nodeId: "other-node",
    signal,
  }), /cannot access private memory owned by researcher/);
  assert.equal(searched, false);
  await scoped.search({ scopeId, query: "history", limit: 5 }, { nodeId: "researcher", signal });
  assert.equal(searched, true);
});
