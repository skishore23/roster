import { canonicalize, hashCanonical } from "../../core/canonical.js";
import type { Clock } from "../../core/clock.js";
import type { DataReferenceStore } from "../dataflow/data-reference-store.js";
import {
  WorkerPipelineExecutor,
  type WorkerPipelineDefinition,
  type WorkerPipelineLimits,
  type WorkerPipelineResult,
} from "../dataflow/worker-pipeline.js";
import {
  RosterFunctionDirectory,
  type RosterFunctionAccess,
  type RosterCapabilityCatalogSearchResult,
  type RosterFunctionDescriptor,
  type RosterFunctionProvider,
  type RosterFunctionTool,
} from "../functions/function-directory.js";
import { createChildExecutionTrace, createRootExecutionTrace } from "../observability/trace.js";
import { createDomainRegistry } from "../orchestration/domain.js";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  DynamicTaskAcceptanceRegistry,
  DynamicTaskDispatcher,
  DynamicTaskHandlerRegistry,
  createDefaultDynamicTaskAcceptanceRegistry,
  createDynamicTaskDefinition,
  defaultTaskResultContract,
  type DynamicTaskHandlerContext,
  type DynamicTaskReadyBatchRunner,
  type TaskGraphQuiescence,
} from "../orchestration/task-graph.js";
import {
  taskGraphEffectiveTask,
  taskGraphTask,
  type TaskGraphControl,
  type TaskGraphControlSnapshot,
} from "../orchestration/task-graph-control.js";
import type {
  DomainCapability,
  DomainPack,
  DomainRegistry,
  JsonValue,
  WorkspaceNode,
  WorkspaceNodeRuntimeBinding,
} from "../orchestration/types.js";
import {
  createDefaultNodeRuntimeRegistry,
  createNodeExecutionCodeMode,
  type NodeExecutionAcceptedArtifactDescriptor,
  type NodeExecutionInputManifest,
  type NodeExecutionInputReferenceDescriptor,
  type NodeExecutionResolvedDataReference,
  type NodeExecutionRequest,
  type NodeExecutionSkill,
  type NodeExecutionSurfaceInput,
  type NodeRuntimeRegistry,
} from "../runtime/node-runtime.js";
import {
  assertTaskExecutionGrantTool,
  assertTaskExecutionGrantWorkspaceOperation,
  createTaskExecutionGrant,
} from "./execution-grant.js";
import {
  NodeExecutionSkillRegistry,
  type NodeExecutionSkillSelectionContext,
  type NodeExecutionSkillSelector,
} from "../runtime/node-skill-registry.js";
import {
  createRosterFunctionExecutionPlane,
  type RosterFunctionActivity,
} from "../runtime/node-function-plane.js";
import type { NodeExecutionFunctionInvoker } from "../runtime/node-runtime.js";
import { createWorkspaceNodeRuntimeBinding } from "../workspace/node.js";
import type {
  RosterTaskContext,
  WorkspaceEntryKind,
  WorkspaceEntryMode,
} from "../workspace/shared-workspace.js";
import {
  ROSTER_TRIGGER_DEFINITION_VERSION,
  RosterTriggerRouter,
  type RosterTriggerDefinition,
  type RosterTriggerDelivery,
  type RosterTriggerEvent,
} from "../triggers/trigger-router.js";
import type {
  AcceptedArtifactReference,
  DataReference,
  DynamicTaskDefinition,
  ExecutionTraceContext,
  RunExecutionPolicy,
  TaskJoinPolicy,
  TaskResultContract,
} from "./protocol.js";
import type { TaskRepositoryPlacement } from "./task-context-manifest.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_NODE_EXECUTION_RESOLVED_DATA_REFERENCES = 64;
const MAX_NODE_EXECUTION_RESOLVED_DATA_REFERENCE_BYTES_TOTAL = 512 * 1_024;

export const ROSTER_EXPAND_FUNCTION_ID = "roster::expand" as const;
export const ROSTER_CONSULT_FUNCTION_ID = "roster::consult" as const;
export const ROSTER_NODE_CONSULTATION_SCHEMA_VERSION = "roster.node-consultation.v1" as const;
export const MAX_ROSTER_CONSULTATION_RECIPIENTS = 4;
export const ROSTER_NODE_TASK_HANDLER = {
  kind: "roster.node",
  version: "1",
} as const;
export const ROSTER_FUNCTION_TASK_HANDLER = {
  kind: "roster.function",
  version: "1",
} as const;
export const ROSTER_WORKSPACE_READ_FUNCTION_ID = "roster::workspace.read" as const;
export const ROSTER_WORKSPACE_PUBLISH_FUNCTION_ID = "roster::workspace.publish" as const;

export type RosterExpansionTaskProposal = {
  readonly taskId: string;
  readonly semanticKey: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective: string;
  /**
   * Optional dependencies on sibling children in the same atomic expansion.
   * This lets a coordinator publish a bounded DAG rather than only a flat
   * fan-out while TaskGraphControl remains the sole graph authority.
   */
  readonly dependencyTaskIds?: ReadonlyArray<string>;
  readonly result?: TaskResultContract;
  readonly estimatedCostMicros?: number;
};

export type RosterExpansionProposal = {
  readonly expansionKey: string;
  readonly children: ReadonlyArray<RosterExpansionTaskProposal>;
  readonly continuation: RosterExpansionTaskProposal & {
    readonly join?: TaskJoinPolicy;
  };
};

export type RosterNodeConsultationRecipient = {
  readonly nodeId: string;
  readonly capability: string;
};

/** A bounded node-authored request whose task identities are stamped by Roster. */
export type RosterNodeConsultation = {
  readonly schemaVersion: typeof ROSTER_NODE_CONSULTATION_SCHEMA_VERSION;
  readonly turnKey: string;
  readonly question: string;
  readonly recipients: ReadonlyArray<RosterNodeConsultationRecipient>;
  readonly responseRequirement: "any" | "all";
  readonly evidence?: ReadonlyArray<string>;
};

export type RosterNodeConsultationPolicy = {
  readonly maxRecipients?: number;
  readonly canConsult: (input: {
    readonly author: WorkspaceNode;
    readonly recipient: WorkspaceNode;
    readonly parent: DynamicTaskDefinition;
    readonly capability: string;
  }) => boolean;
};

export type RosterWorkerRegistration = {
  readonly workerId: string;
  readonly epoch: number;
  readonly heartbeat?: {
    readonly observedAt: number;
    readonly ttlMs: number;
  };
  readonly functions: ReadonlyArray<{
    readonly functionId: string;
    readonly invoke: RosterFunctionProvider["invoke"];
  }>;
};

export type RosterPlatformDefinition = {
  readonly id: string;
  readonly version: string;
  readonly policyVersion: string;
  readonly coordinatorId: string;
  readonly coordinatorCapability?: string;
  readonly capabilities: ReadonlyArray<DomainCapability>;
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly maxNodes?: number;
  readonly policy: RunExecutionPolicy;
  readonly functions?: ReadonlyArray<RosterFunctionDescriptor>;
  readonly workers?: ReadonlyArray<RosterWorkerRegistration>;
  readonly triggers?: ReadonlyArray<RosterTriggerDefinition>;
  readonly pipelineLimits?: WorkerPipelineLimits;
  /** Optional bounded peer-discussion policy. Scheduling remains Roster-owned. */
  readonly consultation?: RosterNodeConsultationPolicy;
  /** Provider-neutral skill catalog; selectors return IDs from this exact set. */
  readonly skills?: ReadonlyArray<NodeExecutionSkill>;
  /** Deterministically selects the exact bounded skills for one node task. */
  readonly selectSkills?: NodeExecutionSkillSelector;
  readonly access?: (
    node: WorkspaceNode,
    definition: DynamicTaskDefinition,
  ) => RosterFunctionAccess;
  /** Task-scoped shared-workspace authority, independent from function effects. */
  readonly workspaceOperations?: (
    node: WorkspaceNode,
    definition: DynamicTaskDefinition,
  ) => ReadonlyArray<"read" | "publish">;
  readonly resolveRuntimeBinding?: (
    node: WorkspaceNode,
    definition: DynamicTaskDefinition,
  ) => WorkspaceNodeRuntimeBinding | undefined;
};

export type RosterTaskContextFactory = ((input: {
  readonly runId: string;
  readonly node: WorkspaceNode;
  readonly definition: DynamicTaskDefinition;
  readonly lease: DynamicTaskHandlerContext["lease"];
}) => Promise<RosterTaskContext> | RosterTaskContext) & {
  /**
   * Required when paired with a durable task graph. Process-local tests may
   * omit the marker; durable production executions fail closed without it.
   */
  readonly durability?: "process-local" | "durable";
};

export const preserveRosterTaskContextDurability = (
  source: RosterTaskContextFactory,
  decorated: RosterTaskContextFactory,
): RosterTaskContextFactory => source.durability
  ? Object.assign(decorated, { durability: source.durability })
  : decorated;

export type RosterPlatformExecutionOptions = {
  readonly runId: string;
  readonly seedTasks: ReadonlyArray<DynamicTaskDefinition>;
  /** Explicit execution authority; production callers must inject their durable control. */
  readonly taskGraph: TaskGraphControl;
  /** Explicit value plane whose durability must cover the task-graph authority. */
  readonly dataReferences: DataReferenceStore;
  /** Required task-fenced shared-workspace plane for every node task. */
  readonly createTaskContext: RosterTaskContextFactory;
  /** Exact repository placement projected into the durable pre-start manifest. */
  readonly contextRepository?: (
    definition: DynamicTaskDefinition,
  ) => TaskRepositoryPlacement | undefined;
  /** Bounded token reservation captured before a paid provider dispatch. */
  readonly providerTokenReserve?: (
    definition: DynamicTaskDefinition,
  ) => number;
  readonly nodeRuntimes?: NodeRuntimeRegistry;
  readonly handlers?: DynamicTaskHandlerRegistry;
  readonly acceptance?: DynamicTaskAcceptanceRegistry;
  readonly nativeExecute?: (input: DynamicTaskHandlerContext & {
    readonly node: WorkspaceNode;
    readonly taskContext: RosterTaskContext;
  }) => Promise<unknown>;
  /**
   * Supplies only provider-neutral inner-loop options for one sanitized node
   * task. Roster constructs every authoritative request field itself.
   */
  readonly executionOptions?: (
    input: {
      readonly runId: string;
      readonly nodeId: string;
      readonly taskId: string;
      readonly capability: string;
      /** Resolved binding runtime kind, or the authored kind when no binding exists. */
      readonly effectiveRuntimeKind: string;
    },
  ) => Pick<
    NodeExecutionRequest<unknown>,
    "attachments" | "onTrajectory" | "onLog" | "onModelOutput"
  > & {
    readonly surface?: Pick<NodeExecutionSurfaceInput, "codeMode">;
    /** Admitted tool-call budget for runtimes that expose functions without code mode. */
    readonly maxFunctionCalls?: number;
  };
  readonly heartbeatMs?: number;
  /** Shared time authority for dispatcher deadlines and lease heartbeats. */
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  /** Observational bounded projection; never participates in graph decisions. */
  readonly onSnapshot?: (snapshot: TaskGraphControlSnapshot) => Promise<void> | void;
  /** Simulator-only cooperative interleaving; it cannot select or mutate graph work. */
  readonly readyBatchRunner?: DynamicTaskReadyBatchRunner;
  /** Content-free function activity; failures are isolated from execution. */
  readonly onFunctionActivity?: (activity: RosterFunctionActivity) => Promise<void> | void;
};

const safeId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized)) throw new Error(`Invalid ${label} "${value}"`);
  return normalized;
};

const immutableFunctionAccess = (
  access: RosterFunctionAccess,
): RosterFunctionAccess => Object.freeze({
  ...(access.functionGrants
    ? { functionGrants: Object.freeze([...access.functionGrants]) }
    : {}),
  ...(access.scopes ? { scopes: Object.freeze([...access.scopes]) } : {}),
  ...(access.allowedEffects
    ? { allowedEffects: Object.freeze([...access.allowedEffects]) }
    : {}),
});

const cloneJson = <Value extends JsonValue>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

const boundedExecutionDescriptorText = (
  value: string,
  label: string,
  maximum: number,
): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
};

type NodeExecutionReferenceProjectionInput = {
  readonly source: string;
  readonly label: string;
  readonly reference: DataReference;
};

const nodeExecutionReferenceLabel = (identity: JsonValue): string =>
  `reference:${hashCanonical(identity)}`;

const taskInputReferenceProjections = (
  manifest: DynamicTaskDefinition["inputs"],
): ReadonlyArray<NodeExecutionReferenceProjectionInput> =>
  manifest.dataReferences.map((reference) => ({
    source: "task-input",
    label: nodeExecutionReferenceLabel({
      scope: "explicit",
      source: "task-input",
      contentHash: reference.contentHash,
    }),
    reference,
  }));

const dependencyReferenceSource = (taskId: string): string => `dependency:${taskId}`;

const dependencyReferenceProjections = (
  taskId: string,
  references: DynamicTaskHandlerContext["dependencyDataReferences"][string] | undefined,
): ReadonlyArray<NodeExecutionReferenceProjectionInput> =>
  (references ?? []).map((entry) => ({
    source: dependencyReferenceSource(taskId),
    label: nodeExecutionReferenceLabel({
      scope: "dependency",
      source: "accepted-task-output",
      taskId,
      outputKey: entry.outputKey,
    }),
    reference: entry.reference,
  }));

const projectNodeExecutionReferences = (
  inputs: ReadonlyArray<NodeExecutionReferenceProjectionInput>,
): ReadonlyArray<NodeExecutionInputReferenceDescriptor> => {
  const projected = inputs.map(({ source, label, reference }) => ({
    source: boundedExecutionDescriptorText(source, "Node execution input source", 240),
    label: boundedExecutionDescriptorText(label, "Node execution input label", 512),
    contentHash: boundedExecutionDescriptorText(
      reference.contentHash,
      "Node execution input contentHash",
      256,
    ),
    mediaType: boundedExecutionDescriptorText(
      reference.mediaType,
      "Node execution input mediaType",
      200,
    ),
    byteLength: reference.byteLength,
  }));
  for (const descriptor of projected) {
    if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0) {
      throw new Error("Node execution input byteLength must be a non-negative safe integer");
    }
  }
  projected.sort((left, right) =>
    left.label.localeCompare(right.label)
    || left.source.localeCompare(right.source)
    || left.contentHash.localeCompare(right.contentHash)
    || left.mediaType.localeCompare(right.mediaType)
    || left.byteLength - right.byteLength);
  if (new Set(projected.map(({ label }) => label)).size !== projected.length) {
    throw new Error("Node execution input descriptor labels must be unique");
  }
  return projected;
};

const encodedDataReferenceValueBytes = (
  value: JsonValue,
  mediaType: string,
): number => {
  const plainText = mediaType.split(";", 1)[0]?.trim().toLowerCase() === "text/plain";
  if (plainText && typeof value !== "string") {
    throw new Error("Resolved text/plain data reference body must be a string");
  }
  return new TextEncoder().encode(
    plainText ? value as string : canonicalize(value),
  ).byteLength;
};

const resolveNodeExecutionReferences = async (
  inputs: ReadonlyArray<NodeExecutionReferenceProjectionInput>,
  projected: ReadonlyArray<NodeExecutionInputReferenceDescriptor>,
  store: DataReferenceStore,
  signal?: AbortSignal,
): Promise<ReadonlyArray<NodeExecutionResolvedDataReference>> => {
  for (const { reference } of inputs) {
    if (!Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0) {
      throw new Error(`Data reference ${reference.referenceId} has an invalid byte length`);
    }
  }
  const referenceByLabel = new Map(inputs.map(({ label, reference }) => [label, reference]));
  const selected: Array<{
    readonly descriptor: NodeExecutionInputReferenceDescriptor;
    readonly reference: DataReference;
  }> = [];
  let selectedBytes = 0;
  for (const descriptor of [...projected].sort((left, right) =>
    Number(right.source === "task-input") - Number(left.source === "task-input")
    || left.label.localeCompare(right.label))) {
    const reference = referenceByLabel.get(descriptor.label);
    if (!reference) {
      throw new Error(`Node execution reference ${descriptor.label} has no admitted host reference`);
    }
    if (
      selected.length >= MAX_NODE_EXECUTION_RESOLVED_DATA_REFERENCES
      || reference.byteLength > MAX_NODE_EXECUTION_RESOLVED_DATA_REFERENCE_BYTES_TOTAL - selectedBytes
    ) {
      continue;
    }
    selected.push({ descriptor, reference });
    selectedBytes += reference.byteLength;
  }
  return Promise.all(selected.map(async ({ descriptor, reference }) => {
    const value = await store.read(reference, { signal });
    if (hashCanonical(value) !== descriptor.contentHash) {
      throw new Error(`Data reference ${reference.referenceId} has a changed content hash`);
    }
    if (encodedDataReferenceValueBytes(value, descriptor.mediaType) !== descriptor.byteLength) {
      throw new Error(`Data reference ${reference.referenceId} has a changed byte length`);
    }
    return {
      ...descriptor,
      value: cloneJson(value),
    };
  }));
};

const projectTaskInputManifest = (
  manifest: DynamicTaskDefinition["inputs"],
  projectedReferences: ReadonlyArray<NodeExecutionInputReferenceDescriptor>,
): NodeExecutionInputManifest => ({
  inputVersions: Object.fromEntries(Object.entries(manifest.inputVersions)
    .sort(([left], [right]) => left.localeCompare(right))),
  dataReferences: projectedReferences.filter(({ source }) => source === "task-input"),
  frontierVersion: manifest.frontierVersion,
  topologyVersion: manifest.topologyVersion,
  catalogVersion: manifest.catalogVersion,
});

const projectDependencyDataReferences = (
  taskId: string,
  projectedReferences: ReadonlyArray<NodeExecutionInputReferenceDescriptor>,
): ReadonlyArray<NodeExecutionInputReferenceDescriptor> =>
  projectedReferences.filter(({ source }) => source === dependencyReferenceSource(taskId));

const projectAcceptedArtifacts = (
  artifacts: ReadonlyArray<AcceptedArtifactReference>,
): ReadonlyArray<NodeExecutionAcceptedArtifactDescriptor> =>
  artifacts
    .map((artifact) => ({
      outputKey: artifact.outputKey,
      kind: artifact.kind,
      contentHash: artifact.contentHash,
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
    }))
    .sort((left, right) =>
      left.outputKey.localeCompare(right.outputKey)
      || left.kind.localeCompare(right.kind)
      || left.contentHash.localeCompare(right.contentHash)
      || left.mediaType.localeCompare(right.mediaType)
      || left.byteLength - right.byteLength);

const objectJson = (
  value: JsonValue,
  label: string,
): Readonly<Record<string, JsonValue>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} requires an object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
};

const optionalStringArray = (
  value: JsonValue | undefined,
  label: string,
): ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as ReadonlyArray<string>;
};

const workspaceTools = (): ReadonlyArray<RosterFunctionTool> => [{
  id: ROSTER_WORKSPACE_READ_FUNCTION_ID,
  version: "1",
  capability: "roster.workspace",
  description: "Read a bounded task-fenced projection of the shared workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kinds: { type: "array", maxItems: 16, items: { type: "string" } },
      subjectIds: { type: "array", maxItems: 128, items: { type: "string" } },
      entryIds: { type: "array", maxItems: 128, items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 512 },
    },
  },
  outputSchema: true,
  effects: ["read"],
}, {
  id: ROSTER_WORKSPACE_PUBLISH_FUNCTION_ID,
  version: "1",
  capability: "roster.workspace",
  description: "Publish one bounded task-fenced shared-workspace entry.",
  inputSchema: {
    type: "object",
    required: ["kind", "mode", "subjectId", "body", "references"],
    additionalProperties: false,
    properties: {
      kind: { type: "string" },
      mode: { enum: ["append", "exclusive"] },
      subjectId: { type: "string", minLength: 1 },
      body: true,
      references: { type: "array", maxItems: 64, items: { type: "string" } },
    },
  },
  outputSchema: true,
  effects: ["write"],
}];

const expansionDescriptor = (capability: string): RosterFunctionDescriptor => ({
  id: ROSTER_EXPAND_FUNCTION_ID,
  version: "1",
  capability,
  description:
    "Atomically replace the active coordinating task with bounded child tasks and one explicit continuation.",
  inputSchema: {
    type: "object",
    required: ["expansionKey", "children", "continuation"],
    additionalProperties: false,
    properties: {
      expansionKey: { type: "string", minLength: 1, maxLength: 200 },
      children: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["taskId", "semanticKey", "nodeId", "capability", "objective"],
          additionalProperties: false,
          properties: {
            taskId: { type: "string", minLength: 1, maxLength: 200 },
            semanticKey: { type: "string", minLength: 1, maxLength: 500 },
            nodeId: { type: "string", minLength: 1, maxLength: 200 },
            capability: { type: "string", minLength: 1, maxLength: 200 },
            objective: { type: "string", minLength: 1, maxLength: 20_000 },
            dependencyTaskIds: {
              type: "array",
              maxItems: 10_000,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
            result: true,
            estimatedCostMicros: { type: "integer", minimum: 0 },
          },
        },
      },
      continuation: {
        type: "object",
        required: ["taskId", "semanticKey", "nodeId", "capability", "objective"],
        additionalProperties: false,
        properties: {
          taskId: { type: "string", minLength: 1, maxLength: 200 },
          semanticKey: { type: "string", minLength: 1, maxLength: 500 },
          nodeId: { type: "string", minLength: 1, maxLength: 200 },
          capability: { type: "string", minLength: 1, maxLength: 200 },
          objective: { type: "string", minLength: 1, maxLength: 20_000 },
          result: true,
          join: true,
          estimatedCostMicros: { type: "integer", minimum: 0 },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["expansionHash", "childTaskIds", "continuationTaskId"],
    additionalProperties: false,
    properties: {
      expansionHash: { type: "string" },
      childTaskIds: { type: "array", items: { type: "string" } },
      continuationTaskId: { type: "string" },
    },
  },
  effects: ["write"],
  requiredScopes: ["roster:graph:expand"],
  idempotency: "required",
  defaultTimeoutMs: 30_000,
});

const consultationDescriptor = (capability: string): RosterFunctionDescriptor => ({
  id: ROSTER_CONSULT_FUNCTION_ID,
  version: "1",
  capability,
  description:
    "Pause the active node turn for bounded questions to eligible peer nodes, then resume with their accepted responses.",
  inputSchema: {
    type: "object",
    required: ["schemaVersion", "turnKey", "question", "recipients", "responseRequirement"],
    additionalProperties: false,
    properties: {
      schemaVersion: { const: ROSTER_NODE_CONSULTATION_SCHEMA_VERSION },
      turnKey: { type: "string", minLength: 1, maxLength: 200 },
      question: { type: "string", minLength: 1, maxLength: 4_000 },
      recipients: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ROSTER_CONSULTATION_RECIPIENTS,
        items: {
          type: "object",
          required: ["nodeId", "capability"],
          additionalProperties: false,
          properties: {
            nodeId: { type: "string", minLength: 1, maxLength: 200 },
            capability: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
      responseRequirement: { enum: ["any", "all"] },
      evidence: {
        type: "array",
        maxItems: 16,
        items: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["expansionHash", "childTaskIds", "continuationTaskId"],
    additionalProperties: false,
    properties: {
      expansionHash: { type: "string" },
      childTaskIds: { type: "array", items: { type: "string" } },
      continuationTaskId: { type: "string" },
    },
  },
  effects: ["write"],
  requiredScopes: ["roster:node:consult"],
  idempotency: "required",
  defaultTimeoutMs: 30_000,
});

const taskCatalogVersion = (directory: RosterFunctionDirectory): string =>
  hashCanonical({
    descriptors: directory.descriptors(),
    providers: directory.providerBindings(),
  });

const resolvedRuntimeBinding = (
  node: WorkspaceNode,
  definition: DynamicTaskDefinition,
  resolve: RosterPlatformDefinition["resolveRuntimeBinding"],
): WorkspaceNodeRuntimeBinding | undefined => {
  const binding = resolve?.(node, definition);
  if (!binding) return undefined;
  if (binding.nodeId !== node.id) {
    throw new Error(
      `Runtime binding for ${binding.nodeId} cannot be snapshotted for workspace node ${node.id}`,
    );
  }
  if (!Number.isSafeInteger(binding.epoch) || binding.epoch < 1) {
    throw new Error(`Workspace node ${node.id} runtime binding epoch must be a positive safe integer`);
  }
  return binding;
};

const definitionWithRuntimeBindingSnapshot = (
  definition: DynamicTaskDefinition,
  registry: DomainRegistry,
  resolve: RosterPlatformDefinition["resolveRuntimeBinding"],
): DynamicTaskDefinition => {
  const node = registry.node(definition.nodeId);
  const epoch = resolvedRuntimeBinding(node, definition, resolve)?.epoch ?? 0;
  if (definition.runtimeBindingEpoch === epoch) return definition;
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
    runtimeBindingEpoch: epoch,
    retry: definition.retry,
    timeoutMs: definition.timeoutMs,
    sideEffect: definition.sideEffect,
    estimatedCostMicros: definition.estimatedCostMicros,
    ...(definition.parentTaskId ? { parentTaskId: definition.parentTaskId } : {}),
  });
};

const initialRuntimeBindingSnapshots = (
  nodes: ReadonlyArray<WorkspaceNode>,
  seedTasks: ReadonlyArray<DynamicTaskDefinition>,
  resolve: RosterPlatformDefinition["resolveRuntimeBinding"],
): ReadonlyArray<WorkspaceNodeRuntimeBinding> => {
  const topologyVersion = seedTasks[0]?.inputs.topologyVersion;
  if (!topologyVersion) return [];
  const selectedByNode = new Map<string, WorkspaceNodeRuntimeBinding[]>();
  for (const definition of seedTasks) {
    const node = nodes.find((candidate) => candidate.id === definition.nodeId);
    if (!node) throw new Error(`Roster seed task ${definition.taskId} references unknown node ${definition.nodeId}`);
    const selected = resolvedRuntimeBinding(node, definition, resolve);
    if (selected) {
      const bindings = selectedByNode.get(node.id) ?? [];
      bindings.push(selected);
      selectedByNode.set(node.id, bindings);
    }
  }
  return nodes.map((node) => {
    const selected = selectedByNode.get(node.id) ?? [];
    const first = selected[0];
    if (first) {
      const selectedRuntime = hashCanonical({
        runtime: first.runtime,
        sandboxId: first.sandboxId ?? "",
        sessionId: first.sessionId ?? "",
        placement: first.placement ?? null,
      });
      const conflicting = selected.find((binding) => hashCanonical({
        runtime: binding.runtime,
        sandboxId: binding.sandboxId ?? "",
        sessionId: binding.sessionId ?? "",
        placement: binding.placement ?? null,
      }) !== selectedRuntime);
      if (conflicting) {
        throw new Error(
          `Roster seed tasks select conflicting initial runtime bindings for node ${node.id}`,
        );
      }
      return {
        ...first,
        epoch: 1,
        topologyVersion,
      };
    }
    return createWorkspaceNodeRuntimeBinding({
      nodeId: node.id,
      runtime: node.runtime,
      epoch: 1,
      topologyVersion,
    });
  });
};

const assertExecutionPlaneDurability = (
  taskGraph: TaskGraphControl,
  dataReferences: DataReferenceStore,
  createTaskContext: RosterTaskContextFactory,
): void => {
  if (taskGraph.durability === "durable" && dataReferences.durability !== "durable") {
    throw new Error(
      "Durable TaskGraphControl requires a durable DataReferenceStore so accepted references survive replay",
    );
  }
  if (taskGraph.durability === "durable" && createTaskContext.durability !== "durable") {
    throw new Error(
      "Durable TaskGraphControl requires a durable task-context workspace so shared context survives replay",
    );
  }
};

const assertExecutionPlanes = (
  options: RosterPlatformExecutionOptions,
): void => {
  if (!options.taskGraph) {
    throw new Error("Roster platform execution requires an explicit TaskGraphControl");
  }
  if (!options.dataReferences) {
    throw new Error("Roster platform execution requires an explicit DataReferenceStore");
  }
  if (typeof options.createTaskContext !== "function") {
    throw new Error("Roster platform execution requires a task-fenced createTaskContext plane");
  }
};

const assertDurableTriggerReplaySafety = (
  taskGraph: TaskGraphControl,
  triggers: ReadonlyArray<RosterTriggerDefinition>,
): void => {
  if (taskGraph.durability !== "durable") return;
  const unsafe = triggers.find((trigger) =>
    trigger.enabled && trigger.target.action.kind !== "enqueue");
  if (unsafe) {
    throw new Error(
      `Durable Roster execution requires trigger ${unsafe.triggerId} to enqueue durable work; `
      + `${unsafe.target.action.kind} delivery deduplication is process-local`,
    );
  }
};

const assertTaskContextFence = (input: {
  readonly runId: string;
  readonly node: WorkspaceNode;
  readonly definition: DynamicTaskDefinition;
  readonly lease: DynamicTaskHandlerContext["lease"];
  readonly context: RosterTaskContext;
}): void => {
  const fence = input.context.fence;
  if (
    input.context.node.id !== input.node.id
    || fence.runId !== input.runId
    || fence.taskId !== input.definition.taskId
    || fence.nodeId !== input.node.id
    || fence.fence !== BigInt(input.lease.fence)
    || fence.frontierVersion !== input.definition.inputs.frontierVersion
    || fence.topologyVersion !== input.definition.inputs.topologyVersion
    || fence.catalogVersion !== input.definition.inputs.catalogVersion
    || fence.runtimeBindingEpoch !== input.definition.runtimeBindingEpoch
    || hashCanonical(fence.inputVersions) !== hashCanonical(input.definition.inputs.inputVersions)
  ) {
    throw new Error(
      `Roster task context for ${input.definition.taskId} does not match its exact execution fence`,
    );
  }
};

const materializeExpansion = (input: {
  readonly parent: DynamicTaskDefinition;
  readonly proposal: RosterExpansionProposal;
  readonly registry: DomainRegistry;
  readonly catalogVersion: string;
  readonly resolveRuntimeBinding: RosterPlatformDefinition["resolveRuntimeBinding"];
}): {
  readonly definitions: ReadonlyArray<DynamicTaskDefinition>;
  readonly continuationTaskId: string;
} => {
  if (input.proposal.children.length < 1) {
    throw new Error("Roster expansion requires at least one child task");
  }
  const proposals = [...input.proposal.children, input.proposal.continuation];
  const childTaskIds = new Set(
    input.proposal.children.map((proposal) => safeId(proposal.taskId, "expanded child task id")),
  );
  for (const proposed of proposals) {
    input.registry.assertNodeAssignment(proposed.nodeId, proposed.capability);
  }
  for (const proposed of input.proposal.children) {
    const dependencies = proposed.dependencyTaskIds ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`Expanded task ${proposed.taskId} has duplicate dependencies`);
    }
    for (const dependencyTaskId of dependencies) {
      const dependencyId = safeId(dependencyTaskId, "expanded dependency task id");
      if (!childTaskIds.has(dependencyId)) {
        throw new Error(
          `Expanded task ${proposed.taskId} depends on ${dependencyId} outside its atomic expansion`,
        );
      }
      if (dependencyId === proposed.taskId) {
        throw new Error(`Expanded task ${proposed.taskId} cannot depend on itself`);
      }
    }
  }
  const definitionFor = (
    proposed: RosterExpansionTaskProposal,
    dependencies: DynamicTaskDefinition["dependencies"],
    join: TaskJoinPolicy,
  ): DynamicTaskDefinition => definitionWithRuntimeBindingSnapshot(
    createDynamicTaskDefinition({
      taskId: safeId(proposed.taskId, "expanded task id"),
      semanticKey: proposed.semanticKey,
      nodeId: proposed.nodeId,
      capability: proposed.capability,
      objective: proposed.objective,
      handler: ROSTER_NODE_TASK_HANDLER,
      acceptance: input.parent.acceptance,
      result: proposed.result ?? defaultTaskResultContract(),
      dependencies,
      join,
      inputs: {
        ...input.parent.inputs,
        catalogVersion: input.catalogVersion,
      },
      runtimeBindingEpoch: 0,
      retry: input.parent.retry,
      timeoutMs: input.parent.timeoutMs,
      sideEffect: "pure",
      estimatedCostMicros: proposed.estimatedCostMicros ?? input.parent.estimatedCostMicros,
      parentTaskId: input.parent.taskId,
    }),
    input.registry,
    input.resolveRuntimeBinding,
  );
  const children = input.proposal.children.map((proposal) =>
    definitionFor(
      proposal,
      (proposal.dependencyTaskIds ?? []).map((taskId) => ({
        taskId,
        condition: "accepted" as const,
      })),
      { kind: "all-success" },
    ));
  const continuation = definitionFor(
    input.proposal.continuation,
    children.map((child) => ({
      taskId: child.taskId,
      condition: input.proposal.continuation.join?.kind === "all-terminal"
        ? "terminal" as const
        : "accepted" as const,
    })),
    input.proposal.continuation.join ?? { kind: "all-success" },
  );
  return {
    definitions: [...children, continuation],
    continuationTaskId: continuation.taskId,
  };
};

const materializeConsultation = (input: {
  readonly parent: DynamicTaskDefinition;
  readonly proposal: RosterNodeConsultation;
  readonly snapshot: TaskGraphControlSnapshot;
  readonly registry: DomainRegistry;
  readonly policy: RosterNodeConsultationPolicy;
  readonly catalogVersion: string;
  readonly resolveRuntimeBinding: RosterPlatformDefinition["resolveRuntimeBinding"];
}): {
  readonly definitions: ReadonlyArray<DynamicTaskDefinition>;
  readonly continuationTaskId: string;
  readonly expansionKey: string;
} => {
  if (input.proposal.schemaVersion !== ROSTER_NODE_CONSULTATION_SCHEMA_VERSION) {
    throw new Error("Roster consultation uses an unsupported schema version");
  }
  const turnKey = boundedExecutionDescriptorText(input.proposal.turnKey, "Consultation turn key", 200);
  const question = boundedExecutionDescriptorText(input.proposal.question, "Consultation question", 4_000);
  const evidence = [...new Set((input.proposal.evidence ?? []).map((entry) =>
    boundedExecutionDescriptorText(entry, "Consultation evidence", 500)))].sort();
  const configuredMaximum = input.policy.maxRecipients ?? 2;
  if (
    !Number.isSafeInteger(configuredMaximum)
    || configuredMaximum < 1
    || configuredMaximum > MAX_ROSTER_CONSULTATION_RECIPIENTS
  ) {
    throw new Error(
      `Roster consultation maxRecipients must be between 1 and ${MAX_ROSTER_CONSULTATION_RECIPIENTS}`,
    );
  }
  if (
    input.proposal.recipients.length < 1
    || input.proposal.recipients.length > configuredMaximum
  ) {
    throw new Error(`Roster consultation exceeds maxRecipients=${configuredMaximum}`);
  }
  const author = input.registry.node(input.parent.nodeId);
  const recipientIds = new Set<string>();
  const recipients = input.proposal.recipients.map((proposed) => {
    const nodeId = safeId(proposed.nodeId, "consultation recipient node id");
    const capability = safeId(proposed.capability, "consultation recipient capability");
    if (recipientIds.has(nodeId)) throw new Error(`Roster consultation repeats recipient ${nodeId}`);
    recipientIds.add(nodeId);
    if (nodeId === author.id) throw new Error("A Roster node cannot consult itself");
    const recipient = input.registry.assertNodeAssignment(nodeId, capability);
    if (!input.policy.canConsult({ author, recipient, parent: input.parent, capability })) {
      throw new Error(`Roster node ${author.id} cannot consult ${recipient.id} for ${capability}`);
    }
    return { node: recipient, capability };
  }).sort((left, right) => left.node.id.localeCompare(right.node.id)
    || left.capability.localeCompare(right.capability));
  // `any` is a semantic selection policy, not a race between workers. Pick
  // the first canonical recipient before scheduling so completion order can
  // never decide which peer's answer enters the continuation.
  const selectedRecipients = input.proposal.responseRequirement === "any"
    ? recipients.slice(0, 1)
    : recipients;

  const unresolvedDependency = input.parent.dependencies.find(({ taskId }) =>
    taskGraphEffectiveTask(input.snapshot, taskId)?.status !== "accepted");
  if (unresolvedDependency) {
    throw new Error(
      `Roster consultation requires accepted parent dependency ${unresolvedDependency.taskId}`,
    );
  }
  const consultationIdentity = {
    parentTaskId: input.parent.taskId,
    parentDefinitionHash: input.parent.definitionHash,
    turnKey,
    question,
    recipients: recipients.map(({ node, capability }) => ({ nodeId: node.id, capability })),
    responseRequirement: input.proposal.responseRequirement,
    evidence,
  };
  const consultationHash = hashCanonical(consultationIdentity);
  const originalDependencies = input.parent.dependencies.map(({ taskId }) => ({
    taskId,
    condition: "accepted" as const,
  }));
  const childDefinitions = selectedRecipients.map(({ node, capability }) =>
    definitionWithRuntimeBindingSnapshot(createDynamicTaskDefinition({
      taskId: `consult_${consultationHash.slice(0, 18)}_${hashCanonical(node.id).slice(0, 8)}`,
      semanticKey: `consult:${consultationHash.slice(0, 28)}:${hashCanonical(node.id).slice(0, 12)}`,
      nodeId: node.id,
      capability,
      objective: [
        `${node.name}: answer a bounded peer consultation from ${author.name}.`,
        `Question: ${question}`,
        evidence.length ? `Evidence references: ${evidence.join(", ")}.` : "",
        `The originating objective is: ${input.parent.objective}`,
        "Use the accepted inputs and dependency evidence supplied by Roster. Return a concise evidence-backed response to the asking peer.",
        "If a missing fact genuinely requires another eligible specialist, you may open one further bounded consultation; otherwise answer directly.",
      ].filter(Boolean).join(" "),
      handler: ROSTER_NODE_TASK_HANDLER,
      acceptance: input.parent.acceptance,
      result: { mode: "text", outputKey: "peer_response" },
      dependencies: originalDependencies,
      join: { kind: "all-success" },
      inputs: {
        ...input.parent.inputs,
        catalogVersion: input.catalogVersion,
      },
      runtimeBindingEpoch: 0,
      retry: input.parent.retry,
      timeoutMs: input.parent.timeoutMs,
      sideEffect: "pure",
      estimatedCostMicros: input.parent.estimatedCostMicros,
      parentTaskId: input.parent.taskId,
    }), input.registry, input.resolveRuntimeBinding));
  const continuationTaskId = `continue_${consultationHash.slice(0, 28)}`;
  const continuationDependencies = [
    ...originalDependencies,
    ...childDefinitions.map((definition) => ({
      taskId: definition.taskId,
      condition: "accepted" as const,
    })),
  ];
  const continuationJoin: TaskJoinPolicy = { kind: "all-success" };
  const continuation = definitionWithRuntimeBindingSnapshot(createDynamicTaskDefinition({
    taskId: continuationTaskId,
    semanticKey: `consult:continue:${consultationHash.slice(0, 28)}`,
    nodeId: author.id,
    capability: input.parent.capability,
    objective: [
      `Resume the original objective after the bounded peer consultation: ${input.parent.objective}`,
      `Your question was: ${question}`,
      "Consume the accepted peer_response dependencies as direct answers, reconcile them with the original evidence, and complete the original output contract.",
      "You may continue the discussion only when another eligible peer has a concrete unresolved question; do not repeat a settled consultation.",
    ].join(" "),
    handler: ROSTER_NODE_TASK_HANDLER,
    acceptance: input.parent.acceptance,
    result: input.parent.result,
    dependencies: continuationDependencies,
    join: continuationJoin,
    inputs: {
      ...input.parent.inputs,
      catalogVersion: input.catalogVersion,
    },
    runtimeBindingEpoch: 0,
    retry: input.parent.retry,
    timeoutMs: input.parent.timeoutMs,
    sideEffect: input.parent.sideEffect,
    estimatedCostMicros: input.parent.estimatedCostMicros,
    parentTaskId: input.parent.taskId,
  }), input.registry, input.resolveRuntimeBinding);
  return {
    definitions: [...childDefinitions, continuation],
    continuationTaskId,
    expansionKey: `consult_${consultationHash.slice(0, 28)}`,
  };
};

const functionMetadataTaskId = (
  metadata: Readonly<Record<string, JsonValue>> | undefined,
): string => {
  const taskId = metadata?.roster_task_id;
  if (typeof taskId !== "string") {
    throw new Error("Roster graph expansion requires an active task identity");
  }
  return taskId;
};

export class RosterPlatformExecution {
  readonly taskGraph: TaskGraphControl;
  readonly functions: RosterFunctionDirectory;
  readonly triggers: RosterTriggerRouter;
  readonly dataReferences: DataReferenceStore;
  readonly pipelines: WorkerPipelineExecutor;

  private readonly dispatcher: DynamicTaskDispatcher;
  private readonly initialized: Promise<TaskGraphControlSnapshot>;

  constructor(
    readonly platform: RosterPlatform,
    readonly runId: string,
    options: RosterPlatformExecutionOptions,
  ) {
    assertExecutionPlanes(options);
    assertExecutionPlaneDurability(
      options.taskGraph,
      options.dataReferences,
      options.createTaskContext,
    );
    assertDurableTriggerReplaySafety(options.taskGraph, platform.definition.triggers ?? []);
    const runtimes = options.nodeRuntimes ?? (() => {
      const nonNative = platform.definition.nodes
        .filter((node) => node.runtime.kind !== "roster-native")
        .map((node) => `${node.id}:${node.runtime.kind}`);
      if (nonNative.length > 0 || platform.definition.resolveRuntimeBinding) {
        const detail = nonNative.length > 0
          ? ` for ${nonNative.join(", ")}`
          : " when runtime bindings are resolved dynamically";
        throw new Error(`Roster platform execution requires an explicit NodeRuntimeRegistry${detail}`);
      }
      return createDefaultNodeRuntimeRegistry();
    })();
    const nativeRuntimes = createDefaultNodeRuntimeRegistry();
    this.taskGraph = options.taskGraph;
    const runtimeBindings = this.taskGraph.durability === "durable"
      ? initialRuntimeBindingSnapshots(
          platform.definition.nodes,
          options.seedTasks,
          platform.definition.resolveRuntimeBinding,
        )
      : undefined;
    const bindingEpochByNode = new Map(runtimeBindings?.map((binding) => [
      binding.nodeId,
      binding.epoch,
    ]) ?? []);
    const seedTasks = options.seedTasks.map((definition) => {
      const snapshotted = definitionWithRuntimeBindingSnapshot(
        definition,
        platform.registry,
        platform.definition.resolveRuntimeBinding,
      );
      const initialEpoch = bindingEpochByNode.get(definition.nodeId);
      return initialEpoch === undefined || initialEpoch === snapshotted.runtimeBindingEpoch
        ? snapshotted
        : createDynamicTaskDefinition({
            taskId: snapshotted.taskId,
            semanticKey: snapshotted.semanticKey,
            nodeId: snapshotted.nodeId,
            capability: snapshotted.capability,
            objective: snapshotted.objective,
            handler: snapshotted.handler,
            acceptance: snapshotted.acceptance,
            result: snapshotted.result,
            dependencies: snapshotted.dependencies,
            join: snapshotted.join,
            inputs: snapshotted.inputs,
            runtimeBindingEpoch: initialEpoch,
            retry: snapshotted.retry,
            timeoutMs: snapshotted.timeoutMs,
            sideEffect: snapshotted.sideEffect,
            estimatedCostMicros: snapshotted.estimatedCostMicros,
            ...(snapshotted.parentTaskId ? { parentTaskId: snapshotted.parentTaskId } : {}),
          });
    });
    this.initialized = this.taskGraph.initialize({
      runId,
      policy: platform.definition.policy,
      seedTasks,
      ...(options.contextRepository && seedTasks[0]
        ? { repository: options.contextRepository(seedTasks[0]) }
        : {}),
      nodes: platform.definition.nodes,
      ...(runtimeBindings ? { runtimeBindings } : {}),
    });
    // Construction and the first dispatch may be separated by other awaited
    // setup. Observe initialization immediately so a fail-closed adapter
    // rejection is reported through the execution API instead of becoming an
    // unhandled process-level rejection.
    void this.initialized.catch(() => undefined);
    this.dataReferences = options.dataReferences;
    const dispatchOwner = `roster-platform:${runId}`;
    this.functions = platform.createFunctionDirectory(
      this.taskGraph,
      this.dataReferences,
      dispatchOwner,
    );
    this.triggers = platform.createTriggerRouter(this.functions);
    this.pipelines = new WorkerPipelineExecutor({
      directory: this.functions,
      store: this.dataReferences,
      limits: platform.definition.pipelineLimits,
    });
    const handlers = options.handlers ?? new DynamicTaskHandlerRegistry();
    const trace = createRootExecutionTrace({
      platformId: platform.definition.id,
      platformVersion: platform.definition.version,
      runId,
    });
    handlers.register(ROSTER_NODE_TASK_HANDLER, async (context) => {
      const node = platform.registry.node(context.definition.nodeId);
      const binding = resolvedRuntimeBinding(
        node,
        context.definition,
        platform.definition.resolveRuntimeBinding,
      );
      // A durable initializer persists the node-authored runtime as epoch one.
      // When no replacement resolver applies, the admitted task snapshot is
      // the exact binding authority selected before execution.
      const currentBindingEpoch = binding?.epoch ?? context.definition.runtimeBindingEpoch;
      if (currentBindingEpoch !== context.definition.runtimeBindingEpoch) {
        throw new Error(
          `Roster task ${context.definition.taskId} runtime binding epoch is stale: `
          + `snapshotted ${context.definition.runtimeBindingEpoch}, current ${currentBindingEpoch}`,
        );
      }
      const task = {
        taskId: context.definition.taskId,
        nodeId: context.definition.nodeId,
        capability: context.definition.capability,
        objective: context.definition.objective,
        ...(context.definition.parentTaskId
          ? { parentTaskId: context.definition.parentTaskId }
          : {}),
        inputVersions: context.definition.inputs.inputVersions,
      };
      const executionGrant = context.executionGrant;
      const executionAccess = immutableFunctionAccess(executionGrant.functionAccess);
      const plane = createRosterFunctionExecutionPlane({
        directory: this.functions,
        access: () => executionAccess,
        pipeline: {
          store: this.dataReferences,
          limits: platform.definition.pipelineLimits,
        },
        ...(options.onFunctionActivity
          ? { onActivity: async (activity) => options.onFunctionActivity?.(activity) }
          : {}),
      });
      const admittedTaskContext = await options.createTaskContext({
        runId,
        node,
        definition: context.definition,
        lease: context.lease,
      });
      const taskContext: RosterTaskContext = {
        ...admittedTaskContext,
        readWorkspace: async (selector) => {
          assertTaskExecutionGrantWorkspaceOperation(executionGrant, "read");
          return admittedTaskContext.readWorkspace(selector);
        },
        publish: async (entry) => {
          assertTaskExecutionGrantWorkspaceOperation(executionGrant, "publish");
          return admittedTaskContext.publish(entry);
        },
      };
      const dependencyEntries = Object.entries(context.dependencyOutcomes)
        .sort(([left], [right]) => left.localeCompare(right));
      const effectiveRuntime = binding?.runtime ?? node.runtime;
      const referenceProjectionInputs = [
        ...taskInputReferenceProjections(context.definition.inputs),
        ...dependencyEntries.flatMap(([taskId]) =>
          dependencyReferenceProjections(
            taskId,
            context.dependencyDataReferences[taskId],
          )),
      ];
      const projectedReferences = projectNodeExecutionReferences(referenceProjectionInputs);
      const resolvedReferences = effectiveRuntime.kind === "roster-native"
        ? []
        : await resolveNodeExecutionReferences(
            referenceProjectionInputs,
            projectedReferences,
            this.dataReferences,
            context.signal,
          );
      const executionInputs = projectTaskInputManifest(
        context.definition.inputs,
        projectedReferences,
      );
      const resolvedInputReferences = resolvedReferences
        .filter(({ source }) => source === "task-input");
      const resolvedLabels = new Set(resolvedReferences.map(({ label }) => label));
      const omittedInputReferenceCount = executionInputs.dataReferences
        .filter(({ label }) => !resolvedLabels.has(label))
        .length;
      const executionDependencies = Object.fromEntries(
        dependencyEntries
          .map(([taskId, outcome]) => [
            taskId,
            outcome ? {
              outcomeId: outcome.outcomeId,
              artifacts: projectAcceptedArtifacts(outcome.artifacts),
              dataReferences: projectDependencyDataReferences(
                taskId,
                projectedReferences,
              ),
              resolvedDataReferences: resolvedReferences.filter(
                ({ source }) => source === dependencyReferenceSource(taskId),
              ),
              omittedDataReferenceCount: projectDependencyDataReferences(
                taskId,
                projectedReferences,
              ).filter(({ label }) => !resolvedLabels.has(label)).length,
            } : null,
          ]),
      );
      assertTaskContextFence({
        runId,
        node,
        definition: context.definition,
        lease: context.lease,
        context: taskContext,
      });
      const planeTools = plane.functionTools(node, task);
      const planeInvoker = plane.functionInvoker(node, task);
      const invokeFunction: NodeExecutionFunctionInvoker = async (invocation, control) => {
        assertTaskExecutionGrantTool(executionGrant, invocation.functionId);
        if (
          invocation.functionId !== ROSTER_WORKSPACE_READ_FUNCTION_ID
          && invocation.functionId !== ROSTER_WORKSPACE_PUBLISH_FUNCTION_ID
        ) {
          return planeInvoker(invocation, control);
        }
        if (invocation.action && invocation.action.kind !== "await") {
          throw new Error("Shared-workspace functions must be awaited");
        }
        const value = objectJson(invocation.value, invocation.functionId);
        if (invocation.functionId === ROSTER_WORKSPACE_READ_FUNCTION_ID) {
          const limit = value.limit;
          if (
            limit !== undefined
            && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 512)
          ) {
            throw new Error("Shared-workspace read limit must be between 1 and 512");
          }
          const projection = await taskContext.readWorkspace({
            ...(optionalStringArray(value.kinds, "Shared-workspace kinds")
              ? { kinds: optionalStringArray(value.kinds, "Shared-workspace kinds") as WorkspaceEntryKind[] }
              : {}),
            ...(optionalStringArray(value.subjectIds, "Shared-workspace subjectIds")
              ? { subjectIds: optionalStringArray(value.subjectIds, "Shared-workspace subjectIds") }
              : {}),
            ...(optionalStringArray(value.entryIds, "Shared-workspace entryIds")
              ? { entryIds: optionalStringArray(value.entryIds, "Shared-workspace entryIds") }
              : {}),
            ...(limit === undefined ? {} : { limit: Number(limit) }),
          });
          return {
            status: "completed",
            functionId: invocation.functionId,
            providerId: "roster-workspace",
            output: cloneJson(projection as unknown as JsonValue),
          };
        }
        const kind = value.kind;
        const mode = value.mode;
        const subjectId = value.subjectId;
        const references = optionalStringArray(value.references, "Shared-workspace references");
        if (
          typeof kind !== "string"
          || typeof mode !== "string"
          || typeof subjectId !== "string"
          || value.body === undefined
          || !references
        ) {
          throw new Error("Shared-workspace publish input is incomplete");
        }
        const published = await taskContext.publish({
          kind: kind as WorkspaceEntryKind,
          mode: mode as WorkspaceEntryMode,
          subjectId,
          body: value.body,
          references,
        });
        return {
          status: "completed",
          functionId: invocation.functionId,
          providerId: "roster-workspace",
          output: cloneJson({
            entry: published.entry,
            updateId: published.updateId,
          } as unknown as JsonValue),
        };
      };
      const innerLoopOptions = options.executionOptions?.({
        runId,
        nodeId: node.id,
        taskId: task.taskId,
        capability: task.capability,
        effectiveRuntimeKind: effectiveRuntime.kind,
      }) ?? {};
      const executionSkills = platform.executionSkills({
        runId,
        nodeId: node.id,
        nodeCapabilities: node.capabilities,
        taskId: task.taskId,
        capability: task.capability,
        handlerKind: context.definition.handler.kind,
        effectiveRuntimeKind: effectiveRuntime.kind,
      });
      const consultationPolicy = platform.definition.consultation;
      const eligiblePeers = consultationPolicy
        && executionGrant.functionAccess.functionGrants.includes(ROSTER_CONSULT_FUNCTION_ID)
        ? platform.registry.pack.nodes.flatMap((candidate) => {
            if (candidate.id === node.id) return [];
            const capabilities = candidate.capabilities.filter((capability) =>
              consultationPolicy.canConsult({
                author: node,
                recipient: candidate,
                parent: context.definition,
                capability,
              }));
            if (capabilities.length === 0) return [];
            const role = candidate.metadata?.role;
            const specialty = candidate.metadata?.specialty;
            return [{
              nodeId: candidate.id,
              name: candidate.name,
              capabilities,
              ...(typeof role === "string" ? { role } : {}),
              ...(typeof specialty === "string" ? { specialty } : {}),
            }];
          })
        : [];
      const innerLoopCodeMode = innerLoopOptions.surface?.codeMode;
      const grantedToolIds = new Set(executionGrant.surface.tools.map(({ id }) => id));
      const executionRequest: NodeExecutionRequest<unknown> = {
        runId,
        node,
        binding,
        task,
        grant: executionGrant,
        input: {
          objective: context.definition.objective,
          inputs: cloneJson({
            ...executionInputs,
            resolvedDataReferences: resolvedInputReferences,
            omittedDataReferenceCount: omittedInputReferenceCount,
          } as unknown as JsonValue),
          dependencies: cloneJson(executionDependencies as unknown as JsonValue),
          ...(eligiblePeers.length ? {
            eligiblePeers: cloneJson(eligiblePeers as unknown as JsonValue),
          } : {}),
        },
        resultContract: context.definition.result,
        trace: createChildExecutionTrace(trace, {
          taskId: context.definition.taskId,
          attempt: context.attempt,
        }),
        surface: {
          ...(executionSkills.length ? { skills: executionSkills } : {}),
          tools: [...planeTools, ...workspaceTools()].filter(({ id }) => grantedToolIds.has(id)),
          workspace: {
            workspaceId: runId,
            inputs: executionInputs,
          },
          ...(innerLoopCodeMode
            ? { codeMode: innerLoopCodeMode }
            : {}),
        },
        invokeFunction,
        attempt: context.attempt,
        timeoutMs: context.definition.timeoutMs,
        signal: context.signal,
        ...(innerLoopOptions.attachments ? { attachments: innerLoopOptions.attachments } : {}),
        ...(innerLoopOptions.onTrajectory ? { onTrajectory: innerLoopOptions.onTrajectory } : {}),
        ...(innerLoopOptions.onLog ? { onLog: innerLoopOptions.onLog } : {}),
        ...(innerLoopOptions.onModelOutput ? { onModelOutput: innerLoopOptions.onModelOutput } : {}),
        onUsage: context.reportUsage,
        execute: async () => {
          if (!options.nativeExecute) {
            throw new Error(`Roster-native task ${context.definition.taskId} has no native executor`);
          }
          return options.nativeExecute({
            ...context,
            node,
            taskContext,
          });
        },
      };
      const executionRuntimes = effectiveRuntime.kind === "roster-native"
        ? nativeRuntimes
        : runtimes;
      if (context.definition.estimatedCostMicros > 0) {
        const metadataModel = effectiveRuntime.metadata?.model;
        const model = typeof metadataModel === "string"
          ? metadataModel
          : effectiveRuntime.profile ?? effectiveRuntime.kind;
        const reservedTokens = executionGrant.budgets.maxTokens;
        if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 1 || reservedTokens > 1_000_000) {
          throw new Error(
            `Roster task ${context.definition.taskId} provider token reserve is outside 1..1000000`,
          );
        }
        await this.taskGraph.markProviderCallDispatched?.({
          lease: context.lease,
          provider: effectiveRuntime.kind,
          model,
          reservedTokens,
        });
      }
      return executionRuntimes.execute(executionRequest);
    });
    handlers.register(ROSTER_FUNCTION_TASK_HANDLER, async (context) => {
      const reference = context.definition.inputs.dataReferences[0];
      const functionId = reference?.metadata?.functionId;
      if (!reference || typeof functionId !== "string") {
        throw new Error(`Roster function task ${context.definition.taskId} has no function input reference`);
      }
      const node = platform.registry.node(context.definition.nodeId);
      const value = await this.dataReferences.read(reference, { signal: context.signal });
      return this.functions.invoke({
        node,
        functionId,
        value,
        action: { kind: "await" },
        access: context.executionGrant.functionAccess,
        timeoutMs: context.definition.timeoutMs,
        signal: context.signal,
        metadata: {
          roster_run_id: runId,
          roster_task_id: context.definition.taskId,
        },
      });
    });
    this.dispatcher = new DynamicTaskDispatcher({
      runId,
      control: this.taskGraph,
      handlers,
      acceptance: options.acceptance ?? createDefaultDynamicTaskAcceptanceRegistry(),
      dataReferences: this.dataReferences,
      owner: dispatchOwner,
      heartbeatMs: options.heartbeatMs,
      clock: options.clock,
      signal: options.signal,
      contextRepository: options.contextRepository,
      resolveRuntimeBinding: (definition) => resolvedRuntimeBinding(
        platform.registry.node(definition.nodeId),
        definition,
        platform.definition.resolveRuntimeBinding,
      ),
      createExecutionGrant: ({ definition, lease, policy }) => {
        const node = platform.registry.node(definition.nodeId);
        const binding = resolvedRuntimeBinding(
          node,
          definition,
          platform.definition.resolveRuntimeBinding,
        );
        const effectiveRuntime = binding?.runtime ?? node.runtime;
        const task = {
          taskId: definition.taskId,
          nodeId: definition.nodeId,
          capability: definition.capability,
          objective: definition.objective,
          ...(definition.parentTaskId ? { parentTaskId: definition.parentTaskId } : {}),
          inputVersions: definition.inputs.inputVersions,
        };
        const access = immutableFunctionAccess(platform.access(node, definition));
        const plane = createRosterFunctionExecutionPlane({
          directory: this.functions,
          access: () => access,
          pipeline: {
            store: this.dataReferences,
            limits: platform.definition.pipelineLimits,
          },
        });
        const operations = platform.workspaceOperations(node, definition, access);
        const projectedWorkspaceTools = workspaceTools().filter(({ id }) =>
          id === ROSTER_WORKSPACE_READ_FUNCTION_ID
            ? operations.includes("read")
            : operations.includes("publish"));
        const projectedFunctionTools = (access.functionGrants?.length ?? 0) > 0
          || operations.length > 0
          ? plane.functionTools(node, task)
          : [];
        const selectedSkills = platform.executionSkills({
          runId,
          nodeId: node.id,
          nodeCapabilities: node.capabilities,
          taskId: task.taskId,
          capability: task.capability,
          handlerKind: definition.handler.kind,
          effectiveRuntimeKind: effectiveRuntime.kind,
        });
        const innerLoopOptions = options.executionOptions?.({
          runId,
          nodeId: node.id,
          taskId: task.taskId,
          capability: task.capability,
          effectiveRuntimeKind: effectiveRuntime.kind,
        }) ?? {};
        const codeMode = createNodeExecutionCodeMode(innerLoopOptions.surface?.codeMode);
        if (codeMode && innerLoopOptions.maxFunctionCalls !== undefined) {
          throw new Error(
            `Roster task ${definition.taskId} cannot override maxFunctionCalls outside its code-mode surface`,
          );
        }
        const maxFunctionCalls = innerLoopOptions.maxFunctionCalls ?? codeMode?.maxFunctionCalls ?? 1;
        const reservedTokens = definition.estimatedCostMicros > 0
          ? options.providerTokenReserve?.(definition) ?? 32_768
          : policy.maxTokens;
        if (
          !Number.isSafeInteger(reservedTokens)
          || reservedTokens < 0
          || (
            definition.estimatedCostMicros > 0
            && (reservedTokens < 1 || reservedTokens > 1_000_000)
          )
        ) {
          throw new Error(
            `Roster task ${definition.taskId} provider token reserve is outside its admitted bound`,
          );
        }
        return createTaskExecutionGrant({
          runId,
          definition,
          attempt: lease.attempt,
          fence: lease.fence,
          policyVersion: platform.definition.policyVersion,
          policy: {
            maxTokens: Math.min(policy.maxTokens, reservedTokens),
            maxCostMicros: definition.estimatedCostMicros > 0
              ? Math.min(policy.maxCostMicros, definition.estimatedCostMicros)
              : 0,
          },
          functionAccess: access,
          workspaceOperations: operations,
          allowGraphExpansion: Boolean(access.functionGrants?.some((functionId) =>
            functionId === ROSTER_EXPAND_FUNCTION_ID || functionId === ROSTER_CONSULT_FUNCTION_ID)),
          skills: selectedSkills.map(({ id, contentHash }) => ({ id, contentHash })),
          tools: [...projectedFunctionTools, ...projectedWorkspaceTools],
          ...(codeMode ? { codeMode } : {}),
          maxFunctionCalls,
          rationale: `Deterministic ${effectiveRuntime.kind} task admission for ${definition.capability}.`,
        });
      },
      onSnapshot: options.onSnapshot,
      readyBatchRunner: options.readyBatchRunner,
    });
  }

  async dispatchUntilQuiescent(): Promise<TaskGraphQuiescence> {
    await this.initialized;
    return this.dispatcher.dispatchUntilQuiescent();
  }

  async snapshot(): Promise<TaskGraphControlSnapshot> {
    await this.initialized;
    return this.taskGraph.snapshot();
  }

  async route(input: {
    readonly node: WorkspaceNode;
    readonly event: RosterTriggerEvent;
    readonly access?: RosterFunctionAccess;
    readonly signal?: AbortSignal;
  }): Promise<ReadonlyArray<RosterTriggerDelivery>> {
    await this.initialized;
    return this.triggers.route(input);
  }

  executePipeline(input: {
    readonly node: WorkspaceNode;
    readonly pipeline: WorkerPipelineDefinition;
    readonly catalogSnapshot: RosterCapabilityCatalogSearchResult;
    readonly access?: RosterFunctionAccess;
    readonly trace?: ExecutionTraceContext;
    readonly signal?: AbortSignal;
  }): Promise<WorkerPipelineResult> {
    return this.pipelines.execute(input);
  }
}

export class RosterPlatform {
  readonly definition: RosterPlatformDefinition;
  readonly registry: DomainRegistry;
  private readonly coordinatorCapability: string;
  private readonly skillRegistry: NodeExecutionSkillRegistry;

  constructor(input: RosterPlatformDefinition) {
    safeId(input.id, "Roster platform id");
    if (!input.version.trim()) throw new Error(`Roster platform ${input.id} requires a version`);
    if (!input.policyVersion.trim()) throw new Error(`Roster platform ${input.id} requires a policy version`);
    this.coordinatorCapability = input.coordinatorCapability ?? "coordinate";
    this.skillRegistry = new NodeExecutionSkillRegistry(input.skills);
    const functions = [
      ...(input.functions ?? []),
      expansionDescriptor(this.coordinatorCapability),
      ...(input.consultation ? [consultationDescriptor(this.coordinatorCapability)] : []),
    ];
    const duplicateFunctions = functions
      .map((descriptor) => descriptor.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index);
    if (duplicateFunctions.length) {
      throw new Error(`Roster platform has duplicate function ${duplicateFunctions[0]}`);
    }
    this.definition = {
      ...input,
      version: input.version.trim(),
      policyVersion: input.policyVersion.trim(),
      functions,
      workers: [...(input.workers ?? [])],
      triggers: [...(input.triggers ?? [])],
      skills: this.skillRegistry.entries(),
    };
    const pack: DomainPack = {
      id: input.id,
      version: input.version,
      policyVersion: input.policyVersion,
      coordinatorId: input.coordinatorId,
      capabilities: input.capabilities,
      nodes: input.nodes,
      limits: {
        maxNodes: input.maxNodes ?? input.nodes.length,
        maxTasks: input.policy.maxTasks,
        maxParallel: input.policy.maxInflight,
        maxDepth: input.policy.maxDepth,
      },
    };
    this.registry = createDomainRegistry(pack);
    this.registry.assertNodeAssignment(input.coordinatorId, this.coordinatorCapability);
    for (const descriptor of functions) {
      if (!input.capabilities.some((capability) => capability.id === descriptor.capability)) {
        throw new Error(
          `Roster function ${descriptor.id} references unknown capability ${descriptor.capability}`,
        );
      }
    }
  }

  createExecution(options: RosterPlatformExecutionOptions): RosterPlatformExecution {
    safeId(options.runId, "Roster execution id");
    return new RosterPlatformExecution(this, options.runId, options);
  }

  access(node: WorkspaceNode, definition: DynamicTaskDefinition): RosterFunctionAccess {
    if (this.definition.access) return this.definition.access(node, definition);
    return node.id === this.definition.coordinatorId
      ? {
          functionGrants: (this.definition.functions ?? []).map((descriptor) => descriptor.id),
          scopes: ["roster:graph:expand"],
          allowedEffects: ["read", "write", "external"],
        }
      : {
          functionGrants: (this.definition.functions ?? [])
            .filter((descriptor) => node.capabilities.includes(descriptor.capability))
            .map((descriptor) => descriptor.id),
          allowedEffects: ["read"],
        };
  }

  workspaceOperations(
    node: WorkspaceNode,
    definition: DynamicTaskDefinition,
    access = this.access(node, definition),
  ): ReadonlyArray<"read" | "publish"> {
    const selected = this.definition.workspaceOperations?.(node, definition)
      ?? (access.allowedEffects?.includes("write") ? ["read", "publish"] : ["read"]);
    const operations = [...new Set(selected)].sort();
    if (operations.some((operation) => operation !== "read" && operation !== "publish")) {
      throw new Error(`Roster task ${definition.taskId} selected an unsupported workspace operation`);
    }
    return operations;
  }

  executionSkills(
    context: NodeExecutionSkillSelectionContext,
  ): ReadonlyArray<NodeExecutionSkill> {
    const selected = this.definition.selectSkills?.(Object.freeze({
      ...context,
      nodeCapabilities: Object.freeze([...context.nodeCapabilities]),
    })) ?? [];
    return this.skillRegistry.select(selected);
  }

  createFunctionDirectory(
    graph: TaskGraphControl,
    dataReferences: DataReferenceStore,
    dispatchOwner: string,
  ): RosterFunctionDirectory {
    safeId(dispatchOwner, "Roster platform dispatch owner");
    let directory: RosterFunctionDirectory;
    directory = new RosterFunctionDirectory(this.definition.functions, {
      enqueue: async (request) => {
        this.registry.assertNodeAssignment(
          request.node.id,
          request.node.capabilities[0] ?? this.coordinatorCapability,
        );
        const identity = {
          platformId: this.definition.id,
          functionId: request.descriptor.id,
          functionVersion: request.descriptor.version,
          nodeId: request.node.id,
          queue: request.queue ?? "",
          input: request.input,
          metadata: request.metadata ?? {},
        };
        const identityHash = hashCanonical(identity);
        const reference = await dataReferences.put({
          value: request.input,
          metadata: {
            functionId: request.descriptor.id,
            functionVersion: request.descriptor.version,
            enqueueIdentity: identityHash,
          },
        });
        const taskId = `function_${identityHash.slice(0, 28)}`;
        const definition = definitionWithRuntimeBindingSnapshot(
          createDynamicTaskDefinition({
            taskId,
            semanticKey: `function:${identityHash}`,
            nodeId: request.node.id,
            capability: request.node.capabilities[0] ?? this.coordinatorCapability,
            objective: `Invoke queued function ${request.descriptor.id}@${request.descriptor.version}.`,
            handler: ROSTER_FUNCTION_TASK_HANDLER,
            acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
            result: { mode: "none" },
            dependencies: [],
            join: { kind: "all-success" },
            inputs: {
              inputVersions: { enqueue: identityHash },
              dataReferences: [reference],
              frontierVersion: `enqueue_${identityHash.slice(0, 28)}`,
              topologyVersion: hashCanonical(this.registry.pack.nodes.map((node) => node.id).sort()),
              catalogVersion: taskCatalogVersion(directory),
            },
            runtimeBindingEpoch: 0,
            retry: {
              maxAttempts: request.descriptor.idempotency === "none" ? 1 : this.definition.policy.maxAttempts,
              initialBackoffMs: 250,
              maximumBackoffMs: 5_000,
            },
            timeoutMs: request.timeoutMs,
            sideEffect: request.descriptor.effects.every((effect) => effect === "read")
              ? "pure"
              : request.descriptor.idempotency === "none"
                ? "non-repeatable"
                : "idempotent",
            estimatedCostMicros: 0,
          }),
          this.registry,
          this.definition.resolveRuntimeBinding,
        );
        const admitted = await graph.enqueue(definition);
        return { receiptId: admitted.definition.taskId };
      },
    });
    for (const worker of this.definition.workers ?? []) {
      safeId(worker.workerId, "Roster worker id");
      directory.bindProviderGeneration({
        providers: worker.functions.map((registered) => ({
          providerId: worker.workerId,
          functionId: registered.functionId,
          epoch: worker.epoch,
          heartbeat: worker.heartbeat,
          invoke: registered.invoke,
        })),
      });
    }
    directory.bindProvider({
      providerId: `${this.definition.id}:graph-control`,
      functionId: ROSTER_EXPAND_FUNCTION_ID,
      epoch: 1,
      invoke: async (value, control): Promise<JsonValue> => {
        const proposal = value as unknown as RosterExpansionProposal;
        const parentTaskId = functionMetadataTaskId(control.metadata);
        const record = taskGraphTask(await graph.snapshot(), parentTaskId);
        if (!record) throw new Error(`Roster graph expansion parent ${parentTaskId} does not exist`);
        if (
          graph.durability === "process-local"
          && record.leaseOwner !== undefined
          && record.leaseOwner !== dispatchOwner
        ) {
          throw new Error(
            `Roster graph expansion parent ${parentTaskId} is leased by a different dispatcher`,
          );
        }
        const materialized = materializeExpansion({
          parent: record.definition,
          proposal,
          registry: this.registry,
          catalogVersion: taskCatalogVersion(directory),
          resolveRuntimeBinding: this.definition.resolveRuntimeBinding,
        });
        const expansion = await graph.expand({
          parentTaskId,
          owner: dispatchOwner,
          fence: record.leaseFence,
          expansionKey: proposal.expansionKey,
          definitions: materialized.definitions,
          continuationTaskId: materialized.continuationTaskId,
        });
        return {
          expansionHash: expansion.expansionHash,
          childTaskIds: [...expansion.childTaskIds],
          continuationTaskId: expansion.continuationTaskId,
        };
      },
    });
    if (this.definition.consultation) {
      directory.bindProvider({
        providerId: `${this.definition.id}:consultation-control`,
        functionId: ROSTER_CONSULT_FUNCTION_ID,
        epoch: 1,
        invoke: async (value, control): Promise<JsonValue> => {
          const proposal = value as unknown as RosterNodeConsultation;
          const parentTaskId = functionMetadataTaskId(control.metadata);
          const snapshot = await graph.snapshot();
          const record = taskGraphTask(snapshot, parentTaskId);
          if (!record) throw new Error(`Roster consultation parent ${parentTaskId} does not exist`);
          if (
            graph.durability === "process-local"
            && record.leaseOwner !== undefined
            && record.leaseOwner !== dispatchOwner
          ) {
            throw new Error(
              `Roster consultation parent ${parentTaskId} is leased by a different dispatcher`,
            );
          }
          const materialized = materializeConsultation({
            parent: record.definition,
            proposal,
            snapshot,
            registry: this.registry,
            policy: this.definition.consultation!,
            catalogVersion: taskCatalogVersion(directory),
            resolveRuntimeBinding: this.definition.resolveRuntimeBinding,
          });
          const expansion = await graph.expand({
            parentTaskId,
            owner: dispatchOwner,
            fence: record.leaseFence,
            expansionKey: materialized.expansionKey,
            definitions: materialized.definitions,
            continuationTaskId: materialized.continuationTaskId,
          });
          return {
            expansionHash: expansion.expansionHash,
            childTaskIds: [...expansion.childTaskIds],
            continuationTaskId: expansion.continuationTaskId,
          };
        },
      });
    }
    return directory;
  }

  createTriggerRouter(directory: RosterFunctionDirectory): RosterTriggerRouter {
    const router = new RosterTriggerRouter({ directory });
    for (const trigger of this.definition.triggers ?? []) {
      if (trigger.schemaVersion !== ROSTER_TRIGGER_DEFINITION_VERSION) {
        throw new Error(`Roster trigger ${trigger.triggerId} uses an unsupported definition version`);
      }
      router.register(trigger);
    }
    return router;
  }
}

export const defineRosterPlatform = (
  input: RosterPlatformDefinition,
): RosterPlatform => new RosterPlatform(input);

export const createRosterRootTask = (input: {
  readonly taskId: string;
  readonly semanticKey: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective: string;
  readonly inputs: DynamicTaskDefinition["inputs"];
  readonly result?: TaskResultContract;
  readonly retry?: DynamicTaskDefinition["retry"];
  readonly timeoutMs?: number;
  readonly estimatedCostMicros?: number;
}): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId: input.taskId,
  semanticKey: input.semanticKey,
  nodeId: input.nodeId,
  capability: input.capability,
  objective: input.objective,
  handler: ROSTER_NODE_TASK_HANDLER,
  acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
  result: input.result ?? defaultTaskResultContract(),
  dependencies: [],
  join: { kind: "all-success" },
  inputs: input.inputs,
  runtimeBindingEpoch: 0,
  retry: input.retry ?? {
    maxAttempts: 2,
    initialBackoffMs: 250,
    maximumBackoffMs: 5_000,
  },
  timeoutMs: input.timeoutMs ?? 120_000,
  sideEffect: "pure",
  estimatedCostMicros: input.estimatedCostMicros ?? 0,
});
