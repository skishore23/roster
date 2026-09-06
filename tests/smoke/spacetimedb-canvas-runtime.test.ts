import assert from "node:assert/strict";
import test from "node:test";

import { createSpacetimeCanvasRuntime } from "../../src/adapters/spacetimedb-canvas-runtime.ts";
import type { SpacetimeControlPlane } from "../../src/adapters/spacetimedb-control.ts";
import type { CanvasEvent } from "../../src/modules/canvas.ts";
import { taskGraphProjectedEvent } from "../../src/modules/orchestration.ts";

type FakeReceipt = {
  readonly runId: string;
  readonly seq: bigint;
  readonly eventId: string;
  readonly kind: string;
  readonly agentId: string;
  readonly payloadJson: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly createdAt: { readonly microsSinceUnixEpoch: bigint };
};

type ProjectInput = {
  readonly runId: string;
  readonly coordinatorTaskId: string;
  readonly coordinatorFence: bigint;
  readonly eventId: string;
  readonly expectedPrev: string;
  readonly eventHash: string;
  readonly kind: string;
  readonly agentId: string;
  readonly eventJson: string;
  readonly summary: string;
};

test("Spacetime Canvas runtime retries interleaved control receipts and replays only Canvas events", async () => {
  const runId = "canvas_runtime_test";
  const rows: FakeReceipt[] = [{
    runId,
    seq: 1n,
    eventId: "run.created:test",
    kind: "run.created",
    agentId: "user",
    payloadJson: "{}",
    prevHash: "",
    hash: "control-genesis",
    createdAt: { microsSinceUnixEpoch: 1_000_000n },
  }];
  let projectAttempts = 0;
  const fakeControl = {
    canvasReceipts: () => [...rows],
    projectCanvasEvent: async (input: ProjectInput): Promise<void> => {
      projectAttempts += 1;
      const currentHead = rows.at(-1)?.hash ?? "";
      if (projectAttempts === 1) {
        rows.push({
          runId,
          seq: 2n,
          eventId: "viewer.joined:test",
          kind: "viewer.joined",
          agentId: "viewer",
          payloadJson: "{}",
          prevHash: currentHead,
          hash: "interleaved-viewer-control",
          createdAt: { microsSinceUnixEpoch: 2_000_000n },
        });
        throw new Error(`expected previous hash ${input.expectedPrev}, found interleaved-viewer-control`);
      }
      assert.equal(input.coordinatorTaskId, "__canvas_coordinator__");
      assert.equal(input.coordinatorFence, 7n);
      assert.equal(input.expectedPrev, currentHead);
      rows.push({
        runId,
        seq: 3n,
        eventId: input.eventId,
        kind: input.kind,
        agentId: input.agentId,
        payloadJson: input.eventJson,
        prevHash: input.expectedPrev,
        hash: input.eventHash,
        createdAt: { microsSinceUnixEpoch: 3_000_000n },
      });
    },
  } as unknown as SpacetimeControlPlane;

  const runtime = createSpacetimeCanvasRuntime(fakeControl, runId, {
    taskId: "__canvas_coordinator__",
    fence: 7n,
  });
  const event: CanvasEvent = {
    type: "prompt.set",
    runId,
    agentId: "orchestrator",
    prompt: "A realtime owl",
  };
  const command = { type: "emit" as const, event, eventId: "canvas-event-1" };

  assert.deepEqual(await runtime.execute("ignored-local-stream", command), [event]);
  assert.equal(projectAttempts, 2, "viewer activity should force exactly one optimistic-head retry");
  assert.deepEqual(await runtime.execute("ignored-local-stream", command), [], "same event id is idempotent");
  await assert.rejects(
    runtime.execute("ignored-local-stream", {
      ...command,
      event: { ...event, prompt: "Changed after publication" },
    }),
    /changed after publication/
  );
  const configured: CanvasEvent = {
    type: "orchestration.configured",
    runId,
    domainId: "canvas-test",
    domainVersion: "2",
    policyVersion: "canvas-test-v2",
    coordinatorId: "orchestrator",
    capabilities: [
      { id: "coordinate", description: "Coordinate the scene." },
      { id: "review", description: "Review the rendered scene." },
    ],
    limits: { maxNodes: 3, maxTasks: 4, maxParallel: 2, maxDepth: 2 },
    nodes: [{
      id: "orchestrator",
      name: "Art Director",
      capabilities: ["coordinate"],
      runtime: { kind: "roster-native", profile: "canvas.art-director" },
    }],
  };
  const spawned: CanvasEvent = {
    type: "node.spawned",
    runId,
    node: {
      id: "visual-critic",
      name: "Mira",
      capabilities: ["review"],
      parentId: "orchestrator",
      runtime: { kind: "roster-native", profile: "canvas.visual-critic" },
    },
    reason: "independent visual review",
  };
  await runtime.execute("ignored-local-stream", {
    type: "emit",
    event: configured,
    eventId: "canvas-configured-v2",
  });
  await runtime.execute("ignored-local-stream", {
    type: "emit",
    event: spawned,
    eventId: "canvas-node-spawned-v2",
  });
  const graphProjected = taskGraphProjectedEvent(runId, {
    runId,
    policy: {
      maxTasks: 8,
      maxDepth: 2,
      maxFanout: 4,
      maxInflight: 2,
      maxReady: 8,
      maxBlocked: 8,
      maxAttempts: 2,
      maxContextBytes: 1_000_000,
      maxCostMicros: 1_000_000,
      maxTokens: 100_000,
      maxWallTimeMs: 60_000,
    },
    tasks: [],
    expansions: [],
    outcomeDataReferences: [],
    acceptedCostMicros: 0,
    acceptedTokens: 0,
  });
  await runtime.execute("ignored-local-stream", {
    type: "emit",
    event: graphProjected,
    eventId: "canvas-task-graph-projected-v2",
  });
  assert.equal(
    rows.find((row) => row.eventId === "canvas-node-spawned-v2")?.agentId,
    "visual-critic",
    "the Canvas receipt author should be the v2 workspace node",
  );

  const [state, chain, verified] = await Promise.all([
    runtime.state("ignored-local-stream"),
    runtime.chain("ignored-local-stream"),
    runtime.verify("ignored-local-stream"),
  ]);
  assert.equal(state.prompt, "A realtime owl");
  assert.equal(state.orchestration.nodes["visual-critic"]?.name, "Mira");
  assert.equal(state.orchestration.taskGraph?.tasks.length, 0);
  assert.deepEqual(chain.map((receipt) => receipt.body.type), [
    "prompt.set",
    "orchestration.configured",
    "node.spawned",
    "task.graph.projected",
  ]);
  assert.deepEqual(verified, {
    ok: true,
    count: 4,
    head: rows.at(-1)?.hash,
  });
});
