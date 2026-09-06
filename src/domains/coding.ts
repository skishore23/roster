import { hashCanonical } from "../core/canonical.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  materializeNodeDemand,
  reflectOnOrchestration,
  type NodeDemand,
} from "../engine/orchestration/adaptive.js";
import type { TargetContractSpec } from "../engine/orchestration/target-contract.js";
import type { JsonValue, WorkspaceNode } from "../engine/orchestration/types.js";
import {
  applyWorkspaceParticipantProfile,
  type WorkspaceParticipantProfile,
} from "../engine/workspace/participant-profile.js";
import {
  CODING_HUMAN_NODE_ID,
  CODING_WORKSPACE_DISCOVERY_PI_TOOLS,
  type CodingRepositorySkill,
  type CodingRepositorySkillProvider,
} from "./coding-workspace.js";
import {
  isCodingReviewEligibleNode,
  type CodingConversationCoordination,
  type CodingConversationMessage,
} from "./coding-conversation.js";
import {
  createCodingControlIngressAuthorization,
} from "./coding-control-ingress.js";
import {
  clampCodingAgentTurnPolicy,
  createCodingAgentTurn,
  planCodingAgentTurns,
} from "./coding-agent-turn.js";
import { codingWorkspaceNodeDependencyIds } from "./coding-workspace-enrichment.js";
import {
  CODING_COLLABORATION_RESOLUTION_OUTPUT,
  codingCollaborationEndorsementOutputKey,
  codingCollaborationProposalOutputKey,
  codingCollaborationResponseOutputKey,
  parseCodingPeerResolution,
  type CodingPeerResolution,
} from "./coding-collaboration.js";
import type {
  NodeExecutionAttachmentInput,
  NodeExecutionLogEvent,
  NodeRuntimeRegistry,
} from "../engine/runtime/node-runtime.js";
import type { NodeExecutionTrajectoryObserver } from "../engine/runtime/node-trajectory.js";
import type { NodeRoomUpdateStore } from "../engine/runtime/node-room-updates.js";
import {
  bindRosterMemoryFunctionProviders,
  createRosterMemoryFunctionDescriptors,
  type RosterMemoryRepository,
} from "../engine/runtime/node-memory-plane.js";
import type { DataReferenceStore } from "../engine/dataflow/data-reference-store.js";
import {
  CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID,
  bindCodingWorkerFunctionProviders,
  createCodingWorkerFunctionDescriptors,
} from "./coding-workers.js";
import {
  CODING_CHANGE_FRONTIER_FUNCTION_ID,
} from "./coding-change-frontier.js";
import {
  CODING_ROOM_POST_UPDATE_FUNCTION_ID,
  CODING_ROOM_UPDATE_SCOPE,
  codingRoomUpdateRecipientPolicy,
} from "./coding-room-updates.js";
import {
  CODING_TASK_CONTEXT_INPUT_KEY,
  CODING_TASK_CONTEXT_OUTPUT_KEY,
  codingCapabilityUsesChangeFrontier,
  codingTaskContextPolicy,
  type CodingTaskContextPolicy,
} from "./coding-context.js";
import {
  createRosterRootTask,
  defineRosterPlatform,
  preserveRosterTaskContextDurability,
  ROSTER_CONSULT_FUNCTION_ID,
  ROSTER_NODE_TASK_HANDLER,
  type RosterPlatform,
  type RosterPlatformExecutionOptions,
} from "../engine/platform/roster-platform.js";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
  type DynamicTaskHandlerContext,
} from "../engine/orchestration/task-graph.js";
import type {
  TaskGraphControl,
  TaskGraphControlSnapshot,
} from "../engine/orchestration/task-graph-control.js";
import type {
  DynamicTaskDefinition,
  TaskResultContract,
} from "../engine/platform/protocol.js";
import type { TaskRepositoryPlacement } from "../engine/platform/task-context-manifest.js";
import type { RosterTaskContext } from "../engine/workspace/shared-workspace.js";
import { createWorkspaceNodeRuntimeBinding } from "../engine/workspace/node.js";
import type { RepositoryExecutionProfile } from "../engine/runtime/repository-toolchain.js";
import type { ActiveImprovementSnapshot } from "../engine/runtime/self-improvement-framework.js";
import { applyCodingImprovements } from "./coding-improvements.js";
import {
  codingAcceptedOutputForTask,
  codingAcceptedOutputProjectionKey,
  codingAcceptedTaskIdForRoot,
  codingAcceptedOutputValues,
  projectCodingAcceptedOutputs,
  projectCodingAcceptedOutputsForRoots,
  type CodingAcceptedOutputProjection,
} from "./coding-accepted-outputs.js";
import {
  DEFAULT_CODING_PI_EXTENSION_PACKAGES,
  resolvePiExtensionPackagePaths,
} from "../engine/runtime/pi-extension-packages.js";
import {
  captureGitRunPatch,
  prepareGitRunCommit,
  type GitRunPreparedCommit,
  type GitRunWorkspace,
} from "../engine/runtime/git-run-workspace.js";

export type CodingAgentInput = {
  readonly objective: string;
  readonly runId?: string;
};

export type CodingExecutionKind = "mutation" | "investigation";

export type CodingAgentPlatformOptions = {
  /** Whether this run may mutate an isolated Git frontier or only inspect the repository. */
  readonly executionKind?: CodingExecutionKind;
  readonly workingDirectory?: string;
  readonly repositoryExecutionProfile?: RepositoryExecutionProfile;
  readonly workerRuntime?: CodingWorkerRuntime;
  readonly reviewerRuntime?: CodingReviewerRuntime;
  readonly codexProfile?: string;
  readonly claudeProfile?: string;
  readonly codexModel?: string;
  readonly reviewerCodexModel?: string;
  readonly codexReasoningEffort?: CodingCodexReasoningEffort;
  /** Immutable API-only authority for the post-edit public-registry worker. */
  readonly dependencyResolution?: "registry";
  readonly claudeModel?: string;
  readonly hermesProvider?: string;
  readonly hermesModel?: string;
  readonly piProvider?: string;
  readonly piModel?: string;
  readonly piThinking?: string;
  readonly piExtensions?: ReadonlyArray<string>;
  readonly piSkills?: ReadonlyArray<string>;
  readonly piPromptTemplates?: ReadonlyArray<string>;
  readonly piTools?: ReadonlyArray<string>;
  readonly piExcludeTools?: ReadonlyArray<string>;
  readonly piProjectTrust?: CodingPiProjectTrust;
  readonly piNoBuiltinTools?: boolean;
  readonly piNoExtensions?: boolean;
  readonly piOffline?: boolean;
  /** Tracked skills discovered from the exact repository checkout for this run. */
  readonly repositorySkills?: ReadonlyArray<CodingRepositorySkill>;
  readonly maxNodes?: number;
  readonly maxParallel?: number;
  readonly maxSupervisors?: number;
  /**
   * Operational window for one active dispatcher tenure, not the lifetime of
   * its durable workflow. The domain keeps a hard ceiling while allowing long
   * reviewed runs to resume across queue waits and replacement workers.
   */
  readonly maxWallTimeMs?: number;
  readonly reviewPolicy?: CodingReviewPolicy;
  /** Exact Git placement captured before each task starts. */
  readonly repositoryPlacement?: TaskRepositoryPlacement;
  /** Provider-neutral reservation policy for paid model tasks. */
  readonly providerBudget?: Partial<Record<CodingModelCapability, {
    readonly estimatedCostMicros: number;
    readonly reservedTokens: number;
  }>>;
  /** Repository-reviewed logical nodes reused across later change conversations. */
  readonly workspaceNodes?: ReadonlyArray<WorkspaceNode>;
  /** Latest workspace-wide social/skill overlays applied before this run is snapshotted. */
  readonly participantProfiles?: ReadonlyArray<WorkspaceParticipantProfile>;
  /** Roster-validated node selection authored by the conversation planner. */
  readonly selectedNodeIds?: ReadonlyArray<string>;
  /** Saved specialist granted mutation authority for this bounded run. */
  readonly primaryNodeId?: string;
  /** Accepted typed decision produced by the bounded coordination skill. */
  readonly coordination?: CodingConversationCoordination;
  /** Authorized durable room/workspace memory projected into code-mode workers. */
  readonly memoryRepository?: RosterMemoryRepository;
  /** Complete human-authored decision frontier for a prior ambiguous attempt. */
  readonly humanResolution?: CodingPeerResolution;
  /** Promoted framework policy/prompt snapshot pinned before this run is admitted. */
  readonly activeImprovementSnapshot?: ActiveImprovementSnapshot;
};

export const DEFAULT_CODING_AGENT_MODELS = {
  piWorker: "openai-codex/gpt-5.6-luna",
  worker: "gpt-5.6-sol",
  reviewer: "gpt-5.6-sol",
  claudeWorker: "sonnet",
  claudeReviewer: "sonnet",
  hermesWorker: "default",
} as const;

export type CodingAgentRole = "worker" | "supervisor";
export type CodingWorkerRuntime = "codex-cli" | "claude-code" | "pi-agent" | "hermes-agent";
export type CodingReviewerRuntime = "codex-cli" | "claude-code";
export type CodingCodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type CodingPiProjectTrust = "approve" | "no-approve" | "default";
export type CodingReviewPolicy = "auto" | "fast" | "reviewed";
export type CodingReviewMode = Exclude<CodingReviewPolicy, "auto">;

export class CodingReviewedSelectionUnavailableError extends Error {
  override readonly name = "CodingReviewedSelectionUnavailableError";
}

/**
 * Preflights a reviewed route against the saved workspace roster without
 * materializing topology. Runtime admission still validates the resulting
 * selection through deriveCodingNodeDemands.
 */
export const resolveCodingReviewedSelection = (input: {
  readonly nodes: readonly WorkspaceNode[];
  readonly selectedNodeIds: readonly string[];
  readonly primaryNodeId: string;
  readonly reviewMode: CodingReviewMode;
}): { readonly selectedNodeIds: readonly string[]; readonly reviewerNodeId?: string } => {
  const selectedNodeIds = [...new Set(input.selectedNodeIds)];
  const primary = input.nodes.find((node) => node.id === input.primaryNodeId);
  if (!primary || primary.metadata?.participantKind === "human") {
    throw new Error("Coding selection requires a saved non-human primary workspace node");
  }
  if (!selectedNodeIds.includes(primary.id)) {
    throw new Error("Coding selection must include its primary workspace node");
  }
  if (input.reviewMode === "fast") return { selectedNodeIds };

  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const eligibleReviewer = (node: WorkspaceNode | undefined): node is WorkspaceNode =>
    isCodingReviewEligibleNode(node, primary.id);
  const selectedReviewer = selectedNodeIds
    .map((nodeId) => byId.get(nodeId))
    .find(eligibleReviewer);
  if (selectedReviewer) {
    return { selectedNodeIds, reviewerNodeId: selectedReviewer.id };
  }
  throw new CodingReviewedSelectionUnavailableError(
    "Reviewed coding requires a saved review-capable workspace node. Enable or select one before starting this run.",
  );
};

export type CodingModelCapability =
  | "room"
  | "propose"
  | "respond"
  | "resolve"
  | "implement"
  | "investigate"
  | "review"
  | "remediate"
  | "synthesize"
  | "certify";

export const CODING_FINAL_ANSWER_OUTPUT = "coding_final_answer" as const;

export type CodingNodeDemand = NodeDemand & {
  readonly role: CodingAgentRole;
  readonly specialty: string;
};

export const CODING_ROOM_CONTROL_INTENT_VERSION = "roster.coding-control-intent.v1" as const;

export type CodingRoomControlIntent = {
  readonly schemaVersion: typeof CODING_ROOM_CONTROL_INTENT_VERSION;
  readonly intentId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly kind: "follow-up";
  readonly text: string;
  readonly createdAtMs: number;
  readonly messageId?: string;
};

export type CodingRoomControlIntentIngress = {
  /** Reads only durable, pending intents from the Room OS authority. */
  readonly pending: (input: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly runId: string;
    readonly boundaryTaskId: string;
  }) => Promise<ReadonlyArray<CodingRoomControlIntent>>;
  /** Atomically marks an intent consumed by the graph expansion that admitted it. */
  readonly consume: (input: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly runId: string;
    readonly boundaryTaskId: string;
    readonly intentId: string;
    readonly expansionKey: string;
  }) => Promise<void>;
};

export type CodingCertifiedCheckpoint = {
  readonly checkpointId: string;
  readonly frontierVersion: string;
  readonly repository: TaskRepositoryPlacement;
};

export type CodingFollowUpExecutionRequest = {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly intentId: string;
  readonly objective: string;
  readonly checkpoint: CodingCertifiedCheckpoint;
};

/**
 * Terminal follow-ups remain in the same room but must start a new execution
 * from an explicit certified checkpoint. This value is an enqueue contract;
 * Room OS reducers remain the authority for whether the intent is still
 * pending and the checkpoint is current.
 */
export const createCodingFollowUpExecutionRequest = (input: {
  readonly intent: CodingRoomControlIntent;
  readonly checkpoint: CodingCertifiedCheckpoint;
}): CodingFollowUpExecutionRequest => {
  const intent = createCodingRoomControlIntent(input.intent);
  const checkpointId = input.checkpoint.checkpointId.trim();
  const frontierVersion = input.checkpoint.frontierVersion.trim();
  if (!checkpointId || checkpointId.length > 240 || !frontierVersion || frontierVersion.length > 240) {
    throw new Error("Coding terminal follow-up requires a bounded certified checkpoint");
  }
  if (!input.checkpoint.repository.commit) {
    throw new Error("Coding terminal follow-up checkpoint requires an exact certified Git commit");
  }
  return {
    workspaceId: intent.workspaceId,
    roomId: intent.roomId,
    intentId: intent.intentId,
    objective: intent.text,
    checkpoint: {
      checkpointId,
      frontierVersion,
      repository: input.checkpoint.repository,
    },
  };
};

export const createCodingRoomControlIntent = (
  input: Omit<CodingRoomControlIntent, "schemaVersion" | "intentId"> & {
    readonly intentId?: string;
  },
): CodingRoomControlIntent => {
  const workspaceId = input.workspaceId.trim();
  const roomId = input.roomId.trim();
  const text = input.text.trim();
  if (!workspaceId || workspaceId.length > 512 || !roomId || roomId.length > 512) {
    throw new Error("Coding room control intent requires bounded workspace and room ids");
  }
  if (!text || text.length > 16_384) {
    throw new Error("Coding room control follow-up must be between 1 and 16384 characters");
  }
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) {
    throw new Error("Coding room control intent createdAtMs must be a non-negative safe integer");
  }
  const identity = {
    schemaVersion: CODING_ROOM_CONTROL_INTENT_VERSION,
    workspaceId,
    roomId,
    kind: "follow-up" as const,
    text,
    createdAtMs: input.createdAtMs,
    ...(input.messageId?.trim() ? { messageId: input.messageId.trim() } : {}),
  };
  const intentId = input.intentId?.trim()
    ?? `coding_intent_${hashCanonical(identity).slice(0, 28)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(intentId) || intentId.length > 240) {
    throw new Error("Coding room control intent id is invalid");
  }
  return { ...identity, intentId };
};

const CODING_WORKER_TIMEOUT_MS = 20 * 60_000;
const CODING_ROOM_ANNOUNCEMENT_TIMEOUT_MS = 60_000;
const CODING_PROPOSAL_TIMEOUT_MS = 7 * 60_000;
// Real CLI reviewers can spend several minutes loading and checking an
// isolated repository before producing their bounded verdict. Keep their
// deadline aligned with mutation workers so a healthy late review does not
// turn an otherwise recoverable run into a terminal timeout.
const CODING_REVIEW_TIMEOUT_MS = 20 * 60_000;
const CODING_RESOLUTION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CODING_RUN_WALL_TIME_MS = 8 * 60 * 60_000;
const MIN_CODING_RUN_WALL_TIME_MS = 30_000;
const MAX_CODING_RUN_WALL_TIME_MS = 24 * 60 * 60_000;

const DEFAULT_CODING_PROVIDER_BUDGET: Readonly<Record<CodingModelCapability, {
  readonly estimatedCostMicros: number;
  readonly reservedTokens: number;
}>> = {
  room: { estimatedCostMicros: 3_000, reservedTokens: 1_024 },
  propose: { estimatedCostMicros: 40_000, reservedTokens: 16_384 },
  respond: { estimatedCostMicros: 30_000, reservedTokens: 12_288 },
  resolve: { estimatedCostMicros: 60_000, reservedTokens: 24_576 },
  implement: { estimatedCostMicros: 180_000, reservedTokens: 65_536 },
  investigate: { estimatedCostMicros: 180_000, reservedTokens: 65_536 },
  review: { estimatedCostMicros: 75_000, reservedTokens: 32_768 },
  remediate: { estimatedCostMicros: 150_000, reservedTokens: 65_536 },
  synthesize: { estimatedCostMicros: 40_000, reservedTokens: 16_384 },
  certify: { estimatedCostMicros: 60_000, reservedTokens: 24_576 },
};

const codingProviderBudget = (
  options: CodingAgentPlatformOptions,
  capability: string,
) => capability in DEFAULT_CODING_PROVIDER_BUDGET
  ? options.providerBudget?.[capability as CodingModelCapability]
    ?? DEFAULT_CODING_PROVIDER_BUDGET[capability as CodingModelCapability]
  : { estimatedCostMicros: 0, reservedTokens: 0 };

const normalizeBound = (value: number | undefined, fallback: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.floor(value ?? fallback)));

const requireCodingCoordination = (
  coordination: CodingConversationCoordination | undefined,
): CodingConversationCoordination => {
  if (!coordination) {
    throw new Error("Coding execution requires an accepted roster-coordination skill decision");
  }
  if (coordination.validationScope === "repository-wide" && coordination.reviewMode !== "reviewed") {
    throw new Error("Repository-wide coding validation requires reviewed coordination");
  }
  return coordination;
};

/** User policy may upgrade the skill decision to reviewed, never downgrade it. */
export const codingReviewMode = (
  coordination: CodingConversationCoordination,
  policy: CodingReviewPolicy = "auto",
): CodingReviewMode =>
  policy === "reviewed" || coordination.reviewMode === "reviewed" ? "reviewed" : "fast";

/**
 * A focused decision with one explicit review peer uses the smaller reviewed
 * graph. Repository-wide decisions always retain the full resolution council.
 */
const usesCompactReviewedPlan = (
  coordination: CodingConversationCoordination,
  nodes: ReadonlyArray<WorkspaceNode>,
  mode: CodingReviewMode,
): boolean => mode === "reviewed"
  && nodes.filter((node) => node.metadata?.role === "supervisor").length === 1
  && coordination.validationScope === "focused";

/** Materializes only the exact saved nodes accepted from the coordination turn. */
export const deriveCodingNodeDemands = (
  options: Pick<CodingAgentPlatformOptions, "coordination" | "executionKind" | "maxSupervisors" | "reviewPolicy" | "workspaceNodes" | "selectedNodeIds" | "primaryNodeId">,
): ReadonlyArray<CodingNodeDemand> => {
  const coordination = requireCodingCoordination(options.coordination);
  const mode = codingReviewMode(coordination, options.reviewPolicy);
  const maxSupervisors = normalizeBound(options.maxSupervisors, 4, 1, 6);
  const selectedIds = new Set(options.selectedNodeIds ?? []);
  const profileNodes = options.workspaceNodes ?? [];
  if (!options.primaryNodeId || !selectedIds.has(options.primaryNodeId)) {
    throw new Error("Coding execution requires an explicitly selected primary workspace node");
  }
  const unknownNodeId = [...selectedIds].find((nodeId) =>
    !profileNodes.some((node) => node.id === nodeId));
  if (unknownNodeId) throw new Error(`Coding execution selected unknown workspace node ${unknownNodeId}`);
  const profileWorker = profileNodes.find((node) => node.id === options.primaryNodeId);
  const investigation = options.executionKind === "investigation";
  if (!profileWorker
    || profileWorker.metadata?.participantKind === "human"
    || (investigation
      ? !profileWorker.capabilities.some((capability) => capability === "respond" || capability === "review" || capability === "implement")
      : (!profileWorker.capabilities.includes("implement") && profileWorker.metadata?.role !== "worker"))) {
    throw new Error(investigation
      ? "The selected primary workspace node cannot investigate the repository"
      : "The selected primary workspace node does not have mutation capability");
  }
  const profileSupervisors = profileNodes
    .filter((node) => node.id !== profileWorker.id)
    .filter((node) => investigation
      ? node.metadata?.participantKind !== "human"
        && node.capabilities.some((capability) => capability === "respond" || capability === "review" || capability === "implement")
      : node.metadata?.role === "supervisor" || node.capabilities.includes("review"))
    .filter((node) => selectedIds.has(node.id))
    .slice(0, maxSupervisors);
  if (mode === "reviewed" && profileSupervisors.length === 0) {
    throw new Error("Reviewed coding execution requires an explicitly selected review-capable workspace node");
  }
  const demandFor = (node: WorkspaceNode, role: CodingAgentRole): CodingNodeDemand => {
    const specialty = typeof node.metadata?.specialty === "string" ? node.metadata.specialty : "general";
    const repositoryReason = typeof node.metadata?.repositoryReason === "string"
      ? node.metadata.repositoryReason.trim()
      : "";
    if (!repositoryReason) {
      throw new Error(`Workspace node ${node.id} is missing its saved repository responsibility`);
    }
    return {
      role,
      specialty,
      capability: investigation ? "investigate" : role === "worker" ? "implement" : "review",
      additionalCapabilities: investigation
        ? ["respond", "room", "memory"]
        : role === "worker"
          ? ["propose", "respond", "remediate", "synthesize", "validate", "room", "memory"]
          : ["propose", "respond", "certify", "room", "memory"],
      objective: repositoryReason,
      name: node.name,
      nameSource: "profile",
      group: typeof node.metadata?.group === "string" ? node.metadata.group : "Repository peers",
      focus: specialty,
      metadata: {
        role,
        specialty,
        workspaceNodeId: node.id,
        collaborationRole: investigation
          ? role === "worker" ? "investigation-lead" : "investigation-peer"
          : role === "worker" ? "mutation-peer" : "peer-reviewer",
        authority: "peer",
      },
    };
  };
  return [
    demandFor(profileWorker, "worker"),
    ...(investigation || mode !== "fast"
      ? profileSupervisors.map((node) => demandFor(node, "supervisor"))
      : []),
  ];
};

const runtimeMetadata = (
  workingDirectory: string | undefined,
  provider: "codex" | "claude",
  model: string,
  role: CodingAgentRole,
  readOnly: boolean,
  codexReasoningEffort: CodingCodexReasoningEffort = "high",
) => ({
  ...(workingDirectory ? { workingDirectory } : {}),
  model,
  ...(provider === "codex"
    ? { sandbox: !readOnly && role === "worker" ? "workspace-write" : "read-only", reasoningEffort: codexReasoningEffort }
    : { permissionMode: !readOnly && role === "worker" ? "acceptEdits" : "plan" }),
});

const piRuntimeMetadata = (
  workingDirectory: string | undefined,
  options: CodingAgentPlatformOptions,
  repositorySkills: ReadonlyArray<CodingRepositorySkill>,
) => {
  const provider = options.piProvider;
  const defaultModel = provider === undefined
    ? DEFAULT_CODING_AGENT_MODELS.piWorker
    : provider === "openai-codex"
      ? DEFAULT_CODING_AGENT_MODELS.piWorker.slice("openai-codex/".length)
      : undefined;
  const configuredModel = options.piModel ?? defaultModel;
  const qualifiedProvider = configuredModel?.includes("/")
    ? configuredModel.slice(0, configuredModel.indexOf("/"))
    : undefined;
  if (provider && qualifiedProvider && provider !== qualifiedProvider) {
    throw new Error(`Pi provider ${provider} conflicts with qualified model ${configuredModel}`);
  }
  const model = provider && qualifiedProvider
    ? configuredModel?.slice(configuredModel.indexOf("/") + 1)
    : configuredModel;
  const skills = [...new Set([
    ...(options.piSkills ?? []),
    ...repositorySkills.map((skill) => workingDirectory
      ? resolve(workingDirectory, skill.relativePath)
      : skill.relativePath),
  ])];
  const extensions = options.piNoExtensions
    ? []
    : options.piExtensions
      ?? resolvePiExtensionPackagePaths(DEFAULT_CODING_PI_EXTENSION_PACKAGES);
  return {
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(options.piThinking ? { thinking: options.piThinking } : {}),
    ...(extensions.length ? { extensions: [...extensions] } : {}),
    ...(skills.length ? { skills } : {}),
    ...(options.piPromptTemplates?.length ? { promptTemplates: [...options.piPromptTemplates] } : {}),
    ...(options.executionKind === "investigation"
      ? { tools: [...CODING_WORKSPACE_DISCOVERY_PI_TOOLS] }
      : options.piTools?.length ? { tools: [...options.piTools] } : {}),
    ...(options.piExcludeTools?.length ? { excludeTools: [...options.piExcludeTools] } : {}),
    ...(options.executionKind === "investigation"
      ? { projectTrust: "no-approve" as const }
      : options.piProjectTrust ? { projectTrust: options.piProjectTrust } : {}),
    ...(options.piNoBuiltinTools !== undefined ? { noBuiltinTools: options.piNoBuiltinTools } : {}),
    ...(options.piNoExtensions !== undefined ? { noExtensions: options.piNoExtensions } : {}),
    ...(options.piOffline !== undefined ? { offline: options.piOffline } : {}),
  };
};

const hermesRuntimeMetadata = (
  workingDirectory: string | undefined,
  options: CodingAgentPlatformOptions,
) => ({
  ...(workingDirectory ? { workingDirectory } : {}),
  ...(options.hermesProvider ? { provider: options.hermesProvider } : {}),
  ...(options.hermesModel && options.hermesModel !== DEFAULT_CODING_AGENT_MODELS.hermesWorker
    ? { model: options.hermesModel }
    : {}),
  yolo: options.executionKind !== "investigation",
});

export const materializeCodingNode = (input: {
  readonly runId: string;
  readonly reflectionId: string;
  readonly index: number;
  readonly demand: CodingNodeDemand;
  readonly options?: CodingAgentPlatformOptions;
  readonly profileNode?: WorkspaceNode;
}): WorkspaceNode => {
  const created = materializeNodeDemand({
    runId: input.runId,
    reflectionId: input.reflectionId,
    index: input.index,
    coordinatorId: "coordinator",
    demand: input.demand,
  });
  const options = input.options ?? {};
  const worker = input.demand.role === "worker";
  const workerRuntime = options.workerRuntime ?? "pi-agent";
  const reviewerRuntime = options.reviewerRuntime ?? "codex-cli";
  const profileNode = input.profileNode;
  const runtimeKind: CodingRepositorySkillProvider = worker ? workerRuntime : reviewerRuntime;
  const repositorySkills = (options.repositorySkills ?? [])
    .filter((skill) => skill.providers.includes(runtimeKind));
  return {
    ...(profileNode ?? created),
    capabilities: [...new Set([
      ...(profileNode?.capabilities ?? []),
      ...created.capabilities,
    ])],
    // Coding specialists are peers in a composition graph. Task dependencies,
    // not parentId, express collaboration order and temporary authority.
    parentId: undefined,
    runtime: runtimeKind === "pi-agent"
      ? {
          kind: "pi-agent",
          metadata: piRuntimeMetadata(options.workingDirectory, options, repositorySkills),
        }
      : runtimeKind === "codex-cli"
        ? {
            kind: "codex-cli",
            ...(options.codexProfile ? { profile: options.codexProfile } : {}),
            metadata: runtimeMetadata(
              options.workingDirectory,
              "codex",
              worker
                ? options.codexModel ?? DEFAULT_CODING_AGENT_MODELS.worker
                : options.reviewerCodexModel ?? DEFAULT_CODING_AGENT_MODELS.reviewer,
              input.demand.role,
              options.executionKind === "investigation",
              options.codexReasoningEffort,
            ),
          }
        : runtimeKind === "hermes-agent"
          ? {
              kind: "hermes-agent",
              metadata: hermesRuntimeMetadata(options.workingDirectory, options),
            }
        : {
            kind: "claude-code",
            ...(options.claudeProfile ? { profile: options.claudeProfile } : {}),
            metadata: runtimeMetadata(
              options.workingDirectory,
              "claude",
              options.claudeModel ?? (worker
                ? DEFAULT_CODING_AGENT_MODELS.claudeWorker
                : DEFAULT_CODING_AGENT_MODELS.claudeReviewer),
              input.demand.role,
              options.executionKind === "investigation",
            ),
          },
    metadata: {
      ...(profileNode?.metadata ?? {}),
      ...(created.metadata ?? {}),
      role: input.demand.role,
      specialty: input.demand.specialty,
      collaborationRole: options.executionKind === "investigation"
        ? input.demand.role === "worker" ? "investigation-lead" : "investigation-peer"
        : input.demand.role === "worker" ? "mutation-peer" : "peer-reviewer",
      authority: "peer",
      ...(repositorySkills.length ? {
        repositorySkills: repositorySkills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          relativePath: skill.relativePath,
        })),
      } : {}),
      ...(profileNode ? { workspaceProfile: true, displayNameSource: "profile" } : {}),
    },
  };
};

const workspaceProfileForDemand = (
  nodes: ReadonlyArray<WorkspaceNode> | undefined,
  demand: CodingNodeDemand,
): WorkspaceNode | undefined => {
  const workspaceNodeId = typeof demand.metadata?.workspaceNodeId === "string"
    ? demand.metadata.workspaceNodeId
    : undefined;
  return nodes?.find((node) => workspaceNodeId
    ? node.id === workspaceNodeId
    : node.metadata?.specialty === demand.specialty && node.metadata?.role === demand.role);
};

const specialtyOf = (node: WorkspaceNode): string =>
  typeof node.metadata?.specialty === "string" ? node.metadata.specialty : "general";

const safeTaskPart = (value: string): string => {
  let result = "";
  for (const character of value.toLowerCase()) {
    const allowed = (character >= "a" && character <= "z")
      || (character >= "0" && character <= "9");
    if (allowed) result += character;
    else if (result && !result.endsWith("-")) result += "-";
  }
  while (result.endsWith("-")) result = result.slice(0, -1);
  return result || "general";
};

const codingNodeTaskKey = (node: WorkspaceNode): string => {
  const readable = safeTaskPart(node.id).slice(0, 48);
  return `${readable}-${hashCanonical(node.id).slice(0, 8)}`;
};

const codingPlanNodes = (
  nodes: ReadonlyArray<WorkspaceNode>,
  coordination: CodingConversationCoordination,
  mode: CodingReviewMode,
  runId: string,
): ReadonlyArray<WorkspaceNode> => {
  if (mode === "fast"
    || usesCompactReviewedPlan(coordination, nodes, mode)
    || nodes.some((node) => node.metadata?.collaborationRole === "temporary-resolver")) return nodes;
  const runtimePeer = [...nodes]
    .filter((node) => node.metadata?.role === "supervisor" && node.runtime)
    .sort((left, right) => codingWorkspaceNodeDependencyIds(left).length - codingWorkspaceNodeDependencyIds(right).length
      || left.id.localeCompare(right.id))[0];
  if (!runtimePeer) throw new Error("Reviewed coding plans require a read-only peer runtime for temporary resolution");
  const participantIds = nodes.map((node) => node.id).sort();
  return [
    ...nodes,
    {
      id: `coding.resolution.${hashCanonical({ runId, participantIds, runtime: runtimePeer.runtime?.kind }).slice(0, 20)}`,
      name: "Resolution Reviewer",
      capabilities: ["resolve", "memory"],
      runtime: runtimePeer.runtime,
      metadata: {
        role: "resolver",
        displayRole: "Run-scoped conflict review",
        specialty: "resolution",
        collaborationRole: "temporary-resolver",
        authority: "conflict-scoped",
        temporary: true,
        displayNameSource: "generated",
        group: "Repository peers",
        runtimeSourceNodeId: runtimePeer.id,
        participantIds,
      },
    },
  ];
};

export type CodingValidationScope = "focused" | "repository-wide";

export type CodingValidationPlan = {
  readonly scope: CodingValidationScope;
  readonly rationale: string;
  readonly crossBoundary: boolean;
  readonly changedSurfaces: number;
};

/**
 * Derives whether this run's checks stay scoped to the task delta or require
 * one additional authoritative full-repository toolchain gate. Pure and
 * deterministic over the accepted coordination decision and selected review
 * population; it reads no repository paths and interprets no objective text.
 */
export const deriveCodingValidationPlan = (
  coordination: CodingConversationCoordination,
  nodes: ReadonlyArray<WorkspaceNode>,
): CodingValidationPlan => {
  const changedSurfaces = new Set(
    nodes.filter((node) => node.metadata?.role === "supervisor").map(specialtyOf),
  ).size;
  const crossBoundary = coordination.validationScope === "repository-wide";
  return {
    scope: coordination.validationScope,
    rationale: crossBoundary
      ? `Repository-wide validation selected by the accepted coordination skill across ${changedSurfaces} review specialties.`
      : `Focused validation selected by the accepted coordination skill across ${changedSurfaces} review specialties.`,
    crossBoundary,
    changedSurfaces,
  };
};

const REPOSITORY_VALIDATION_REPORT = "repository_validation_report";
const REPOSITORY_VALIDATION_WORKER_URL = new URL(
  `../engine/runtime/repository-validation-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  import.meta.url,
);

export const codingRepositoryValidationRuntime = (
  workingDirectory: string,
  executionProfile?: RepositoryExecutionProfile,
) => {
  const workerPath = fileURLToPath(REPOSITORY_VALIDATION_WORKER_URL);
  return {
    kind: "shell" as const,
    command: [
      process.execPath,
      ...(workerPath.endsWith(".ts") ? ["--import", "tsx"] : []),
      workerPath,
      workingDirectory,
      ...(executionProfile ? [Buffer.from(JSON.stringify(executionProfile)).toString("base64url")] : []),
    ],
    profile: "repository-validation",
    metadata: { workingDirectory },
  };
};

const CODING_MUTATION_FRONTIER_HASH_INSTRUCTION = [
  "Before returning, run `git add -A -- .` in the isolated checkout.",
  "Set frontierHash to the lowercase SHA-256 of the exact bytes from",
  "`git --no-pager diff --cached --binary --full-index HEAD --`.",
  "Roster recomputes this hash from an immutable Git tree at the commit boundary and rejects any mismatch.",
].join(" ");

const CODING_AUTONOMOUS_IMPROVEMENT_INSTRUCTION = [
  "When concrete evidence from this run reveals a reusable Roster Coding framework weakness rather than a repository-specific issue, include exactly one optional improvementCandidate in the verified report.",
  "Shape it as {artifactType:\"prompt_patch\"|\"policy_patch\"|\"harness_patch\",target:\"coding.prompt\"|\"coding.policy\"|\"coding.harness\",patch:object,rationale:string,evidence:string[]} with the matching target.",
  "Prompt patches may contain only bounded instructions, policy patches may only tighten maxNodes/maxParallel/maxSupervisors or set reviewPolicy to reviewed, and harness patches may contain only requiredChecks.",
  "Omit improvementCandidate unless the accepted Git and validation evidence supports it; Roster independently verifies, canaries, promotes, monitors, and rolls it back.",
].join(" ");

const codingCertificationFrontierInstruction = (
  source: "final_report" | typeof REPOSITORY_VALIDATION_REPORT,
): string => [
  `Use ${source}.frontierHash as this endorsement's candidate frontier identifier.`,
  "Do not run `git add`, write the Git index, or derive the identifier from this execution's private index.",
  "Inspect the actual worktree delta with read-only commands and return that exact supplied frontierHash only when approving it.",
  "Roster independently recomputes the frontier from an immutable Git tree at the commit boundary and rejects any mismatch.",
].join(" ");

const codingExecutionProfileConstraint = (
  executionProfile?: RepositoryExecutionProfile,
): string | undefined => {
  const evidenceFiles = executionProfile?.evidenceFiles.slice(0, 16);
  if (!evidenceFiles?.length) return undefined;
  return [
    `Keep the content-addressed toolchain evidence files unchanged in this run: ${evidenceFiles.join(", ")}.`,
    "Use their existing scripts or direct focused commands for task-level checks.",
    "A dependency, script, lockfile, or toolchain change requires a separately reviewed and onboarded execution profile.",
  ].join(" ");
};

const codingTargetContract = (
  objective: string,
  validationPlan: CodingValidationPlan,
  mode: CodingReviewMode,
  executionProfile?: RepositoryExecutionProfile,
): TargetContractSpec => ({
  id: "coding-change",
  version: "1",
  objective,
  acceptanceCriteria: [
    "The requested repository change is implemented completely with no unrelated source changes.",
    `${validationPlan.scope === "repository-wide" ? "Repository-wide" : "Focused"} validation evidence satisfies the selected validation policy.`,
    mode === "fast"
      ? "The mutation node returns a verified final report for the exact Git frontier."
      : "Every required review and certification task accepts the same exact Git frontier.",
  ],
  constraints: [
    "Only tasks with explicit mutation authority may edit repository files.",
    "Preserve unresolved semantic conflicts instead of selecting by arrival order.",
    ...(codingExecutionProfileConstraint(executionProfile)
      ? [codingExecutionProfileConstraint(executionProfile)!]
      : []),
  ],
});

const codingInvestigationTargetContract = (objective: string): TargetContractSpec => ({
  id: "coding-investigation",
  version: "1",
  objective,
  acceptanceCriteria: [
    "The selected specialists inspect the repository deeply enough to answer the question with concrete evidence.",
    "The final report synthesizes relevant findings, file references, limitations, and disagreements without claiming unperformed work.",
    "No repository file, Git ref, dependency state, or external system is mutated.",
  ],
  constraints: [
    "Use read-only repository tools and continue investigating until the answer is substantive or a concrete blocker is proven.",
    "Preserve conflicting evidence explicitly instead of selecting by arrival order.",
  ],
});

export type CodingTaskBlueprint = {
  readonly id: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective: string;
  readonly needs: ReadonlyArray<string>;
  readonly provides: ReadonlyArray<string>;
  readonly context: CodingTaskContextPolicy;
};

export type CodingAgentGraphPreview = {
  readonly id: "coding-agent";
  readonly version: string;
  readonly target: TargetContractSpec;
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly maxParallel: number;
  readonly tasks: ReadonlyArray<CodingTaskBlueprint>;
  readonly topologicalOrder: ReadonlyArray<string>;
};

type CodingTaskBlueprintDraft = Omit<CodingTaskBlueprint, "context">;

type CodingTaskBlueprintGraph = Omit<
  CodingAgentGraphPreview,
  "id" | "topologicalOrder" | "tasks"
> & {
  readonly id: "coding-agent";
  readonly initialArtifacts: ReadonlyArray<string>;
  readonly tasks: ReadonlyArray<CodingTaskBlueprintDraft>;
};

const codingFinalAnswerBlueprint = (
  worker: WorkspaceNode,
  needs: ReadonlyArray<string>,
): CodingTaskBlueprintDraft => ({
  id: "synthesize-final",
  nodeId: worker.id,
  capability: "synthesize",
  objective: [
    "Synthesize the single final answer to the human from the accepted current mutation frontier and its certification evidence.",
    "Do not edit files, run tools, introduce new claims, quote internal handoffs, or address another workspace node. State what changed, the validation that actually ran, and any material limitation in direct natural language.",
    `Return ${CODING_FINAL_ANSWER_OUTPUT} as strict JSON: {status:"completed",summary:string (1-1600 characters),frontierHash:string}. The summary is the one human-addressed final answer; copy the exact certified frontierHash from the accepted final_report and matching endorsements.`,
  ].join(" "),
  needs: [...new Set(needs)],
  provides: [CODING_FINAL_ANSWER_OUTPUT],
});

const codingPlan = (
  objective: string,
  nodes: ReadonlyArray<WorkspaceNode>,
  maxParallel: number,
  coordination: CodingConversationCoordination,
  mode: CodingReviewMode,
  executionKind: CodingExecutionKind,
  executionProfile?: RepositoryExecutionProfile,
): CodingTaskBlueprintGraph => {
  const worker = nodes.find((node) => node.metadata?.role === "worker");
  const supervisors = nodes.filter((node) => node.metadata?.role === "supervisor");
  const resolver = nodes.find((node) => node.metadata?.collaborationRole === "temporary-resolver");
  const compactReviewed = usesCompactReviewedPlan(coordination, nodes, mode);
  if (executionKind === "investigation") {
    if (!worker) throw new Error("Coding investigations require one synthesis lead");
    const investigators = [worker, ...supervisors];
    const evidenceTasks = investigators.map((node) => {
      const key = codingNodeTaskKey(node);
      const outputKey = `investigation_${key}_report`;
      return {
        id: `investigate-${key}`,
        nodeId: node.id,
        capability: "investigate",
        objective: [
          `${node.name}: investigate this repository question from your ${specialtyOf(node)} responsibility: ${objective}`,
          "Use read-only repository tools eagerly. Open the relevant implementation, tests, configuration, and documentation; search outward when the first files do not settle the question.",
          "Continue until you have a substantive evidence-backed account or can name a concrete blocker. Do not edit files, install dependencies, create Git state, or merely propose that somebody else inspect the repository.",
          `Return ${outputKey} as strict JSON: {status:"completed",summary:string,findings:[{claim:string,evidence:string[]}],files:string[],limitations:string[]}. Use repository-relative file paths and line numbers in evidence when available.`,
        ].join(" "),
        needs: ["request"],
        provides: [outputKey],
      } satisfies CodingTaskBlueprintDraft;
    });
    const evidenceKeys = evidenceTasks.flatMap((task) => task.provides);
    return {
      id: "coding-agent",
      version: "3.3.0-investigation",
      target: codingInvestigationTargetContract(objective),
      nodes,
      initialArtifacts: ["request"],
      maxParallel: Math.max(1, Math.min(maxParallel, evidenceTasks.length)),
      tasks: [
        ...evidenceTasks,
        {
          id: "synthesize-investigation",
          nodeId: worker.id,
          capability: "investigate",
          objective: [
            `Synthesize the completed specialist investigation into the definitive answer to: ${objective}`,
            "Reconcile overlaps and disagreements explicitly. Prefer concrete repository evidence over generic architectural assumptions. Do not claim a file was inspected unless a specialist report supplies evidence for it.",
            'Return final_report as strict JSON: {status:"completed",summary:string (1-1600 characters),answer:string,findings:[{claim:string,evidence:string[]}],files:string[],limitations:string[],specialistReports:string[]}. The summary is the single direct final reply to the human and must stand alone; the answer may retain the longer evidence-backed investigation body.',
          ].join(" "),
          needs: ["request", ...evidenceKeys],
          provides: ["final_report"],
        },
      ],
    };
  }
  if (!worker || (mode === "reviewed" && (supervisors.length < 1 || (!compactReviewed && !resolver)))) {
    throw new Error("Reviewed coding plans require one mutation peer, one review peer, and one temporary resolution peer");
  }
  const validationPlan = deriveCodingValidationPlan(coordination, nodes);
  const target = codingTargetContract(objective, validationPlan, mode, executionProfile);
  const executionProfileConstraint = codingExecutionProfileConstraint(executionProfile);
  if (mode === "fast") {
    return {
      id: "coding-agent",
      version: "3.0.0-fast",
      target,
      nodes,
      initialArtifacts: ["request"],
      maxParallel: 1,
      tasks: [{
        id: "implement",
        nodeId: worker.id,
        capability: "implement",
        objective: [
          `Implement this narrow low-risk change: ${objective}`,
          ...(executionProfileConstraint ? [executionProfileConstraint] : []),
          `Validation scope: ${validationPlan.scope} — ${validationPlan.rationale}`,
          "Run only targeted validation appropriate to the changed file.",
          `Return final_report as strict JSON: {status:"verified",summary:string (1-1600 characters),changedFiles:string[],validation:string[],validationScope:string,validationRationale:string,frontierHash:string}. ${CODING_MUTATION_FRONTIER_HASH_INSTRUCTION} ${CODING_AUTONOMOUS_IMPROVEMENT_INSTRUCTION} Set validationScope to \`${validationPlan.scope}\` and validationRationale to \`${validationPlan.rationale}\` exactly as given.`,
        ].join(" "),
        needs: ["request"],
        provides: ["final_report"],
      }, codingFinalAnswerBlueprint(worker, ["final_report"])],
    };
  }
  if (compactReviewed) {
    const reviewer = supervisors[0]!;
    const reviewerNodeKey = codingNodeTaskKey(reviewer);
    const proposalOutputKey = codingCollaborationProposalOutputKey(reviewerNodeKey);
    const responseOutputKey = codingCollaborationResponseOutputKey(codingNodeTaskKey(worker));
    const reviewOutputKey = `review_${reviewerNodeKey}_report`;
    const endorsementOutputKey = codingCollaborationEndorsementOutputKey(reviewerNodeKey);
    const reviewerSpecialty = safeTaskPart(specialtyOf(reviewer));
    return {
      id: "coding-agent",
      version: "3.0.0-compact-reviewed",
      target,
      nodes,
      initialArtifacts: ["request"],
      maxParallel: 1,
      tasks: [
        {
          id: `propose-${reviewerNodeKey}`,
          nodeId: reviewer.id,
          capability: "propose",
          objective: [
            `${reviewer.name}: inspect the request and directly relevant repository evidence from your ${reviewerSpecialty} specialty before files are changed.`,
            "Give the implementation peer a concise design direction, concrete constraints, and evidence. Do not edit files or run broad validation.",
            `Return ${proposalOutputKey} as strict JSON: {status:"proposal",summary:string,recommendations:[{subjectId:string,recommendation:string,rationale:string,evidence:string[],confidence:number}],questions:string[]}.`,
          ].join(" "),
          needs: ["request"],
          provides: [proposalOutputKey],
        },
        {
          id: `respond-${codingNodeTaskKey(worker)}`,
          nodeId: worker.id,
          capability: "respond",
          objective: [
            `${worker.name}: read ${reviewer.name}'s proposal and reply naturally before editing files.`,
            "React to the substance in your own words: agree, disagree, refine the approach, or ask one concrete question when evidence is missing. Do not perform implementation in this turn.",
            `Return ${responseOutputKey} as strict JSON: {status:"response",summary:string,answers:[{subjectId:string,response:string,rationale:string,evidence:string[],confidence:number}],openQuestions:[{subjectId:string,question:string,reason:string}]}.`,
          ].join(" "),
          needs: [proposalOutputKey],
          provides: [responseOutputKey],
        },
        {
          id: "implement",
          nodeId: worker.id,
          capability: "implement",
          objective: [
            `Implement this focused repository change completely: ${objective}`,
            ...(executionProfileConstraint ? [executionProfileConstraint] : []),
            "Inspect the repository before editing and keep the delta to files actually needed for the requested behavior.",
            "Run targeted validation for the touched surface; do not run the full repository toolchain gate.",
            `Return implementation_report as strict JSON with status="verified", summary, changedFiles, validation, validationScope, validationRationale, frontierHash, and any crossBoundarySignals discovered from the actual Git delta. ${CODING_MUTATION_FRONTIER_HASH_INSTRUCTION} ${CODING_AUTONOMOUS_IMPROVEMENT_INSTRUCTION}`,
          ].join(" "),
          needs: ["request", proposalOutputKey, responseOutputKey],
          provides: ["implementation_report"],
        },
        {
          id: `review-${reviewerNodeKey}`,
          nodeId: reviewer.id,
          capability: "review",
          objective: [
            `${reviewer.name}: independently review the actual Git task delta and implementation_report from your ${reviewerSpecialty} specialty.`,
            "Use the changed file paths and diff semantics as the scope authority. Treat any discovered API, data, runtime, security, or other cross-boundary effect as a blocking finding that requires an escalated rerun; do not silently assume the saved dependency graph is relevant.",
            `Do not edit files or run the full suite. Return ${reviewOutputKey} as strict JSON with verdict="approve" or "changes_requested", summary, findings, and targeted validation evidence.`,
          ].join(" "),
          needs: ["implementation_report", proposalOutputKey, responseOutputKey],
          provides: [reviewOutputKey],
        },
        {
          id: "remediate",
          nodeId: worker.id,
          capability: "remediate",
          objective: [
            `Reconcile every actionable finding in ${reviewOutputKey}; make no unrelated changes.`,
            ...(executionProfileConstraint ? [executionProfileConstraint] : []),
            `Run targeted checks and return final_report as strict JSON: {status:"verified",summary:string (1-1600 characters),changedFiles:string[],validation:string[],validationScope:"focused",validationRationale:"${validationPlan.rationale}",frontierHash:string}.`,
            CODING_MUTATION_FRONTIER_HASH_INSTRUCTION,
            CODING_AUTONOMOUS_IMPROVEMENT_INSTRUCTION,
          ].join(" "),
          needs: [reviewOutputKey],
          provides: ["final_report"],
        },
        {
          id: `certify-${reviewerNodeKey}`,
          nodeId: reviewer.id,
          capability: "certify",
          objective: [
            `Re-review only the remediated Git delta as the ${reviewerSpecialty} peer; do not edit files or run the full suite. Validation scope: focused — ${validationPlan.rationale}`,
            "Return changes_requested if the actual changed paths or diff semantics cross another specialist surface.",
            `Return ${endorsementOutputKey} as an object with verdict (approve or changes_requested), frontierHash, summary, and evidence as an array of concise strings.`,
            codingCertificationFrontierInstruction("final_report"),
          ].join(" "),
          needs: ["final_report"],
          provides: [endorsementOutputKey],
        },
        codingFinalAnswerBlueprint(worker, ["final_report", endorsementOutputKey]),
      ],
    };
  }
  const reviews = supervisors.map((supervisor) => {
    const specialty = safeTaskPart(specialtyOf(supervisor));
    const nodeKey = codingNodeTaskKey(supervisor);
    return {
      proposalTaskId: `propose-${nodeKey}`,
      proposalOutputKey: codingCollaborationProposalOutputKey(nodeKey),
      taskId: `review-${nodeKey}`,
      outputKey: `review_${nodeKey}_report`,
      supervisor,
      specialty,
      nodeKey,
    };
  });
  const workerSpecialty = safeTaskPart(specialtyOf(worker));
  const workerNodeKey = codingNodeTaskKey(worker);
  const workerProposal = {
    taskId: `propose-${workerNodeKey}`,
    outputKey: codingCollaborationProposalOutputKey(workerNodeKey),
  };
  const proposals = [
    {
      taskId: workerProposal.taskId,
      outputKey: workerProposal.outputKey,
      node: worker,
      specialty: workerSpecialty,
    },
    ...reviews.map((review) => ({
      taskId: review.proposalTaskId,
      outputKey: review.proposalOutputKey,
      node: review.supervisor,
      specialty: review.specialty,
    })),
  ];
  // A downstream reviewer consumes its upstream review reports, so only the
  // terminal nodes of the selected dependency DAG need to re-read and endorse
  // the final frontier. Independent review branches remain separate terminal
  // nodes and still certify independently.
  const terminalReviews = reviews.filter((review) => !reviews.some((candidate) =>
    candidate.supervisor.id !== review.supervisor.id
    && codingWorkspaceNodeDependencyIds(candidate.supervisor).includes(review.supervisor.id)));
  if (terminalReviews.length === 0) {
    throw new Error("The selected review dependency graph has no terminal certification node");
  }
  const certifications = terminalReviews.map((review) => ({
    taskId: `certify-${review.nodeKey}`,
    outputKey: codingCollaborationEndorsementOutputKey(review.nodeKey),
    review,
  }));
  const routedResponses = proposals.flatMap((target) => {
    const inboundPeers = proposals.filter((author) =>
      codingWorkspaceNodeDependencyIds(author.node).includes(target.node.id));
    return inboundPeers.length ? [{
      taskId: `respond-${codingNodeTaskKey(target.node)}`,
      outputKey: codingCollaborationResponseOutputKey(codingNodeTaskKey(target.node)),
      node: target.node,
      specialty: target.specialty,
      inboundPeers,
    }] : [];
  });
  const responses = routedResponses.length > 0
    ? routedResponses
    : [{
        taskId: `respond-${workerNodeKey}`,
        outputKey: codingCollaborationResponseOutputKey(workerNodeKey),
        node: worker,
        specialty: workerSpecialty,
        inboundPeers: proposals.filter((proposal) => proposal.node.id !== worker.id).slice(0, 3),
      }];
  const responseByNodeId = new Map(responses.map((response) => [
    response.node.id,
    response,
  ]));
  const reviewByNodeId = new Map(reviews.map((review) => [review.supervisor.id, review]));
  return {
    id: "coding-agent",
    version: "3.0.0-reviewed",
    target,
    nodes,
    initialArtifacts: ["request"],
    maxParallel,
    tasks: [
      ...proposals.map((proposal) => ({
        id: proposal.taskId,
        nodeId: proposal.node.id,
        capability: "propose",
        objective: [
          `${proposal.node.name}: independently inspect the objective and repository evidence from your ${proposal.specialty} specialty before any files are changed.`,
          "Act as a peer, not an approver. Identify concrete decisions, alternatives, evidence, and genuine ambiguity.",
          `Return ${proposal.outputKey} as strict JSON: {status:\"proposal\",summary:string,recommendations:[{subjectId:string,recommendation:string,rationale:string,evidence:string[],confidence:number}],questions:string[]}.`,
          "Use stable semantic subjectId values shared across specialties, such as implementation-approach, public-contract, data-model, validation, or delivery.",
          "Do not edit files during this proposal task, even if this node owns the later mutation task.",
          "Keep this a bounded planning pass: start from the supplied specialization metadata and focusPaths, inspect at most eight directly relevant repository files, do not run builds or broad test suites, and return as soon as the evidence supports a proposal.",
        ].join(" "),
        needs: ["request"],
        provides: [proposal.outputKey],
      })),
      ...responses.map((response) => ({
        id: response.taskId,
        nodeId: response.node.id,
        capability: "respond",
        objective: [
          `${response.node.name}: join the bounded peer discussion after every independent proposal is visible. Respond only from your ${response.specialty} specialization; do not edit files.`,
          `The saved dependency graph routes questions from ${response.inboundPeers.map((peer) => peer.node.name).join(", ")} to you; you may also answer another explicit proposal question that your evidence resolves.`,
          "Address concrete disagreements and questions using exact proposal subjectId values. If evidence remains insufficient, preserve an open question; never invent an agent or repository path.",
          `Return ${response.outputKey} as strict JSON: {status:"response",summary:string,answers:[{subjectId:string,response:string,rationale:string,evidence:string[],confidence:number}],openQuestions:[{subjectId:string,question:string,reason:string}]}.`,
          "This is one bounded collaboration round. Inspect at most three additional directly relevant repository files and do not run builds or broad test suites.",
        ].join(" "),
        needs: [
          ...proposals.map((proposal) => proposal.outputKey),
          ...codingWorkspaceNodeDependencyIds(response.node).flatMap((nodeId) => {
            const upstream = responseByNodeId.get(nodeId);
            return upstream ? [upstream.outputKey] : [];
          }),
        ],
        provides: [response.outputKey],
      })),
      {
        id: "resolve-collaboration",
        nodeId: resolver!.id,
        capability: "resolve",
        objective: [
          "Temporarily facilitate only this objective's peer resolution. You are a run-scoped graph binding, not a permanent lead, and must not edit files.",
          "Compare every peer proposal and response by semantic subject. Preserve agreement, resolve incompatible positions from repository evidence, and leave genuinely unsupported choices explicit for the human participant rather than guessing.",
          `Return ${CODING_COLLABORATION_RESOLUTION_OUTPUT} as strict JSON: {status:\"aligned\"|\"resolved\"|\"ambiguous\",summary:string,decisions:[{subjectId:string,resolution:string,rationale:string,evidence:string[]}],unresolved:[{subjectId:string,reason:string,candidateSummaries:string[]}]}.`,
          "Enumerate every unique subjectId from every supplied proposal and copy each id exactly. Emit exactly one decisions or unresolved entry for every subjectId; never omit, rename, or duplicate a subject. Even an aligned subject requires one decisions entry so coverage is machine-checkable.",
          "Use ambiguous only when repository evidence cannot safely decide. This is an automatic conflict-scoped escalation, not a request for human approval.",
          "Prefer the supplied proposal evidence; inspect at most four additional repository files only when required to decide a conflict.",
        ].join(" "),
        needs: [
          ...proposals.map((proposal) => proposal.outputKey),
          ...responses.map((response) => response.outputKey),
        ],
        provides: [CODING_COLLABORATION_RESOLUTION_OUTPUT],
      },
      {
        id: "implement",
        nodeId: worker.id,
        capability: "implement",
        objective: [
          `Implement the requested repository change completely: ${objective}`,
          ...(executionProfileConstraint ? [executionProfileConstraint] : []),
          `Consume ${CODING_COLLABORATION_RESOLUTION_OUTPUT} as the certified peer decision context before editing.`,
          "If its status is ambiguous, do not edit files; return implementation_report with status=blocked and the unresolved subjects.",
          `Otherwise implement the resolved decisions, record any evidence that invalidates them, and return implementation_report as strict JSON with status="verified", summary, changedFiles, validation, validationScope, validationRationale, and frontierHash. ${CODING_MUTATION_FRONTIER_HASH_INSTRUCTION} ${CODING_AUTONOMOUS_IMPROVEMENT_INSTRUCTION}`,
          `Validation scope: ${validationPlan.scope} — ${validationPlan.rationale} Keep this task's own checks focused on the changed surface; do not run the full repository toolchain gate here.`,
        ].join(" "),
        needs: ["request", CODING_COLLABORATION_RESOLUTION_OUTPUT],
        provides: ["implementation_report"],
      },
      ...reviews.map((review) => {
        const upstreamReports = codingWorkspaceNodeDependencyIds(review.supervisor)
          .map((nodeId) => reviewByNodeId.get(nodeId)?.outputKey)
          .filter((outputKey): outputKey is string => Boolean(outputKey));
        return {
          id: review.taskId,
          nodeId: review.supervisor.id,
          capability: "review",
          objective: `${review.supervisor.name}: independently review only the task delta from the synthetic Git baseline and the implementation report as a peer.${upstreamReports.length ? ` Consume the upstream specialist reports ${upstreamReports.join(", ")} before publishing your own findings.` : ""} Do not edit files. Treat unrelated baseline failures as non-blocking evidence, not regressions. Keep validation focused on the task delta; do not run the full repository toolchain gate in this review. Return ${review.outputKey} as strict JSON with verdict="approve" or "changes_requested", summary, findings, and targeted validation evidence.`,
          needs: ["implementation_report", ...upstreamReports],
          provides: [review.outputKey],
        };
      }),
      {
        id: "remediate",
        nodeId: worker.id,
        capability: "remediate",
        objective: [
          `Validation scope: ${validationPlan.scope} — ${validationPlan.rationale}`,
          ...(executionProfileConstraint ? [executionProfileConstraint] : []),
          `Reconcile every actionable peer finding in the isolated run checkout, run targeted validation plus checks relevant to the task delta, and return final_report as strict JSON: {status:"verified",summary:string (1-1600 characters),validation:string[],validationScope:string,validationRationale:string,frontierHash:string}. ${CODING_MUTATION_FRONTIER_HASH_INSTRUCTION} ${CODING_AUTONOMOUS_IMPROVEMENT_INSTRUCTION}`,
          `Set validationScope to \`${validationPlan.scope}\` and validationRationale to \`${validationPlan.rationale}\` exactly as given.`,
          validationPlan.crossBoundary
            ? `Do not run the full repository toolchain gate yourself here; a separate validate-repository task rebinds this logical mutation node to Roster's bounded host command runtime, runs the checked-in gate once in the same isolated checkout, and every terminal certification depends on that shared ${REPOSITORY_VALIDATION_REPORT}.`
            : "Do not modify unrelated baseline work or block on clearly unrelated pre-existing failures.",
        ].join(" "),
        needs: reviews.map((review) => review.outputKey),
        provides: ["final_report"],
      },
      ...(validationPlan.crossBoundary ? [{
        id: "validate-repository",
        nodeId: worker.id,
        capability: "validate",
        objective: [
          `Validation scope: repository-wide — ${validationPlan.rationale}`,
          "You are the single authoritative pre-certification validation task for this run, on the same logical mutation node and isolated checkout after remediation. Roster rebinds this task to a bounded non-model host command runtime that runs the allowlisted lockfile-backed repository toolchain exactly once. Do not edit files here and do not repeat remediation.",
          `Return ${REPOSITORY_VALIDATION_REPORT} as strict JSON: {status:"passed"|"failed",command:"npm run verify"|"roster repository toolchain",checks?:string[],summary:string,evidence:string,frontierHash:string}, matching final_report's frontierHash. The trusted host worker owns staging and frontier hashing for this task.`,
          "Every terminal certification task depends on this exact report and validates its passing evidence instead of rerunning the suite itself.",
        ].join(" "),
        needs: ["final_report"],
        provides: [REPOSITORY_VALIDATION_REPORT],
      }] : []),
      ...certifications.map((certification) => {
        const validationClause = validationPlan.crossBoundary
          ? ` Consume ${REPOSITORY_VALIDATION_REPORT} as the single authoritative repository-wide toolchain evidence for this run; do not rerun it yourself. Require its status to be passed and its frontierHash to match this frontier before endorsing; if it is failed, missing, or reports a different frontierHash, return changes_requested citing that evidence. Every other independent terminal certification shares this exact same report; none of you owns it exclusively.`
          : ` Validation scope: focused — ${validationPlan.rationale} Keep this endorsement's own checks scoped to the task delta; do not run the full repository toolchain gate here.`;
        return {
          id: certification.taskId,
          nodeId: certification.review.supervisor.id,
          capability: "certify",
          objective: `Re-review only the remediated task delta from the synthetic Git baseline as the ${certification.review.specialty} peer. Do not edit files. Return ${certification.outputKey} as an object with verdict (approve or changes_requested), frontierHash, summary, and evidence as an array of concise strings. ${codingCertificationFrontierInstruction(validationPlan.crossBoundary ? REPOSITORY_VALIDATION_REPORT : "final_report")} Approve when no blocking regression in the task delta remains; record unrelated baseline failures without blocking.${validationClause}`,
          needs: validationPlan.crossBoundary ? ["final_report", REPOSITORY_VALIDATION_REPORT] : ["final_report"],
          provides: [certification.outputKey],
        };
      }),
      codingFinalAnswerBlueprint(worker, [
        "final_report",
        ...(validationPlan.crossBoundary ? [REPOSITORY_VALIDATION_REPORT] : []),
        ...certifications.map((certification) => certification.outputKey),
      ]),
    ],
  };
};

const validatedHumanResolution = (
  resolution: CodingPeerResolution | undefined,
): CodingPeerResolution | undefined => {
  if (!resolution) return undefined;
  const parsed = parseCodingPeerResolution(JSON.stringify(resolution));
  if (!parsed || parsed.status === "ambiguous" || parsed.unresolved.length > 0) {
    throw new Error("A coding human resolution must be a complete non-ambiguous decision frontier");
  }
  return parsed;
};

const codingHumanContinuationNodes = (
  nodes: ReadonlyArray<WorkspaceNode>,
): ReadonlyArray<WorkspaceNode> => nodes.filter((node) =>
  node.metadata?.collaborationRole !== "temporary-resolver");

const codingHumanContinuationPlan = (
  plan: CodingTaskBlueprintGraph,
  nodes: ReadonlyArray<WorkspaceNode>,
): CodingTaskBlueprintGraph => ({
  ...plan,
  version: "3.0.0-reviewed-human-continuation",
  nodes: codingHumanContinuationNodes(nodes),
  initialArtifacts: ["request", CODING_COLLABORATION_RESOLUTION_OUTPUT],
  tasks: plan.tasks
    .filter((task) => !["propose", "respond", "resolve"].includes(task.capability))
    .map((task) => {
      const retainedNeeds = (task.needs ?? []).filter((outputKey) =>
        !outputKey.startsWith("collaboration_proposal_")
        && !outputKey.startsWith("collaboration_response_"));
      return task.capability === "implement" ? {
        ...task,
        objective: `${task.objective ?? "Implement the requested change."} Apply the supplied human resolution as binding context for this continuation.`,
        needs: [...new Set([...retainedNeeds, CODING_COLLABORATION_RESOLUTION_OUTPUT])],
      } : {
        ...task,
        needs: retainedNeeds,
      };
    }),
});

const previewPopulation = (
  options: CodingAgentPlatformOptions,
  runId: string,
): ReadonlyArray<WorkspaceNode> => {
  const coordination = requireCodingCoordination(options.coordination);
  const demands = deriveCodingNodeDemands(options);
  const mode = options.executionKind === "investigation"
    ? "fast"
    : codingReviewMode(coordination, options.reviewPolicy);
  const reflection = reflectOnOrchestration({
    runId,
    policyId: "coding-demand",
    policyVersion: "coding-agent-v2",
    iteration: 1,
    observation: {
      activeNodes: 1,
      pendingTasks: demands.length,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 0,
      evidenceGaps: demands.length,
      stagnationRounds: 0,
      goalSatisfied: false,
    },
    maxNodes: normalizeBound(options.maxNodes, 8, 4, 8) - (mode === "reviewed" ? 1 : 0),
    unmetDemands: demands,
  });
  return reflection.actions
    .filter((action) => action.type === "spawn")
    .map((action, index) => materializeCodingNode({
      runId,
      reflectionId: reflection.reflectionId,
      index,
      demand: action.demand as CodingNodeDemand,
      options,
      profileNode: workspaceProfileForDemand(options.workspaceNodes, action.demand as CodingNodeDemand),
    }));
};

const CODING_CAPABILITIES = [
  { id: "coordinate", description: "Expand and certify the bounded Coding task graph." },
  { id: "propose", description: "Publish an independent evidence-backed position before mutation begins." },
  { id: "respond", description: "Answer peer questions through the saved dependency topology." },
  { id: "resolve", description: "Reconcile explicit conflicts for one objective without editing." },
  { id: "implement", description: "Inspect, edit, and validate repository changes." },
  { id: "investigate", description: "Inspect the repository deeply and publish evidence without editing." },
  { id: "onboard", description: "Derive a bounded repository execution profile from tracked build evidence." },
  { id: "review", description: "Independently review one peer risk dimension without editing." },
  { id: "remediate", description: "Integrate peer findings and run final validation." },
  { id: "synthesize", description: "Write one bounded human answer from the certified current frontier." },
  { id: "validate", description: "Run the authoritative repository toolchain gate after remediation." },
  { id: "certify", description: "Endorse or reject the exact remediated Git frontier." },
  { id: "memory", description: "Search and propose provenance-bearing workspace memory." },
  { id: "workspace", description: "Discover and compose repository and data-transformation workers." },
  { id: "room", description: "Post bounded model-authored updates to the active Coding room." },
] as const;

const CODING_MODEL_CAPABILITIES = new Set<string>([
  "propose",
  "respond",
  "resolve",
  "implement",
  "investigate",
  "review",
  "remediate",
  "synthesize",
  "certify",
]);
const CODING_ANNOUNCED_CAPABILITIES = new Set<string>([
  "propose",
  "respond",
  "resolve",
  "implement",
  "investigate",
  "review",
]);
const CODING_ROOM_UPDATE_MAX_CALLS = 3;
const CODING_ROOM_ANNOUNCEMENT_MAX_CHARS = 420;

function codingRoomInstructions(input: {
  upstreamNodeIds: readonly string[];
  downstreamNodeIds: readonly string[];
  finalAudience: "human" | "nodes";
  narrativeField: "answer" | "summary";
}): string {
  const upstreamNodeIds = [...new Set(input.upstreamNodeIds)].sort();
  const downstreamNodeIds = [...new Set(input.downstreamNodeIds)].sort();
  return [
    `You may use ${CODING_ROOM_POST_UPDATE_FUNCTION_ID} for at most three optional, meaningful progress updates or questions during this task; a room function call is never required for completion.`,
    "Do not call a room function solely to announce that work started; Roster publishes the accepted model-authored announcement task before this work begins.",
    "Use progress only for a meaningful change in understanding; use question only when an answer can change the work.",
    "Do not include raw commands, logs, hidden reasoning, tool transcripts, JSON, or fabricated results in room text.",
    `Use the existing \`${input.narrativeField}\` field as the natural model-authored handoff after this task is complete.`,
    input.finalAudience === "human"
      ? "Write that field as one direct, natural first-person reply to the human that must acknowledge the useful evidence you received when upstream node IDs are listed, and show it verbatim in the shared room exactly once."
      : downstreamNodeIds.length > 0
        ? "Write that field as one direct, natural first-person conversational reply to the listed downstream participants, shown verbatim in the shared room."
        : "Write that field as a direct, natural first-person message to the same node's next task, shown verbatim in the shared room; this continues the assigned downstream work internally and is not the final answer to the human.",
    `Upstream node IDs: ${upstreamNodeIds.length ? upstreamNodeIds.join(", ") : "none"}`,
    `Downstream node IDs: ${downstreamNodeIds.length ? downstreamNodeIds.join(", ") : "none"}`,
  ].join(" ");
}

const codingAnnouncementTask = (
  task: CodingTaskBlueprint,
  recipients: ReturnType<typeof codingRoomUpdateRecipientPolicy>,
): CodingTaskBlueprint => {
  const outputKey = `room_announcement_${hashCanonical({
    taskId: task.id,
    nodeId: task.nodeId,
  }).slice(0, 20)}`;
  const boundedSubject = task.objective.length <= 600
    ? task.objective
    : `${task.objective.slice(0, 597)}...`;
  return {
    id: `announce-${task.id}`,
    nodeId: task.nodeId,
    capability: "room",
    objective: [
      `Write one concise, natural first-person room message immediately before starting this bounded task: ${boundedSubject}`,
      recipients.upstreamNodeIds.length > 0
        ? `Address the human and acknowledge the useful handoff from these upstream node IDs: ${recipients.upstreamNodeIds.join(", ")}.`
        : "Address the human and say what bounded contribution you are starting.",
      "Do not claim work, evidence, or results that are not complete. Do not include commands, logs, hidden reasoning, tool transcripts, or markdown fences.",
      `Return ${outputKey} as strict JSON: {summary:string (1-${CODING_ROOM_ANNOUNCEMENT_MAX_CHARS} characters)}.`,
    ].join(" "),
    needs: task.needs,
    provides: [outputKey],
    context: codingTaskContextPolicy("room"),
  };
};

const CODING_COORDINATOR: WorkspaceNode = {
  id: "coordinator",
  name: "Roster",
  capabilities: ["coordinate"],
  runtime: { kind: "roster-native", profile: "coding.coordinator" },
  metadata: {
    role: "coordinator",
    givenName: "Roster",
    displayRole: "System Facilitator",
    participantKind: "system",
    collaborationRole: "mechanical-facilitator",
    authority: "none",
    group: "Repository peers",
  },
};

const codingTaskTopologicalOrder = (
  tasks: ReadonlyArray<Pick<CodingTaskBlueprint, "id" | "needs" | "provides">>,
  initialArtifacts: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const producer = new Map<string, string>();
  for (const artifact of initialArtifacts) producer.set(artifact, "input");
  for (const task of tasks) {
    for (const output of task.provides) {
      if (producer.has(output)) throw new Error(`Coding graph repeats output ${output}`);
      producer.set(output, task.id);
    }
  }
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((task) => task.needs.every((need) => {
        const source = producer.get(need);
        if (!source) throw new Error(`Coding task ${task.id} requires unknown output ${need}`);
        return source === "input" || completed.has(source);
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error("Coding task graph contains a dependency cycle");
    for (const task of ready) {
      remaining.delete(task.id);
      completed.add(task.id);
      order.push(task.id);
    }
  }
  return order;
};

const codingAgentBlueprint = (
  options: CodingAgentPlatformOptions,
  input: Required<Pick<CodingAgentInput, "objective" | "runId">>,
): CodingAgentGraphPreview => {
  const objective = input.objective.trim();
  if (!objective) throw new Error("Coding agent objective must not be blank");
  const humanResolution = validatedHumanResolution(options.humanResolution);
  const coordination = requireCodingCoordination(options.coordination);
  const executionKind = options.executionKind ?? "mutation";
  const mode = executionKind === "investigation"
    ? "fast"
    : humanResolution ? "reviewed" : codingReviewMode(coordination, options.reviewPolicy);
  const candidateNodes = codingPlanNodes(
    previewPopulation(options, input.runId),
    coordination,
    mode,
    input.runId,
  );
  const base = codingPlan(
    objective,
    candidateNodes,
    normalizeBound(options.maxParallel, 4, 1, 6),
    coordination,
    mode,
    executionKind,
    options.repositoryExecutionProfile,
  );
  const plan = humanResolution
    ? codingHumanContinuationPlan(base, codingHumanContinuationNodes(candidateNodes))
    : base;
  const substantiveTasks = plan.tasks.map((task): CodingTaskBlueprint => {
    const recipients = codingRoomUpdateRecipientPolicy(
      plan.tasks,
      task.id,
      "human.operator",
      task.nodeId,
    );
    const terminal = !plan.tasks.some((candidate) =>
      candidate.needs.some((need) => task.provides.includes(need)));
    const narrativeField = "summary" as const;
    return {
      ...task,
      objective: CODING_MODEL_CAPABILITIES.has(task.capability)
        ? `${task.objective} ${codingRoomInstructions({
            upstreamNodeIds: recipients.upstreamNodeIds,
            downstreamNodeIds: recipients.downstreamNodeIds,
            finalAudience: terminal ? "human" : "nodes",
            narrativeField,
          })}`
        : task.objective,
      context: codingTaskContextPolicy(task.capability),
    };
  });
  const tasks = substantiveTasks.flatMap((task): ReadonlyArray<CodingTaskBlueprint> => {
    if (!CODING_ANNOUNCED_CAPABILITIES.has(task.capability)) return [task];
    const sourceTask = plan.tasks.find((candidate) => candidate.id === task.id);
    if (!sourceTask) throw new Error(`Coding announcement has no source task ${task.id}`);
    const recipients = codingRoomUpdateRecipientPolicy(
      plan.tasks,
      task.id,
      "human.operator",
      task.nodeId,
    );
    const announcement = codingAnnouncementTask({
      ...task,
      objective: sourceTask.objective,
    }, recipients);
    return [
      announcement,
      {
        ...task,
        needs: [...new Set([...task.needs, ...announcement.provides])],
      },
    ];
  });
  return {
    id: "coding-agent",
    version: plan.version,
    target: plan.target,
    nodes: [
      applyWorkspaceParticipantProfile(
        CODING_COORDINATOR,
        options.participantProfiles?.find((profile) => profile.nodeId === CODING_COORDINATOR.id),
        new Set(CODING_CAPABILITIES.map((capability) => capability.id)),
      ),
      ...plan.nodes,
    ],
    maxParallel: plan.maxParallel,
    tasks,
    topologicalOrder: codingTaskTopologicalOrder(tasks, plan.initialArtifacts),
  };
};

/** Read-only graph preview for interfaces that explain the next bounded execution. */
export const previewCodingAgentGraph = (
  options: CodingAgentPlatformOptions & Required<Pick<CodingAgentInput, "objective" | "runId">>,
): CodingAgentGraphPreview => {
  const projected = applyCodingImprovements({
    objective: options.objective,
    snapshot: options.activeImprovementSnapshot,
    maxNodes: options.maxNodes,
    maxParallel: options.maxParallel,
    maxSupervisors: options.maxSupervisors,
    reviewPolicy: options.reviewPolicy,
  });
  return codingAgentBlueprint({ ...options, ...projected }, {
    objective: projected.objective,
    runId: options.runId,
  });
};

/**
 * Defines the run-specific logical population on the node-only platform. The
 * coordinator publishes executable tasks through one fenced graph expansion.
 */
export const defineCodingAgentPlatform = (
  options: CodingAgentPlatformOptions,
  input: Required<Pick<CodingAgentInput, "objective" | "runId">>,
): RosterPlatform => {
  const blueprint = codingAgentBlueprint(options, input);
  const topologyVersion = `coding_topology_${hashCanonical(
    blueprint.nodes.map((node) => node.id).sort(),
  ).slice(0, 28)}`;
  const memoryFunctions = createRosterMemoryFunctionDescriptors({
    readScope: "memory:read",
    proposeScope: "memory:propose",
  });
  const codingFunctions = createCodingWorkerFunctionDescriptors({
    ...(options.dependencyResolution ? {
      dependencyResolution: options.dependencyResolution,
    } : {}),
  });
  return defineRosterPlatform({
    id: "coding-agent",
    version: "3.2.0",
    policyVersion: "coding-agent-dynamic-v5",
    coordinatorId: CODING_COORDINATOR.id,
    capabilities: CODING_CAPABILITIES,
    nodes: blueprint.nodes,
    maxNodes: blueprint.nodes.length,
    policy: {
      maxTasks: 48,
      maxDepth: 4,
      maxFanout: 48,
      maxInflight: blueprint.maxParallel,
      maxReady: 30,
      maxBlocked: 48,
      maxAttempts: 2,
      maxContextBytes: 64 * 1_048_576,
      maxCostMicros: 50_000_000,
      maxTokens: 2_000_000,
      maxWallTimeMs: normalizeBound(
        options.maxWallTimeMs,
        DEFAULT_CODING_RUN_WALL_TIME_MS,
        MIN_CODING_RUN_WALL_TIME_MS,
        MAX_CODING_RUN_WALL_TIME_MS,
      ),
    },
    functions: [...memoryFunctions, ...codingFunctions],
    pipelineLimits: {
      maxSteps: 16,
      maxValueBytes: 8 * 1_048_576,
      maxTotalBytes: 32 * 1_048_576,
      maxReferenceBytes: 16_384,
      maxWallTimeMs: 60_000,
      maxStepTimeMs: 30_000,
      maxPreviewBytes: 16_384,
    },
    consultation: {
      maxRecipients: 3,
      canConsult: ({ author, recipient, parent, capability }) =>
        parent.capability !== "validate"
        && author.id !== CODING_COORDINATOR.id
        && recipient.id !== CODING_COORDINATOR.id
        && author.metadata?.participantKind !== "human"
        && recipient.metadata?.participantKind !== "human"
            && capability === "respond",
    },
    workspaceOperations: (_node, definition) => definition.capability === "room"
      ? []
      : definition.capability === "validate"
        ? ["read"]
        : ["read", "publish"],
    access: (node, definition) => {
      if (definition.capability === "validate") {
        return { functionGrants: [], allowedEffects: [] };
      }
      if (definition.capability === "room") {
        return { functionGrants: [], scopes: [], allowedEffects: [] };
      }
      if (node.id === CODING_COORDINATOR.id) {
        return {
          functionGrants: ["roster::expand"],
          scopes: ["roster:graph:expand"],
          allowedEffects: options.executionKind === "investigation"
            ? ["read"]
            : ["read", "write", "external"],
        };
      }
      const investigation = options.executionKind === "investigation";
      const roomUpdatesAllowed = CODING_MODEL_CAPABILITIES.has(definition.capability);
      const functionGrants = [
        ...(investigation ? [] : [ROSTER_CONSULT_FUNCTION_ID]),
        ...[...memoryFunctions, ...codingFunctions]
          .filter((descriptor) =>
            (
              descriptor.id !== CODING_REPOSITORY_DEPENDENCIES_RESOLVE_FUNCTION_ID
              || definition.capability === "implement"
              || definition.capability === "remediate"
            )
            && (
              descriptor.id !== CODING_CHANGE_FRONTIER_FUNCTION_ID
              || codingCapabilityUsesChangeFrontier(definition.capability)
            )
            && (
              descriptor.id !== CODING_ROOM_POST_UPDATE_FUNCTION_ID
              || roomUpdatesAllowed
            )
            && (
              !investigation
              || descriptor.id === CODING_ROOM_POST_UPDATE_FUNCTION_ID
              || !descriptor.effects.includes("write")
            ))
          .map((descriptor) => descriptor.id),
      ];
      return {
        functionGrants,
        scopes: investigation
          ? ["memory:read", ...(roomUpdatesAllowed ? [CODING_ROOM_UPDATE_SCOPE] : [])]
          : [
              "roster:node:consult",
              "memory:read",
              "memory:propose",
              ...(roomUpdatesAllowed ? [CODING_ROOM_UPDATE_SCOPE] : []),
            ],
        allowedEffects: investigation
          ? ["read", "write"]
          : ["read", "write", "external"],
      };
    },
    resolveRuntimeBinding: (node, definition) => {
      if (definition.capability !== "validate") return undefined;
      if (!options.workingDirectory) {
        throw new Error("Repository validation requires an isolated working directory");
      }
      return createWorkspaceNodeRuntimeBinding({
        nodeId: node.id,
        runtime: codingRepositoryValidationRuntime(
          options.workingDirectory,
          options.repositoryExecutionProfile,
        ),
        epoch: 2,
        topologyVersion,
      });
    },
  });
};

type Certification = {
  readonly verdict: "approve" | "changes_requested";
  readonly frontierHash: string;
};

const certification = (value: string | undefined): Certification | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { readonly verdict?: unknown; readonly frontierHash?: unknown };
    if ((parsed.verdict !== "approve" && parsed.verdict !== "changes_requested")
      || typeof parsed.frontierHash !== "string" || !parsed.frontierHash.trim()) return undefined;
    return { verdict: parsed.verdict, frontierHash: parsed.frontierHash.trim() };
  } catch {
    return undefined;
  }
};

export type RepositoryValidationReport = {
  readonly status: "passed" | "failed";
  readonly command: "npm run verify" | "roster repository toolchain";
  readonly checks?: ReadonlyArray<string>;
  readonly summary?: string;
  readonly evidence: string;
  readonly frontierHash: string;
};

export const parseRepositoryValidationReport = (
  value: string | undefined,
): RepositoryValidationReport | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as {
      readonly status?: unknown;
      readonly command?: unknown;
      readonly checks?: unknown;
      readonly summary?: unknown;
      readonly evidence?: unknown;
      readonly frontierHash?: unknown;
    };
    if ((parsed.status !== "passed" && parsed.status !== "failed")
      || (parsed.command !== "npm run verify" && parsed.command !== "roster repository toolchain")
      || (parsed.command === "roster repository toolchain" && (
        !Array.isArray(parsed.checks)
        || parsed.checks.length === 0
        || parsed.checks.length > 12
        || !parsed.checks.every((check) => typeof check === "string" && check.trim().length > 0 && check.length <= 240)
      ))
      || (parsed.summary !== undefined && (
        typeof parsed.summary !== "string"
        || !parsed.summary.trim()
        || parsed.summary.length > 1_000
      ))
      || typeof parsed.evidence !== "string" || !parsed.evidence.trim()
      || typeof parsed.frontierHash !== "string" || !parsed.frontierHash.trim()) return undefined;
    return {
      status: parsed.status,
      command: parsed.command,
      ...(Array.isArray(parsed.checks) ? { checks: parsed.checks as string[] } : {}),
      ...(typeof parsed.summary === "string" ? { summary: parsed.summary.trim() } : {}),
      evidence: parsed.evidence.trim(),
      frontierHash: parsed.frontierHash.trim(),
    };
  } catch {
    return undefined;
  }
};

/**
 * `validationReportKey`, when supplied, names the single shared
 * repository-wide toolchain artifact every terminal certification
 * depends on; no certifier reruns the suite, they only validate this report's
 * passing evidence and matching frontier.
 */
export const evaluateCodingConsensus = (
  outputs: Readonly<Record<string, string>>,
  certificationKeys: ReadonlyArray<string>,
  validationReportKey?: string,
  requireResolution = true,
): { readonly done: boolean; readonly blocked?: string } => {
  if (requireResolution) {
    const resolution = parseCodingPeerResolution(outputs[CODING_COLLABORATION_RESOLUTION_OUTPUT] ?? "");
    if (!resolution) return { done: false, blocked: "Peer collaboration resolution is missing or invalid" };
    if (resolution.status === "ambiguous" || resolution.unresolved.length > 0) {
      return { done: false, blocked: "Peer collaboration has unresolved semantic conflicts" };
    }
  }
  const validationReport = validationReportKey
    ? parseRepositoryValidationReport(outputs[validationReportKey])
    : undefined;
  if (validationReportKey && !validationReport) {
    return { done: false, blocked: "Repository-wide validation report is missing or invalid" };
  }
  if (validationReport && validationReport.status !== "passed") {
    const detail = [
      validationReport.summary,
      validationReport.checks?.length ? `checks=${validationReport.checks.join(", ")}` : undefined,
      validationReport.evidence,
    ].filter((value): value is string => Boolean(value)).join("; ");
    return {
      done: false,
      blocked: `Repository-wide validation did not pass${detail ? `: ${detail}` : ""}`,
    };
  }
  const reports = certificationKeys.map((key) => certification(outputs[key]));
  const complete = reports.every((report) => report !== undefined);
  const frontiers = new Set([
    ...(validationReport ? [validationReport.frontierHash] : []),
    ...reports.flatMap((report) => report ? [report.frontierHash] : []),
  ]);
  const approved = complete && reports.every((report) => report?.verdict === "approve");
  return {
    done: approved && frontiers.size === 1,
    ...(!complete ? { blocked: "Peer endorsements are incomplete" }
      : !approved ? { blocked: "At least one peer requested changes" }
        : frontiers.size !== 1 ? { blocked: "Peers endorsed different Git diff frontiers" }
          : {}),
  };
};

export const evaluateCodingInvestigationCompletion = (
  outputs: Readonly<Record<string, string>>,
): { readonly done: boolean; readonly blocked?: string } => {
  const value = outputs.final_report;
  if (!value) return { done: false, blocked: "Investigation synthesis is incomplete" };
  try {
    const report = JSON.parse(value) as {
      readonly status?: unknown;
      readonly answer?: unknown;
      readonly findings?: unknown;
    };
    const complete = report.status === "completed"
      && typeof report.answer === "string"
      && report.answer.trim().length > 0
      && Array.isArray(report.findings);
    return complete
      ? { done: true }
      : { done: false, blocked: "Investigation synthesis lacks a completed evidence-backed answer" };
  } catch {
    return { done: false, blocked: "Investigation synthesis is invalid" };
  }
};

export const evaluateFastCodingCompletion = (
  outputs: Readonly<Record<string, string>>,
): { readonly done: boolean; readonly blocked?: string } => {
  const value = outputs.final_report;
  if (!value) return { done: false, blocked: "Fast-path final report is incomplete" };
  try {
    const report = JSON.parse(value) as { readonly status?: unknown; readonly frontierHash?: unknown };
    const verified = report.status === "verified" || report.status === "completed";
    const hasFrontier = typeof report.frontierHash === "string" && report.frontierHash.trim().length > 0;
    return verified && hasFrontier
      ? { done: true }
      : { done: false, blocked: "Fast-path validation or frontier evidence is incomplete" };
  } catch {
    return { done: false, blocked: "Fast-path final report is invalid" };
  }
};

const reportedFrontierHash = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { readonly frontierHash?: unknown };
    return typeof parsed.frontierHash === "string" ? parsed.frontierHash.trim() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Trusted commit-boundary check. Model-authored reports can agree with each
 * other and still be stale, so agreement is insufficient: every terminal
 * frontier claim must equal the hash recomputed from Roster's immutable index
 * tree immediately before its ref compare-and-swap.
 */
export const verifyCodingFrontierEvidence = (
  outputs: Readonly<Record<string, string>>,
  trustedFrontierHash: string,
): { readonly valid: boolean; readonly reason?: string } => {
  const validHash = trustedFrontierHash.length === 64
    && [...trustedFrontierHash].every((character) =>
      (character >= "a" && character <= "f")
      || (character >= "0" && character <= "9"));
  if (!validHash) {
    return { valid: false, reason: "Roster computed an invalid Git frontier hash" };
  }
  const claimed: Array<{ readonly key: string; readonly hash?: string }> = [
    { key: "final_report", hash: reportedFrontierHash(outputs.final_report) },
    ...Object.keys(outputs)
      .filter((key) => key === REPOSITORY_VALIDATION_REPORT || key.startsWith("collaboration_endorsement_"))
      .sort()
      .map((key) => ({ key, hash: reportedFrontierHash(outputs[key]) })),
  ];
  const missing = claimed.find((entry) => !entry.hash);
  if (missing) {
    return { valid: false, reason: `${missing.key} is missing valid Git frontier evidence` };
  }
  const mismatched = claimed.find((entry) => entry.hash !== trustedFrontierHash);
  if (mismatched) {
    return {
      valid: false,
      reason: `${mismatched.key} does not certify Roster's exact Git frontier`,
    };
  }
  return { valid: true };
};

export type CodingAgentGitFailureResult = {
  readonly ok: false;
  readonly error: string;
  readonly noRetry: true;
  readonly result: {
    readonly runId: string;
    readonly runStream: string;
    readonly status: string;
  };
};

export type CodingAgentGitPreparation =
  | { readonly status: "failed"; readonly result: CodingAgentGitFailureResult }
  | { readonly status: "prepared"; readonly prepared: GitRunPreparedCommit };

export type CodingAgentExecutionResult = {
  readonly runId: string;
  readonly platformId: string;
  readonly platformVersion: string;
  readonly status: "completed" | "blocked" | "failed";
  readonly completion: { readonly done: boolean; readonly blocked?: string };
  readonly outputs: Readonly<Record<string, string>>;
  readonly snapshot: TaskGraphControlSnapshot;
};

/**
 * Performs the Git-result decision from accepted graph outcomes. The commit
 * boundary never trusts model agreement without recomputing the exact patch.
 */
export const prepareCodingAgentGitRun = async (input: {
  readonly workspace: GitRunWorkspace;
  readonly execution: CodingAgentExecutionResult;
  readonly runId: string;
  readonly runStream: string;
}): Promise<CodingAgentGitPreparation> => {
  if (input.execution.status !== "completed") {
    await captureGitRunPatch(input.workspace);
    return {
      status: "failed",
      result: {
        ok: false,
        error: input.execution.completion.blocked ?? "coding graph did not complete",
        noRetry: true,
        result: {
          runId: input.runId,
          runStream: input.runStream,
          status: input.execution.status,
        },
      },
    };
  }

  const prepared = await prepareGitRunCommit(input.workspace);
  const frontierEvidence = verifyCodingFrontierEvidence(
    input.execution.outputs,
    prepared.patchHash,
  );
  if (!frontierEvidence.valid) {
    await captureGitRunPatch(input.workspace);
    return {
      status: "failed",
      result: {
        ok: false,
        error: frontierEvidence.reason ?? "Coding Git frontier certification failed",
        noRetry: true,
        result: { runId: input.runId, runStream: input.runStream, status: "failed" },
      },
    };
  }
  return { status: "prepared", prepared };
};

export type RunCodingAgentOptions = CodingAgentPlatformOptions & CodingAgentInput & {
  readonly runId: string;
  readonly signal?: AbortSignal;
  /** Durable control authority. Its durability must match dataReferences. */
  readonly taskGraph: TaskGraphControl;
  /** Immutable value plane used for task inputs and accepted outputs. */
  readonly dataReferences: DataReferenceStore;
  /** Required durable/rehydrated task-fenced shared-workspace plane. */
  readonly createTaskContext: RosterPlatformExecutionOptions["createTaskContext"];
  readonly nodeRuntimes: NodeRuntimeRegistry;
  /** Process-local, presentation-only room updates for this Coding runtime. */
  readonly roomUpdates: NodeRoomUpdateStore;
  /** Durable chat inputs supplied to model-backed tasks through runtime adapters. */
  readonly executionAttachments?: ReadonlyArray<NodeExecutionAttachmentInput>;
  readonly onNodeLog?: (entry: NodeExecutionLogEvent) => void;
  /**
   * Optional observational sink for bounded canonical inner-loop trajectories.
   * Trajectories do not participate in task acceptance or certification.
   */
  readonly onNodeTrajectory?: NodeExecutionTrajectoryObserver;
  readonly onGraphSnapshot?: (snapshot: TaskGraphControlSnapshot) => Promise<void> | void;
  readonly controlIngress?: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly jobId: string;
    readonly jobAttempt: number;
    readonly pendingMessages: () => Promise<ReadonlyArray<CodingConversationMessage>>;
    readonly claimCommands: (consumeId: string) => Promise<void>;
  };
  readonly roomControlIntents?: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly authority: CodingRoomControlIntentIngress;
  };
};

const codingTaskTimeout = (capability: string): number =>
  capability === "room"
    ? CODING_ROOM_ANNOUNCEMENT_TIMEOUT_MS
    : capability === "implement" || capability === "investigate" || capability === "remediate" || capability === "validate"
    ? CODING_WORKER_TIMEOUT_MS
    : capability === "propose" || capability === "respond"
      ? CODING_PROPOSAL_TIMEOUT_MS
      : capability === "review"
        ? CODING_REVIEW_TIMEOUT_MS
        : CODING_RESOLUTION_TIMEOUT_MS;

const codingTaskResultContract = (
  outputKey: string,
  requireAuthoredSummary = false,
): TaskResultContract => ({
  mode: "json",
  outputKey,
  schema: {
    type: "object",
    required: [outputKey],
    additionalProperties: false,
    properties: {
      [outputKey]: requireAuthoredSummary
        ? {
            type: "object",
            required: ["summary"],
            additionalProperties: true,
            properties: {
              summary: { type: "string", minLength: 1, maxLength: 1_600 },
            },
          }
        : true,
    },
  },
});

const codingInvestigationSynthesisResultContract = (): TaskResultContract => ({
  mode: "json",
  outputKey: "final_report",
  schema: {
    type: "object",
    required: ["final_report"],
    additionalProperties: false,
    properties: {
      final_report: {
        type: "object",
        required: [
          "status",
          "summary",
          "answer",
          "findings",
          "files",
          "limitations",
          "specialistReports",
        ],
        additionalProperties: false,
        properties: {
          status: { const: "completed" },
          summary: { type: "string", minLength: 1, maxLength: 1_600 },
          answer: { type: "string", minLength: 1 },
          findings: {
            type: "array",
            items: {
              type: "object",
              required: ["claim", "evidence"],
              additionalProperties: false,
              properties: {
                claim: { type: "string", minLength: 1 },
                evidence: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
              },
            },
          },
          files: { type: "array", items: { type: "string", minLength: 1 } },
          limitations: { type: "array", items: { type: "string", minLength: 1 } },
          specialistReports: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
});

const codingRoomAnnouncementResultContract = (
  outputKey: string,
): TaskResultContract => ({
  mode: "json",
  outputKey,
  schema: {
    type: "object",
    required: [outputKey],
    additionalProperties: false,
    properties: {
      [outputKey]: {
        type: "object",
        required: ["summary"],
        additionalProperties: false,
        properties: {
          summary: {
            type: "string",
            minLength: 1,
            maxLength: CODING_ROOM_ANNOUNCEMENT_MAX_CHARS,
            pattern: ".*\\S.*",
          },
        },
      },
    },
  },
});

const parsedOutputObject = (
  encoded: string | undefined,
  outputKey: string,
): Readonly<Record<string, JsonValue>> | undefined => {
  if (!encoded) return undefined;
  try {
    const value = JSON.parse(encoded) as JsonValue;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const selected = outputKey in value
      ? (value as Readonly<Record<string, JsonValue>>)[outputKey]
      : value;
    return selected && typeof selected === "object" && !Array.isArray(selected)
      ? selected as Readonly<Record<string, JsonValue>>
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Review branching fails closed: only an explicit approve verdict can skip a
 * model remediation turn. Missing, malformed, blocked, or changes_requested
 * reports all require the coordinator to expand a remediator.
 */
export const codingReviewRequiresRemediation = (
  outputs: Readonly<Record<string, string>>,
  reviewOutputKeys: ReadonlyArray<string>,
): boolean => reviewOutputKeys.some((outputKey) =>
  parsedOutputObject(outputs[outputKey], outputKey)?.verdict !== "approve");

const recreateCodingDefinition = (input: {
  readonly source: DynamicTaskDefinition;
  readonly taskId?: string;
  readonly semanticKey?: string;
  readonly parentTaskId: string;
  readonly objective?: string;
  readonly dependencies?: DynamicTaskDefinition["dependencies"];
}): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId: input.taskId ?? input.source.taskId,
  semanticKey: input.semanticKey ?? input.source.semanticKey,
  nodeId: input.source.nodeId,
  capability: input.source.capability,
  objective: input.objective ?? input.source.objective,
  handler: input.source.handler,
  acceptance: input.source.acceptance,
  result: input.source.result,
  dependencies: input.dependencies ?? input.source.dependencies,
  join: input.source.join,
  inputs: input.source.inputs,
  runtimeBindingEpoch: input.source.runtimeBindingEpoch,
  retry: input.source.retry,
  timeoutMs: input.source.timeoutMs,
  sideEffect: input.source.sideEffect,
  estimatedCostMicros: input.source.estimatedCostMicros,
  parentTaskId: input.parentTaskId,
});

const acceptedCodingDependencyOutputs = async (
  snapshot: TaskGraphControlSnapshot,
  store: DataReferenceStore,
  definition: DynamicTaskDefinition,
): Promise<{
  readonly outputs: Record<string, string>;
  readonly projection: CodingAcceptedOutputProjection;
}> => {
  const roots = definition.dependencies.map((dependency) => dependency.taskId);
  if (roots.length === 0) {
    throw new Error(`Coding native task ${definition.taskId} has no accepted dependency frontier`);
  }
  const projection = await projectCodingAcceptedOutputsForRoots(snapshot, store, roots);
  const taskById = new Map(snapshot.tasks.map((record) => [record.definition.taskId, record]));
  const outputs: Record<string, string> = {};
  for (const dependency of definition.dependencies) {
    const effectiveTaskId = codingAcceptedTaskIdForRoot(snapshot, dependency.taskId);
    const record = taskById.get(effectiveTaskId);
    if (!record || record.status !== "accepted" || record.definition.result.mode === "none") {
      throw new Error(
        `Coding final frontier dependency ${dependency.taskId} is not an accepted result task`,
      );
    }
    const outputKey = record.definition.result.outputKey;
    if (Object.prototype.hasOwnProperty.call(outputs, outputKey)) {
      throw new Error(
        `Coding final frontier has ambiguous semantic output ${outputKey} from multiple tasks`,
      );
    }
    outputs[outputKey] = codingAcceptedOutputForTask(
      projection,
      effectiveTaskId,
      outputKey,
    );
  }
  return { outputs, projection };
};

const codingAuthoredFinalAnswer = (
  encoded: string | undefined,
  executionKind: CodingExecutionKind,
): { readonly summary: string; readonly frontierHash?: string } => {
  const result = parsedOutputObject(
    encoded,
    executionKind === "investigation" ? "final_report" : CODING_FINAL_ANSWER_OUTPUT,
  );
  const summary = typeof result?.summary === "string" ? result.summary.trim() : "";
  if (!summary || summary.length > 1_600) {
    throw new Error("Coding final answer is missing its bounded model-authored summary");
  }
  if (executionKind === "investigation") return { summary };
  const frontierHash = typeof result?.frontierHash === "string"
    ? result.frontierHash.trim()
    : "";
  if (!frontierHash) {
    throw new Error("Coding final answer is missing its certified frontier hash");
  }
  return { summary, frontierHash };
};

const CODING_ROOM_UPDATE_SETTLED_TASK_STATUSES = new Set([
  "accepted",
  "failed",
  "canceled",
  "skipped",
]);

const settleCodingRoomUpdateTasks = (
  roomUpdates: NodeRoomUpdateStore,
  runId: string,
  snapshot: Pick<TaskGraphControlSnapshot, "tasks">,
): void => {
  for (const record of snapshot.tasks) {
    if (CODING_ROOM_UPDATE_SETTLED_TASK_STATUSES.has(record.status)) {
      roomUpdates.settleTask(runId, record.definition.taskId);
    }
  }
};

const codingRoomUpdateTaskGraph = (
  control: TaskGraphControl,
  roomUpdates: NodeRoomUpdateStore,
  runId: string,
): TaskGraphControl => {
  const settleAfterTransition = async (): Promise<void> => {
    const snapshot = await control.snapshot().catch(() => undefined);
    if (snapshot) settleCodingRoomUpdateTasks(roomUpdates, runId, snapshot);
  };
  return new Proxy(control, {
    get(target, property, receiver) {
      if (property === "accept") {
        return async (input: Parameters<TaskGraphControl["accept"]>[0]) => {
          try {
            const outcome = await target.accept(input);
            roomUpdates.settleTask(runId, input.lease.taskId);
            return outcome;
          } catch (error) {
            await settleAfterTransition();
            throw error;
          }
        };
      }
      if (property === "fail") {
        return async (input: Parameters<TaskGraphControl["fail"]>[0]) => {
          try {
            await target.fail(input);
            await settleAfterTransition();
          } catch (error) {
            await settleAfterTransition();
            throw error;
          }
        };
      }
      if (property === "cancel") {
        return async (input: Parameters<TaskGraphControl["cancel"]>[0]) => {
          try {
            await target.cancel(input);
            roomUpdates.settleTask(runId, input.taskId);
          } catch (error) {
            await settleAfterTransition();
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const currentCodingRoomUpdateTasks = (
  snapshot: Pick<TaskGraphControlSnapshot, "tasks">,
) => snapshot.tasks.map(({ definition }) => ({
  id: definition.taskId,
  nodeId: definition.nodeId,
  needs: definition.dependencies.map((dependency) => dependency.taskId),
  provides: [definition.taskId],
}));

const codingExecutionOptions = (
  options: RunCodingAgentOptions,
): NonNullable<RosterPlatformExecutionOptions["executionOptions"]> =>
  ({ runId, nodeId, taskId, capability, effectiveRuntimeKind }) => {
    const adapter = effectiveRuntimeKind !== "roster-native"
      ? options.nodeRuntimes.adapter(effectiveRuntimeKind)
      : undefined;
    const usesCodeMode = capability !== "validate"
      && capability !== "room"
      && options.executionKind !== "investigation"
      && Boolean(adapter?.supportsCodeMode);
    const maxFunctionCalls = !usesCodeMode
      && nodeId !== CODING_COORDINATOR.id
      && CODING_MODEL_CAPABILITIES.has(capability)
      ? CODING_ROOM_UPDATE_MAX_CALLS
      : undefined;
    return {
      ...(usesCodeMode ? { surface: { codeMode: { inputMode: "external" as const } } } : {}),
      ...(maxFunctionCalls === undefined ? {} : { maxFunctionCalls }),
      ...(capability === "validate" || capability === "room" || !options.executionAttachments?.length
        ? {}
        : { attachments: options.executionAttachments }),
      ...(options.onNodeTrajectory ? { onTrajectory: options.onNodeTrajectory } : {}),
      ...(options.onNodeLog ? {
        onLog: (entry) => options.onNodeLog?.({
          ...entry,
          runId,
          nodeId,
          taskId,
          runtime: effectiveRuntimeKind,
        }),
      } : {}),
    };
  };

const codingTaskContext = async (input: {
  readonly options: RunCodingAgentOptions;
  readonly platform: RosterPlatform;
  readonly node: WorkspaceNode;
  readonly definition: DynamicTaskDefinition;
  readonly lease: DynamicTaskHandlerContext["lease"];
  readonly deliveredMessageIds: Set<string>;
}): Promise<RosterTaskContext> => {
  const topologyVersion = input.definition.inputs.topologyVersion;
  const taskContext = await input.options.createTaskContext({
    runId: input.options.runId,
    node: input.node,
    definition: input.definition,
    lease: input.lease,
  });
  const fence = taskContext.fence;
  if (
    taskContext.node.id !== input.node.id
    || fence.runId !== input.options.runId
    || fence.taskId !== input.definition.taskId
    || fence.nodeId !== input.definition.nodeId
    || fence.fence !== BigInt(input.lease.fence)
    || fence.runtimeBindingEpoch !== input.definition.runtimeBindingEpoch
    || fence.frontierVersion !== input.definition.inputs.frontierVersion
    || fence.topologyVersion !== topologyVersion
    || fence.catalogVersion !== input.definition.inputs.catalogVersion
    || hashCanonical(fence.inputVersions) !== hashCanonical(input.definition.inputs.inputVersions)
  ) {
    throw new Error(`Coding task context for ${input.definition.taskId} does not match its execution fence`);
  }
  const controlIngress = input.options.controlIngress;
  const humanNode = input.options.workspaceNodes?.find((node) =>
    node.metadata?.participantKind === "human");
  if (controlIngress && humanNode && input.node.id !== CODING_COORDINATOR.id) {
    const consumeId = `consume_${hashCanonical({
      schema: "coding-control-consume/v2",
      workspaceId: controlIngress.workspaceId,
      conversationId: controlIngress.conversationId,
      runId: input.options.runId,
      jobId: controlIngress.jobId,
      jobAttempt: controlIngress.jobAttempt,
      taskId: input.definition.taskId,
      nodeId: input.definition.nodeId,
      fence: input.lease.fence,
    }).slice(0, 28)}`;
    await controlIngress.claimCommands(consumeId);
    const pending = (await controlIngress.pendingMessages())
      .filter((message) => message.conversationId === controlIngress.conversationId
        && message.author.id === humanNode.id
        && !input.deliveredMessageIds.has(message.messageId));
    const selected: CodingConversationMessage[] = [];
    let bytes = 0;
    for (const message of pending) {
      const nextBytes = Buffer.byteLength(message.text);
      if (selected.length >= 4 || bytes + nextBytes > 6_000) break;
      selected.push(message);
      bytes += nextBytes;
    }
    const topologyNodes = [...new Map([
      ...(input.options.workspaceNodes ?? []),
      ...input.platform.definition.nodes,
    ].map((node) => [node.id, node])).values()];
    const dependencies = topologyNodes.flatMap((node) =>
      codingWorkspaceNodeDependencyIds(node).map((dependsOnNodeId) => ({
        nodeId: node.id,
        dependsOnNodeId,
        reason: "Saved WorkspaceNode dependency",
      })));
    for (const message of selected) {
      const evidenceTurn = message.tags.includes("intent:evidence");
      const turn = createCodingAgentTurn({
        kind: evidenceTurn ? "evidence" : "clarification",
        authorNodeId: humanNode.id,
        recipients: [input.definition.nodeId],
        subjectId: `human-${message.messageId}`.slice(0, 160),
        originatingTaskId: input.definition.taskId,
        responseRequirement: "none",
        body: message.text,
        evidence: evidenceTurn ? [`conversation-message:${message.messageId}`] : [],
      });
      const authorization = createCodingControlIngressAuthorization({
        workspaceId: controlIngress.workspaceId,
        conversationId: controlIngress.conversationId,
        runId: input.options.runId,
        messageId: message.messageId,
        turnId: turn.turnId,
        jobId: controlIngress.jobId,
        jobAttempt: controlIngress.jobAttempt,
        topologyVersion,
        authorNodeId: humanNode.id,
        recipientTaskId: input.definition.taskId,
        recipientNodeId: input.definition.nodeId,
      });
      const planned = planCodingAgentTurns({
        originatingTaskId: input.definition.taskId,
        nodes: topologyNodes,
        dependencies,
        turns: [turn],
        ingressAuthorizations: [authorization],
        ingressScope: {
          workspaceId: authorization.workspaceId,
          conversationId: authorization.conversationId,
          runId: authorization.runId,
          jobId: authorization.jobId,
          jobAttempt: authorization.jobAttempt,
          topologyVersion: authorization.topologyVersion,
        },
        policy: clampCodingAgentTurnPolicy({
          maxNodes: input.platform.definition.maxNodes ?? input.platform.definition.nodes.length,
          maxTasks: input.platform.definition.policy.maxTasks,
          maxParallel: input.platform.definition.policy.maxInflight,
          maxDepth: input.platform.definition.policy.maxDepth,
        }),
      });
      if (!planned.acceptedTurnIds.includes(turn.turnId)) {
        throw new Error(`Control ingress authorization was rejected for task ${input.definition.taskId}`);
      }
      await taskContext.publish({
        kind: "message",
        mode: "append",
        subjectId: `human-${message.messageId}`,
        body: {
          schema: "roster.coding.control-delivery.v2",
          authorNodeId: humanNode.id,
          authorization,
          turn,
        },
        references: [`conversation-message:${message.messageId}`],
      });
      input.deliveredMessageIds.add(message.messageId);
    }
  }
  return taskContext;
};

/** Executes the first-party Coding workflow as a dynamically expanded v3 DAG. */
export const runCodingAgent = async (
  initialOptions: RunCodingAgentOptions,
): Promise<CodingAgentExecutionResult> => {
  const projectedImprovements = applyCodingImprovements({
    objective: initialOptions.objective,
    snapshot: initialOptions.activeImprovementSnapshot,
    maxNodes: initialOptions.maxNodes,
    maxParallel: initialOptions.maxParallel,
    maxSupervisors: initialOptions.maxSupervisors,
    reviewPolicy: initialOptions.reviewPolicy,
  });
  const options: RunCodingAgentOptions = {
    ...initialOptions,
    ...projectedImprovements,
  };
  const objective = options.objective.trim();
  if (!objective) throw new Error("Coding agent objective must not be blank");
  const humanResolution = validatedHumanResolution(options.humanResolution);
  const coordination = requireCodingCoordination(options.coordination);
  const executionKind = options.executionKind ?? "mutation";
  const mode = executionKind === "investigation"
    ? "fast"
    : humanResolution ? "reviewed" : codingReviewMode(coordination, options.reviewPolicy);
  const blueprint = codingAgentBlueprint(options, { objective, runId: options.runId });
  const platform = defineCodingAgentPlatform(options, { objective, runId: options.runId });
  const topologyVersion = `coding_topology_${hashCanonical(
    blueprint.nodes.map((node) => node.id).sort(),
  ).slice(0, 28)}`;
  const catalogVersion = `coding_catalog_${hashCanonical(
    platform.definition.functions ?? [],
  ).slice(0, 28)}`;
  const requestReference = await options.dataReferences.put({
    value: objective,
    mediaType: "text/plain",
    metadata: { outputKey: "request", runId: options.runId },
  }, { signal: options.signal });
  const humanResolutionReference = humanResolution
    ? await options.dataReferences.put({
        value: humanResolution as unknown as JsonValue,
        metadata: {
          outputKey: CODING_COLLABORATION_RESOLUTION_OUTPUT,
          runId: options.runId,
        },
      }, { signal: options.signal })
    : undefined;
  const inputVersions = {
    request: requestReference.contentHash,
    ...(humanResolutionReference
      ? { [CODING_COLLABORATION_RESOLUTION_OUTPUT]: humanResolutionReference.contentHash }
      : {}),
  };
  const dataReferences = [
    requestReference,
    ...(humanResolutionReference ? [humanResolutionReference] : []),
  ];
  const taskContextReferences = new Map(await Promise.all(
    blueprint.tasks.map(async (task) => [
      task.id,
      await options.dataReferences.put({
        value: task.context,
        metadata: {
          outputKey: CODING_TASK_CONTEXT_OUTPUT_KEY,
          runId: options.runId,
          taskId: task.id,
          capability: task.capability,
        },
      }, { signal: options.signal }),
    ] as const),
  ));
  const frontierVersion = `coding_frontier_${hashCanonical(inputVersions).slice(0, 28)}`;
  const taskByOutput = new Map<string, CodingTaskBlueprint>();
  for (const task of blueprint.tasks) {
    for (const output of task.provides) taskByOutput.set(output, task);
  }
  const workDefinitions = blueprint.tasks.map((task): DynamicTaskDefinition => {
    const taskContextReference = taskContextReferences.get(task.id);
    if (!taskContextReference) {
      throw new Error(`Coding task ${task.id} has no durable context policy`);
    }
    return createDynamicTaskDefinition({
      taskId: task.id,
      semanticKey: `coding:${options.runId}:${task.id}`,
      nodeId: task.nodeId,
      capability: task.capability,
      objective: task.objective,
      handler: ROSTER_NODE_TASK_HANDLER,
      acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
      result: task.capability === "room"
        ? codingRoomAnnouncementResultContract(task.provides[0]!)
        : task.id === "synthesize-investigation"
          ? codingInvestigationSynthesisResultContract()
        : codingTaskResultContract(
            task.provides[0]!,
            task.capability === "remediate"
              || task.capability === "synthesize"
              || task.id === "synthesize-investigation"
              || (mode === "fast" && task.capability === "implement"),
          ),
      dependencies: task.needs.flatMap((need) => {
        const producer = taskByOutput.get(need);
        return producer ? [{ taskId: producer.id, condition: "accepted" as const }] : [];
      }),
      join: { kind: "all-success" },
      inputs: {
        inputVersions: {
          ...inputVersions,
          [CODING_TASK_CONTEXT_INPUT_KEY]: taskContextReference.contentHash,
        },
        dataReferences: [...dataReferences, taskContextReference],
        frontierVersion,
        topologyVersion,
        catalogVersion,
      },
      runtimeBindingEpoch: task.capability === "validate" ? 2 : 0,
      retry: {
        maxAttempts: task.capability === "room" ? 1 : 2,
        initialBackoffMs: 250,
        maximumBackoffMs: 5_000,
      },
      timeoutMs: codingTaskTimeout(task.capability),
      sideEffect: task.capability === "implement" || task.capability === "remediate"
        ? "idempotent"
        : "pure",
      estimatedCostMicros: codingProviderBudget(options, task.capability).estimatedCostMicros,
      parentTaskId: "coding-coordinate",
    });
  });
  const deferredCapabilities = new Set(["remediate", "validate", "certify", "synthesize"]);
  const initialDefinitions = mode === "fast"
    ? workDefinitions.filter((definition) => definition.capability !== "synthesize")
    : workDefinitions.filter((definition) => !deferredCapabilities.has(definition.capability));
  const deferredDefinitions = mode === "fast"
    ? workDefinitions.filter((definition) => definition.capability === "synthesize")
    : workDefinitions.filter((definition) => deferredCapabilities.has(definition.capability));
  const finalSynthesisDefinition = deferredDefinitions.find((definition) =>
    definition.capability === "synthesize");
  const reviewDefinitions = initialDefinitions.filter((definition) =>
    definition.capability === "review");
  const completionContextDefinitions = initialDefinitions.filter((definition) =>
    definition.capability === "resolve");
  const implementationDefinition = initialDefinitions.find((definition) =>
    definition.capability === "implement");
  if (executionKind !== "investigation" && mode === "reviewed" && (!implementationDefinition || reviewDefinitions.length === 0)) {
    throw new Error("Reviewed Coding execution requires an implementer and an independent reviewer");
  }
  const finalTaskId = "coding-finalize";
  const createFinalDefinition = (
    parentTaskId: string,
    dependencies: ReadonlyArray<DynamicTaskDefinition>,
    suffix = "",
  ): DynamicTaskDefinition => createDynamicTaskDefinition({
    taskId: `${finalTaskId}${suffix}`,
    semanticKey: `coding:${options.runId}:finalize${suffix}`,
    nodeId: CODING_COORDINATOR.id,
    capability: "coordinate",
    objective: "Certify that all accepted Coding outputs satisfy the selected completion policy.",
    handler: ROSTER_NODE_TASK_HANDLER,
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: codingTaskResultContract("coding_result"),
    dependencies: dependencies.map((definition) => ({
      taskId: definition.taskId,
      condition: "accepted" as const,
    })),
    join: { kind: "all-success" },
    inputs: {
      inputVersions,
      dataReferences,
      frontierVersion,
      topologyVersion,
      catalogVersion,
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 30_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
    parentTaskId,
  });
  const completionTaskId = "coding-complete";
  const createCompletionDefinition = (
    parentTaskId: string,
    dependencies: ReadonlyArray<DynamicTaskDefinition>,
    suffix = "",
  ): DynamicTaskDefinition => createDynamicTaskDefinition({
    taskId: `${completionTaskId}${suffix}`,
    semanticKey: `coding:${options.runId}:complete${suffix}`,
    nodeId: CODING_COORDINATOR.id,
    capability: "coordinate",
    objective: "Seal the exact accepted model-authored final answer and its certified dependency frontier.",
    handler: ROSTER_NODE_TASK_HANDLER,
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: codingTaskResultContract("coding_result"),
    dependencies: dependencies.map((definition) => ({
      taskId: definition.taskId,
      condition: "accepted" as const,
    })),
    join: { kind: "all-success" },
    inputs: {
      inputVersions,
      dataReferences,
      frontierVersion,
      topologyVersion,
      catalogVersion,
    },
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 30_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
    parentTaskId,
  });
  const reviewGateTaskId = "coding-review-gate";
  const reviewGateDefinition = mode === "reviewed"
    ? createDynamicTaskDefinition({
        taskId: reviewGateTaskId,
        semanticKey: `coding:${options.runId}:review-gate`,
        nodeId: CODING_COORDINATOR.id,
        capability: "coordinate",
        objective: "Consume explicit reviewer verdicts and dynamically expand remediation or certification.",
        handler: ROSTER_NODE_TASK_HANDLER,
        acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
        result: { mode: "none" },
        dependencies: initialDefinitions.map((definition) => ({
          taskId: definition.taskId,
          condition: "accepted" as const,
        })),
        join: { kind: "all-success" },
        inputs: {
          inputVersions,
          dataReferences,
          frontierVersion,
          topologyVersion,
          catalogVersion,
        },
        runtimeBindingEpoch: 0,
        retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
        timeoutMs: 30_000,
        sideEffect: "pure",
        estimatedCostMicros: 0,
        parentTaskId: "coding-coordinate",
      })
    : undefined;
  const fastFinalDefinition = mode === "fast"
    ? createFinalDefinition("coding-coordinate", initialDefinitions)
    : undefined;
  const root = createRosterRootTask({
    taskId: "coding-coordinate",
    semanticKey: `coding:${options.runId}:coordinate`,
    nodeId: CODING_COORDINATOR.id,
    capability: "coordinate",
    objective: "Publish the bounded Coding specialist graph and its explicit certification continuation.",
    inputs: {
      inputVersions,
      dataReferences,
      frontierVersion,
      topologyVersion,
      catalogVersion,
    },
    result: { mode: "none" },
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 30_000,
  });
  const deliveredMessageIds = new Set<string>();
  const createTaskContext = preserveRosterTaskContextDurability(
    options.createTaskContext,
    ({ node, definition, lease }) => codingTaskContext({
      options,
      platform,
      node,
      definition,
      lease,
      deliveredMessageIds,
    }),
  );
  const pendingRoomControlIntents = async (
    boundaryTaskId: string,
  ): Promise<ReadonlyArray<CodingRoomControlIntent>> => {
    const ingress = options.roomControlIntents;
    if (!ingress) return [];
    const pending = await ingress.authority.pending({
      workspaceId: ingress.workspaceId,
      roomId: ingress.roomId,
      runId: options.runId,
      boundaryTaskId,
    });
    return pending
      .map((intent) => createCodingRoomControlIntent(intent))
      .filter((intent) =>
        intent.workspaceId === ingress.workspaceId && intent.roomId === ingress.roomId)
      .sort((left, right) =>
        left.createdAtMs - right.createdAtMs || left.intentId.localeCompare(right.intentId))
      .slice(0, 4);
  };
  const consumeRoomControlIntents = async (
    boundaryTaskId: string,
    expansionKey: string,
    intents: ReadonlyArray<CodingRoomControlIntent>,
  ): Promise<void> => {
    const ingress = options.roomControlIntents;
    if (!ingress) return;
    for (const intent of intents) {
      await ingress.authority.consume({
        workspaceId: ingress.workspaceId,
        roomId: ingress.roomId,
        runId: options.runId,
        boundaryTaskId,
        intentId: intent.intentId,
        expansionKey,
      });
    }
  };
  const dynamicRemediationCycle = (input: {
    readonly parentTaskId: string;
    readonly intents: ReadonlyArray<CodingRoomControlIntent>;
    readonly suffix?: string;
    readonly skipRemediation: boolean;
    readonly frontierDependencies?: DynamicTaskDefinition["dependencies"];
  }): {
    readonly definitions: ReadonlyArray<DynamicTaskDefinition>;
    readonly continuation: DynamicTaskDefinition;
  } => {
    const suffix = input.suffix ?? "";
    const remediatorSource = deferredDefinitions.find((definition) =>
      definition.capability === "remediate");
    const validationSource = deferredDefinitions.find((definition) =>
      definition.capability === "validate");
    const certificationSources = deferredDefinitions.filter((definition) =>
      definition.capability === "certify");
    const followUpClause = input.intents.length
      ? ` Also incorporate these durable room follow-ups at this safe boundary: ${
          input.intents.map((intent) => `[${intent.intentId}] ${intent.text}`).join(" ")
        }`
      : "";
    let frontierSource: DynamicTaskDefinition;
    const children: DynamicTaskDefinition[] = [];
    if (input.skipRemediation) {
      const acceptTaskId = `accept-implementation${suffix}`;
      frontierSource = createDynamicTaskDefinition({
        taskId: acceptTaskId,
        semanticKey: `coding:${options.runId}:accept-implementation${suffix}`,
        nodeId: CODING_COORDINATOR.id,
        capability: "coordinate",
        objective: "Promote the explicitly approved implementation report to the final frontier without another provider call.",
        handler: ROSTER_NODE_TASK_HANDLER,
        acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
        result: codingTaskResultContract("final_report"),
        dependencies: [{
          taskId: implementationDefinition!.taskId,
          condition: "accepted",
        }],
        join: { kind: "all-success" },
        inputs: {
          inputVersions,
          dataReferences,
          frontierVersion,
          topologyVersion,
          catalogVersion,
        },
        runtimeBindingEpoch: 0,
        retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
        timeoutMs: 30_000,
        sideEffect: "pure",
        estimatedCostMicros: 0,
        parentTaskId: input.parentTaskId,
      });
      children.push(frontierSource);
    } else {
      if (!remediatorSource) throw new Error("Reviewed Coding plan has no remediator blueprint");
      frontierSource = recreateCodingDefinition({
        source: remediatorSource,
        taskId: `${remediatorSource.taskId}${suffix}`,
        semanticKey: `${remediatorSource.semanticKey}${suffix}`,
        parentTaskId: input.parentTaskId,
        objective: `${remediatorSource.objective}${followUpClause}`,
        dependencies: suffix
          ? input.frontierDependencies
          : remediatorSource.dependencies,
      });
      children.push(frontierSource);
    }
    let validation: DynamicTaskDefinition | undefined;
    if (validationSource) {
      validation = recreateCodingDefinition({
        source: validationSource,
        taskId: `${validationSource.taskId}${suffix}`,
        semanticKey: `${validationSource.semanticKey}${suffix}`,
        parentTaskId: input.parentTaskId,
        dependencies: [{ taskId: frontierSource.taskId, condition: "accepted" }],
      });
      children.push(validation);
    }
    for (const source of certificationSources) {
      const certification = recreateCodingDefinition({
        source,
        taskId: `${source.taskId}${suffix}`,
        semanticKey: `${source.semanticKey}${suffix}`,
        parentTaskId: input.parentTaskId,
        objective: `${source.objective}${input.skipRemediation
          ? " The initial independent review explicitly approved this frontier, so certify it without requesting cosmetic remediation."
          : ""}`,
        dependencies: [
          { taskId: frontierSource.taskId, condition: "accepted" },
          ...(validation ? [{ taskId: validation.taskId, condition: "accepted" as const }] : []),
        ],
      });
      children.push(certification);
    }
    if (children.length < 2) {
      throw new Error("Reviewed Coding dynamic continuation requires frontier work and re-review");
    }
    const continuation = createFinalDefinition(
      input.parentTaskId,
      [...children, ...completionContextDefinitions],
      suffix,
    );
    return { definitions: [...children, continuation], continuation };
  };
  const fastFollowUpCycle = (input: {
    readonly parentTaskId: string;
    readonly intents: ReadonlyArray<CodingRoomControlIntent>;
    readonly suffix: string;
    readonly frontierTaskId: string;
  }): {
    readonly definitions: ReadonlyArray<DynamicTaskDefinition>;
    readonly continuation: DynamicTaskDefinition;
  } => {
    if (!implementationDefinition) throw new Error("Fast Coding plan has no implementation blueprint");
    const followUp = recreateCodingDefinition({
      source: implementationDefinition,
      taskId: `${implementationDefinition.taskId}${input.suffix}`,
      semanticKey: `${implementationDefinition.semanticKey}${input.suffix}`,
      parentTaskId: input.parentTaskId,
      objective: `${implementationDefinition.objective} Also incorporate these durable room follow-ups at this safe boundary: ${
        input.intents.map((intent) => `[${intent.intentId}] ${intent.text}`).join(" ")
      }`,
      dependencies: [{ taskId: input.frontierTaskId, condition: "accepted" }],
    });
    const continuation = createFinalDefinition(
      input.parentTaskId,
      [followUp, ...completionContextDefinitions],
      input.suffix,
    );
    return { definitions: [followUp, continuation], continuation };
  };
  const finalAnswerCycle = (input: {
    readonly parentTaskId: string;
    readonly dependencies: ReadonlyArray<DynamicTaskDefinition>;
    readonly suffix: string;
  }): {
    readonly definitions: ReadonlyArray<DynamicTaskDefinition>;
    readonly continuation: DynamicTaskDefinition;
    readonly answerTask: DynamicTaskDefinition;
  } => {
    if (executionKind === "investigation") {
      const answerTask = input.dependencies.find((definition) =>
        definition.taskId === "synthesize-investigation");
      if (!answerTask) throw new Error("Coding investigation has no accepted synthesis task");
      const continuation = createCompletionDefinition(
        input.parentTaskId,
        input.dependencies,
        input.suffix,
      );
      return { definitions: [continuation], continuation, answerTask };
    }
    if (!finalSynthesisDefinition) {
      throw new Error("Coding mutation has no final answer synthesis definition");
    }
    const answerTask = recreateCodingDefinition({
      source: finalSynthesisDefinition,
      taskId: `${finalSynthesisDefinition.taskId}${input.suffix}`,
      semanticKey: `${finalSynthesisDefinition.semanticKey}${input.suffix}`,
      parentTaskId: input.parentTaskId,
      dependencies: input.dependencies.map((definition) => ({
        taskId: definition.taskId,
        condition: "accepted" as const,
      })),
    });
    const continuation = createCompletionDefinition(
      input.parentTaskId,
      [...input.dependencies, answerTask],
      input.suffix,
    );
    return {
      definitions: [answerTask, continuation],
      continuation,
      answerTask,
    };
  };
  const taskGraph = codingRoomUpdateTaskGraph(
    options.taskGraph,
    options.roomUpdates,
    options.runId,
  );
  const execution = platform.createExecution({
    runId: options.runId,
    seedTasks: [root],
    taskGraph,
    dataReferences: options.dataReferences,
    nodeRuntimes: options.nodeRuntimes,
    executionOptions: codingExecutionOptions(options),
    contextRepository: () => options.repositoryPlacement ?? {
      root: options.workingDirectory ?? null,
      branch: null,
      commit: null,
      worktree: options.workingDirectory ?? null,
    },
    providerTokenReserve: (definition) =>
      codingProviderBudget(options, definition.capability).reservedTokens,
    createTaskContext,
    nativeExecute: async (context) => {
      const readDependencyFrontier = async (): Promise<{
        readonly snapshot: TaskGraphControlSnapshot;
        readonly outputs: Record<string, string>;
        readonly projection: CodingAcceptedOutputProjection;
      }> => {
        const snapshot = await execution.snapshot();
        const accepted = await acceptedCodingDependencyOutputs(
          snapshot,
          options.dataReferences,
          context.definition,
        );
        if (humanResolution) {
          const encoded = JSON.stringify(humanResolution);
          const current = accepted.outputs[CODING_COLLABORATION_RESOLUTION_OUTPUT];
          if (current !== undefined && current !== encoded) {
            throw new Error("Coding final frontier has ambiguous collaboration resolution");
          }
          accepted.outputs[CODING_COLLABORATION_RESOLUTION_OUTPUT] = encoded;
        }
        return { snapshot, ...accepted };
      };
      if (context.definition.taskId === root.taskId) {
        const continuation = reviewGateDefinition ?? fastFinalDefinition!;
        const definitions = [...initialDefinitions, continuation];
        await context.expand({
          expansionKey: `coding-${hashCanonical({
            version: blueprint.version,
            tasks: definitions.map((definition) => definition.definitionHash),
          }).slice(0, 28)}`,
          definitions,
          continuationTaskId: continuation.taskId,
        });
        return undefined;
      }
      if (context.definition.taskId === reviewGateTaskId) {
        const { outputs } = await readDependencyFrontier();
        const reviewOutputKeys = reviewDefinitions.flatMap((definition) =>
          definition.result.mode === "none" ? [] : [definition.result.outputKey]);
        const intents = await pendingRoomControlIntents(context.definition.taskId);
        const needsRemediation = intents.length > 0
          || codingReviewRequiresRemediation(outputs, reviewOutputKeys);
        const cycle = dynamicRemediationCycle({
          parentTaskId: context.definition.taskId,
          intents,
          skipRemediation: !needsRemediation,
        });
        const expansionKey = `coding-review-continuation-${hashCanonical({
          needsRemediation,
          intents: intents.map((intent) => intent.intentId),
          definitions: cycle.definitions.map((definition) => definition.definitionHash),
        }).slice(0, 28)}`;
        await context.expand({
          expansionKey,
          definitions: cycle.definitions,
          continuationTaskId: cycle.continuation.taskId,
        });
        await consumeRoomControlIntents(
          context.definition.taskId,
          expansionKey,
          intents,
        );
        return undefined;
      }
      if (context.definition.taskId.startsWith("accept-implementation")) {
        const { outputs } = await readDependencyFrontier();
        const implementation = parsedOutputObject(
          outputs.implementation_report,
          "implementation_report",
        );
        if (!implementation || implementation.status !== "verified") {
          throw new Error("Approved implementation report is missing or not verified");
        }
        return { final_report: implementation };
      }
      if (context.definition.taskId.startsWith(completionTaskId)) {
        const { snapshot, outputs, projection } = await readDependencyFrontier();
        const suffix = context.definition.taskId.slice(completionTaskId.length);
        const answerTaskId = executionKind === "investigation"
          ? "synthesize-investigation"
          : `synthesize-final${suffix}`;
        const answerOutputKey = executionKind === "investigation"
          ? "final_report"
          : CODING_FINAL_ANSWER_OUTPUT;
        const encodedAnswer = codingAcceptedOutputForTask(
          projection,
          answerTaskId,
          answerOutputKey,
        );
        const authored = codingAuthoredFinalAnswer(encodedAnswer, executionKind);
        const source = snapshot.tasks.find((record) =>
          record.definition.taskId === answerTaskId && record.status === "accepted");
        if (!source) throw new Error("Coding final answer source is not accepted");
        const certifiedFrontierHash = executionKind === "investigation"
          ? undefined
          : reportedFrontierHash(outputs.final_report);
        if (executionKind !== "investigation"
          && (!certifiedFrontierHash || authored.frontierHash !== certifiedFrontierHash)) {
          throw new Error("Coding final answer does not match the certified current frontier");
        }
        return {
          coding_result: {
            status: "completed",
            finalAnswer: authored.summary,
            sourceTaskId: answerTaskId,
            sourceNodeId: source.definition.nodeId,
            sourceOutputKey: answerOutputKey,
            sourceProjectionKey: codingAcceptedOutputProjectionKey(answerOutputKey, answerTaskId),
            ...(certifiedFrontierHash ? { certifiedFrontierHash } : {}),
            outputKeys: Object.keys(outputs).sort(),
          },
        };
      }
      if (!context.definition.taskId.startsWith(finalTaskId)) {
        throw new Error(`Unknown Coding native task ${context.definition.taskId}`);
      }
      const dependencyFrontier = await readDependencyFrontier();
      const dependencyDefinitions = context.definition.dependencies.map((dependency) => {
        const record = dependencyFrontier.snapshot.tasks.find((candidate) =>
          candidate.definition.taskId === dependency.taskId);
        if (!record || record.status !== "accepted") {
          throw new Error(`Coding finalizer dependency ${dependency.taskId} is not accepted`);
        }
        return record.definition;
      });
      const pendingIntents = executionKind === "investigation"
        ? []
        : await pendingRoomControlIntents(context.definition.taskId);
      if (pendingIntents.length > 0) {
        const suffix = `-followup-${hashCanonical(
          pendingIntents.map((intent) => intent.intentId),
        ).slice(0, 10)}`;
        const cycle = mode === "fast"
          ? (() => {
              const mutationFrontiers = dependencyDefinitions.filter((definition) =>
                definition.capability === "implement");
              if (mutationFrontiers.length !== 1) {
                throw new Error(
                  `Fast Coding follow-up requires exactly one accepted mutation frontier; found ${mutationFrontiers.length}`,
                );
              }
              return fastFollowUpCycle({
                parentTaskId: context.definition.taskId,
                intents: pendingIntents,
                suffix,
                frontierTaskId: mutationFrontiers[0]!.taskId,
              });
            })()
          : dynamicRemediationCycle({
              parentTaskId: context.definition.taskId,
              intents: pendingIntents,
              suffix,
              skipRemediation: false,
              frontierDependencies: dependencyDefinitions.map((definition) => ({
                taskId: definition.taskId,
                condition: "accepted" as const,
              })),
            });
        const expansionKey = `coding-followup-${hashCanonical({
          parentTaskId: context.definition.taskId,
          intents: pendingIntents.map((intent) => intent.intentId),
          definitions: cycle.definitions.map((definition) => definition.definitionHash),
        }).slice(0, 28)}`;
        await context.expand({
          expansionKey,
          definitions: cycle.definitions,
          continuationTaskId: cycle.continuation.taskId,
        });
        await consumeRoomControlIntents(
          context.definition.taskId,
          expansionKey,
          pendingIntents,
        );
        return undefined;
      }
      const { snapshot, outputs, projection } = dependencyFrontier;
      const certificationKeys = blueprint.tasks
        .flatMap((task) => task.provides)
        .filter((key) => key.startsWith("collaboration_endorsement_"));
      const validationReportKey = blueprint.tasks.some((task) =>
        task.provides.includes(REPOSITORY_VALIDATION_REPORT))
        ? REPOSITORY_VALIDATION_REPORT
        : undefined;
      const completion = executionKind === "investigation"
        ? evaluateCodingInvestigationCompletion(outputs)
        : mode === "fast"
          ? evaluateFastCodingCompletion(outputs)
        : evaluateCodingConsensus(
            outputs,
            certificationKeys,
            validationReportKey,
            blueprint.tasks.some((task) => task.capability === "resolve") || Boolean(humanResolution),
          );
      if (!completion.done) {
        throw new Error(completion.blocked ?? "Coding completion policy rejected the accepted frontier");
      }
      if (executionKind === "investigation") {
        const answerTaskId = "synthesize-investigation";
        const answerOutputKey = "final_report";
        const encodedAnswer = codingAcceptedOutputForTask(
          projection,
          answerTaskId,
          answerOutputKey,
        );
        const authored = codingAuthoredFinalAnswer(encodedAnswer, executionKind);
        const source = snapshot.tasks.find((record) =>
          record.definition.taskId === answerTaskId && record.status === "accepted");
        if (!source) throw new Error("Coding investigation final answer source is not accepted");
        return {
          coding_result: {
            status: "completed",
            finalAnswer: authored.summary,
            sourceTaskId: answerTaskId,
            sourceNodeId: source.definition.nodeId,
            sourceOutputKey: answerOutputKey,
            sourceProjectionKey: codingAcceptedOutputProjectionKey(answerOutputKey, answerTaskId),
            outputKeys: Object.keys(outputs).sort(),
          },
        };
      }
      const suffix = context.definition.taskId.slice(finalTaskId.length);
      const cycle = finalAnswerCycle({
        parentTaskId: context.definition.taskId,
        dependencies: dependencyDefinitions,
        suffix,
      });
      const expansionKey = `coding-final-answer-${hashCanonical({
        parentTaskId: context.definition.taskId,
        definitions: cycle.definitions.map((definition) => definition.definitionHash),
      }).slice(0, 28)}`;
      await context.expand({
        expansionKey,
        definitions: cycle.definitions,
        continuationTaskId: cycle.continuation.taskId,
      });
      return undefined;
    },
    ...(options.signal ? { signal: options.signal } : {}),
    onSnapshot: async (snapshot) => {
      settleCodingRoomUpdateTasks(options.roomUpdates, options.runId, snapshot);
      await options.onGraphSnapshot?.(snapshot);
    },
  });
  const workspaceWorkerRoot = options.workingDirectory && await stat(options.workingDirectory)
    .then((metadata) => metadata.isDirectory() ? options.workingDirectory : undefined)
    .catch(() => undefined);
  const disposeProviders: Array<() => void> = [];
  try {
    if (options.memoryRepository) {
      disposeProviders.push(bindRosterMemoryFunctionProviders({
        directory: execution.functions,
        repository: options.memoryRepository,
      }));
    }
    if (workspaceWorkerRoot) {
      disposeProviders.push(await bindCodingWorkerFunctionProviders({
        directory: execution.functions,
        workingDirectory: workspaceWorkerRoot,
        ...(options.repositoryPlacement?.commit ? {
          baselineCommit: options.repositoryPlacement.commit,
        } : {}),
        ...(options.dependencyResolution ? {
          dependencyResolution: options.dependencyResolution,
        } : {}),
        ...(options.repositoryExecutionProfile ? {
          repositoryExecutionProfile: options.repositoryExecutionProfile,
        } : {}),
        roomUpdateProvider: {
          roomUpdates: options.roomUpdates,
          recipientPolicyForTask: async (taskId, nodeId) => codingRoomUpdateRecipientPolicy(
            currentCodingRoomUpdateTasks(await execution.snapshot()),
            taskId,
            CODING_HUMAN_NODE_ID,
            nodeId,
          ),
        },
      }));
    }
    await execution.dispatchUntilQuiescent();
  } finally {
    for (const dispose of disposeProviders.reverse()) dispose();
  }
  const snapshot = await execution.snapshot();
  const acceptedFinals = snapshot.tasks.filter((record) =>
    record.status === "accepted"
    && record.definition.capability === "coordinate"
    && record.definition.result.mode !== "none"
    && record.definition.result.outputKey === "coding_result");
  if (acceptedFinals.length > 1) {
    throw new Error("Coding execution has multiple accepted final result frontiers");
  }
  let outputs: Record<string, string>;
  let completionOutputs: Record<string, string>;
  const acceptedFinal = acceptedFinals[0];
  if (acceptedFinal) {
    completionOutputs = (await acceptedCodingDependencyOutputs(
      snapshot,
      options.dataReferences,
      acceptedFinal.definition,
    )).outputs;
    const finalProjection = await projectCodingAcceptedOutputsForRoots(
      snapshot,
      options.dataReferences,
      [acceptedFinal.definition.taskId],
    );
    outputs = {
      ...codingAcceptedOutputValues(finalProjection),
      ...completionOutputs,
      coding_result: codingAcceptedOutputForTask(
        finalProjection,
        acceptedFinal.definition.taskId,
        "coding_result",
      ),
    };
  } else {
    outputs = { ...codingAcceptedOutputValues(
      await projectCodingAcceptedOutputs(snapshot, options.dataReferences),
    ) };
    completionOutputs = outputs;
  }
  if (humanResolution) {
    const encoded = JSON.stringify(humanResolution);
    outputs[CODING_COLLABORATION_RESOLUTION_OUTPUT] = encoded;
    completionOutputs[CODING_COLLABORATION_RESOLUTION_OUTPUT] = encoded;
  }
  const certificationKeys = blueprint.tasks
    .flatMap((task) => task.provides)
    .filter((key) => key.startsWith("collaboration_endorsement_"));
  const validationReportKey = blueprint.tasks.some((task) =>
    task.provides.includes(REPOSITORY_VALIDATION_REPORT))
    ? REPOSITORY_VALIDATION_REPORT
    : undefined;
  const completion = executionKind === "investigation"
    ? evaluateCodingInvestigationCompletion(completionOutputs)
    : mode === "fast"
      ? evaluateFastCodingCompletion(completionOutputs)
    : evaluateCodingConsensus(
        completionOutputs,
        certificationKeys,
        validationReportKey,
        blueprint.tasks.some((task) => task.capability === "resolve") || Boolean(humanResolution),
      );
  const failed = snapshot.tasks.find((record) => record.status === "failed");
  const status = failed
    ? "failed"
    : acceptedFinal && completion.done
      ? "completed"
      : "blocked";
  const sealedCompletion = acceptedFinal
    ? completion
    : { done: false, blocked: completion.blocked ?? "Coding final answer is incomplete" };
  return {
    runId: options.runId,
    platformId: platform.definition.id,
    platformVersion: platform.definition.version,
    status,
    completion: failed
      ? { done: false, blocked: failed.error ?? `Coding task ${failed.definition.taskId} failed` }
      : sealedCompletion,
    outputs,
    snapshot,
  };
};
