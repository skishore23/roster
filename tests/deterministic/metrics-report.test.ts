import assert from "node:assert/strict";
import test from "node:test";
import { buildMetricsReport } from "../../src/modules/metrics-report.js";

const time = (microsSinceUnixEpoch: bigint) => ({ microsSinceUnixEpoch }) as never;
const task = (nodeId: string, taskId: string, status: string, start: bigint, end: bigint) => ({ runId: "run-1", taskId, nodeId, status, createdAt: time(start), updatedAt: time(end), attempt: 1, leaseFence: 1n }) as never;

test("metrics report computes node rates, latency percentiles, and settled reservation cost", () => {
  const report = buildMetricsReport({
    workspaceId: "workspace-1",
    selector: { kind: "run", runId: "run-1" },
    generatedAt: 10,
    tasks: [task("node-b", "b", "accepted", 0n, 10_000n), task("node-a", "a", "failed", 0n, 20_000n), task("node-a", "c", "active", 0n, 30_000n)],
    reservations: [
      { runId: "run-1", taskId: "a", nodeId: "node-a", fence: 1n, status: "settled", actualCostMicros: 7n },
      { runId: "run-1", taskId: "a", nodeId: "node-a", fence: 1n, status: "settled", actualCostMicros: 7n },
      { runId: "run-1", taskId: "c", nodeId: "node-a", fence: 2n, status: "uncertain", actualCostMicros: 0n },
    ],
  });
  assert.deepEqual(report.nodes.map((node) => node.nodeId), ["node-a", "node-b"]);
  assert.equal(report.nodes[0].completionRate.value, 1 / 2);
  assert.equal(report.nodes[0].successRate.value, 0);
  assert.equal(report.nodes[0].latencyMs.p50Ms, 20);
  assert.equal(report.nodes[0].costMicros.settledMicros, 7);
  assert.equal(report.nodes[0].costMicros.uncertainCount, 1);
  assert.equal(report.nodes[0].quality, null);
});

test("metrics report preserves zero denominators and bounded selectors", () => {
  const report = buildMetricsReport({ workspaceId: "w", selector: { kind: "since-until", since: 100, until: 200 }, tasks: [task("n", "old", "accepted", 1n, 2n)] });
  assert.equal(report.runCount, 0);
  assert.equal(report.nodes.length, 0);
  assert.equal(report.totals.completionRate.value, null);
  assert.match(report.warnings.join(" "), /Cost coverage/);
});


test("metrics report bounds terminal history and aggregates selected task costs", () => {
  const tasks = [
    task("node-a", "older", "accepted", 1n, 10_000n),
    task("node-a", "newer", "delegated", 2n, 20_000n),
  ];
  const report = buildMetricsReport({
    workspaceId: "w",
    selector: { kind: "terminal-limit", limit: 1 },
    tasks,
    reservations: [
      { runId: "run-1", taskId: "older", nodeId: "node-a", fence: 1n, status: "settled", actualCostMicros: 9n },
      { runId: "run-1", taskId: "newer", nodeId: "node-a", fence: 1n, status: "settled", actualCostMicros: 4n },
    ],
  });
  assert.equal(report.totals.assignedCount, 1);
  assert.equal(report.totals.costMicros.settledMicros, 9);
});

test("metrics report rejects invalid terminal limits", () => {
  assert.throws(() => buildMetricsReport({ workspaceId: "w", selector: { kind: "terminal-limit", limit: -1 }, tasks: [] }), /non-negative integer/);
});
