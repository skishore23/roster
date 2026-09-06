export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export type OrchestrationLimits = {
  readonly maxNodes: number;
  readonly maxTasks: number;
  readonly maxParallel: number;
  readonly maxDepth: number;
};

export type DomainCapability = {
  readonly id: string;
  readonly description: string;
};

export type BuiltInWorkspaceNodeRuntimeKind =
  | "roster-native"
  | "codex-cli"
  | "claude-code"
  | "pi-agent"
  | "hermes-agent"
  | "shell"
  | "a2a";

/**
 * Built-in runtime kinds are documented above, while adapters may register a
 * package-owned kind without requiring a change to Roster core.
 */
export type WorkspaceNodeRuntimeKind = BuiltInWorkspaceNodeRuntimeKind | (string & {});

/**
 * Declares how a logical workspace node executes. Runtime placement is kept
 * separate from topology identity so a node can be rebound after a process or
 * sandbox failure without changing the workflow that refers to it.
 */
export type WorkspaceNodeRuntime = {
  readonly kind: WorkspaceNodeRuntimeKind;
  readonly profile?: string;
  readonly command?: ReadonlyArray<string>;
  readonly endpoint?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type WorkspaceNodeRuntimePlacement = {
  readonly rosterId: string;
  readonly rosterVersion: string;
  readonly policyVersion: string;
  readonly profileId: string;
  readonly reason: string;
};

/**
 * Declares whether a logical node's continuity ends with one run or survives
 * across workspace runs. Scheduling and memory remain Roster-owned control
 * planes; this declaration never grants a runtime authority by itself.
 */
export type WorkspaceNodeContinuityPolicy = {
  readonly mode: "run" | "workspace";
  readonly policyId?: string;
  readonly policyVersion?: string;
  /** Durable job handler selected by the domain for admitted wakes. */
  readonly wakeAgentId?: string;
  readonly memory?: "none" | "private";
  readonly maxPendingInboxItems?: number;
  /** Maximum same-lane deliveries captured by one immutable wake manifest. */
  readonly maxInboxItemsPerWake?: number;
  readonly maxActiveCommitments?: number;
  readonly maxCausalDepth?: number;
  readonly maxWakesPerWindow?: number;
  readonly wakeWindowMs?: number;
  readonly minWakeIntervalMs?: number;
};

export type WorkspaceNode = {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly parentId?: string;
  readonly promptProfile?: string;
  readonly runtime: WorkspaceNodeRuntime;
  readonly continuity?: WorkspaceNodeContinuityPolicy;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type WorkspaceNodeRuntimeBinding = {
  readonly bindingId: string;
  readonly nodeId: string;
  readonly runtime: WorkspaceNodeRuntime;
  readonly epoch: number;
  readonly topologyVersion: string;
  readonly sandboxId?: string;
  readonly sessionId?: string;
  readonly placement?: WorkspaceNodeRuntimePlacement;
};

/**
 * Provider-reported usage for one bounded node execution. Input tokens include
 * cached reads and cache writes; cached/cache-write counts are subsets kept for
 * an inspectable breakdown. Total tokens are input plus output. Execution token
 * policies charge uncached input plus output; cached input remains evidence and
 * may still contribute to provider cost.
 */
export type NodeExecutionUsage = {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
  /** Exact usage observed before an external runtime ended without a completed result. */
  readonly partial?: true;
};

export type DomainPack = {
  readonly id: string;
  readonly version: string;
  readonly policyVersion: string;
  readonly coordinatorId: string;
  readonly capabilities: ReadonlyArray<DomainCapability>;
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly limits: OrchestrationLimits;
};

export type DomainRegistry = {
  readonly pack: DomainPack;
  readonly node: (nodeId: string) => WorkspaceNode;
  readonly nodesFor: (capabilityId: string) => ReadonlyArray<WorkspaceNode>;
  readonly assertNodeAssignment: (nodeId: string, capabilityId: string) => WorkspaceNode;
  readonly extendNodes: (nodes: ReadonlyArray<WorkspaceNode>) => DomainRegistry;
  readonly capability: (capabilityId: string) => DomainCapability;
};

export type PromptTemplate = {
  readonly id: string;
  readonly version: string;
  readonly system: string;
  readonly user: string;
};

export type PromptSpec = {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly template: PromptTemplate;
  readonly variables: Readonly<Record<string, string>>;
  readonly inputVersions?: Readonly<Record<string, string>>;
  readonly constraints?: ReadonlyArray<string>;
  readonly outputContract?: string;
  readonly toolPolicy?: ReadonlyArray<string>;
};

export type CompiledPrompt = {
  readonly promptId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly domainId: string;
  readonly domainVersion: string;
  readonly policyVersion: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly system: string;
  readonly user: string;
  readonly systemHash: string;
  readonly userHash: string;
  readonly variablesHash: string;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly outputContract?: string;
  readonly toolPolicy: ReadonlyArray<string>;
  readonly promptHash: string;
};

export type TaskBinding = {
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective?: string;
  readonly parentTaskId?: string;
  readonly inputVersions?: Readonly<Record<string, string>>;
};
