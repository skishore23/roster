import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodingNodeContinuity } from "../../src/adapters/coding-node-continuity.ts";
import { connectSpacetimeControlPlaneFromEnv } from "../../src/adapters/spacetimedb-control.ts";
import { createSpacetimeJobQueue } from "../../src/adapters/spacetimedb-job-queue.ts";
import { SpacetimeNodeContinuityControl } from "../../src/adapters/spacetimedb-node-continuity.ts";
import { createFileSystemDataReferenceStore } from "../../src/engine/dataflow/filesystem-data-reference-store.ts";

const enabled = Boolean(process.env.SPACETIMEDB_URI && process.env.SPACETIMEDB_DATABASE);

const waitFor = async <Value>(read: () => Promise<Value | undefined>, timeoutMs = 5_000): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
};

test("Coding routes one saved specialist through durable node continuity", {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceId = process.env.ROSTER_WORKSPACE_ID ?? `verification/coding-continuity/${suffix}`;
  const nodeId = `coding.implementation-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "roster-coding-continuity-"));
  const control = await connectSpacetimeControlPlaneFromEnv();
  assert.ok(control);
  const jobs = await createSpacetimeJobQueue({ control, workspaceId });
  const continuity = new SpacetimeNodeContinuityControl({ control, workspaceId });
  try {
    await control.ensureWorkspace(workspaceId, "Node continuity verification");
    await continuity.initialize();
    const integration = new CodingNodeContinuity({
      workspaceId,
      control: continuity,
      jobs,
      dataReferences: createFileSystemDataReferenceStore({
        directory,
        namespace: "coding-continuity-live",
      }),
      memoryVersion: async () => `memory-${suffix}`,
    });
    const runId = `coding-run-${suffix}`;
    const projected = await integration.enqueue({
      nodes: [{
        id: nodeId,
        name: "Kai, Implementation Engineer",
        capabilities: ["implement", "respond", "remediate"],
        runtime: { kind: "pi-agent" },
        continuity: {
          mode: "workspace",
          policyId: "coding.workspace-specialist-continuity",
          policyVersion: "1",
          wakeAgentId: "coding-agent",
          memory: "private",
          maxInboxItemsPerWake: 1,
        },
        metadata: { role: "worker", specialty: "implementation", persistent: true },
      }],
      primaryNodeId: nodeId,
      deliveryId: `message-${suffix}`,
      sourceId: `message-${suffix}`,
      sourceVersion: "route-1",
      sourceHash: `message-hash-${suffix}`,
      deliveredAt: Date.now(),
      payload: {
        kind: "coding-agent.run",
        runId,
        conversationId: runId,
        runStream: `agents/coding-agent/runs/${runId}`,
        objective: "Make one bounded verified change.",
        codingWorkspaceId: `workspace_${"a".repeat(20)}`,
        selectedNodeIds: [nodeId],
        primaryNodeId: nodeId,
      },
    });
    assert.ok(projected);
    assert.equal(projected.agentId, "coding-agent");
    assert.equal(projected.payload.kind, "coding-agent.run");
    assert.equal(projected.payload.primaryNodeId, nodeId);
    assert.equal(
      (await continuity.snapshot(workspaceId, nodeId))?.memoryFrontier?.snapshotVersion,
      `memory-${suffix}`,
    );

    const raw = await jobs.getJob(projected.id);
    assert.equal(raw?.payload.schemaVersion, "roster.node-wake-job.v1");
    const leased = await jobs.leaseNext({
      workerId: `coding-continuity-worker-${suffix}`,
      leaseMs: 5_000,
      agentId: "coding-agent",
    });
    assert.equal(leased?.id, projected.id);
    assert.ok(leased?.leaseOwner);
    assert.ok(leased?.leaseFence);
    const wake = await integration.unwrap(leased!);
    assert.ok(wake);
    assert.equal(wake.job.payload.runId, runId);
    await continuity.admitWake({
      workspaceId,
      nodeId,
      wakeId: wake.manifest.wake.wakeId,
      admittedAt: Date.now(),
      lease: { workerId: leased!.leaseOwner!, fence: leased!.leaseFence! },
    });
    assert.equal((await continuity.snapshot(workspaceId, nodeId))?.status, "working");
    const waitingRunId = `coding-run-waiting-${suffix}`;
    const queued = await integration.enqueue({
      nodes: [{
        id: nodeId,
        name: "Kai, Implementation Engineer",
        capabilities: ["implement", "respond", "remediate"],
        runtime: { kind: "pi-agent" },
        continuity: {
          mode: "workspace",
          policyId: "coding.workspace-specialist-continuity",
          policyVersion: "1",
          wakeAgentId: "coding-agent",
          memory: "private",
          maxInboxItemsPerWake: 1,
        },
        metadata: { role: "worker", specialty: "implementation", persistent: true },
      }],
      primaryNodeId: nodeId,
      deliveryId: `message-waiting-${suffix}`,
      sourceId: `message-waiting-${suffix}`,
      sourceVersion: "route-2",
      sourceHash: `message-waiting-hash-${suffix}`,
      deliveredAt: Date.now(),
      payload: {
        kind: "coding-agent.run",
        runId: waitingRunId,
        conversationId: waitingRunId,
        runStream: `agents/coding-agent/runs/${waitingRunId}`,
        objective: "Wait behind the first room, then run independently.",
        codingWorkspaceId: `workspace_${"a".repeat(20)}`,
        selectedNodeIds: [nodeId],
        primaryNodeId: nodeId,
      },
    });
    assert.equal(queued, undefined);
    assert.equal((await integration.summaries([nodeId]))[nodeId]?.pendingLaneCount, 2);
    await jobs.complete(leased!.id, leased!.leaseOwner!, { status: "completed", runId }, leased!.leaseFence);
    const secondRaw = await waitFor(async () => (await jobs.listJobs({ limit: 20 })).find((job) =>
      job.id !== projected.id && job.agentId === "coding-agent" && job.status === "queued"));
    const secondLeased = await jobs.leaseNext({
      workerId: `coding-continuity-worker-2-${suffix}`,
      leaseMs: 5_000,
      agentId: "coding-agent",
    });
    assert.equal(secondLeased?.id, secondRaw.id);
    const secondWake = await integration.unwrap(secondLeased!);
    assert.equal(secondWake?.job.payload.runId, waitingRunId);
    await continuity.admitWake({
      workspaceId,
      nodeId,
      wakeId: secondWake!.manifest.wake.wakeId,
      admittedAt: Date.now(),
      lease: { workerId: secondLeased!.leaseOwner!, fence: secondLeased!.leaseFence! },
    });
    await jobs.complete(
      secondLeased!.id,
      secondLeased!.leaseOwner!,
      { status: "completed", runId: waitingRunId },
      secondLeased!.leaseFence,
    );
    const completed = await waitFor(async () => {
      const state = await continuity.snapshot(workspaceId, nodeId);
      return state?.status === "dormant" ? state : undefined;
    });
    assert.equal(completed.pendingInbox.length, 0);
    assert.equal(completed.lastWakeId, secondWake!.manifest.wake.wakeId);

    const failedRunId = `coding-run-failed-${suffix}`;
    const failedProjected = await integration.enqueue({
      nodes: [{
        id: nodeId,
        name: "Kai, Implementation Engineer",
        capabilities: ["implement", "respond", "remediate"],
        runtime: { kind: "pi-agent" },
        continuity: {
          mode: "workspace",
          policyId: "coding.workspace-specialist-continuity",
          policyVersion: "1",
          wakeAgentId: "coding-agent",
          memory: "private",
          maxInboxItemsPerWake: 1,
        },
        metadata: { role: "worker", specialty: "implementation", persistent: true },
      }],
      primaryNodeId: nodeId,
      deliveryId: `message-failed-${suffix}`,
      sourceId: `message-failed-${suffix}`,
      sourceVersion: "route-3",
      sourceHash: `message-failed-hash-${suffix}`,
      deliveredAt: Date.now(),
      payload: {
        kind: "coding-agent.run",
        runId: failedRunId,
        conversationId: failedRunId,
        runStream: `agents/coding-agent/runs/${failedRunId}`,
        objective: "Fail once before an explicit retry.",
        codingWorkspaceId: `workspace_${"a".repeat(20)}`,
        selectedNodeIds: [nodeId],
        primaryNodeId: nodeId,
      },
    });
    assert.ok(failedProjected);
    const failedLeased = await jobs.leaseNext({
      workerId: `coding-continuity-worker-3-${suffix}`,
      leaseMs: 5_000,
      agentId: "coding-agent",
    });
    assert.equal(failedLeased?.id, failedProjected.id);
    const failedWake = await integration.unwrap(failedLeased!);
    assert.equal(failedWake?.job.payload.runId, failedRunId);
    await continuity.admitWake({
      workspaceId,
      nodeId,
      wakeId: failedWake!.manifest.wake.wakeId,
      admittedAt: Date.now(),
      lease: { workerId: failedLeased!.leaseOwner!, fence: failedLeased!.leaseFence! },
    });
    await jobs.fail(
      failedLeased!.id,
      failedLeased!.leaseOwner!,
      "review requested changes",
      true,
      undefined,
      failedLeased!.leaseFence,
    );
    await waitFor(async () => {
      const state = await continuity.snapshot(workspaceId, nodeId);
      return state?.status === "waiting" ? state : undefined;
    });

    const retryRunId = `coding-run-retry-${suffix}`;
    const retryProjected = await integration.enqueue({
      nodes: [{
        id: nodeId,
        name: "Kai, Implementation Engineer",
        capabilities: ["implement", "respond", "remediate"],
        runtime: { kind: "pi-agent" },
        continuity: {
          mode: "workspace",
          policyId: "coding.workspace-specialist-continuity",
          policyVersion: "1",
          wakeAgentId: "coding-agent",
          memory: "private",
          maxInboxItemsPerWake: 1,
        },
        metadata: { role: "worker", specialty: "implementation", persistent: true },
      }],
      primaryNodeId: nodeId,
      deliveryId: `message-retry-${suffix}`,
      sourceId: `message-retry-${suffix}`,
      sourceVersion: "route-4",
      sourceHash: `message-retry-hash-${suffix}`,
      deliveredAt: Date.now(),
      payload: {
        kind: "coding-agent.run",
        runId: retryRunId,
        conversationId: retryRunId,
        runStream: `agents/coding-agent/runs/${retryRunId}`,
        objective: "Run the retry with fresh execution identity.",
        codingWorkspaceId: `workspace_${"a".repeat(20)}`,
        selectedNodeIds: [nodeId],
        primaryNodeId: nodeId,
        retryOfJobId: failedProjected.id,
      },
    });
    assert.ok(retryProjected);
    assert.notEqual(retryProjected.id, failedProjected.id);
    assert.equal(retryProjected.payload.runId, retryRunId);
    const retryRaw = await jobs.getJob(retryProjected.id);
    assert.equal(retryRaw?.payload.schemaVersion, "roster.node-wake-job.v1");
    const retryWake = await integration.unwrap(retryRaw!);
    assert.equal(retryWake?.job.payload.runId, retryRunId);
    assert.deepEqual(retryWake?.manifest.inbox.map((item) => item.deliveryId), [`message-retry-${suffix}`]);
  } finally {
    continuity.close();
    jobs.close();
    control.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
