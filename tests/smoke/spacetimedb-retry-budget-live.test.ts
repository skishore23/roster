import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SpacetimeControlPlane } from "../../src/adapters/spacetimedb-control.js";
import { SpacetimeTaskGraphControl } from "../../src/adapters/spacetimedb-task-graph-control.js";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.js";
import { DEFAULT_DYNAMIC_ACCEPTANCE, DynamicTaskDispatcher, DynamicTaskHandlerRegistry, createDynamicTaskDefinition } from "../../src/engine/orchestration/task-graph.js";
import { spacetimeTestOptions } from "../support/spacetimedb-test.js";

const policy = {
  maxTasks: 8, maxDepth: 3, maxFanout: 3, maxInflight: 1, maxReady: 8, maxBlocked: 8,
  maxAttempts: 2, maxContextBytes: 64_000, maxCostMicros: 1_000, maxTokens: 1_000, maxWallTimeMs: 20_000,
};
const root = createDynamicTaskDefinition({
  taskId: "work", semanticKey: "work", nodeId: "worker", capability: "work", objective: "Verify recovery",
  handler: { kind: "test", version: "1" }, acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
  result: { mode: "none" }, dependencies: [], join: { kind: "all-success" },
  inputs: { inputVersions: { request: "v1" }, dataReferences: [], frontierVersion: "frontier-v1", topologyVersion: "topology-v1", catalogVersion: "catalog-v1" },
  runtimeBindingEpoch: 1, retry: { maxAttempts: 2, initialBackoffMs: 500, maximumBackoffMs: 500 },
  timeoutMs: 5_000, sideEffect: "pure", estimatedCostMicros: 1_000,
});

for (const scenario of ["retry", "reconcile"] as const) {
  test(`durable ${scenario} preserves scheduled work and actual usage`, spacetimeTestOptions(30_000), async () => {
    // Give this fixture its own identity rather than consuming the shared
    // verification coordinator's bounded workspace allowance.
    const control = await SpacetimeControlPlane.connect({ uri: process.env.SPACETIMEDB_URI!, database: process.env.SPACETIMEDB_DATABASE!, connectTimeoutMs: 10_000, confirmedReads: true });
    const runId = `refactor-${scenario}-${randomUUID()}`;
    const workspaceId = `verification/${runId}`;
    let subscription: ReturnType<typeof control.subscribeRosterExecution> | undefined;
    try {
      await control.ensureWorkspace(workspaceId, "Recovery verification");
      subscription = control.subscribeRosterExecution(runId);
      await subscription.ready;
      const graph = new SpacetimeTaskGraphControl({ control, workspaceId, kind: "recovery-test", leaseMs: 5_000 });
      await graph.initialize({ runId, policy, seedTasks: [root], nodes: [{
        id: "worker", name: "Worker", capabilities: ["work"], runtime: { kind: "roster-native", profile: "test" },
      }] });
      const handlers = new DynamicTaskHandlerRegistry();
      let attempts = 0;
      let fence = 0;
      handlers.register(root.handler, async ({ lease }) => {
        attempts += 1;
        fence = lease.fence;
        if (scenario === "reconcile") {
          await graph.markProviderCallDispatched({ lease, provider: "test", model: "test", reservedTokens: 1 });
          throw new Error("provider response lost");
        }
        if (attempts === 1) throw new Error("transient failure before dispatch");
        return undefined;
      });
      const dispatcher = new DynamicTaskDispatcher({ runId, control: graph, handlers, dataReferences: new InMemoryDataReferenceStore() });
      const result = await dispatcher.dispatchUntilQuiescent();
      if (scenario === "retry") {
        assert.equal(result.deadlocked, false);
        assert.equal(attempts, 2);
        assert.equal((await graph.snapshot()).tasks[0]?.status, "accepted");
      } else {
        assert.equal(attempts, 1, "uncertain provider calls must not retry");
        assert.equal(control.rosterSnapshot(runId).modelReservations[0]?.status, "uncertain");
        const settlement = { runId, taskId: root.taskId, fence: BigInt(fence), actualCostMicros: 1_001n, actualTokens: 1_001n };
        await control.settleRosterModelReservation(settlement);
        await control.settleRosterModelReservation(settlement);
        const snapshot = control.rosterSnapshot(runId);
        assert.equal(snapshot.executions[0]?.spentCostMicros, 1_001n);
        assert.equal(snapshot.executions[0]?.usedTokens, 1_001n);
        assert.equal(snapshot.executions[0]?.reservedCostMicros, 0n);
        assert.equal(snapshot.executions[0]?.status, "budget_exhausted");
        assert.equal(snapshot.modelReservations[0]?.status, "settled");
        await assert.rejects(control.settleRosterModelReservation({ ...settlement, actualCostMicros: 1_002n }), /settlement changed/);
      }
    } finally {
      subscription?.close();
      control.disconnect();
    }
  });
}
