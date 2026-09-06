import { hashCanonical } from "../core/canonical.js";
import type { DataReferenceStore } from "../engine/dataflow/data-reference-store.js";
import type {
  JsonValue,
  WorkspaceNode,
} from "../engine/orchestration/types.js";
import type { DataReference } from "../engine/platform/protocol.js";
import {
  nodeContinuityJobId,
  normalizeWorkspaceNodeContinuityPolicy,
  projectNodeContinuitySummary,
  type NodeContinuityControl,
  type NodeContinuityManifest,
  type NodeContinuitySummary,
} from "../engine/workspace/node-continuity.js";
import type {
  EnqueueJobInput,
  JobPayload,
  JobQueue,
  LeaseOptions,
  QueueCommandInput,
  QueueCommandRecord,
  QueueJob,
} from "../engine/runtime/job-queue.js";
import type { JobStatus, QueueCommandType } from "../modules/job.js";
import { nodePrivateMemoryScopeId } from "../engine/runtime/node-memory-plane.js";

export const CODING_CONTINUITY_WAKE_PAYLOAD_VERSION = "roster.coding-continuity-wake.v1" as const;
const NODE_WAKE_JOB_VERSION = "roster.node-wake-job.v1";
const POINTER_MAX_CHARS = 2_000;
const DISPATCH_WAIT_MS = 5_000;

const stableMetadataKeys = [
  "role",
  "specialty",
  "givenName",
  "displayRole",
  "participantKind",
  "group",
  "persistent",
  "displayNameSource",
] as const;

const jsonClone = <Value extends JsonValue>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

const codingContinuityNode = (node: WorkspaceNode): WorkspaceNode => {
  const metadata: Record<string, JsonValue> = {};
  for (const key of stableMetadataKeys) {
    const value = node.metadata?.[key];
    if (value !== undefined) metadata[key] = jsonClone(value);
  }
  return {
    id: node.id,
    name: node.name,
    capabilities: [...new Set(node.capabilities)].sort(),
    runtime: {
      kind: node.runtime.kind,
      ...(node.runtime.profile ? { profile: node.runtime.profile } : {}),
    },
    continuity: normalizeWorkspaceNodeContinuityPolicy(node.continuity),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
};

const parseReference = (value: string): DataReference => {
  const parsed = asRecord(JSON.parse(value), "Coding continuity payload reference");
  if (
    parsed.schemaVersion !== "roster.data-reference.v1"
    || typeof parsed.referenceId !== "string"
    || typeof parsed.contentHash !== "string"
    || typeof parsed.mediaType !== "string"
    || typeof parsed.byteLength !== "number"
    || (parsed.storage !== "artifact" && parsed.storage !== "object")
  ) {
    throw new Error("Coding continuity payload reference is malformed or non-durable");
  }
  return parsed as DataReference;
};

const parseWakeManifest = (payload: JobPayload): NodeContinuityManifest | undefined => {
  if (payload.schemaVersion !== NODE_WAKE_JOB_VERSION) return undefined;
  const manifest = asRecord(payload.manifest, "Coding continuity manifest");
  if (
    manifest.schemaVersion !== "roster.node-continuity-manifest.v1"
    || typeof manifest.manifestId !== "string"
    || typeof manifest.workspaceId !== "string"
    || typeof manifest.nodeId !== "string"
    || !Array.isArray(manifest.inbox)
  ) {
    throw new Error("Coding continuity manifest is malformed");
  }
  return manifest as unknown as NodeContinuityManifest;
};

export type CodingNodeContinuityEnqueueInput = {
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly primaryNodeId: string;
  readonly nodeRevision?: number;
  readonly deliveryId: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly sourceHash: string;
  readonly payload: JobPayload;
  readonly deliveredAt: number;
};

export type UnwrappedCodingNodeWake = {
  readonly job: QueueJob;
  readonly manifest: NodeContinuityManifest;
};

/**
 * Coding activation for framework node continuity. The data-reference body is
 * the ordinary Coding job payload; SpacetimeDB owns delivery, wake scheduling,
 * leases, and terminal continuity settlement.
 */
export class CodingNodeContinuity {
  readonly queue: JobQueue;

  constructor(private readonly options: {
    readonly workspaceId: string;
    readonly control: NodeContinuityControl;
    readonly jobs: JobQueue;
    readonly dataReferences: DataReferenceStore;
    readonly memoryVersion: (scopeId: string) => Promise<string>;
  }) {
    if (options.control.durability !== "durable" || options.dataReferences.durability !== "durable") {
      throw new Error("Coding node continuity requires durable control and data references");
    }
    this.queue = this.projectedQueue();
  }

  async enqueue(input: CodingNodeContinuityEnqueueInput): Promise<QueueJob | undefined> {
    const now = input.deliveredAt;
    const continuous = input.nodes.filter((node) =>
      normalizeWorkspaceNodeContinuityPolicy(node.continuity).mode === "workspace");
    const primary = continuous.find((node) => node.id === input.primaryNodeId);
    if (!primary) throw new Error(`Coding primary node ${input.primaryNodeId} is not workspace-continuous`);
    for (const node of continuous) {
      await this.options.control.register({
        workspaceId: this.options.workspaceId,
        node: codingContinuityNode(node),
        nodeRevision: input.nodeRevision ?? "next-on-change",
        occurredAt: now,
      });
    }
    if (normalizeWorkspaceNodeContinuityPolicy(primary.continuity).memory === "private") {
      const scopeId = nodePrivateMemoryScopeId(this.options.workspaceId, primary.id);
      await this.options.control.updateMemoryFrontier({
        workspaceId: this.options.workspaceId,
        nodeId: primary.id,
        frontier: {
          scopeId,
          snapshotVersion: await this.options.memoryVersion(scopeId),
          updatedAt: now,
        },
        occurredAt: now,
      });
    }
    const retryOfJobId = typeof input.payload.retryOfJobId === "string"
      ? input.payload.retryOfJobId
      : undefined;
    if (retryOfJobId?.startsWith("node_wake_job_")) {
      const state = await this.options.control.snapshot(this.options.workspaceId, primary.id);
      const failedWakeId = state?.lastWakeId;
      if (!failedWakeId || nodeContinuityJobId(failedWakeId) !== retryOfJobId) {
        throw new Error(`Coding retry source ${retryOfJobId} is not the current failed node wake`);
      }
      await this.options.control.resolveFailedWake({
        workspaceId: this.options.workspaceId,
        nodeId: primary.id,
        wakeId: failedWakeId,
        resolution: "superseded",
        occurredAt: now,
      });
    }
    const value = jsonClone(input.payload as unknown as JsonValue);
    const reference = await this.options.dataReferences.put({
      value,
      mediaType: "application/vnd.roster.coding-continuity-wake+json",
      artifactId: `coding_continuity_${hashCanonical(value).slice(0, 28)}`,
      metadata: {
        schemaVersion: CODING_CONTINUITY_WAKE_PAYLOAD_VERSION,
        nodeId: primary.id,
        runId: typeof input.payload.runId === "string" ? input.payload.runId : "",
      },
    });
    const payloadReference = JSON.stringify(reference);
    if (payloadReference.length > POINTER_MAX_CHARS) {
      throw new Error("Coding continuity data reference exceeds the inbox pointer bound");
    }
    const delivered = await this.options.control.deliverAndRequestWake({
      workspaceId: this.options.workspaceId,
      nodeId: primary.id,
      deliveryId: input.deliveryId,
      cause: "direct",
      scope: {
        laneId: typeof input.payload.conversationId === "string"
          ? input.payload.conversationId
          : typeof input.payload.runId === "string" ? input.payload.runId : input.deliveryId,
        ...(typeof input.payload.conversationId === "string" ? { roomId: input.payload.conversationId } : {}),
        ...(typeof input.payload.runId === "string" ? { runId: input.payload.runId } : {}),
      },
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      sourceHash: input.sourceHash,
      payloadReference,
      causalDepth: 0,
      deliveredAt: now,
      wake: {
        requestId: `coding_wake_${hashCanonical({
          deliveryId: input.deliveryId,
          nodeId: primary.id,
          sourceHash: input.sourceHash,
        }).slice(0, 28)}`,
        requestedAt: now,
      },
    });
    if (!delivered.wake.admitted) return undefined;
    if (!delivered.state.activeWake) throw new Error(`Coding node ${primary.id} admitted no continuity wake`);
    const jobId = nodeContinuityJobId(delivered.state.activeWake.wakeId);
    const deadline = Date.now() + DISPATCH_WAIT_MS;
    let job: QueueJob | undefined;
    while (!job && Date.now() < deadline) {
      job = await this.options.jobs.getJob(jobId);
      if (!job) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (!job) throw new Error(`Coding continuity wake ${delivered.state.activeWake.wakeId} was not dispatched`);
    const projected = await this.project(job);
    if (!projected) throw new Error(`Coding continuity job ${job.id} could not be projected`);
    return projected;
  }

  async summaries(nodeIds: ReadonlyArray<string>): Promise<Readonly<Record<string, NodeContinuitySummary>>> {
    const entries = await Promise.all([...new Set(nodeIds)].map(async (nodeId) => {
      const state = await this.options.control.snapshot(this.options.workspaceId, nodeId);
      return state ? [nodeId, projectNodeContinuitySummary(state)] as const : undefined;
    }));
    return Object.freeze(Object.fromEntries(entries.filter((entry) => entry !== undefined)));
  }

  async unwrap(job: QueueJob): Promise<UnwrappedCodingNodeWake | undefined> {
    const manifest = parseWakeManifest(job.payload);
    if (!manifest) return undefined;
    if (manifest.workspaceId !== this.options.workspaceId) {
      throw new Error(`Coding continuity job ${job.id} belongs to another workspace`);
    }
    if (manifest.inbox.length !== 1) {
      throw new Error(`Coding continuity job ${job.id} must bind exactly one Coding delivery`);
    }
    const pointer = manifest.inbox[0]?.payloadReference;
    if (!pointer) throw new Error(`Coding continuity job ${job.id} has no durable payload reference`);
    const payload = asRecord(
      await this.options.dataReferences.read(parseReference(pointer)),
      `Coding continuity job ${job.id} payload`,
    );
    if (
      payload.kind !== "coding-agent.run"
      || payload.primaryNodeId !== manifest.nodeId
      || !Array.isArray(payload.selectedNodeIds)
      || !payload.selectedNodeIds.includes(manifest.nodeId)
    ) {
      throw new Error(`Coding continuity job ${job.id} does not preserve its primary node assignment`);
    }
    return {
      manifest,
      job: Object.freeze({ ...job, payload: payload as JobPayload }),
    };
  }

  private async project(job: QueueJob | undefined): Promise<QueueJob | undefined> {
    if (!job) return undefined;
    return (await this.unwrap(job))?.job ?? job;
  }

  private projectedQueue(): JobQueue {
    const jobs = this.options.jobs;
    return {
      enqueue: (input: EnqueueJobInput) => jobs.enqueue(input),
      ...(jobs.findActiveBySession ? {
        findActiveBySession: async (sessionKey: string, excludeJobId?: string) =>
          this.project(await jobs.findActiveBySession!(sessionKey, excludeJobId)),
      } : {}),
      leaseNext: (options: LeaseOptions) => jobs.leaseNext(options),
      heartbeat: async (jobId, workerId, leaseMs, leaseFence) =>
        this.project(await jobs.heartbeat(jobId, workerId, leaseMs, leaseFence)),
      complete: async (jobId, workerId, result, leaseFence) =>
        this.project(await jobs.complete(jobId, workerId, result, leaseFence)),
      fail: async (jobId, workerId, error, noRetry, result, leaseFence) =>
        this.project(await jobs.fail(jobId, workerId, error, noRetry, result, leaseFence)),
      cancel: async (jobId, reason, by) => this.project(await jobs.cancel(jobId, reason, by)),
      queueCommand: (input: QueueCommandInput) => jobs.queueCommand(input),
      consumeCommands: (
        jobId: string,
        filter?: ReadonlyArray<QueueCommandType>,
        consumeId?: string,
      ): Promise<ReadonlyArray<QueueCommandRecord>> => jobs.consumeCommands(jobId, filter, consumeId),
      getJob: async (jobId: string) => this.project(await jobs.getJob(jobId)),
      listJobs: async (options: { readonly status?: JobStatus; readonly limit?: number } = {}) =>
        Promise.all((await jobs.listJobs(options)).map((job) => this.project(job) as Promise<QueueJob>)),
      waitForJob: async (jobId, timeoutMs, pollMs) =>
        this.project(await jobs.waitForJob(jobId, timeoutMs, pollMs)),
      ...(jobs.waitForAvailable ? {
        waitForAvailable: (timeoutMs?: number) => jobs.waitForAvailable!(timeoutMs),
      } : {}),
    };
  }
}
