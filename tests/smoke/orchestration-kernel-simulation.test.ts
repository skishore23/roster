import assert from "node:assert/strict";
import test from "node:test";

import {
  RecordingEntropySource,
  ReplayingEntropySource,
  type EntropySource,
} from "determined";

import { hashCanonical } from "../../src/core/canonical.ts";
import { VirtualClock } from "../../src/core/clock.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
} from "../../src/engine/orchestration/task-graph-control.ts";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import type { WorkspaceNode } from "../../src/engine/orchestration/types.ts";
import {
  ROSTER_NODE_TASK_HANDLER,
  defineRosterPlatform,
} from "../../src/engine/platform/roster-platform.ts";
import type {
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../../src/engine/platform/protocol.ts";
import { createDeterminedTaskRuntime } from "../../src/simulations/determined-task-runtime.ts";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
} from "../../src/engine/workspace/shared-workspace.ts";

class SeededEntropySource implements EntropySource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  random(_reason: string): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

type StressTask = {
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: "work" | "compose";
  readonly outputKey: string;
  readonly dependencyTaskIds: ReadonlyArray<string>;
  readonly parentTaskId?: string;
};

const coordinator: WorkspaceNode = {
  id: "coordinator",
  name: "Coordinator",
  capabilities: ["coordinate"],
  runtime: { kind: "roster-native", profile: "kernel-stress.coordinator" },
};

const node = (index: number): WorkspaceNode => ({
  id: `node_${String(index).padStart(2, "0")}`,
  name: `Node ${index + 1}`,
  parentId: coordinator.id,
  capabilities: ["work", "compose"],
  runtime: { kind: "roster-native", profile: "kernel-stress.worker" },
  metadata: { cohort: index % 4, focus: `partition-${index % 8}` },
});

const ALL_NODES = Array.from({ length: 63 }, (_unused, index) => node(index));

const POLICY: RunExecutionPolicy = {
  maxTasks: 128,
  maxDepth: 8,
  maxFanout: 64,
  maxInflight: 12,
  maxReady: 128,
  maxBlocked: 128,
  maxAttempts: 2,
  maxContextBytes: 16 * 1_048_576,
  maxCostMicros: 1_000_000_000,
  maxTokens: 100_000_000,
  maxWallTimeMs: 120_000,
};

const buildStressTasks = (): ReadonlyArray<StressTask> => {
  const tasks: StressTask[] = [];
  let nodeIndex = 0;
  let frontier = Array.from({ length: 32 }, (_unused, index) => {
    const taskId = `leaf_${String(index).padStart(2, "0")}`;
    tasks.push({
      taskId,
      nodeId: ALL_NODES[nodeIndex++]!.id,
      capability: "work",
      outputKey: `leaf.${index}`,
      dependencyTaskIds: [],
    });
    return taskId;
  });
  let layer = 1;
  while (frontier.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < frontier.length; index += 2) {
      const left = frontier[index];
      const right = frontier[index + 1];
      if (!left || !right) throw new Error("Stress frontier must remain balanced");
      const isFinal = frontier.length === 2;
      const taskId = isFinal ? "final" : `layer_${layer}_${String(index / 2).padStart(2, "0")}`;
      tasks.push({
        taskId,
        nodeId: ALL_NODES[nodeIndex++]!.id,
        capability: isFinal ? "compose" : "work",
        outputKey: isFinal ? "final" : `layer.${layer}.${index / 2}`,
        dependencyTaskIds: [left, right],
        parentTaskId: left,
      });
      next.push(taskId);
    }
    frontier = next;
    layer += 1;
  }
  assert.equal(tasks.length, 63);
  return tasks;
};

const definition = (
  task: StressTask,
  maxAttempts = 2,
): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId: task.taskId,
  semanticKey: `stress:${task.taskId}`,
  nodeId: task.nodeId,
  capability: task.capability,
  objective: task.dependencyTaskIds.length === 0
    ? `Solve ${task.taskId}.`
    : `Compose ${task.dependencyTaskIds.join(" and ")}.`,
  handler: ROSTER_NODE_TASK_HANDLER,
  acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
  result: { mode: "text", outputKey: task.outputKey },
  dependencies: task.dependencyTaskIds.map((taskId) => ({
    taskId,
    condition: "accepted",
  })),
  join: { kind: "all-success" },
  inputs: {
    inputVersions: Object.fromEntries(task.dependencyTaskIds.map((taskId) => [
      taskId,
      hashCanonical({ taskId }),
    ])),
    dataReferences: [],
    frontierVersion: "stress-frontier-v3",
    topologyVersion: "stress-topology-v3",
    catalogVersion: "stress-catalog-v3",
  },
  runtimeBindingEpoch: 0,
  retry: {
    maxAttempts,
    initialBackoffMs: 1,
    maximumBackoffMs: 1,
  },
  timeoutMs: 30_000,
  sideEffect: "pure",
  estimatedCostMicros: 0,
  ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
});

const runScenario = async (input: {
  readonly entropy: EntropySource;
  readonly faultTaskId?: string;
}) => {
  const tasks = buildStressTasks();
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const clock = new VirtualClock();
  const taskGraph = new InMemoryTaskGraphControl(clock);
  const dataReferences = new InMemoryDataReferenceStore();
  const ledger = new SharedWorkspaceLedger("kernel-stress");
  const runtime = createDeterminedTaskRuntime({
    entropy: input.entropy,
    ...(input.faultTaskId ? { faultTaskId: input.faultTaskId } : {}),
  });
  const outputs = new Map<string, string>();
  const platform = defineRosterPlatform({
    id: "kernel-stress",
    version: "3",
    policyVersion: "kernel-stress-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [
      { id: "coordinate", description: "Coordinate the bounded stress graph." },
      { id: "work", description: "Produce one deterministic partial result." },
      { id: "compose", description: "Compose accepted dependency results." },
    ],
    nodes: [coordinator, ...ALL_NODES],
    maxNodes: 64,
    policy: POLICY,
  });
  const execution = platform.createExecution({
    runId: "stress-run",
    seedTasks: tasks.map((task) => definition(task)),
    taskGraph,
    dataReferences,
    createTaskContext: ({ runId, node, definition: taskDefinition, lease }) =>
      createRosterTaskContext({
        node,
        ledger,
        fence: {
          runId,
          taskId: taskDefinition.taskId,
          nodeId: node.id,
          fence: BigInt(lease.fence),
          frontierVersion: taskDefinition.inputs.frontierVersion,
          topologyVersion: taskDefinition.inputs.topologyVersion,
          catalogVersion: taskDefinition.inputs.catalogVersion,
          runtimeBindingEpoch: taskDefinition.runtimeBindingEpoch,
          inputVersions: taskDefinition.inputs.inputVersions,
        },
        authority: {
          assertActive: async () => {
            const record = taskGraphTask(await taskGraph.snapshot(), taskDefinition.taskId);
            if (
              !record
              || (record.status !== "leased" && record.status !== "running")
              || record.leaseOwner !== lease.owner
              || record.leaseFence !== lease.fence
            ) {
              throw new Error(`Stress task ${taskDefinition.taskId} lost its workspace fence`);
            }
          },
        },
      }),
    nativeExecute: async (context) => runtime.execute(context, async () => {
      const task = byId.get(context.definition.taskId);
      if (!task) throw new Error(`Missing stress task ${context.definition.taskId}`);
      const dependencies = await Promise.all(task.dependencyTaskIds.map(async (taskId) => {
        const reference = context.dependencyDataReferences[taskId]?.[0]?.reference;
        if (!reference) throw new Error(`Stress task ${task.taskId} is missing ${taskId}`);
        const value = await context.readDataReference(reference, { signal: context.signal });
        if (typeof value !== "string") throw new Error(`Stress dependency ${taskId} is not text`);
        return value;
      }));
      const output = task.dependencyTaskIds.length === 0
        ? hashCanonical({ taskId: task.taskId, seed: "hard-problem" })
        : hashCanonical({ taskId: task.taskId, dependencies });
      outputs.set(task.outputKey, output);
      return output;
    }),
    clock,
    readyBatchRunner: async (entries) => {
      await runtime.runReadyBatch(entries);
      await clock.advanceBy(1);
    },
  });
  const quiescence = await execution.dispatchUntilQuiescent();
  const snapshot = await execution.snapshot();
  return {
    snapshot,
    runtime: runtime.snapshot(),
    final: outputs.get("final"),
    quiescence,
    semantic: hashCanonical({
      final: outputs.get("final"),
      tasks: snapshot.tasks.map((record) => ({
        taskId: record.definition.taskId,
        status: record.status,
        contentHash: record.outcome?.artifacts[0]?.contentHash,
      })),
    }),
  };
};

test("node platform simulation explores 64-node schedules and replays exactly", {
  timeout: 120_000,
}, async () => {
  const semanticDigests = new Set<string>();
  const completionOrders = new Set<string>();
  for (const seed of [0x101, 0x202, 0x303, 0x404, 0x505, 0x606]) {
    const recording = new RecordingEntropySource(new SeededEntropySource(seed));
    const first = await runScenario({ entropy: recording });
    assert.equal(first.quiescence.deadlocked, false);
    assert.equal(first.snapshot.tasks.length, 63);
    assert.ok(first.snapshot.tasks.every((record) => record.status === "accepted"));
    assert.equal(first.runtime.peakParallel, 12);
    assert.ok(first.runtime.transitions.length > first.snapshot.tasks.length);
    assert.ok(first.runtime.transitions.some((transition) =>
      transition.phase === "after-accept"));
    assert.ok(first.final);

    const replay = await runScenario({
      entropy: new ReplayingEntropySource(recording.getRecords()),
    });
    assert.deepEqual(replay.snapshot, first.snapshot);
    assert.deepEqual(replay.runtime, first.runtime);
    assert.equal(replay.final, first.final);

    semanticDigests.add(first.semantic);
    completionOrders.add(first.runtime.completionOrder.join(","));
  }
  assert.equal(semanticDigests.size, 1);
  assert.ok(completionOrders.size >= 3);
});

test("v3 task retries recover deterministic faults throughout the DAG", {
  timeout: 120_000,
}, async () => {
  const baseline = await runScenario({ entropy: new SeededEntropySource(0x777) });
  for (const [index, faultTaskId] of [
    "leaf_00",
    "leaf_17",
    "layer_1_03",
    "layer_2_02",
    "layer_4_00",
    "final",
  ].entries()) {
    const recording = new RecordingEntropySource(new SeededEntropySource(0x900 + index));
    const recovered = await runScenario({ entropy: recording, faultTaskId });
    assert.equal(recovered.runtime.faultMatches, 1);
    assert.ok(recovered.runtime.transitions.some((transition) =>
      transition.taskId === faultTaskId && transition.phase === "after-fail"));
    assert.equal(taskGraphTask(recovered.snapshot, faultTaskId)?.attempt, 2);
    assert.ok(recovered.snapshot.tasks.every((record) => record.status === "accepted"));
    assert.equal(recovered.final, baseline.final);
    assert.ok(recovered.runtime.peakParallel <= POLICY.maxInflight);

    const replay = await runScenario({
      entropy: new ReplayingEntropySource(recording.getRecords()),
      faultTaskId,
    });
    assert.deepEqual(replay.snapshot, recovered.snapshot);
    assert.deepEqual(replay.runtime, recovered.runtime);
  }
});

test("provider execution stays bounded across 2,000 logical tasks", {
  timeout: 120_000,
}, async () => {
  const taskCount = 2_000;
  const providerConcurrency = 8;
  const scalePolicy: RunExecutionPolicy = {
    ...POLICY,
    maxTasks: taskCount,
    maxInflight: providerConcurrency,
    maxReady: taskCount,
    maxBlocked: taskCount,
  };
  const tasks = Array.from({ length: taskCount }, (_unused, index): StressTask => ({
    taskId: `scale_${String(index).padStart(4, "0")}`,
    nodeId: ALL_NODES[index % ALL_NODES.length]!.id,
    capability: "work",
    outputKey: `scale.${index}`,
    dependencyTaskIds: [],
  }));
  const taskGraph = new InMemoryTaskGraphControl();
  const ledger = new SharedWorkspaceLedger("kernel-provider-scale");
  const platform = defineRosterPlatform({
    id: "kernel-provider-scale",
    version: "3",
    policyVersion: "kernel-provider-scale-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [
      { id: "coordinate", description: "Coordinate the bounded provider simulation." },
      { id: "work", description: "Execute one simulated provider call." },
      { id: "compose", description: "Retain the reusable worker-node contract." },
    ],
    nodes: [coordinator, ...ALL_NODES],
    maxNodes: 64,
    policy: scalePolicy,
  });
  let activeProviderCalls = 0;
  let peakProviderCalls = 0;
  let completedProviderCalls = 0;
  const execution = platform.createExecution({
    runId: "provider-scale-run",
    seedTasks: tasks.map((task) => definition(task, 1)),
    taskGraph,
    dataReferences: new InMemoryDataReferenceStore({ maxEntries: taskCount }),
    createTaskContext: ({ runId, node, definition: taskDefinition, lease }) =>
      createRosterTaskContext({
        node,
        ledger,
        fence: {
          runId,
          taskId: taskDefinition.taskId,
          nodeId: node.id,
          fence: BigInt(lease.fence),
          frontierVersion: taskDefinition.inputs.frontierVersion,
          topologyVersion: taskDefinition.inputs.topologyVersion,
          catalogVersion: taskDefinition.inputs.catalogVersion,
          runtimeBindingEpoch: taskDefinition.runtimeBindingEpoch,
          inputVersions: taskDefinition.inputs.inputVersions,
        },
        authority: { assertActive: async () => undefined },
      }),
    nativeExecute: async (context) => {
      activeProviderCalls += 1;
      peakProviderCalls = Math.max(peakProviderCalls, activeProviderCalls);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        completedProviderCalls += 1;
        return hashCanonical({ taskId: context.definition.taskId });
      } finally {
        activeProviderCalls -= 1;
      }
    },
  });

  const quiescence = await execution.dispatchUntilQuiescent();
  const snapshot = await execution.snapshot();
  assert.equal(quiescence.deadlocked, false);
  assert.equal(snapshot.tasks.length, taskCount);
  assert.equal(completedProviderCalls, taskCount);
  assert.equal(peakProviderCalls, providerConcurrency);
  assert.ok(peakProviderCalls <= scalePolicy.maxInflight);
  assert.deepEqual(
    Object.fromEntries(Object.entries(Object.groupBy(
      snapshot.tasks,
      (record) => record.status,
    )).map(([status, records]) => [status, records?.length ?? 0])),
    { accepted: taskCount },
  );
});

test("v3 task-graph authority rejects oversized frontiers before dispatch", async () => {
  const tasks = Array.from({ length: POLICY.maxTasks + 1 }, (_unused, index): StressTask => ({
    taskId: `oversized_${String(index).padStart(3, "0")}`,
    nodeId: ALL_NODES[0]!.id,
    capability: "work",
    outputKey: `oversized.${index}`,
    dependencyTaskIds: [],
  }));
  const platform = defineRosterPlatform({
    id: "kernel-bound-rejection",
    version: "3",
    policyVersion: "kernel-bound-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [
      { id: "coordinate", description: "Coordinate bounded work." },
      { id: "work", description: "Perform bounded work." },
      { id: "compose", description: "Compose bounded work." },
    ],
    nodes: [coordinator, ALL_NODES[0]!],
    policy: POLICY,
  });
  const taskGraph = new InMemoryTaskGraphControl();
  const ledger = new SharedWorkspaceLedger("kernel-bound-rejection");
  const execution = platform.createExecution({
    runId: "oversized-run",
    seedTasks: tasks.map((task) => definition(task, 1)),
    taskGraph,
    dataReferences: new InMemoryDataReferenceStore(),
    createTaskContext: ({ runId, node, definition: taskDefinition, lease }) =>
      createRosterTaskContext({
        node,
        ledger,
        fence: {
          runId,
          taskId: taskDefinition.taskId,
          nodeId: node.id,
          fence: BigInt(lease.fence),
          frontierVersion: taskDefinition.inputs.frontierVersion,
          topologyVersion: taskDefinition.inputs.topologyVersion,
          catalogVersion: taskDefinition.inputs.catalogVersion,
          runtimeBindingEpoch: taskDefinition.runtimeBindingEpoch,
          inputVersions: taskDefinition.inputs.inputVersions,
        },
        authority: { assertActive: async () => undefined },
      }),
    nativeExecute: async () => "should-not-run",
  });
  await assert.rejects(execution.dispatchUntilQuiescent(), /maxTasks=128/);
});
