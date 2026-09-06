// ============================================================================
// SpacetimeDB Job Queue - reducer-atomic claims, fences, commands, and replay
// ============================================================================

import { randomUUID } from "node:crypto";

import { canonicalize } from "../core/canonical.js";
import type {
  EnqueueJobInput,
  JobQueue,
  LeaseOptions,
  QueueCommandInput,
  QueueCommandRecord,
  QueueJob,
} from "../engine/runtime/job-queue.js";
import type { JobLane, JobStatus, QueueCommandType } from "../modules/job.js";
import type {
  RosterJobCommandProjection,
  RosterJobProjection,
} from "../spacetimedb-bindings/types.js";
import type { SpacetimeControlPlane, SpacetimeSubscription } from "./spacetimedb-control.js";

const TERMINAL = new Set<JobStatus>(["completed", "failed", "canceled"]);
const VALID_STATUSES = new Set<JobStatus>(["queued", "leased", "running", "completed", "failed", "canceled"]);
const VALID_LANES = new Set<JobLane>(["collect", "steer", "follow_up"]);
const VALID_COMMANDS = new Set<QueueCommandType>(["steer", "follow_up", "abort"]);

const timestampMs = (value?: { readonly microsSinceUnixEpoch: bigint }): number | undefined =>
  value ? Number(value.microsSinceUnixEpoch / 1_000n) : undefined;

const parseObject = (json: string, label: string): Record<string, unknown> | undefined => {
  if (!json) return undefined;
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
};

const asStatus = (value: string): JobStatus => {
  if (!VALID_STATUSES.has(value as JobStatus)) throw new Error(`Unknown Roster job status ${value}`);
  return value as JobStatus;
};

const asLane = (value: string): JobLane => {
  if (!VALID_LANES.has(value as JobLane)) throw new Error(`Unknown Roster job lane ${value}`);
  return value as JobLane;
};

const asCommand = (value: string): QueueCommandType => {
  if (!VALID_COMMANDS.has(value as QueueCommandType)) throw new Error(`Unknown Roster job command ${value}`);
  return value as QueueCommandType;
};

export type SpacetimeJobQueueOptions = {
  readonly control: SpacetimeControlPlane;
  readonly workspaceId: string;
};

class SpacetimeJobQueue implements JobQueue {
  private subscription?: SpacetimeSubscription;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: SpacetimeJobQueueOptions) {}

  async initialize(): Promise<void> {
    if (this.subscription) return;
    this.subscription = this.options.control.subscribeRosterJobs(this.options.workspaceId, () => {
      for (const listener of this.listeners) listener();
    });
    await this.subscription.ready;
  }

  close(): void {
    this.subscription?.close();
    this.subscription = undefined;
    this.listeners.clear();
  }

  private snapshot() {
    return this.options.control.jobSnapshot(this.options.workspaceId);
  }

  private row(jobId: string): RosterJobProjection | undefined {
    return this.snapshot().jobs.find((job) => job.id === jobId);
  }

  private commands(jobId: string): ReadonlyArray<RosterJobCommandProjection> {
    return this.snapshot().commands
      .filter((command) => command.jobId === jobId)
      .sort((left, right) => {
        const leftMs = timestampMs(left.createdAt) ?? 0;
        const rightMs = timestampMs(right.createdAt) ?? 0;
        return leftMs - rightMs || left.id.localeCompare(right.id);
      });
  }

  private toCommand(command: RosterJobCommandProjection): QueueCommandRecord {
    return {
      id: command.id,
      command: asCommand(command.command),
      lane: asLane(command.lane) as Exclude<JobLane, "collect">,
      payload: parseObject(command.payloadJson, `command ${command.id} payload`),
      by: command.by || undefined,
      createdAt: timestampMs(command.createdAt) ?? 0,
      consumedAt: timestampMs(command.consumedAt),
      consumedBy: command.consumedBy || undefined,
    };
  }

  private toJob(row: RosterJobProjection): QueueJob {
    const payload = parseObject(row.payloadJson, `job ${row.id} payload`);
    if (!payload) throw new Error(`job ${row.id} is missing its payload`);
    return {
      id: row.id,
      agentId: row.agentId,
      lane: asLane(row.lane),
      sessionKey: row.sessionKey || undefined,
      singletonMode: row.singletonMode as QueueJob["singletonMode"],
      payload,
      status: asStatus(row.status),
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      createdAt: timestampMs(row.createdAt) ?? 0,
      updatedAt: timestampMs(row.updatedAt) ?? 0,
      leaseOwner: row.leaseWorker || undefined,
      leaseFence: row.leaseFence > 0n ? row.leaseFence.toString() : undefined,
      leaseUntil: timestampMs(row.leaseUntil),
      lastError: row.lastError || undefined,
      result: parseObject(row.resultJson, `job ${row.id} result`),
      canceledReason: row.canceledReason || undefined,
      abortRequested: row.abortRequested || undefined,
      commands: this.commands(row.id).map((command) => this.toCommand(command)),
    };
  }

  private async nextChange(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, timeoutMs));
      this.listeners.add(done);
    });
  }

  async enqueue(input: EnqueueJobInput): Promise<QueueJob> {
    const suffix = `${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const jobId = input.jobId ?? `job_${suffix}`;
    const requestId = input.requestId ?? `enqueue_${suffix}`;
    await this.options.control.enqueueRosterJob({
      workspaceId: this.options.workspaceId,
      requestId,
      jobId,
      agentId: input.agentId,
      lane: input.lane ?? "collect",
      sessionKey: input.sessionKey?.trim() ?? "",
      singletonMode: input.singletonMode ?? "allow",
      payloadJson: JSON.stringify(input.payload),
      maxAttempts: Math.max(1, Math.min(input.maxAttempts ?? 2, 8)),
    });
    const request = this.snapshot().requests.find((candidate) => candidate.requestId === requestId);
    const resolvedId = request?.resolvedJobId ?? jobId;
    const row = this.row(resolvedId);
    if (!row) throw new Error(`SpacetimeDB did not project enqueued job ${resolvedId}`);
    return this.toJob(row);
  }

  async findActiveBySession(sessionKey: string, excludeJobId?: string): Promise<QueueJob | undefined> {
    const row = this.snapshot().jobs
      .filter((job) => job.sessionKey === sessionKey
        && job.id !== excludeJobId
        && !TERMINAL.has(asStatus(job.status)))
      .sort((left, right) => {
        const leftMs = timestampMs(left.updatedAt) ?? 0;
        const rightMs = timestampMs(right.updatedAt) ?? 0;
        return rightMs - leftMs || left.id.localeCompare(right.id);
      })[0];
    return row ? this.toJob(row) : undefined;
  }

  async leaseNext(options: LeaseOptions): Promise<QueueJob | undefined> {
    const claimToken = `claim_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await this.options.control.claimNextRosterJob({
      workspaceId: this.options.workspaceId,
      workerId: options.workerId,
      claimToken,
      leaseMs: options.leaseMs,
      agentId: options.agentId ?? "",
    });
    const row = this.snapshot().jobs.find((job) => job.claimToken === claimToken);
    return row ? this.toJob(row) : undefined;
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    leaseMs: number,
    leaseFence?: string
  ): Promise<QueueJob | undefined> {
    const current = this.row(jobId);
    if (!current) return undefined;
    if (TERMINAL.has(asStatus(current.status))) return this.toJob(current);
    if (current.leaseWorker !== workerId) return undefined;
    if (leaseFence && current.leaseFence.toString() !== leaseFence) return undefined;
    await this.options.control.heartbeatRosterJob({
      workspaceId: this.options.workspaceId,
      jobId,
      workerId,
      fence: leaseFence ? BigInt(leaseFence) : current.leaseFence,
      leaseMs,
    });
    const updated = this.row(jobId);
    return updated ? this.toJob(updated) : undefined;
  }

  async complete(
    jobId: string,
    workerId: string,
    result?: Record<string, unknown>,
    leaseFence?: string
  ): Promise<QueueJob | undefined> {
    const current = this.row(jobId);
    if (!current) return undefined;
    if (TERMINAL.has(asStatus(current.status))) return this.toJob(current);
    if (current.leaseWorker !== workerId) return undefined;
    if (leaseFence && current.leaseFence.toString() !== leaseFence) return undefined;
    await this.options.control.completeRosterJob({
      workspaceId: this.options.workspaceId,
      jobId,
      workerId,
      fence: leaseFence ? BigInt(leaseFence) : current.leaseFence,
      resultJson: result ? JSON.stringify(result) : "",
    });
    const updated = this.row(jobId);
    return updated ? this.toJob(updated) : undefined;
  }

  async fail(
    jobId: string,
    workerId: string,
    error: string,
    noRetry?: boolean,
    result?: Record<string, unknown>,
    leaseFence?: string
  ): Promise<QueueJob | undefined> {
    const current = this.row(jobId);
    if (!current) return undefined;
    if (TERMINAL.has(asStatus(current.status))) return this.toJob(current);
    if (current.leaseWorker !== workerId) return undefined;
    if (leaseFence && current.leaseFence.toString() !== leaseFence) return undefined;
    await this.options.control.failRosterJob({
      workspaceId: this.options.workspaceId,
      jobId,
      workerId,
      fence: leaseFence ? BigInt(leaseFence) : current.leaseFence,
      error,
      retryable: !noRetry,
      resultJson: result ? JSON.stringify(result) : "",
    });
    const updated = this.row(jobId);
    return updated ? this.toJob(updated) : undefined;
  }

  async cancel(jobId: string, reason?: string, by?: string): Promise<QueueJob | undefined> {
    if (!this.row(jobId)) return undefined;
    await this.options.control.cancelRosterJob({
      workspaceId: this.options.workspaceId,
      jobId,
      reason: reason ?? "",
      by: by ?? "",
    });
    const updated = this.row(jobId);
    return updated ? this.toJob(updated) : undefined;
  }

  async queueCommand(input: QueueCommandInput): Promise<QueueCommandRecord | undefined> {
    if (!this.row(input.jobId)) return undefined;
    const localId = input.commandId
      ?? `cmd_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await this.options.control.queueRosterJobCommand({
      workspaceId: this.options.workspaceId,
      jobId: input.jobId,
      commandId: localId,
      command: input.command,
      payloadJson: input.payload ? canonicalize(input.payload) : "",
      by: input.by ?? "",
    });
    const command = this.commands(input.jobId).find((candidate) => candidate.id.endsWith(localId));
    return command ? this.toCommand(command) : undefined;
  }

  async consumeCommands(
    jobId: string,
    filter: ReadonlyArray<QueueCommandType> = [],
    requestedConsumeId?: string,
  ): Promise<ReadonlyArray<QueueCommandRecord>> {
    if (!this.row(jobId)) return [];
    const consumeId = requestedConsumeId
      ?? `consume_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await this.options.control.consumeRosterJobCommands({
      workspaceId: this.options.workspaceId,
      jobId,
      consumeId,
      filtersJson: JSON.stringify(filter),
    });
    return this.commands(jobId)
      .filter((command) => command.consumedBy === consumeId)
      .map((command) => this.toCommand(command));
  }

  async getJob(jobId: string): Promise<QueueJob | undefined> {
    const row = this.row(jobId);
    return row ? this.toJob(row) : undefined;
  }

  async listJobs(options: { readonly status?: JobStatus; readonly limit?: number } = {}): Promise<ReadonlyArray<QueueJob>> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
    return this.snapshot().jobs
      .filter((row) => !options.status || row.status === options.status)
      .sort((left, right) => {
        const leftMs = timestampMs(left.updatedAt) ?? 0;
        const rightMs = timestampMs(right.updatedAt) ?? 0;
        return rightMs - leftMs || left.id.localeCompare(right.id);
      })
      .slice(0, limit)
      .map((row) => this.toJob(row));
  }

  async waitForJob(jobId: string, timeoutMs = 30_000, _pollMs = 100): Promise<QueueJob | undefined> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const current = await this.getJob(jobId);
      if (!current || TERMINAL.has(current.status) || Date.now() >= deadline) return current;
      await this.nextChange(Math.min(1_000, Math.max(1, deadline - Date.now())));
    }
  }

  async waitForAvailable(timeoutMs = 5_000): Promise<void> {
    const claimableNow = this.snapshot().jobs.some((job) => (
      job.status === "queued"
      && timestampMs(job.availableAt) !== undefined
      && timestampMs(job.availableAt)! <= Date.now()
    ));
    if (claimableNow) return;
    await this.nextChange(Math.max(1, timeoutMs));
  }
}

export const createSpacetimeJobQueue = async (
  options: SpacetimeJobQueueOptions
): Promise<JobQueue & { readonly close: () => void }> => {
  const queue = new SpacetimeJobQueue(options);
  await queue.initialize();
  return queue;
};
