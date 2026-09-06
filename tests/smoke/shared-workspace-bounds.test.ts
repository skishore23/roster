import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileSystemSharedWorkspace,
  createTaskGraphWorkspaceContextFactory,
} from "../../src/engine/workspace/filesystem-shared-workspace.ts";
import {
  createRosterTaskContext,
  createWorkspaceEntry,
  SharedWorkspaceLedger,
  type SharedWorkspaceLimits,
} from "../../src/engine/workspace/shared-workspace.ts";
import { InMemoryTaskGraphControl } from "../../src/engine/orchestration/task-graph-control.ts";
import { createDynamicTaskDefinition } from "../../src/engine/orchestration/task-graph.ts";
import type { JsonValue } from "../../src/engine/orchestration/types.ts";

const frontier = { frontierVersion: "frontier-1", topologyVersion: "topology-1" };

const publishFinding = (
  ledger: SharedWorkspaceLedger,
  subjectId: string,
  body: JsonValue = { summary: subjectId },
) => ledger.publish({
  runId: "run-1",
  taskId: `task-${subjectId}`,
  nodeId: "researcher",
  ...frontier,
  entry: {
    kind: "finding",
    mode: "append",
    subjectId,
    body,
    references: [],
  },
});

test("workspace entries reject oversized subjects, references, and bodies before publication", () => {
  const limits: Partial<SharedWorkspaceLimits> = {
    maxSubjectBytes: 8,
    maxReferences: 1,
    maxReferenceBytes: 8,
    maxBodyBytes: 32,
  };
  const base = {
    kind: "finding" as const,
    mode: "append" as const,
    subjectId: "subject",
    nodeId: "node",
    body: { ok: true },
    references: [] as string[],
  };

  assert.throws(() => createWorkspaceEntry({ ...base, subjectId: "too-long-subject" }, limits), /subject id exceeds/);
  assert.throws(() => createWorkspaceEntry({ ...base, references: ["one", "two"] }, limits), /references exceed/);
  assert.throws(() => createWorkspaceEntry({ ...base, references: ["reference-too-long"] }, limits), /reference exceeds/);
  assert.throws(() => createWorkspaceEntry({ ...base, body: { text: "x".repeat(64) } }, limits), /body exceeds/);
});

test("workspace publication bounds metadata, input versions, and total local entries", () => {
  const ledger = new SharedWorkspaceLedger("workspace-bounds", undefined, {
    maxIdentifierBytes: 16,
    maxInputVersions: 1,
    maxInputVersionKeyBytes: 4,
    maxInputVersionValueBytes: 4,
    maxEntries: 1,
  });

  assert.throws(() => ledger.publish({
    runId: "run-1",
    taskId: "task-1",
    nodeId: "researcher",
    ...frontier,
    inputVersions: { first: "1", second: "2" },
    entry: { kind: "finding", mode: "append", subjectId: "one", body: null, references: [] },
  }), /input versions exceed/);
  assert.throws(() => ledger.publish({
    runId: "run-1",
    taskId: "task-1",
    nodeId: "researcher",
    ...frontier,
    inputVersions: { oversized: "1" },
    entry: { kind: "finding", mode: "append", subjectId: "one", body: null, references: [] },
  }), /version key exceeds/);
  assert.throws(() => ledger.publish({
    runId: "run-1",
    taskId: "task-1",
    nodeId: "researcher",
    ...frontier,
    inputVersions: { one: "value-too-long" },
    entry: { kind: "finding", mode: "append", subjectId: "one", body: null, references: [] },
  }), /version one exceeds/);
  assert.throws(() => ledger.publish({
    runId: "run-id-that-is-too-long",
    taskId: "task-1",
    nodeId: "researcher",
    ...frontier,
    entry: { kind: "finding", mode: "append", subjectId: "one", body: null, references: [] },
  }), /run id exceeds/);

  publishFinding(ledger, "one");
  assert.throws(() => publishFinding(ledger, "two"), /entry limit 1 reached/);
  assert.equal(ledger.project(frontier).value.entries.length, 1);
  ledger.destroy();
});

test("oversized locally encoded updates are rolled back atomically", () => {
  const ledger = new SharedWorkspaceLedger("workspace-local-update", undefined, {
    maxBodyBytes: 1_024,
    maxUpdateBytes: 128,
  });
  assert.throws(() => publishFinding(ledger, "large", { text: "x".repeat(256) }), /update exceeds 128 bytes/);
  assert.equal(ledger.project(frontier).value.entries.length, 0);
  ledger.destroy();
});

test("remote workspace updates are size checked before decoding and schema checked before admission", () => {
  const source = new SharedWorkspaceLedger("workspace-source");
  const published = publishFinding(source, "remote", { text: "x".repeat(256) });
  const sizeBounded = new SharedWorkspaceLedger("workspace-source", undefined, { maxUpdateBytes: 64 });
  assert.throws(() => sizeBounded.apply(published.update), /update exceeds 64 bytes/);
  assert.equal(sizeBounded.project(frontier).value.entries.length, 0);

  const wrongArtifact = new SharedWorkspaceLedger("workspace-other");
  const wrongUpdate = publishFinding(wrongArtifact, "wrong-artifact");
  const target = new SharedWorkspaceLedger("workspace-source");
  assert.throws(() => target.apply(wrongUpdate.update), /unexpected artifact/);
  assert.equal(target.project(frontier).value.entries.length, 0);

  source.destroy();
  sizeBounded.destroy();
  wrongArtifact.destroy();
  target.destroy();
});

test("bounded remote admission converges independently of delivery order", () => {
  const sources = ["alpha", "beta", "gamma"].map((subject) => {
    const ledger = new SharedWorkspaceLedger("workspace-convergent");
    return { ledger, published: publishFinding(ledger, subject) };
  });
  const forward = new SharedWorkspaceLedger("workspace-convergent", undefined, { maxEntries: 2 });
  const reverse = new SharedWorkspaceLedger("workspace-convergent", undefined, { maxEntries: 2 });
  for (const source of sources) forward.apply(source.published.update);
  for (const source of [...sources].reverse()) reverse.apply(source.published.update);

  const forwardProjection = forward.project(frontier);
  const reverseProjection = reverse.project(frontier);
  assert.equal(forwardProjection.value.entries.length, 2);
  assert.equal(forwardProjection.versionHash, reverseProjection.versionHash);
  assert.deepEqual(forwardProjection.value, reverseProjection.value);
  assert.ok(forward.encode().byteLength < forward.limits.maxEncodedStateBytes);
  assert.ok(reverse.encode().byteLength < reverse.limits.maxEncodedStateBytes);

  for (const source of sources) source.ledger.destroy();
  forward.destroy();
  reverse.destroy();
});

test("restored snapshots use the same deterministic bound as incremental delivery", () => {
  const source = new SharedWorkspaceLedger("workspace-snapshot");
  publishFinding(source, "alpha");
  publishFinding(source, "beta");
  publishFinding(source, "gamma");

  const restored = new SharedWorkspaceLedger("workspace-snapshot", source.encode(), { maxEntries: 1 });
  const incremental = new SharedWorkspaceLedger("workspace-snapshot", undefined, { maxEntries: 1 });
  const updates = ["alpha", "beta", "gamma"].map((subject) => {
    const ledger = new SharedWorkspaceLedger("workspace-snapshot");
    const update = publishFinding(ledger, subject).update;
    ledger.destroy();
    return update;
  });
  for (const update of updates) incremental.apply(update);
  assert.equal(restored.project(frontier).value.entries.length, 1);
  assert.equal(restored.project(frontier).versionHash, incremental.project(frontier).versionHash);

  const tooSmall = () => new SharedWorkspaceLedger("workspace-snapshot", source.encode(), {
    maxEncodedStateBytes: 64,
  });
  assert.throws(tooSmall, /encoded update exceeds 64 bytes/);

  source.destroy();
  restored.destroy();
  incremental.destroy();
});

test("filesystem shared workspace restores the graph-fenced CRDT after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-shared-workspace-"));
  const graph = new InMemoryTaskGraphControl();
  const node = {
    id: "researcher",
    name: "Researcher",
    capabilities: ["research"],
    runtime: { kind: "roster-native" as const },
  };
  const definition = createDynamicTaskDefinition({
    taskId: "research",
    semanticKey: "research",
    nodeId: node.id,
    capability: "research",
    objective: "Publish one durable finding.",
    handler: { kind: "roster.node", version: "1" },
    acceptance: { policyId: "default", policyVersion: "1" },
    result: { mode: "none" },
    dependencies: [],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: { request: "v1" },
      dataReferences: [],
      frontierVersion: "frontier-1",
      topologyVersion: "topology-1",
      catalogVersion: "catalog-1",
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 10_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });
  await graph.initialize({
    runId: "workspace-restart",
    policy: {
      maxTasks: 1,
      maxDepth: 1,
      maxFanout: 1,
      maxInflight: 1,
      maxReady: 1,
      maxBlocked: 1,
      maxAttempts: 1,
      maxContextBytes: 1_048_576,
      maxCostMicros: 1_000,
      maxTokens: 1_000,
      maxWallTimeMs: 60_000,
    },
    seedTasks: [definition],
  });
  const lease = await graph.claim({ owner: "worker", taskId: definition.taskId });
  assert.ok(lease);
  await graph.start(lease);

  try {
    const first = new FileSystemSharedWorkspace({
      directory,
      namespace: "workspace-restart",
    });
    const firstContext = await createTaskGraphWorkspaceContextFactory({
      taskGraph: graph,
      workspace: first,
    })({
      runId: "workspace-restart",
      node,
      definition,
      lease,
    });
    await firstContext.publish({
      kind: "finding",
      mode: "append",
      subjectId: "answer",
      body: { title: "Changelog" },
      references: [],
    });
    await first.flush();
    first.close();

    const restored = new FileSystemSharedWorkspace({
      directory,
      namespace: "workspace-restart",
    });
    const restoredContext = await createTaskGraphWorkspaceContextFactory({
      taskGraph: graph,
      workspace: restored,
    })({
      runId: "workspace-restart",
      node,
      definition,
      lease,
    });
    assert.deepEqual(
      (await restoredContext.readWorkspace()).value.entries.map((entry) => entry.body),
      [{ title: "Changelog" }],
    );
    restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task workspace context fences reads and publications and returns only selected entries", async () => {
  const ledger = new SharedWorkspaceLedger("workspace-task-fence");
  publishFinding(ledger, "alpha");
  publishFinding(ledger, "beta");
  let activeFence = 7n;
  const context = createRosterTaskContext({
    node: {
      id: "researcher",
      name: "Researcher",
      capabilities: ["research"],
      runtime: { kind: "roster-native" },
    },
    ledger,
    fence: {
      runId: "run-1",
      taskId: "task-fenced",
      nodeId: "researcher",
      fence: 7n,
      runtimeBindingEpoch: 3,
      ...frontier,
      catalogVersion: "catalog-1",
      inputVersions: { request: "v1" },
    },
    authority: {
      assertActive: async (_operation, fence) => {
        if (fence.fence !== activeFence) throw new Error("stale task fence");
      },
    },
  });

  const selected = await context.readWorkspace({ subjectIds: ["beta"], limit: 1 });
  assert.deepEqual(selected.value.entries.map((entry) => entry.subjectId), ["beta"]);
  await context.publish({
    kind: "finding",
    mode: "append",
    subjectId: "gamma",
    body: { summary: "gamma" },
    references: [],
  });
  activeFence = 8n;
  await assert.rejects(() => context.readWorkspace(), /stale task fence/);
  await assert.rejects(() => context.publish({
    kind: "finding",
    mode: "append",
    subjectId: "delta",
    body: null,
    references: [],
  }), /stale task fence/);
  ledger.destroy();
});
