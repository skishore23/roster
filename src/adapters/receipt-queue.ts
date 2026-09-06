// ============================================================================
// In-memory/test Queue Adapter - derives queue state from a supplied runtime
// ============================================================================

import { randomUUID } from "node:crypto";

import { systemClock, type Clock } from "../core/clock.js";
import { hashCanonical } from "../core/canonical.js";
import type { Runtime } from "../core/runtime.js";
import type {
  JobQueue,
  QueueCommandRecord,
  QueueJob,
} from "../engine/runtime/job-queue.js";
import type {
  JobCmd,
  JobCommandRecord,
  JobEvent,
  JobLane,
  JobRecord,
  JobState,
  JobStatus,
  QueueCommandType,
} from "../modules/job.js";

export type ReceiptQueue = JobQueue;

type ReceiptQueueOptions = {
  readonly runtime: Runtime<JobCmd, JobEvent, JobState>;
  readonly stream: string;
  readonly clock?: Clock;
  readonly onJobChange?: (jobIds: ReadonlyArray<string>) => Promise<void> | void;
};

const TERMINAL = new Set<JobStatus>(["completed", "failed", "canceled"]);

const lanePriority: Record<JobLane, number> = {
  steer: 0,
  collect: 1,
  follow_up: 2,
};

const commandLane = (command: QueueCommandType): Exclude<JobLane, "collect"> =>
  command === "follow_up" ? "follow_up" : "steer";

const cloneJob = (job: QueueJob): QueueJob => ({
  ...job,
  payload: { ...job.payload },
  result: job.result ? { ...job.result } : undefined,
  commands: job.commands.map((cmd) => ({
    ...cmd,
    payload: cmd.payload ? { ...cmd.payload } : undefined,
  })),
});

const eventId = (timestamp: number): string =>
  `jobevt_${timestamp.toString(36)}_${randomUUID().slice(0, 6)}`;

export const receiptQueue = (opts: ReceiptQueueOptions): JobQueue => {
  if (opts.clock && opts.runtime.clock && opts.clock !== opts.runtime.clock) {
    throw new Error("Receipt queue clock must match its runtime receipt clock");
  }
  const clock = opts.clock ?? opts.runtime.clock ?? systemClock;
  const nowTs = clock.now;
  let lock = Promise.resolve();

  const withLock = async <T>(op: () => Promise<T>): Promise<T> => {
    const next = lock.then(op);
    lock = next.then(() => undefined, () => undefined);
    return next;
  };

  const jobStream = (jobId: string): string => `${opts.stream}/${jobId}`;

  const emitToStream = async (stream: string, event: JobEvent, hint?: string): Promise<void> => {
    await opts.runtime.execute(stream, {
      type: "emit",
      event,
      eventId: hint ?? eventId(nowTs()),
    });
  };

  const emitEvent = async (event: JobEvent): Promise<void> => {
    const marker = eventId(nowTs());
    if ("jobId" in event) {
      await emitToStream(jobStream(event.jobId), event, `${marker}:job`);
    }
    await emitToStream(opts.stream, event, `${marker}:index`);
    if ("jobId" in event) await opts.onJobChange?.([event.jobId]);
  };

  const ensureIndexState = async (): Promise<JobState> => {
    return opts.runtime.state(opts.stream);
  };

  const ensureJobState = async (jobId: string): Promise<JobState> => {
    return opts.runtime.state(jobStream(jobId));
  };

  const jobsMap = async (): Promise<Readonly<Record<string, JobRecord>>> => (await ensureIndexState()).jobs;

  const toCommandRecord = (command: JobCommandRecord): QueueCommandRecord => ({
    id: command.id,
    command: command.command,
    lane: command.lane,
    payload: command.payload ? { ...command.payload } : undefined,
    by: command.by,
    createdAt: command.createdAt,
    consumedAt: command.consumedAt,
    consumedBy: command.consumedBy,
  });

  const toQueueJob = (record: JobRecord): QueueJob => ({
    id: record.id,
    agentId: record.agentId,
    lane: record.lane,
    sessionKey: record.sessionKey,
    singletonMode: record.singletonMode,
    payload: { ...record.payload },
    status: record.status,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    leaseOwner: record.workerId,
    leaseFence: record.attempt > 0 ? String(record.attempt) : undefined,
    leaseUntil: record.leaseUntil,
    lastError: record.lastError,
    result: record.result ? { ...record.result } : undefined,
    canceledReason: record.canceledReason,
    abortRequested: record.abortRequested,
    commands: record.commands.map(toCommandRecord),
  });

  const getQueueJob = async (jobId: string): Promise<QueueJob | undefined> => {
    const record = (await ensureJobState(jobId)).jobs[jobId];
    return record ? toQueueJob(record) : undefined;
  };

  const listAllJobs = async (): Promise<ReadonlyArray<QueueJob>> =>
    Object.values(await jobsMap()).map((job) => toQueueJob(job));

  const handleExpiredLeases = async (timestamp: number): Promise<void> => {
    for (const job of await listAllJobs()) {
      if ((job.status !== "leased" && job.status !== "running") || !job.leaseUntil) continue;
      if (job.leaseUntil > timestamp) continue;
      const retryable = job.attempt < job.maxAttempts;
      await emitEvent({
        type: "job.lease_expired",
        jobId: job.id,
        retryable,
        willRetry: retryable,
      });
    }
  };

  const sortedJobs = (all: ReadonlyArray<QueueJob>): QueueJob[] =>
    [...all].sort((a, b) =>
      lanePriority[a.lane] - lanePriority[b.lane]
      || a.createdAt - b.createdAt
      || a.id.localeCompare(b.id)
    );

  const sortedByRecent = (all: ReadonlyArray<QueueJob>): QueueJob[] =>
    [...all].sort((a, b) =>
      b.updatedAt - a.updatedAt
      || b.createdAt - a.createdAt
      || b.id.localeCompare(a.id)
    );

  const activeBySession = async (sessionKey: string, excludeId?: string): Promise<QueueJob[]> =>
    (await listAllJobs()).filter((job) =>
      job.sessionKey === sessionKey
      && !TERMINAL.has(job.status)
      && job.id !== excludeId
    );

  const requestAbort = async (job: QueueJob, reason: string): Promise<void> => {
    if (job.status === "queued") {
      await emitEvent({
        type: "job.canceled",
        jobId: job.id,
        reason,
      });
      return;
    }
    const ts = nowTs();
    const commandId = `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
    await emitEvent({
      type: "queue.command",
      jobId: job.id,
      commandId,
      command: "abort",
      lane: "steer",
      payload: { reason },
      createdAt: ts,
    });
  };

  const requestSteer = async (job: QueueJob, payload: Record<string, unknown>): Promise<void> => {
    const ts = nowTs();
    const commandId = `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
    await emitEvent({
      type: "queue.command",
      jobId: job.id,
      commandId,
      command: "steer",
      lane: "steer",
      payload,
      createdAt: ts,
    });
  };

  return {
    enqueue: async (input) => withLock(async () => {
      const ts = nowTs();
      const jobId = input.jobId ?? `job_${ts.toString(36)}_${randomUUID().slice(0, 6)}`;
      const existing = await getQueueJob(jobId);
      if (existing) {
        const unchanged = existing.agentId === input.agentId
          && existing.lane === (input.lane ?? "collect")
          && existing.sessionKey === (input.sessionKey?.trim() || undefined)
          && existing.singletonMode === (input.singletonMode ?? "allow")
          && existing.maxAttempts === (input.maxAttempts ?? 2)
          && hashCanonical(existing.payload) === hashCanonical(input.payload);
        if (!unchanged) throw new Error(`Job ${jobId} changed after enqueue`);
        return cloneJob(existing);
      }
      const singletonMode = input.singletonMode ?? "allow";
      const sessionKey = typeof input.sessionKey === "string" && input.sessionKey.trim()
        ? input.sessionKey.trim()
        : undefined;
      if (sessionKey) {
        const active = sortedByRecent(await activeBySession(sessionKey, jobId));
        if (singletonMode === "cancel" && active.length > 0) {
          for (const prior of active) {
            await requestAbort(prior, "singleton cancel");
          }
        } else if (singletonMode === "steer" && active.length > 0) {
          const target = active[0];
          if (target) {
            await requestSteer(target, {
              fromSessionKey: sessionKey,
              fromEnqueue: true,
              payload: input.payload,
            });
            return cloneJob(target);
          }
        } else if (singletonMode === "reject" && active.length > 0) {
          throw new Error(`Session ${sessionKey} already has active job ${active[0]!.id}`);
        }
      }
      const job: QueueJob = {
        id: jobId,
        agentId: input.agentId,
        lane: input.lane ?? "collect",
        sessionKey,
        singletonMode,
        payload: input.payload,
        status: "queued",
        attempt: 0,
        maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 2, 8)),
        createdAt: ts,
        updatedAt: ts,
        commands: [],
      };
      await emitEvent({
        type: "job.enqueued",
        jobId: job.id,
        agentId: job.agentId,
        lane: job.lane,
        payload: job.payload,
        maxAttempts: job.maxAttempts,
        sessionKey: job.sessionKey,
        singletonMode: job.singletonMode,
        createdAt: job.createdAt,
      });
      const created = await getQueueJob(job.id);
      if (!created) throw new Error(`Invariant: missing job ${job.id} after enqueue`);
      return cloneJob(created);
    }),
    findActiveBySession: async (sessionKey, excludeJobId) => {
      const active = sortedByRecent(await activeBySession(sessionKey.trim(), excludeJobId));
      return active[0] ? cloneJob(active[0]) : undefined;
    },

    leaseNext: async (lease) => withLock(async () => {
      const ts = nowTs();
      await handleExpiredLeases(ts);
      const candidates = sortedJobs(
        (await listAllJobs()).filter((job) =>
          job.status === "queued"
          && !job.abortRequested
          && (!lease.agentId || job.agentId === lease.agentId)
        )
      );
      const next = candidates[0];
      if (!next) return undefined;
      const attempt = next.attempt + 1;
      await emitEvent({
        type: "job.leased",
        jobId: next.id,
        workerId: lease.workerId,
        leaseMs: Math.max(1_000, lease.leaseMs),
        attempt,
      });
      return getQueueJob(next.id);
    }),

    heartbeat: async (jobId, workerId, leaseMs, leaseFence) => withLock(async () => {
      await handleExpiredLeases(nowTs());
      const current = await getQueueJob(jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return cloneJob(current);
      if (current.status !== "leased" && current.status !== "running") return undefined;
      if (current.leaseOwner !== workerId) return undefined;
      if (leaseFence && current.leaseFence !== leaseFence) return undefined;
      await emitEvent({
        type: "job.heartbeat",
        jobId,
        workerId,
        leaseMs: Math.max(1_000, leaseMs),
      });
      return getQueueJob(jobId);
    }),

    complete: async (jobId, workerId, result, leaseFence) => withLock(async () => {
      await handleExpiredLeases(nowTs());
      const current = await getQueueJob(jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return cloneJob(current);
      if (current.status !== "leased" && current.status !== "running") return undefined;
      if (current.leaseOwner !== workerId) return undefined;
      if (leaseFence && current.leaseFence !== leaseFence) return undefined;
      await emitEvent({
        type: "job.completed",
        jobId,
        workerId,
        result,
      });
      return getQueueJob(jobId);
    }),

    fail: async (jobId, workerId, error, noRetry, result, leaseFence) => withLock(async () => {
      await handleExpiredLeases(nowTs());
      const current = await getQueueJob(jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return cloneJob(current);
      if (current.status !== "leased" && current.status !== "running") return undefined;
      if (current.leaseOwner !== workerId) return undefined;
      if (leaseFence && current.leaseFence !== leaseFence) return undefined;

      const retryable = current.attempt < current.maxAttempts && !noRetry;
      await emitEvent({
        type: "job.failed",
        jobId,
        workerId,
        error,
        retryable,
        willRetry: retryable,
        result: retryable ? undefined : result,
      });
      return getQueueJob(jobId);
    }),

    cancel: async (jobId, reason, by) => withLock(async () => {
      const current = await getQueueJob(jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return cloneJob(current);
      await emitEvent({
        type: "job.canceled",
        jobId,
        reason,
        by,
      });
      return getQueueJob(jobId);
    }),

    queueCommand: async (input) => withLock(async () => {
      const current = await getQueueJob(input.jobId);
      if (!current) return undefined;
      if (TERMINAL.has(current.status)) return undefined;
      const existing = input.commandId
        ? current.commands.find((command) => command.id === input.commandId)
        : undefined;
      if (existing) {
        if (existing.command !== input.command
          || hashCanonical(existing.payload ?? {}) !== hashCanonical(input.payload ?? {})
          || existing.by !== input.by) {
          throw new Error(`Queue command identity ${input.commandId} was reused with conflicting content`);
        }
        return existing;
      }
      const ts = nowTs();
      const command: QueueCommandRecord = {
        id: input.commandId ?? `cmd_${ts.toString(36)}_${randomUUID().slice(0, 6)}`,
        command: input.command,
        lane: commandLane(input.command),
        payload: input.payload,
        by: input.by,
        createdAt: ts,
      };
      await emitEvent({
        type: "queue.command",
        jobId: input.jobId,
        commandId: command.id,
        command: input.command,
        lane: commandLane(input.command),
        payload: input.payload,
        by: input.by,
        createdAt: ts,
      });
      if (input.command === "abort") {
        if (current.status === "queued") {
          await emitEvent({
            type: "job.canceled",
            jobId: input.jobId,
            reason: "abort requested",
            by: input.by,
          });
        }
      }
      return command;
    }),

    consumeCommands: async (jobId, filter, consumeId) => withLock(async () => {
      const current = await getQueueJob(jobId);
      if (!current) return [];
      const wanted = new Set(filter ?? ["steer", "follow_up", "abort"]);
      const previouslyClaimed = consumeId
        ? current.commands.filter((cmd) => cmd.consumedBy === consumeId && wanted.has(cmd.command))
        : [];
      if (previouslyClaimed.length > 0) return previouslyClaimed;
      const unconsumed = current.commands.filter((cmd) => !cmd.consumedAt && wanted.has(cmd.command));
      if (unconsumed.length === 0) return [];
      const ts = nowTs();
      for (const cmd of unconsumed) {
        await emitEvent({
          type: "queue.command.consumed",
          jobId,
          commandId: cmd.id,
          consumedAt: ts,
          ...(consumeId ? { consumedBy: consumeId } : {}),
        });
      }
      return unconsumed.map((cmd) => ({ ...cmd, consumedAt: ts, ...(consumeId ? { consumedBy: consumeId } : {}) }));
    }),

    getJob: async (jobId) => withLock(async () => {
      const found = await getQueueJob(jobId);
      return found ? cloneJob(found) : undefined;
    }),

    listJobs: async (options) => withLock(async () => {
      const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));
      const values = (await listAllJobs())
        .filter((job) => (options?.status ? job.status === options.status : true))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
      return values.slice(0, limit).map(cloneJob);
    }),

    waitForJob: async (jobId, timeoutMs = 15_000, pollMs = 200) => {
      const end = nowTs() + Math.max(0, timeoutMs);
      while (true) {
        const current = await getQueueJob(jobId);
        if (current && TERMINAL.has(current.status)) return cloneJob(current);
        const remaining = end - nowTs();
        if (remaining <= 0) return current ? cloneJob(current) : undefined;
        await clock.sleep(Math.min(Math.max(20, pollMs), remaining));
      }
    },
  };
};
