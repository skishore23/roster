import assert from "node:assert/strict";
import test from "node:test";

import {
  SpacetimeTaskGraphControl,
  type SpacetimeTaskGraphDriver,
} from "../../src/adapters/spacetimedb-task-graph-control.js";
import {
  createAcceptedTaskOutcome,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.js";
import type {
  AcceptedTaskOutcome,
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../../src/engine/platform/protocol.js";

const policy: RunExecutionPolicy = {
  maxTasks: 8,
  maxDepth: 3,
  maxFanout: 3,
  maxInflight: 2,
  maxReady: 6,
  maxBlocked: 6,
  maxAttempts: 3,
  maxContextBytes: 1_000_000,
  maxCostMicros: 1_000_000,
  maxTokens: 10_000,
  maxWallTimeMs: 60_000,
};

const definition = (
  taskId: string,
  dependencies: DynamicTaskDefinition["dependencies"] = [],
  parentTaskId?: string,
  timeoutMs = 30_000,
) => createDynamicTaskDefinition({
  taskId,
  semanticKey: taskId,
  nodeId: "worker",
  capability: "work",
  objective: `Execute ${taskId}.`,
  handler: { kind: "test", version: "1" },
  acceptance: { policyId: "test", policyVersion: "1" },
  result: { mode: "none" },
  dependencies,
  join: { kind: "all-success" },
  inputs: {
    inputVersions: { request: "v1" },
    dataReferences: [],
    frontierVersion: "frontier-v1",
    topologyVersion: "topology-v1",
    catalogVersion: "catalog-v1",
  },
  runtimeBindingEpoch: 1,
  retry: { maxAttempts: 3, initialBackoffMs: 0, maximumBackoffMs: 0 },
  timeoutMs,
  sideEffect: "idempotent",
  estimatedCostMicros: 0,
  ...(parentTaskId ? { parentTaskId } : {}),
});

type MutableTask = {
  definition: DynamicTaskDefinition;
  status: string;
  attempt: number;
  leaseFence: bigint;
  outcomeId: string;
  lastError: string;
};

const restartableDriver = (runId: string) => {
  const tasks = new Map<string, MutableTask>();
  const outcomes = new Map<string, AcceptedTaskOutcome>();
  const claimLeaseMs: number[] = [];
  const heartbeatLeaseMs: number[] = [];
  const runtimeBindings: Array<{
    runId: string;
    nodeId: string;
    bindingId: string;
    epoch: bigint;
  }> = [];
  const expansions = new Map<string, {
    parentTaskId: string;
    publicationFence: string;
    expansionKey: string;
    expansionSpec: {
      children: ReadonlyArray<DynamicTaskDefinition>;
      continuation: DynamicTaskDefinition;
    };
    childCount: number;
    continuationTaskId: string;
  }>();
  const execution = {
    runId,
    kind: "test",
    workspaceId: "workspace",
    policyJson: JSON.stringify(policy),
    spentCostMicros: 0n,
    usedTokens: 0n,
  };
  const refreshReady = (): void => {
    for (const task of tasks.values()) {
      if (task.status !== "blocked") continue;
      if (task.definition.dependencies.every((dependency) => {
        const dependencyTask = tasks.get(dependency.taskId);
        return dependencyTask && (
          dependency.condition === "terminal"
            ? ["accepted", "failed", "canceled", "skipped"].includes(dependencyTask.status)
            : dependencyTask.status === "accepted"
        );
      })) task.status = "ready";
    }
  };
  const snapshot = () => ({
    executions: [{ ...execution }],
    outcomes: [...outcomes.values()].map((outcome) => ({
        outcomeId: outcome.outcomeId,
        taskKey: `${runId}:${outcome.taskId}`,
        definitionHash: outcome.definitionHash,
        outcomeJson: JSON.stringify(outcome),
        artifactsJson: JSON.stringify(outcome.artifacts),
        usageJson: JSON.stringify(outcome.usage ?? {}),
        actualCostMicros: "0",
        totalTokens: "0",
    })),
    expansions: [...expansions.values()].map((expansion) => ({
      ...expansion,
      expansionSpecJson: JSON.stringify(expansion.expansionSpec),
    })),
    outputReferences: [],
    runtimeBindings,
    tasks: [...tasks.values()].map((task) => ({
      runId,
      taskId: task.definition.taskId,
      status: task.status,
      attempt: task.attempt,
      leaseFence: task.leaseFence,
      definitionHash: task.definition.definitionHash,
      definitionJson: JSON.stringify(task.definition),
      outcomeId: task.outcomeId,
      lastError: task.lastError,
    })),
    claimableTasks: [...tasks.values()]
      .filter((task) => task.status === "ready")
      .map((task) => ({
        runId,
        taskId: task.definition.taskId,
        status: task.status,
        attempt: task.attempt,
        leaseFence: task.leaseFence,
        definitionHash: task.definition.definitionHash,
        definitionJson: JSON.stringify(task.definition),
        outcomeId: task.outcomeId,
        lastError: task.lastError,
      })),
  }) as unknown as ReturnType<SpacetimeTaskGraphDriver["rosterSnapshot"]>;
  const driver: SpacetimeTaskGraphDriver = {
    rosterSnapshot: snapshot,
    ensureRosterExecution: async () => undefined,
    enqueueRosterTask: async (input) => {
      const current = tasks.get(input.definition.taskId);
      if (current) {
        assert.equal(current.definition.definitionHash, input.definition.definitionHash);
        return;
      }
      tasks.set(input.definition.taskId, {
        definition: input.definition,
        status: input.definition.dependencies.length === 0 ? "ready" : "blocked",
        attempt: 0,
        leaseFence: 0n,
        outcomeId: "",
        lastError: "",
      });
      refreshReady();
    },
    claimRosterTask: async (input) => {
      claimLeaseMs.push(input.leaseMs);
      const task = tasks.get(input.taskId);
      if (!task || task.status !== "ready") throw new Error("task is not ready");
      task.status = "leased";
      task.attempt += 1;
      task.leaseFence += 1n;
    },
    startRosterTask: async (input) => {
      const task = tasks.get(input.taskId);
      if (!task || task.leaseFence !== input.fence) throw new Error("stale fence");
      task.status = "running";
    },
    heartbeatRosterTask: async (input) => {
      heartbeatLeaseMs.push(input.leaseMs);
      const task = tasks.get(input.taskId);
      if (!task || task.leaseFence !== input.fence) throw new Error("stale fence");
    },
    expandAndDelegateRosterTask: async (input) => {
      const existing = expansions.get(input.parentTaskId);
      if (existing) {
        assert.equal(existing.expansionKey, input.expansionKey);
        return;
      }
      const parent = tasks.get(input.parentTaskId);
      if (!parent || parent.leaseFence !== input.fence) throw new Error("stale fence");
      parent.status = "delegated";
      expansions.set(input.parentTaskId, {
        parentTaskId: input.parentTaskId,
        publicationFence: input.fence.toString(),
        expansionKey: input.expansionKey,
        expansionSpec: {
          children: input.children,
          continuation: input.continuation,
        },
        childCount: input.children.length,
        continuationTaskId: input.continuation.taskId,
      });
      for (const child of [...input.children, input.continuation]) {
        tasks.set(child.taskId, {
          definition: child,
          status: child.dependencies.length === 0 ? "ready" : "blocked",
          attempt: 0,
          leaseFence: 0n,
          outcomeId: "",
          lastError: "",
        });
      }
      refreshReady();
    },
    acceptRosterTaskOutcome: async (input) => {
      const task = tasks.get(input.taskId);
      if (task?.outcomeId === input.outcome.outcomeId) return;
      if (!task || task.leaseFence !== input.fence) throw new Error("stale fence");
      task.status = "accepted";
      task.outcomeId = input.outcome.outcomeId;
      outcomes.set(input.outcome.outcomeId, input.outcome);
      refreshReady();
    },
    failRosterTask: async (input) => {
      const task = tasks.get(input.taskId);
      if (!task || task.leaseFence !== input.fence) throw new Error("stale fence");
      task.status = input.retryable ? "ready" : "failed";
      task.lastError = input.error;
    },
    cancelRosterTask: async (input) => {
      const task = tasks.get(input.taskId);
      if (!task) throw new Error("missing task");
      task.status = "canceled";
    },
  };
  return {
    driver,
    tasks,
    execution,
    runtimeBindings,
    claimLeaseMs,
    heartbeatLeaseMs,
  };
};

const adapter = (
  driver: SpacetimeTaskGraphDriver,
  leaseMs = 5_000,
) => new SpacetimeTaskGraphControl({
  control: driver,
  workspaceId: "workspace",
  kind: "test",
  existingExecution: true,
  leaseMs,
});

test("a failed durable attachment does not poison the adapter for an exact retry", async () => {
  const runId = "restart_attach_retry";
  const root = definition("root");
  const fixture = restartableDriver(runId);
  fixture.execution.policyJson = JSON.stringify({ ...policy, maxTasks: policy.maxTasks - 1 });
  const graph = adapter(fixture.driver);

  await assert.rejects(
    graph.initialize({ runId, policy, seedTasks: [root] }),
    /changed before attachment/,
  );

  fixture.execution.policyJson = JSON.stringify(policy);
  const snapshot = await graph.initialize({ runId, policy, seedTasks: [root] });
  assert.equal(snapshot.tasks.find((task) => task.definition.taskId === root.taskId)?.status, "ready");
});

test("Spacetime graph clamps claim and heartbeat leases to each task timeout", async () => {
  const runId = "task_lease_clamp";
  const short = definition("short", [], undefined, 30_000);
  const long = definition("long", [], undefined, 20 * 60_000);
  const fixture = restartableDriver(runId);
  const graph = adapter(fixture.driver, 120_000);
  await graph.initialize({ runId, policy, seedTasks: [short, long] });

  const shortLease = await graph.claim({ taskId: short.taskId, owner: "worker" });
  assert.ok(shortLease);
  await graph.start(shortLease);
  await graph.heartbeat(shortLease);
  const longLease = await graph.claim({ taskId: long.taskId, owner: "worker" });
  assert.ok(longLease);
  await graph.start(longLease);
  await graph.heartbeat(longLease);

  assert.deepEqual(fixture.claimLeaseMs, [30_000, 120_000]);
  assert.deepEqual(fixture.heartbeatLeaseMs, [30_000, 120_000]);
});

test("durable attachment hydrates binding epochs for nodes without seed tasks", async () => {
  const runId = "binding_epoch_hydration";
  const fixture = restartableDriver(runId);
  fixture.runtimeBindings.push({
    runId,
    nodeId: "worker",
    bindingId: "worker-binding-3",
    epoch: 3n,
  });
  const graph = adapter(fixture.driver);
  await graph.initialize({ runId, policy, seedTasks: [] });
  const authored = createDynamicTaskDefinition({
    ...definition("post-restart-work"),
    runtimeBindingEpoch: 0,
    definitionHash: "",
  });

  const admitted = await graph.enqueue(authored);

  assert.equal(admitted.definition.runtimeBindingEpoch, 3);
  assert.notEqual(admitted.definition.definitionHash, authored.definitionHash);
});

test("a fresh Spacetime graph adapter can replay expansion and acceptance after process loss", async () => {
  const runId = "restart_replay";
  const root = definition("root");
  const child = definition("child", [], root.taskId);
  const join = definition(
    "join",
    [{ taskId: child.taskId, condition: "accepted" }],
    root.taskId,
  );
  const fixture = restartableDriver(runId);
  fixture.tasks.set(root.taskId, {
    definition: root,
    status: "ready",
    attempt: 0,
    leaseFence: 0n,
    outcomeId: "",
    lastError: "",
  });

  const first = adapter(fixture.driver);
  await first.initialize({ runId, policy, seedTasks: [root] });
  const rootLease = await first.claim({ taskId: root.taskId, owner: "process-a" });
  assert.ok(rootLease);
  await first.start(rootLease);
  const expansionInput = {
    parentTaskId: root.taskId,
    fence: rootLease.fence,
    owner: rootLease.owner,
    expansionKey: "discover-child",
    definitions: [child, join],
    continuationTaskId: join.taskId,
  };
  const committedExpansion = await first.expand(expansionInput);

  const second = adapter(fixture.driver);
  await second.initialize({ runId, policy, seedTasks: [root] });
  assert.deepEqual(await second.expand(expansionInput), committedExpansion);
  const childLease = await second.claim({ taskId: child.taskId, owner: "process-b" });
  assert.ok(childLease);
  await second.start(childLease);
  const outcome = createAcceptedTaskOutcome({
    runId,
    taskId: child.taskId,
    nodeId: child.nodeId,
    attempt: childLease.attempt,
    definitionHash: child.definitionHash,
    inputVersions: child.inputs.inputVersions,
    frontierVersion: child.inputs.frontierVersion,
    topologyVersion: child.inputs.topologyVersion,
    catalogVersion: child.inputs.catalogVersion,
    acceptancePolicyId: child.acceptance.policyId,
    acceptancePolicyVersion: child.acceptance.policyVersion,
    artifacts: [],
  });
  await second.accept({ lease: childLease, outcome });

  const third = adapter(fixture.driver);
  await third.initialize({ runId, policy, seedTasks: [root] });
  assert.deepEqual(await third.accept({ lease: childLease, outcome }), outcome);
  assert.equal(
    (await third.snapshot()).tasks.find((task) => task.definition.taskId === child.taskId)?.status,
    "accepted",
  );
});

test("durable canceled and budget-exhausted expansion parents remain readable", async () => {
  const runId = "restart_canceled_expansion";
  const root = definition("canceled-root");
  const child = definition("canceled-child", [], root.taskId);
  const continuation = definition(
    "canceled-continuation",
    [{ taskId: child.taskId, condition: "accepted" }],
    root.taskId,
  );
  const fixture = restartableDriver(runId);
  fixture.tasks.set(root.taskId, {
    definition: root,
    status: "ready",
    attempt: 0,
    leaseFence: 0n,
    outcomeId: "",
    lastError: "",
  });
  const graph = adapter(fixture.driver);
  await graph.initialize({ runId, policy, seedTasks: [root] });
  const lease = await graph.claim({ taskId: root.taskId, owner: "publisher" });
  assert.ok(lease);
  await graph.start(lease);
  await graph.expand({
    parentTaskId: root.taskId,
    fence: lease.fence,
    owner: lease.owner,
    expansionKey: "durable-canceled-expansion",
    definitions: [child, continuation],
    continuationTaskId: continuation.taskId,
  });
  await graph.cancel({ taskId: root.taskId, reason: "operator canceled durable run" });
  assert.equal(
    (await graph.snapshot()).tasks.find((task) => task.definition.taskId === root.taskId)?.status,
    "canceled",
  );

  fixture.tasks.get(root.taskId)!.lastError = "execution budget exhausted";
  const recovered = adapter(fixture.driver);
  await recovered.initialize({ runId, policy, seedTasks: [root] });
  const budgetSnapshot = await recovered.snapshot();
  const budgetParent = budgetSnapshot.tasks.find((task) => task.definition.taskId === root.taskId);
  assert.equal(budgetParent?.status, "canceled");
  assert.equal(budgetParent?.error, "execution budget exhausted");
});
