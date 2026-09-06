import { hashCanonical } from "../core/canonical.js";
import { connectSpacetimeControlPlaneFromEnv } from "../adapters/spacetimedb-control.js";
import { SpacetimeTaskGraphControl } from "../adapters/spacetimedb-task-graph-control.js";
import { createFileSystemDataReferenceStore } from "../engine/dataflow/filesystem-data-reference-store.js";
import {
  taskGraphTask,
  type TaskGraphAcceptInput,
  type TaskGraphControl,
} from "../engine/orchestration/task-graph-control.js";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
  type TaskGraphExpansionInput,
} from "../engine/orchestration/task-graph.js";
import type { WorkspaceNode } from "../engine/orchestration/types.js";
import type {
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../engine/platform/protocol.js";
import {
  ROSTER_EXPAND_FUNCTION_ID,
  ROSTER_NODE_TASK_HANDLER,
  defineRosterPlatform,
} from "../engine/platform/roster-platform.js";
import {
  FileSystemSharedWorkspace,
  createTaskGraphWorkspaceContextFactory,
} from "../engine/workspace/filesystem-shared-workspace.js";
import type { RosterTaskContext } from "../engine/workspace/shared-workspace.js";

export type DurableRosterRestartEvidence = {
  readonly reconnected: boolean;
  readonly graphRecovered: boolean;
  readonly valuesRecovered: boolean;
  readonly workspaceRecovered: boolean;
  readonly staleFenceRejected: boolean;
  readonly exactReducerReplay: boolean;
  readonly graphDigest: string;
  readonly executionCounts: Readonly<Record<string, number>>;
};

export type DurableRosterRestartInput = {
  readonly workspaceId: string;
  readonly runId: string;
  readonly directory: string;
  readonly namespace: string;
};

const policy: RunExecutionPolicy = {
  maxTasks: 8,
  maxDepth: 3,
  maxFanout: 3,
  maxInflight: 1,
  maxReady: 8,
  maxBlocked: 8,
  maxAttempts: 3,
  maxContextBytes: 2_000_000,
  maxCostMicros: 1_000_000,
  maxTokens: 1_000_000,
  maxWallTimeMs: 30_000,
};

const coordinator: WorkspaceNode = {
  id: "restart-coordinator",
  name: "Restart coordinator",
  capabilities: ["coordinate", "compose"],
  runtime: { kind: "roster-native", profile: "restart-verification.coordinator" },
};

const worker: WorkspaceNode = {
  id: "restart-worker",
  name: "Restart worker",
  parentId: coordinator.id,
  capabilities: ["produce"],
  runtime: { kind: "roster-native", profile: "restart-verification.worker" },
};

const definition = (input: {
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective: string;
  readonly outputKey: string;
  readonly dependencies?: DynamicTaskDefinition["dependencies"];
  readonly parentTaskId?: string;
}): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId: input.taskId,
  semanticKey: `restart-verification:${input.taskId}`,
  nodeId: input.nodeId,
  capability: input.capability,
  objective: input.objective,
  handler: ROSTER_NODE_TASK_HANDLER,
  acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
  result: { mode: "text", outputKey: input.outputKey },
  dependencies: input.dependencies ?? [],
  join: { kind: "all-success" },
  inputs: {
    inputVersions: { objective: hashCanonical(input.objective) },
    dataReferences: [],
    frontierVersion: "restart-verification.frontier.v1",
    topologyVersion: "restart-verification.topology.v1",
    catalogVersion: "restart-verification.catalog.v1",
  },
  runtimeBindingEpoch: 0,
  retry: { maxAttempts: 3, initialBackoffMs: 0, maximumBackoffMs: 0 },
  timeoutMs: 10_000,
  sideEffect: "idempotent",
  estimatedCostMicros: 1,
  ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
});

const root = definition({
  taskId: "root",
  nodeId: coordinator.id,
  capability: "coordinate",
  objective: "Discover and delegate durable work.",
  outputKey: "root",
});

const produce = definition({
  taskId: "produce",
  nodeId: worker.id,
  capability: "produce",
  objective: "Publish a durable finding and a large immutable result.",
  outputKey: "produced",
  parentTaskId: root.taskId,
});

const compose = definition({
  taskId: "compose",
  nodeId: coordinator.id,
  capability: "compose",
  objective: "Recover and compose the durable worker outputs.",
  outputKey: "composed",
  dependencies: [{ taskId: produce.taskId, condition: "accepted" }],
  parentTaskId: root.taskId,
});

const platform = defineRosterPlatform({
  id: "restart-verification",
  version: "3",
  policyVersion: "restart-verification.v3",
  coordinatorId: coordinator.id,
  capabilities: [
    { id: "coordinate", description: "Delegate a bounded dynamic DAG." },
    { id: "produce", description: "Publish a durable partial result." },
    { id: "compose", description: "Compose recovered durable state." },
  ],
  nodes: [coordinator, worker],
  maxNodes: 2,
  policy,
  access: (node) => node.id === worker.id
    ? { allowedEffects: ["read", "write"] }
    : {
        functionGrants: [ROSTER_EXPAND_FUNCTION_ID],
        scopes: ["roster:graph:expand"],
        allowedEffects: ["read", "write"],
      },
  workspaceOperations: (node) => node.id === worker.id
    ? ["read", "publish"]
    : ["read"],
});

const interruptAfterProduceAcceptance = (
  inner: TaskGraphControl,
  capture: (input: TaskGraphAcceptInput) => void,
  captureExpansion: (input: TaskGraphExpansionInput) => void,
): TaskGraphControl => {
  let interrupted = false;
  return {
    durability: inner.durability,
    initialize: (input) => inner.initialize(input),
    snapshot: () => inner.snapshot(),
    enqueue: (input) => inner.enqueue(input),
    claim: (input) => inner.claim(input),
    start: (input, contextManifest) => inner.start(input, contextManifest),
    heartbeat: (input) => inner.heartbeat(input),
    expand: (input) => {
      captureExpansion(input);
      return inner.expand(input);
    },
    accept: async (input) => {
      const accepted = await inner.accept(input);
      if (input.lease.taskId === produce.taskId && !interrupted) {
        interrupted = true;
        capture(input);
        throw new Error("simulated process loss after durable child acceptance");
      }
      return accepted;
    },
    fail: (input) => inner.fail(input),
    cancel: (input) => inner.cancel(input),
  };
};

const increment = (counts: Map<string, number>, taskId: string): void => {
  counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
};

const requireValue = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) throw new Error(message);
  return value;
};

/**
 * Executes the real cross-process recovery boundary used by Roster:
 * SpacetimeTaskGraphControl + immutable filesystem values + filesystem Yjs
 * shared workspace. A committed child acceptance loses its acknowledgement,
 * then a fresh connection and fresh platform instance resume the continuation.
 */
export const verifyDurableRosterRestart = async (
  input: DurableRosterRestartInput,
): Promise<DurableRosterRestartEvidence> => {
  const referenceDirectory = `${input.directory}/references`;
  const workspaceDirectory = `${input.directory}/workspace`;
  const largeValue = `durable-value:${"x".repeat(32 * 1_024)}`;
  const executionCounts = new Map<string, number>();
  let capturedAcceptance: TaskGraphAcceptInput | undefined;
  let capturedExpansion: TaskGraphExpansionInput | undefined;
  let oldProduceContext: RosterTaskContext | undefined;
  let recoveredValue: unknown;
  let recoveredFindings: ReadonlyArray<unknown> = [];
  let firstWorkspace: FileSystemSharedWorkspace | undefined;
  let secondWorkspace: FileSystemSharedWorkspace | undefined;
  let firstSubscription:
    | ReturnType<NonNullable<Awaited<ReturnType<typeof connectSpacetimeControlPlaneFromEnv>>>["subscribeRosterExecution"]>
    | undefined;
  let secondSubscription:
    | ReturnType<NonNullable<Awaited<ReturnType<typeof connectSpacetimeControlPlaneFromEnv>>>["subscribeRosterExecution"]>
    | undefined;
  const firstControl = await connectSpacetimeControlPlaneFromEnv();
  if (!firstControl) throw new Error("SpacetimeDB is disabled for durable Roster restart verification");
  let secondControl: Awaited<ReturnType<typeof connectSpacetimeControlPlaneFromEnv>> | undefined;

  try {
    await firstControl.ensureWorkspace(input.workspaceId, "Roster platform restart verification");
    firstSubscription = firstControl.subscribeRosterExecution(input.runId);
    await firstSubscription.ready;
    const durableGraph = new SpacetimeTaskGraphControl({
      control: firstControl,
      workspaceId: input.workspaceId,
      kind: "platform-restart-verification",
      leaseMs: 5_000,
    });
    const faultingGraph = interruptAfterProduceAcceptance(
      durableGraph,
      (acceptance) => {
        capturedAcceptance = acceptance;
      },
      (expansion) => {
        capturedExpansion = expansion;
      },
    );
    const firstReferences = createFileSystemDataReferenceStore({
      directory: referenceDirectory,
      namespace: input.namespace,
    });
    firstWorkspace = new FileSystemSharedWorkspace({
      directory: workspaceDirectory,
      namespace: input.namespace,
    });
    const firstExecution = platform.createExecution({
      runId: input.runId,
      seedTasks: [root],
      taskGraph: faultingGraph,
      dataReferences: firstReferences,
      createTaskContext: createTaskGraphWorkspaceContextFactory({
        taskGraph: faultingGraph,
        workspace: firstWorkspace,
      }),
      nativeExecute: async (context) => {
        increment(executionCounts, context.definition.taskId);
        if (context.definition.taskId === root.taskId) {
          await context.expand({
            expansionKey: "durable-discovered-work-v1",
            definitions: [produce, compose],
            continuationTaskId: compose.taskId,
          });
          return "delegated";
        }
        if (context.definition.taskId === produce.taskId) {
          oldProduceContext = context.taskContext;
          await context.taskContext.publish({
            kind: "finding",
            mode: "append",
            subjectId: "durable-result",
            body: { claim: "shared context survived process loss" },
            references: [],
          });
          return largeValue;
        }
        throw new Error(`First process unexpectedly executed ${context.definition.taskId}`);
      },
    });

    let interrupted = false;
    let interruptionError: unknown;
    try {
      await firstExecution.dispatchUntilQuiescent();
    } catch (error) {
      interruptionError = error;
      interrupted = error instanceof Error
        && error.message.includes("simulated process loss after durable child acceptance");
    }
    if (!interrupted) {
      const unexpected = await firstExecution.snapshot();
      throw new Error(
        `Durable Roster restart fault was not observed; graph=${unexpected.tasks
          .map((record) => `${record.definition.taskId}:${record.status}:${record.error ?? ""}`)
          .join(",")}`,
        {
        cause: interruptionError,
        },
      );
    }
    await firstWorkspace.flush();
    const beforeRestart = await firstExecution.snapshot();
    const childBefore = requireValue(
      taskGraphTask(beforeRestart, produce.taskId),
      "Durable child was not projected before restart",
    );
    const expansionBefore = requireValue(
      beforeRestart.expansions[0],
      "Durable expansion was not projected before restart",
    );
    const referenceBefore = requireValue(
      beforeRestart.outcomeDataReferences.find((entry) => entry.taskId === produce.taskId)?.reference,
      "Durable child reference was not projected before restart",
    );
    if (
      taskGraphTask(beforeRestart, root.taskId)?.status !== "waiting"
      || childBefore.status !== "accepted"
      || taskGraphTask(beforeRestart, compose.taskId)?.status !== "ready"
    ) {
      throw new Error("Durable graph did not reach the expected interrupted frontier");
    }

    const staleContext = requireValue(
      oldProduceContext,
      "Durable child task context was not captured",
    );
    let staleFenceRejected = false;
    try {
      await staleContext.publish({
        kind: "finding",
        mode: "append",
        subjectId: "stale-publication",
        body: { claim: "must be rejected" },
        references: [],
      });
    } catch {
      staleFenceRejected = true;
    }

    firstWorkspace.close();
    firstWorkspace = undefined;
    firstSubscription.close();
    firstSubscription = undefined;
    firstControl.disconnect();

    secondControl = await connectSpacetimeControlPlaneFromEnv();
    if (!secondControl) throw new Error("SpacetimeDB reconnect was disabled");
    secondSubscription = secondControl.subscribeRosterExecution(input.runId);
    await secondSubscription.ready;
    const recoveredGraph = new SpacetimeTaskGraphControl({
      control: secondControl,
      workspaceId: input.workspaceId,
      kind: "platform-restart-verification",
      leaseMs: 5_000,
      existingExecution: true,
    });
    const recoveredReferences = createFileSystemDataReferenceStore({
      directory: referenceDirectory,
      namespace: input.namespace,
    });
    secondWorkspace = new FileSystemSharedWorkspace({
      directory: workspaceDirectory,
      namespace: input.namespace,
    });
    const secondExecution = platform.createExecution({
      runId: input.runId,
      seedTasks: [root],
      taskGraph: recoveredGraph,
      dataReferences: recoveredReferences,
      createTaskContext: createTaskGraphWorkspaceContextFactory({
        taskGraph: recoveredGraph,
        workspace: secondWorkspace,
      }),
      nativeExecute: async (context) => {
        increment(executionCounts, context.definition.taskId);
        if (context.definition.taskId !== compose.taskId) {
          throw new Error(`Recovered process unexpectedly executed ${context.definition.taskId}`);
        }
        const reference = requireValue(
          context.dependencyDataReferences[produce.taskId]?.[0]?.reference,
          "Recovered continuation has no durable child reference",
        );
        recoveredValue = await context.readDataReference(reference, {
          signal: context.signal,
        });
        const projection = await context.taskContext.readWorkspace({
          subjectIds: ["durable-result"],
        });
        recoveredFindings = projection.value.entries.map((entry) => entry.body);
        return hashCanonical({ recoveredValue, recoveredFindings });
      },
    });

    const quiescence = await secondExecution.dispatchUntilQuiescent();
    await secondWorkspace.flush();
    const recovered = await secondExecution.snapshot();
    const recoveredTaskIds = recovered.tasks
      .map((record) => record.definition.taskId)
      .sort();
    const expectedTaskIds = [root.taskId, produce.taskId, compose.taskId].sort();
    const graphRecovered = (
      !quiescence.deadlocked
      && hashCanonical(recoveredTaskIds) === hashCanonical(expectedTaskIds)
      && taskGraphTask(recovered, root.taskId)?.status === "skipped"
      && taskGraphTask(recovered, produce.taskId)?.status === "accepted"
      && taskGraphTask(recovered, compose.taskId)?.status === "accepted"
      && recovered.expansions.length === 1
      && recovered.expansions[0]?.expansionHash === expansionBefore.expansionHash
      && taskGraphTask(recovered, produce.taskId)?.outcome?.outcomeId
        === childBefore.outcome?.outcomeId
      && taskGraphTask(recovered, produce.taskId)?.attempt === 1
      && executionCounts.get(root.taskId) === 1
      && executionCounts.get(produce.taskId) === 1
      && executionCounts.get(compose.taskId) === 1
      && recovered.tasks.every((record) =>
        record.status !== "failed" && record.status !== "canceled")
    );
    const valuesRecovered = (
      recoveredValue === largeValue
      && await recoveredReferences.read(referenceBefore) === largeValue
      && hashCanonical(
        recovered.outcomeDataReferences.find((entry) =>
          entry.taskId === produce.taskId)?.reference,
      ) === hashCanonical(referenceBefore)
    );
    const workspaceRecovered = hashCanonical(recoveredFindings)
      === hashCanonical([{ claim: "shared context survived process loss" }]);

    await recoveredGraph.accept(requireValue(
      capturedAcceptance,
      "Durable acceptance was not captured",
    ));
    await recoveredGraph.expand(requireValue(
      capturedExpansion,
      "Durable expansion was not captured",
    ));
    const afterReplay = await recoveredGraph.snapshot();
    const exactReducerReplay = (
      afterReplay.expansions.length === 1
      && afterReplay.tasks.length === 3
      && afterReplay.outcomeDataReferences.filter((entry) =>
        entry.taskId === produce.taskId).length === 1
    );

    return {
      reconnected: true,
      graphRecovered,
      valuesRecovered,
      workspaceRecovered,
      staleFenceRejected,
      exactReducerReplay,
      graphDigest: hashCanonical({
        tasks: recovered.tasks.map((record) => ({
          taskId: record.definition.taskId,
          status: record.status,
          attempt: record.attempt,
          definitionHash: record.definition.definitionHash,
          artifactHashes: record.outcome?.artifacts.map((artifact) => artifact.contentHash) ?? [],
        })),
        expansions: recovered.expansions.map((expansion) => ({
          parentTaskId: expansion.parentTaskId,
          expansionKey: expansion.expansionKey,
          expansionHash: expansion.expansionHash,
          childTaskIds: expansion.childTaskIds,
          continuationTaskId: expansion.continuationTaskId,
        })),
        references: recovered.outcomeDataReferences.map((entry) => ({
          taskId: entry.taskId,
          artifactId: entry.artifactId,
          outputKey: entry.outputKey,
          contentHash: entry.reference.contentHash,
          mediaType: entry.reference.mediaType,
          byteLength: entry.reference.byteLength,
        })),
      }),
      executionCounts: Object.fromEntries(
        [...executionCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  } finally {
    await firstWorkspace?.flush().catch(() => undefined);
    await secondWorkspace?.flush().catch(() => undefined);
    firstWorkspace?.close();
    secondWorkspace?.close();
    firstSubscription?.close();
    secondSubscription?.close();
    firstControl.disconnect();
    secondControl?.disconnect();
  }
};
