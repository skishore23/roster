import assert from "node:assert/strict";
import test from "node:test";

import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  type NodeRuntimeAdapter,
} from "../../src/engine/runtime/node-runtime.ts";
import {
  RuntimeEffectCleanupError,
  RuntimeEffectOperationError,
} from "../../src/engine/runtime/runtime-effect-scope.ts";

const node = (kind: string) => ({
  id: "effect-node",
  name: "Effect Node",
  capabilities: ["inspect"],
  runtime: { kind },
});

const request = (kind: string) => ({
  runId: "effect-run",
  node: node(kind),
  task: {
    taskId: "effect-task",
    nodeId: "effect-node",
    capability: "inspect",
  },
  execute: async () => "native",
});

test("runtime registry closes adapter-owned attempt effects before returning output", async () => {
  const order: string[] = [];
  const adapter: NodeRuntimeAdapter = {
    kind: "effect-runtime",
    executeEnvelope: async (envelope, control) => {
      assert.equal("effects" in envelope, false);
      control.effects.defer(() => { order.push("first"); }, "first");
      control.effects.defer(async () => { order.push("second"); }, "second");
      order.push("execute");
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "external",
      };
    },
  };

  assert.equal(await new NodeRuntimeRegistry([adapter]).execute(request(adapter.kind)), "external");
  assert.deepEqual(order, ["execute", "second", "first"]);
});

test("runtime registry surfaces cleanup failure after successful adapter output", async () => {
  const adapter: NodeRuntimeAdapter = {
    kind: "effect-cleanup-failure",
    executeEnvelope: async (_envelope, control) => {
      control.effects.defer(() => {
        throw new Error("attempt cleanup failed");
      });
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "draft",
      };
    },
  };

  await assert.rejects(
    new NodeRuntimeRegistry([adapter]).execute(request(adapter.kind)),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeEffectCleanupError);
      assert.equal(error.owner.kind, "task-attempt");
      return true;
    },
  );
});

test("runtime registry preserves adapter and cleanup failures without accepting a draft", async () => {
  const primary = new Error("adapter failed");
  const adapter: NodeRuntimeAdapter = {
    kind: "effect-dual-failure",
    executeEnvelope: async (_envelope, control) => {
      control.effects.defer(() => {
        throw new Error("attempt cleanup failed");
      });
      throw primary;
    },
  };

  await assert.rejects(
    new NodeRuntimeRegistry([adapter]).execute(request(adapter.kind)),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeEffectOperationError);
      assert.equal(error.phase, "execution");
      assert.equal(error.primaryError, primary);
      assert.equal(error.owner.kind, "task-attempt");
      return true;
    },
  );
});
