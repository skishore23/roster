// ============================================================================
// Durable Job Queue Port - storage-neutral worker and orchestration contract
// ============================================================================

import type { JobLane, JobStatus, QueueCommandType } from "../../modules/job.js";

export type QueueCommandRecord = {
  readonly id: string;
  readonly command: QueueCommandType;
  readonly lane: Exclude<JobLane, "collect">;
  readonly payload?: Record<string, unknown>;
  readonly by?: string;
  readonly createdAt: number;
  readonly consumedAt?: number;
  readonly consumedBy?: string;
};

export type JobPayload = Readonly<Record<string, unknown>> & {
  readonly runId?: string;
  readonly runStream?: string;
  readonly stream?: string;
};

export type QueueJob = {
  readonly id: string;
  readonly agentId: string;
  readonly lane: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer" | "reject";
  readonly payload: JobPayload;
  readonly status: JobStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly leaseOwner?: string;
  /** Opaque token identifying this exact lease attempt. */
  readonly leaseFence?: string;
  readonly leaseUntil?: number;
  readonly lastError?: string;
  readonly result?: Record<string, unknown>;
  readonly canceledReason?: string;
  readonly abortRequested?: boolean;
  readonly commands: ReadonlyArray<QueueCommandRecord>;
};

export type EnqueueJobInput = {
  /** Caller-derived identity used to make a durable enqueue retry converge. */
  readonly requestId?: string;
  readonly jobId?: string;
  readonly agentId: string;
  readonly lane?: JobLane;
  readonly sessionKey?: string;
  readonly singletonMode?: "allow" | "cancel" | "steer" | "reject";
  readonly payload: JobPayload;
  readonly maxAttempts?: number;
};

export type LeaseOptions = {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly agentId?: string;
};

export type QueueCommandInput = {
  /** Caller-derived identity for retry convergence. */
  readonly commandId?: string;
  readonly jobId: string;
  readonly command: QueueCommandType;
  readonly payload?: Record<string, unknown>;
  readonly by?: string;
};

export interface JobQueue {
  readonly enqueue: (input: EnqueueJobInput) => Promise<QueueJob>;
  readonly findActiveBySession?: (sessionKey: string, excludeJobId?: string) => Promise<QueueJob | undefined>;
  readonly leaseNext: (opts: LeaseOptions) => Promise<QueueJob | undefined>;
  readonly heartbeat: (
    jobId: string,
    workerId: string,
    leaseMs: number,
    leaseFence?: string
  ) => Promise<QueueJob | undefined>;
  readonly complete: (
    jobId: string,
    workerId: string,
    result?: Record<string, unknown>,
    leaseFence?: string
  ) => Promise<QueueJob | undefined>;
  readonly fail: (
    jobId: string,
    workerId: string,
    error: string,
    noRetry?: boolean,
    result?: Record<string, unknown>,
    leaseFence?: string
  ) => Promise<QueueJob | undefined>;
  readonly cancel: (jobId: string, reason?: string, by?: string) => Promise<QueueJob | undefined>;
  readonly queueCommand: (input: QueueCommandInput) => Promise<QueueCommandRecord | undefined>;
  readonly consumeCommands: (
    jobId: string,
    filter?: ReadonlyArray<QueueCommandType>,
    /** Caller-derived boundary claim identity for retry convergence. */
    consumeId?: string,
  ) => Promise<ReadonlyArray<QueueCommandRecord>>;
  readonly getJob: (jobId: string) => Promise<QueueJob | undefined>;
  readonly listJobs: (opts?: { readonly status?: JobStatus; readonly limit?: number }) => Promise<ReadonlyArray<QueueJob>>;
  readonly waitForJob: (jobId: string, timeoutMs?: number, pollMs?: number) => Promise<QueueJob | undefined>;
  /**
   * Optional subscription-backed wakeup for idle workers. Durable adapters
   * should resolve when queue claimability may have changed; in-memory test
   * adapters may omit it and retain the worker's bounded polling fallback.
   */
  readonly waitForAvailable?: (timeoutMs?: number) => Promise<void>;
}
