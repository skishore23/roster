import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "../../src/core/canonical.ts";
import {
  ROSTER_CONSULT_FUNCTION_ID,
  ROSTER_EXPAND_FUNCTION_ID,
  ROSTER_WORKSPACE_PUBLISH_FUNCTION_ID,
  ROSTER_WORKSPACE_READ_FUNCTION_ID,
  createRosterRootTask,
  defineRosterPlatform,
  type RosterPlatformExecutionOptions,
} from "../../src/engine/platform/roster-platform.ts";
import type {
  DataReference,
  RunExecutionPolicy,
} from "../../src/engine/platform/protocol.ts";
import {
  createNodeExecutionSkill,
  NodeRuntimeRegistry,
  type NodeExecutionEnvelope,
  type NodeRuntimeAdapter,
} from "../../src/engine/runtime/node-runtime.ts";
import {
  createCodexCliNodeRuntimeAdapter,
} from "../../src/engine/runtime/agent-cli-node-runtime.ts";
import type {
  CommandExecution,
} from "../../src/engine/runtime/command-node-runtime.ts";
import {
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
  type RosterFunctionActivity,
} from "../../src/engine/runtime/node-function-plane.ts";
import {
  InMemoryDataReferenceStore,
  type DataReferenceStore,
} from "../../src/engine/dataflow/data-reference-store.ts";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
  type TaskGraphControl,
} from "../../src/engine/orchestration/task-graph-control.ts";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  DynamicTaskAcceptanceRegistry,
  createAcceptedTaskOutcome,
  createDefaultDynamicTaskAcceptanceRegistry,
  createDynamicTaskDefinition,
} from "../../src/engine/orchestration/task-graph.ts";
import type {
  NodeExecutionAcceptedArtifactDescriptor,
  NodeExecutionInputManifest,
  NodeExecutionInputReferenceDescriptor,
  NodeExecutionResolvedDataReference,
  NodeExecutionWorkspaceContext,
} from "../../src/sdk/runtime.ts";
import { ROSTER_TRIGGER_DEFINITION_VERSION } from "../../src/engine/triggers/trigger-router.ts";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
} from "../../src/engine/workspace/shared-workspace.ts";

const POLICY: RunExecutionPolicy = {
  maxTasks: 16,
  maxDepth: 4,
  maxFanout: 4,
  maxInflight: 2,
  maxReady: 16,
  maxBlocked: 16,
  maxAttempts: 2,
  maxContextBytes: 1_000_000,
  maxCostMicros: 1_000_000,
  maxTokens: 100_000,
  maxWallTimeMs: 10_000,
};

const executionReferenceLabel = (identity: unknown): string =>
  `reference:${hashCanonical(identity)}`;

const executionPlanes = (
  id: string,
  dataReferences = new InMemoryDataReferenceStore(),
  taskGraph: TaskGraphControl = new InMemoryTaskGraphControl(),
  workspaceAuthority: TaskGraphControl = taskGraph,
): Pick<
  RosterPlatformExecutionOptions,
  "taskGraph" | "dataReferences" | "createTaskContext"
> => {
  const ledger = new SharedWorkspaceLedger(`workspace-${id}`);
  return {
    taskGraph,
    dataReferences,
    createTaskContext: ({ runId, node, definition, lease }) =>
      createRosterTaskContext({
        node,
        ledger,
        fence: {
          runId,
          taskId: definition.taskId,
          nodeId: node.id,
          fence: BigInt(lease.fence),
          frontierVersion: definition.inputs.frontierVersion,
          topologyVersion: definition.inputs.topologyVersion,
          catalogVersion: definition.inputs.catalogVersion,
          runtimeBindingEpoch: definition.runtimeBindingEpoch,
          inputVersions: definition.inputs.inputVersions,
        },
        authority: {
          assertActive: async () => {
            const record = taskGraphTask(await workspaceAuthority.snapshot(), definition.taskId);
            if (
              !record
              || (record.status !== "leased" && record.status !== "running")
              || record.leaseOwner !== lease.owner
              || record.leaseFence !== lease.fence
            ) {
              throw new Error(`Task ${definition.taskId} no longer owns its workspace fence`);
            }
          },
        },
      }),
  };
};

const withoutLeaseOwnerProjection = (
  control: InMemoryTaskGraphControl,
): TaskGraphControl => {
  const redact = async (
    snapshot: Awaited<ReturnType<TaskGraphControl["snapshot"]>>,
  ): Promise<Awaited<ReturnType<TaskGraphControl["snapshot"]>>> => ({
    ...snapshot,
    tasks: snapshot.tasks.map((record) => {
      const clone = { ...record };
      delete clone.leaseOwner;
      return clone;
    }),
  });
  return {
    durability: control.durability,
    initialize: async (input) => redact(await control.initialize(input)),
    snapshot: async () => redact(await control.snapshot()),
    enqueue: (definition) => control.enqueue(definition),
    claim: (input) => control.claim(input),
    start: (lease) => control.start(lease),
    heartbeat: (lease) => control.heartbeat(lease),
    expand: (input) => control.expand(input),
    accept: (input) => control.accept(input),
    fail: (input) => control.fail(input),
    cancel: (input) => control.cancel(input),
  };
};

test("platform acceptance retains provider usage while excluding cached input from the run allowance", async () => {
  const node = {
    id: "measured-worker",
    name: "Measured Worker",
    capabilities: ["coordinate", "implement"],
    runtime: { kind: "measured-runtime" as const },
  };
  const platform = defineRosterPlatform({
    id: "measured-platform",
    version: "1",
    policyVersion: "measured-policy-v1",
    coordinatorId: node.id,
    capabilities: [
      { id: "coordinate", description: "Coordinate one measured task." },
      { id: "implement", description: "Implement one measured change." },
    ],
    nodes: [node],
    policy: POLICY,
  });
  const root = createRosterRootTask({
    taskId: "measured-task",
    semanticKey: "measured:task",
    nodeId: node.id,
    capability: "implement",
    objective: "Return one measured result.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
    result: { mode: "text", outputKey: "result" },
  });
  const execution = platform.createExecution({
    runId: "measured-run",
    seedTasks: [root],
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "measured-runtime",
      executeEnvelope: async (envelope) => ({
        schemaVersion: envelope.schemaVersion,
        status: "completed",
        output: "measured result",
        usage: {
          inputTokens: 120,
          cachedInputTokens: 80,
          outputTokens: 30,
          totalTokens: 150,
          costUsd: 0.42,
          durationMs: 1_234,
        },
      }),
    }]),
    ...executionPlanes("measured-run"),
  });

  await execution.dispatchUntilQuiescent();
  const snapshot = await execution.snapshot();
  assert.deepEqual(taskGraphTask(snapshot, root.taskId)?.outcome?.usage, {
    inputTokens: 120,
    cachedInputTokens: 80,
    outputTokens: 30,
    totalTokens: 150,
    costUsd: 0.42,
    durationMs: 1_234,
  });
  assert.equal(snapshot.acceptedTokens, 70);
});

test("a coordinating model expands the live graph through the platform function plane", async () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "test-runtime" as const },
  };
  const researcher = {
    id: "researcher",
    name: "Researcher",
    capabilities: ["research"],
    runtime: { kind: "test-runtime" as const },
  };
  const platform = defineRosterPlatform({
    id: "research-platform",
    version: "3",
    policyVersion: "research-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [
      { id: "coordinate", description: "Adapt the task graph." },
      { id: "research", description: "Research a bounded question." },
    ],
    nodes: [coordinator, researcher],
    workspaceOperations: () => ["read"],
    policy: POLICY,
    resolveRuntimeBinding: (node, definition) => {
      const epoch = node.id === coordinator.id ? 5 : 7;
      return {
        bindingId: `binding-${node.id}-${epoch}`,
        nodeId: node.id,
        runtime: node.runtime,
        epoch,
        topologyVersion: definition.inputs.topologyVersion,
      };
    },
  });
  const calls: string[] = [];
  const activities: RosterFunctionActivity[] = [];
  let synthesisReferences: ReadonlyArray<{
    readonly source: string;
    readonly label: string;
    readonly contentHash: string;
    readonly mediaType: string;
    readonly byteLength: number;
  }> = [];
  const dataReferences = new InMemoryDataReferenceStore();
  const taskGraphAuthority = new InMemoryTaskGraphControl();
  const taskGraph = withoutLeaseOwnerProjection(taskGraphAuthority);
  const adapter: NodeRuntimeAdapter = {
    kind: "test-runtime",
    executeEnvelope: async (envelope, control) => {
      calls.push(envelope.task.taskId);
      const toolIds = envelope.surface.tools.map((tool) => tool.id);
      assert.ok(toolIds.includes(ROSTER_WORKSPACE_READ_FUNCTION_ID));
      assert.equal(
        toolIds.includes(ROSTER_WORKSPACE_PUBLISH_FUNCTION_ID),
        false,
        "graph expansion authority must not imply workspace publication authority",
      );
      assert.equal(
        envelope.binding?.epoch,
        envelope.node.id === coordinator.id ? 5 : 7,
      );
      if (envelope.task.taskId === "root") {
        assert.ok(toolIds.includes(ROSTER_CATALOG_SEARCH_FUNCTION_ID));
        assert.ok(toolIds.includes(ROSTER_CATALOG_INVOKE_FUNCTION_ID));
        const catalogToolIds = new Set<string>([
          ROSTER_CATALOG_SEARCH_FUNCTION_ID,
          ROSTER_CATALOG_INVOKE_FUNCTION_ID,
          ROSTER_WORKSPACE_READ_FUNCTION_ID,
        ]);
        assert.ok(toolIds.every((toolId) => catalogToolIds.has(toolId)));
        const search = await control.invokeFunction?.({
          functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
          value: { query: "expand" },
        }, {
          executionId: "execution-root",
          runId: envelope.runId,
          nodeId: envelope.node.id,
          taskId: envelope.task.taskId,
          trace: envelope.trace,
          signal: control.signal,
        });
        assert.equal(search?.status, "completed");
        if (search?.status !== "completed") throw new Error("Catalog search did not complete");
        const snapshot = search.output as {
          readonly catalogVersion: string;
          readonly entries: ReadonlyArray<{
            readonly id: string;
            readonly version: string;
            readonly providers: ReadonlyArray<{
              readonly providerId: string;
              readonly epoch: number;
            }>;
          }>;
        };
        const expansion = snapshot.entries.find((entry) => entry.id === ROSTER_EXPAND_FUNCTION_ID);
        assert.ok(expansion, JSON.stringify(snapshot));
        const provider = expansion.providers[0];
        assert.ok(provider);
        const result = await control.invokeFunction?.({
          functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
          value: {
            operation: "call",
            catalogVersion: snapshot.catalogVersion,
            functionId: expansion.id,
            functionVersion: expansion.version,
            providerId: provider.providerId,
            providerEpoch: provider.epoch,
            value: {
              expansionKey: "research-two-angles",
              children: [
                {
                  taskId: "research-architecture",
                  semanticKey: "research:architecture",
                  nodeId: "researcher",
                  capability: "research",
                  objective: "Assess the architecture.",
                },
                {
                  taskId: "research-efficiency",
                  semanticKey: "research:efficiency",
                  nodeId: "researcher",
                  capability: "research",
                  objective: "Assess the efficiency.",
                },
              ],
              continuation: {
                taskId: "synthesize",
                semanticKey: "research:synthesis",
                nodeId: "coordinator",
                capability: "coordinate",
                objective: "Synthesize accepted research.",
                join: { kind: "all-success" },
              },
            },
          },
        }, {
          executionId: "execution-root",
          runId: envelope.runId,
          nodeId: envelope.node.id,
          taskId: envelope.task.taskId,
          trace: envelope.trace,
          signal: control.signal,
        });
        assert.equal(result?.status, "completed");
        return {
          schemaVersion: envelope.schemaVersion,
          status: "completed",
          output: "The task graph was expanded.",
        };
      }
      if (envelope.task.taskId === "synthesize") {
        const input = envelope.input as {
          readonly dependencies: Readonly<Record<string, {
            readonly dataReferences: typeof synthesisReferences;
          }>>;
        };
        synthesisReferences = Object.values(input.dependencies)
          .flatMap((dependency) => dependency.dataReferences);
        assert.deepEqual(synthesisReferences.map(({ source, label, mediaType }) => ({
          source,
          label,
          mediaType,
        })), [
          {
            source: "dependency:research-architecture",
            label: executionReferenceLabel({
              scope: "dependency",
              source: "accepted-task-output",
              taskId: "research-architecture",
              outputKey: "result",
            }),
            mediaType: "text/plain",
          },
          {
            source: "dependency:research-efficiency",
            label: executionReferenceLabel({
              scope: "dependency",
              source: "accepted-task-output",
              taskId: "research-efficiency",
              outputKey: "result",
            }),
            mediaType: "text/plain",
          },
        ]);
        return {
          schemaVersion: envelope.schemaVersion,
          status: "completed",
          output: "Combined accepted findings.",
        };
      }
      return {
        schemaVersion: envelope.schemaVersion,
        status: "completed",
        output: `Natural research from ${envelope.task.taskId}.`,
      };
    },
  };
  const root = createRosterRootTask({
    taskId: "root",
    semanticKey: "research:root",
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: "Research an unknown-complexity topic.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "bootstrap-catalog",
    },
    result: { mode: "none" },
  });
  const execution = platform.createExecution({
    runId: "research-run",
    seedTasks: [root],
    nodeRuntimes: new NodeRuntimeRegistry([adapter]),
    onFunctionActivity: async (activity) => {
      activities.push(activity);
      throw new Error("observational sink unavailable");
    },
    ...executionPlanes(
      "research-run",
      dataReferences,
      taskGraph,
      taskGraphAuthority,
    ),
  });

  const quiescence = await execution.dispatchUntilQuiescent();
  const snapshot = await execution.snapshot();

  assert.equal(quiescence.quiescent, true);
  assert.equal(quiescence.deadlocked, false);
  assert.equal(
    taskGraphTask(snapshot, "root")?.status,
    "skipped",
    JSON.stringify(snapshot.tasks.map((record) => ({
      taskId: record.definition.taskId,
      status: record.status,
      error: record.error,
    }))),
  );
  const taskDiagnostics = JSON.stringify(snapshot.tasks.map((record) => ({
    taskId: record.definition.taskId,
    status: record.status,
    error: record.error,
  })));
  assert.equal(
    taskGraphTask(snapshot, "research-architecture")?.status,
    "accepted",
    taskDiagnostics,
  );
  assert.equal(
    taskGraphTask(snapshot, "research-efficiency")?.status,
    "accepted",
    taskDiagnostics,
  );
  assert.equal(taskGraphTask(snapshot, "synthesize")?.status, "accepted", taskDiagnostics);
  assert.equal(taskGraphTask(snapshot, "root")?.definition.runtimeBindingEpoch, 5);
  assert.equal(taskGraphTask(snapshot, "research-architecture")?.definition.runtimeBindingEpoch, 7);
  assert.equal(taskGraphTask(snapshot, "research-efficiency")?.definition.runtimeBindingEpoch, 7);
  assert.equal(taskGraphTask(snapshot, "synthesize")?.definition.runtimeBindingEpoch, 5);
  assert.equal(taskGraphTask(snapshot, "synthesize")?.outcome?.artifacts[0]?.mediaType, "text/plain");
  assert.equal(snapshot.outcomeDataReferences.length, 3);
  assert.deepEqual(
    synthesisReferences.map(({ contentHash, byteLength }) => ({ contentHash, byteLength })),
    snapshot.outcomeDataReferences
      .filter(({ taskId }) => taskId.startsWith("research-"))
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map(({ reference }) => ({
        contentHash: reference.contentHash,
        byteLength: reference.byteLength,
      })),
  );
  assert.deepEqual(calls, [
    "root",
    "research-architecture",
    "research-efficiency",
    "synthesize",
  ]);
  assert.deepEqual(activities.map((activity) => ({
    operation: activity.operation,
    taskId: activity.taskId,
    functionId: activity.functionId,
    providerEpoch: activity.providerEpoch,
  })), [
    {
      operation: "catalog.search",
      taskId: "root",
      functionId: undefined,
      providerEpoch: undefined,
    },
    {
      operation: "function.call",
      taskId: "root",
      functionId: ROSTER_EXPAND_FUNCTION_ID,
      providerEpoch: 1,
    },
  ]);
});

test("a node consultation materializes peer work and transparently resumes existing downstream tasks", async () => {
  const coordinator = {
    id: "consult-coordinator",
    name: "Consult Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "consult-runtime" as const },
  };
  const architect = {
    id: "consult-architect",
    name: "Architect",
    capabilities: ["propose", "respond"],
    runtime: { kind: "consult-runtime" as const },
  };
  const security = {
    id: "consult-security",
    name: "Security Reviewer",
    capabilities: ["respond"],
    runtime: { kind: "consult-runtime" as const },
  };
  const data = {
    id: "consult-data",
    name: "Data Reviewer",
    capabilities: ["respond"],
    runtime: { kind: "consult-runtime" as const },
  };
  const platform = defineRosterPlatform({
    id: "consult-platform",
    version: "1",
    policyVersion: "consult-policy-v1",
    coordinatorId: coordinator.id,
    capabilities: [
      { id: "coordinate", description: "Finish accepted work." },
      { id: "propose", description: "Propose one bounded change." },
      { id: "respond", description: "Answer one peer question." },
    ],
    nodes: [coordinator, architect, security, data],
    policy: POLICY,
    consultation: {
      maxRecipients: 2,
      canConsult: ({ author, recipient, capability }) =>
        capability === "respond"
        && (
          (author.id === architect.id && recipient.id === security.id)
          || (author.id === security.id && recipient.id === data.id)
        ),
    },
    access: (node) => node.id === coordinator.id
      ? { functionGrants: [], allowedEffects: ["read"] }
      : {
          functionGrants: [ROSTER_CONSULT_FUNCTION_ID],
          scopes: ["roster:node:consult"],
          allowedEffects: ["read", "write"],
        },
  });
  const inputs = {
    inputVersions: { request: "consult-request-v1" },
    dataReferences: [],
    frontierVersion: "consult-frontier-v1",
    topologyVersion: "consult-topology-v1",
    catalogVersion: "consult-catalog-v1",
  };
  const proposal = createRosterRootTask({
    taskId: "architect-proposal",
    semanticKey: "consult:architect-proposal",
    nodeId: architect.id,
    capability: "propose",
    objective: "Propose the authentication boundary.",
    inputs,
    result: { mode: "text", outputKey: "proposal" },
  });
  const finalize = createDynamicTaskDefinition({
    taskId: "consult-finalize",
    semanticKey: "consult:finalize",
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: "Finish after the architect's resumed proposal.",
    handler: { kind: "roster.node", version: "1" },
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: { mode: "text", outputKey: "final" },
    dependencies: [{ taskId: proposal.taskId, condition: "accepted" }],
    join: { kind: "all-success" },
    inputs,
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 30_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });
  const calls: string[] = [];
  let finalDependencyValue: unknown;
  const adapter: NodeRuntimeAdapter = {
    kind: "consult-runtime",
    executeEnvelope: async (envelope, control) => {
      calls.push(`${envelope.node.id}:${envelope.task.taskId}`);
      if (envelope.task.taskId === proposal.taskId) {
        const input = envelope.input as {
          readonly eligiblePeers?: ReadonlyArray<{
            readonly nodeId: string;
            readonly capabilities: ReadonlyArray<string>;
          }>;
        };
        assert.deepEqual(input.eligiblePeers, [{
          nodeId: security.id,
          name: security.name,
          capabilities: ["respond"],
        }]);
        const search = await control.invokeFunction?.({
          functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
          value: { query: "consult" },
        }, {
          executionId: "consult-execution",
          runId: envelope.runId,
          nodeId: envelope.node.id,
          taskId: envelope.task.taskId,
        });
        assert.equal(search?.status, "completed");
        if (search?.status !== "completed") throw new Error("Consultation catalog search failed");
        const catalog = search.output as {
          readonly catalogVersion: string;
          readonly entries: ReadonlyArray<{
            readonly id: string;
            readonly version: string;
            readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
          }>;
        };
        const consult = catalog.entries.find((entry) => entry.id === ROSTER_CONSULT_FUNCTION_ID);
        assert.ok(consult);
        const provider = consult.providers[0];
        assert.ok(provider);
        const consultationInvocation = {
          functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
          value: {
            operation: "call",
            catalogVersion: catalog.catalogVersion,
            functionId: consult.id,
            functionVersion: consult.version,
            providerId: provider.providerId,
            providerEpoch: provider.epoch,
            value: {
              schemaVersion: "roster.node-consultation.v1",
              turnKey: "authentication-boundary",
              question: "Should this endpoint require user-scoped authorization?",
              recipients: [{ nodeId: security.id, capability: "respond" }],
              responseRequirement: "all",
              evidence: ["src/api/routes.ts"],
            },
          },
        } as const;
        const consultationControl = {
          executionId: "consult-execution",
          runId: envelope.runId,
          nodeId: envelope.node.id,
          taskId: envelope.task.taskId,
        } as const;
        const result = await control.invokeFunction?.(consultationInvocation, consultationControl);
        assert.equal(result?.status, "completed");
        const replayed = await control.invokeFunction?.(consultationInvocation, consultationControl);
        assert.deepEqual(replayed, result, "the same accepted consultation must replay exactly");
        return { schemaVersion: envelope.schemaVersion, status: "completed", output: "delegated" };
      }
      if (envelope.node.id === security.id && envelope.task.taskId.startsWith("consult_")) {
        assert.match(envelope.task.objective ?? "", /user-scoped authorization/);
        const input = envelope.input as {
          readonly eligiblePeers?: ReadonlyArray<{ readonly nodeId: string }>;
        };
        assert.deepEqual(input.eligiblePeers?.map(({ nodeId }) => nodeId), [data.id]);
        const search = await control.invokeFunction?.({
          functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
          value: { query: "consult" },
        }, {
          executionId: "nested-consult-execution",
          runId: envelope.runId,
          nodeId: envelope.node.id,
          taskId: envelope.task.taskId,
        });
        assert.equal(search?.status, "completed");
        if (search?.status !== "completed") throw new Error("Nested consultation search failed");
        const catalog = search.output as {
          readonly catalogVersion: string;
          readonly entries: ReadonlyArray<{
            readonly id: string;
            readonly version: string;
            readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
          }>;
        };
        const consult = catalog.entries.find((entry) => entry.id === ROSTER_CONSULT_FUNCTION_ID)!;
        const provider = consult.providers[0]!;
        const result = await control.invokeFunction?.({
          functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
          value: {
            operation: "call",
            catalogVersion: catalog.catalogVersion,
            functionId: consult.id,
            functionVersion: consult.version,
            providerId: provider.providerId,
            providerEpoch: provider.epoch,
            value: {
              schemaVersion: "roster.node-consultation.v1",
              turnKey: "resource-ownership-source",
              question: "Which data boundary proves resource ownership?",
              recipients: [{ nodeId: data.id, capability: "respond" }],
              responseRequirement: "all",
            },
          },
        }, {
          executionId: "nested-consult-execution",
          runId: envelope.runId,
          nodeId: envelope.node.id,
          taskId: envelope.task.taskId,
        });
        assert.equal(result?.status, "completed");
        return { schemaVersion: envelope.schemaVersion, status: "completed", output: "delegated" };
      }
      if (envelope.node.id === data.id) {
        return {
          schemaVersion: envelope.schemaVersion,
          status: "completed",
          output: "Use the caller-scoped ownership row at the data boundary.",
        };
      }
      if (envelope.node.id === security.id && envelope.task.taskId.startsWith("continue_")) {
        const input = envelope.input as {
          readonly dependencies: Readonly<Record<string, {
            readonly resolvedDataReferences?: ReadonlyArray<{ readonly value: unknown }>;
          }>>;
        };
        assert.ok(Object.values(input.dependencies).some((dependency) =>
          dependency.resolvedDataReferences?.some(({ value }) =>
            value === "Use the caller-scoped ownership row at the data boundary.")));
        return {
          schemaVersion: envelope.schemaVersion,
          status: "completed",
          output: "Require user-scoped authorization against the caller-scoped ownership row.",
        };
      }
      if (envelope.node.id === architect.id && envelope.task.taskId.startsWith("continue_")) {
        const input = envelope.input as {
          readonly dependencies: Readonly<Record<string, {
            readonly resolvedDataReferences?: ReadonlyArray<{ readonly value: unknown }>;
          }>>;
        };
        assert.ok(Object.values(input.dependencies).some((dependency) =>
          dependency.resolvedDataReferences?.some(({ value }) =>
            value === "Require user-scoped authorization against the caller-scoped ownership row.")));
        return {
          schemaVersion: envelope.schemaVersion,
          status: "completed",
          output: "Use a user-scoped authorization boundary.",
        };
      }
      const input = envelope.input as {
        readonly dependencies: Readonly<Record<string, {
          readonly resolvedDataReferences?: ReadonlyArray<{ readonly value: unknown }>;
        }>>;
      };
      finalDependencyValue = input.dependencies[proposal.taskId]?.resolvedDataReferences?.[0]?.value;
      return {
        schemaVersion: envelope.schemaVersion,
        status: "completed",
        output: "Consultation accepted.",
      };
    },
  };
  const execution = platform.createExecution({
    runId: "consult-run",
    seedTasks: [proposal, finalize],
    nodeRuntimes: new NodeRuntimeRegistry([adapter]),
    ...executionPlanes("consult-run"),
  });

  const quiescence = await execution.dispatchUntilQuiescent();
  const snapshot = await execution.snapshot();
  assert.equal(quiescence.quiescent, true);
  assert.equal(
    taskGraphTask(snapshot, proposal.taskId)?.status,
    "skipped",
    JSON.stringify(snapshot.tasks.map((record) => ({
      taskId: record.definition.taskId,
      status: record.status,
      error: record.error,
    }))),
  );
  assert.equal(taskGraphTask(snapshot, finalize.taskId)?.status, "accepted");
  assert.equal(finalDependencyValue, "Use a user-scoped authorization boundary.");
  assert.equal(calls.length, 6);
  assert.ok(calls[0]?.endsWith(":architect-proposal"));
  assert.ok(calls[1]?.startsWith(`${security.id}:consult_`));
  assert.ok(calls[2]?.startsWith(`${data.id}:consult_`));
  assert.ok(calls[3]?.startsWith(`${security.id}:continue_`));
  assert.ok(calls[4]?.startsWith(`${architect.id}:continue_`));
  assert.equal(calls[5], `${coordinator.id}:consult-finalize`);
});

test("external model projections deliver verified bodies while keeping locators host-private", async () => {
  const sentinels = {
    rawMetadata: "PRIVATE_RAW_BODY_METADATA_SENTINEL",
    nestedMetadata: "PRIVATE_NESTED_METADATA_SENTINEL",
    signedUri: "PRIVATE_SIGNED_URI_QUERY_SENTINEL",
    referenceId: "private-reference-id-sentinel",
    artifactLocator: "private-artifact-locator-sentinel",
    acceptedArtifactId: "PRIVATE_ACCEPTED_ARTIFACT_ID_SENTINEL",
    producer: "private-producer-sentinel",
  };
  const explicitBodies = {
    a: "hello world",
    b: { safe: "explicit body" },
  } as const;
  const explicitReferences: DataReference[] = [
    {
      schemaVersion: "roster.data-reference.v1",
      referenceId: `${sentinels.referenceId}-b`,
      contentHash: hashCanonical(explicitBodies.b),
      mediaType: "application/json",
      byteLength: Buffer.byteLength(JSON.stringify(explicitBodies.b)),
      storage: "object",
      artifactId: `${sentinels.artifactLocator}-b`,
      uri: `https://private.invalid/b?signature=${sentinels.signedUri}`,
      producerFunctionId: sentinels.producer,
      metadata: {
        rawBody: sentinels.rawMetadata,
        nested: { secret: sentinels.nestedMetadata },
      },
    },
    {
      schemaVersion: "roster.data-reference.v1",
      referenceId: `${sentinels.referenceId}-a`,
      contentHash: hashCanonical(explicitBodies.a),
      mediaType: "text/plain",
      byteLength: 11,
      storage: "object",
      artifactId: `${sentinels.artifactLocator}-a`,
      uri: `https://private.invalid/a?signature=${sentinels.signedUri}`,
      producerFunctionId: sentinels.producer,
      metadata: {
        rawBody: sentinels.rawMetadata,
        nested: { secret: sentinels.nestedMetadata },
      },
    },
  ];
  const backingStore = new InMemoryDataReferenceStore();
  const dataReferences: DataReferenceStore = {
    durability: backingStore.durability,
    put: async (input, control) => {
      const reference = await backingStore.put(input, control);
      if (input.metadata?.taskId !== "private-producer") return reference;
      return {
        ...reference,
        referenceId: sentinels.referenceId,
        storage: "object",
        artifactId: sentinels.artifactLocator,
        uri: `https://private.invalid/dependency?signature=${sentinels.signedUri}`,
        producerFunctionId: sentinels.producer,
        producerFunctionVersion: "private-producer-version",
        metadata: {
          rawBody: sentinels.rawMetadata,
          nested: { secret: sentinels.nestedMetadata },
        },
      };
    },
    read: async (reference, control) => {
      if (reference.contentHash === hashCanonical(explicitBodies.a)) return explicitBodies.a;
      if (reference.contentHash === hashCanonical(explicitBodies.b)) return explicitBodies.b;
      if (reference.referenceId === sentinels.referenceId) return "dependency body";
      return backingStore.read(reference, control);
    },
  };
  const node = {
    id: "private-edge-node",
    name: "Private Edge Node",
    capabilities: ["coordinate", "inspect"],
    runtime: { kind: "codex-cli" as const, command: ["fake-codex"] },
  };
  const platform = defineRosterPlatform({
    id: "private-edge-platform",
    version: "3",
    policyVersion: "private-edge-policy-v3",
    coordinatorId: node.id,
    capabilities: [
      { id: "coordinate", description: "Coordinate safe projections." },
      { id: "inspect", description: "Inspect safe projections." },
    ],
    nodes: [node],
    policy: POLICY,
  });
  const producer = createRosterRootTask({
    taskId: "private-producer",
    semanticKey: "private-edge:producer",
    nodeId: node.id,
    capability: "inspect",
    objective: "Produce one accepted dependency.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  const consumer = createDynamicTaskDefinition({
    taskId: "private-consumer",
    semanticKey: "private-edge:consumer",
    nodeId: node.id,
    capability: "inspect",
    objective: "Inspect explicit and dependency descriptors.",
    handler: { kind: "roster.node", version: "1" },
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: { mode: "text", outputKey: "result" },
    dependencies: [{ taskId: producer.taskId, condition: "accepted" }],
    join: { kind: "all-success" },
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: explicitReferences,
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
    runtimeBindingEpoch: 0,
    retry: {
      maxAttempts: 1,
      initialBackoffMs: 0,
      maximumBackoffMs: 0,
    },
    timeoutMs: 5_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });
  const commandExecutions: CommandExecution[] = [];
  const processLogs: string[] = [];
  const envelopes: NodeExecutionEnvelope[] = [];
  const baseAdapter = createCodexCliNodeRuntimeAdapter({
    runner: async (execution) => {
      commandExecutions.push(execution);
      const taskId = execution.stdin.includes('"taskId":"private-producer"')
        ? "private-producer"
        : "private-consumer";
      const response = taskId === "private-producer" ? "dependency body" : "consumer done";
      const stdout = JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: response },
      });
      processLogs.push(stdout);
      execution.onOutput?.({ stream: "stdout", text: `${stdout}\n` });
      return { exitCode: 0, stdout, stderr: "" };
    },
  });
  const adapter: NodeRuntimeAdapter = {
    ...baseAdapter,
    executeEnvelope: async (envelope, control) => {
      envelopes.push(envelope);
      return baseAdapter.executeEnvelope!(envelope, control);
    },
  };
  const defaultAcceptance = createDefaultDynamicTaskAcceptanceRegistry()
    .resolve(DEFAULT_DYNAMIC_ACCEPTANCE);
  const acceptance = new DynamicTaskAcceptanceRegistry();
  acceptance.register(DEFAULT_DYNAMIC_ACCEPTANCE, async (input) => {
    const outcome = await defaultAcceptance(input);
    if (input.definition.taskId !== producer.taskId) return outcome;
    return createAcceptedTaskOutcome({
      runId: outcome.runId,
      taskId: outcome.taskId,
      nodeId: outcome.nodeId,
      attempt: outcome.attempt,
      definitionHash: outcome.definitionHash,
      inputVersions: outcome.inputVersions,
      frontierVersion: outcome.frontierVersion,
      topologyVersion: outcome.topologyVersion,
      catalogVersion: outcome.catalogVersion,
      acceptancePolicyId: outcome.acceptancePolicyId,
      acceptancePolicyVersion: outcome.acceptancePolicyVersion,
      artifacts: outcome.artifacts.map((artifact) => ({
        ...artifact,
        artifactId: sentinels.acceptedArtifactId,
      })),
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    });
  });
  const execution = platform.createExecution({
    runId: "private-edge-run",
    seedTasks: [producer, consumer],
    nodeRuntimes: new NodeRuntimeRegistry([adapter]),
    acceptance,
    ...executionPlanes("private-edge-run", dataReferences),
  });

  await execution.dispatchUntilQuiescent();
  const snapshot = await execution.snapshot();
  assert.equal(taskGraphTask(snapshot, producer.taskId)?.status, "accepted");
  assert.equal(taskGraphTask(snapshot, consumer.taskId)?.status, "accepted");
  assert.equal(commandExecutions.length, 2);
  const consumerEnvelope = envelopes.find(({ task }) => task.taskId === consumer.taskId);
  assert.ok(consumerEnvelope);
  const modelInput = consumerEnvelope.input as {
    readonly inputs: {
      readonly inputVersions: Readonly<Record<string, string>>;
      readonly dataReferences: ReadonlyArray<Record<string, unknown>>;
      readonly resolvedDataReferences: ReadonlyArray<Record<string, unknown>>;
      readonly frontierVersion: string;
      readonly topologyVersion: string;
      readonly catalogVersion: string;
    };
    readonly dependencies: Readonly<Record<string, {
      readonly artifacts: ReadonlyArray<Record<string, unknown>>;
      readonly dataReferences: ReadonlyArray<Record<string, unknown>>;
      readonly resolvedDataReferences: ReadonlyArray<Record<string, unknown>>;
    }>>;
  };
  const expectedInputReferences = [
    {
      source: "task-input",
      label: executionReferenceLabel({
        scope: "explicit",
        source: "task-input",
        contentHash: hashCanonical(explicitBodies.b),
      }),
      contentHash: hashCanonical(explicitBodies.b),
      mediaType: "application/json",
      byteLength: Buffer.byteLength(JSON.stringify(explicitBodies.b)),
    },
    {
      source: "task-input",
      label: executionReferenceLabel({
        scope: "explicit",
        source: "task-input",
        contentHash: hashCanonical(explicitBodies.a),
      }),
      contentHash: hashCanonical(explicitBodies.a),
      mediaType: "text/plain",
      byteLength: 11,
    },
  ].sort((left, right) => left.label.localeCompare(right.label));
  assert.deepEqual(modelInput.inputs.dataReferences, expectedInputReferences);
  assert.deepEqual(modelInput.inputs.resolvedDataReferences, modelInput.inputs.dataReferences.map(
    (descriptor) => ({
      ...descriptor,
      value: descriptor.contentHash === hashCanonical(explicitBodies.a)
        ? explicitBodies.a
        : explicitBodies.b,
    }),
  ));
  assert.deepEqual(consumerEnvelope.surface.workspace?.inputs, {
    inputVersions: modelInput.inputs.inputVersions,
    dataReferences: modelInput.inputs.dataReferences,
    frontierVersion: modelInput.inputs.frontierVersion,
    topologyVersion: modelInput.inputs.topologyVersion,
    catalogVersion: modelInput.inputs.catalogVersion,
  });
  assert.ok(consumerEnvelope.surface.workspace);
  const dependency = modelInput.dependencies["private-producer"];
  assert.ok(dependency);
  const dependencyReference = snapshot.outcomeDataReferences
    .find(({ taskId }) => taskId === producer.taskId)?.reference;
  assert.ok(dependencyReference);
  const producerOutcome = taskGraphTask(snapshot, producer.taskId)?.outcome;
  const producerArtifact = producerOutcome?.artifacts[0];
  assert.ok(producerArtifact);
  assert.equal(producerArtifact.artifactId, sentinels.acceptedArtifactId);
  assert.equal(dependencyReference.referenceId, sentinels.referenceId);
  assert.equal(dependencyReference.artifactId, sentinels.artifactLocator);
  assert.match(dependencyReference.uri ?? "", new RegExp(sentinels.signedUri, "u"));
  assert.equal(dependencyReference.producerFunctionId, sentinels.producer);
  assert.equal(dependencyReference.metadata?.rawBody, sentinels.rawMetadata);
  assert.deepEqual(dependencyReference.metadata?.nested, {
    secret: sentinels.nestedMetadata,
  });
  assert.deepEqual(dependency.dataReferences, [{
    source: "dependency:private-producer",
    label: executionReferenceLabel({
      scope: "dependency",
      source: "accepted-task-output",
      taskId: "private-producer",
      outputKey: "result",
    }),
    contentHash: dependencyReference.contentHash,
    mediaType: "text/plain",
    byteLength: dependencyReference.byteLength,
  }]);
  assert.deepEqual(dependency.resolvedDataReferences, [{
    ...dependency.dataReferences[0],
    value: "dependency body",
  }]);
  assert.deepEqual(Object.keys(dependency.dataReferences[0] ?? {}).sort(), [
    "byteLength",
    "contentHash",
    "label",
    "mediaType",
    "source",
  ]);
  assert.deepEqual(Object.keys(dependency.artifacts[0] ?? {}).sort(), [
    "byteLength",
    "contentHash",
    "kind",
    "mediaType",
    "outputKey",
  ]);
  assert.deepEqual(dependency.artifacts, [{
    outputKey: "result",
    kind: producerArtifact.kind,
    contentHash: producerArtifact.contentHash,
    mediaType: producerArtifact.mediaType,
    byteLength: producerArtifact.byteLength,
  }]);
  const sdkBoundaryTypes: {
    readonly manifest: NodeExecutionInputManifest;
    readonly reference: NodeExecutionInputReferenceDescriptor;
    readonly resolvedReference: NodeExecutionResolvedDataReference;
    readonly artifact: NodeExecutionAcceptedArtifactDescriptor;
    readonly workspace: NodeExecutionWorkspaceContext;
  } = {
    manifest: consumerEnvelope.surface.workspace.inputs,
    reference: modelInput.inputs.dataReferences[0] as NodeExecutionInputReferenceDescriptor,
    resolvedReference: modelInput.inputs.resolvedDataReferences[0] as NodeExecutionResolvedDataReference,
    artifact: dependency.artifacts[0] as NodeExecutionAcceptedArtifactDescriptor,
    workspace: consumerEnvelope.surface.workspace,
  };
  assert.equal(sdkBoundaryTypes.artifact.outputKey, "result");
  assert.deepEqual(
    sdkBoundaryTypes.resolvedReference.value,
    sdkBoundaryTypes.resolvedReference.contentHash === hashCanonical(explicitBodies.a)
      ? explicitBodies.a
      : explicitBodies.b,
  );
  const completeSurfaces = JSON.stringify({
    args: commandExecutions.map(({ args }) => args),
    stdin: commandExecutions.map(({ stdin }) => stdin),
    env: commandExecutions.map(({ env }) => env),
    envelopes,
    prompts: commandExecutions.map(({ stdin }) => stdin),
    logs: processLogs,
    stdout: processLogs,
    stderr: commandExecutions.map(() => ""),
  });
  for (const sentinel of Object.values(sentinels)) {
    assert.doesNotMatch(completeSurfaces, new RegExp(sentinel, "u"));
  }
  for (const privateField of [
    "referenceId",
    "storage",
    "uri",
    "metadata",
    "artifactId",
    "producerFunctionId",
    "producerFunctionVersion",
  ]) {
    assert.doesNotMatch(completeSurfaces, new RegExp(`"${privateField}"`, "u"));
  }
  for (const safeValue of [
    "task-input",
    "dependency:private-producer",
    executionReferenceLabel({
      scope: "dependency",
      source: "accepted-task-output",
      taskId: "private-producer",
      outputKey: "result",
    }),
    hashCanonical(explicitBodies.a),
    "application/json",
    `"byteLength":${String(Buffer.byteLength(JSON.stringify(explicitBodies.b)))}`,
    "hello world",
    "explicit body",
    "dependency body",
  ]) {
    assert.match(completeSurfaces, new RegExp(safeValue, "u"));
  }

  const duplicate = createRosterRootTask({
    taskId: "duplicate-inputs",
    semanticKey: "private-edge:duplicates",
    nodeId: node.id,
    capability: "inspect",
    objective: "Reject duplicate projected labels.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [
        explicitReferences[0]!,
        {
          ...explicitReferences[1]!,
          contentHash: explicitReferences[0]!.contentHash,
        },
      ],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  const duplicateExecution = platform.createExecution({
    runId: "duplicate-inputs-run",
    seedTasks: [duplicate],
    nodeRuntimes: new NodeRuntimeRegistry([adapter]),
    ...executionPlanes("duplicate-inputs-run"),
  });
  await duplicateExecution.dispatchUntilQuiescent();
  const duplicateRecord = taskGraphTask(await duplicateExecution.snapshot(), duplicate.taskId);
  assert.equal(duplicateRecord?.status, "failed");
  assert.match(duplicateRecord?.error ?? "", /descriptor labels must be unique/u);
  assert.equal(commandExecutions.length, 2, "duplicate projection failed before adapter launch");

  const malformed = createRosterRootTask({
    taskId: "malformed-inputs",
    semanticKey: "private-edge:malformed",
    nodeId: node.id,
    capability: "inspect",
    objective: "Reject a malformed projected descriptor.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [{
        ...explicitReferences[0]!,
        mediaType: " ",
      }],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  const malformedExecution = platform.createExecution({
    runId: "malformed-inputs-run",
    seedTasks: [malformed],
    nodeRuntimes: new NodeRuntimeRegistry([adapter]),
    ...executionPlanes("malformed-inputs-run"),
  });
  await assert.rejects(
    malformedExecution.snapshot(),
    /data reference media type must not be blank/u,
  );
  assert.equal(
    commandExecutions.length,
    2,
    "malformed projection failed before adapter launch",
  );

  const oversized = createRosterRootTask({
    taskId: "oversized-inputs",
    semanticKey: "private-edge:oversized",
    nodeId: node.id,
    capability: "inspect",
    objective: "Omit an input body outside the external execution budget.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [{
        ...explicitReferences[0]!,
        byteLength: 512 * 1_024 + 1,
      }],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  const oversizedExecution = platform.createExecution({
    runId: "oversized-inputs-run",
    seedTasks: [oversized],
    nodeRuntimes: new NodeRuntimeRegistry([adapter]),
    ...executionPlanes("oversized-inputs-run"),
  });
  await oversizedExecution.dispatchUntilQuiescent();
  const oversizedRecord = taskGraphTask(
    await oversizedExecution.snapshot(),
    oversized.taskId,
  );
  assert.equal(oversizedRecord?.status, "accepted");
  const oversizedEnvelope = envelopes.find(({ task }) => task.taskId === oversized.taskId);
  assert.ok(oversizedEnvelope);
  const oversizedInput = (oversizedEnvelope.input as {
    readonly inputs: {
      readonly resolvedDataReferences: ReadonlyArray<unknown>;
      readonly omittedDataReferenceCount: number;
    };
  }).inputs;
  assert.deepEqual(oversizedInput.resolvedDataReferences, []);
  assert.equal(oversizedInput.omittedDataReferenceCount, 1);
  assert.equal(commandExecutions.length, 3, "oversized body was omitted while the task still launched");

  const corruptedStore: DataReferenceStore = {
    durability: "process-local",
    put: (input, control) => backingStore.put(input, control),
    read: async () => "tampered body",
  };
  const corrupted = createRosterRootTask({
    taskId: "corrupted-input",
    semanticKey: "private-edge:corrupted",
    nodeId: node.id,
    capability: "inspect",
    objective: "Reject a body that does not match its admitted hash.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [explicitReferences[0]!],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  const corruptedExecution = platform.createExecution({
    runId: "corrupted-input-run",
    seedTasks: [corrupted],
    nodeRuntimes: new NodeRuntimeRegistry([adapter]),
    ...executionPlanes("corrupted-input-run", corruptedStore),
  });
  await corruptedExecution.dispatchUntilQuiescent();
  const corruptedRecord = taskGraphTask(
    await corruptedExecution.snapshot(),
    corrupted.taskId,
  );
  assert.equal(corruptedRecord?.status, "failed");
  assert.match(corruptedRecord?.error ?? "", /changed content hash/u);
  assert.equal(commandExecutions.length, 3, "corrupted body failed before adapter launch");

  const collisionInputs = {
    inputVersions: { request: "request-v1" },
    dataReferences: [],
    frontierVersion: "frontier-v1",
    topologyVersion: "topology-v1",
    catalogVersion: "catalog-v1",
  };
  const tupleProducer = createRosterRootTask({
    taskId: "a:b",
    semanticKey: "private-edge:tuple-producer-a-b",
    nodeId: node.id,
    capability: "inspect",
    objective: "Produce tuple a:b / c.",
    inputs: collisionInputs,
    result: { mode: "text", outputKey: "c" },
  });
  const alternateTupleProducer = createRosterRootTask({
    taskId: "a",
    semanticKey: "private-edge:tuple-producer-a",
    nodeId: node.id,
    capability: "inspect",
    objective: "Produce tuple a / b:c.",
    inputs: collisionInputs,
    result: { mode: "text", outputKey: "b:c" },
  });
  const scopeProducer = createRosterRootTask({
    taskId: "input",
    semanticKey: "private-edge:scope-producer",
    nodeId: node.id,
    capability: "inspect",
    objective: "Attempt the former explicit/dependency label collision.",
    inputs: collisionInputs,
    result: { mode: "text", outputKey: explicitReferences[0]!.contentHash },
  });
  const collisionConsumer = createDynamicTaskDefinition({
    taskId: "collision-consumer",
    semanticKey: "private-edge:collision-consumer",
    nodeId: node.id,
    capability: "inspect",
    objective: "Inspect collision-proof aggregate reference identities.",
    handler: { kind: "roster.node", version: "1" },
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: { mode: "text", outputKey: "result" },
    dependencies: [tupleProducer, alternateTupleProducer, scopeProducer].map(({ taskId }) => ({
      taskId,
      condition: "accepted" as const,
    })),
    join: { kind: "all-success" },
    inputs: {
      ...collisionInputs,
      dataReferences: [explicitReferences[0]!],
    },
    runtimeBindingEpoch: 0,
    retry: {
      maxAttempts: 1,
      initialBackoffMs: 0,
      maximumBackoffMs: 0,
    },
    timeoutMs: 5_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
  });
  const collisionExecution = platform.createExecution({
    runId: "collision-inputs-run",
    seedTasks: [
      tupleProducer,
      alternateTupleProducer,
      scopeProducer,
      collisionConsumer,
    ],
    nodeRuntimes: new NodeRuntimeRegistry([adapter]),
    ...executionPlanes("collision-inputs-run", dataReferences),
  });
  await collisionExecution.dispatchUntilQuiescent();
  assert.equal(
    taskGraphTask(await collisionExecution.snapshot(), collisionConsumer.taskId)?.status,
    "accepted",
  );
  const collisionEnvelope = envelopes.find(({ task }) =>
    task.taskId === collisionConsumer.taskId);
  assert.ok(collisionEnvelope);
  const collisionInput = collisionEnvelope.input as {
    readonly inputs: {
      readonly dataReferences: ReadonlyArray<NodeExecutionInputReferenceDescriptor>;
    };
    readonly dependencies: Readonly<Record<string, {
      readonly dataReferences: ReadonlyArray<NodeExecutionInputReferenceDescriptor>;
    }>>;
  };
  const crossDependencyLabels = [
    collisionInput.dependencies["a:b"]!.dataReferences[0]!.label,
    collisionInput.dependencies.a!.dataReferences[0]!.label,
  ];
  assert.equal(new Set(crossDependencyLabels).size, 2);
  assert.notEqual(
    collisionInput.inputs.dataReferences[0]!.label,
    collisionInput.dependencies.input!.dataReferences[0]!.label,
  );
  assert.equal(commandExecutions.length, 7);
});

test("execution options cannot replace Roster-owned sanitized request authority", async () => {
  const node = {
    id: "options-node",
    name: "Options Node",
    capabilities: ["coordinate", "inspect"],
    runtime: { kind: "options-authored-runtime" as const },
  };
  const platform = defineRosterPlatform({
    id: "options-platform",
    version: "3",
    policyVersion: "options-policy-v3",
    coordinatorId: node.id,
    capabilities: [
      { id: "coordinate", description: "Coordinate one bounded task." },
      { id: "inspect", description: "Inspect one bounded task." },
    ],
    nodes: [node],
    policy: POLICY,
    resolveRuntimeBinding: (_node, definition) => ({
      bindingId: "options-bound-binding",
      nodeId: node.id,
      runtime: { kind: "options-runtime" },
      epoch: 2,
      topologyVersion: definition.inputs.topologyVersion,
    }),
  });
  const root = createRosterRootTask({
    taskId: "options-root",
    semanticKey: "options:root",
    nodeId: node.id,
    capability: "inspect",
    objective: "Keep Roster-owned execution fields authoritative.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  let observed: NodeExecutionEnvelope | undefined;
  let observedOptions: Record<string, unknown> | undefined;
  let launchedRuntime: string | undefined;
  let nativeCalls = 0;
  const execution = platform.createExecution({
    runId: "options-run",
    seedTasks: [root],
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "options-runtime",
      executeEnvelope: async (envelope) => {
        observed = envelope;
        launchedRuntime = envelope.runtime.kind;
        return {
          schemaVersion: envelope.schemaVersion,
          status: "completed",
          output: "safe",
        };
      },
    }]),
    executionOptions: (descriptor) => {
      observedOptions = { ...descriptor };
      const hostile = descriptor as unknown as Record<string, unknown>;
      hostile.runId = "HOSTILE_RUN";
      hostile.nodeId = "HOSTILE_NODE";
      hostile.taskId = "HOSTILE_TASK";
      hostile.capability = "HOSTILE_CAPABILITY";
      hostile.effectiveRuntimeKind = "HOSTILE_RUNTIME";
      hostile.node = { id: "HOSTILE_NODE_OBJECT" };
      hostile.task = { taskId: "HOSTILE_TASK_OBJECT" };
      hostile.binding = { bindingId: "HOSTILE_BINDING_OBJECT" };
      hostile.runtime = { kind: "HOSTILE_RUNTIME_OBJECT" };
      return {
        runId: "HOSTILE_RETURN_RUN",
        node: { id: "HOSTILE_RETURN_NODE" },
        task: { taskId: "HOSTILE_RETURN_TASK" },
        input: { secret: "HOSTILE_INPUT" },
        surface: {
          workspace: { workspaceId: "HOSTILE_WORKSPACE" },
          tools: [{ id: "HOSTILE_TOOL" }],
        },
        binding: { bindingId: "HOSTILE_BINDING" },
        runtime: { kind: "HOSTILE_RETURN_RUNTIME" },
        trace: { traceId: "HOSTILE_TRACE" },
        execute: async () => "HOSTILE_NATIVE",
        invokeFunction: async () => ({ status: "completed", output: "HOSTILE_FUNCTION" }),
      } as never;
    },
    nativeExecute: async () => {
      nativeCalls += 1;
      return "native";
    },
    ...executionPlanes("options-run"),
  });

  await execution.dispatchUntilQuiescent();
  assert.ok(observed);
  assert.equal(observed.runId, "options-run");
  assert.equal(observed.node.id, node.id);
  assert.equal(observed.task.taskId, root.taskId);
  assert.equal(observed.binding?.bindingId, "options-bound-binding");
  assert.equal(observed.runtime.kind, "options-runtime");
  assert.equal(observed.surface.workspace?.workspaceId, "options-run");
  assert.equal(observed.surface.tools.some((tool) => tool.id === "HOSTILE_TOOL"), false);
  assert.equal(JSON.stringify(observed).includes("HOSTILE_"), false);
  assert.deepEqual(observedOptions, {
    runId: "options-run",
    nodeId: node.id,
    taskId: root.taskId,
    capability: root.capability,
    effectiveRuntimeKind: "options-runtime",
  });
  assert.equal(launchedRuntime, "options-runtime");
  assert.equal(nativeCalls, 0);
});

test("platform projects centrally selected skills through the provider-neutral envelope", async () => {
  const node = {
    id: "skill-node",
    name: "Skill Node",
    capabilities: ["coordinate", "inspect"],
    runtime: { kind: "skill-runtime" },
  };
  const inspectSkill = createNodeExecutionSkill({
    id: "inspect-context",
    name: "Inspect context",
    description: "Inspect bounded context without importing the complete value.",
    instructions: "Use context search and peek before materializing a complete value.",
  });
  const unusedSkill = createNodeExecutionSkill({
    id: "unused",
    name: "Unused",
    description: "Prove that unselected skills remain outside the execution envelope.",
    instructions: "This instruction must not appear in the selected node turn.",
  });
  let selectionContext: Readonly<Record<string, unknown>> | undefined;
  const platform = defineRosterPlatform({
    id: "skill-platform",
    version: "3",
    policyVersion: "skill-policy-v1",
    coordinatorId: node.id,
    capabilities: [
      { id: "coordinate", description: "Coordinate one bounded task." },
      { id: "inspect", description: "Inspect bounded context." },
    ],
    nodes: [node],
    policy: POLICY,
    skills: [inspectSkill, unusedSkill],
    selectSkills: (context) => {
      selectionContext = { ...context };
      return context.capability === "inspect" ? [inspectSkill.id] : [];
    },
  });
  const root = createRosterRootTask({
    taskId: "skill-root",
    semanticKey: "skill:root",
    nodeId: node.id,
    capability: "inspect",
    objective: "Inspect the bounded task context.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  let observed: NodeExecutionEnvelope | undefined;
  const execution = platform.createExecution({
    runId: "skill-projection-run",
    seedTasks: [root],
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "skill-runtime",
      executeEnvelope: async (envelope) => {
        observed = envelope;
        return {
          schemaVersion: envelope.schemaVersion,
          status: "completed",
          output: "inspected",
        };
      },
    }]),
    ...executionPlanes("skill-projection-run"),
  });

  await execution.dispatchUntilQuiescent();

  assert.deepEqual(observed?.surface.skills, [inspectSkill]);
  assert.equal(JSON.stringify(observed).includes(unusedSkill.instructions), false);
  assert.deepEqual(selectionContext, {
    runId: "skill-projection-run",
    nodeId: node.id,
    nodeCapabilities: ["coordinate", "inspect"],
    taskId: root.taskId,
    capability: "inspect",
    handlerKind: "roster.node",
    effectiveRuntimeKind: "skill-runtime",
  });
});

test("execution options observe the bound effective runtime without replacing its identity", async () => {
  const node = {
    id: "runtime-bound-node",
    name: "Runtime Bound Node",
    capabilities: ["coordinate", "inspect"],
    runtime: { kind: "authored-runtime" as const },
  };
  const platform = defineRosterPlatform({
    id: "runtime-bound-platform",
    version: "3",
    policyVersion: "runtime-bound-policy-v3",
    coordinatorId: node.id,
    capabilities: [
      { id: "coordinate", description: "Coordinate one bounded task." },
      { id: "inspect", description: "Inspect one bounded task." },
    ],
    nodes: [node],
    policy: POLICY,
    resolveRuntimeBinding: (_node, definition) => ({
      bindingId: "runtime-bound-binding",
      nodeId: node.id,
      runtime: { kind: "bound-runtime", profile: "bound-profile" },
      epoch: 3,
      topologyVersion: definition.inputs.topologyVersion,
    }),
  });
  const root = createRosterRootTask({
    taskId: "runtime-bound-root",
    semanticKey: "runtime-bound:root",
    nodeId: node.id,
    capability: "inspect",
    objective: "Use the resolved runtime binding.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  let hookRuntime: string | undefined;
  let adapterRuntime: string | undefined;
  let loggedRuntime: string | undefined;
  const execution = platform.createExecution({
    runId: "runtime-bound-run",
    seedTasks: [root],
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "bound-runtime",
      supportsCodeMode: true,
      executeEnvelope: async (envelope, control) => {
        adapterRuntime = envelope.runtime.kind;
        assert.equal(envelope.binding?.runtime.kind, "bound-runtime");
        control.onLog?.({ stream: "stdout", text: "bound runtime log" });
        return {
          schemaVersion: envelope.schemaVersion,
          status: "completed",
          output: "bound",
        };
      },
    }]),
    executionOptions: ({ effectiveRuntimeKind }) => {
      hookRuntime = effectiveRuntimeKind;
      return {
        runtime: { kind: "HOSTILE_RUNTIME" },
        binding: { bindingId: "HOSTILE_BINDING" },
        onLog: () => {
          loggedRuntime = effectiveRuntimeKind;
        },
      } as never;
    },
    ...executionPlanes("runtime-bound-run"),
  });

  await execution.dispatchUntilQuiescent();
  assert.equal(hookRuntime, "bound-runtime");
  assert.equal(adapterRuntime, "bound-runtime");
  assert.equal(loggedRuntime, "bound-runtime");
  assert.equal(
    taskGraphTask(await execution.snapshot(), root.taskId)?.definition.runtimeBindingEpoch,
    3,
  );
});

test("roster-native platform tasks always use the canonical native adapter", async () => {
  const node = {
    id: "canonical-native-node",
    name: "Canonical Native Node",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" as const },
  };
  const platform = defineRosterPlatform({
    id: "canonical-native-platform",
    version: "3",
    policyVersion: "canonical-native-policy-v3",
    coordinatorId: node.id,
    capabilities: [{ id: "coordinate", description: "Coordinate one bounded task." }],
    nodes: [node],
    policy: POLICY,
  });
  const nativeBackingStore = new InMemoryDataReferenceStore();
  const nativeReference = await nativeBackingStore.put({
    value: { shouldRemainUnread: true },
  });
  let nativeReferenceReads = 0;
  const nativeDataReferences: DataReferenceStore = {
    durability: nativeBackingStore.durability,
    put: (input, control) => nativeBackingStore.put(input, control),
    read: (reference, control) => {
      nativeReferenceReads += 1;
      return nativeBackingStore.read(reference, control);
    },
  };
  const root = createRosterRootTask({
    taskId: "canonical-native-root",
    semanticKey: "canonical-native:root",
    nodeId: node.id,
    capability: "coordinate",
    objective: "Use canonical native execution.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [nativeReference],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });
  let injectedCalls = 0;
  let nativeCalls = 0;
  const execution = platform.createExecution({
    runId: "canonical-native-run",
    seedTasks: [root],
    nodeRuntimes: new NodeRuntimeRegistry([{
      kind: "roster-native",
      execute: async () => {
        injectedCalls += 1;
        return "injected";
      },
    }]),
    nativeExecute: async () => {
      nativeCalls += 1;
      return "canonical";
    },
    ...executionPlanes("canonical-native-run", nativeDataReferences),
  });

  await execution.dispatchUntilQuiescent();
  assert.equal(injectedCalls, 0);
  assert.equal(nativeCalls, 1);
  assert.equal(nativeReferenceReads, 0);
});

test("non-native platform nodes require an explicit runtime registry", () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "remote-agent" },
  };
  const platform = defineRosterPlatform({
    id: "explicit-runtime-platform",
    version: "3",
    policyVersion: "explicit-runtime-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [{ id: "coordinate", description: "Coordinate work." }],
    nodes: [coordinator],
    policy: POLICY,
  });
  const root = createRosterRootTask({
    taskId: "root",
    semanticKey: "explicit-runtime:root",
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: "Require explicit execution placement.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
  });

  assert.throws(
    () => platform.createExecution({
      runId: "explicit-runtime-run",
      seedTasks: [root],
      ...executionPlanes("explicit-runtime-run"),
    }),
    /requires an explicit NodeRuntimeRegistry.*coordinator:remote-agent/,
  );
});

test("platform execution requires explicit compatible graph, value, and task-context planes", () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" },
  };
  const platform = defineRosterPlatform({
    id: "explicit-planes-platform",
    version: "3",
    policyVersion: "explicit-planes-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [{ id: "coordinate", description: "Coordinate work." }],
    nodes: [coordinator],
    policy: POLICY,
  });
  const incomplete = {
    runId: "explicit-planes-run",
    seedTasks: [],
  };
  assert.throws(
    () => platform.createExecution(incomplete as RosterPlatformExecutionOptions),
    /requires an explicit TaskGraphControl/,
  );
  assert.throws(
    () => platform.createExecution({
      ...incomplete,
      taskGraph: new InMemoryTaskGraphControl(),
    } as RosterPlatformExecutionOptions),
    /requires an explicit DataReferenceStore/,
  );
  assert.throws(
    () => platform.createExecution({
      ...incomplete,
      taskGraph: new InMemoryTaskGraphControl(),
      dataReferences: new InMemoryDataReferenceStore(),
    } as RosterPlatformExecutionOptions),
    /requires a task-fenced createTaskContext plane/,
  );

  const durableTaskGraph = new InMemoryTaskGraphControl();
  Object.defineProperty(durableTaskGraph, "durability", { value: "durable" });
  assert.throws(
    () => platform.createExecution({
      ...incomplete,
      taskGraph: durableTaskGraph as unknown as TaskGraphControl,
      dataReferences: new InMemoryDataReferenceStore(),
      createTaskContext: executionPlanes("unused").createTaskContext,
    }),
    /Durable TaskGraphControl requires a durable DataReferenceStore/,
  );

  const durableDataReferences = new InMemoryDataReferenceStore();
  Object.defineProperty(durableDataReferences, "durability", { value: "durable" });
  assert.throws(() => platform.createExecution({
    ...incomplete,
    taskGraph: durableTaskGraph as unknown as TaskGraphControl,
    dataReferences: durableDataReferences as unknown as DataReferenceStore,
    createTaskContext: executionPlanes("durable-workspace-mismatch").createTaskContext,
  }), /requires a durable task-context workspace/);
  const durableTaskContext = Object.assign(
    executionPlanes("durable-compatible").createTaskContext,
    { durability: "durable" as const },
  );
  assert.doesNotThrow(() => platform.createExecution({
    ...incomplete,
    taskGraph: durableTaskGraph as unknown as TaskGraphControl,
    dataReferences: durableDataReferences as unknown as DataReferenceStore,
    createTaskContext: durableTaskContext,
  }));
});

test("platform initialization failures stay attached to the execution API", async () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" },
  };
  const platform = defineRosterPlatform({
    id: "initialization-failure-platform",
    version: "3",
    policyVersion: "initialization-failure-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [{ id: "coordinate", description: "Coordinate work." }],
    nodes: [coordinator],
    policy: POLICY,
  });
  const backing = new InMemoryTaskGraphControl();
  const failing = new Proxy(backing, {
    get(target, property, receiver) {
      if (property === "initialize") {
        return async () => {
          throw new Error("durable initialization rejected");
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TaskGraphControl;
  const execution = platform.createExecution({
    runId: "initialization-failure-run",
    seedTasks: [],
    ...executionPlanes("initialization-failure-run", new InMemoryDataReferenceStore(), failing),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(execution.snapshot(), /durable initialization rejected/);
});

test("durable atomic initialization preserves the resolver-selected runtime snapshot", async () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" as const, profile: "authored-default" },
  };
  const platform = defineRosterPlatform({
    id: "initial-runtime-snapshot-platform",
    version: "3",
    policyVersion: "initial-runtime-snapshot-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [{ id: "coordinate", description: "Coordinate work." }],
    nodes: [coordinator],
    policy: POLICY,
    resolveRuntimeBinding: (node, definition) => ({
      bindingId: "selected-coordinator-binding",
      nodeId: node.id,
      runtime: {
        kind: "codex-cli",
        profile: "selected-profile",
        metadata: { model: "selected-model" },
      },
      epoch: 7,
      topologyVersion: definition.inputs.topologyVersion,
      sandboxId: "selected-sandbox",
    }),
  });
  const root = createRosterRootTask({
    taskId: "initial-runtime-snapshot-root",
    semanticKey: "initial-runtime-snapshot:root",
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: "Capture the exact initial runtime placement.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
    result: { mode: "none" },
  });
  const backing = new InMemoryTaskGraphControl();
  let initialization: Parameters<TaskGraphControl["initialize"]>[0] | undefined;
  const durableControl: TaskGraphControl = {
    durability: "durable",
    initialize: (input) => {
      initialization = input;
      return backing.initialize(input);
    },
    snapshot: () => backing.snapshot(),
    enqueue: (input) => backing.enqueue(input),
    claim: (input) => backing.claim(input),
    start: (lease, manifest) => backing.start(lease, manifest),
    heartbeat: (lease) => backing.heartbeat(lease),
    expand: (input) => backing.expand(input),
    accept: (input) => backing.accept(input),
    fail: (input) => backing.fail(input),
    cancel: (input) => backing.cancel(input),
  };
  const durableReferences = new InMemoryDataReferenceStore();
  Object.defineProperty(durableReferences, "durability", { value: "durable" });
  const durableContext = Object.assign(
    executionPlanes("initial-runtime-snapshot", durableReferences, durableControl).createTaskContext,
    { durability: "durable" as const },
  );
  const execution = platform.createExecution({
    runId: "initial-runtime-snapshot-run",
    seedTasks: [root],
    taskGraph: durableControl,
    dataReferences: durableReferences,
    createTaskContext: durableContext,
    nodeRuntimes: new NodeRuntimeRegistry(),
  });
  await execution.snapshot();

  assert.equal(initialization?.runtimeBindings?.length, 1);
  assert.deepEqual(initialization?.runtimeBindings?.[0], {
    bindingId: "selected-coordinator-binding",
    nodeId: coordinator.id,
    runtime: {
      kind: "codex-cli",
      profile: "selected-profile",
      metadata: { model: "selected-model" },
    },
    epoch: 1,
    topologyVersion: "topology-v1",
    sandboxId: "selected-sandbox",
  });
  assert.equal(initialization?.seedTasks[0]?.runtimeBindingEpoch, 1);
  assert.equal(initialization?.seedTasks[0]?.definitionHash, (
    await execution.snapshot()
  ).tasks[0]?.definition.definitionHash);
});

test("a changed runtime binding epoch fails before node execution", async () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" },
  };
  let bindingEpoch = 1;
  const platform = defineRosterPlatform({
    id: "stale-binding-platform",
    version: "3",
    policyVersion: "stale-binding-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [{ id: "coordinate", description: "Coordinate work." }],
    nodes: [coordinator],
    policy: POLICY,
    resolveRuntimeBinding: (node, definition) => ({
      bindingId: `binding-${node.id}-${bindingEpoch}`,
      nodeId: node.id,
      runtime: node.runtime,
      epoch: bindingEpoch,
      topologyVersion: definition.inputs.topologyVersion,
    }),
  });
  const root = createRosterRootTask({
    taskId: "stale-binding-root",
    semanticKey: "stale-binding:root",
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: "Reject stale placement before execution.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
    result: { mode: "none" },
  });
  let nativeCalls = 0;
  const execution = platform.createExecution({
    runId: "stale-binding-run",
    seedTasks: [root],
    ...executionPlanes("stale-binding-run"),
    nodeRuntimes: new NodeRuntimeRegistry(),
    nativeExecute: async () => {
      nativeCalls += 1;
      return undefined;
    },
  });
  assert.equal(
    taskGraphTask(await execution.snapshot(), root.taskId)?.definition.runtimeBindingEpoch,
    1,
  );
  bindingEpoch = 2;

  await execution.dispatchUntilQuiescent();
  const record = taskGraphTask(await execution.snapshot(), root.taskId);
  assert.equal(nativeCalls, 0);
  assert.equal(record?.status, "failed");
  assert.match(record?.error ?? "", /runtime binding epoch is stale: snapshotted 1, current 2/);
});

test("every native platform turn can receive a task-fenced shared context", async () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" },
  };
  const platform = defineRosterPlatform({
    id: "shared-context-platform",
    version: "3",
    policyVersion: "shared-context-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [{ id: "coordinate", description: "Coordinate shared work." }],
    nodes: [coordinator],
    policy: POLICY,
  });
  const root = createRosterRootTask({
    taskId: "shared-root",
    semanticKey: "shared-context:root",
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: "Publish one shared finding.",
    inputs: {
      inputVersions: { request: "request-v1" },
      dataReferences: [],
      frontierVersion: "frontier-v1",
      topologyVersion: "topology-v1",
      catalogVersion: "catalog-v1",
    },
    result: { mode: "none" },
  });
  let publishedTaskId = "";
  const taskGraph = new InMemoryTaskGraphControl();
  const execution = platform.createExecution({
    runId: "shared-context-run",
    seedTasks: [root],
    taskGraph,
    dataReferences: new InMemoryDataReferenceStore(),
    createTaskContext: ({ runId, node, definition, lease }) => ({
      node,
      fence: {
        runId,
        taskId: definition.taskId,
        nodeId: node.id,
        fence: BigInt(lease.fence),
        frontierVersion: definition.inputs.frontierVersion,
        topologyVersion: definition.inputs.topologyVersion,
        catalogVersion: definition.inputs.catalogVersion,
        runtimeBindingEpoch: definition.runtimeBindingEpoch,
        inputVersions: definition.inputs.inputVersions,
      },
      readWorkspace: async () => {
        throw new Error("readWorkspace was not expected");
      },
      publish: async (entry) => {
        publishedTaskId = definition.taskId;
        return {
          entry: {
            ...entry,
            nodeId: node.id,
            entryId: "entry-shared-root",
            bodyHash: "body-hash",
          },
          update: new Uint8Array([1]),
          updateId: "update-shared-root",
        };
      },
    }),
    nativeExecute: async ({ taskContext }) => {
      assert.equal(taskContext?.fence.taskId, "shared-root");
      assert.equal(taskContext?.fence.fence, 1n);
      await taskContext?.publish({
        kind: "finding",
        mode: "append",
        subjectId: "dynamic-graph",
        body: "Shared context is fenced to this task.",
        references: [],
      });
      return undefined;
    },
  });

  const quiescence = await execution.dispatchUntilQuiescent();
  assert.equal(quiescence.deadlocked, false);
  assert.equal(publishedTaskId, "shared-root");
  assert.equal(taskGraphTask(await execution.snapshot(), "shared-root")?.status, "accepted");
});

test("an enqueue trigger admits an idempotent root task into the same graph control", async () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" },
  };
  const received: unknown[] = [];
  const platform = defineRosterPlatform({
    id: "trigger-platform",
    version: "3",
    policyVersion: "trigger-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [{ id: "coordinate", description: "Coordinate work." }],
    nodes: [coordinator],
    policy: POLICY,
    functions: [{
      id: "work::capture",
      version: "1",
      capability: "coordinate",
      description: "Capture one queued value.",
      inputSchema: { type: "string" },
      outputSchema: { type: "null" },
      effects: ["read"],
      idempotency: "supported",
    }],
    workers: [{
      workerId: "capture-worker",
      epoch: 1,
      functions: [{
        functionId: "work::capture",
        invoke: async (value) => {
          received.push(value);
          return null;
        },
      }],
    }],
    triggers: [{
      schemaVersion: ROSTER_TRIGGER_DEFINITION_VERSION,
      triggerId: "capture-on-queue",
      version: "1",
      source: { kind: "queue", key: "capture" },
      target: {
        functionId: "work::capture",
        functionVersion: "1",
        action: { kind: "enqueue" },
      },
      inputMode: "event",
      enabled: true,
    }],
  });
  const execution = platform.createExecution({
    runId: "trigger-run",
    seedTasks: [],
    ...executionPlanes("trigger-run"),
  });
  const event = {
    eventId: "capture-event",
    source: { kind: "queue" as const, key: "capture" },
    value: "queued body",
    occurredAt: Date.now(),
  };
  const access = {
    functionGrants: ["work::capture"],
    allowedEffects: ["read" as const],
  };

  const first = await execution.route({ node: coordinator, event, access });
  const replay = await execution.route({ node: coordinator, event, access });
  assert.deepEqual(replay, first);
  assert.equal(first[0]?.status, "enqueued");
  assert.ok(first[0]?.receiptId?.startsWith("function_"));
  assert.equal((await execution.snapshot()).tasks.length, 1);

  const quiescence = await execution.dispatchUntilQuiescent();
  const snapshot = await execution.snapshot();
  assert.equal(quiescence.quiescent, true);
  assert.equal(snapshot.tasks[0]?.status, "accepted");
  assert.deepEqual(received, ["queued body"]);
});

test("durable execution rejects direct triggers whose replay dedupe is process-local", () => {
  const coordinator = {
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" },
  };
  const platform = defineRosterPlatform({
    id: "durable-trigger-platform",
    version: "3",
    policyVersion: "durable-trigger-policy-v3",
    coordinatorId: coordinator.id,
    capabilities: [{ id: "coordinate", description: "Coordinate work." }],
    nodes: [coordinator],
    policy: POLICY,
    functions: [{
      id: "work::direct",
      version: "1",
      capability: "coordinate",
      description: "Run one direct operation.",
      inputSchema: true,
      outputSchema: true,
      effects: ["read"],
    }],
    triggers: [{
      schemaVersion: ROSTER_TRIGGER_DEFINITION_VERSION,
      triggerId: "unsafe-direct-trigger",
      version: "1",
      source: { kind: "queue", key: "direct" },
      target: {
        functionId: "work::direct",
        functionVersion: "1",
        action: { kind: "await" },
      },
      inputMode: "event",
      enabled: true,
    }],
  });
  const durableTaskGraph = new InMemoryTaskGraphControl();
  Object.defineProperty(durableTaskGraph, "durability", { value: "durable" });
  const durableDataReferences = new InMemoryDataReferenceStore();
  Object.defineProperty(durableDataReferences, "durability", { value: "durable" });
  const durableTaskContext = Object.assign(
    executionPlanes("durable-trigger-run").createTaskContext,
    { durability: "durable" as const },
  );

  assert.throws(() => platform.createExecution({
    runId: "durable-trigger-run",
    seedTasks: [],
    taskGraph: durableTaskGraph as unknown as TaskGraphControl,
    dataReferences: durableDataReferences as unknown as DataReferenceStore,
    createTaskContext: durableTaskContext,
  }), /requires trigger unsafe-direct-trigger to enqueue durable work/);
});
