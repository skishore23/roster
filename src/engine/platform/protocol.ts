import type {
  JsonValue,
  NodeExecutionUsage,
} from "../orchestration/types.js";

export const ROSTER_PLATFORM_PROTOCOL_VERSION = "roster.platform.v3" as const;
export const ROSTER_DATA_REFERENCE_VERSION = "roster.data-reference.v1" as const;
export const ROSTER_TASK_DEFINITION_VERSION = "roster.task-definition.v1" as const;
export const ROSTER_TASK_OUTCOME_VERSION = "roster.task-outcome.v2" as const;

export type ExecutionTraceContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly traceFlags?: string;
  readonly baggage?: Readonly<Record<string, string>>;
};

/**
 * An immutable value that can move between workers without entering a model
 * prompt. Ephemeral values are bounded to one execution; artifact and object
 * values may be replayed when their content hash remains available.
 */
export type DataReference = {
  readonly schemaVersion: typeof ROSTER_DATA_REFERENCE_VERSION;
  readonly referenceId: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly storage: "ephemeral" | "artifact" | "object";
  readonly producerFunctionId?: string;
  readonly producerFunctionVersion?: string;
  readonly artifactId?: string;
  readonly uri?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type TaskResultContract =
  | {
      readonly mode: "text";
      readonly outputKey: string;
    }
  | {
      readonly mode: "json";
      readonly outputKey: string;
      readonly schema: JsonValue;
    }
  | {
      readonly mode: "artifact";
      readonly outputKey: string;
      readonly artifactKind: string;
      readonly mediaType?: string;
    }
  | {
      readonly mode: "none";
    };

export type TaskJoinPolicy =
  | { readonly kind: "all-success" }
  | { readonly kind: "all-terminal" }
  | { readonly kind: "any-success" }
  | { readonly kind: "quorum"; readonly count: number };

export type TaskDependency = {
  readonly taskId: string;
  readonly condition: "accepted" | "terminal";
};

export type TaskInputManifest = {
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly dataReferences: ReadonlyArray<DataReference>;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
};

export type TaskHandlerReference = {
  readonly kind: string;
  readonly version: string;
};

export type TaskAcceptanceReference = {
  readonly policyId: string;
  readonly policyVersion: string;
};

export type TaskRetryPolicy = {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maximumBackoffMs: number;
};

/**
 * Canonical executable task definition. Runtime placement is snapshotted by
 * epoch but remains separate from the logical WorkspaceNode identity.
 */
export type DynamicTaskDefinition = {
  readonly schemaVersion: typeof ROSTER_TASK_DEFINITION_VERSION;
  readonly taskId: string;
  readonly semanticKey: string;
  readonly definitionHash: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective: string;
  readonly handler: TaskHandlerReference;
  readonly acceptance: TaskAcceptanceReference;
  readonly result: TaskResultContract;
  readonly dependencies: ReadonlyArray<TaskDependency>;
  readonly join: TaskJoinPolicy;
  readonly inputs: TaskInputManifest;
  readonly runtimeBindingEpoch: number;
  readonly retry: TaskRetryPolicy;
  readonly timeoutMs: number;
  readonly sideEffect: "pure" | "idempotent" | "non-repeatable";
  readonly estimatedCostMicros: number;
  readonly parentTaskId?: string;
};

export type AcceptedArtifactReference = {
  readonly artifactId: string;
  readonly outputKey: string;
  readonly kind: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly storage: "inline" | "artifact" | "object";
  readonly uri?: string;
  /**
   * Bounded model-authored prose retained by the trusted acceptance boundary
   * for conversational projections. It never replaces the artifact body or
   * participates in task scheduling.
   */
  readonly presentationText?: string;
};

/**
 * The only durable success boundary for task execution. Runtime results are
 * drafts until a trusted acceptance policy produces this outcome.
 */
export type AcceptedTaskOutcome = {
  readonly schemaVersion: typeof ROSTER_TASK_OUTCOME_VERSION;
  readonly outcomeId: string;
  /** Execution scope prevents identical work in separate runs sharing an outcome row. */
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly definitionHash: string;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
  readonly acceptancePolicyId: string;
  readonly acceptancePolicyVersion: string;
  readonly artifacts: ReadonlyArray<AcceptedArtifactReference>;
  readonly usage?: NodeExecutionUsage;
};

export type RunExecutionPolicy = {
  readonly maxTasks: number;
  readonly maxDepth: number;
  readonly maxFanout: number;
  readonly maxInflight: number;
  readonly maxReady: number;
  readonly maxBlocked: number;
  readonly maxAttempts: number;
  readonly maxContextBytes: number;
  readonly maxCostMicros: number;
  readonly maxTokens: number;
  readonly maxWallTimeMs: number;
};
