import { hashCanonical } from "../core/canonical.js";
import type {
  AcceptedTaskOutcome,
  DataReference,
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../engine/platform/protocol.js";
import type {
  TaskGraphAcceptInput,
  TaskGraphCancelInput,
  TaskGraphClaimInput,
  TaskGraphControl,
  TaskGraphControlInitialization,
  TaskGraphControlSnapshot,
  TaskGraphFailInput,
  TaskGraphOutcomeDataReference,
} from "../engine/orchestration/task-graph-control.js";
import type {
  TaskGraphExpansion,
  TaskGraphExpansionInput,
  TaskGraphLease,
  TaskGraphTaskRecord,
  TaskGraphTaskStatus,
} from "../engine/orchestration/task-graph.js";
import {
  createDynamicTaskDefinition,
  taskGraphExpansionHash,
  validateTaskGraphSnapshotExpansions,
} from "../engine/orchestration/task-graph.js";
import type { TaskContextManifest } from "../engine/platform/task-context-manifest.js";
import {
  createWorkspaceNodeRuntimeBinding,
} from "../engine/workspace/node.js";
import type { SpacetimeControlPlane } from "./spacetimedb-control.js";

export type SpacetimeTaskGraphDriver = Pick<
  SpacetimeControlPlane,
  | "acceptRosterTaskOutcome"
  | "bindRosterNodeRuntime"
  | "cancelRosterTask"
  | "claimRosterTask"
  | "enqueueRosterTask"
  | "ensureRosterExecution"
  | "expandAndDelegateRosterTask"
  | "failRosterTask"
  | "heartbeatRosterTask"
  | "initializeRosterExecution"
  | "markRosterModelReservationDispatched"
  | "reserveRosterModelCall"
  | "rosterSnapshot"
  | "startRosterTask"
>;

export type SpacetimeTaskGraphControlOptions = {
  readonly control: SpacetimeTaskGraphDriver;
  readonly workspaceId: string;
  readonly kind: string;
  readonly receiptStreamId?: string;
  readonly leaseMs?: number;
  /** Attach to a run created atomically with a domain resource such as Canvas. */
  readonly existingExecution?: boolean;
  readonly room?: {
    readonly id: string;
    readonly roomKey: string;
    readonly title: string;
  };
};

type ProjectedOutcome = {
  readonly outcomeId: string;
  readonly taskKey: string;
  readonly definitionHash: string;
  readonly outcome: AcceptedTaskOutcome;
  readonly actualCostMicros: string;
  readonly totalTokens: string;
};

type ProjectedExpansion = {
  readonly parentTaskId: string;
  readonly publicationFence: string;
  readonly expansionKey: string;
  readonly expansionSpec: {
    readonly children: ReadonlyArray<DynamicTaskDefinition>;
    readonly continuation: DynamicTaskDefinition;
  };
  readonly childCount: number;
  readonly continuationTaskId: string;
};

const safeNumber = (value: bigint | string | number, label: string): number => {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} exceeds the JavaScript safe-integer bound`);
  }
  return parsed;
};

const policyFromJson = (policyJson: string): RunExecutionPolicy => {
  const raw = JSON.parse(policyJson) as Readonly<Record<string, unknown>>;
  const field = (name: keyof RunExecutionPolicy): number =>
    safeNumber(raw[name] as string | number, `Roster execution policy ${name}`);
  return {
    maxTasks: field("maxTasks"),
    maxDepth: field("maxDepth"),
    maxFanout: field("maxFanout"),
    maxInflight: field("maxInflight"),
    maxReady: field("maxReady"),
    maxBlocked: field("maxBlocked"),
    maxAttempts: field("maxAttempts"),
    maxContextBytes: field("maxContextBytes"),
    maxCostMicros: field("maxCostMicros"),
    maxTokens: field("maxTokens"),
    maxWallTimeMs: field("maxWallTimeMs"),
  };
};

export const spacetimeRosterExecutionPolicy = (
  control: Pick<SpacetimeControlPlane, "rosterSnapshot">,
  runId: string,
): RunExecutionPolicy => {
  const execution = control.rosterSnapshot(runId).executions.find((candidate) =>
    candidate.runId === runId);
  if (!execution) throw new Error(`Spacetime Roster execution ${runId} is not projected`);
  return policyFromJson(execution.policyJson);
};

const statusFor = (
  status: string,
  continuationTerminal: boolean,
): TaskGraphTaskStatus => {
  switch (status) {
    case "ready":
    case "leased":
    case "running":
    case "accepted":
    case "failed":
    case "canceled":
    case "skipped":
      return status;
    case "retry_wait":
    case "blocked":
      return "pending";
    case "delegated":
      return continuationTerminal ? "skipped" : "waiting";
    default:
      throw new Error(`Unsupported Spacetime Roster task status ${status}`);
  }
};

const terminal = (status: string): boolean =>
  ["accepted", "failed", "canceled", "skipped"].includes(status);

/**
 * Durable TaskGraphControl backed entirely by Spacetime projections/reducers.
 * No graph or lease-owner state is cached as replay authority. Spacetime's
 * monotonic fence is the cross-process authority, so an exact reducer
 * operation can be retried by a fresh adapter after a lost response.
 */
export class SpacetimeTaskGraphControl implements TaskGraphControl {
  readonly durability = "durable" as const;
  private runId?: string;
  private initializationHash?: string;
  private readonly leaseMs: number;
  private bindingEpochByNode = new Map<string, number>();
  private roomId?: string;

  constructor(private readonly options: SpacetimeTaskGraphControlOptions) {
    this.leaseMs = options.leaseMs ?? 120_000;
    if (
      !Number.isSafeInteger(this.leaseMs)
      || this.leaseMs < 5_000
      || this.leaseMs > 600_000
    ) {
      throw new Error("Spacetime task graph leaseMs must be between 5000 and 600000");
    }
  }

  async initialize(
    input: TaskGraphControlInitialization,
  ): Promise<TaskGraphControlSnapshot> {
    const initializationHash = hashCanonical({
      runId: input.runId,
      policy: input.policy,
      seeds: input.seedTasks.map((definition) => ({
        taskId: definition.taskId,
        definitionHash: definition.definitionHash,
      })),
      repository: input.repository ?? null,
    });
    if (this.runId) {
      if (this.runId !== input.runId || this.initializationHash !== initializationHash) {
        throw new Error(`Spacetime task graph control is already initialized for run ${this.runId}`);
      }
      return this.snapshot();
    }
    if (this.options.existingExecution) {
      const attachedSnapshot = this.options.control.rosterSnapshot(input.runId);
      const existing = attachedSnapshot.executions.find((candidate) =>
        candidate.runId === input.runId);
      if (!existing) {
        throw new Error(`Spacetime Roster execution ${input.runId} is not projected`);
      }
      if (
        existing.kind !== this.options.kind
        || existing.workspaceId !== this.options.workspaceId
        || hashCanonical(policyFromJson(existing.policyJson)) !== hashCanonical(input.policy)
      ) {
        throw new Error(`Spacetime Roster execution ${input.runId} changed before attachment`);
      }
      for (const binding of attachedSnapshot.runtimeBindings) {
        const epoch = safeNumber(
          binding.epoch,
          `Roster runtime binding ${binding.bindingId} epoch`,
        );
        const currentEpoch = this.bindingEpochByNode.get(binding.nodeId) ?? 0;
        if (epoch > currentEpoch) this.bindingEpochByNode.set(binding.nodeId, epoch);
      }
      for (const definition of input.seedTasks) {
        const projected = attachedSnapshot.tasks.find((task) => task.taskId === definition.taskId);
        if (projected) {
          const persisted = JSON.parse(projected.definitionJson) as DynamicTaskDefinition;
          const rebound = this.withCurrentBindingEpoch(definition);
          if (rebound.definitionHash !== persisted.definitionHash) {
            throw new Error(`Spacetime Roster seed task ${definition.taskId} changed before attachment`);
          }
          continue;
        }
        await this.options.control.enqueueRosterTask({
          runId: input.runId,
          definition: this.withCurrentBindingEpoch(definition),
        });
      }
    } else {
      const nodes = input.nodes;
      if (!nodes?.length) {
        throw new Error("Atomic Spacetime execution initialization requires logical nodes");
      }
      const firstSeed = input.seedTasks[0];
      if (!firstSeed) throw new Error("Atomic Spacetime execution initialization requires seed tasks");
      const topologyVersion = firstSeed.inputs.topologyVersion;
      const runtimeBindings = (input.runtimeBindings ?? nodes.map((node) =>
        createWorkspaceNodeRuntimeBinding({
          nodeId: node.id,
          runtime: node.runtime,
          epoch: 1,
          topologyVersion,
        }))).map((binding) => ({
          ...binding,
          epoch: 1,
          topologyVersion,
        }));
      this.bindingEpochByNode = new Map(runtimeBindings.map((binding) => [
        binding.nodeId,
        binding.epoch,
      ]));
      const seedTasks = input.seedTasks.map((definition) =>
        this.withCurrentBindingEpoch(definition));
      const room = this.options.room ?? {
        id: input.runId,
        roomKey: `${this.options.kind}:${input.runId}`,
        title: `${this.options.kind} ${input.runId}`,
      };
      this.roomId = room.id;
      await this.options.control.initializeRosterExecution({
        workspaceId: this.options.workspaceId,
        runId: input.runId,
        receiptStreamId: this.options.receiptStreamId,
        policy: input.policy,
        room: { ...room, kind: this.options.kind },
        nodes,
        runtimeBindings,
        seedTasks,
        initialContextFrontier: {
          contextVersion: `run_context_${hashCanonical({
            runId: input.runId,
            frontierVersion: firstSeed.inputs.frontierVersion,
            topologyVersion,
            catalogVersion: firstSeed.inputs.catalogVersion,
            repository: input.repository ?? null,
          }).slice(0, 28)}`,
          frontierVersion: firstSeed.inputs.frontierVersion,
          topologyVersion,
          catalogVersion: firstSeed.inputs.catalogVersion,
          bindingVersion: "1",
          repository: input.repository ?? {
            root: null,
            branch: null,
            commit: null,
            worktree: null,
          },
        },
        idempotencyKey: `initialize_${initializationHash.slice(0, 28)}`,
      });
    }
    this.runId = input.runId;
    this.roomId ??= this.options.room?.id;
    this.initializationHash = initializationHash;
    return this.snapshot();
  }

  async snapshot(): Promise<TaskGraphControlSnapshot> {
    const runId = this.requireRunId();
    const projection = this.options.control.rosterSnapshot(runId);
    const execution = projection.executions.find((candidate) => candidate.runId === runId);
    if (!execution) throw new Error(`Spacetime Roster execution ${runId} is not projected`);
    const outcomes = projection.outcomes.map((entry): ProjectedOutcome => ({
      outcomeId: entry.outcomeId,
      taskKey: entry.taskKey,
      definitionHash: entry.definitionHash,
      outcome: JSON.parse(entry.outcomeJson) as AcceptedTaskOutcome,
      actualCostMicros: entry.actualCostMicros.toString(),
      totalTokens: entry.totalTokens.toString(),
    }));
    const outcomeById = new Map(outcomes.map((entry) => [entry.outcomeId, entry.outcome]));
    const expansions = projection.expansions.map((entry): ProjectedExpansion => ({
      parentTaskId: entry.parentTaskId,
      publicationFence: entry.publicationFence.toString(),
      expansionKey: entry.expansionKey,
      expansionSpec: JSON.parse(entry.expansionSpecJson) as ProjectedExpansion["expansionSpec"],
      childCount: entry.childCount,
      continuationTaskId: entry.continuationTaskId,
    }));
    const expansionByParent = new Map(expansions.map((entry) => [entry.parentTaskId, entry]));
    const statusByTask = new Map(projection.tasks.map((task) => [task.taskId, task.status]));
    const tasks = projection.tasks.map((task): TaskGraphTaskRecord => {
      const expansion = expansionByParent.get(task.taskId);
      const continuationTerminal = Boolean(
        expansion && terminal(statusByTask.get(expansion.continuationTaskId) ?? ""),
      );
      const fence = safeNumber(task.leaseFence, `Roster task ${task.taskId} lease fence`);
      const outcome = task.outcomeId ? outcomeById.get(task.outcomeId) : undefined;
      return {
        definition: JSON.parse(task.definitionJson) as DynamicTaskDefinition,
        status: statusFor(task.status, continuationTerminal),
        ...(task.status === "retry_wait" ? { retryAt: Number(task.availableAt.microsSinceUnixEpoch / 1_000n) } : {}),
        attempt: task.attempt,
        leaseFence: fence,
        ...(outcome ? { outcome } : {}),
        ...(task.lastError ? { error: task.lastError } : {}),
        ...(expansion ? { continuationTaskId: expansion.continuationTaskId } : {}),
      };
    }).sort((left, right) =>
      left.definition.taskId.localeCompare(right.definition.taskId));
    const graphExpansions = expansions.map((entry): TaskGraphExpansion => {
      const definitions = [
        ...entry.expansionSpec.children,
        entry.expansionSpec.continuation,
      ];
      return {
        parentTaskId: entry.parentTaskId,
        expansionKey: entry.expansionKey,
        expansionHash: taskGraphExpansionHash({
          parentTaskId: entry.parentTaskId,
          expansionKey: entry.expansionKey,
          definitions,
          continuationTaskId: entry.continuationTaskId,
        }),
        publishedFence: safeNumber(
          entry.publicationFence,
          `Roster expansion ${entry.expansionKey} fence`,
        ),
        childTaskIds: entry.expansionSpec.children
          .map((definition) => definition.taskId)
          .sort(),
        continuationTaskId: entry.continuationTaskId,
      };
    });
    const outcomeDataReferences = projection.outputReferences.map(
      (entry): TaskGraphOutcomeDataReference => ({
        taskId: entry.taskId,
        outcomeId: entry.outcomeId,
        artifactId: entry.artifactId,
        outputKey: entry.outputKey,
        reference: JSON.parse(entry.referenceJson) as DataReference,
      }),
    );
    const snapshot: TaskGraphControlSnapshot = {
      runId,
      policy: policyFromJson(execution.policyJson),
      tasks,
      expansions: graphExpansions,
      acceptedCostMicros: safeNumber(
        execution.spentCostMicros,
        `Roster execution ${runId} spent cost`,
      ),
      acceptedTokens: safeNumber(
        execution.usedTokens,
        `Roster execution ${runId} used tokens`,
      ),
      outcomeDataReferences: outcomeDataReferences.map((entry) => ({
        ...entry,
        reference: JSON.parse(JSON.stringify(entry.reference)) as DataReference,
      })),
    };
    validateTaskGraphSnapshotExpansions(snapshot);
    return snapshot;
  }

  async enqueue(definition: DynamicTaskDefinition): Promise<TaskGraphTaskRecord> {
    const runId = this.requireRunId();
    definition = this.withCurrentBindingEpoch(definition);
    await this.options.control.enqueueRosterTask({ runId, definition });
    const record = (await this.snapshot()).tasks.find((task) =>
      task.definition.taskId === definition.taskId);
    if (!record) throw new Error(`Enqueued Roster task ${definition.taskId} is not projected`);
    return record;
  }

  async claim(input: TaskGraphClaimInput): Promise<TaskGraphLease | undefined> {
    const runId = this.requireRunId();
    const before = this.options.control.rosterSnapshot(runId);
    const taskId = input.taskId ?? before.claimableTasks
      .map((task) => task.taskId)
      .sort()[0];
    if (!taskId) return undefined;
    const candidate = before.tasks.find((task) => task.taskId === taskId);
    if (!candidate || candidate.status !== "ready") return undefined;
    const definition = JSON.parse(candidate.definitionJson) as DynamicTaskDefinition;
    await this.options.control.claimRosterTask({
      runId,
      taskId,
      leaseMs: this.effectiveLeaseMs(definition),
    });
    const claimed = this.options.control.rosterSnapshot(runId).tasks.find((task) =>
      task.taskId === taskId && task.status === "leased");
    if (!claimed) throw new Error(`Claimed Roster task ${taskId} is not projected`);
    const fence = safeNumber(claimed.leaseFence, `Roster task ${taskId} lease fence`);
    return {
      taskId,
      owner: input.owner,
      fence,
      attempt: claimed.attempt,
      definition: JSON.parse(claimed.definitionJson) as DynamicTaskDefinition,
    };
  }

  async start(
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
    contextManifest: TaskContextManifest,
  ): Promise<void> {
    await this.options.control.startRosterTask({
      runId: this.requireRunId(),
      taskId: lease.taskId,
      fence: BigInt(lease.fence),
      contextManifest,
    });
  }

  async markProviderCallDispatched(input: {
    readonly lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">;
    readonly provider: string;
    readonly model: string;
    readonly reservedTokens: number;
  }): Promise<void> {
    const runId = this.requireRunId();
    await this.options.control.reserveRosterModelCall({
      runId,
      taskId: input.lease.taskId,
      fence: BigInt(input.lease.fence),
      provider: input.provider,
      model: input.model,
      reservedTokens: BigInt(input.reservedTokens),
    });
    await this.options.control.markRosterModelReservationDispatched({
      runId,
      taskId: input.lease.taskId,
      fence: BigInt(input.lease.fence),
    });
  }

  async bindRuntime(binding: ReturnType<typeof createWorkspaceNodeRuntimeBinding>): Promise<void> {
    const runId = this.requireRunId();
    const roomId = this.roomId;
    if (!roomId) {
      throw new Error("Spacetime runtime rebinding requires explicit Room OS metadata");
    }
    const currentEpoch = this.bindingEpochByNode.get(binding.nodeId) ?? 1;
    if (binding.epoch < currentEpoch) {
      throw new Error(`Runtime binding ${binding.bindingId} is stale for node ${binding.nodeId}`);
    }
    if (binding.epoch === currentEpoch) return;
    if (binding.epoch !== currentEpoch + 1) {
      throw new Error(
        `Runtime binding epoch for node ${binding.nodeId} must advance from ${currentEpoch} to ${currentEpoch + 1}`,
      );
    }
    await this.options.control.bindRosterNodeRuntime({
      workspaceId: this.options.workspaceId,
      roomId,
      runId,
      binding,
    });
    this.bindingEpochByNode.set(binding.nodeId, binding.epoch);
  }

  async heartbeat(
    lease: Pick<TaskGraphLease, "taskId" | "owner" | "fence">,
  ): Promise<void> {
    const task = (await this.snapshot()).tasks.find((candidate) =>
      candidate.definition.taskId === lease.taskId);
    if (!task) throw new Error(`Roster task ${lease.taskId} is not projected`);
    await this.options.control.heartbeatRosterTask({
      runId: this.requireRunId(),
      taskId: lease.taskId,
      fence: BigInt(lease.fence),
      leaseMs: this.effectiveLeaseMs(task.definition),
    });
  }

  async expand(input: TaskGraphExpansionInput): Promise<TaskGraphExpansion> {
    const definitions = input.definitions.map((definition) =>
      this.withCurrentBindingEpoch(definition));
    const continuation = definitions.find((definition) =>
      definition.taskId === input.continuationTaskId);
    if (!continuation) {
      throw new Error(`Expansion continuation ${input.continuationTaskId} is missing`);
    }
    const children = definitions.filter((definition) =>
      definition.taskId !== input.continuationTaskId);
    await this.options.control.expandAndDelegateRosterTask({
      runId: this.requireRunId(),
      parentTaskId: input.parentTaskId,
      fence: BigInt(input.fence),
      expansionKey: input.expansionKey,
      children,
      continuation,
    });
    return {
      parentTaskId: input.parentTaskId,
      expansionKey: input.expansionKey,
      expansionHash: taskGraphExpansionHash({ ...input, definitions }),
      publishedFence: input.fence,
      childTaskIds: children.map((definition) => definition.taskId).sort(),
      continuationTaskId: input.continuationTaskId,
    };
  }

  async accept(input: TaskGraphAcceptInput): Promise<AcceptedTaskOutcome> {
    const runId = this.requireRunId();
    if (input.outcome.runId !== runId) {
      throw new Error(
        `Task ${input.lease.taskId} outcome belongs to run ${input.outcome.runId}, not ${runId}`,
      );
    }
    await this.options.control.acceptRosterTaskOutcome({
      runId,
      taskId: input.lease.taskId,
      fence: BigInt(input.lease.fence),
      outcome: input.outcome,
      dataReferences: input.dataReferences,
    });
    return input.outcome;
  }

  async fail(input: TaskGraphFailInput): Promise<void> {
    await this.options.control.failRosterTask({
      runId: this.requireRunId(),
      taskId: input.lease.taskId,
      fence: BigInt(input.lease.fence),
      error: input.error,
      retryable: input.retryable ?? true,
    });
  }

  async cancel(input: TaskGraphCancelInput): Promise<void> {
    await this.options.control.cancelRosterTask({
      runId: this.requireRunId(),
      taskId: input.taskId,
      fence: input.lease ? BigInt(input.lease.fence) : undefined,
      reason: input.reason,
    });
  }

  private requireRunId(): string {
    if (!this.runId) throw new Error("Spacetime task graph control has not been initialized");
    return this.runId;
  }

  private effectiveLeaseMs(definition: DynamicTaskDefinition): number {
    const leaseMs = Math.min(this.leaseMs, definition.timeoutMs);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000) {
      throw new Error(`Roster task ${definition.taskId} cannot support the minimum 5000ms lease`);
    }
    return leaseMs;
  }

  private withCurrentBindingEpoch(definition: DynamicTaskDefinition): DynamicTaskDefinition {
    const runtimeBindingEpoch = this.bindingEpochByNode.get(definition.nodeId)
      ?? definition.runtimeBindingEpoch;
    if (runtimeBindingEpoch === definition.runtimeBindingEpoch) return definition;
    return createDynamicTaskDefinition({
      taskId: definition.taskId,
      semanticKey: definition.semanticKey,
      nodeId: definition.nodeId,
      capability: definition.capability,
      objective: definition.objective,
      handler: definition.handler,
      acceptance: definition.acceptance,
      result: definition.result,
      dependencies: definition.dependencies,
      join: definition.join,
      inputs: definition.inputs,
      runtimeBindingEpoch,
      retry: definition.retry,
      timeoutMs: definition.timeoutMs,
      sideEffect: definition.sideEffect,
      estimatedCostMicros: definition.estimatedCostMicros,
      ...(definition.parentTaskId ? { parentTaskId: definition.parentTaskId } : {}),
    });
  }

}
