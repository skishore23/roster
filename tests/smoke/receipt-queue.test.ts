import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { receiptQueue } from "../../src/adapters/receipt-queue.ts";
import { VirtualClock } from "../../src/core/clock.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import {
  JobWorker,
  jobResultRequestsRetry,
  normalizeJobWorkerLimits,
} from "../../src/engine/runtime/job-worker.ts";
import type { JobQueue } from "../../src/engine/runtime/job-queue.ts";

test("worker retry classification honors the run failure receipt", () => {
  assert.equal(jobResultRequestsRetry({
    status: "failed",
    failure: { failureClass: "model_json_parse", retryable: true },
  }), true);
  assert.equal(jobResultRequestsRetry({
    status: "failed",
    failure: { failureClass: "workspace_missing", retryable: false },
  }), false);
  assert.equal(jobResultRequestsRetry({ status: "completed" }), false);
});

test("job worker replaces non-finite limits and bounds external capacity", () => {
  assert.deepEqual(normalizeJobWorkerLimits({
    pollMs: Number.NaN,
    leaseMs: Number.POSITIVE_INFINITY,
    concurrency: Number.NEGATIVE_INFINITY,
  }), {
    pollMs: 250,
    leaseMs: 30_000,
    concurrency: 10,
  });
  assert.deepEqual(normalizeJobWorkerLimits({
    pollMs: 10.9,
    leaseMs: 9_999_999,
    concurrency: 999.8,
  }), {
    pollMs: 50,
    leaseMs: 3_600_000,
    concurrency: 256,
  });
});
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

test("receipt queue: lease/retry/wait lifecycle", async () => {
  const dir = await mkTmp("receipt-queue");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = receiptQueue({ runtime, stream: "jobs" });
    const job = await queue.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "r1" },
      maxAttempts: 2,
    });
    const jobChain = await runtime.chain(`jobs/${job.id}`);
    assert.equal(jobChain.length > 0, true, "per-job stream should contain lifecycle receipts");

    const lease1 = await queue.leaseNext({ workerId: "w1", leaseMs: 5_000 });
    assert.ok(lease1, "expected first lease");
    assert.equal(lease1?.id, job.id);
    assert.equal(lease1?.attempt, 1);

    const duplicate = await queue.leaseNext({ workerId: "w2", leaseMs: 5_000 });
    assert.equal(duplicate, undefined, "should not double-lease same queued item");

    await queue.fail(job.id, "w1", "transient");
    const afterFail = await queue.getJob(job.id);
    assert.equal(afterFail?.status, "queued");

    const lease2 = await queue.leaseNext({ workerId: "w2", leaseMs: 5_000 });
    assert.ok(lease2, "expected retry lease");
    assert.equal(lease2?.attempt, 2);

    await queue.complete(job.id, "w2", { ok: true });
    const settled = await queue.waitForJob(job.id, 1_000, 25);
    assert.equal(settled?.status, "completed");
    assert.equal(await queue.queueCommand({ jobId: job.id, command: "abort" }), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("job worker honors an abort requested while a handler is finishing", { timeout: 5_000 }, async () => {
  const dir = await mkTmp("receipt-worker-late-abort");
  let worker: JobWorker | undefined;
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = receiptQueue({ runtime, stream: "jobs" });
    const job = await queue.enqueue({
      agentId: "slow-agent",
      payload: { kind: "test.run" },
      maxAttempts: 1,
    });
    let releaseHandler = (): void => undefined;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let markHandlerStarted = (): void => undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    worker = new JobWorker({
      queue,
      workerId: "worker-1",
      pollMs: 50,
      handlers: {
        "slow-agent": async () => {
          markHandlerStarted();
          await handlerReleased;
          return { ok: true, result: { output: "late success" } };
        },
      },
    });
    worker.start();
    await handlerStarted;
    assert.ok(await queue.queueCommand({ jobId: job.id, command: "abort", by: "test" }));
    releaseHandler();

    const settled = await queue.waitForJob(job.id, 2_000, 20);
    assert.equal(settled?.status, "canceled");
    assert.equal(settled?.result, undefined);
  } finally {
    worker?.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("job worker propagates an in-flight abort signal into the active handler", { timeout: 5_000 }, async () => {
  const dir = await mkTmp("receipt-worker-active-abort");
  let worker: JobWorker | undefined;
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = receiptQueue({ runtime, stream: "jobs" });
    const job = await queue.enqueue({
      agentId: "abortable-agent",
      payload: { kind: "test.run" },
      maxAttempts: 1,
    });
    let markHandlerStarted = (): void => undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    let handlerObservedAbort = false;
    worker = new JobWorker({
      queue,
      workerId: "worker-active-abort",
      pollMs: 50,
      handlers: {
        "abortable-agent": async (_leased, context) => {
          markHandlerStarted();
          await new Promise<never>((_resolve, reject) => {
            const abort = (): void => {
              handlerObservedAbort = true;
              reject(context.signal.reason);
            };
            if (context.signal.aborted) abort();
            else context.signal.addEventListener("abort", abort, { once: true });
          });
          return { ok: true };
        },
      },
    });
    worker.start();
    await handlerStarted;
    assert.ok(await queue.queueCommand({ jobId: job.id, command: "abort", by: "test" }));

    const settled = await queue.waitForJob(job.id, 2_000, 20);
    assert.equal(settled?.status, "canceled");
    assert.equal(handlerObservedAbort, true);
  } finally {
    worker?.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("job worker exposes a fail-closed lease assertion for irreversible handler work", { timeout: 5_000 }, async () => {
  const dir = await mkTmp("receipt-worker-lease-fence");
  let worker: JobWorker | undefined;
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = receiptQueue({ runtime, stream: "jobs" });
    const job = await queue.enqueue({
      agentId: "guarded-agent",
      payload: { kind: "test.run" },
      maxAttempts: 1,
    });
    let heartbeatCalls = 0;
    const guardedQueue: JobQueue = {
      ...queue,
      heartbeat: async (...args) => {
        heartbeatCalls += 1;
        return heartbeatCalls === 1 ? queue.heartbeat(...args) : undefined;
      },
    };
    let irreversibleWorkRan = false;
    worker = new JobWorker({
      queue: guardedQueue,
      workerId: "worker-lease-guard",
      pollMs: 50,
      handlers: {
        "guarded-agent": async (_leased, context) => {
          await context.assertLease();
          irreversibleWorkRan = true;
          return { ok: true };
        },
      },
    });
    worker.start();

    const settled = await queue.waitForJob(job.id, 2_000, 20);
    assert.equal(settled?.status, "failed");
    assert.match(settled?.lastError ?? "", /execution fence/i);
    assert.equal(irreversibleWorkRan, false);
  } finally {
    worker?.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("receipt queue rejects a stale fence after the same worker reacquires a job", async () => {
  const dir = await mkTmp("receipt-queue-stale-fence");
  const clock = new VirtualClock(10_000);
  try {
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
      agentId: "same-worker-agent",
      payload: { kind: "test.run" },
      maxAttempts: 2,
    });
    const first = await queue.leaseNext({ workerId: "worker-stable-id", leaseMs: 1_000 });
    assert.ok(first?.leaseFence);
    await clock.advanceBy(2_000);
    const second = await queue.leaseNext({ workerId: "worker-stable-id", leaseMs: 1_000 });
    assert.ok(second?.leaseFence);
    assert.notEqual(second?.leaseFence, first?.leaseFence);

    const staleCompletion = await queue.complete(
      job.id,
      "worker-stable-id",
      { stale: true },
      first?.leaseFence,
    );
    assert.equal(staleCompletion, undefined);
    assert.equal((await queue.getJob(job.id))?.status, "leased");

    const completed = await queue.complete(
      job.id,
      "worker-stable-id",
      { recovered: true },
      second?.leaseFence,
    );
    assert.equal(completed?.status, "completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("receipt queue: steer/follow-up/abort command lanes", async () => {
  const dir = await mkTmp("receipt-queue-cmd");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = receiptQueue({ runtime, stream: "jobs" });
    const job = await queue.enqueue({
      agentId: "theorem",
      payload: { kind: "theorem.run", runId: "r2" },
      maxAttempts: 1,
    });

    const steer = await queue.queueCommand({
      jobId: job.id,
      command: "steer",
      payload: { config: { rounds: 1 } },
    });
    assert.ok(steer);
    assert.equal(steer?.lane, "steer");

    const follow = await queue.queueCommand({
      jobId: job.id,
      command: "follow_up",
      payload: { note: "tighten proof" },
    });
    assert.ok(follow);
    assert.equal(follow?.lane, "follow_up");

    const commands = await queue.consumeCommands(job.id, ["steer", "follow_up"]);
    assert.equal(commands.length, 2);

    const abort = await queue.queueCommand({ jobId: job.id, command: "abort" });
    assert.ok(abort);
    const canceled = await queue.getJob(job.id);
    assert.equal(canceled?.status, "canceled");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("receipt queue: failed jobs retain terminal result metadata", async () => {
  const dir = await mkTmp("receipt-queue-failed-result");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = receiptQueue({ runtime, stream: "jobs" });
    const job = await queue.enqueue({
      agentId: "axiom-roster",
      payload: { kind: "axiom-roster.run", runId: "r_failed" },
      maxAttempts: 1,
    });

    await queue.leaseNext({ workerId: "w1", leaseMs: 5_000 });
    await queue.fail(job.id, "w1", "final verify failed", true, {
      runId: "r_failed",
      status: "failed",
      followUpJobId: "job_retry_1",
      followUpRunId: "run_retry_1",
      failureClass: "axle_verify_failed",
      failure: {
        stage: "verification",
        failureClass: "axle_verify_failed",
        message: "Final verification failed.",
        retryable: true,
      },
    });

    const failed = await queue.getJob(job.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.result?.followUpJobId, "job_retry_1");
    assert.equal(failed?.result?.followUpRunId, "run_retry_1");
    assert.equal(failed?.result?.failureClass, "axle_verify_failed");
    assert.equal((failed?.result?.failure as Record<string, unknown> | undefined)?.failureClass, "axle_verify_failed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("receipt queue: session singleton cancel and steer modes", async () => {
  const dir = await mkTmp("receipt-queue-singleton");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = receiptQueue({ runtime, stream: "jobs" });

    const first = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:1",
      singletonMode: "cancel",
      payload: { msg: "first" },
    });
    assert.equal(first.status, "queued");

    const second = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:1",
      singletonMode: "cancel",
      payload: { msg: "second" },
    });
    assert.equal(second.status, "queued");
    const firstAfter = await queue.getJob(first.id);
    assert.equal(firstAfter?.status, "canceled");

    const third = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:2",
      singletonMode: "cancel",
      payload: { msg: "third" },
    });
    assert.equal(third.status, "queued");

    const steerTarget = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:3",
      singletonMode: "cancel",
      payload: { msg: "base" },
    });
    const steered = await queue.enqueue({
      agentId: "writer",
      sessionKey: "chat:3",
      singletonMode: "steer",
      payload: { note: "new message" },
    });
    assert.equal(steered.id, steerTarget.id);
    const commands = await queue.consumeCommands(steerTarget.id, ["steer"]);
    assert.equal(commands.length, 1);

    const rejectTarget = await queue.enqueue({
      agentId: "coding-agent",
      sessionKey: "workspace-rescan:1",
      singletonMode: "reject",
      payload: { kind: "workspace-rescan" },
    });
    await assert.rejects(queue.enqueue({
      agentId: "coding-agent",
      sessionKey: "workspace-rescan:1",
      singletonMode: "reject",
      payload: { kind: "workspace-rescan", request: "different" },
    }), new RegExp(`active job ${rejectTarget.id}`));
    assert.equal((await queue.getJob(rejectTarget.id))?.status, "queued");

    const stableInput = {
      requestId: "enqueue-rescan-stable",
      jobId: "coding-rescan-stable",
      agentId: "coding-agent",
      sessionKey: "workspace-rescan:stable",
      singletonMode: "reject" as const,
      maxAttempts: 1,
      payload: { kind: "workspace-rescan", request: "same" },
    };
    const stable = await queue.enqueue(stableInput);
    assert.equal((await queue.enqueue(stableInput)).id, stable.id);
    await assert.rejects(queue.enqueue({
      ...stableInput,
      payload: { kind: "workspace-rescan", request: "changed" },
    }), /changed after enqueue/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("receipt queue: getJob reads authoritative jobs/<jobId> stream", async () => {
  const dir = await mkTmp("receipt-queue-authoritative");
  try {
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob
    );
    const queue = receiptQueue({ runtime, stream: "jobs" });

    await runtime.execute("jobs", {
      type: "emit",
      eventId: "aggregate-index-only",
      event: {
        type: "job.enqueued",
        jobId: "legacy_only",
        agentId: "writer",
        lane: "collect",
        payload: { kind: "writer.run" },
        maxAttempts: 1,
      },
    });

    const fromAuthoritative = await queue.getJob("legacy_only");
    assert.equal(fromAuthoritative, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("receipt queue: separate queue instances observe fresh shared state", async () => {
  const dir = await mkTmp("receipt-queue-fresh-index");
  try {
    const store = memoryStore<JobEvent>();
    const branches = memoryBranchStore();
    const makeQueue = () => {
      const runtime = createRuntime<JobCmd, JobEvent, JobState>(
        store,
        branches,
        decideJob,
        reduceJob,
        initialJob
      );
      return receiptQueue({ runtime, stream: "jobs" });
    };

    const staleReader = makeQueue();
    const writer = makeQueue();

    assert.equal((await staleReader.listJobs()).length, 0);

    const created = await writer.enqueue({
      agentId: "writer",
      payload: { kind: "writer.run", runId: "fresh-index" },
      maxAttempts: 1,
    });

    assert.equal((await staleReader.listJobs()).some((job) => job.id === created.id), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const renewal of ["missing", "transport-failure", "hung"] as const) {
  test(`job worker aborts on ${renewal} renewal by its last known lease deadline`, { timeout: 5_000 }, async () => {
    const clock = new VirtualClock(10_000);
    const runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(), memoryBranchStore(), decideJob, reduceJob, initialJob, { clock },
    );
    const queue = receiptQueue({ runtime, stream: `lease-${renewal}`, clock });
    const job = await queue.enqueue({ agentId: "slow", payload: {}, maxAttempts: 1 });
    let renewals = 0;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let observedSignal: AbortSignal | undefined;
    const guarded: JobQueue = { ...queue, heartbeat: async (...args) => {
      renewals += 1;
      if (renewals === 1) return queue.heartbeat(...args);
      if (renewal === "missing") return undefined;
      if (renewal === "transport-failure") throw new Error("disconnected");
      return new Promise(() => {});
    } };
    const worker = new JobWorker({ queue: guarded, clock, leaseMs: 5_000, pollMs: 50, workerId: "obsolete-worker", handlers: {
      slow: async (_job, context) => {
        observedSignal = context.signal;
        started();
        await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
        return { ok: true };
      },
    } });
    try {
      worker.start();
      await running;
      worker.stop();
      await clock.advanceBy(6_000);
      assert.equal(observedSignal?.aborted, true);
      await worker.drain();
      assert.notEqual((await queue.getJob(job.id))?.status, "completed");
    } finally { worker.stop(); }
  });
}
