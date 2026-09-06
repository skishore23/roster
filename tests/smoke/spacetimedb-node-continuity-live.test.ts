import assert from "node:assert/strict";
import test from "node:test";

import { connectSpacetimeControlPlaneFromEnv } from "../../src/adapters/spacetimedb-control.ts";
import { SpacetimeNodeContinuityControl } from "../../src/adapters/spacetimedb-node-continuity.ts";

const enabled = Boolean(process.env.SPACETIMEDB_URI && process.env.SPACETIMEDB_DATABASE);

const waitFor = async <Value>(read: () => Value | undefined, timeoutMs = 10_000): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
};

test("SpacetimeDB executes the complete framework node continuity lifecycle", {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = process.env.ROSTER_WORKSPACE_ID ?? `verification/node-continuity/${suffix}`;
  const nodeId = `researcher-${suffix}`;
  const control = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(control);
  const continuity = new SpacetimeNodeContinuityControl({ control, workspaceId });
  const jobs = control.subscribeRosterJobs(workspaceId);
  try {
    await control.ensureWorkspace(workspaceId, "Node continuity verification");
    await control.ensureWorkspace(workspaceId, "Renamed node continuity verification");
    await control.ensureWorkspace(workspaceId, "Node continuity verification");
    await Promise.all([continuity.initialize(), jobs.ready]);
    const registered = await continuity.register({
      workspaceId,
      node: {
        id: nodeId,
        name: "Durable Researcher",
        capabilities: ["respond"],
        runtime: { kind: "roster-native" },
        continuity: { mode: "workspace", maxCausalDepth: 2, maxInboxItemsPerWake: 1 },
      },
      nodeRevision: 1,
      occurredAt: Date.now(),
    });
    assert.equal(registered.status, "dormant");
    assert.equal(registered.memoryFrontier?.scopeId, undefined);
    const revised = await continuity.register({
      workspaceId,
      node: {
        id: nodeId,
        name: "Durable Researcher",
        capabilities: ["investigate", "respond"],
        runtime: { kind: "roster-native" },
        continuity: { mode: "workspace", maxCausalDepth: 2, maxInboxItemsPerWake: 1 },
      },
      nodeRevision: "next-on-change",
      occurredAt: Date.now(),
    });
    const replayedRevision = await continuity.register({
      workspaceId,
      node: {
        id: nodeId,
        name: "Durable Researcher",
        capabilities: ["investigate", "respond"],
        runtime: { kind: "roster-native" },
        continuity: { mode: "workspace", maxCausalDepth: 2, maxInboxItemsPerWake: 1 },
      },
      nodeRevision: "next-on-change",
      occurredAt: Date.now(),
    });
    assert.equal(revised.nodeRevision, 2);
    assert.equal(replayedRevision.nodeRevision, 2);

    const delivery = await continuity.deliverAndRequestWake({
      workspaceId,
      nodeId,
      deliveryId: `delivery-${suffix}`,
      cause: "direct",
      scope: { laneId: `room-${suffix}`, roomId: `room-${suffix}`, runId: `run-${suffix}` },
      sourceId: `message-${suffix}`,
      sourceVersion: "1",
      sourceHash: `hash-${suffix}`,
      causalDepth: 0,
      deliveredAt: Date.now(),
      wake: { requestId: `wake-${suffix}`, requestedAt: Date.now() },
    });
    assert.equal(delivery.wake.admitted, true);
    assert.ok(delivery.state.activeWake);
    const wakeId = delivery.state.activeWake.wakeId;
    const manifest = await continuity.manifest(workspaceId, nodeId, wakeId);
    assert.equal(manifest.nodeId, nodeId);
    assert.deepEqual(manifest.inbox.map((item) => item.deliveryId), [`delivery-${suffix}`]);

    const job = await waitFor(() => control.jobSnapshot(workspaceId).jobs.find((candidate) =>
      candidate.agentId === "roster-node-continuity"));
    const workerId = `continuity-worker-${suffix}`;
    const claimToken = `continuity-claim-${suffix}`;
    await control.claimNextRosterJob({
      workspaceId,
      workerId,
      claimToken,
      leaseMs: 15_000,
      agentId: "roster-node-continuity",
    });
    const leased = await waitFor(() => control.jobSnapshot(workspaceId).jobs.find((candidate) =>
      candidate.id === job.id && candidate.claimToken === claimToken));
    await control.admitRosterNodeWake({
      workspaceId,
      wakeId,
      workerId,
      fence: leased.leaseFence,
    });
    assert.equal((await continuity.snapshot(workspaceId, nodeId))?.status, "working");
    const waitingDeliveryId = `delivery-waiting-${suffix}`;
    const waiting = await continuity.deliverAndRequestWake({
      workspaceId,
      nodeId,
      deliveryId: waitingDeliveryId,
      cause: "direct",
      scope: { laneId: `room-waiting-${suffix}`, roomId: `room-waiting-${suffix}`, runId: `run-waiting-${suffix}` },
      sourceId: `message-waiting-${suffix}`,
      sourceVersion: "1",
      sourceHash: `hash-waiting-${suffix}`,
      causalDepth: 0,
      deliveredAt: Date.now(),
      wake: { requestId: `wake-waiting-${suffix}`, requestedAt: Date.now() },
    });
    assert.deepEqual(waiting.wake, { admitted: false, reason: "already-active" });
    assert.equal(waiting.state.pendingInbox.length, 2);
    await control.completeRosterJob({
      workspaceId,
      jobId: leased.id,
      workerId,
      fence: leased.leaseFence,
      resultJson: JSON.stringify({ accepted: true }),
    });
    const automaticallyContinued = await waitFor(() => {
      const state = control.nodeContinuitySnapshot(workspaceId).continuities
        .find((candidate) => candidate.nodeId === nodeId);
      return state?.status === "queued" && state.activeWakeId && state.activeWakeId !== wakeId ? state : undefined;
    });
    assert.notEqual(automaticallyContinued.activeWakeId, "");
    // Adapter completion remains replay-safe after the job reducer atomically
    // settled the continuity boundary.
    await continuity.completeWake({
      workspaceId,
      nodeId,
      wakeId,
      consumedDeliveryIds: [`delivery-${suffix}`],
      occurredAt: Date.now(),
    });
    const continued = await continuity.snapshot(workspaceId, nodeId);
    assert.equal(continued?.activeWake?.laneId, `room-waiting-${suffix}`);
    assert.deepEqual(continued?.pendingInbox.map((item) => item.deliveryId), [waitingDeliveryId]);
    const secondJob = await waitFor(() => control.jobSnapshot(workspaceId).jobs.find((candidate) =>
      candidate.agentId === "roster-node-continuity" && candidate.id !== job.id));
    const secondClaimToken = `continuity-claim-waiting-${suffix}`;
    await control.claimNextRosterJob({
      workspaceId,
      workerId,
      claimToken: secondClaimToken,
      leaseMs: 15_000,
      agentId: "roster-node-continuity",
    });
    const secondLeased = await waitFor(() => control.jobSnapshot(workspaceId).jobs.find((candidate) =>
      candidate.id === secondJob.id && candidate.claimToken === secondClaimToken));
    await control.admitRosterNodeWake({
      workspaceId,
      wakeId: automaticallyContinued.activeWakeId,
      workerId,
      fence: secondLeased.leaseFence,
    });
    await control.completeRosterJob({
      workspaceId,
      jobId: secondLeased.id,
      workerId,
      fence: secondLeased.leaseFence,
      resultJson: JSON.stringify({ accepted: true }),
    });
    const completed = await waitFor(() => {
      const state = control.nodeContinuitySnapshot(workspaceId).continuities.find((candidate) => candidate.nodeId === nodeId);
      return state?.status === "dormant" ? state : undefined;
    });
    assert.equal(completed.pendingInboxCount, 0);
  } finally {
    jobs.close();
    continuity.close();
    control.disconnect();
  }
});
