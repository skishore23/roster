import assert from "node:assert/strict";
import test from "node:test";

import {
  codingRuntimeTelemetry,
  type CodingRuntimeProgressLog,
} from "../../src/browser/coding-progress-updates.js";

const log = (
  sequence: number,
  text: string,
  options: Partial<CodingRuntimeProgressLog> = {},
): CodingRuntimeProgressLog => ({
  runId: "coding-progress",
  nodeId: "workspace.implementation",
  taskId: "implement",
  stream: "stdout",
  text,
  sequence,
  at: sequence * 1_000,
  ...options,
});

test("runtime telemetry exposes only structured Workbench references", () => {
  const telemetry = codingRuntimeTelemetry([
    log(1, "Pi agent started\n"),
    log(2, "Tool read: {\"path\":\"src/views/coding.ts\"}\n"),
    log(3, 'item.started: ["npm","run","verify"]'),
    log(4, JSON.stringify({ implementation_report: { status: "verified", summary: "private output" } })),
    log(5, "provider diagnostic", { stream: "stderr" }),
  ]);

  assert.deepEqual(telemetry, [{
    commandKind: "lifecycle",
    nodeId: "workspace.implementation",
    taskId: "implement",
    at: 1_000,
    rawLogRef: "runtime-log:coding-progress:1",
  }, {
    commandKind: "tool",
    nodeId: "workspace.implementation",
    taskId: "implement",
    at: 2_000,
    rawLogRef: "runtime-log:coding-progress:2",
  }, {
    commandKind: "command",
    nodeId: "workspace.implementation",
    taskId: "implement",
    at: 3_000,
    rawLogRef: "runtime-log:coding-progress:3",
  }, {
    commandKind: "result",
    nodeId: "workspace.implementation",
    taskId: "implement",
    at: 4_000,
    rawLogRef: "runtime-log:coding-progress:4",
  }, {
    commandKind: "stderr",
    nodeId: "workspace.implementation",
    taskId: "implement",
    at: 5_000,
    rawLogRef: "runtime-log:coding-progress:5",
  }]);
  assert.equal(telemetry.some((entry) => "body" in entry || "text" in entry), false);
});

test("runtime telemetry preserves node and task identity without synthesizing copy", () => {
  const telemetry = codingRuntimeTelemetry([
    log(1, "Tool read: {}", { taskId: "inspect-runtime" }),
    log(2, "ordinary stdout", { nodeId: "workspace.quality", taskId: "inspect-tests" }),
  ]);

  assert.deepEqual(telemetry.map(({ commandKind, nodeId, taskId, rawLogRef }) => ({
    commandKind,
    nodeId,
    taskId,
    rawLogRef,
  })), [{
    commandKind: "tool",
    nodeId: "workspace.implementation",
    taskId: "inspect-runtime",
    rawLogRef: "runtime-log:coding-progress:1",
  }, {
    commandKind: "stdout",
    nodeId: "workspace.quality",
    taskId: "inspect-tests",
    rawLogRef: "runtime-log:coding-progress:2",
  }]);
});

test("runtime telemetry rejects invalid references and stays bounded", () => {
  const telemetry = codingRuntimeTelemetry([
    log(0, "invalid sequence"),
    log(1, "missing node", { nodeId: "" }),
    ...Array.from({ length: 16 }, (_, index) => log(index + 2, `raw output ${index}`)),
  ], 8);

  assert.equal(telemetry.length, 8);
  assert.equal(telemetry[0]?.rawLogRef, "runtime-log:coding-progress:10");
  assert.equal(telemetry.at(-1)?.rawLogRef, "runtime-log:coding-progress:17");
});

test("runtime telemetry keeps simultaneous task records distinct", () => {
  const telemetry = codingRuntimeTelemetry([
    log(1, "Tool read: {}", { taskId: "inspect-runtime" }),
    log(2, "Tool read: {}", { nodeId: "workspace.quality", taskId: "inspect-tests" }),
  ]);
  assert.deepEqual(telemetry.map((entry) => [entry.nodeId, entry.taskId]), [
    ["workspace.implementation", "inspect-runtime"],
    ["workspace.quality", "inspect-tests"],
  ]);
});

test("runtime telemetry ordering follows the raw stream sequence", () => {
  const telemetry = codingRuntimeTelemetry([
    log(3, "third"),
    log(1, "first"),
    log(2, "second"),
  ]);
  assert.deepEqual(telemetry.map((entry) => entry.rawLogRef), [
    "runtime-log:coding-progress:1",
    "runtime-log:coding-progress:2",
    "runtime-log:coding-progress:3",
  ]);
});

test("runtime telemetry limit remains within its hard ceiling", () => {
  const logs = Array.from({ length: 600 }, (_, index) => log(index + 1, `raw ${index}`));
  assert.equal(codingRuntimeTelemetry(logs, 1_000).length, 500);
  assert.equal(codingRuntimeTelemetry(logs, 0).length, 1);
});
