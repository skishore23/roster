import { systemClock, type Clock } from "../../core/clock.js";
import type { JobQueue, QueueJob } from "./job-queue.js";

const TERMINAL_JOB_STATUSES = new Set<QueueJob["status"]>([
  "completed",
  "failed",
  "canceled",
]);

const boundedMilliseconds = (value: number, fallback: number, maximum: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), maximum));
};

export const isTerminalQueueJob = (job: Pick<QueueJob, "status">): boolean =>
  TERMINAL_JOB_STATUSES.has(job.status);

export type OwnedJobWaitResult = {
  readonly job?: QueueJob;
  readonly timedOut: boolean;
  readonly cancellationAttempted: boolean;
};

/**
 * Waits for a child job owned by the caller and closes its lifecycle on timeout.
 *
 * `JobQueue.waitForJob` may legally return the current non-terminal snapshot at
 * the end of any bounded wait. Rechecking until the overall deadline prevents a
 * short/spurious wait from silently abandoning the child. Once that deadline is
 * exhausted, ownership is resolved by durably canceling the child.
 */
export const waitForOwnedJob = async (input: {
  readonly queue: Pick<JobQueue, "getJob" | "waitForJob" | "cancel">;
  readonly jobId: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly timeoutReason: string;
  readonly canceledBy: string;
  readonly clock?: Clock;
  readonly onObserved?: (job: QueueJob | undefined) => Promise<void> | void;
}): Promise<OwnedJobWaitResult> => {
  const clock = input.clock ?? systemClock;
  const timeoutMs = boundedMilliseconds(input.timeoutMs, 0, 600_000);
  const pollMs = Math.max(1, boundedMilliseconds(input.pollMs, 100, 10_000));
  const deadline = clock.now() + timeoutMs;

  let current = await input.queue.getJob(input.jobId);
  await input.onObserved?.(current);
  if (!current || isTerminalQueueJob(current)) {
    return { job: current, timedOut: false, cancellationAttempted: false };
  }

  while (clock.now() < deadline) {
    const remainingMs = deadline - clock.now();
    const waitMs = Math.max(1, Math.min(pollMs, remainingMs));
    const waitStartedAt = clock.now();
    current = await input.queue.waitForJob(input.jobId, waitMs, waitMs);
    await input.onObserved?.(current);
    if (!current || isTerminalQueueJob(current)) {
      return { job: current, timedOut: false, cancellationAttempted: false };
    }

    // Some adapters wake on any queue change and can return a non-terminal
    // snapshot before their requested wait expires. Preserve bounded polling
    // without turning those wakeups into a hot loop.
    const unusedWaitMs = waitMs - (clock.now() - waitStartedAt);
    if (unusedWaitMs > 0 && clock.now() < deadline) {
      await clock.sleep(Math.min(unusedWaitMs, deadline - clock.now()));
    }
  }

  // Resolve the boundary race before issuing cancellation: a child that
  // committed a terminal state at the deadline must not be mislabeled as a
  // timeout merely because our preceding snapshot was stale.
  current = await input.queue.getJob(input.jobId);
  await input.onObserved?.(current);
  if (!current || isTerminalQueueJob(current)) {
    return { job: current, timedOut: false, cancellationAttempted: false };
  }

  const canceled = await input.queue.cancel(
    input.jobId,
    input.timeoutReason,
    input.canceledBy,
  );
  current = canceled ?? current;
  await input.onObserved?.(current);
  const childWonBoundaryRace = canceled !== undefined
    && isTerminalQueueJob(canceled)
    && canceled.status !== "canceled";
  return {
    job: current,
    timedOut: !childWonBoundaryRace,
    cancellationAttempted: true,
  };
};
