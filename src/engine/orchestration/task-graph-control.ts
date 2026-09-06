import { hashCanonical } from "../../core/canonical.js";
import { systemClock, type Clock } from "../../core/clock.js";
import type { DataReference } from "../platform/protocol.js";
import type {
  WorkspaceNode,
  WorkspaceNodeRuntimeBinding,
} from "./types.js";
import type {
  AcceptedTaskOutcome,
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../platform/protocol.js";
import {
  createTaskContextManifest,
  type TaskRepositoryPlacement,
  type TaskContextManifest,
} from "../platform/task-context-manifest.js";
import { createTaskExecutionGrant } from "../platform/execution-grant.js";
import {
  InMemoryTaskGraphStore,
  type TaskGraphExpansion,
  type TaskGraphExpansionInput,
  type TaskGraphLease,
  type TaskGraphQuiescence,
  type TaskGraphSnapshot,
  type TaskGraphTaskRecord,
} from "./task-graph.js";

export type TaskGraphControlInitialization = {
  readonly runId: string;
  readonly policy: RunExecutionPolicy;
  readonly seedTasks: ReadonlyArray<DynamicTaskDefinition>;
  /** Run-owned repository placement persisted before any task can start. */
  readonly repository?: TaskRepositoryPlacement;
  /** Logical topology supplied to durable atomic initializers. */
  readonly nodes?: ReadonlyArray<WorkspaceNode>;
  /** Optional exact initial placement; durable adapters may derive epoch one from nodes. */
  readonly runtimeBindings?: ReadonlyArray<WorkspaceNodeRuntimeBinding>;
};

export type TaskGraphClaimInput = {
  readonly owner: string;
  readonly taskId?: string;
};

export type TaskGraphOutcomeDataReference = {
  readonly taskId: string;
  readonly outcomeId: string;
  readonly artifactId: string;
  readonly outputKey: string;
  readonly reference: DataReference;
};

export type TaskGraphControlSnapshot = TaskGraphSnapshot & {
  readonly runId: string;
  readonly outcomeDataReferences: ReadonlyArray<TaskGraphOutcomeDataReference>;
};

export type TaskGraphAcceptInput = {
  readonly lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">;
  readonly outcome: AcceptedTaskOutcome;
  readonly dataReferences?: ReadonlyArray<{
    readonly artifactId: string;
    readonly reference: DataReference;
    readonly presentationText?: string;
  }>;
};

export type TaskGraphFailInput = {
  readonly lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">;
  readonly error: string;
  readonly retryable?: boolean;
};

export type TaskGraphCancelInput = {
  readonly taskId: string;
  readonly reason: string;
  readonly lease?: Pick<TaskGraphLease, "taskId" | "owner" | "fence">;
};

export type TaskGraphProviderCallDispatch = {
  readonly lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">;
  readonly provider: string;
  readonly model: string;
  readonly reservedTokens: number;
};

/**
 * Storage-neutral authority for one dynamic task-graph execution.
 *
 * Implementations must serialize each transition, enforce lease fences, and
 * make initialize idempotent only for the exact same run, policy, and seeds.
 * Runtime adapters never implement or bypass this contract.
 */
export type TaskGraphControl = {
  /** Whether accepted graph state survives process loss. */
  readonly durability: "process-local" | "durable";
  readonly initialize: (
    input: TaskGraphControlInitialization,
  ) => Promise<TaskGraphControlSnapshot>;
  readonly snapshot: () => Promise<TaskGraphControlSnapshot>;
  readonly enqueue: (definition: DynamicTaskDefinition) => Promise<TaskGraphTaskRecord>;
  readonly claim: (input: TaskGraphClaimInput) => Promise<TaskGraphLease | undefined>;
  readonly start: (
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
    contextManifest: TaskContextManifest,
  ) => Promise<void>;
  /**
   * Optional durable provider reservation boundary. Implementations that
   * reserve estimated model cost at claim flip it immediately before dispatch.
   */
  readonly markProviderCallDispatched?: (
    input: TaskGraphProviderCallDispatch,
  ) => Promise<void>;
  /** Persist a monotonic replacement placement before publishing work that uses it. */
  readonly bindRuntime?: (
    binding: WorkspaceNodeRuntimeBinding,
  ) => Promise<void>;
  readonly heartbeat: (
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
  ) => Promise<void>;
  readonly expand: (input: TaskGraphExpansionInput) => Promise<TaskGraphExpansion>;
  readonly accept: (input: TaskGraphAcceptInput) => Promise<AcceptedTaskOutcome>;
  readonly fail: (input: TaskGraphFailInput) => Promise<void>;
  readonly cancel: (input: TaskGraphCancelInput) => Promise<void>;
};

const terminalStatuses = new Set<TaskGraphTaskRecord["status"]>([
  "accepted",
  "failed",
  "canceled",
  "skipped",
]);

export const taskGraphQuiescence = (
  snapshot: Pick<TaskGraphControlSnapshot, "tasks">,
): TaskGraphQuiescence => {
  const statuses = snapshot.tasks.map((record) => record.status);
  const ready = statuses.filter((status) => status === "ready").length;
  const inflight = statuses.filter((status) => status === "leased" || status === "running").length;
  const waiting = statuses.filter((status) => status === "waiting").length;
  const blocked = statuses.filter((status) => status === "pending").length;
  const terminal = statuses.filter((status) => terminalStatuses.has(status)).length;
  const scheduled = snapshot.tasks.filter((record) => record.status === "pending" && record.retryAt !== undefined).length;
  const actionable = ready + inflight + scheduled;
  return {
    quiescent: actionable === 0,
    deadlocked: actionable === 0 && terminal < statuses.length,
    ready,
    inflight,
    waiting,
    blocked,
    terminal,
    total: statuses.length,
  };
};

export const taskGraphTask = (
  snapshot: Pick<TaskGraphControlSnapshot, "tasks">,
  taskId: string,
): TaskGraphTaskRecord | undefined =>
  snapshot.tasks.find((record) => record.definition.taskId === taskId);

/**
 * Resolve the exact continuation that currently represents a delegated task.
 * The original task remains visible for provenance, while consumers receive
 * the accepted continuation outcome and references as its effective handoff.
 */
export const taskGraphEffectiveTask = (
  snapshot: Pick<TaskGraphControlSnapshot, "tasks">,
  taskId: string,
): TaskGraphTaskRecord | undefined => {
  const seen = new Set<string>();
  let currentTaskId = taskId;
  while (true) {
    if (seen.has(currentTaskId)) {
      throw new Error(`Task continuation chain contains a cycle at ${currentTaskId}`);
    }
    seen.add(currentTaskId);
    const record = taskGraphTask(snapshot, currentTaskId);
    if (!record?.continuationTaskId) return record;
    currentTaskId = record.continuationTaskId;
  }
};

export const taskGraphReady = (
  snapshot: Pick<TaskGraphControlSnapshot, "tasks">,
): ReadonlyArray<DynamicTaskDefinition> =>
  snapshot.tasks
    .filter((record) => record.status === "ready")
    .map((record) => record.definition)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));

export const taskGraphDependencyDataReferences = (
  snapshot: Pick<TaskGraphControlSnapshot, "tasks" | "outcomeDataReferences">,
  taskId: string,
): ReadonlyArray<TaskGraphOutcomeDataReference> => {
  const effectiveTaskId = taskGraphEffectiveTask(snapshot, taskId)?.definition.taskId ?? taskId;
  return snapshot.outcomeDataReferences.filter((entry) => entry.taskId === effectiveTaskId);
};

const cloneDataReference = (entry: TaskGraphOutcomeDataReference): TaskGraphOutcomeDataReference => ({
  ...entry,
  reference: {
    ...entry.reference,
    ...(entry.reference.metadata ? { metadata: { ...entry.reference.metadata } } : {}),
  },
});

/**
 * Process-local conformance implementation. The wrapped store remains private:
 * callers exercise the same asynchronous contract as durable implementations.
 */
export class InMemoryTaskGraphControl implements TaskGraphControl {
  readonly durability = "process-local" as const;
  private runId?: string;
  private initializationHash?: string;
  private store?: InMemoryTaskGraphStore;
  private readonly outcomeDataReferences = new Map<string, TaskGraphOutcomeDataReference>();

  constructor(private readonly clock: Clock = systemClock) {}

  async initialize(
    input: TaskGraphControlInitialization,
  ): Promise<TaskGraphControlSnapshot> {
    const runId = input.runId.trim();
    if (!runId) throw new Error("Task graph run id must not be blank");
    const initializationHash = hashCanonical({
      runId,
      policy: input.policy,
      seeds: input.seedTasks.map((definition) => ({
        taskId: definition.taskId,
        definitionHash: definition.definitionHash,
      })),
      nodes: input.nodes?.map((node) => node.id).sort() ?? [],
      runtimeBindings: input.runtimeBindings?.map((binding) => ({
        bindingId: binding.bindingId,
        nodeId: binding.nodeId,
        epoch: binding.epoch,
      })).sort((left, right) => left.nodeId.localeCompare(right.nodeId)) ?? [],
      repository: input.repository ?? null,
    });
    if (this.store) {
      if (this.initializationHash !== initializationHash) {
        throw new Error(`Task graph control is already initialized for run ${this.runId}`);
      }
      return this.snapshot();
    }
    this.runId = runId;
    this.initializationHash = initializationHash;
    this.store = new InMemoryTaskGraphStore(input.policy, input.seedTasks, this.clock);
    return this.snapshot();
  }

  async snapshot(): Promise<TaskGraphControlSnapshot> {
    const store = this.requireStore();
    return {
      runId: this.runId!,
      ...store.snapshot(),
      outcomeDataReferences: [...this.outcomeDataReferences.values()]
        .map(cloneDataReference)
        .sort((left, right) =>
          left.taskId.localeCompare(right.taskId)
          || left.outputKey.localeCompare(right.outputKey)
          || left.reference.referenceId.localeCompare(right.reference.referenceId)),
    };
  }

  async enqueue(definition: DynamicTaskDefinition): Promise<TaskGraphTaskRecord> {
    return this.requireStore().enqueue(definition);
  }

  async claim(input: TaskGraphClaimInput): Promise<TaskGraphLease | undefined> {
    const store = this.requireStore();
    if (!input.taskId) return store.leaseNext(input.owner);
    const record = store.task(input.taskId);
    if (record?.status !== "ready") return undefined;
    return store.lease(input.taskId, input.owner);
  }

  async start(
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
    contextManifest?: TaskContextManifest,
  ): Promise<void> {
    const task = this.requireStore().task(lease.taskId);
    if (!task) throw new Error(`Task ${lease.taskId} does not exist`);
    this.requireStore().start(lease, contextManifest ?? createTaskContextManifest({
      runId: this.runId!,
      definition: task.definition,
      attempt: task.attempt,
      fence: task.leaseFence,
      executionGrant: createTaskExecutionGrant({
        runId: this.runId!,
        definition: task.definition,
        attempt: task.attempt,
        fence: task.leaseFence,
        policyVersion: "roster.process-local.default.v1",
        policy: this.requireStore().snapshot().policy,
        allowGraphExpansion: true,
      }),
    }));
  }

  async heartbeat(
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
  ): Promise<void> {
    // The process-local store has no expiring wall-clock lease. Calling start
    // revalidates the owner/fence and is otherwise a no-op for a running task.
    const task = this.requireStore().task(lease.taskId);
    if (!task?.contextManifest) {
      throw new Error(`Task ${lease.taskId} heartbeat requires a persisted context manifest`);
    }
    this.requireStore().start(lease, task.contextManifest);
  }

  async expand(input: TaskGraphExpansionInput): Promise<TaskGraphExpansion> {
    return this.requireStore().expand(input);
  }

  async accept(input: TaskGraphAcceptInput): Promise<AcceptedTaskOutcome> {
    if (input.outcome.runId !== this.runId) {
      throw new Error(
        `Task ${input.lease.taskId} outcome belongs to run ${input.outcome.runId}, not ${this.runId}`,
      );
    }
    const references = input.dataReferences ?? [];
    const artifactById = new Map(input.outcome.artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const seen = new Set<string>();
    const materialized = references.map(({ artifactId, reference }) => {
      const artifact = artifactById.get(artifactId);
      if (!artifact) {
        throw new Error(`Task ${input.lease.taskId} data reference names unknown artifact ${artifactId}`);
      }
      if (seen.has(artifactId)) {
        throw new Error(`Task ${input.lease.taskId} repeats data reference for artifact ${artifactId}`);
      }
      seen.add(artifactId);
      if (
        reference.contentHash !== artifact.contentHash
        || reference.mediaType !== artifact.mediaType
        || reference.byteLength !== artifact.byteLength
      ) {
        throw new Error(`Task ${input.lease.taskId} data reference does not match artifact ${artifactId}`);
      }
      return {
        taskId: input.outcome.taskId,
        outcomeId: input.outcome.outcomeId,
        artifactId,
        outputKey: artifact.outputKey,
        reference,
      } satisfies TaskGraphOutcomeDataReference;
    });
    for (const entry of materialized) {
      const existing = this.outcomeDataReferences.get(`${entry.outcomeId}:${entry.artifactId}`);
      if (existing && hashCanonical(existing) !== hashCanonical(entry)) {
        throw new Error(
          `Task ${input.lease.taskId} data reference for artifact ${entry.artifactId} changed after acceptance`,
        );
      }
    }
    const accepted = this.requireStore().accept(input.lease, input.outcome);
    for (const entry of materialized) {
      const key = `${entry.outcomeId}:${entry.artifactId}`;
      this.outcomeDataReferences.set(key, cloneDataReference(entry));
    }
    return accepted;
  }

  async fail(input: TaskGraphFailInput): Promise<void> {
    this.requireStore().fail(input.lease, input.error, input.retryable);
  }

  async cancel(input: TaskGraphCancelInput): Promise<void> {
    this.requireStore().cancel(input.taskId, input.reason, input.lease);
  }

  private requireStore(): InMemoryTaskGraphStore {
    if (!this.store) throw new Error("Task graph control has not been initialized");
    return this.store;
  }
}
