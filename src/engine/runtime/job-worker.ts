// ============================================================================
// Background Job Worker - queue polling + leased execution + retries
// ============================================================================

import { boundedFiniteInteger } from "../../core/numbers.js";
import { systemClock, type Clock, type ClockTimer } from "../../core/clock.js";
import type { JobQueue, QueueCommandRecord, QueueJob } from "./job-queue.js";

export type JobExecutionContext = {
  readonly workerId: string;
  readonly leaseFence?: string;
  /** Aborts in-flight runtime work when the durable job receives an abort command. */
  readonly signal: AbortSignal;
  /** Revalidates the exact leased attempt before an irreversible side effect. */
  readonly assertLease: () => Promise<void>;
  readonly pullCommands: (
    types?: ReadonlyArray<"steer" | "follow_up" | "abort">,
    consumeId?: string,
  ) => Promise<ReadonlyArray<QueueCommandRecord>>;
};

export class JobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} no longer owns its leased execution fence`);
    this.name = "JobLeaseLostError";
  }
}

export type JobExecutionResult = {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly noRetry?: boolean;
};

export const jobResultRequestsRetry = (result: Readonly<Record<string, unknown>>): boolean => {
  if (result.status !== "failed") return false;
  const failure = result.failure;
  return Boolean(
    failure
    && typeof failure === "object"
    && !Array.isArray(failure)
    && (failure as Readonly<Record<string, unknown>>).retryable === true
  );
};

export type JobHandler = (job: QueueJob, ctx: JobExecutionContext) => Promise<JobExecutionResult>;

export type JobWorkerOptions = {
  readonly queue: JobQueue;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly workerId: string;
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly concurrency?: number;
  readonly clock?: Clock;
  readonly onTick?: () => void;
  readonly onError?: (error: Error) => void;
};

export type JobWorkerLimits = {
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly concurrency: number;
};

export const normalizeJobWorkerLimits = (
  options: Pick<JobWorkerOptions, "pollMs" | "leaseMs" | "concurrency">,
): JobWorkerLimits => ({
  pollMs: boundedFiniteInteger(options.pollMs, 250, 50, 60_000),
  leaseMs: boundedFiniteInteger(options.leaseMs, 30_000, 5_000, 3_600_000),
  concurrency: boundedFiniteInteger(options.concurrency, 10, 1, 256),
});

export class JobWorker {
  private readonly queue: JobQueue;
  private readonly handlers: Readonly<Record<string, JobHandler>>;
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private readonly clock: Clock;
  private readonly onTick?: () => void;
  private readonly onError?: (error: Error) => void;
  private readonly active = new Map<string, Promise<void>>();
  private running = false;

  constructor(opts: JobWorkerOptions) {
    const limits = normalizeJobWorkerLimits(opts);
    this.queue = opts.queue;
    this.handlers = opts.handlers;
    this.workerId = opts.workerId;
    this.pollMs = limits.pollMs;
    this.leaseMs = limits.leaseMs;
    this.concurrency = limits.concurrency;
    this.clock = opts.clock ?? systemClock;
    this.onTick = opts.onTick;
    this.onError = opts.onError;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop().catch((err) => {
      this.running = false;
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
    });
  }

  stop(): void {
    this.running = false;
  }

  /** Stops claiming new work and resolves after currently leased handlers settle. */
  async drain(): Promise<void> {
    this.stop();
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()]);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } finally {
        if (this.onTick) this.onTick();
      }
      if (!this.running) break;
      if (claimed === 0 && this.queue.waitForAvailable) {
        await this.queue.waitForAvailable(Math.max(1_000, Math.min(5_000, this.pollMs * 20)));
      } else {
        await this.clock.sleep(this.pollMs);
      }
    }
  }

  private async tick(): Promise<number> {
    let claimed = 0;
    while (this.active.size < this.concurrency) {
      const leased = await this.queue.leaseNext({
        workerId: this.workerId,
        leaseMs: this.leaseMs,
      });
      if (!leased) break;
      claimed += 1;
      const runPromise = this.runLeased(leased)
        .catch((err) => {
          this.running = false;
          const error = err instanceof Error ? err : new Error(String(err));
          this.onError?.(error);
        })
        .finally(() => {
          this.active.delete(leased.id);
        });
      this.active.set(leased.id, runPromise);
    }
    return claimed;
  }

  private async runLeased(job: QueueJob): Promise<void> {
    const pullCommands = async (
      types?: ReadonlyArray<"steer" | "follow_up" | "abort">,
      consumeId?: string,
    ): Promise<ReadonlyArray<QueueCommandRecord>> => this.queue.consumeCommands(job.id, types, consumeId);

    const preAbort = await pullCommands(["abort"]);
    if (preAbort.length > 0 || job.abortRequested) {
      await this.queue.cancel(job.id, "abort requested", this.workerId);
      return;
    }

    let leaseDeadline: ClockTimer | undefined;
    let leaseTrackingActive = true;
    let heartbeatInFlight: Promise<QueueJob | undefined> | undefined;
    const executionController = new AbortController();
    const abortExecution = (reason: Error): void => {
      if (!executionController.signal.aborted) executionController.abort(reason);
    };
    const renewLease = (): Promise<QueueJob | undefined> => {
      if (heartbeatInFlight) return heartbeatInFlight;
      const renewal = this.queue.heartbeat(job.id, this.workerId, this.leaseMs, job.leaseFence);
      heartbeatInFlight = renewal;
      renewal.then(
        () => {
          if (heartbeatInFlight === renewal) heartbeatInFlight = undefined;
        },
        () => {
          if (heartbeatInFlight === renewal) heartbeatInFlight = undefined;
        },
      );
      return renewal;
    };
    const validateLease = (renewed: QueueJob | undefined): void => {
      if (!leaseTrackingActive) return;
      executionController.signal.throwIfAborted();
      const sameFence = !job.leaseFence || renewed?.leaseFence === job.leaseFence;
      const active = renewed?.status === "running" || renewed?.status === "leased";
      const unexpired = renewed?.leaseUntil === undefined || renewed.leaseUntil > this.clock.now();
      if (!renewed || renewed.leaseOwner !== this.workerId || !sameFence || !active || !unexpired) {
        const error = new JobLeaseLostError(job.id);
        abortExecution(error);
        throw error;
      }
      if (leaseDeadline) this.clock.clearTimeout(leaseDeadline);
      leaseDeadline = this.clock.setTimeout(() => abortExecution(new JobLeaseLostError(job.id)),
        Math.max(0, (renewed.leaseUntil ?? this.clock.now() + this.leaseMs) - this.clock.now()));
    };
    const assertLease = async (): Promise<void> => {
      executionController.signal.throwIfAborted();
      validateLease(await renewLease());
    };

    let abortPollInFlight: Promise<void> | undefined;
    const pollAbort = (): Promise<void> => {
      if (abortPollInFlight) return abortPollInFlight;
      const poll = this.queue.getJob(job.id).then((latest) => {
        if (latest?.abortRequested || latest?.status === "canceled") {
          abortExecution(new Error("abort requested"));
        }
      });
      abortPollInFlight = poll;
      poll.then(
        () => {
          if (abortPollInFlight === poll) abortPollInFlight = undefined;
        },
        () => {
          if (abortPollInFlight === poll) abortPollInFlight = undefined;
        },
      );
      return poll;
    };

    let heartbeat: ClockTimer | undefined;
    let abortPoll: ClockTimer | undefined;

    try {
      await assertLease();
      heartbeat = this.clock.setInterval(() => {
        void assertLease().catch((error) => {
          this.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
      }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
      abortPoll = this.clock.setInterval(() => {
        void pollAbort().catch(() => undefined);
      }, Math.max(100, Math.min(1_000, this.pollMs, Math.floor(this.leaseMs / 3))));
      const handler = this.handlers[job.agentId];
      if (!handler) {
        await this.queue.fail(
          job.id,
          this.workerId,
          `No handler for agent '${job.agentId}'`,
          true,
          undefined,
          job.leaseFence,
        );
        return;
      }

      const result = await handler(job, {
        workerId: this.workerId,
        leaseFence: job.leaseFence,
        signal: executionController.signal,
        assertLease,
        pullCommands,
      });
      executionController.signal.throwIfAborted();
      const postAbort = await pullCommands(["abort"]);
      const latest = await this.queue.getJob(job.id);
      if (postAbort.length > 0 || latest?.abortRequested) {
        await this.queue.cancel(job.id, "abort requested", this.workerId);
        return;
      }
      // Terminal reducers are themselves fenced by the exact lease attempt.
      // Revalidate the cached projection here without extending the lease a
      // second time immediately before its terminal compare-and-swap.
      const sameFence = !job.leaseFence || latest?.leaseFence === job.leaseFence;
      const active = latest?.status === "running" || latest?.status === "leased";
      const unexpired = latest?.leaseUntil === undefined || latest.leaseUntil > this.clock.now();
      if (!latest || latest.leaseOwner !== this.workerId || !sameFence || !active || !unexpired) {
        throw new JobLeaseLostError(job.id);
      }
      if (result.ok) {
        const completed = await this.queue.complete(
          job.id,
          this.workerId,
          result.result,
          job.leaseFence,
        );
        if (completed?.status !== "completed") throw new JobLeaseLostError(job.id);
      } else {
        await this.queue.fail(
          job.id,
          this.workerId,
          result.error ?? "job failed",
          result.noRetry,
          result.result,
          job.leaseFence,
        );
      }
    } catch (err) {
      if (err instanceof JobLeaseLostError || executionController.signal.reason instanceof JobLeaseLostError) {
        // Only the exact fenced attempt may record failure; never cancel a
        // replacement job merely because this obsolete handler was aborted.
        const reason = executionController.signal.reason ?? err;
        await this.queue.fail(job.id, this.workerId, String(reason), undefined, undefined, job.leaseFence);
        return;
      }
      if (executionController.signal.aborted) {
        await this.queue.cancel(job.id, "abort requested", this.workerId);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.queue.fail(job.id, this.workerId, message, undefined, undefined, job.leaseFence);
    } finally {
      leaseTrackingActive = false;
      if (leaseDeadline) this.clock.clearTimeout(leaseDeadline);
      if (heartbeat) this.clock.clearInterval(heartbeat);
      if (abortPoll) this.clock.clearInterval(abortPoll);
    }
  }
}
