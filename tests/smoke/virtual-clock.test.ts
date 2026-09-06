import assert from "node:assert/strict";
import test from "node:test";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { receiptQueue } from "../../src/adapters/receipt-queue.ts";
import { VirtualClock, type ClockTimer } from "../../src/core/clock.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  DynamicTaskDispatcher,
  DynamicTaskHandlerRegistry,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
} from "../../src/engine/orchestration/task-graph-control.ts";
import type { RunExecutionPolicy } from "../../src/engine/platform/protocol.ts";
import { JobWorker } from "../../src/engine/runtime/job-worker.ts";
import type { JobQueue } from "../../src/engine/runtime/job-queue.ts";
import {
  decide as decideJob,
  initial as initialJob,
  reduce as reduceJob,
  type JobCmd,
  type JobEvent,
  type JobState,
} from "../../src/modules/job.ts";

test("virtual clock orders timers deterministically and drains sleeps without real time", async () => {
  const clock = new VirtualClock(1_000);
  const observed: string[] = [];
  let intervalRuns = 0;
  let interval: ClockTimer;
  interval = clock.setInterval(() => {
    intervalRuns += 1;
    observed.push(`interval:${clock.now()}`);
    if (intervalRuns === 3) clock.clearInterval(interval);
  }, 10);
  clock.setTimeout(() => observed.push(`timeout:${clock.now()}`), 20);
  const slept = clock.sleep(25).then(() => observed.push(`sleep:${clock.now()}`));

  await clock.advanceBy(30);
  await slept;

  assert.deepEqual(observed, [
    "interval:1010",
    "interval:1020",
    "timeout:1020",
    "sleep:1025",
    "interval:1030",
  ]);
  assert.equal(clock.now(), 1_030);
  assert.equal(clock.pendingTimerCount(), 0);
  await assert.rejects(clock.advanceTo(1_029), /cannot move backwards/);
});

test("one virtual clock drives receipt timestamps, queue dormancy, lease expiry, and replacement fences", async () => {
  const clock = new VirtualClock(1_700_000_000_000);
  const runtime = createRuntime<JobCmd, JobEvent, JobState>(
    memoryStore<JobEvent>(),
    memoryBranchStore(),
    decideJob,
    reduceJob,
    initialJob,
    { clock },
  );
  const queue = receiptQueue({ runtime, stream: "jobs" });
  assert.throws(
    () => receiptQueue({
      runtime,
      stream: "mismatched-jobs",
      clock: new VirtualClock(clock.now()),
    }),
    /clock must match its runtime receipt clock/,
  );
  const job = await queue.enqueue({
    jobId: "virtual-long-run",
    agentId: "coding-agent",
    payload: { kind: "coding-agent.run", runId: "virtual-long-run" },
    maxAttempts: 3,
  });
  assert.equal((await runtime.chain(`jobs/${job.id}`))[0]?.ts, clock.now());

  await clock.advanceBy(180 * 24 * 60 * 60_000);
  const first = await queue.leaseNext({ workerId: "worker-one", leaseMs: 60_000 });
  assert.equal(first?.attempt, 1);
  assert.equal(first?.leaseUntil, clock.now() + 60_000);
  assert.ok(first?.leaseFence);

  await clock.advanceBy(60_001);
  assert.equal(
    await queue.heartbeat(job.id, "worker-one", 60_000, first.leaseFence),
    undefined,
    "an expired worker must not revive its own lease before replacement",
  );
  assert.equal((await queue.getJob(job.id))?.status, "queued");
  const replacement = await queue.leaseNext({ workerId: "worker-two", leaseMs: 60_000 });
  assert.equal(replacement?.attempt, 2);
  assert.notEqual(replacement?.leaseFence, first.leaseFence);
  assert.equal(replacement?.lastError, "lease expired");

  assert.equal(
    await queue.complete(job.id, "worker-one", { stale: true }, first.leaseFence),
    undefined,
  );
  const completed = await queue.complete(
    job.id,
    "worker-two",
    { recovered: true },
    replacement?.leaseFence,
  );
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.result, { recovered: true });
  assert.deepEqual(
    (await runtime.chain(`jobs/${job.id}`)).map((entry) => entry.ts),
    [
      1_700_000_000_000,
      1_715_552_000_000,
      1_715_552_060_001,
      1_715_552_060_001,
      1_715_552_060_001,
    ],
  );
});

test("dynamic dispatcher wall time follows virtual active time and preserves accepted work", async () => {
  const clock = new VirtualClock(5_000);
  const policy: RunExecutionPolicy = {
    maxTasks: 1,
    maxDepth: 1,
    maxFanout: 1,
    maxInflight: 1,
    maxReady: 1,
    maxBlocked: 1,
    maxAttempts: 1,
    maxContextBytes: 64_000,
    maxCostMicros: 1_000,
    maxTokens: 1_000,
    maxWallTimeMs: 1_000,
  };
  const definition = createDynamicTaskDefinition({
    taskId: "virtual-work",
    semanticKey: "virtual-work",
    nodeId: "worker",
    capability: "implement",
    objective: "Complete work across a virtual dispatch boundary.",
    handler: { kind: "virtual-work", version: "1" },
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: { mode: "text", outputKey: "result" },
    dependencies: [],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: { objective: "v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 10_000,
    sideEffect: "pure",
    estimatedCostMicros: 1,
  });
  const control = new InMemoryTaskGraphControl();
  await control.initialize({
    runId: "virtual-dispatch",
    policy,
    seedTasks: [definition],
  });
  const handlers = new DynamicTaskHandlerRegistry();
  let markStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  handlers.register({ kind: "virtual-work", version: "1" }, async () => {
    markStarted();
    await clock.sleep(2_000);
    return "accepted before the dispatch tenure check";
  });

  const dispatch = new DynamicTaskDispatcher({
    runId: "virtual-dispatch",
    control,
    handlers,
    dataReferences: new InMemoryDataReferenceStore(),
    heartbeatMs: 5_000,
    clock,
  }).dispatchUntilQuiescent();
  await started;
  await clock.advanceBy(2_000);

  await assert.rejects(dispatch, /exceeded maxWallTimeMs=1000/);
  assert.equal(taskGraphTask(await control.snapshot(), definition.taskId)?.status, "accepted");
});

test("job worker renews one fenced attempt through virtual timer cycles", async () => {
  const clock = new VirtualClock(50_000);
  const runtime = createRuntime<JobCmd, JobEvent, JobState>(
    memoryStore<JobEvent>(),
    memoryBranchStore(),
    decideJob,
    reduceJob,
    initialJob,
    { clock },
  );
  const queue = receiptQueue({ runtime, stream: "jobs", clock });
  const job = await queue.enqueue({
    jobId: "virtual-worker-renewal",
    agentId: "long-worker",
    payload: { kind: "long-worker.run" },
    maxAttempts: 2,
  });
  let heartbeatCalls = 0;
  const observingQueue: JobQueue = {
    ...queue,
    heartbeat: async (...args) => {
      heartbeatCalls += 1;
      return queue.heartbeat(...args);
    },
  };
  let markStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new JobWorker({
    queue: observingQueue,
    workerId: "virtual-worker",
    pollMs: 50,
    leaseMs: 5_000,
    concurrency: 1,
    clock,
    handlers: {
      "long-worker": async () => {
        markStarted();
        await released;
        return { ok: true, result: { renewed: true } };
      },
    },
  });
  worker.start();
  await started;

  for (let step = 0; step < 20; step += 1) {
    await clock.advanceBy(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const active = await queue.getJob(job.id);
  assert.equal(active?.attempt, 1);
  assert.equal(active?.status, "running");
  assert.ok((active?.leaseUntil ?? 0) > clock.now());
  assert.ok(heartbeatCalls >= 5);

  release();
  for (let turn = 0; turn < 20 && (await queue.getJob(job.id))?.status !== "completed"; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const completed = await queue.getJob(job.id);
  worker.stop();
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.attempt, 1);
  assert.deepEqual(completed?.result, { renewed: true });
});
