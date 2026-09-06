import { hashCanonical } from "../core/canonical.js";
import {
  taskGraphProjectedEvent,
  type OrchestrationEvent,
} from "../modules/orchestration.js";
import {
  createRosterRootTask,
  defineRosterPlatform,
  type RosterPlatformExecutionOptions,
} from "../engine/platform/roster-platform.js";
import type { RunExecutionPolicy } from "../engine/platform/protocol.js";
import { taskGraphTask } from "../engine/orchestration/task-graph-control.js";
import type {
  DomainRegistry,
  TaskBinding,
} from "../engine/orchestration/types.js";

export type TheoremTaskExecutionDetails = Readonly<
  Record<string, string | number | boolean>
>;

export type TheoremTaskExecutionControl = {
  readonly checkpoint: (
    boundary: string,
    details?: TheoremTaskExecutionDetails,
  ) => Promise<void>;
  readonly failpoint: (
    boundary: string,
    details?: TheoremTaskExecutionDetails,
  ) => Promise<void>;
};

export type TheoremPlatformTaskRuntime = <Output>(input: {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly phase: string;
  readonly round?: number;
  readonly actor: string;
  readonly index: number;
  readonly run: (control: TheoremTaskExecutionControl) => Promise<Output>;
}) => Promise<Output>;

export type TheoremPlatformPhaseRequest<Input, Output> = {
  readonly phase: string;
  readonly round?: number;
  readonly items: ReadonlyArray<Input>;
  readonly maxParallel: number;
  readonly failureMode?: "fail-fast" | "best-effort";
  readonly minimumSuccesses?: number;
  readonly actor: (item: Input, index: number) => string;
  readonly run: (
    item: Input,
    index: number,
    control: TheoremTaskExecutionControl,
  ) => Promise<Output>;
};

export type TheoremPlatformPhaseRunner = <Input, Output>(
  request: TheoremPlatformPhaseRequest<Input, Output>,
) => Promise<Output[]>;

export type TheoremPlatformPhaseScope = {
  readonly runId: string;
  readonly phase: string;
  readonly round?: number;
  readonly wave: number;
  readonly taskIds: ReadonlyArray<string>;
};

export type TheoremPlatformExecutionPlanes = Pick<
  RosterPlatformExecutionOptions,
  "taskGraph" | "dataReferences" | "createTaskContext"
> & {
  readonly dispose?: () => void | Promise<void>;
};

export type TheoremPlatformExecutionPlaneFactory = (
  scope: TheoremPlatformPhaseScope,
) => TheoremPlatformExecutionPlanes | Promise<TheoremPlatformExecutionPlanes>;

export type TheoremPlatformPhaseRunnerOptions = {
  readonly runId: string;
  readonly registry: () => DomainRegistry;
  readonly topologyVersion: () => string;
  readonly emit: (event: OrchestrationEvent) => Promise<void>;
  readonly resolve: (input: {
    readonly phase: string;
    readonly round?: number;
    readonly actor: string;
    readonly index: number;
  }) => TaskBinding;
  /**
   * Optional runtime for one already-leased native task. It may instrument or
   * fault inner execution but cannot schedule, lease, or accept graph work.
   */
  readonly taskRuntime?: TheoremPlatformTaskRuntime;
  readonly createExecutionPlanes: TheoremPlatformExecutionPlaneFactory;
};

type WorkItem<Input> = {
  readonly item: Input;
  readonly index: number;
  readonly actor: string;
  readonly binding: TaskBinding;
};

const DIRECT_TASK_CONTROL: TheoremTaskExecutionControl = {
  checkpoint: async () => undefined,
  failpoint: async () => undefined,
};

const executeTaskDirect: TheoremPlatformTaskRuntime = (input) =>
  input.run(DIRECT_TASK_CONTROL);

const executionPolicy = (
  taskCount: number,
  maxDepth: number,
): RunExecutionPolicy => ({
  maxTasks: taskCount,
  maxDepth: Math.max(1, maxDepth),
  maxFanout: Math.max(1, taskCount),
  maxInflight: taskCount,
  maxReady: taskCount,
  maxBlocked: taskCount,
  maxAttempts: 1,
  maxContextBytes: 16 * 1_048_576,
  maxCostMicros: 1_000_000_000,
  maxTokens: 100_000_000,
  maxWallTimeMs: 600_000,
});

/**
 * Adapts Theorem's staged, adaptive frontiers to the v3 Roster platform.
 * Each wave is a real bounded TaskGraphControl execution. The optional phase
 * runtime is nested inside already leased tasks and therefore cannot accept,
 * schedule, or otherwise mutate the authoritative graph.
 */
export const createTheoremPlatformPhaseRunner = (
  options: TheoremPlatformPhaseRunnerOptions,
): TheoremPlatformPhaseRunner => {
  const taskOccurrences = new Map<string, number>();
  const taskRuntime = options.taskRuntime ?? executeTaskDirect;
  let delegatedTasks = 0;
  let executionOrdinal = 0;

  return async <Input, Output>(
    request: TheoremPlatformPhaseRequest<Input, Output>,
  ): Promise<Output[]> => {
    if (request.items.length === 0) return [];
    const registry = options.registry();
    const maxParallel = Number.isFinite(request.maxParallel)
      ? Math.max(1, Math.min(
          registry.pack.limits.maxParallel,
          Math.floor(request.maxParallel),
        ))
      : 1;
    const work = request.items.map((item, index): WorkItem<Input> => {
      const actor = request.actor(item, index);
      const resolved = options.resolve({
        phase: request.phase,
        round: request.round,
        actor,
        index,
      });
      const occurrence = (taskOccurrences.get(resolved.taskId) ?? 0) + 1;
      taskOccurrences.set(resolved.taskId, occurrence);
      const binding = occurrence === 1
        ? resolved
        : { ...resolved, taskId: `${resolved.taskId}:attempt-${occurrence}` };
      registry.assertNodeAssignment(binding.nodeId, binding.capability);
      return {
        item,
        index,
        actor,
        binding,
      };
    });
    delegatedTasks += work.length;
    if (delegatedTasks > registry.pack.limits.maxTasks) {
      throw new Error(
        `Domain ${registry.pack.id} exceeded maxTasks=${registry.pack.limits.maxTasks}`,
      );
    }

    const successes = new Map<number, Output>();
    const failures: unknown[] = [];
    for (let offset = 0, wave = 0; offset < work.length; offset += maxParallel, wave += 1) {
      const frontier = work.slice(offset, offset + maxParallel);

      executionOrdinal += 1;
      const graphRunId = `theorem_phase_${hashCanonical({
        runId: options.runId,
        phase: request.phase,
        round: request.round ?? 0,
        wave,
        executionOrdinal,
        taskIds: frontier.map((entry) => entry.binding.taskId),
      }).slice(0, 28)}`;
      const topologyVersion = options.topologyVersion();
      const frontierVersion = `theorem_frontier_${hashCanonical({
        runId: options.runId,
        phase: request.phase,
        round: request.round ?? 0,
        topologyVersion,
        taskIds: frontier.map((entry) => entry.binding.taskId),
      }).slice(0, 28)}`;
      const currentRegistry = options.registry();
      const policy = executionPolicy(frontier.length, currentRegistry.pack.limits.maxDepth);
      const platform = defineRosterPlatform({
        id: `theorem-phase-${hashCanonical({
          runId: options.runId,
          phase: request.phase,
          round: request.round ?? 0,
          wave,
        }).slice(0, 20)}`,
        version: currentRegistry.pack.version,
        policyVersion: currentRegistry.pack.policyVersion,
        coordinatorId: currentRegistry.pack.coordinatorId,
        capabilities: currentRegistry.pack.capabilities,
        nodes: currentRegistry.pack.nodes,
        maxNodes: currentRegistry.pack.limits.maxNodes,
        policy,
      });
      const definitions = frontier.map((entry) => createRosterRootTask({
        taskId: entry.binding.taskId,
        semanticKey: entry.binding.taskId,
        nodeId: entry.binding.nodeId,
        capability: entry.binding.capability,
        objective: entry.binding.objective
          ?? `Execute theorem ${request.phase} work for round ${request.round ?? 0}.`,
        inputs: {
          inputVersions: {
            phase: hashCanonical({
              runId: options.runId,
              phase: request.phase,
              round: request.round ?? 0,
            }),
            actor: hashCanonical(entry.actor),
            ...(entry.binding.inputVersions ?? {}),
          },
          dataReferences: [],
          frontierVersion,
          topologyVersion,
          catalogVersion: `${currentRegistry.pack.id}@${currentRegistry.pack.version}`,
        },
        result: { mode: "none" },
        retry: {
          maxAttempts: 1,
          initialBackoffMs: 1,
          maximumBackoffMs: 1,
        },
        timeoutMs: 600_000,
      }));
      const scope: TheoremPlatformPhaseScope = {
        runId: graphRunId,
        phase: request.phase,
        ...(request.round === undefined ? {} : { round: request.round }),
        wave,
        taskIds: definitions.map((definition) => definition.taskId),
      };
      const planes = await options.createExecutionPlanes(scope);
      const { dispose, ...executionPlanes } = planes;

      try {
        const execution = platform.createExecution({
          runId: graphRunId,
          seedTasks: definitions,
          ...executionPlanes,
          nativeExecute: async ({ definition }) => {
            const entry = frontier.find((candidate) =>
              candidate.binding.taskId === definition.taskId);
            if (!entry) {
              throw new Error(`Theorem platform has no work item for ${definition.taskId}`);
            }
            // Domain receipts emitted by the leased inner task must be fenced
            // against a graph projection that already contains their producer.
            // This remains a read model; the TaskGraphControl lease is the
            // authoritative execution transition.
            await options.emit(taskGraphProjectedEvent(
              graphRunId,
              await execution.snapshot(),
            ));
            const value = await taskRuntime({
              runId: options.runId,
              taskId: definition.taskId,
              nodeId: definition.nodeId,
              phase: request.phase,
              ...(request.round === undefined ? {} : { round: request.round }),
              actor: entry.actor,
              index: entry.index,
              run: (control) => request.run(entry.item, entry.index, control),
            });
            successes.set(entry.index, value);
            return value;
          },
        });
        const quiescence = await execution.dispatchUntilQuiescent();
        if (quiescence.deadlocked) {
          throw new Error(`Theorem phase ${request.phase} deadlocked in the Roster task graph`);
        }
        const snapshot = await execution.snapshot();
        await options.emit(taskGraphProjectedEvent(graphRunId, snapshot));
        for (const entry of frontier) {
          const record = taskGraphTask(snapshot, entry.binding.taskId);
          if (record?.status === "accepted") {
            continue;
          }
          const error = record?.error
            ?? `Theorem task ${entry.binding.taskId} ended as ${record?.status ?? "missing"}`;
          failures.push(new Error(error));
          successes.delete(entry.index);
        }
        if (failures.length > 0 && (request.failureMode ?? "fail-fast") === "fail-fast") {
          throw failures[0];
        }
      } finally {
        await dispose?.();
      }
    }

    const ordered = [...successes.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value);
    const minimumSuccesses = request.failureMode === "best-effort"
      ? Math.max(1, Math.min(request.items.length, Math.floor(request.minimumSuccesses ?? 1)))
      : request.items.length;
    if (failures.length > 0 && ordered.length < minimumSuccesses) {
      throw failures[0] ?? new Error(`Theorem phase ${request.phase} failed`);
    }
    return ordered;
  };
};
