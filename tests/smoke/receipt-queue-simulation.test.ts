import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConditionVariable,
  RecordingEntropySource,
  ReplayingEntropySource,
  SimulationImpl,
  isApplicationFailure,
  type EntropySource,
  type Logger,
  type SimulationTask,
} from "determined";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { receiptQueue } from "../../src/adapters/receipt-queue.ts";
import { systemClock, VirtualClock, type Clock } from "../../src/core/clock.ts";
import type { JobQueue, QueueJob } from "../../src/engine/runtime/job-queue.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { decide as decideJob, initial as initialJob, reduce as reduceJob, type JobCmd, type JobEvent, type JobState } from "../../src/modules/job.ts";

class FixedEntropySource implements EntropySource {
  private index = 0;

  constructor(private readonly values: ReadonlyArray<number>) {
    assert.ok(values.length > 0, "fixed entropy requires at least one value");
  }

  random(_reason: string): number {
    const value = this.values[this.index % this.values.length];
    this.index += 1;
    assert.equal(typeof value, "number");
    return value;
  }
}

const silentLogger: Logger = {
  log: () => undefined,
  error: () => undefined,
};

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const queueRuntimes = new Map<string, ReturnType<typeof createRuntime<JobCmd, JobEvent, JobState>>>();

const makeQueue = (scope: string, clock: Clock = systemClock): JobQueue => {
  let runtime = queueRuntimes.get(scope);
  if (!runtime) {
    runtime = createRuntime<JobCmd, JobEvent, JobState>(
      memoryStore<JobEvent>(),
      memoryBranchStore(),
      decideJob,
      reduceJob,
      initialJob,
      { clock },
    );
    queueRuntimes.set(scope, runtime);
  }
  return receiptQueue({ runtime, stream: "jobs", clock });
};

type QueueSimulationSummary = {
  readonly observedBefore: number;
  readonly observedAfter: number;
  readonly finalJobs: ReadonlyArray<Pick<QueueJob, "agentId" | "status">>;
};

type FailureSearchSummary = {
  readonly completed: ReadonlyArray<string>;
  readonly failures: Readonly<Record<string, number>>;
  readonly finalJobs: ReadonlyArray<Pick<QueueJob, "agentId" | "attempt" | "status" | "lastError">>;
};

const runQueueSimulation = async (entropy: EntropySource): Promise<QueueSimulationSummary> => {
  const dir = await mkTmp("receipt-queue-simulation");
  const signal = new ConditionVariable("jobs-enqueued");
  const enqueued = { value: 0 };
  const observed = { before: -1, after: -1 };

  const producer = (name: "writer" | "theorem") => async (task: SimulationTask): Promise<string> => {
    const queue = makeQueue(dir);
    await task.checkpoint(`${name}:ready`);
    const job = await queue.enqueue({
      agentId: name,
      payload: { kind: `${name}.run`, runId: `${name}-sim` },
      maxAttempts: 1,
    });
    enqueued.value += 1;
    signal.notifyAll(task, `${name}:enqueued`);
    await task.checkpoint(`${name}:done`);
    return job.id;
  };

  try {
    const sim = new SimulationImpl(silentLogger, entropy, () => 0);
    const result = await sim.runTasks([
      { name: "producer-writer", f: producer("writer") },
      { name: "producer-theorem", f: producer("theorem") },
      {
        name: "observer-worker",
        f: async (task: SimulationTask): Promise<ReadonlyArray<string>> => {
          const queue = makeQueue(dir);
          observed.before = (await queue.listJobs()).length;

          while (enqueued.value < 2) {
            await signal.wait(task, "observer:waiting-for-producers");
          }

          await task.checkpoint("observer:after-signal");
          const visible = await queue.listJobs({ limit: 10 });
          observed.after = visible.length;

          const completed: string[] = [];
          for (let index = 0; index < 2; index += 1) {
            const leased = await queue.leaseNext({ workerId: "sim-worker", leaseMs: 10_000 });
            if (!leased) break;
            await task.checkpoint("observer:leased", leased.id);
            await queue.complete(leased.id, "sim-worker", { ok: true });
            completed.push(leased.id);
          }
          return completed;
        },
      },
    ] as const);

    if (result.isErr()) throw result.error;

    const finalJobs = (await makeQueue(dir).listJobs({ limit: 10 }))
      .map((job) => ({ agentId: job.agentId, status: job.status }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));

    return {
      observedBefore: observed.before,
      observedAfter: observed.after,
      finalJobs,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

test("receipt queue simulation: cross-instance observer sees scheduled producer writes", async () => {
  const recording = new RecordingEntropySource(new FixedEntropySource([0, 0.7, 0.2, 0.9, 0.1]));
  const first = await runQueueSimulation(recording);

  assert.equal(first.observedBefore, 0);
  assert.equal(first.observedAfter, 2);
  assert.deepEqual(first.finalJobs, [
    { agentId: "theorem", status: "completed" },
    { agentId: "writer", status: "completed" },
  ]);

  const replay = await runQueueSimulation(new ReplayingEntropySource(recording.getRecords()));
  assert.deepEqual(replay, first);
});

const agentIds = ["writer", "theorem", "axiom"] as const;

const runQueueFailureSearch = async (
  entropy: EntropySource,
  failpointProbability: (...log: readonly unknown[]) => number
): Promise<FailureSearchSummary> => {
  const dir = await mkTmp("receipt-queue-failure-simulation");
  const signal = new ConditionVariable("queue-progress");
  const enqueued = { value: 0 };
  const completed = new Set<string>();
  const failures = new Map<string, number>();
  const clock = new VirtualClock(1_000);

  const producer = (agentId: typeof agentIds[number]) => async (task: SimulationTask): Promise<string> => {
    const queue = makeQueue(dir, clock);
    await task.checkpoint(`${agentId}:producer-ready`);
    const job = await queue.enqueue({
      jobId: `job-${agentId}`,
      agentId,
      payload: { kind: `${agentId}.run`, runId: `${agentId}-failure-sim` },
      maxAttempts: 3,
    });
    enqueued.value += 1;
    signal.notifyAll(task, `${agentId}:producer-enqueued`);
    await task.checkpoint(`${agentId}:producer-done`, job.id);
    return job.id;
  };

  const worker = (workerId: string) => async (task: SimulationTask): Promise<ReadonlyArray<string>> => {
    const queue = makeQueue(dir, clock);
    const localCompleted: string[] = [];

    while (completed.size < agentIds.length) {
      if (enqueued.value < agentIds.length) {
        await signal.wait(task, `${workerId}:waiting-for-producers`);
        continue;
      }

      const leased = await queue.leaseNext({ workerId, leaseMs: 10_000 });
      if (!leased) {
        await signal.wait(task, `${workerId}:waiting-for-queued-job`);
        continue;
      }

      await task.checkpoint(`${workerId}:leased`, leased.id, leased.agentId, leased.attempt);
      try {
        await task.failpoint(`${workerId}:before-complete`, leased.agentId, leased.attempt);
        await queue.complete(leased.id, workerId, { ok: true, workerId });
        completed.add(leased.id);
        localCompleted.push(leased.id);
      } catch (err) {
        if (!isApplicationFailure(err)) throw err;
        failures.set(leased.id, (failures.get(leased.id) ?? 0) + 1);
        await queue.fail(leased.id, workerId, err.message, false, { workerId });
      }

      signal.notifyAll(task, `${workerId}:progress`);
      await task.checkpoint(`${workerId}:cycle-done`, leased.id);
    }

    return localCompleted;
  };

  try {
    const sim = new SimulationImpl(silentLogger, entropy, failpointProbability);
    const result = await sim.runTasks([
      ...agentIds.map((agentId) => ({ name: `producer-${agentId}`, f: producer(agentId) })),
      { name: "worker-a", f: worker("worker-a") },
      { name: "worker-b", f: worker("worker-b") },
    ] as const);

    if (result.isErr()) throw result.error;

    const finalJobs = (await makeQueue(dir, clock).listJobs({ limit: 10 }))
      .map((job) => ({
        agentId: job.agentId,
        attempt: job.attempt,
        status: job.status,
        lastError: job.lastError,
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));

    return {
      completed: [...completed].sort(),
      failures: Object.fromEntries([...failures.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      finalJobs,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

test("receipt queue simulation: searches schedules with injected worker failures", async () => {
  const schedules: ReadonlyArray<ReadonlyArray<number>> = [
    [0.04, 0.82, 0.18, 0.91, 0.33, 0.67],
    [0.78, 0.12, 0.44, 0.02, 0.88, 0.51],
    [0.31, 0.62, 0.07, 0.73, 0.24, 0.95],
    [0.56, 0.21, 0.84, 0.15, 0.69, 0.03],
  ];
  let sawInjectedFailure = false;

  for (const schedule of schedules) {
    const recording = new RecordingEntropySource(new FixedEntropySource(schedule));
    const first = await runQueueFailureSearch(recording, (...log) =>
      String(log[0]).includes("before-complete") && Number(log[2]) < 3 ? 0.35 : 0
    );

    assert.equal(first.completed.length, agentIds.length);
    assert.deepEqual(first.finalJobs.map((job) => job.status), ["completed", "completed", "completed"]);
    assert.equal(new Set(first.completed).size, first.completed.length, "job completed twice");

    for (const job of first.finalJobs) {
      assert.ok(job.attempt >= 1 && job.attempt <= 3);
    }

    sawInjectedFailure = sawInjectedFailure || Object.keys(first.failures).length > 0;

    const replay = await runQueueFailureSearch(
      new ReplayingEntropySource(recording.getRecords()),
      (...log) => String(log[0]).includes("before-complete") && Number(log[2]) < 3 ? 0.35 : 0
    );
    assert.deepEqual(replay, first);
  }

  assert.equal(sawInjectedFailure, true, "expected at least one schedule to inject a worker failure");
});

test("receipt queue simulation: terminal failure after max attempts is replayable", async () => {
  const runTerminalFailure = async (entropy: EntropySource): Promise<Pick<QueueJob, "attempt" | "lastError" | "status">> => {
    const dir = await mkTmp("receipt-queue-terminal-simulation");
    const queue = makeQueue(dir);
    const job = await queue.enqueue({
      jobId: "job-terminal",
      agentId: "writer",
      payload: { kind: "writer.run", runId: "terminal-sim" },
      maxAttempts: 2,
    });

    try {
      const sim = new SimulationImpl(
        silentLogger,
        entropy,
        (...log) => String(log[0]).includes("terminal:before-complete") ? 1 : 0
      );
      const result = await sim.runTasks([
        {
          name: "terminal-worker",
          f: async (task: SimulationTask): Promise<void> => {
            const workerQueue = makeQueue(dir);
            while (true) {
              const current = await workerQueue.getJob(job.id);
              if (current?.status === "failed") return;

              const leased = await workerQueue.leaseNext({ workerId: "terminal-worker", leaseMs: 10_000 });
              assert.ok(leased, "expected queued job to lease until max attempts are exhausted");
              await task.checkpoint("terminal:leased", leased.id, leased.attempt);

              try {
                await task.failpoint("terminal:before-complete", leased.attempt);
                await workerQueue.complete(leased.id, "terminal-worker", { ok: true });
              } catch (err) {
                if (!isApplicationFailure(err)) throw err;
                await workerQueue.fail(leased.id, "terminal-worker", err.message, false, { workerId: "terminal-worker" });
              }
            }
          },
        },
      ] as const);

      if (result.isErr()) throw result.error;

      const finalJob = await makeQueue(dir).getJob(job.id);
      assert.ok(finalJob, "missing terminal job");
      return {
        attempt: finalJob.attempt,
        lastError: finalJob.lastError,
        status: finalJob.status,
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  const recording = new RecordingEntropySource(new FixedEntropySource([0.11, 0.87, 0.24]));
  const first = await runTerminalFailure(recording);

  assert.equal(first.status, "failed");
  assert.equal(first.attempt, 2);
  assert.match(first.lastError ?? "", /failpoint|failure|terminal/i);

  const replay = await runTerminalFailure(new ReplayingEntropySource(recording.getRecords()));
  assert.deepEqual(replay, first);
});

test("receipt queue simulation: expired leases are recovered by another worker", async () => {
  const runLeaseExpiry = async (entropy: EntropySource): Promise<Pick<QueueJob, "attempt" | "lastError" | "leaseOwner" | "status">> => {
    const dir = await mkTmp("receipt-queue-lease-simulation");
    const clock = new VirtualClock(10_000);
    const queue = makeQueue(dir, clock);
    const job = await queue.enqueue({
      jobId: "job-lease-expiry",
      agentId: "theorem",
      payload: { kind: "theorem.run", runId: "lease-expiry-sim" },
      maxAttempts: 3,
    });
    const leasedSignal = new ConditionVariable("lease-held");
    const leaseHeld = { value: false };

    try {
      const sim = new SimulationImpl(silentLogger, entropy, () => 0);
      const result = await sim.runTasks([
        {
          name: "worker-a-holds-lease",
          f: async (task: SimulationTask): Promise<void> => {
            const workerQueue = makeQueue(dir, clock);
            const leased = await workerQueue.leaseNext({ workerId: "worker-a", leaseMs: 1_000 });
            assert.equal(leased?.leaseOwner, "worker-a");
            await task.checkpoint("lease-expiry:worker-a-leased", leased?.attempt);
            leaseHeld.value = true;
            leasedSignal.notifyAll(task, "lease-expiry:worker-a-ready");
          },
        },
        {
          name: "worker-b-recovers",
          f: async (task: SimulationTask): Promise<void> => {
            const workerQueue = makeQueue(dir, clock);
            while (!leaseHeld.value) {
              await leasedSignal.wait(task, "lease-expiry:waiting-for-worker-a");
            }
            await clock.advanceBy(2_000);
            await task.checkpoint("lease-expiry:lease-time-advanced");
            const leased = await workerQueue.leaseNext({ workerId: "worker-b", leaseMs: 1_000 });
            assert.equal(leased?.leaseOwner, "worker-b");
            assert.equal(leased?.attempt, 2);
            await workerQueue.complete(job.id, "worker-b", { recovered: true });
          },
        },
      ] as const);

      if (result.isErr()) throw result.error;

      const finalJob = await makeQueue(dir, clock).getJob(job.id);
      assert.ok(finalJob, "missing recovered job");
      return {
        attempt: finalJob.attempt,
        lastError: finalJob.lastError,
        leaseOwner: finalJob.leaseOwner,
        status: finalJob.status,
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  const recording = new RecordingEntropySource(new FixedEntropySource([0.22, 0.51, 0.93]));
  const first = await runLeaseExpiry(recording);

  assert.equal(first.status, "completed");
  assert.equal(first.attempt, 2);
  assert.equal(first.leaseOwner, "worker-b");
  assert.equal(first.lastError, "lease expired");

  const replay = await runLeaseExpiry(new ReplayingEntropySource(recording.getRecords()));
  assert.deepEqual(replay, first);
});

test("receipt queue simulation: long-dormant workflows survive repeated renewals without spending retries", async () => {
  const dir = await mkTmp("receipt-queue-long-running-simulation");
  const clock = new VirtualClock(1_000);
  const queue = makeQueue(dir, clock);
  const monthMs = 30 * 24 * 60 * 60_000;
  const leaseMs = 60 * 60_000;

  try {
    const job = await queue.enqueue({
      jobId: "job-long-running",
      agentId: "coding-agent",
      payload: { kind: "coding-agent.run", runId: "long-running-sim" },
      maxAttempts: 3,
    });

    await clock.advanceBy(6 * monthMs);
    const leased = await queue.leaseNext({
      workerId: "durable-worker",
      leaseMs,
    });
    assert.equal(leased?.id, job.id);
    assert.equal(leased?.attempt, 1, "dormant queue time must not consume an execution attempt");
    assert.ok(leased?.leaseFence);

    // Cross another simulated month while continually renewing the same
    // fenced attempt. No real sleeping is involved.
    for (let renewal = 0; renewal < 1_000; renewal += 1) {
      await clock.advanceBy(45 * 60_000);
      const heartbeat = await queue.heartbeat(
        job.id,
        "durable-worker",
        leaseMs,
        leased.leaseFence,
      );
      assert.equal(heartbeat?.attempt, 1);
      assert.equal(heartbeat?.leaseFence, leased.leaseFence);
      assert.equal(heartbeat?.status, "running");
      assert.ok((heartbeat?.leaseUntil ?? 0) > clock.now());
    }

    const completed = await queue.complete(
      job.id,
      "durable-worker",
      { durable: true },
      leased.leaseFence,
    );
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.attempt, 1);
    assert.deepEqual(completed?.result, { durable: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("receipt queue simulation: a replacement fence rejects a delayed completion from the lost worker", async () => {
  const dir = await mkTmp("receipt-queue-stale-fence-simulation");
  const clock = new VirtualClock(10_000);
  const queue = makeQueue(dir, clock);

  try {
    const job = await queue.enqueue({
      jobId: "job-stale-fence",
      agentId: "coding-agent",
      payload: { kind: "coding-agent.run", runId: "stale-fence-sim" },
      maxAttempts: 3,
    });
    const first = await queue.leaseNext({ workerId: "lost-worker", leaseMs: 1_000 });
    assert.ok(first?.leaseFence);

    await clock.advanceBy(24 * 60 * 60_000);
    const replacement = await queue.leaseNext({ workerId: "replacement-worker", leaseMs: 1_000 });
    assert.ok(replacement?.leaseFence);
    assert.notEqual(replacement.leaseFence, first.leaseFence);
    assert.equal(replacement.attempt, 2);

    const staleCompletion = await queue.complete(
      job.id,
      "lost-worker",
      { stale: true },
      first.leaseFence,
    );
    assert.equal(staleCompletion, undefined);

    const completed = await queue.complete(
      job.id,
      "replacement-worker",
      { recovered: true },
      replacement.leaseFence,
    );
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.attempt, 2);
    assert.deepEqual(completed?.result, { recovered: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("receipt queue simulation: active workers consume steer, follow-up, and abort commands", async () => {
  type CommandSimulationSummary = {
    readonly consumed: ReadonlyArray<string>;
    readonly finalJob: Pick<QueueJob, "abortRequested" | "canceledReason" | "status">;
  };

  const runCommandSimulation = async (entropy: EntropySource): Promise<CommandSimulationSummary> => {
    const dir = await mkTmp("receipt-queue-command-simulation");
    const queue = makeQueue(dir);
    const job = await queue.enqueue({
      jobId: "job-commands",
      agentId: "axiom",
      payload: { kind: "axiom.run", runId: "command-sim" },
      maxAttempts: 1,
    });
    const leasedSignal = new ConditionVariable("command-job-leased");
    const commandSignal = new ConditionVariable("command-job-commands");
    const state = {
      commandCount: 0,
      leased: false,
    };

    try {
      const sim = new SimulationImpl(silentLogger, entropy, () => 0);
      const result = await sim.runTasks([
        {
          name: "active-worker",
          f: async (task: SimulationTask): Promise<ReadonlyArray<string>> => {
            const workerQueue = makeQueue(dir);
            const leased = await workerQueue.leaseNext({ workerId: "active-worker", leaseMs: 10_000 });
            assert.equal(leased?.id, job.id);
            state.leased = true;
            leasedSignal.notifyAll(task, "commands:leased");

            while (state.commandCount < 3) {
              await commandSignal.wait(task, "commands:waiting-for-control");
            }

            await task.checkpoint("commands:consume");
            const consumed = await workerQueue.consumeCommands(job.id);
            if (consumed.some((command) => command.command === "abort")) {
              await workerQueue.cancel(job.id, "abort requested", "active-worker");
            }
            return consumed.map((command) => command.command).sort();
          },
        },
        {
          name: "controller",
          f: async (task: SimulationTask): Promise<void> => {
            const controlQueue = makeQueue(dir);
            while (!state.leased) {
              await leasedSignal.wait(task, "commands:waiting-for-lease");
            }
            await task.checkpoint("commands:issue-steer");
            await controlQueue.queueCommand({
              jobId: job.id,
              command: "steer",
              payload: { instruction: "try the shorter proof path" },
              by: "controller",
            });
            state.commandCount += 1;
            await controlQueue.queueCommand({
              jobId: job.id,
              command: "follow_up",
              payload: { question: "summarize current state" },
              by: "controller",
            });
            state.commandCount += 1;
            await controlQueue.queueCommand({
              jobId: job.id,
              command: "abort",
              payload: { reason: "newer request superseded this job" },
              by: "controller",
            });
            state.commandCount += 1;
            commandSignal.notifyAll(task, "commands:issued");
          },
        },
      ] as const);

      if (result.isErr()) throw result.error;
      const consumed = result.value[0];
      const finalJob = await makeQueue(dir).getJob(job.id);
      assert.ok(finalJob, "missing command job");
      return {
        consumed,
        finalJob: {
          abortRequested: finalJob.abortRequested,
          canceledReason: finalJob.canceledReason,
          status: finalJob.status,
        },
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  const recording = new RecordingEntropySource(new FixedEntropySource([0.66, 0.12, 0.48, 0.9]));
  const first = await runCommandSimulation(recording);

  assert.deepEqual(first.consumed, ["abort", "follow_up", "steer"]);
  assert.deepEqual(first.finalJob, {
    abortRequested: true,
    canceledReason: "abort requested",
    status: "canceled",
  });

  const replay = await runCommandSimulation(new ReplayingEntropySource(recording.getRecords()));
  assert.deepEqual(replay, first);
});

test("receipt queue converges caller-derived command and boundary claim identities", async () => {
  const scope = await mkTmp("receipt-queue-command-identities");
  try {
    const queue = makeQueue(scope, new VirtualClock(100));
    const job = await queue.enqueue({
      jobId: "job-stable-command",
      agentId: "coding-agent",
      payload: { runId: "run-1" },
    });
    const input = {
      commandId: "coding_command_stable",
      jobId: job.id,
      command: "steer" as const,
      payload: { messageId: "message-1", problem: "Preserve replay." },
      by: "ui",
    };
    const first = await queue.queueCommand(input);
    const duplicate = await queue.queueCommand({
      ...input,
      payload: { problem: "Preserve replay.", messageId: "message-1" },
    });
    assert.equal(first?.id, input.commandId);
    assert.equal(duplicate?.id, first?.id);
    assert.deepEqual(duplicate?.payload, first?.payload);
    await assert.rejects(() => queue.queueCommand({
      ...input,
      payload: { messageId: "message-1", problem: "Conflicting reuse." },
    }), /conflicting content/);

    const claim = await queue.consumeCommands(job.id, ["steer"], "consume-boundary-1");
    const retriedClaim = await queue.consumeCommands(job.id, ["steer"], "consume-boundary-1");
    assert.deepEqual(retriedClaim, claim);
    assert.equal(claim[0]?.consumedBy, "consume-boundary-1");
  } finally {
    queueRuntimes.delete(scope);
    await fs.rm(scope, { recursive: true, force: true });
  }
});
