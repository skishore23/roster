import assert from "node:assert/strict";
import test from "node:test";

import { VirtualClock } from "../../src/core/clock.ts";
import { waitForOwnedJob } from "../../src/engine/runtime/delegated-job.ts";
import type { JobQueue, QueueJob } from "../../src/engine/runtime/job-queue.ts";

const jobWithStatus = (status: QueueJob["status"]): QueueJob => ({
  id: "child-1",
  agentId: "axiom",
  lane: "follow_up",
  payload: {},
  status,
  attempt: 1,
  maxAttempts: 1,
  createdAt: 1,
  updatedAt: 1,
  commands: [],
});

type WaitQueue = Pick<JobQueue, "getJob" | "waitForJob" | "cancel">;

test("owned child wait rechecks non-terminal snapshots until the child settles", async () => {
  const observations: QueueJob["status"][] = [];
  const waits = [jobWithStatus("running"), jobWithStatus("completed")];
  let waitCalls = 0;
  let cancelCalls = 0;
  const queue: WaitQueue = {
    getJob: async () => jobWithStatus("running"),
    waitForJob: async () => {
      const result = waits[Math.min(waitCalls, waits.length - 1)];
      waitCalls += 1;
      return result;
    },
    cancel: async () => {
      cancelCalls += 1;
      return jobWithStatus("canceled");
    },
  };

  const result = await waitForOwnedJob({
    queue,
    jobId: "child-1",
    timeoutMs: 100,
    pollMs: 1,
    timeoutReason: "join timeout",
    canceledBy: "parent",
    onObserved: (job) => {
      if (job) observations.push(job.status);
    },
  });

  assert.equal(result.job?.status, "completed");
  assert.equal(result.timedOut, false);
  assert.equal(result.cancellationAttempted, false);
  assert.equal(waitCalls, 2);
  assert.equal(cancelCalls, 0);
  assert.deepEqual(observations, ["running", "running", "completed"]);
});

test("owned child wait durably cancels a non-terminal child at its deadline", async () => {
  const cancelInputs: Array<{ reason?: string; by?: string }> = [];
  const queue: WaitQueue = {
    getJob: async () => jobWithStatus("queued"),
    waitForJob: async () => jobWithStatus("queued"),
    cancel: async (_jobId, reason, by) => {
      cancelInputs.push({ reason, by });
      return { ...jobWithStatus("canceled"), canceledReason: reason, abortRequested: true };
    },
  };

  const result = await waitForOwnedJob({
    queue,
    jobId: "child-1",
    timeoutMs: 0,
    pollMs: 1,
    timeoutReason: "parent join timed out",
    canceledBy: "subagent-join",
  });

  assert.equal(result.job?.status, "canceled");
  assert.equal(result.job?.abortRequested, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancellationAttempted, true);
  assert.deepEqual(cancelInputs, [{ reason: "parent join timed out", by: "subagent-join" }]);
});

test("owned child wait preserves a terminal result that wins the timeout boundary race", async () => {
  let reads = 0;
  let cancelCalls = 0;
  const queue: WaitQueue = {
    getJob: async () => {
      reads += 1;
      return jobWithStatus(reads === 1 ? "running" : "completed");
    },
    waitForJob: async () => jobWithStatus("running"),
    cancel: async () => {
      cancelCalls += 1;
      return jobWithStatus("canceled");
    },
  };

  const result = await waitForOwnedJob({
    queue,
    jobId: "child-1",
    timeoutMs: 0,
    pollMs: 1,
    timeoutReason: "deadline",
    canceledBy: "parent",
  });

  assert.equal(result.job?.status, "completed");
  assert.equal(result.timedOut, false);
  assert.equal(result.cancellationAttempted, false);
  assert.equal(cancelCalls, 0);
});

test("owned child deadline uses virtual time without a real wait", async () => {
  const clock = new VirtualClock(5_000);
  let canceled = false;
  const queue: WaitQueue = {
    getJob: async () => jobWithStatus(canceled ? "canceled" : "running"),
    waitForJob: async () => jobWithStatus("running"),
    cancel: async () => {
      canceled = true;
      return jobWithStatus("canceled");
    },
  };
  const waiting = waitForOwnedJob({
    queue,
    jobId: "child-1",
    timeoutMs: 100,
    pollMs: 25,
    timeoutReason: "virtual deadline",
    canceledBy: "parent",
    clock,
  });

  for (let step = 0; step < 4; step += 1) {
    await clock.advanceBy(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const result = await waiting;

  assert.equal(clock.now(), 5_100);
  assert.equal(result.job?.status, "canceled");
  assert.equal(result.timedOut, true);
  assert.equal(result.cancellationAttempted, true);
});
