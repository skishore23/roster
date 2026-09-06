import { hashCanonical } from "../../core/canonical.js";
import type {
  RosterFunctionInvocationAction,
  RosterFunctionInvocationResult,
  RosterFunctionTool,
} from "../functions/function-directory.js";
import type {
  JsonValue,
  NodeExecutionUsage,
  TaskBinding,
  WorkspaceNode,
  WorkspaceNodeRuntime,
  WorkspaceNodeRuntimeBinding,
  WorkspaceNodeRuntimeKind,
} from "../orchestration/types.js";
import type {
  ExecutionTraceContext,
  TaskResultContract,
} from "../platform/protocol.js";
import {
  assertTaskExecutionGrantTool,
  createTaskExecutionGrant,
  validateTaskExecutionGrant,
  type TaskExecutionGrant,
} from "../platform/execution-grant.js";
import type { TargetContract } from "../orchestration/target-contract.js";
import {
  normalizeWorkspaceNodeName,
  normalizeWorkspaceNodeRuntime,
} from "../workspace/node.js";
import type {
  NodeExecutionTrajectory,
  NodeExecutionTrajectoryObserver,
} from "./node-trajectory.js";
import {
  executeWithPreparedNodeCodeMode,
  prepareNodeCodeMode,
} from "./node-code-mode.js";
import {
  runWithRuntimeEffectScope,
  type RuntimeEffectRegistrar,
} from "./runtime-effect-scope.js";

export const NODE_EXECUTION_SCHEMA_VERSION = "roster.node-execution.v5" as const;
export const NODE_EXECUTION_CODE_MODE_SCHEMA_VERSION = "roster.node-code-mode.v3" as const;
export const NODE_EXECUTION_SURFACE_SCHEMA_VERSION = "roster.node-execution-surface.v1" as const;
export const MAX_NODE_EXECUTION_SKILLS = 8;
export const MAX_NODE_EXECUTION_IMAGE_ATTACHMENTS = 4;
export const MAX_NODE_EXECUTION_IMAGE_BYTES = 1_048_576;
export const MAX_NODE_EXECUTION_IMAGE_BYTES_TOTAL = 2 * 1_048_576;

export type NodeExecutionImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export type NodeExecutionImageAttachmentInput = {
  readonly kind: "image";
  readonly attachmentId: string;
  readonly name: string;
  readonly mediaType: NodeExecutionImageMediaType;
  readonly dataUrl: string;
};

export type NodeExecutionImageAttachment = NodeExecutionImageAttachmentInput & {
  readonly contentHash: string;
  readonly byteLength: number;
};

export type NodeExecutionAttachmentInput = NodeExecutionImageAttachmentInput;
export type NodeExecutionAttachment = NodeExecutionImageAttachment;

const NODE_EXECUTION_IMAGE_MEDIA_TYPES: ReadonlyArray<NodeExecutionImageMediaType> = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export const createNodeExecutionImageAttachment = (
  input: NodeExecutionImageAttachmentInput,
): NodeExecutionImageAttachment => {
  const attachmentId = input.attachmentId.trim();
  const name = input.name.trim().replace(/\s+/gu, " ");
  if (!attachmentId || attachmentId.length > 200) {
    throw new Error("Node execution image attachmentId must be between 1 and 200 characters");
  }
  if (!name || name.length > 200) {
    throw new Error("Node execution image name must be between 1 and 200 characters");
  }
  if (!NODE_EXECUTION_IMAGE_MEDIA_TYPES.includes(input.mediaType)) {
    throw new Error("Node execution images must be PNG, JPEG, WebP, or GIF");
  }
  const prefix = `data:${input.mediaType};base64,`;
  const dataUrl = input.dataUrl.trim();
  const encoded = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : "";
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error(`Node execution image data must be a base64 ${input.mediaType} data URL`);
  }
  if (encoded.length > Math.ceil(MAX_NODE_EXECUTION_IMAGE_BYTES * 4 / 3) + 4) {
    throw new Error(`Node execution images must not exceed ${MAX_NODE_EXECUTION_IMAGE_BYTES} bytes`);
  }
  const byteLength = Buffer.from(encoded, "base64").byteLength;
  if (byteLength < 1 || byteLength > MAX_NODE_EXECUTION_IMAGE_BYTES) {
    throw new Error(
      `Node execution images must be between 1 and ${MAX_NODE_EXECUTION_IMAGE_BYTES} bytes`,
    );
  }
  const content = {
    kind: "image" as const,
    attachmentId,
    name,
    mediaType: input.mediaType,
    dataUrl,
  };
  return {
    ...content,
    contentHash: hashCanonical(content),
    byteLength,
  };
};

export type NodeExecutionSkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly contentHash: string;
};

export const createNodeExecutionSkill = (input: Omit<NodeExecutionSkill, "contentHash">): NodeExecutionSkill => {
  const id = input.id.trim();
  const name = input.name.trim();
  const description = input.description.trim();
  const instructions = input.instructions.trim();
  if (!id || id.length > 120) throw new Error("Node execution skill id must be between 1 and 120 characters");
  if (!name || name.length > 120) throw new Error("Node execution skill name must be between 1 and 120 characters");
  if (!description || description.length > 500) {
    throw new Error("Node execution skill description must be between 1 and 500 characters");
  }
  if (!instructions || instructions.length > 32_000) {
    throw new Error("Node execution skill instructions must be between 1 and 32,000 characters");
  }
  const content = { id, name, description, instructions };
  return { ...content, contentHash: hashCanonical(content) };
};

export type NodeExecutionCodeModeOptions = {
  /** Keep task input outside the model prompt and expose it through a context handle. */
  readonly inputMode?: "inline" | "external";
  readonly maxFunctionCalls?: number;
  readonly maxContextValues?: number;
  readonly maxContextBytes?: number;
  readonly maxValueBytes?: number;
  readonly maxObservationBytes?: number;
  readonly maxRequestBytes?: number;
};

export type NodeExecutionContextHandle = {
  readonly handle: string;
  readonly label: string;
  readonly contentHash: string;
  readonly byteLength: number;
};

export type NodeExecutionCodeMode = {
  readonly schemaVersion: typeof NODE_EXECUTION_CODE_MODE_SCHEMA_VERSION;
  readonly inputMode: "inline" | "external";
  readonly maxFunctionCalls: number;
  readonly maxContextValues: number;
  readonly maxContextBytes: number;
  readonly maxValueBytes: number;
  readonly maxObservationBytes: number;
  readonly maxRequestBytes: number;
  /** Present only in the model-facing envelope prepared by a local adapter. */
  readonly command?: "roster-tool";
  /** Bounded values available to code without placing their bodies in the prompt. */
  readonly contextValues?: ReadonlyArray<NodeExecutionContextHandle>;
};

export type NodeExecutionSurface = {
  readonly schemaVersion: typeof NODE_EXECUTION_SURFACE_SCHEMA_VERSION;
  readonly surfaceId: string;
  readonly skills: ReadonlyArray<NodeExecutionSkill>;
  readonly tools: ReadonlyArray<RosterFunctionTool>;
  readonly workspace?: NodeExecutionWorkspaceContext;
  readonly codeMode?: NodeExecutionCodeMode;
};

export type NodeExecutionSurfaceInput = {
  readonly skills?: ReadonlyArray<NodeExecutionSkill>;
  readonly tools?: ReadonlyArray<RosterFunctionTool>;
  readonly workspace?: NodeExecutionWorkspaceContext;
  readonly codeMode?: NodeExecutionCodeModeOptions;
};

export const createNodeExecutionSurface = (input: {
  readonly skills?: ReadonlyArray<NodeExecutionSkill>;
  readonly tools?: ReadonlyArray<RosterFunctionTool>;
  readonly workspace?: NodeExecutionWorkspaceContext;
  readonly codeMode?: NodeExecutionCodeMode;
}): NodeExecutionSurface => {
  const skills = immutableSkillSnapshots(input.skills ?? []);
  const tools = immutableTypedSnapshot(input.tools ?? [], "Node execution surface tools");
  const toolIds = new Set<string>();
  for (const tool of tools) {
    if (toolIds.has(tool.id)) {
      throw new Error(`Node execution surface tool IDs must be unique: ${tool.id}`);
    }
    toolIds.add(tool.id);
  }
  const content = Object.freeze({
    schemaVersion: NODE_EXECUTION_SURFACE_SCHEMA_VERSION,
    skills,
    tools,
    ...(input.workspace
      ? {
          workspace: immutableTypedSnapshot(
            input.workspace,
            "Node execution surface workspace",
          ),
        }
      : {}),
    ...(input.codeMode
      ? {
          codeMode: immutableTypedSnapshot(
            input.codeMode,
            "Node execution surface code mode",
          ),
        }
      : {}),
  });
  return Object.freeze({
    ...content,
    surfaceId: `node_surface_${hashCanonical(content).slice(0, 28)}`,
  });
};

export type NodeExecutionFunctionInvocation = {
  readonly functionId: string;
  readonly value: JsonValue;
  readonly action?: RosterFunctionInvocationAction;
  readonly timeoutMs?: number;
};

export type NodeExecutionFunctionInvoker = (
  invocation: NodeExecutionFunctionInvocation,
  control: {
    readonly executionId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly taskId: string;
    readonly trace?: ExecutionTraceContext;
    readonly signal?: AbortSignal;
  },
) => Promise<RosterFunctionInvocationResult>;

export type NodeExecutionEnvelope = {
  readonly schemaVersion: typeof NODE_EXECUTION_SCHEMA_VERSION;
  readonly executionId: string;
  readonly runId: string;
  readonly node: {
    readonly id: string;
    readonly name: string;
    readonly capabilities: ReadonlyArray<string>;
    readonly parentId?: string;
    readonly promptProfile?: string;
    readonly metadata?: Readonly<Record<string, JsonValue>>;
  };
  readonly runtime: WorkspaceNodeRuntime;
  readonly binding?: WorkspaceNodeRuntimeBinding;
  readonly task: TaskBinding;
  /** Exact Roster-owned authority admitted before this execution started. */
  readonly grant: TaskExecutionGrant;
  readonly target?: TargetContract;
  readonly input?: JsonValue;
  readonly resultContract: TaskResultContract;
  readonly trace?: ExecutionTraceContext;
  /** Exact skills, tools, and RLM context projected for this bounded execution. */
  readonly surface: NodeExecutionSurface;
  /** Bounded binary inputs interpreted only by the selected runtime adapter. */
  readonly attachments?: ReadonlyArray<NodeExecutionAttachment>;
  readonly artifacts?: ReadonlyArray<NodeExecutionArtifactReference>;
  readonly attempt?: number;
  readonly timeoutMs?: number;
};

export type NodeExecutionArtifactReference = {
  readonly artifactId: string;
  readonly outputKey: string;
  readonly kind: string;
  readonly contentHash: string;
  readonly sharedArtifactId?: string;
};

/**
 * Content-free reference metadata safe to cross the runtime/model boundary.
 * Complete DataReferences remain on Roster's host-private data plane.
 */
export type NodeExecutionInputReferenceDescriptor = {
  readonly source: string;
  readonly label: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly byteLength: number;
};

/**
 * A bounded, host-verified data-reference body safe to cross the runtime/model
 * boundary. Locator, producer, and private metadata fields are deliberately
 * excluded; source + label bind the value back to its admitted descriptor.
 */
export type NodeExecutionResolvedDataReference = NodeExecutionInputReferenceDescriptor & {
  readonly value: JsonValue;
};

export type NodeExecutionInputManifest = {
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly dataReferences: ReadonlyArray<NodeExecutionInputReferenceDescriptor>;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
};

/**
 * Locator-free accepted artifact metadata safe to cross the runtime/model boundary.
 * Complete AcceptedArtifactReferences remain on Roster's host-private data plane.
 */
export type NodeExecutionAcceptedArtifactDescriptor = {
  readonly outputKey: string;
  readonly kind: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly byteLength: number;
};

export type NodeExecutionWorkspaceContext = {
  readonly workspaceId: string;
  readonly inputs: NodeExecutionInputManifest;
};

/** Ephemeral process output. It is diagnostics, never orchestration authority. */
export type NodeExecutionLog = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

export type NodeExecutionLogEvent = NodeExecutionLog & {
  readonly runId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly runtime: WorkspaceNodeRuntimeKind;
};

/**
 * Ephemeral assistant output observed while a model-backed runtime is still
 * executing. It is presentation input only, never a task result or receipt.
 */
export type NodeExecutionModelOutput = {
  readonly kind: "delta" | "snapshot";
  readonly text: string;
};

export type NodeExecutionResult<Output = JsonValue> =
  | {
      readonly schemaVersion: typeof NODE_EXECUTION_SCHEMA_VERSION;
      readonly status: "completed";
      readonly output: Output;
      readonly usage?: NodeExecutionUsage;
      readonly metadata?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly schemaVersion: typeof NODE_EXECUTION_SCHEMA_VERSION;
      readonly status: "failed";
      readonly error: string;
      readonly retryable?: boolean;
      readonly metadata?: Readonly<Record<string, JsonValue>>;
    };

export type NodeExecutionRequest<Output> = {
  readonly runId: string;
  readonly node: WorkspaceNode;
  readonly task: TaskBinding;
  /**
   * Durable platform executions supply the task-context grant. Direct
   * process-local runtime calls receive a deterministic standalone grant.
   */
  readonly grant?: TaskExecutionGrant;
  /** Versioned common goal shared by every task in this plan. */
  readonly target?: TargetContract;
  /** Latest durable placement receipt, when one exists for the node. */
  readonly binding?: WorkspaceNodeRuntimeBinding;
  readonly input?: JsonValue;
  readonly resultContract?: TaskResultContract;
  readonly trace?: ExecutionTraceContext;
  /** One provider-neutral capability and RLM context projection for this turn. */
  readonly surface?: NodeExecutionSurfaceInput;
  /** Bounded provider-neutral binary inputs for this execution. */
  readonly attachments?: ReadonlyArray<NodeExecutionAttachmentInput>;
  /** Executable validation paired with resultContract at the caller boundary. */
  readonly validateOutput?: (output: unknown) => boolean;
  readonly artifacts?: ReadonlyArray<NodeExecutionArtifactReference>;
  /**
   * Trusted Roster-owned invocation boundary. Runtime adapters may transport
   * requests to it but never select functions or admit their results.
   */
  readonly invokeFunction?: NodeExecutionFunctionInvoker;
  readonly attempt?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onLog?: (entry: NodeExecutionLog) => void;
  readonly onModelOutput?: (entry: NodeExecutionModelOutput) => void;
  /**
   * Receives an optional normalized inner-loop transcript artifact. Trajectory
   * observation is diagnostic and cannot affect task acceptance.
   */
  readonly onTrajectory?: NodeExecutionTrajectoryObserver;
  /**
   * Receives normalized provider-reported usage after output validation, or
   * exact partial usage emitted by an external adapter before interruption.
   */
  readonly onUsage?: (usage: NodeExecutionUsage) => void | Promise<void>;
  /** Roster-native in-process execution. Transport adapters do not receive this callback. */
  readonly execute: () => Promise<Output>;
};

export type NodeRuntimeExecutionControl = {
  readonly signal?: AbortSignal;
  readonly onLog?: (entry: NodeExecutionLog) => void;
  readonly onModelOutput?: (entry: NodeExecutionModelOutput) => void;
  readonly onTrajectory?: NodeExecutionTrajectoryObserver;
  /** Adapter-owned partial accounting; never task acceptance authority. */
  readonly onUsage?: (usage: NodeExecutionUsage) => void | Promise<void>;
  readonly invokeFunction?: NodeExecutionFunctionInvoker;
  /** Process-local attempt ownership for ephemeral adapter resources. */
  readonly effects: RuntimeEffectRegistrar;
};

/** @internal Engine-only prepared dispatch control. */
export type PreparedNodeRuntimeExecutionControl = Omit<
  NodeRuntimeExecutionControl,
  "invokeFunction"
>;

/** @internal Engine-only prepared dispatch transport. */
export type PreparedExecutionTransport = {
  readonly envelope: NodeExecutionEnvelope;
  readonly environment: NodeJS.ProcessEnv;
  readonly clientDirectory: string;
};

export type NodeRuntimeAdapter = {
  readonly kind: WorkspaceNodeRuntimeKind;
  /** Whether this runtime kind supports registry-prepared local code mode. */
  readonly supportsCodeMode?: boolean;
  /** Runtime-specific configuration validation at the dispatch boundary. */
  readonly validateRuntime?: (runtime: WorkspaceNodeRuntime) => void;
  /** Existing in-process inner-loop adapter API. */
  readonly execute?: <Output>(
    request: NodeExecutionRequest<Output>,
    control: Pick<NodeRuntimeExecutionControl, "effects">,
  ) => Promise<Output>;
  /** Serializable process/network boundary for CLI, shell, and A2A adapters. */
  readonly executeEnvelope?: (
    envelope: NodeExecutionEnvelope,
    control: NodeRuntimeExecutionControl,
  ) => Promise<NodeExecutionResult>;
};

/** Primitive-only public descriptor for a registered runtime adapter. */
export type NodeRuntimeAdapterView = {
  readonly kind: WorkspaceNodeRuntimeKind;
  readonly supportsCodeMode?: boolean;
};

/** @internal Engine-only local adapter binding. */
export type PreparedNodeRuntimeBinding = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly execute: (
    transport: PreparedExecutionTransport,
    control: PreparedNodeRuntimeExecutionControl,
  ) => Promise<NodeExecutionResult>;
};

/*
 * Built-in local adapters register their prepared path here. The binding is
 * structural engine state: it is not a request/envelope/control/adapter
 * property and is intentionally absent from the public SDK surface.
 */
const preparedNodeRuntimeBindings = new WeakMap<NodeRuntimeAdapter, PreparedNodeRuntimeBinding>();

export const bindPreparedNodeRuntimeExecutor = (
  adapter: NodeRuntimeAdapter,
  binding: PreparedNodeRuntimeBinding,
): NodeRuntimeAdapter => {
  preparedNodeRuntimeBindings.set(adapter, binding);
  return adapter;
};

export const rosterNativeNodeRuntime: NodeRuntimeAdapter = {
  kind: "roster-native",
  execute: (request) => request.execute(),
};

type NodeRuntimeRegistration = {
  readonly kind: WorkspaceNodeRuntimeKind;
  readonly adapter: NodeRuntimeAdapter;
  readonly publicView: NodeRuntimeAdapterView;
  readonly validateRuntime?: NodeRuntimeAdapter["validateRuntime"];
  readonly execute?: NodeRuntimeAdapter["execute"];
  readonly executeEnvelope?: NodeRuntimeAdapter["executeEnvelope"];
  readonly preparedBinding?: PreparedNodeRuntimeBinding;
};

const adapterPublicView = (
  kind: WorkspaceNodeRuntimeKind,
  supportsCodeMode: boolean | undefined,
): NodeRuntimeAdapterView => {
  const view = Object.create(null) as {
    kind: WorkspaceNodeRuntimeKind;
    supportsCodeMode?: boolean;
  };
  Object.defineProperty(view, "kind", {
    value: kind,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  if (supportsCodeMode !== undefined) {
    Object.defineProperty(view, "supportsCodeMode", {
      value: supportsCodeMode,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(view);
};

const snapshotPreparedEnvironment = (
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const snapshot = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Reflect.ownKeys(environment)) {
    if (typeof key !== "string") {
      throw new Error("Prepared node runtime environment keys must be strings");
    }
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (
      descriptor === undefined
      || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || Object.prototype.hasOwnProperty.call(descriptor, "get")
      || Object.prototype.hasOwnProperty.call(descriptor, "set")
    ) {
      throw new Error(
        `Prepared node runtime environment ${key} must be an own data property`,
      );
    }
    const value = descriptor.value as unknown;
    if (value !== undefined && typeof value !== "string") {
      throw new Error(
        `Prepared node runtime environment ${key} must be a string or undefined`,
      );
    }
    Object.defineProperty(snapshot, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
};

export const isNodeExecutionResult = (value: unknown): value is NodeExecutionResult => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    readonly schemaVersion?: unknown;
    readonly status?: unknown;
    readonly output?: unknown;
    readonly error?: unknown;
  };
  if (candidate.schemaVersion !== NODE_EXECUTION_SCHEMA_VERSION) return false;
  if (candidate.status === "completed") return "output" in candidate;
  return candidate.status === "failed" && typeof candidate.error === "string";
};

const usageInteger = (value: number | undefined, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Node execution usage ${field} must be a non-negative safe integer`);
  }
  return value;
};

const usageNumber = (value: number | undefined, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Node execution usage ${field} must be a non-negative finite number`);
  }
  return value;
};

export const normalizeNodeExecutionUsage = (usage: NodeExecutionUsage): NodeExecutionUsage => {
  if (usage.partial !== undefined && usage.partial !== true) {
    throw new Error("Node execution usage partial must be true when present");
  }
  const inputTokens = usageInteger(usage.inputTokens, "inputTokens");
  const cachedInputTokens = usageInteger(usage.cachedInputTokens, "cachedInputTokens");
  const cacheWriteTokens = usageInteger(usage.cacheWriteTokens, "cacheWriteTokens");
  const outputTokens = usageInteger(usage.outputTokens, "outputTokens");
  const reasoningTokens = usageInteger(usage.reasoningTokens, "reasoningTokens");
  const explicitTotal = usageInteger(usage.totalTokens, "totalTokens");
  if (cachedInputTokens !== undefined && inputTokens !== undefined && cachedInputTokens > inputTokens) {
    throw new Error("Node execution usage cachedInputTokens cannot exceed inputTokens");
  }
  if (cacheWriteTokens !== undefined && inputTokens !== undefined && cacheWriteTokens > inputTokens) {
    throw new Error("Node execution usage cacheWriteTokens cannot exceed inputTokens");
  }
  if (
    inputTokens !== undefined
    && (cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0) > inputTokens
  ) {
    throw new Error("Node execution usage cache token subsets cannot exceed inputTokens");
  }
  if (reasoningTokens !== undefined && outputTokens !== undefined && reasoningTokens > outputTokens) {
    throw new Error("Node execution usage reasoningTokens cannot exceed outputTokens");
  }
  const derivedTotal = inputTokens !== undefined || outputTokens !== undefined
    ? (inputTokens ?? 0) + (outputTokens ?? 0)
    : undefined;
  if (explicitTotal !== undefined && derivedTotal !== undefined && explicitTotal !== derivedTotal) {
    throw new Error("Node execution usage totalTokens must equal inputTokens plus outputTokens");
  }
  const normalized = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(explicitTotal !== undefined || derivedTotal !== undefined
      ? { totalTokens: explicitTotal ?? derivedTotal }
      : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usageNumber(usage.costUsd, "costUsd")! } : {}),
    ...(usage.durationMs !== undefined ? { durationMs: usageInteger(usage.durationMs, "durationMs")! } : {}),
    ...(usage.partial === true ? { partial: true as const } : {}),
  };
  if (Object.keys(normalized).every((key) => key === "partial")) {
    throw new Error("Node execution usage must report at least one usage field");
  }
  return normalized;
};

export const resolveBoundWorkspaceNode = (
  node: WorkspaceNode,
  binding: WorkspaceNodeRuntimeBinding | undefined,
): WorkspaceNode => {
  if (!binding) return node;
  if (binding.nodeId !== node.id) {
    throw new Error(`Runtime binding for ${binding.nodeId} cannot execute workspace node ${node.id}`);
  }
  return { ...node, runtime: binding.runtime };
};

const MAX_NODE_EXECUTION_SNAPSHOT_DEPTH = 100;
const MAX_NODE_EXECUTION_SNAPSHOT_VALUES = 100_000;

type SnapshotState = {
  readonly ancestors: WeakSet<object>;
  values: number;
};

const defineSnapshotProperty = (
  target: object,
  key: string,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  });
};

const immutableJsonValueSnapshot = (
  value: unknown,
  label = "node execution data",
  state: SnapshotState = { ancestors: new WeakSet<object>(), values: 0 },
  depth = 0,
): JsonValue => {
  state.values += 1;
  if (state.values > MAX_NODE_EXECUTION_SNAPSHOT_VALUES) {
    throw new Error(
      `${label} exceeds ${MAX_NODE_EXECUTION_SNAPSHOT_VALUES} snapshot values`,
    );
  }
  if (depth > MAX_NODE_EXECUTION_SNAPSHOT_DEPTH) {
    throw new Error(
      `${label} exceeds snapshot depth ${MAX_NODE_EXECUTION_SNAPSHOT_DEPTH}`,
    );
  }
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} contains unsupported non-JSON data`);
  }
  if (state.ancestors.has(value)) {
    throw new Error(`${label} contains cyclic data`);
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = value.length;
      if (!Number.isSafeInteger(length)) {
        throw new Error(`${label} contains an invalid array length`);
      }
      const snapshot: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error(`${label} contains a sparse array`);
        }
        const entry = value[index];
        snapshot.push(immutableJsonValueSnapshot(
          entry,
          `${label}[${index}]`,
          state,
          depth + 1,
        ));
      }
      return Object.freeze(snapshot);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains an unsupported non-plain JSON object`);
    }
    const snapshot: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) continue;
      if (typeof key !== "string") {
        throw new Error(`${label} contains an enumerable symbol key`);
      }
      const entry = (value as Readonly<Record<string, unknown>>)[key];
      const detached = immutableJsonValueSnapshot(
        entry,
        `${label}.${key}`,
        state,
        depth + 1,
      );
      defineSnapshotProperty(snapshot, key, detached);
    }
    return Object.freeze(snapshot);
  } finally {
    state.ancestors.delete(value);
  }
};

const immutableTypedSnapshot = <Value>(
  value: Value,
  label: string,
): Value => immutableJsonValueSnapshot(value, label) as Value;

const deepFreezePreparedDispatch = <Value>(value: Value): Value => {
  const seen = new WeakSet<object>();
  let values = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return;
    values += 1;
    if (values > MAX_NODE_EXECUTION_SNAPSHOT_VALUES) {
      throw new Error(
        `Prepared node execution exceeds ${MAX_NODE_EXECUTION_SNAPSHOT_VALUES} snapshot values`,
      );
    }
    if (depth > MAX_NODE_EXECUTION_SNAPSHOT_DEPTH) {
      throw new Error(
        `Prepared node execution exceeds snapshot depth ${MAX_NODE_EXECUTION_SNAPSHOT_DEPTH}`,
      );
    }
    if (seen.has(entry)) {
      throw new Error("Prepared node execution contains cyclic data");
    }
    seen.add(entry);
    for (const key of Reflect.ownKeys(entry)) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (descriptor?.enumerable !== true) continue;
      visit((entry as Readonly<Record<PropertyKey, unknown>>)[key], depth + 1);
    }
    Object.freeze(entry);
    seen.delete(entry);
  };
  visit(value, 0);
  return value;
};

const immutableMetadataSnapshot = (
  metadata: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined => metadata === undefined
  ? undefined
  : immutableTypedSnapshot(metadata, "node execution metadata");

const immutableStringArraySnapshot = (
  source: ReadonlyArray<string>,
  label: string,
  unique = false,
): ReadonlyArray<string> => {
  const length = source.length;
  const snapshot: string[] = [];
  const seen = unique ? new Set<string>() : undefined;
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(source, index)) {
      throw new Error(`${label} contains a sparse array`);
    }
    const value = source[index];
    if (typeof value !== "string") {
      throw new Error(`${label} must contain only strings`);
    }
    if (!seen?.has(value)) {
      snapshot.push(value);
      seen?.add(value);
    }
  }
  return Object.freeze(snapshot);
};

const immutableRuntimeSnapshot = (
  source: WorkspaceNodeRuntime,
): WorkspaceNodeRuntime => {
  // Read each declared property from the effective source exactly once. Any
  // normalization after this point operates only on detached values.
  const kind = source.kind;
  const profile = source.profile;
  const sourceCommand = source.command;
  const command = sourceCommand === undefined
    ? undefined
    : immutableStringArraySnapshot(sourceCommand, "Workspace node runtime command");
  const endpoint = source.endpoint;
  const sourceMetadata = source.metadata;
  const metadata = immutableMetadataSnapshot(sourceMetadata);
  const captured: {
    kind: WorkspaceNodeRuntimeKind;
    profile?: string;
    command?: ReadonlyArray<string>;
    endpoint?: string;
    metadata?: Readonly<Record<string, JsonValue>>;
  } = { kind };
  if (profile !== undefined) defineSnapshotProperty(captured, "profile", profile);
  if (command !== undefined) defineSnapshotProperty(captured, "command", command);
  if (endpoint !== undefined) defineSnapshotProperty(captured, "endpoint", endpoint);
  if (metadata !== undefined) defineSnapshotProperty(captured, "metadata", metadata);
  const normalized = normalizeWorkspaceNodeRuntime(captured);
  const snapshot: {
    kind: WorkspaceNodeRuntimeKind;
    profile?: string;
    command?: ReadonlyArray<string>;
    endpoint?: string;
    metadata?: Readonly<Record<string, JsonValue>>;
  } = { kind: normalized.kind };
  if (normalized.profile !== undefined) {
    defineSnapshotProperty(snapshot, "profile", normalized.profile);
  }
  if (normalized.command !== undefined) {
    defineSnapshotProperty(
      snapshot,
      "command",
      immutableStringArraySnapshot(normalized.command, "Workspace node runtime command"),
    );
  }
  if (normalized.endpoint !== undefined) {
    defineSnapshotProperty(snapshot, "endpoint", normalized.endpoint);
  }
  if (normalized.metadata !== undefined) {
    defineSnapshotProperty(
      snapshot,
      "metadata",
      immutableMetadataSnapshot(normalized.metadata),
    );
  }
  return Object.freeze(snapshot);
};

const immutablePlacementSnapshot = (
  source: NonNullable<WorkspaceNodeRuntimeBinding["placement"]>,
): NonNullable<WorkspaceNodeRuntimeBinding["placement"]> => {
  const rosterId = source.rosterId;
  const rosterVersion = source.rosterVersion;
  const policyVersion = source.policyVersion;
  const profileId = source.profileId;
  const reason = source.reason;
  return Object.freeze({
    rosterId,
    rosterVersion,
    policyVersion,
    profileId,
    reason,
  });
};

type CapturedRuntimeBinding = {
  readonly runtime: WorkspaceNodeRuntime;
  readonly binding: WorkspaceNodeRuntimeBinding;
};

const immutableBindingSnapshot = (
  source: WorkspaceNodeRuntimeBinding,
): CapturedRuntimeBinding => {
  const runtimeSource = source.runtime;
  const runtime = immutableRuntimeSnapshot(runtimeSource);
  const bindingId = source.bindingId;
  const nodeId = source.nodeId;
  const epoch = source.epoch;
  const topologyVersion = source.topologyVersion;
  const sandboxId = source.sandboxId;
  const sessionId = source.sessionId;
  const sourcePlacement = source.placement;
  const placement = sourcePlacement === undefined
    ? undefined
    : immutablePlacementSnapshot(sourcePlacement);
  return Object.freeze({
    runtime,
    binding: Object.freeze({
      bindingId,
      nodeId,
      runtime,
      epoch,
      topologyVersion,
      ...(sandboxId !== undefined ? { sandboxId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(placement !== undefined ? { placement } : {}),
    }),
  });
};

const immutableNodeSnapshot = (
  source: WorkspaceNode,
  runtime: WorkspaceNodeRuntime,
): WorkspaceNode => {
  const id = source.id;
  const name = source.name;
  const sourceCapabilities = source.capabilities;
  const capabilities = immutableStringArraySnapshot(
    sourceCapabilities,
    "Workspace node capabilities",
    true,
  );
  const parentId = source.parentId;
  const promptProfile = source.promptProfile;
  const sourceMetadata = source.metadata;
  const metadata = immutableMetadataSnapshot(sourceMetadata);
  return Object.freeze({
    id,
    name: normalizeWorkspaceNodeName(name),
    capabilities,
    runtime,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(promptProfile !== undefined ? { promptProfile } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
};

type NodeRuntimeDispatchSnapshot<Output> = {
  readonly request: NodeExecutionRequest<Output>;
  readonly node: WorkspaceNode;
  readonly envelopeNode: NodeExecutionEnvelope["node"];
  readonly runtime: WorkspaceNodeRuntime;
  readonly binding?: WorkspaceNodeRuntimeBinding;
  readonly envelopeBinding?: WorkspaceNodeRuntimeBinding;
};

const immutableSkillSnapshots = (
  source: ReadonlyArray<NodeExecutionSkill>,
): ReadonlyArray<NodeExecutionSkill> => {
  const length = source.length;
  if (length > MAX_NODE_EXECUTION_SKILLS) {
    throw new Error(`A node execution may receive at most ${MAX_NODE_EXECUTION_SKILLS} skills`);
  }
  const snapshot: NodeExecutionSkill[] = [];
  const skillIds = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const detached = immutableTypedSnapshot(source[index], `Node execution skill ${index}`);
    const skill = Object.freeze(createNodeExecutionSkill(detached));
    if (skillIds.has(skill.id)) {
      throw new Error(`Node execution skill IDs must be unique: ${skill.id}`);
    }
    skillIds.add(skill.id);
    snapshot.push(skill);
  }
  return Object.freeze(snapshot);
};

const immutableAttachmentSnapshots = (
  source: ReadonlyArray<NodeExecutionAttachmentInput>,
): ReadonlyArray<NodeExecutionAttachment> => {
  const length = source.length;
  if (length > MAX_NODE_EXECUTION_IMAGE_ATTACHMENTS) {
    throw new Error(
      `A node execution may receive at most ${MAX_NODE_EXECUTION_IMAGE_ATTACHMENTS} image attachments`,
    );
  }
  const snapshot: NodeExecutionAttachment[] = [];
  const attachmentIds = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < length; index += 1) {
    const detached = immutableTypedSnapshot(
      source[index],
      `Node execution attachment ${index}`,
    );
    const attachment = Object.freeze(createNodeExecutionImageAttachment(detached));
    if (attachmentIds.has(attachment.attachmentId)) {
      throw new Error("Node execution image attachmentIds must be unique");
    }
    attachmentIds.add(attachment.attachmentId);
    totalBytes += attachment.byteLength;
    if (totalBytes > MAX_NODE_EXECUTION_IMAGE_BYTES_TOTAL) {
      throw new Error(
        `Node execution image attachments exceed ${MAX_NODE_EXECUTION_IMAGE_BYTES_TOTAL} total bytes`,
      );
    }
    snapshot.push(attachment);
  }
  return Object.freeze(snapshot);
};

const envelopeNodeSnapshot = (
  node: WorkspaceNode,
): NodeExecutionEnvelope["node"] => {
  const snapshot: {
    id: string;
    name: string;
    capabilities: ReadonlyArray<string>;
    parentId?: string;
    promptProfile?: string;
    metadata?: Readonly<Record<string, JsonValue>>;
  } = {
    id: node.id,
    name: node.name,
    capabilities: node.capabilities,
  };
  if (node.parentId !== undefined) {
    defineSnapshotProperty(snapshot, "parentId", node.parentId);
  }
  if (node.promptProfile !== undefined) {
    defineSnapshotProperty(snapshot, "promptProfile", node.promptProfile);
  }
  if (node.metadata !== undefined) {
    defineSnapshotProperty(snapshot, "metadata", node.metadata);
  }
  return Object.freeze(snapshot);
};

const envelopeBindingSnapshot = (
  binding: WorkspaceNodeRuntimeBinding | undefined,
  runtime: WorkspaceNodeRuntime,
): WorkspaceNodeRuntimeBinding | undefined => {
  if (binding === undefined) return undefined;
  return Object.freeze({
    bindingId: binding.bindingId,
    nodeId: binding.nodeId,
    runtime,
    epoch: binding.epoch,
    topologyVersion: binding.topologyVersion,
    ...(binding.sandboxId !== undefined ? { sandboxId: binding.sandboxId } : {}),
    ...(binding.sessionId !== undefined ? { sessionId: binding.sessionId } : {}),
  });
};

const immutableDispatchSnapshot = <Output>(
  request: NodeExecutionRequest<Output>,
): NodeRuntimeDispatchSnapshot<Output> => {
  const sourceBinding = request.binding;
  let runtime: WorkspaceNodeRuntime;
  let binding: WorkspaceNodeRuntimeBinding | undefined;
  let node: WorkspaceNode;
  if (sourceBinding === undefined) {
    const sourceNode = request.node;
    const runtimeSource = sourceNode.runtime;
    runtime = immutableRuntimeSnapshot(runtimeSource);
    node = immutableNodeSnapshot(sourceNode, runtime);
  } else {
    const capturedBinding = immutableBindingSnapshot(sourceBinding);
    runtime = capturedBinding.runtime;
    binding = capturedBinding.binding;
    const sourceNode = request.node;
    node = immutableNodeSnapshot(sourceNode, runtime);
  }
  if (binding !== undefined && binding.nodeId !== node.id) {
    throw new Error(
      `Runtime binding for ${binding.nodeId} cannot execute workspace node ${node.id}`,
    );
  }
  const runId = request.runId;
  const taskSource = request.task;
  const task = immutableTypedSnapshot(taskSource, "Node execution task");
  const targetSource = request.target;
  const target = targetSource === undefined
    ? undefined
    : immutableTypedSnapshot(targetSource, "Node execution target");
  const inputSource = request.input;
  const input = inputSource === undefined
    ? undefined
    : immutableJsonValueSnapshot(inputSource, "Node execution input");
  const resultContractSource = request.resultContract;
  const resultContract = resultContractSource === undefined
    ? undefined
    : immutableTypedSnapshot(resultContractSource, "Node execution result contract");
  const traceSource = request.trace;
  const trace = traceSource === undefined
    ? undefined
    : immutableTypedSnapshot(traceSource, "Node execution trace");
  const surfaceSource = request.surface;
  const surfaceSkills = surfaceSource?.skills;
  const surfaceTools = surfaceSource?.tools;
  const surfaceWorkspace = surfaceSource?.workspace;
  const surfaceCodeModeSource = surfaceSource?.codeMode;
  const surfaceCodeMode = createNodeExecutionCodeMode(surfaceCodeModeSource);
  const surface = createNodeExecutionSurface({
    skills: surfaceSkills,
    tools: surfaceTools,
    workspace: surfaceWorkspace,
    ...(surfaceCodeMode ? { codeMode: surfaceCodeMode } : {}),
  });
  const attempt = request.attempt;
  const grantSource = request.grant;
  const grant = grantSource === undefined
    ? createStandaloneExecutionGrant({
        runId,
        node,
        task,
        surface,
        attempt,
        binding,
      })
    : validateTaskExecutionGrant(
        immutableTypedSnapshot(grantSource, "Node execution grant"),
      );
  assertGrantMatchesExecution({
    grant,
    runId,
    node,
    task,
    surface,
    attempt,
    binding,
  });
  const attachmentsSource = request.attachments;
  const attachments = attachmentsSource === undefined
    ? undefined
    : immutableAttachmentSnapshots(attachmentsSource);
  const validateOutput = request.validateOutput;
  const artifactsSource = request.artifacts;
  const artifacts = artifactsSource === undefined
    ? undefined
    : immutableTypedSnapshot(artifactsSource, "Node execution artifacts");
  const invokeFunction = request.invokeFunction;
  const timeoutMs = request.timeoutMs;
  const signal = request.signal;
  const onLog = request.onLog;
  const onModelOutput = request.onModelOutput;
  const onTrajectory = request.onTrajectory;
  const onUsage = request.onUsage;
  const execute = request.execute;
  const canonicalRequest = Object.freeze({
    runId,
    node,
    task,
    grant,
    ...(binding !== undefined ? { binding } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(resultContract !== undefined ? { resultContract } : {}),
    ...(trace !== undefined ? { trace } : {}),
    surface,
    ...(attachments !== undefined ? { attachments } : {}),
    ...(validateOutput !== undefined ? { validateOutput } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(invokeFunction !== undefined ? { invokeFunction } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(onLog !== undefined ? { onLog } : {}),
    ...(onModelOutput !== undefined ? { onModelOutput } : {}),
    ...(onTrajectory !== undefined ? { onTrajectory } : {}),
    ...(onUsage !== undefined ? { onUsage } : {}),
    execute,
  }) as NodeExecutionRequest<Output>;
  return Object.freeze({
    request: canonicalRequest,
    node,
    envelopeNode: envelopeNodeSnapshot(node),
    runtime,
    ...(binding !== undefined ? { binding } : {}),
    ...(binding !== undefined
      ? { envelopeBinding: envelopeBindingSnapshot(binding, runtime) }
      : {}),
  });
};

const boundedCodeModeLimit = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: keyof Omit<NodeExecutionCodeMode, "schemaVersion" | "inputMode">,
): number => {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`Node execution code mode ${field} must be a positive safe integer`);
  }
  if (normalized > maximum) {
    throw new Error(`Node execution code mode ${field} exceeds hard maximum ${maximum}`);
  }
  return normalized;
};

export const createNodeExecutionCodeMode = (
  options: NodeExecutionCodeModeOptions | undefined,
): NodeExecutionCodeMode | undefined => {
  if (options === undefined) return undefined;
  const inputMode = options.inputMode;
  const maxFunctionCalls = options.maxFunctionCalls;
  const maxContextValues = options.maxContextValues;
  const maxContextBytes = options.maxContextBytes;
  const maxValueBytes = options.maxValueBytes;
  const maxObservationBytes = options.maxObservationBytes;
  const maxRequestBytes = options.maxRequestBytes;
  void inputMode;
  return Object.freeze({
    schemaVersion: NODE_EXECUTION_CODE_MODE_SCHEMA_VERSION,
    // Registry-backed local code mode always keeps task input out of the
    // adapter-visible envelope, including for legacy callers requesting inline.
    inputMode: "external",
    maxFunctionCalls: boundedCodeModeLimit(maxFunctionCalls, 16, 128, "maxFunctionCalls"),
    maxContextValues: boundedCodeModeLimit(maxContextValues, 64, 512, "maxContextValues"),
    maxContextBytes: boundedCodeModeLimit(
      maxContextBytes,
      32 * 1_048_576,
      256 * 1_048_576,
      "maxContextBytes",
    ),
    maxValueBytes: boundedCodeModeLimit(
      maxValueBytes,
      16 * 1_048_576,
      64 * 1_048_576,
      "maxValueBytes",
    ),
    maxObservationBytes: boundedCodeModeLimit(
      maxObservationBytes,
      64 * 1_024,
      1_048_576,
      "maxObservationBytes",
    ),
    maxRequestBytes: boundedCodeModeLimit(
      maxRequestBytes,
      1_048_576,
      8 * 1_048_576,
      "maxRequestBytes",
    ),
  });
};

const createStandaloneExecutionGrant = (input: {
  readonly runId: string;
  readonly node: WorkspaceNode;
  readonly task: TaskBinding;
  readonly surface: NodeExecutionSurface;
  readonly attempt?: number;
  readonly binding?: WorkspaceNodeRuntimeBinding;
}): TaskExecutionGrant => {
  const projectedInputs = input.surface.workspace?.inputs;
  const inputs = {
    inputVersions: projectedInputs?.inputVersions ?? input.task.inputVersions ?? {},
    dataReferences: [],
    frontierVersion: projectedInputs?.frontierVersion ?? "direct-runtime-frontier",
    topologyVersion: projectedInputs?.topologyVersion ?? "direct-runtime-topology",
    catalogVersion: projectedInputs?.catalogVersion ?? "direct-runtime-catalog",
  };
  const definitionHash = hashCanonical({
    runId: input.runId,
    nodeId: input.node.id,
    task: input.task,
    surfaceId: input.surface.surfaceId,
  });
  return createTaskExecutionGrant({
    runId: input.runId,
    definition: {
      schemaVersion: "roster.task-definition.v1",
      taskId: input.task.taskId,
      semanticKey: `direct:${input.task.taskId}`,
      definitionHash,
      nodeId: input.node.id,
      capability: input.task.capability,
      objective: input.task.objective ?? "Execute one direct process-local runtime turn.",
      handler: { kind: "roster.runtime.direct", version: "1" },
      acceptance: { policyId: "roster.runtime.direct", policyVersion: "1" },
      result: { mode: "none" },
      dependencies: [],
      join: { kind: "all-success" },
      inputs,
      runtimeBindingEpoch: input.binding?.epoch ?? 0,
      retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
      timeoutMs: 0,
      sideEffect: "pure",
      estimatedCostMicros: 0,
    },
    attempt: input.attempt ?? 1,
    fence: 1,
    policyVersion: "roster.runtime.direct.v1",
    policy: { maxTokens: 1_000_000, maxCostMicros: 0 },
    workspaceOperations: input.surface.tools.some(({ id }) =>
      id === "roster::workspace.publish") ? ["read", "publish"] : ["read"],
    skills: input.surface.skills.map(({ id, contentHash }) => ({ id, contentHash })),
    tools: input.surface.tools,
    codeMode: input.surface.codeMode,
    maxFunctionCalls: input.surface.codeMode?.maxFunctionCalls ?? 1,
    rationale: "A direct process-local runtime call is bounded to its exact projected surface.",
  });
};

const assertGrantMatchesExecution = (input: {
  readonly grant: TaskExecutionGrant;
  readonly runId: string;
  readonly node: WorkspaceNode;
  readonly task: TaskBinding;
  readonly surface: NodeExecutionSurface;
  readonly attempt?: number;
  readonly binding?: WorkspaceNodeRuntimeBinding;
}): void => {
  if (
    input.grant.runId !== input.runId
    || input.grant.taskId !== input.task.taskId
    || input.grant.nodeId !== input.node.id
    || input.grant.attempt !== (input.attempt ?? 1)
    || (
      input.binding !== undefined
      && input.grant.runtimeBindingEpoch !== input.binding.epoch
    )
  ) {
    throw new Error("Node execution grant does not match its exact runtime execution");
  }
  const actualSkills = input.surface.skills
    .map(({ id, contentHash }) => ({ id, contentHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const actualTools = input.surface.tools
    .map(({ id, version, effects }) => ({ id, version, effects: [...effects].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const actualCodeMode = input.surface.codeMode === undefined
    ? undefined
    : {
        maxFunctionCalls: input.surface.codeMode.maxFunctionCalls,
        maxContextValues: input.surface.codeMode.maxContextValues,
        maxContextBytes: input.surface.codeMode.maxContextBytes,
        maxValueBytes: input.surface.codeMode.maxValueBytes,
        maxObservationBytes: input.surface.codeMode.maxObservationBytes,
        maxRequestBytes: input.surface.codeMode.maxRequestBytes,
      };
  if (
    hashCanonical(actualSkills) !== hashCanonical(input.grant.surface.skills)
    || hashCanonical(actualTools) !== hashCanonical(input.grant.surface.tools)
    || hashCanonical(actualCodeMode ?? null)
      !== hashCanonical(input.grant.surface.codeMode ?? null)
  ) {
    throw new Error("Node execution surface does not match its admitted execution grant");
  }
  const manifest = input.surface.workspace?.inputs;
  if (manifest && (
    input.grant.frontierVersion !== manifest.frontierVersion
    || input.grant.topologyVersion !== manifest.topologyVersion
    || input.grant.catalogVersion !== manifest.catalogVersion
  )) {
    throw new Error("Node execution context does not match its admitted execution grant");
  }
};

const executionEnvelope = <Output>(
  snapshot: NodeRuntimeDispatchSnapshot<Output>,
): NodeExecutionEnvelope => {
  const { request, envelopeNode, runtime, envelopeBinding: binding } = snapshot;
  const resultContract: TaskResultContract = request.resultContract ?? Object.freeze({
    mode: "text",
    outputKey: "result",
  });
  const content = Object.freeze({
    runId: request.runId,
    node: envelopeNode,
    runtime,
    ...(binding ? { binding } : {}),
    task: request.task,
    grant: request.grant!,
    ...(request.target ? { target: request.target } : {}),
    ...(request.input !== undefined ? { input: request.input } : {}),
    resultContract,
    surface: request.surface as NodeExecutionSurface,
    ...(request.attachments?.length
      ? { attachments: request.attachments as ReadonlyArray<NodeExecutionAttachment> }
      : {}),
    ...(request.artifacts?.length ? { artifacts: request.artifacts } : {}),
    ...(request.trace ? { trace: request.trace } : {}),
    ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  });
  return Object.freeze({
    schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
    executionId: `node_execution_${hashCanonical(content).slice(0, 28)}`,
    ...content,
  });
};

/**
 * Dispatches a logical node through its effective inner-loop runtime. A durable
 * binding overrides the runtime authored on the node while preserving logical
 * identity. Roster still owns task/frontier mechanics and result acceptance.
 */
export class NodeRuntimeRegistry {
  readonly #registrations = new Map<WorkspaceNodeRuntimeKind, NodeRuntimeRegistration>();

  constructor(adapters: ReadonlyArray<NodeRuntimeAdapter> = [rosterNativeNodeRuntime]) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: NodeRuntimeAdapter): void {
    const kind = adapter.kind;
    if (typeof kind !== "string") {
      throw new Error("Node runtime adapter kind must be a string");
    }
    if (!kind.trim()) throw new Error("Node runtime adapter kind must not be blank");
    if (kind !== kind.trim()) {
      throw new Error("Node runtime adapter kind must not contain surrounding whitespace");
    }
    if (this.#registrations.has(kind)) {
      throw new Error(`Node runtime adapter ${kind} is already registered`);
    }
    const execute = adapter.execute;
    const executeEnvelope = adapter.executeEnvelope;
    const validateRuntime = adapter.validateRuntime;
    const preparedBinding = preparedNodeRuntimeBindings.get(adapter);
    const preparedExecute = preparedBinding?.execute;
    const preparedEnvironment = preparedBinding?.environment;
    if (execute !== undefined && typeof execute !== "function") {
      throw new Error(`Node runtime adapter ${kind} execute must be a function`);
    }
    if (executeEnvelope !== undefined && typeof executeEnvelope !== "function") {
      throw new Error(`Node runtime adapter ${kind} executeEnvelope must be a function`);
    }
    if (validateRuntime !== undefined && typeof validateRuntime !== "function") {
      throw new Error(`Node runtime adapter ${kind} validateRuntime must be a function`);
    }
    if (preparedBinding && typeof preparedExecute !== "function") {
      throw new Error(`Prepared node runtime binding ${kind} execute must be a function`);
    }
    if (
      preparedEnvironment !== undefined
      && (
        preparedEnvironment === null
        || typeof preparedEnvironment !== "object"
        || Array.isArray(preparedEnvironment)
      )
    ) {
      throw new Error(
        `Prepared node runtime binding ${kind} environment must be a non-null, non-array object`,
      );
    }
    if (!execute && !executeEnvelope && !preparedBinding) {
      throw new Error(`Node runtime adapter ${kind} has no execution method`);
    }
    if (
      kind !== "roster-native"
      && !executeEnvelope
      && !preparedBinding
    ) {
      throw new Error(
        `External node runtime adapter ${kind} requires a serializable execution transport`,
      );
    }
    const supportsCodeMode = adapter.supportsCodeMode;
    if (supportsCodeMode !== undefined && typeof supportsCodeMode !== "boolean") {
      throw new Error(`Node runtime adapter ${kind} supportsCodeMode must be a boolean`);
    }
    const publicView = adapterPublicView(kind, supportsCodeMode);
    const preparedBindingSnapshot: PreparedNodeRuntimeBinding | undefined = preparedBinding
      ? Object.freeze({
        ...(preparedEnvironment !== undefined
          ? {
            environment: snapshotPreparedEnvironment(preparedEnvironment),
          }
          : {}),
        execute: preparedExecute!,
      })
      : undefined;
    this.#registrations.set(kind, Object.freeze({
      kind,
      adapter,
      publicView,
      validateRuntime,
      execute,
      executeEnvelope,
      ...(preparedBindingSnapshot ? { preparedBinding: preparedBindingSnapshot } : {}),
    }));
  }

  adapter(kind: WorkspaceNodeRuntimeKind): NodeRuntimeAdapterView {
    return this.#registration(kind).publicView;
  }

  #registration(kind: WorkspaceNodeRuntimeKind): NodeRuntimeRegistration {
    const registration = this.#registrations.get(kind);
    if (!registration) throw new Error(`No node runtime adapter registered for ${kind}`);
    return registration;
  }

  async execute<Output>(request: NodeExecutionRequest<Output>): Promise<Output> {
    const snapshot = immutableDispatchSnapshot(request);
    const canonicalRequest = snapshot.request;
    const runtime = snapshot.runtime;
    const registration = this.#registration(runtime.kind);
    const adapter = registration.adapter;
    if (
      adapter.kind !== registration.kind
      || adapter.execute !== registration.execute
      || adapter.executeEnvelope !== registration.executeEnvelope
    ) {
      throw new Error(`Node runtime adapter ${registration.kind} changed after registration`);
    }
    registration.validateRuntime?.(runtime);
    const envelope = executionEnvelope(snapshot);
    return runWithRuntimeEffectScope({
      owner: {
        kind: "task-attempt",
        executionId: envelope.executionId,
        runId: envelope.runId,
        taskId: envelope.task.taskId,
        attempt: envelope.grant.attempt,
        fence: envelope.grant.fence,
      },
      run: async (effects): Promise<Output> => {
        const preparedBinding = registration.preparedBinding;
        const grantedInvoker: NodeExecutionFunctionInvoker | undefined =
          canonicalRequest.invokeFunction
            ? async (invocation, control) => {
                assertTaskExecutionGrantTool(canonicalRequest.grant!, invocation.functionId);
                return canonicalRequest.invokeFunction!(invocation, control);
              }
            : undefined;
        if (canonicalRequest.surface?.codeMode && !preparedBinding) {
          throw new Error(`Node runtime ${registration.kind} does not support code mode`);
        }
        const acceptEnvelopeResult = async (result: NodeExecutionResult): Promise<Output> => {
          if (result.schemaVersion !== NODE_EXECUTION_SCHEMA_VERSION) {
            throw new Error(`Node runtime ${registration.kind} returned an unsupported result schema`);
          }
          if (result.status === "failed") throw new Error(result.error);
          if (canonicalRequest.validateOutput && !canonicalRequest.validateOutput(result.output)) {
            throw new Error(`Node runtime ${registration.kind} returned output that violates its contract`);
          }
          if (result.usage) await canonicalRequest.onUsage?.(normalizeNodeExecutionUsage(result.usage));
          return result.output as Output;
        };
        const reportAdapterUsage = canonicalRequest.onUsage
          ? async (usage: NodeExecutionUsage): Promise<void> =>
              canonicalRequest.onUsage!(normalizeNodeExecutionUsage(usage))
          : undefined;
        if (canonicalRequest.surface?.codeMode) {
          const prepared = await prepareNodeCodeMode({
            envelope,
            invokeFunction: grantedInvoker,
            signal: canonicalRequest.signal,
            baseEnvironment: preparedBinding!.environment,
          });
          const preparedEnvelope = deepFreezePreparedDispatch(prepared.envelope);
          return executeWithPreparedNodeCodeMode(prepared, async () =>
            acceptEnvelopeResult(await preparedBinding!.execute({
              envelope: preparedEnvelope,
              environment: prepared.environment,
              clientDirectory: prepared.clientDirectory,
            }, {
              signal: canonicalRequest.signal,
              onLog: canonicalRequest.onLog,
              onModelOutput: canonicalRequest.onModelOutput,
              onTrajectory: canonicalRequest.onTrajectory,
              ...(reportAdapterUsage ? { onUsage: reportAdapterUsage } : {}),
              effects,
            })));
        }
        if (registration.executeEnvelope) {
          const result = await registration.executeEnvelope(envelope, {
            signal: canonicalRequest.signal,
            onLog: canonicalRequest.onLog,
            onModelOutput: canonicalRequest.onModelOutput,
            onTrajectory: canonicalRequest.onTrajectory,
            ...(reportAdapterUsage ? { onUsage: reportAdapterUsage } : {}),
            invokeFunction: grantedInvoker,
            effects,
          });
          return acceptEnvelopeResult(result);
        }
        if (registration.kind !== "roster-native") {
          throw new Error(
            `External node runtime adapter ${registration.kind} requires a serializable execution transport`,
          );
        }
        if (!registration.execute) {
          throw new Error(`Node runtime adapter ${registration.kind} has no execution method`);
        }
        const output = await registration.execute(canonicalRequest, { effects });
        if (canonicalRequest.validateOutput && !canonicalRequest.validateOutput(output)) {
          throw new Error(`Node runtime ${registration.kind} returned output that violates its contract`);
        }
        return output;
      },
    });
  }
}

export const createDefaultNodeRuntimeRegistry = (): NodeRuntimeRegistry =>
  new NodeRuntimeRegistry();

export type { NodeExecutionUsage } from "../orchestration/types.js";
export type { NodeExecutionTrajectory };
