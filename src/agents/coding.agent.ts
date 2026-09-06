import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { createRosterHttpAccess, validRosterApiToken } from "../runtime/http-access.js";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";

import { zValidator } from "@hono/zod-validator";
import type { Context, Hono } from "hono";
import { stream } from "hono/streaming";

import type { Runtime } from "../core/runtime.js";
import { hashCanonical } from "../core/canonical.js";
import {
  DEFAULT_CODING_CONVERSATION_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "../models.js";
import type { EnqueueJobInput, JobPayload, JobQueue, QueueJob } from "../engine/runtime/job-queue.js";
import type { WorkspaceNode } from "../engine/orchestration/types.js";
import type { NodeContinuitySummary } from "../engine/workspace/node-continuity.js";
import {
  NodeRuntimeLogPendingBuffer,
  NodeRuntimeLogStore,
  type NodeRuntimeLogSource,
} from "../engine/runtime/node-runtime-log.js";
import {
  NodeRoomUpdateStore,
  type NodeRoomUpdate,
  type NodeRoomUpdateStoreEvent,
} from "../engine/runtime/node-room-updates.js";
import type { NodeRuntimeRegistry } from "../engine/runtime/node-runtime.js";
import type { DataReferenceStore } from "../engine/dataflow/data-reference-store.js";
import type { TaskGraphControl } from "../engine/orchestration/task-graph-control.js";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
} from "../engine/orchestration/task-graph.js";
import {
  createRosterRootTask,
  defineRosterPlatform,
  preserveRosterTaskContextDurability,
  ROSTER_NODE_TASK_HANDLER,
} from "../engine/platform/roster-platform.js";
import {
  type RosterPlatformExecutionOptions,
} from "../engine/platform/roster-platform.js";
import { resolveCodingCliEnvironment } from "../engine/runtime/coding-cli-environment.js";
import {
  discoverCodingMcpConfiguration,
  type CodingMcpDiscovery,
} from "../engine/runtime/coding-mcp-discovery.js";
import {
  createCodingRuntimeDiscoveryRegistry,
  type CodingRuntimeAccess,
  type CodingRuntimeDiscoveryDescriptor,
} from "../engine/runtime/coding-runtime-discovery.js";
import type { OrchestrationEvent, OrchestrationState } from "../modules/orchestration.js";
import {
  initialOrchestrationState,
  inlineArtifactPublishedEvent,
  orchestrationConfiguredEvent,
  orchestrationOutputValues,
} from "../modules/orchestration.js";
import {
  CODING_WORKSPACE_PROFILE_OUTPUT,
  CODING_WORKSPACE_CATALOG_OUTPUT_PREFIX,
  CODING_WORKSPACE_CATALOG_STREAM,
  DEFAULT_CODING_WORKSPACE_CODEX_MODEL,
  DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL,
  DEFAULT_CODING_WORKSPACE_HERMES_MODEL,
  DEFAULT_CODING_WORKSPACE_PI_MODEL,
  DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME,
  codingWorkspaceSettings,
  codingWorkspaceSettingsOutputKey,
  codingWorkspaceNodePreference,
  codingWorkspaceSelectedModel,
  CODING_HUMAN_NODE_ID,
  codingRepositoryWorkspace,
  codingRepositoryWorkspaceRevision,
  parseCodingRepositoryWorkspace,
  parseCodingWorkspaceSettings,
  codingWorkspaceNodesFromState,
  codingWorkspacePack,
  inspectCodingWorkspace,
  parseCodingWorkspaceProfile,
  prepareCodingWorkspaceProfileForPublication,
  type CodingWorkspaceProfile,
  type CodingWorkspaceClaudeModel,
  type CodingWorkspaceCodexModel,
  type CodingWorkspaceHermesModel,
  type CodingWorkspacePiModel,
  type CodingWorkspaceWorkerModel,
  type CodingWorkspaceNodePreference,
  type CodingRepositoryWorkspace,
  type CodingWorkspaceSettings,
  type CodingWorkspaceWorkerRuntime,
} from "../domains/coding-workspace.js";
import {
  createCodingWorkerExecution,
  parseCodingWorkerExecution,
  type CodingWorkerExecution,
  type CodingWorkerSelectionSource,
} from "../domains/coding-execution.js";
import {
  CODING_ROOM_REACTION_EMOJIS,
  CODING_ROOM_REACTION_KIND,
  codingDeliveryDispositionEvent,
  codingDeliveryDispositionFromEvents,
  codingRepositoryRoomId,
  codingRoomProjection,
  codingRoomReactionEvent,
  createCodingDeliveryDisposition,
  createCodingRoomReaction,
  type CodingDeliveryDisposition,
  type CodingRoomDirectory,
  type CodingRoomReactionEmoji,
} from "../domains/coding-room.js";
import {
  createCodingWorkspaceDiscoveryExecution,
  enrichCodingWorkspaceProfile,
  piCodingWorkspaceAgentReviewer,
  type CodingWorkspaceAgentReviewer,
} from "../domains/coding-workspace-enrichment.js";
import {
  modelCodingWorkspaceToolchainOnboarder,
  onboardCodingWorkspaceToolchain,
  type CodingWorkspaceToolchainOnboarder,
} from "../domains/coding-workspace-toolchain.js";
import {
  CODING_COLLABORATION_RESOLUTION_OUTPUT,
  codingCollaborationStatus,
  parseCodingPeerResolution,
  resolveCodingPeerAmbiguityWithHumanAnswer,
  type CodingPeerResolution,
} from "../domains/coding-collaboration.js";
import {
  codingAcceptedOutputSharedArtifactId,
  codingAcceptedOutputValues,
  validateCodingAcceptedOutputProjection,
  type CodingAcceptedOutputProjection,
} from "../domains/coding-accepted-outputs.js";
import {
  MAX_CODING_CONVERSATION_IMAGES,
  CODING_CONVERSATION_MESSAGE_KIND,
  CODING_CONVERSATION_ROUTE_KIND,
  codingConversationFromEvents,
  codingConversationImageEvent,
  codingConversationMentionedNodeIds,
  codingConversationMessageEvent,
  codingConversationObjective,
  codingConversationRouteEvent,
  createCodingConversationImage,
  createCodingConversationMessage,
  createCodingConversationRoute as createConversationRouteDecision,
  modelCodingConversationAnswerer,
  modelCodingConversationPlanner,
  parseCodingConversationCoordination,
  validateCodingConversationPlannerResult,
  type CodingConversationAnswerer,
  type CodingConversationActiveRunContext,
  type CodingConversationCollaborationContext,
  type CodingConversationCoordination,
  type CodingConversationImage,
  type CodingConversationMessage,
  type CodingConversationPlanner,
  type CodingConversationProductContext,
  type CodingConversationRepositoryContext,
  type CodingConversationRoute,
  type CodingConversationSource,
} from "../domains/coding-conversation.js";
import {
  codingConversationRuntimeFailureClass,
  localRuntimeCodingConversationPlanner,
} from "../domains/coding-conversation-runtime.js";
import {
  codingControlDeliveryAttemptsFromEvents,
  codingControlDeliveriesFromEvents,
  isCodingControlDeliveryEvent,
  pendingCodingControlMessages,
} from "../domains/coding-control-ingress.js";
import {
  CodingReviewedSelectionUnavailableError,
  codingReviewMode,
  parseRepositoryValidationReport,
  resolveCodingReviewedSelection,
  type CodingReviewerRuntime,
  type CodingWorkerRuntime,
} from "../domains/coding.js";
import {
  codingImprovementRuntimeIdentity,
  emptyCodingImprovementRuntimePin,
  parseCodingImprovementRuntimePin,
  type CodingImprovementRuntimePin,
} from "../domains/coding-improvements.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import { html, text } from "../framework/http.js";
import { codingRunFormSchema, codingWorkspaceSettingsFormSchema } from "../framework/schemas.js";
import { resolveRosterServerSurface } from "../runtime/server-surface.js";
import {
  gitBranchExists,
  gitRunBranchExists,
  gitRunBranchName,
  gitRunDetachedSourceIntegrationStatus,
  gitRunIntegrationStatus,
  gitRoomBranchName,
  gitRunWorkspaceExists,
  gitRunWorkspacePaths,
  integrateGitRunBranch,
  readGitRunPatch,
  type GitRunIntegrationStatus,
} from "../engine/runtime/git-run-workspace.js";
import {
  codingCollaborationRecordFilename,
  renderCodingCollaborationRecord,
} from "../views/coding-collaboration-record.js";
import {
  codingInvestigationReportFilename,
  parseCodingInvestigationReport,
  renderCodingInvestigationReport,
} from "../views/coding-investigation-report.js";
import {
  DEFAULT_CODING_WORKER_RUNTIME_OPTIONS,
  codingReviewShell,
  codingShell,
  type CodingAttentionItem,
  type CodingDemoJob,
  type CodingRepositoryGitState,
  type CodingReviewDiff,
  type CodingRealtimeConfig,
  type CodingWorkerRuntimeOption,
} from "../views/coding.js";

export type CodingAgentCommand = {
  readonly type: "emit";
  readonly eventId: string;
  readonly expectedPrev?: string;
  readonly event: OrchestrationEvent;
};

export type CodingAgentRuntime = Runtime<CodingAgentCommand, OrchestrationEvent, OrchestrationState>;

export type CodingRealtimeSessionGrant = {
  readonly capabilitySecret: string;
  readonly capabilityId: string;
  readonly expiresAt: number;
  readonly uri: string;
  readonly database: string;
  readonly confirmedReads: boolean;
};

export type CodingRealtimeSessionScope = {
  /** Exact repository workspace selected by the Coding job. */
  readonly workspaceId: string;
  readonly controlWorkspaceId: string;
  readonly roomId: string;
  readonly conversationId: string;
  readonly jobId: string;
  readonly executionId: string;
};

export type CodingRouteDeps = {
  readonly runtime: CodingAgentRuntime;
  readonly queue: AgentLoaderContext["queue"];
  readonly rooms: CodingRoomDirectory;
  readonly conversationPlanner?: CodingConversationPlanner;
  readonly conversationAnswerer?: CodingConversationAnswerer;
  readonly conversationModel?: string;
  readonly conversationProductContext?: CodingConversationProductContext;
  readonly showGlobalNavigation?: boolean;
  readonly workspaceReviewer?: CodingWorkspaceAgentReviewer;
  readonly workspaceToolchainOnboarder?: CodingWorkspaceToolchainOnboarder;
  readonly repositoryContext?: (repositoryRoot?: string) => Promise<CodingConversationRepositoryContext>;
  readonly integrationStatus?: typeof gitRunIntegrationStatus;
  readonly integrateRun?: typeof integrateGitRunBranch;
  readonly runBranchExists?: typeof gitRunBranchExists;
  readonly branchExists?: typeof gitBranchExists;
  /** Authoritative, caller-scoped projection of accepted durable task outputs. */
  readonly acceptedOutputs?: (runId: string) => Promise<CodingAcceptedOutputProjection>;
  /** Exact active framework snapshot captured before each newly admitted execution. */
  readonly activeImprovementSnapshot?: () => CodingImprovementRuntimePin;
  readonly runtimeLogs?: NodeRuntimeLogSource;
  /** Isolated process-local room updates; production uses codingRoomUpdates. */
  readonly roomUpdates?: NodeRoomUpdateStore;
  /** Safe, non-secret runtime cards used by desktop onboarding. */
  readonly runtimeDiscovery?: (repositoryRoot?: string) => Promise<ReadonlyArray<CodingRuntimeOnboardingOption>>;
  readonly runtimeOptions?: () => Promise<ReadonlyArray<CodingWorkerRuntimeOption>>;
  /** Testable enqueue-time environment used to snapshot non-secret worker configuration. */
  readonly workerExecutionEnvironment?: NodeJS.ProcessEnv;
  /** Desktop-selected local runtime used until a workspace preference is saved. */
  readonly defaultWorkerRuntime?: CodingWorkerRuntime;
  readonly realtime?: Omit<CodingRealtimeConfig, "activeRunId">;
  /** Mints one short-lived exact-run viewer grant after HTTP authentication. */
  readonly realtimeSession?: (scope: CodingRealtimeSessionScope) => Promise<CodingRealtimeSessionGrant>;
  /** Host clock for expiring and rotating exact page-session authority. */
  readonly pageSessionNow?: () => number;
  readonly roomControl?: {
    readonly queueIntent: (input: {
      readonly roomId: string;
      readonly intentId: string;
      readonly kind: "follow_up" | "steer";
      readonly payloadJson: string;
    }) => Promise<void>;
  };
  readonly continuity?: {
    readonly queue: JobQueue;
    readonly enqueue: (input: {
      readonly nodes: ReadonlyArray<WorkspaceNode>;
      readonly primaryNodeId: string;
      readonly deliveryId: string;
      readonly sourceId: string;
      readonly sourceVersion: string;
      readonly sourceHash: string;
      readonly payload: JobPayload;
      readonly deliveredAt: number;
    }) => Promise<QueueJob | undefined>;
    readonly summaries: (
      nodeIds: ReadonlyArray<string>,
    ) => Promise<Readonly<Record<string, NodeContinuitySummary>>>;
  };
};

const CODING_WORKER_RUNTIMES = new Set<CodingWorkerRuntime>([
  "codex-cli",
  "claude-code",
  "pi-agent",
  "hermes-agent",
]);

export const codingUsesLocalRuntimesOnly = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => env.ROSTER_CODING_LOCAL_ONLY === "1";

export const codingDefaultWorkerRuntime = (
  env: NodeJS.ProcessEnv = process.env,
): CodingWorkerRuntime => {
  const candidate = env.ROSTER_CODING_DEFAULT_RUNTIME?.trim() as CodingWorkerRuntime | undefined;
  return candidate && CODING_WORKER_RUNTIMES.has(candidate)
    ? candidate
    : DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME;
};

export const codingConversationModel = (
  env: NodeJS.ProcessEnv = process.env,
): string => env.ROSTER_CODING_CONVERSATION_MODEL?.trim()
  || DEFAULT_CODING_CONVERSATION_MODEL;

export const codingLocalConversationModel = (
  runtime: CodingWorkerRuntime,
  env: NodeJS.ProcessEnv = process.env,
): string => createCodingWorkerExecution({
  runtime,
  source: "product-default",
  ...(runtime === "codex-cli"
    ? { workerModel: DEFAULT_CODING_WORKSPACE_CODEX_MODEL }
    : runtime === "pi-agent"
      ? { workerModel: DEFAULT_CODING_WORKSPACE_PI_MODEL }
      : {}),
  env,
}).model;

const rosterPackageProductMetadata = (): {
  readonly name?: string;
  readonly category?: string;
  readonly description?: string;
  readonly creatorLabel?: string;
  readonly creatorUrl?: string;
} => {
  try {
    const parsed = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const manifest = parsed as Readonly<Record<string, unknown>>;
    const product = manifest.rosterProduct
      && typeof manifest.rosterProduct === "object"
      && !Array.isArray(manifest.rosterProduct)
      ? manifest.rosterProduct as Readonly<Record<string, unknown>>
      : {};
    const author = manifest.author
      && typeof manifest.author === "object"
      && !Array.isArray(manifest.author)
      ? manifest.author as Readonly<Record<string, unknown>>
      : {};
    const value = (candidate: unknown): string | undefined =>
      typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
    return {
      ...(value(product.name) ? { name: value(product.name) } : {}),
      ...(value(product.category) ? { category: value(product.category) } : {}),
      ...(value(manifest.description) ? { description: value(manifest.description) } : {}),
      ...(value(author.name) ? { creatorLabel: value(author.name) } : {}),
      ...(value(author.url) ? { creatorUrl: value(author.url) } : {}),
    };
  } catch {
    return {};
  }
};

export const codingConversationProductContext = (
  env: NodeJS.ProcessEnv = process.env,
): CodingConversationProductContext => {
  const packageMetadata = rosterPackageProductMetadata();
  const creatorUrl = env.ROSTER_PRODUCT_CREATOR_URL?.trim() || packageMetadata.creatorUrl;
  const creatorLabel = env.ROSTER_PRODUCT_CREATOR_LABEL?.trim() || packageMetadata.creatorLabel;
  return {
    name: env.ROSTER_PRODUCT_NAME?.trim() || packageMetadata.name || "Roster",
    category: env.ROSTER_PRODUCT_CATEGORY?.trim()
      || packageMetadata.category
      || "multi-agent coordination workspace",
    description: env.ROSTER_PRODUCT_DESCRIPTION?.trim()
      || packageMetadata.description
      || "A shared workspace for coordinated people and agents.",
    ...(creatorLabel && creatorUrl ? {
      creator: {
        label: creatorLabel,
        url: creatorUrl,
      },
    } : {}),
  };
};

/** Shared only within this server process; never replayed as orchestration state. */
export const codingRuntimeLogs = new NodeRuntimeLogStore();
export const codingRoomUpdates = new NodeRoomUpdateStore({
  maxRuns: 32,
  maxUpdatesPerRun: 500,
});

const CODING_ROOM_UPDATE_PENDING_LIMIT = 256;
const CODING_ROOM_UPDATE_JOB_RECHECK_MS = 1_000;

const publicCodingRoomUpdate = (update: NodeRoomUpdate): NodeRoomUpdate => ({
  schema: update.schema,
  updateId: update.updateId,
  runId: update.runId,
  taskId: update.taskId,
  executionId: update.executionId,
  nodeId: update.nodeId,
  updateKey: update.updateKey,
  text: update.text,
  intent: update.intent,
  recipientNodeIds: [...update.recipientNodeIds],
  sequence: update.sequence,
  at: update.at,
  settled: update.settled,
});

const activeCodingRoomUpdateJob = (job: QueueJob): boolean =>
  job.status === "queued" || job.status === "leased" || job.status === "running";

const execFileAsync = promisify(execFile);
const CODING_API_SCHEMA = "roster.coding.v2" as const;
const CODING_API_BASE = "/api/v2/coding";
const CODING_DIFF_MAX_BYTES = 256 * 1024;
const CODING_DIRECTORY_MAX_ENTRIES = 160;
const CODING_TEAM_REFRESH_FLASH_TTL_MS = 5 * 60_000;
const CODING_TEAM_REFRESH_FLASH_LIMIT = 100;
const CODING_PAGE_SESSION_TTL_MS = 10 * 60_000;
const CODING_PAGE_SESSION_LIMIT = 200;
const CODING_PAGE_SESSION_COOKIE = "roster_coding_page";
const codingRepositoryRoot = (): string => resolve(process.cwd());
const codingRunStream = (runId: string): string => `agents/coding-agent/runs/${runId}`;
const codingDefaultWorkspace = (): CodingRepositoryWorkspace =>
  codingRepositoryWorkspace(codingRepositoryRoot());
const safeRunId = (value: string | undefined): string | undefined =>
  value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) ? value : undefined;
const safeWorkspaceId = (value: unknown): string | undefined =>
  typeof value === "string" && /^workspace_[a-f0-9]{20}$/.test(value) ? value : undefined;

type CodingTeamRefreshFlash = {
  readonly workspaceId: string;
  readonly profileStream: string;
  readonly kind: "created" | "refreshed";
  readonly createdAt: number;
};

type CodingWorkspaceSettingsFlash = {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly workerRuntime: CodingWorkspaceWorkerRuntime;
  readonly workerModel: CodingWorkspaceWorkerModel;
  readonly createdAt: number;
};

type CodingPageSession = CodingRealtimeSessionScope & {
  readonly operatorAuthority: string;
  readonly expiresAt: number;
};

const cookieValue = (header: string | undefined, name: string): string | undefined => {
  for (const field of header?.split(";") ?? []) {
    const [candidate, ...value] = field.trim().split("=");
    if (candidate === name) return value.join("=");
  }
  return undefined;
};

const codingPageSessionStore = (now: () => number = Date.now) => {
  const sessions = new Map<string, CodingPageSession>();
  const prune = (now: number): void => {
    for (const [tokenHash, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(tokenHash);
    }
    while (sessions.size >= CODING_PAGE_SESSION_LIMIT) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      sessions.delete(oldest);
    }
  };
  const issue = (scope: Omit<CodingPageSession, "expiresAt">): string => {
    const token = randomBytes(32).toString("base64url");
    const issuedAt = now();
    prune(issuedAt);
    sessions.set(createHash("sha256").update(token).digest("hex"), {
      ...scope,
      expiresAt: issuedAt + CODING_PAGE_SESSION_TTL_MS,
    });
    return token;
  };
  const read = (token: string | undefined): CodingPageSession | undefined => {
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const readAt = now();
    prune(readAt);
    const session = sessions.get(createHash("sha256").update(token).digest("hex"));
    return session && session.expiresAt > readAt ? session : undefined;
  };
  return {
    issue,
    read,
    rotate: (
      token: string | undefined,
      operatorAuthority: string,
    ): { readonly token: string; readonly expiresAt: number } | undefined => {
      const session = read(token);
      if (!session || session.operatorAuthority !== operatorAuthority) return undefined;
      sessions.delete(createHash("sha256").update(token!).digest("hex"));
      const rotatedToken = issue({
        workspaceId: session.workspaceId,
        controlWorkspaceId: session.controlWorkspaceId,
        roomId: session.roomId,
        conversationId: session.conversationId,
        jobId: session.jobId,
        executionId: session.executionId,
        operatorAuthority: session.operatorAuthority,
      });
      const rotatedSession = read(rotatedToken);
      if (!rotatedSession) return undefined;
      return { token: rotatedToken, expiresAt: rotatedSession.expiresAt };
    },
  };
};

const codingPageSessionCookie = (token: string, requestUrl: string): string =>
  `${CODING_PAGE_SESSION_COOKIE}=${token}; Path=/coding; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(CODING_PAGE_SESSION_TTL_MS / 1_000)}${new URL(requestUrl).protocol === "https:" ? "; Secure" : ""}`;

const codingTeamRefreshFlashStore = () => {
  const flashes = new Map<string, CodingTeamRefreshFlash>();
  const prune = (now: number): void => {
    for (const [token, flash] of flashes) {
      if (now - flash.createdAt > CODING_TEAM_REFRESH_FLASH_TTL_MS) flashes.delete(token);
    }
    while (flashes.size >= CODING_TEAM_REFRESH_FLASH_LIMIT) {
      const oldest = flashes.keys().next().value as string | undefined;
      if (!oldest) break;
      flashes.delete(oldest);
    }
  };
  return {
    issue: (flash: Omit<CodingTeamRefreshFlash, "createdAt">): string => {
      const now = Date.now();
      prune(now);
      for (const [token, pending] of flashes) {
        if (pending.workspaceId === flash.workspaceId) flashes.delete(token);
      }
      const token = randomBytes(24).toString("hex");
      flashes.set(token, { ...flash, createdAt: now });
      return token;
    },
    consume: (token: string | undefined, workspace: CodingRepositoryWorkspace): CodingTeamRefreshFlash | undefined => {
      if (!token || !/^[a-f0-9]{48}$/.test(token)) return undefined;
      const flash = flashes.get(token);
      flashes.delete(token);
      if (!flash
        || Date.now() - flash.createdAt > CODING_TEAM_REFRESH_FLASH_TTL_MS
        || flash.workspaceId !== workspace.id
        || flash.profileStream !== workspace.profileStream) return undefined;
      return flash;
    },
  };
};

const codingWorkspaceSettingsFlashStore = () => {
  const flashes = new Map<string, CodingWorkspaceSettingsFlash>();
  const prune = (now: number): void => {
    for (const [token, flash] of flashes) {
      if (now - flash.createdAt > CODING_TEAM_REFRESH_FLASH_TTL_MS) flashes.delete(token);
    }
    while (flashes.size >= CODING_TEAM_REFRESH_FLASH_LIMIT) {
      const oldest = flashes.keys().next().value as string | undefined;
      if (!oldest) break;
      flashes.delete(oldest);
    }
  };
  return {
    issue: (flash: Omit<CodingWorkspaceSettingsFlash, "createdAt">): string => {
      const now = Date.now();
      prune(now);
      for (const [token, pending] of flashes) {
        if (pending.workspaceId === flash.workspaceId) flashes.delete(token);
      }
      const token = randomBytes(24).toString("hex");
      flashes.set(token, { ...flash, createdAt: now });
      return token;
    },
    consume: (token: string | undefined, workspaceId: string): CodingWorkspaceSettingsFlash | undefined => {
      if (!token || !/^[a-f0-9]{48}$/.test(token)) return undefined;
      const flash = flashes.get(token);
      flashes.delete(token);
      if (!flash
        || Date.now() - flash.createdAt > CODING_TEAM_REFRESH_FLASH_TTL_MS
        || flash.workspaceId !== workspaceId) return undefined;
      return flash;
    },
  };
};

const codingTeamRefreshDestination = (input: {
  readonly workspaceId: string;
  readonly token: string;
  readonly returnTo?: string;
  readonly selectedAgent?: string;
}): string => {
  const params = new URLSearchParams({ workspace: input.workspaceId, teamRefresh: input.token });
  if (input.returnTo && input.returnTo.length <= 4_096) {
    try {
      const candidate = new URL(input.returnTo, "http://roster.local");
      if (candidate.origin === "http://roster.local"
        && candidate.pathname === "/coding"
        && candidate.searchParams.get("workspace") === input.workspaceId) {
        const runId = safeRunId(candidate.searchParams.get("run") ?? undefined);
        const jobId = safeRunId(candidate.searchParams.get("job") ?? undefined);
        if (runId) params.set("run", runId);
        if (jobId) params.set("job", jobId);
      }
    } catch {
      // A malformed optional return target cannot invalidate a completed scan.
    }
  }
  if (input.selectedAgent
    && params.has("run")
    && /^coding-agent-detail-[a-z0-9_-]{1,200}$/.test(input.selectedAgent)) {
    params.set("selectedAgent", input.selectedAgent);
  }
  return `/coding?${params.toString()}`;
};

const codingTrackedRunDestination = (workspaceId: string, runId: string, jobId: string): string =>
  `/coding?workspace=${encodeURIComponent(workspaceId)}&run=${encodeURIComponent(runId)}&job=${encodeURIComponent(jobId)}`;

type CodingJobSelector =
  | { readonly valid: true; readonly jobId?: string }
  | { readonly valid: false };

const codingJobSelector = (context: Context): CodingJobSelector => {
  const values = new URL(context.req.url).searchParams.getAll("job");
  if (values.length === 0) return { valid: true };
  if (values.length !== 1) return { valid: false };
  const jobId = safeRunId(values[0]);
  return jobId ? { valid: true, jobId } : { valid: false };
};

const newCodingConversationId = (): string =>
  `coding_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export type CodingRuntimeOnboardingOption = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly source: "builtin" | "manifest";
  readonly available: boolean;
  readonly ready: boolean;
  readonly readiness: "ready" | "probe-failed" | "not-installed";
  readonly version?: string;
  readonly access: ReadonlyArray<CodingRuntimeAccess>;
  readonly mcp: CodingMcpDiscovery;
};

const desktopEnabledRuntimeIds = (
  env: NodeJS.ProcessEnv,
): ReadonlySet<string> | undefined => {
  const value = env.ROSTER_DESKTOP_RUNTIME_PROFILES?.trim();
  if (!value) return undefined;
  try {
    const profiles = JSON.parse(value) as unknown;
    if (!Array.isArray(profiles)) return new Set();
    return new Set(profiles.flatMap((profile) => {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) return [];
      const candidate = profile as Readonly<Record<string, unknown>>;
      return candidate.enabled === true && typeof candidate.id === "string"
        ? [candidate.id]
        : [];
    }));
  } catch {
    return new Set();
  }
};

/**
 * Returns the non-secret runtime cards consumed by desktop onboarding. It does
 * not expose process environment, credentials, command arguments, or config.
 */
export const discoverCodingRuntimeOnboardingOptions = async (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  descriptors?: ReadonlyArray<CodingRuntimeDiscoveryDescriptor>,
  repositoryRoot: string = process.cwd(),
): Promise<ReadonlyArray<CodingRuntimeOnboardingOption>> => {
  const executableEnvironment = {
    ...env,
    ...resolveCodingCliEnvironment(env, platform),
  };
  const discovered = await createCodingRuntimeDiscoveryRegistry(descriptors).discover(
    executableEnvironment,
    platform,
  );
  const desktopRuntimeIds = desktopEnabledRuntimeIds(env);
  const selected = discovered
    .filter((runtime) => desktopRuntimeIds === undefined || desktopRuntimeIds.has(runtime.descriptor.id));
  return Promise.all(selected.map(async (runtime) => ({
    id: runtime.descriptor.id,
    label: runtime.descriptor.label,
    detail: runtime.descriptor.detail,
    source: runtime.descriptor.source,
    available: runtime.available,
    ready: runtime.ready,
    readiness: runtime.readiness,
    ...(runtime.version ? { version: runtime.version } : {}),
    access: [...runtime.descriptor.access],
    mcp: await discoverCodingMcpConfiguration({
      runtimeId: runtime.descriptor.id,
      runtimeAvailable: runtime.available,
      ...(runtime.executablePath ? { executablePath: runtime.executablePath } : {}),
      env: executableEnvironment,
      workingDirectory: repositoryRoot,
    }),
  })));
};

const runtimeOptionsFromDiscovery = (
  discovered: ReadonlyArray<CodingRuntimeOnboardingOption>,
): ReadonlyArray<CodingWorkerRuntimeOption> => {
  const available = new Map(discovered
    .filter((runtime) => runtime.available)
    .map((runtime) => [runtime.id, runtime]));
  return DEFAULT_CODING_WORKER_RUNTIME_OPTIONS.flatMap((option) => {
    const runtime = available.get(option.value);
    return runtime ? [{ ...option, mcp: runtime.mcp }] : [];
  });
};

/** Projects only coding runtimes that this server process can execute locally. */
export const discoverCodingWorkerRuntimeOptions = async (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  descriptors?: ReadonlyArray<CodingRuntimeDiscoveryDescriptor>,
  repositoryRoot: string = process.cwd(),
): Promise<ReadonlyArray<CodingWorkerRuntimeOption>> => {
  const discovered = await discoverCodingRuntimeOnboardingOptions(env, platform, descriptors, repositoryRoot);
  return runtimeOptionsFromDiscovery(discovered);
};

const availableCodingWorkerRuntimeOptions = async (
  deps: CodingRouteDeps,
  repositoryRoot?: string,
): Promise<ReadonlyArray<CodingWorkerRuntimeOption>> => {
  if (deps.runtimeOptions) return deps.runtimeOptions();
  if (!deps.runtimeDiscovery) {
    return discoverCodingWorkerRuntimeOptions(
      process.env,
      process.platform,
      undefined,
      repositoryRoot,
    );
  }
  const discovered = await deps.runtimeDiscovery(repositoryRoot);
  return runtimeOptionsFromDiscovery(discovered);
};

const preferredCodingReviewerRuntime = async (deps: CodingRouteDeps): Promise<CodingReviewerRuntime> => {
  const available = await availableCodingWorkerRuntimeOptions(deps);
  return available.some((runtime) => runtime.value === "codex-cli") ? "codex-cli" : "claude-code";
};

const readCodingWorkspaceCatalog = async (
  runtime: CodingAgentRuntime,
): Promise<ReadonlyArray<CodingRepositoryWorkspace>> => {
  const fallback = codingDefaultWorkspace();
  try {
    const values = orchestrationOutputValues(await runtime.state(CODING_WORKSPACE_CATALOG_STREAM));
    const saved = Object.entries(values)
      .filter(([key]) => key.startsWith(CODING_WORKSPACE_CATALOG_OUTPUT_PREFIX))
      .flatMap(([, value]) => {
        const entry = parseCodingRepositoryWorkspace(value);
        return entry ? [entry] : [];
      });
    const savedFallback = saved.find((entry) => entry.id === fallback.id);
    return [savedFallback ?? fallback, ...saved.filter((entry) => entry.id !== fallback.id)]
      .sort((left, right) => left.id === fallback.id ? -1 : right.id === fallback.id ? 1 : left.repositoryRoot.localeCompare(right.repositoryRoot));
  } catch {
    return [fallback];
  }
};

const resolveCodingWorkspace = async (
  runtime: CodingAgentRuntime,
  requestedId?: string,
): Promise<CodingRepositoryWorkspace | undefined> => {
  const workspaces = await readCodingWorkspaceCatalog(runtime);
  return requestedId ? workspaces.find((workspace) => workspace.id === requestedId) : workspaces[0];
};

const readCodingWorkspaceSettings = async (
  runtime: CodingAgentRuntime,
  workspaceId: string,
): Promise<CodingWorkspaceSettings | undefined> => {
  try {
    const values = orchestrationOutputValues(await runtime.state(CODING_WORKSPACE_CATALOG_STREAM));
    return parseCodingWorkspaceSettings(values[codingWorkspaceSettingsOutputKey(workspaceId)], workspaceId);
  } catch {
    return undefined;
  }
};

const saveCodingWorkspaceSettings = async (
  runtime: CodingAgentRuntime,
  workspaceId: string,
  nodeId: string,
  workerRuntime: CodingWorkspaceWorkerRuntime,
  models: {
    readonly codexModel: CodingWorkspaceCodexModel;
    readonly piModel: CodingWorkspacePiModel;
    readonly claudeModel: CodingWorkspaceClaudeModel;
    readonly hermesModel: CodingWorkspaceHermesModel;
  },
  allowedNodeIds: ReadonlySet<string>,
): Promise<CodingWorkspaceSettings> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const chain = await runtime.chain(CODING_WORKSPACE_CATALOG_STREAM);
    const expectedPrev = chain.at(-1)?.hash ?? "";
    const current = await readCodingWorkspaceSettings(runtime, workspaceId);
    const fallback = current ?? codingWorkspaceSettings(
      workspaceId,
      DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME,
      1,
      {
        codexModel: DEFAULT_CODING_WORKSPACE_CODEX_MODEL,
        piModel: DEFAULT_CODING_WORKSPACE_PI_MODEL,
        claudeModel: DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL,
        hermesModel: DEFAULT_CODING_WORKSPACE_HERMES_MODEL,
      },
    );
    const nodePreference: CodingWorkspaceNodePreference = {
      nodeId,
      workerRuntime,
      codexModel: models.codexModel,
      piModel: models.piModel,
      claudeModel: models.claudeModel,
      hermesModel: models.hermesModel,
    };
    const nodePreferences = [
      ...fallback.nodePreferences.filter((preference) =>
        preference.nodeId !== nodeId && allowedNodeIds.has(preference.nodeId)),
      nodePreference,
    ].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    const workspaceDefaults = nodeId === "workspace.implementation"
      ? nodePreference
      : fallback;
    if (current?.workerRuntime === workspaceDefaults.workerRuntime
      && current.codexModel === workspaceDefaults.codexModel
      && current.piModel === workspaceDefaults.piModel
      && current.claudeModel === workspaceDefaults.claudeModel
      && current.hermesModel === workspaceDefaults.hermesModel
      && JSON.stringify(current.nodePreferences) === JSON.stringify(nodePreferences)) return current;
    const settings = codingWorkspaceSettings(
      workspaceId,
      workspaceDefaults.workerRuntime,
      (current?.revision ?? 0) + 1,
      {
        codexModel: workspaceDefaults.codexModel,
        piModel: workspaceDefaults.piModel,
        claudeModel: workspaceDefaults.claudeModel,
        hermesModel: workspaceDefaults.hermesModel,
        nodePreferences,
      },
    );
    const revision = `${settings.revision}-${hashCanonical({
      workerRuntime: settings.workerRuntime,
      codexModel: settings.codexModel,
      piModel: settings.piModel,
      claudeModel: settings.claudeModel,
      hermesModel: settings.hermesModel,
      nodePreferences: settings.nodePreferences,
    }).slice(0, 12)}`;
    try {
      await runtime.execute(CODING_WORKSPACE_CATALOG_STREAM, {
        type: "emit",
        eventId: `coding-workspace-settings-saved:${workspaceId}:${revision}`,
        expectedPrev,
        event: inlineArtifactPublishedEvent({
          runId: "coding-workspaces",
          artifactId: `coding-workspace-settings-${workspaceId}-${revision}`,
          origin: "input",
          outputKey: codingWorkspaceSettingsOutputKey(workspaceId),
          nodeId: "coordinator",
          kind: "coding.workspace-settings",
          inputVersions: {},
        }, JSON.stringify(settings)),
      });
      return settings;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Expected prev hash")) throw error;
    }
  }
  throw new Error("Workspace settings changed too frequently; retry the save.");
};

const resolveCodingWorkerSelection = async (
  runtime: CodingAgentRuntime,
  workspaceId: string,
  options: {
    readonly nodeId?: string;
    readonly override?: CodingWorkerRuntime;
    readonly defaultRuntime?: CodingWorkerRuntime;
  } = {},
): Promise<{
  readonly workerRuntime: CodingWorkerRuntime;
  readonly workerModel?: CodingWorkspaceWorkerModel;
  readonly selectionSource: CodingWorkerSelectionSource;
}> => {
  const settings = await readCodingWorkspaceSettings(runtime, workspaceId);
  const productDefault = options.defaultRuntime ?? DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME;
  const settingsDefault = productDefault;
  const normalized = settings ?? codingWorkspaceSettings(
    workspaceId,
    settingsDefault,
    1,
    {
      codexModel: DEFAULT_CODING_WORKSPACE_CODEX_MODEL,
      piModel: DEFAULT_CODING_WORKSPACE_PI_MODEL,
      claudeModel: DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL,
      hermesModel: DEFAULT_CODING_WORKSPACE_HERMES_MODEL,
    },
  );
  const nodePreference = options.nodeId
    ? codingWorkspaceNodePreference(normalized, options.nodeId)
    : normalized;
  const workerRuntime = options.override
    ?? (settings ? nodePreference.workerRuntime : productDefault);
  const selectionSource: CodingWorkerSelectionSource = options.override
    ? "api-override"
    : options.nodeId && settings?.nodePreferences.some((preference) => preference.nodeId === options.nodeId)
      ? "node-preference"
      : settings
        ? "workspace-default"
        : "product-default";
  return {
    workerRuntime,
    selectionSource,
    workerModel: workerRuntime === nodePreference.workerRuntime
      ? codingWorkspaceSelectedModel(nodePreference)
      : workerRuntime === "pi-agent"
        ? nodePreference.piModel
        : workerRuntime === "claude-code"
          ? nodePreference.claudeModel
          : workerRuntime === "hermes-agent"
            ? nodePreference.hermesModel
            : nodePreference.codexModel,
  };
};

const readCodingWorkspace = async (
  runtime: CodingAgentRuntime,
  workspace: CodingRepositoryWorkspace = codingDefaultWorkspace(),
): Promise<{ readonly state: OrchestrationState; readonly profile?: CodingWorkspaceProfile }> => {
  try {
    const state = await runtime.state(workspace.profileStream);
    const profile = parseCodingWorkspaceProfile(
      orchestrationOutputValues(state)[CODING_WORKSPACE_PROFILE_OUTPUT],
      codingWorkspaceNodesFromState(state),
    );
    return { state, ...(profile ? { profile } : {}) };
  } catch {
    return { state: initialOrchestrationState };
  }
};

const scanAndSaveCodingWorkspace = async (
  runtime: CodingAgentRuntime,
  workspace: CodingRepositoryWorkspace = codingDefaultWorkspace(),
  scannedProfile?: CodingWorkspaceProfile,
): Promise<CodingWorkspaceProfile> => {
  const existing = await readCodingWorkspace(runtime, workspace);
  if (existing.profile) return existing.profile;
  const scanned = prepareCodingWorkspaceProfileForPublication(
    scannedProfile ?? await inspectCodingWorkspace(workspace.repositoryRoot),
  );
  if (!existing.state.domain) {
    await runtime.execute(workspace.profileStream, {
      type: "emit",
      eventId: `coding-workspace-configured:${workspace.id}:${scanned.fingerprint}`,
      event: orchestrationConfiguredEvent(workspace.id, codingWorkspacePack(scanned)),
    });
  }
  const current = await runtime.state(workspace.profileStream);
  const nodes = codingWorkspaceNodesFromState(current);
  const { nodes: _scannedNodes, ...review } = scanned;
  await runtime.execute(workspace.profileStream, {
    type: "emit",
    eventId: `coding-workspace-profile:${workspace.id}:${scanned.fingerprint}`,
    event: inlineArtifactPublishedEvent({
      runId: workspace.id,
      artifactId: `workspace-profile-${scanned.fingerprint.slice(0, 24)}`,
      origin: "input",
      outputKey: CODING_WORKSPACE_PROFILE_OUTPUT,
      nodeId: current.domain?.coordinatorId ?? "coordinator",
      kind: "coding.workspace-profile",
      inputVersions: {},
    }, JSON.stringify(review)),
  });
  const saved = parseCodingWorkspaceProfile(
    orchestrationOutputValues(await runtime.state(workspace.profileStream))[CODING_WORKSPACE_PROFILE_OUTPUT],
    nodes,
  );
  if (!saved) throw new Error("Saved coding workspace profile could not be replayed");
  return saved;
};

const canonicalGitRepository = async (repositoryPath: string): Promise<string> => {
  if (!isAbsolute(repositoryPath)) throw new Error("Enter an absolute Git repository root.");
  const requested = await realpath(resolve(repositoryPath));
  const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: requested,
    timeout: 3_000,
    maxBuffer: 32_768,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const topLevel = await realpath(result.stdout.trim());
  if (requested !== topLevel) throw new Error("Choose the Git repository root, not a subdirectory.");
  return topLevel;
};

type CodingDirectoryEntry = {
  readonly name: string;
  readonly path: string;
  readonly gitRepository: boolean;
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const hasGitRepositoryMarker = async (path: string): Promise<boolean> => {
  try {
    await lstat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
};

const codingDirectoryLocations = async (): Promise<ReadonlyArray<{
  readonly label: string;
  readonly path: string;
}>> => {
  const candidates = [
    { label: "Home", path: homedir() },
    { label: "Documents", path: join(homedir(), "Documents") },
    { label: "Roster", path: codingRepositoryRoot() },
  ];
  const available = await Promise.all(candidates.map(async (candidate) =>
    await isDirectory(candidate.path) ? { ...candidate, path: await realpath(candidate.path) } : undefined));
  return available.filter((candidate): candidate is { readonly label: string; readonly path: string } =>
    Boolean(candidate))
    .filter((candidate, index, locations) =>
      locations.findIndex((location) => location.path === candidate.path) === index);
};

const browseCodingDirectory = async (requestedPath: string): Promise<{
  readonly path: string;
  readonly name: string;
  readonly parent?: string;
  readonly gitRepository: boolean;
  readonly entries: ReadonlyArray<CodingDirectoryEntry>;
  readonly locations: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly breadcrumbs: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  readonly truncated: boolean;
}> => {
  if (!isAbsolute(requestedPath) || requestedPath.length > 4_096) {
    throw new Error("Choose an absolute folder on this machine.");
  }
  const path = await realpath(resolve(requestedPath));
  if (!await isDirectory(path)) throw new Error("Choose a folder that still exists.");
  const rows = await readdir(path, { withFileTypes: true });
  const directories = rows
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const visible = directories.slice(0, CODING_DIRECTORY_MAX_ENTRIES);
  const entries = (await Promise.all(visible.map(async (entry): Promise<CodingDirectoryEntry | undefined> => {
    const entryPath = join(path, entry.name);
    if (!entry.isDirectory() && !await isDirectory(entryPath)) return undefined;
    return {
      name: entry.name,
      path: entryPath,
      gitRepository: await hasGitRepositoryMarker(entryPath),
    };
  }))).filter((entry): entry is CodingDirectoryEntry => Boolean(entry))
    .sort((left, right) => Number(right.gitRepository) - Number(left.gitRepository)
      || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const parent = dirname(path);
  const root = parse(path).root;
  let cursor = root;
  const breadcrumbs = [
    { label: root === sep ? "Computer" : root, path: root },
    ...path.slice(root.length).split(sep).filter(Boolean).map((segment) => {
      cursor = join(cursor, segment);
      return { label: segment, path: cursor };
    }),
  ];
  return {
    path,
    name: basename(path) || path,
    ...(parent !== path ? { parent } : {}),
    gitRepository: await hasGitRepositoryMarker(path),
    entries,
    locations: await codingDirectoryLocations(),
    breadcrumbs,
    truncated: directories.length > visible.length,
  };
};

const saveCodingWorkspaceCatalogEntry = async (
  runtime: CodingAgentRuntime,
  workspace: CodingRepositoryWorkspace,
): Promise<void> => {
  const value = JSON.stringify(workspace);
  const revision = createHash("sha256").update(workspace.profileStream).digest("hex").slice(0, 24);
  await runtime.execute(CODING_WORKSPACE_CATALOG_STREAM, {
    type: "emit",
    eventId: `coding-workspace-saved:${workspace.id}:${revision}`,
    event: inlineArtifactPublishedEvent({
      runId: "coding-workspaces",
      artifactId: `coding-workspace-${workspace.id}-${revision}`,
      origin: "input",
      outputKey: `${CODING_WORKSPACE_CATALOG_OUTPUT_PREFIX}${workspace.id}`,
      nodeId: "coordinator",
      kind: "coding.workspace-entry",
      inputVersions: {},
    }, value),
  });
};

const rescanAndSaveCodingWorkspace = async (
  runtime: CodingAgentRuntime,
  workspace: CodingRepositoryWorkspace,
  reviewer?: CodingWorkspaceAgentReviewer,
  toolchainOnboarder?: CodingWorkspaceToolchainOnboarder,
  lifecycle: {
    readonly onInspected?: (profile: CodingWorkspaceProfile) => void | Promise<void>;
    readonly onNodeReview?: Parameters<typeof enrichCodingWorkspaceProfile>[0]["onNodeReview"];
    readonly onToolchainState?: Parameters<typeof onboardCodingWorkspaceToolchain>[0]["onState"];
    readonly signal?: AbortSignal;
    readonly beforePublish?: () => void | Promise<void>;
    readonly beforeSelect?: () => void | Promise<void>;
  } = {},
): Promise<{ readonly workspace: CodingRepositoryWorkspace; readonly profile: CodingWorkspaceProfile }> => {
  const assertNotAborted = (): void => {
    if (!lifecycle.signal?.aborted) return;
    throw lifecycle.signal.reason instanceof Error
      ? lifecycle.signal.reason
      : new Error("Workspace rescan was aborted");
  };
  assertNotAborted();
  const previousProfile = (await readCodingWorkspace(runtime, workspace)).profile;
  assertNotAborted();
  const scanned = await inspectCodingWorkspace(workspace.repositoryRoot);
  assertNotAborted();
  await lifecycle.onInspected?.(scanned);
  const onboarded = await onboardCodingWorkspaceToolchain({
    profile: scanned,
    ...(toolchainOnboarder ? { onboarder: toolchainOnboarder } : {}),
    ...(lifecycle.onToolchainState ? { onState: lifecycle.onToolchainState } : {}),
  });
  const enriched = await enrichCodingWorkspaceProfile({
    profile: onboarded,
    ...(reviewer ? { reviewer } : {}),
    ...(previousProfile ? { previousProfile } : {}),
    ...(lifecycle.onNodeReview ? { onNodeReview: lifecycle.onNodeReview } : {}),
    ...(lifecycle.signal ? { signal: lifecycle.signal } : {}),
  });
  assertNotAborted();
  const publishable = prepareCodingWorkspaceProfileForPublication(enriched);
  const revision = createHash("sha256").update(JSON.stringify({
    fingerprint: publishable.fingerprint,
    publicationFingerprint: publishable.publicationFingerprint,
  })).digest("hex");
  const revisionWorkspace = codingRepositoryWorkspaceRevision(workspace, revision);
  await lifecycle.beforePublish?.();
  assertNotAborted();
  const profile = await scanAndSaveCodingWorkspace(runtime, revisionWorkspace, publishable);
  await lifecycle.beforeSelect?.();
  assertNotAborted();
  await saveCodingWorkspaceCatalogEntry(runtime, revisionWorkspace);
  return { workspace: revisionWorkspace, profile };
};

export const executeCodingWorkspaceRescanJob = async (input: {
  readonly runtime: CodingAgentRuntime;
  readonly job: QueueJob;
  readonly taskGraph: TaskGraphControl;
  readonly dataReferences: DataReferenceStore;
  readonly createTaskContext: RosterPlatformExecutionOptions["createTaskContext"];
  readonly reviewer?: CodingWorkspaceAgentReviewer;
  readonly toolchainOnboarder?: CodingWorkspaceToolchainOnboarder;
  readonly assertLease?: () => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<Record<string, unknown>> => {
  const runId = typeof input.job.payload.runId === "string" ? safeRunId(input.job.payload.runId) : undefined;
  const objective = typeof input.job.payload.objective === "string" ? input.job.payload.objective.trim() : "";
  const workspace = parseCodingRepositoryWorkspace(
    typeof input.job.payload.workspace === "string" ? input.job.payload.workspace : undefined,
  );
  if (input.job.payload.kind !== "coding-agent.workspace-rescan" || !runId || !objective || !workspace) {
    throw new Error("workspace-rescan job requires a valid run, objective, and workspace snapshot");
  }
  const assertCanPublish = async (): Promise<void> => {
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Workspace rescan was aborted");
    }
    await input.assertLease?.();
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Workspace rescan was aborted");
    }
  };
  const coordinator = {
    id: "coordinator",
    name: "Roster, Workspace Rescan Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "roster-native" as const, profile: "coding.workspace-rescan" },
  };
  const platform = defineRosterPlatform({
    id: "coding-workspace-rescan",
    version: "3.0.0",
    policyVersion: "coding-workspace-rescan-v3",
    coordinatorId: coordinator.id,
    capabilities: [{
      id: "coordinate",
      description: "Inspect, enrich, persist, and select one immutable workspace revision.",
    }],
    nodes: [coordinator],
    policy: {
      maxTasks: 3,
      maxDepth: 2,
      maxFanout: 2,
      maxInflight: 1,
      maxReady: 2,
      maxBlocked: 3,
      maxAttempts: 2,
      maxContextBytes: 32 * 1_048_576,
      maxCostMicros: 0,
      maxTokens: 1,
      maxWallTimeMs: 30 * 60_000,
    },
  });
  const requestReference = await input.dataReferences.put({
    value: objective,
    mediaType: "text/plain",
    metadata: { outputKey: "request", workspaceId: workspace.id },
  }, { signal: input.signal });
  const inputVersions = { request: requestReference.contentHash };
  const topologyVersion = `workspace_rescan_topology_${hashCanonical([coordinator.id]).slice(0, 28)}`;
  const catalogVersion = `workspace_rescan_catalog_${hashCanonical(
    platform.definition.functions ?? [],
  ).slice(0, 28)}`;
  const frontierVersion = `workspace_rescan_frontier_${hashCanonical(inputVersions).slice(0, 28)}`;
  const inputs = {
    inputVersions,
    dataReferences: [requestReference],
    frontierVersion,
    topologyVersion,
    catalogVersion,
  };
  const parentTaskId = "workspace-rescan-coordinate";
  const workTaskId = "workspace-rescan-execute";
  const finalTaskId = "workspace-rescan-finalize";
  const root = createRosterRootTask({
    taskId: parentTaskId,
    semanticKey: `workspace-rescan:${runId}:coordinate`,
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: "Publish the bounded workspace rescan worker flow.",
    inputs,
    result: { mode: "none" },
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 30_000,
  });
  const work = createDynamicTaskDefinition({
    taskId: workTaskId,
    semanticKey: `workspace-rescan:${runId}:execute`,
    nodeId: coordinator.id,
    capability: "coordinate",
    objective,
    handler: ROSTER_NODE_TASK_HANDLER,
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: { mode: "json", outputKey: "workspace_rescan_work", schema: true },
    dependencies: [],
    join: { kind: "all-success" },
    inputs,
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 2, initialBackoffMs: 250, maximumBackoffMs: 2_000 },
    timeoutMs: 20 * 60_000,
    sideEffect: "idempotent",
    estimatedCostMicros: 0,
    parentTaskId,
  });
  const final = createDynamicTaskDefinition({
    taskId: finalTaskId,
    semanticKey: `workspace-rescan:${runId}:finalize`,
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: "Return the accepted immutable workspace rescan result.",
    handler: ROSTER_NODE_TASK_HANDLER,
    acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
    result: { mode: "json", outputKey: "workspace_rescan_result", schema: true },
    dependencies: [{ taskId: workTaskId, condition: "accepted" }],
    join: { kind: "all-success" },
    inputs,
    runtimeBindingEpoch: 0,
    retry: { maxAttempts: 1, initialBackoffMs: 0, maximumBackoffMs: 0 },
    timeoutMs: 30_000,
    sideEffect: "pure",
    estimatedCostMicros: 0,
    parentTaskId,
  });
  const createTaskContext = preserveRosterTaskContextDurability(
    input.createTaskContext,
    async (contextInput) => {
      await input.assertLease?.();
      return input.createTaskContext(contextInput);
    },
  );
  const execution = platform.createExecution({
    runId,
    seedTasks: [root],
    taskGraph: input.taskGraph,
    dataReferences: input.dataReferences,
    createTaskContext,
    nativeExecute: async (context) => {
      if (context.definition.taskId === parentTaskId) {
        await context.expand({
          expansionKey: `workspace-rescan-${hashCanonical({
            work: work.definitionHash,
            final: final.definitionHash,
          }).slice(0, 28)}`,
          definitions: [work, final],
          continuationTaskId: finalTaskId,
        });
        return undefined;
      }
      if (context.definition.taskId === workTaskId) {
        const saved = await rescanAndSaveCodingWorkspace(
          input.runtime,
          workspace,
          input.reviewer,
          input.toolchainOnboarder,
          {
            ...(input.signal ? { signal: input.signal } : {}),
            beforePublish: assertCanPublish,
            beforeSelect: assertCanPublish,
          },
        );
        const specialistOutcomes = saved.profile.nodes
          .filter((node) => node.metadata?.participantKind !== "human")
          .map((node) => ({
            nodeId: node.id,
            state: node.metadata?.enrichmentStatus ?? "partial",
            epoch: typeof node.metadata?.evolutionEpoch === "number"
              ? node.metadata.evolutionEpoch
              : 0,
          }));
        return {
          schema: "roster.coding.workspace-rescan-result.v1",
          runKind: "workspace-rescan",
          workspaceId: saved.workspace.id,
          inputProfileStream: workspace.profileStream,
          outputProfileStream: saved.workspace.profileStream,
          fingerprint: saved.profile.fingerprint,
          enrichmentEpoch: saved.profile.enrichmentEpoch ?? 0,
          enrichmentStatus: saved.profile.enrichmentStatus ?? "partial",
          specialistCount: specialistOutcomes.length,
          specialistOutcomes,
          toolchainOnboarding: {
            status: saved.profile.executionProfile
              ? saved.profile.executionProfile.source === "onboarded" ? "complete" : "not-required"
              : "unavailable",
            ...(saved.profile.executionProfile ? {
              profileHash: saved.profile.executionProfile.contentHash,
              source: saved.profile.executionProfile.source,
            } : {}),
          },
          conflictCount: saved.profile.dependencyConflicts?.length ?? 0,
        };
      }
      if (context.definition.taskId !== finalTaskId) {
        throw new Error(`Unknown workspace rescan task ${context.definition.taskId}`);
      }
      const reference = context.dependencyDataReferences[workTaskId]?.[0]?.reference;
      if (!reference) throw new Error("Workspace rescan worker published no accepted result reference");
      return context.readDataReference(reference, { signal: context.signal });
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  await execution.dispatchUntilQuiescent();
  const snapshot = await execution.snapshot();
  const failed = snapshot.tasks.find((record) => record.status === "failed");
  if (failed) {
    throw new Error(failed.error ?? `Workspace rescan task ${failed.definition.taskId} failed`);
  }
  const resultReference = snapshot.outcomeDataReferences.find((entry) =>
    entry.outputKey === "workspace_rescan_result");
  if (!resultReference) throw new Error("Workspace rescan produced no accepted result");
  const result = await input.dataReferences.read(resultReference.reference, { signal: input.signal });
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Workspace rescan accepted an invalid result");
  }
  return result as Record<string, unknown>;
};

const workspaceDto = (profile: CodingWorkspaceProfile) => ({
  scanned: true,
  fingerprint: profile.fingerprint,
  repositoryRoot: profile.repositoryRoot,
  fileCount: profile.fileCount,
  filesTruncated: profile.filesTruncated,
  technologies: profile.technologies,
  topLevelAreas: profile.topLevelAreas ?? [],
  areaSummaries: profile.areaSummaries ?? [],
  toolchains: profile.toolchains ?? [],
  executionProfile: profile.executionProfile ? {
    source: profile.executionProfile.source,
    contentHash: profile.executionProfile.contentHash,
    evidenceFiles: profile.executionProfile.evidenceFiles,
    installCommands: profile.executionProfile.installCommands,
    verifyCommands: profile.executionProfile.verifyCommands,
  } : null,
  reviewedAt: profile.reviewedAt,
  enrichmentVersion: profile.enrichmentVersion,
  enrichmentEpoch: profile.enrichmentEpoch,
  enrichmentStatus: profile.enrichmentStatus,
  dependencies: profile.dependencies ?? [],
  dependencyProposals: profile.dependencyProposals ?? [],
  dependencyConflicts: profile.dependencyConflicts ?? [],
  nodes: profile.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    capabilities: node.capabilities,
    runtime: node.metadata?.participantKind === "human" ? "human" : node.runtime?.kind,
    participantKind: typeof node.metadata?.participantKind === "string" ? node.metadata.participantKind : "agent",
    specialty: typeof node.metadata?.specialty === "string" ? node.metadata.specialty : undefined,
    reason: typeof node.metadata?.repositoryReason === "string" ? node.metadata.repositoryReason : undefined,
    evolutionEpoch: typeof node.metadata?.evolutionEpoch === "number" ? node.metadata.evolutionEpoch : 0,
    skills: Array.isArray(node.metadata?.specialistSkills) ? node.metadata.specialistSkills : [],
    toolRequirements: Array.isArray(node.metadata?.toolRequirements) ? node.metadata.toolRequirements : [],
    dependsOnNodeIds: Array.isArray(node.metadata?.dependsOnNodeIds) ? node.metadata.dependsOnNodeIds : [],
    dependencyConflicts: Array.isArray(node.metadata?.dependencyConflicts) ? node.metadata.dependencyConflicts : [],
  })),
});

const repositoryIdentity = async (
  repositoryRoot = codingRepositoryRoot(),
  options: { readonly includeAccount?: boolean } = {},
): Promise<CodingRepositoryGitState> => {
  const run = async (command: string, args: ReadonlyArray<string>): Promise<string | undefined> => {
    try {
      const result = await execFileAsync(command, [...args], {
        cwd: repositoryRoot,
        timeout: 1_500,
        maxBuffer: 32_768,
      });
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  };
  const [remote, branchValue, headCommit, status, upstream, account] = await Promise.all([
    run("git", ["remote", "get-url", "origin"]),
    run("git", ["branch", "--show-current"]),
    run("git", ["rev-parse", "HEAD"]),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
    run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    options.includeAccount === false ? Promise.resolve(undefined) : run("gh", ["api", "user", "--jq", ".login"]),
  ]);
  const divergence = upstream
    ? await run("git", ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
    : undefined;
  const [behind, ahead] = divergence?.split(/\s+/).map((value) => Number.parseInt(value, 10)) ?? [];
  const changedFiles = status ? status.split("\n").filter(Boolean).length : 0;
  return {
    path: repositoryRoot,
    remote: remote || "No origin configured",
    account: account || "Current HTTPS credential",
    branch: branchValue || "detached HEAD",
    headCommit: headCommit || "unknown",
    workingTree: status === undefined ? "unknown" : status ? "dirty" : "clean",
    changedFiles,
    ...(upstream ? { upstream } : {}),
    ...(Number.isFinite(ahead) ? { ahead } : {}),
    ...(Number.isFinite(behind) ? { behind } : {}),
  };
};

const codingConversationRepositoryContext = async (
  repositoryRoot = codingRepositoryRoot(),
): Promise<CodingConversationRepositoryContext> => {
  const git = async (args: ReadonlyArray<string>): Promise<string | null> => {
    try {
      const result = await execFileAsync("git", [...args], {
        cwd: repositoryRoot,
        timeout: 1_500,
        maxBuffer: 32_768,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      });
      return result.stdout.trim();
    } catch {
      return null;
    }
  };
  const [root, branch, headCommit, status] = await Promise.all([
    git(["rev-parse", "--show-toplevel"]),
    git(["branch", "--show-current"]),
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return {
    repositoryName: basename(root || repositoryRoot),
    currentBranch: branch === null ? "unknown" : branch || "detached HEAD",
    headCommit: headCommit || "unknown",
    workingTree: status === null ? "unknown" : status ? "dirty" : "clean",
  };
};

type CodingRunReplay = {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly receiptCount: number;
};

type CodingRunView = CodingRunReplay & {
  readonly eventTimestamps: ReadonlyArray<number>;
};

type CodingConversationExecutionView = CodingRunView & {
  readonly acceptedOutputProjection: CodingAcceptedOutputProjection;
};

const EMPTY_CODING_ACCEPTED_OUTPUT_PROJECTION = Object.freeze({
  outputs: Object.freeze([]),
  omittedCount: 0,
}) satisfies CodingAcceptedOutputProjection;

class CodingAcceptedOutputProjectionUnavailableError extends Error {
  constructor() {
    super("Coding accepted output projection is unavailable");
    this.name = "CodingAcceptedOutputProjectionUnavailableError";
  }
}

const readCodingAcceptedOutputs = async (
  loader: CodingRouteDeps["acceptedOutputs"],
  runId: string,
): Promise<CodingAcceptedOutputProjection> => {
  if (!loader) return { outputs: [], omittedCount: 0 };
  try {
    return validateCodingAcceptedOutputProjection(await loader(runId), runId);
  } catch {
    throw new CodingAcceptedOutputProjectionUnavailableError();
  }
};

const readRunHead = async (
  runtime: CodingAgentRuntime,
  runId: string,
): Promise<CodingRunReplay> => {
  const stream = codingRunStream(runId);
  const chain = await runtime.chain(stream);
  const state = await runtime.stateAt(stream, chain.length);
  return {
    state,
    events: chain.map((receipt) => receipt.body),
    receiptCount: chain.length,
  };
};

const readRun = async (
  runtime: CodingAgentRuntime,
  runId: string | undefined,
): Promise<CodingRunView> => {
  if (!runId) {
    return { state: initialOrchestrationState, events: [], eventTimestamps: [], receiptCount: 0 };
  }
  try {
    const chain = await runtime.chain(codingRunStream(runId));
    const state = await runtime.state(codingRunStream(runId));
    return {
      state,
      events: chain.map((receipt) => receipt.body),
      eventTimestamps: chain.map((receipt) => receipt.ts),
      receiptCount: chain.length,
    };
  } catch {
    return { state: initialOrchestrationState, events: [], eventTimestamps: [], receiptCount: 0 };
  }
};

const isCodingConversationEvent = (event: OrchestrationEvent): boolean =>
  isCodingControlDeliveryEvent(event)
  || (event.type === "artifact.published"
    && (event.kind === CODING_CONVERSATION_MESSAGE_KIND
      || event.kind === CODING_CONVERSATION_ROUTE_KIND
      || event.kind === CODING_ROOM_REACTION_KIND));

const readConversationExecution = async (
  runtime: CodingAgentRuntime,
  conversationId: string | undefined,
  executionRunId?: string,
  relatedExecutionRunIds: ReadonlyArray<string> = [],
): Promise<CodingRunView> => {
  if (!conversationId) return readRun(runtime, undefined);
  const selectedExecutionId = executionRunId ?? conversationId;
  const streamIds = [...new Set([
    conversationId,
    selectedExecutionId,
    ...relatedExecutionRunIds,
  ])];
  const views = new Map(await Promise.all(streamIds.map(async (runId) => [
    runId,
    await readRun(runtime, runId),
  ] as const)));
  const conversation = views.get(conversationId)!;
  const execution = views.get(selectedExecutionId)!;
  const entries = (
    view: CodingRunView,
    source: number,
    include: (event: OrchestrationEvent) => boolean = () => true,
  ) => view.events.flatMap((event, index) => include(event)
    ? [{ event, timestamp: view.eventTimestamps[index] ?? 0, source, index }]
    : []);
  const ordered = [
    ...(selectedExecutionId === conversationId
      ? entries(conversation, 0)
      : [
          ...entries(conversation, 0, isCodingConversationEvent),
          ...entries(execution, 1),
        ]),
    ...streamIds
      .filter((runId) => runId !== conversationId && runId !== selectedExecutionId)
      .flatMap((runId, index) => entries(views.get(runId)!, index + 2, isCodingControlDeliveryEvent)),
  ].sort((left, right) => (left.timestamp - right.timestamp)
    || (left.source - right.source)
    || (left.index - right.index));
  return {
    state: execution.state,
    events: ordered.map((entry) => entry.event),
    eventTimestamps: ordered.map((entry) => entry.timestamp),
    receiptCount: ordered.length,
  };
};

const codingReviewPolicy = (value: unknown): "auto" | "fast" | "reviewed" | undefined =>
  value === undefined || value === "auto"
    ? "auto"
    : value === "fast" || value === "reviewed"
      ? value
      : undefined;

const codingWorkerRuntime = (value: unknown): CodingWorkerRuntime | undefined =>
  value === "codex-cli" || value === "claude-code" || value === "pi-agent" || value === "hermes-agent"
    ? value
    : undefined;

const codingDependencyResolution = (value: unknown): "registry" | undefined =>
  value === "registry" ? value : undefined;

type CodingIntegrationInput = Parameters<typeof integrateGitRunBranch>[0];

const codingIntegrationInput = (job: QueueJob): CodingIntegrationInput | undefined => {
  const runId = typeof job.payload.runId === "string" ? safeRunId(job.payload.runId) : undefined;
  const expectedCommit = typeof job.result?.commit === "string" ? job.result.commit : undefined;
  const baselineBranch = typeof job.result?.baselineBranch === "string" ? job.result.baselineBranch : undefined;
  const baselineCommit = typeof job.result?.baselineCommit === "string" ? job.result.baselineCommit : undefined;
  return job.status === "completed" && job.result?.noChanges !== true
    && runId && expectedCommit && baselineBranch && baselineCommit
      ? {
        repositoryRoot: typeof job.payload.workingDirectory === "string"
          ? resolve(job.payload.workingDirectory)
          : codingRepositoryRoot(),
        runId,
        expectedCommit,
        baselineBranch,
        baselineCommit,
        ...(typeof job.payload.branch === "string" ? {
          branchName: job.payload.branch,
          keepBranch: job.payload.branch === gitRoomBranchName(codingRepositoryRoomId(codingJobConversationId(job) ?? runId)),
        } : {}),
      }
    : undefined;
};

const codingJobConversationId = (job: QueueJob): string | undefined =>
  typeof job.payload.conversationId === "string"
    ? safeRunId(job.payload.conversationId)
    : typeof job.payload.runId === "string" ? safeRunId(job.payload.runId) : undefined;

const codingJobExecutionId = (job: QueueJob): string | undefined =>
  typeof job.payload.runId === "string" ? safeRunId(job.payload.runId) : undefined;

const codingJobRoomId = (conversationId: string, job: QueueJob): string =>
  codingRoomProjection({
    conversationId,
    job: {
      id: job.id,
      status: job.status,
      ...(typeof job.payload.branch === "string" ? { branch: job.payload.branch } : {}),
      ...(typeof job.payload.objective === "string" ? { objective: job.payload.objective } : {}),
    },
    nodes: [],
  }).roomId;

const jobProjection = async (
  queue: AgentLoaderContext["queue"],
  jobId: string | undefined,
  integrationStatus: typeof gitRunIntegrationStatus = gitRunIntegrationStatus,
  expected?: { readonly runId: string; readonly workspaceId?: string },
): Promise<CodingDemoJob | undefined> => {
  if (!jobId) return undefined;
  const job = await queue.getJob(jobId);
  if (!job) return undefined;
  if (expected && (!isCodingJob(job) || codingJobConversationId(job) !== expected.runId
    || (expected.workspaceId && codingJobWorkspaceId(job) !== expected.workspaceId))) return undefined;
  const integrationInput = codingIntegrationInput(job);
  const detachedSourceIntegration = !integrationInput
    && job.agentId === "coding-agent"
    && job.payload.kind === "coding-agent.run"
    && job.payload.executionKind !== "investigation"
    && typeof job.payload.runId === "string"
    && job.status === "completed"
    && job.result?.noChanges !== true
    && typeof job.result?.commit === "string"
    && typeof job.result?.baselineBranch !== "string"
      ? gitRunDetachedSourceIntegrationStatus({
        runId: job.payload.runId,
        expectedCommit: job.result.commit,
        ...(typeof job.payload.branch === "string" ? { branchName: job.payload.branch } : {}),
      })
    : undefined;
  const integration = integrationInput
    ? await integrationStatus(integrationInput).catch((error): GitRunIntegrationStatus => ({
        runId: integrationInput.runId,
        branchName: integrationInput.branchName ?? gitRunBranchName(integrationInput.runId),
        commit: integrationInput.expectedCommit,
        integrated: false,
        canIntegrate: false,
        reason: error instanceof Error ? error.message : String(error),
      }))
    : detachedSourceIntegration;
  const managementRun = isWorkspaceRescanJob(job);
  const investigationRun = isInvestigationJob(job);
  const workerExecution = managementRun
    ? undefined
    : parseCodingWorkerExecution(job.payload.workerExecution);
  const coordination = managementRun
    ? undefined
    : parseCodingConversationCoordination(job.payload.coordination);
  if (!managementRun && !workerExecution) {
    throw new Error(`Coding job ${job.id} is missing its Roster v2 worker execution snapshot`);
  }
  const improvementRuntime = managementRun || job.payload.improvementRuntime === undefined
    ? undefined
    : parseCodingImprovementRuntimePin(job.payload.improvementRuntime);
  return {
    id: job.id,
    executionId: codingJobExecutionId(job),
    runKind: managementRun ? "workspace-rescan" : investigationRun ? "investigation" : "coding",
    readOnly: managementRun || investigationRun,
    integratable: !managementRun && !investigationRun
      && (job.status !== "completed" || typeof job.result?.baselineBranch === "string"),
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    updatedAt: job.updatedAt,
    ...(job.leaseUntil !== undefined ? { leaseUntil: job.leaseUntil } : {}),
    ...(!managementRun ? {
      reviewPolicy: codingReviewPolicy(job.payload.reviewPolicy) ?? "auto",
      ...(coordination ? { coordination } : {}),
      workerRuntime: workerExecution!.runtime,
      workerModel: workerExecution!.model,
      workerSelectionSource: workerExecution!.source,
      ...(workerExecution!.runtime === "pi-agent" ? {
        workerProvider: workerExecution!.pi.provider,
        workerPackages: workerExecution!.pi.extensionPackages,
      } : {}),
      improvement: improvementRuntime
        ? codingImprovementRuntimeIdentity(improvementRuntime)
        : null,
    } : {}),
    ...(typeof job.payload.objective === "string" ? { objective: job.payload.objective } : {}),
    ...(typeof job.payload.branch === "string" ? { branch: job.payload.branch } : {}),
    ...(typeof job.result?.commit === "string" ? { commit: job.result.commit } : {}),
    ...(typeof job.result?.baselineBranch === "string" ? { baselineBranch: job.result.baselineBranch } : {}),
    ...(typeof job.result?.baselineCommit === "string" ? { baselineCommit: job.result.baselineCommit } : {}),
    ...(typeof job.result?.sourceCheckoutDirty === "boolean" ? { sourceCheckoutDirty: job.result.sourceCheckoutDirty } : {}),
    ...(typeof job.result?.noChanges === "boolean" ? { noChanges: job.result.noChanges } : {}),
    ...(job.result?.gitOutcome === "committed" || job.result?.gitOutcome === "no_changes"
      ? { gitOutcome: job.result.gitOutcome as "committed" | "no_changes" }
      : {}),
    ...(integration ? { integration } : {}),
    ...(job.lastError || job.canceledReason ? { error: job.lastError ?? job.canceledReason } : {}),
  };
};

const jobWithDeliveryDisposition = (
  job: CodingDemoJob | undefined,
  events: ReadonlyArray<OrchestrationEvent>,
): CodingDemoJob | undefined => {
  if (!job) return undefined;
  const disposition = codingDeliveryDispositionFromEvents(events);
  if (!disposition
    || disposition.jobId !== job.id
    || disposition.branch !== job.branch
    || disposition.commit !== job.commit) return job;
  return { ...job, deliveryDisposition: disposition };
};

const isCodingJob = (job: QueueJob): boolean =>
  job.agentId === "coding-agent"
  && (job.payload.kind === "coding-agent.run" || job.payload.kind === "coding-agent.workspace-rescan")
  && typeof job.payload.runId === "string";

const isWorkspaceRescanJob = (job: QueueJob): boolean =>
  job.agentId === "coding-agent"
  && job.payload.kind === "coding-agent.workspace-rescan"
  && typeof job.payload.runId === "string";

const isInvestigationJob = (job: QueueJob): boolean =>
  job.agentId === "coding-agent"
  && job.payload.kind === "coding-agent.run"
  && job.payload.executionKind === "investigation"
  && typeof job.payload.runId === "string";

const codingJobDto = (job: QueueJob) => {
  const managementRun = isWorkspaceRescanJob(job);
  const investigationRun = isInvestigationJob(job);
  const workerExecution = managementRun
    ? undefined
    : parseCodingWorkerExecution(job.payload.workerExecution);
  const coordination = managementRun
    ? undefined
    : parseCodingConversationCoordination(job.payload.coordination);
  if (!managementRun && !workerExecution) {
    throw new Error(`Coding job ${job.id} is missing its Roster v2 worker execution snapshot`);
  }
  const improvementRuntime = managementRun || job.payload.improvementRuntime === undefined
    ? undefined
    : parseCodingImprovementRuntimePin(job.payload.improvementRuntime);
  return {
    id: job.id,
    runKind: managementRun ? "workspace-rescan" as const : investigationRun ? "investigation" as const : "coding" as const,
    capabilities: {
      readOnly: managementRun || investigationRun,
      integratable: !managementRun && !investigationRun
        && (job.status !== "completed" || typeof job.result?.baselineBranch === "string"),
    },
    runId: job.payload.runId as string,
    executionId: job.payload.runId as string,
    conversationId: codingJobConversationId(job) ?? (job.payload.runId as string),
    status: job.status,
    ...(!managementRun ? {
      reviewPolicy: codingReviewPolicy(job.payload.reviewPolicy) ?? "auto",
      ...(coordination ? { coordination } : {}),
      workerRuntime: workerExecution!.runtime,
      workerModel: workerExecution!.model,
      workerSelectionSource: workerExecution!.source,
      ...(workerExecution!.runtime === "pi-agent" ? {
        workerProvider: workerExecution!.pi.provider,
        workerPackages: workerExecution!.pi.extensionPackages,
      } : {}),
      improvement: improvementRuntime
        ? codingImprovementRuntimeIdentity(improvementRuntime)
        : null,
    } : {}),
    terminal: ["completed", "failed", "canceled"].includes(job.status),
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(typeof job.payload.objective === "string" ? { objective: job.payload.objective } : {}),
    ...(typeof job.payload.branch === "string" ? { branch: job.payload.branch } : {}),
    ...(typeof job.result?.commit === "string" ? { commit: job.result.commit } : {}),
    ...(typeof job.result?.baselineBranch === "string" ? { baselineBranch: job.result.baselineBranch } : {}),
    ...(typeof job.result?.baselineCommit === "string" ? { baselineCommit: job.result.baselineCommit } : {}),
    ...(typeof job.result?.sourceCheckoutDirty === "boolean" ? { sourceCheckoutDirty: job.result.sourceCheckoutDirty } : {}),
    ...(typeof job.result?.noChanges === "boolean" ? { noChanges: job.result.noChanges } : {}),
    ...(job.result?.gitOutcome === "committed" || job.result?.gitOutcome === "no_changes"
      ? { gitOutcome: job.result.gitOutcome as "committed" | "no_changes" }
      : {}),
    ...(job.lastError ? { error: job.lastError } : {}),
    ...(job.canceledReason ? { canceledReason: job.canceledReason } : {}),
  };
};

const codingJobWorkspaceId = (job: QueueJob): string =>
  typeof job.payload.codingWorkspaceId === "string"
    ? job.payload.codingWorkspaceId
    : codingDefaultWorkspace().id;

const listCodingJobs = async (
  queue: AgentLoaderContext["queue"],
  limit = 50,
  workspaceId?: string,
): Promise<ReadonlyArray<QueueJob>> => {
  const jobs = await queue.listJobs({ limit: Math.min(200, Math.max(limit * 4, limit)) });
  return jobs
    .filter((job) => isCodingJob(job) && (!workspaceId || codingJobWorkspaceId(job) === workspaceId))
    .sort((left, right) => (right.updatedAt - left.updatedAt)
      || (right.createdAt - left.createdAt)
      || (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
    .slice(0, limit);
};

const codingAttentionItems = async (
  queue: AgentLoaderContext["queue"],
  runtime: CodingAgentRuntime,
  workspaces: ReadonlyArray<CodingRepositoryWorkspace>,
  integrationStatus: typeof gitRunIntegrationStatus = gitRunIntegrationStatus,
  limit = 24,
): Promise<ReadonlyArray<CodingAttentionItem>> => {
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, basename(workspace.repositoryRoot)]));
  const jobs = (await listCodingJobs(queue, 60))
    .filter((job) => ["completed", "failed", "canceled"].includes(job.status));
  const projected = await Promise.all(jobs.map(async (job) => {
    const value = await jobProjection(queue, job.id, integrationStatus);
    if (!value?.commit || value.noChanges || value.integration?.integrated) {
      return { raw: job, projected: value };
    }
    const executionRunId = codingJobExecutionId(job);
    const events = executionRunId ? (await readRun(runtime, executionRunId)).events : [];
    return { raw: job, projected: jobWithDeliveryDisposition(value, events) };
  }));
  return projected.flatMap(({ raw, projected: job }): ReadonlyArray<CodingAttentionItem> => {
    if (!job) return [];
    const workspaceId = codingJobWorkspaceId(raw);
    const conversationId = codingJobConversationId(raw);
    if (!conversationId) return [];
    const common = {
      workspaceId,
      workspaceName: workspaceNames.get(workspaceId) ?? "Repository",
      conversationId,
      jobId: job.id,
      updatedAt: raw.updatedAt,
    } as const;
    if (job.noChanges || job.integration?.integrated || job.deliveryDisposition) return [];
    if (job.commit && job.integration?.canIntegrate) {
      return [{
        ...common,
        id: `attention:${job.id}:merge-ready`,
        kind: "merge-ready",
        title: "Certified code is ready to merge",
        detail: `Roster verified the exact commit and can fast-forward ${job.baselineBranch ?? "the recorded target branch"}.`,
        ...(job.baselineBranch ? { targetBranch: job.baselineBranch } : {}),
      }];
    }
    if (job.commit && job.integration?.reason) {
      return [{
        ...common,
        id: `attention:${job.id}:merge-blocked`,
        kind: "merge-blocked",
        title: "Certified merge is blocked",
        detail: "The certified commit cannot be integrated until the recorded repository boundary is restored.",
        ...(job.baselineBranch ? { targetBranch: job.baselineBranch } : {}),
      }];
    }
    if (job.status === "failed" || job.status === "canceled") {
      return [{
        ...common,
        id: `attention:${job.id}:failed`,
        kind: "failed",
        title: "Coding run failed",
        detail: job.status === "canceled"
          ? "The run was canceled before certification completed."
          : "The run failed before certification completed.",
      }];
    }
    return [];
  }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
};

const codingConversationExecutionIds = async (
  queue: AgentLoaderContext["queue"],
  conversationId: string,
  workspaceId?: string,
): Promise<ReadonlyArray<string>> => [...new Set(
  (await listCodingJobs(queue, 200, workspaceId))
    .filter((job) => codingJobConversationId(job) === conversationId)
    .flatMap((job) => {
      const executionId = codingJobExecutionId(job);
      return executionId ? [executionId] : [];
    }),
)];

const readCodingConversationExecution = async (
  deps: Pick<CodingRouteDeps, "runtime" | "queue" | "acceptedOutputs">,
  conversationId: string | undefined,
  executionRunId?: string,
  workspaceId?: string,
  acceptedOutputRead: {
    readonly required?: boolean;
    readonly when?: (view: CodingRunView) => boolean;
  } = {},
): Promise<CodingConversationExecutionView> => {
  const view = await readConversationExecution(
    deps.runtime,
    conversationId,
    executionRunId,
    conversationId
      ? await codingConversationExecutionIds(deps.queue, conversationId, workspaceId)
      : [],
  );
  if (!executionRunId || acceptedOutputRead.when?.(view) === false) {
    return { ...view, acceptedOutputProjection: EMPTY_CODING_ACCEPTED_OUTPUT_PROJECTION };
  }
  const acceptedOutputProjection = await readCodingAcceptedOutputs(deps.acceptedOutputs, executionRunId).catch((error) => {
    if (acceptedOutputRead.required) throw error;
    return EMPTY_CODING_ACCEPTED_OUTPUT_PROJECTION;
  });
  if (!acceptedOutputProjection.outputs.length) {
    return { ...view, acceptedOutputProjection };
  }
  const updatedAt = view.state.taskGraph?.updatedAt ?? 0;
  const artifacts = { ...view.state.artifacts };
  const outputs = { ...view.state.outputs };
  const acceptedOutputKeyCounts = new Map<string, number>();
  const acceptedProjectionKeys = new Set(
    acceptedOutputProjection.outputs.map((output) => output.projectionKey),
  );
  for (const output of acceptedOutputProjection.outputs) {
    acceptedOutputKeyCounts.set(
      output.outputKey,
      (acceptedOutputKeyCounts.get(output.outputKey) ?? 0) + 1,
    );
  }
  for (const [outputKey, count] of acceptedOutputKeyCounts) {
    if (count > 1) delete outputs[outputKey];
  }
  for (const output of acceptedOutputProjection.outputs) {
    const existingArtifact = artifacts[output.artifactId];
    if (existingArtifact && (
      existingArtifact.contentHash !== output.contentHash
      || existingArtifact.outputKey !== output.outputKey
      || existingArtifact.taskId !== output.taskId
      || existingArtifact.nodeId !== output.nodeId
    )) {
      throw new CodingAcceptedOutputProjectionUnavailableError();
    }
    const existingOutput = outputs[output.projectionKey];
    if (existingOutput && (
      existingOutput.artifactId !== output.artifactId
      || existingOutput.contentHash !== output.contentHash
      || existingOutput.taskId !== output.taskId
    )) {
      throw new CodingAcceptedOutputProjectionUnavailableError();
    }
    const event = inlineArtifactPublishedEvent({
      runId: output.runId,
      artifactId: output.artifactId,
      sharedArtifactId: codingAcceptedOutputSharedArtifactId(output),
      origin: "task" as const,
      outputKey: output.outputKey,
      taskId: output.taskId,
      nodeId: output.nodeId,
      kind: output.kind,
      inputVersions: {},
    }, output.value);
    artifacts[output.artifactId] = {
      ...event,
      contentHash: output.contentHash,
      updatedAt,
    };
    const binding = {
      outputKey: output.outputKey,
      artifactId: output.artifactId,
      contentHash: output.contentHash,
      origin: "task" as const,
      taskId: output.taskId,
      updatedAt,
    };
    outputs[output.projectionKey] = binding;
    if (
      acceptedOutputKeyCounts.get(output.outputKey) === 1
      && !acceptedProjectionKeys.has(output.outputKey)
    ) {
      outputs[output.outputKey] = binding;
    }
  }
  return {
    ...view,
    state: { ...view.state, artifacts, outputs },
    acceptedOutputProjection,
  };
};

const codingDeliveryRecoveryRequired = async (
  runtime: CodingAgentRuntime,
  messages: ReadonlyArray<CodingConversationMessage>,
  events: ReadonlyArray<OrchestrationEvent>,
): Promise<boolean> => {
  const deliveryAttempts = codingControlDeliveryAttemptsFromEvents(events);
  const runIds = [...new Set(
    [...deliveryAttempts.values()].flatMap((attempts) =>
      attempts.flatMap((delivery) => delivery.runId ? [delivery.runId] : [])),
  )].slice(0, 200);
  const stateByRunId = new Map(await Promise.all(runIds.map(async (runId) => [
    runId,
    (await readRun(runtime, runId)).state,
  ] as const)));
  return pendingCodingControlMessages({
    messages,
    deliveryAttempts,
    currentJobId: "terminal-continuation-projection",
    currentJobAttempt: 0,
    recipientTaskCompleted: (delivery) => Boolean(delivery.runId && delivery.recipientTaskId
      && stateByRunId.get(delivery.runId)?.taskGraph?.tasks.some((task) =>
        task.taskId === delivery.recipientTaskId && task.status === "accepted")),
  }).length > 0;
};

const findCodingJob = async (
  queue: AgentLoaderContext["queue"],
  runId: string,
  requestedJobId?: string,
  workspaceId?: string,
): Promise<QueueJob | undefined> => {
  if (requestedJobId) {
    const job = await queue.getJob(requestedJobId);
    return job && isCodingJob(job) && codingJobConversationId(job) === runId
      && (!workspaceId || codingJobWorkspaceId(job) === workspaceId) ? job : undefined;
  }
  return (await listCodingJobs(queue, 200, workspaceId))
    .filter((job) => codingJobConversationId(job) === runId)
    .sort((left, right) => (right.createdAt - left.createdAt)
      || (right.updatedAt - left.updatedAt)
      || (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))[0];
};

const codingPageConversationOwner = async (
  deps: Pick<CodingRouteDeps, "queue" | "rooms">,
  catalog: ReadonlyArray<CodingRepositoryWorkspace>,
  conversationId: string,
  requestedJobId?: string,
): Promise<{
  readonly workspace?: CodingRepositoryWorkspace;
  readonly job?: QueueJob;
}> => {
  const job = await findCodingJob(deps.queue, conversationId, requestedJobId);
  if (job) {
    return {
      job,
      workspace: catalog.find((workspace) => workspace.id === codingJobWorkspaceId(job)),
    };
  }
  if (requestedJobId) return {};
  const matchingWorkspaces = (await Promise.all(catalog.map(async (workspace) => ({
    workspace,
    ownsConversation: (await deps.rooms.list(workspace.id))
      .some((room) => room.conversationId === conversationId),
  })))).filter((candidate) => candidate.ownsConversation);
  return matchingWorkspaces.length === 1
    ? { workspace: matchingWorkspaces[0]!.workspace }
    : {};
};

type CodingCollaborationRecordLoad =
  | { readonly ok: true; readonly markdown: string; readonly filename: string }
  | { readonly ok: false; readonly status: 404 | 409 | 503; readonly error: string };

const loadCodingCollaborationRecord = async (
  deps: CodingRouteDeps,
  runId: string,
  requestedJobId?: string,
): Promise<CodingCollaborationRecordLoad> => {
  const job = await findCodingJob(deps.queue, runId, requestedJobId);
  if (!job) {
    const conversation = await readRun(deps.runtime, runId);
    return {
      ok: false,
      status: 404,
      error: conversation.events.length === 0 ? "coding run not found" : "coding job not found",
    };
  }
  const executionRunId = codingJobExecutionId(job) ?? runId;
  const replayResult = await readRunHead(deps.runtime, executionRunId).then(
    (replay) => ({ ok: true as const, replay }),
    () => ({ ok: false as const }),
  );
  if (!replayResult.ok) {
    return { ok: false, status: 503, error: "coding collaboration replay is unavailable" };
  }
  const replay = replayResult.replay;
  if (!["completed", "failed", "canceled"].includes(job.status)) {
    return { ok: false, status: 409, error: "coding collaboration records are available only for terminal jobs" };
  }
  const acceptedOutputs = await (isWorkspaceRescanJob(job)
    ? Promise.resolve({ outputs: [], omittedCount: 0 } satisfies CodingAcceptedOutputProjection)
    : readCodingAcceptedOutputs(deps.acceptedOutputs, executionRunId))
    .catch(() => undefined);
  if (!acceptedOutputs) {
    return { ok: false, status: 503, error: "coding accepted output projection is unavailable" };
  }
  return {
    ok: true,
    markdown: renderCodingCollaborationRecord({
      runId,
      receiptCount: replay.receiptCount,
      state: replay.state,
      events: replay.events,
      job,
      acceptedOutputs: acceptedOutputs.outputs,
      acceptedOutputsOmitted: acceptedOutputs.omittedCount,
      runtimeDiagnostics: (deps.runtimeLogs ?? codingRuntimeLogs).list(executionRunId),
    }),
    filename: codingCollaborationRecordFilename(runId, job.id),
  };
};

const setCodingCollaborationRecordHeaders = (context: Context, filename: string): void => {
  context.header("Content-Type", "text/markdown; charset=utf-8");
  context.header("Content-Disposition", `attachment; filename="${filename}"`);
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
};

type CodingInvestigationReportLoad =
  | { readonly ok: true; readonly markdown: string; readonly filename: string }
  | { readonly ok: false; readonly status: 404 | 409 | 503; readonly error: string };

const loadCodingInvestigationReport = async (
  deps: CodingRouteDeps,
  runId: string,
  requestedJobId?: string,
): Promise<CodingInvestigationReportLoad> => {
  const job = await findCodingJob(deps.queue, runId, requestedJobId);
  if (!job) return { ok: false, status: 404, error: "coding investigation not found" };
  if (!isInvestigationJob(job)) {
    return { ok: false, status: 409, error: "this run does not produce an investigation report" };
  }
  if (!["completed", "failed", "canceled"].includes(job.status)) {
    return { ok: false, status: 409, error: "investigation reports are available only after the run finishes" };
  }
  const executionRunId = codingJobExecutionId(job) ?? runId;
  const acceptedOutputs = await readCodingAcceptedOutputs(deps.acceptedOutputs, executionRunId).catch(() => undefined);
  if (!acceptedOutputs) {
    return { ok: false, status: 503, error: "coding accepted output projection is unavailable" };
  }
  const finalReport = acceptedOutputs.outputs.find((output) => output.outputKey === "final_report");
  const report = parseCodingInvestigationReport(finalReport?.value);
  if (!report) return { ok: false, status: 404, error: "accepted investigation report not found" };
  return {
    ok: true,
    markdown: renderCodingInvestigationReport({
      runId,
      objective: typeof job.payload.objective === "string" ? job.payload.objective : "Repository investigation",
      report,
    }),
    filename: codingInvestigationReportFilename(runId),
  };
};

const boundedString = (value: unknown, max = 1_000): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

const boundedStrings = (value: unknown, max = 100): ReadonlyArray<string> | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, max) : undefined;

const eventDto = (event: OrchestrationEvent): Readonly<Record<string, unknown>> => {
  const source = event as unknown as Readonly<Record<string, unknown>>;
  const result: Record<string, unknown> = { type: event.type };
  for (const key of [
    "runId", "taskId", "delegationId", "nodeId", "capability", "artifactId", "outputKey",
    "contentHash", "planId", "planVersion", "compositionId", "topologyId", "frontierVersion",
  ]) {
    const value = boundedString(source[key], 500);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["reason", "error", "detail"]) {
    const value = boundedString(source[key], 4_000);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["attempt", "iteration", "score"]) {
    if (typeof source[key] === "number") result[key] = source[key];
  }
  for (const key of ["artifactIds", "needs", "provides"]) {
    const value = boundedStrings(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
};

type CodingRunResultDto = {
  readonly runKind?: "workspace-rescan";
  readonly status?: string;
  readonly summary?: string;
  readonly answer?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly validation?: ReadonlyArray<string>;
  readonly frontierHash?: string;
  readonly workspaceId?: string;
  readonly inputProfileStream?: string;
  readonly outputProfileStream?: string;
  readonly fingerprint?: string;
  readonly enrichmentEpoch?: number;
  readonly enrichmentStatus?: string;
  readonly specialistCount?: number;
  readonly conflictCount?: number;
  readonly specialistOutcomes?: ReadonlyArray<{
    readonly nodeId: string;
    readonly state: string;
    readonly epoch: number;
    readonly artifactId?: string;
  }>;
  readonly raw?: string;
};

const parsedObject = (value: string | undefined): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

const cleanString = (value: unknown, max = 1_000): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

const cleanStringArray = (value: unknown, max = 20): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 1_000))
    .slice(0, max);
  return strings.length > 0 ? strings : undefined;
};

const cleanNonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const workspaceRescanOutcomes = (value: unknown): CodingRunResultDto["specialistOutcomes"] => {
  if (!Array.isArray(value)) return undefined;
  const outcomes = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const row = candidate as Record<string, unknown>;
    const nodeId = cleanString(row.nodeId, 200);
    const state = cleanString(row.state, 80);
    const epoch = cleanNonNegativeInteger(row.epoch);
    const artifactId = cleanString(row.artifactId, 500);
    return nodeId && state && epoch !== undefined
      ? [{ nodeId, state, epoch, ...(artifactId ? { artifactId } : {}) }]
      : [];
  }).slice(0, 24);
  return outcomes.length ? outcomes : undefined;
};

const codingRunResult = (
  outputs: Readonly<Record<string, string>>,
  acceptedJobResult?: unknown,
): CodingRunResultDto | undefined => {
  const workspaceRescanRaw = outputs.workspace_rescan_result;
  const raw = workspaceRescanRaw ?? outputs.final_report ?? outputs.review_report ?? outputs.implementation_report;
  const parsedJobResult = acceptedJobResult
    && typeof acceptedJobResult === "object"
    && !Array.isArray(acceptedJobResult)
    ? acceptedJobResult as Record<string, unknown>
    : undefined;
  const parsed = parsedObject(raw) ?? parsedJobResult;
  if (!raw && !parsed) return undefined;
  const changedFiles = cleanStringArray(parsed?.changedFiles ?? parsed?.changed_files);
  const validation = cleanStringArray(parsed?.validation ?? parsed?.validations);
  const status = cleanString(parsed?.status, 120);
  const summary = cleanString(parsed?.summary, 1_000);
  const answer = cleanString(parsed?.answer, 20_000);
  const frontierHash = cleanString(parsed?.frontierHash ?? parsed?.frontier_hash, 200);
  const workspaceId = cleanString(parsed?.workspaceId, 200);
  const inputProfileStream = cleanString(parsed?.inputProfileStream, 500);
  const outputProfileStream = cleanString(parsed?.outputProfileStream, 500);
  const fingerprint = cleanString(parsed?.fingerprint, 200);
  const enrichmentEpoch = cleanNonNegativeInteger(parsed?.enrichmentEpoch);
  const enrichmentStatus = cleanString(parsed?.enrichmentStatus, 80);
  const specialistCount = cleanNonNegativeInteger(parsed?.specialistCount);
  const conflictCount = cleanNonNegativeInteger(parsed?.conflictCount);
  const specialistOutcomes = workspaceRescanOutcomes(parsed?.specialistOutcomes);
  const result = {
    ...(workspaceRescanRaw || parsed?.runKind === "workspace-rescan"
      ? { runKind: "workspace-rescan" as const }
      : {}),
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
    ...(answer ? { answer } : {}),
    ...(changedFiles ? { changedFiles } : {}),
    ...(validation ? { validation } : {}),
    ...(frontierHash ? { frontierHash } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(inputProfileStream ? { inputProfileStream } : {}),
    ...(outputProfileStream ? { outputProfileStream } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(enrichmentEpoch !== undefined ? { enrichmentEpoch } : {}),
    ...(enrichmentStatus ? { enrichmentStatus } : {}),
    ...(specialistCount !== undefined ? { specialistCount } : {}),
    ...(conflictCount !== undefined ? { conflictCount } : {}),
    ...(specialistOutcomes ? { specialistOutcomes } : {}),
    ...(raw
      ? { raw: raw.slice(0, 8_000) }
      : parsedJobResult
        ? { raw: JSON.stringify(parsedJobResult).slice(0, 8_000) }
        : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
};

const countPatchLines = (patch: string, marker: "+" | "-"): number =>
  patch.split("\n").filter((line) =>
    line.startsWith(marker) && !line.startsWith(`${marker}${marker}${marker}`)).length;

type CodingDiffSummaryDto = {
  readonly summary: string;
  readonly files: ReadonlyArray<{ readonly status: string; readonly path: string }>;
  readonly truncated: boolean;
  readonly patch: {
    readonly text: string;
    readonly bytes: number;
    readonly truncated: boolean;
  };
};

const frontierDto = (diff: CodingDiffSummaryDto) => ({
  summary: diff.summary,
  changedFiles: diff.files.length,
  files: diff.files.map((file) => ({ status: file.status, path: file.path })).slice(0, 100),
  insertions: countPatchLines(diff.patch.text, "+"),
  deletions: countPatchLines(diff.patch.text, "-"),
  patchBytes: diff.patch.bytes,
  truncated: diff.truncated || diff.patch.truncated,
});

const codingExecutionTasks = (state: OrchestrationState) =>
  (state.taskGraph?.tasks ?? []).filter((task) => task.capability !== "coordinate.graph");

const codingExecutionCertified = (state: OrchestrationState): boolean => {
  const tasks = codingExecutionTasks(state);
  const finalizer = tasks.find((task) => task.taskId === "coding-finalize");
  const executableTasks = tasks.filter((task) => task.capability !== "coordinate");
  return executableTasks.length > 0
    && executableTasks.every((task) => task.status === "accepted")
    && (!finalizer || finalizer.status === "accepted");
};

const runProjection = async (
  deps: Pick<CodingRouteDeps, "runtime" | "queue" | "acceptedOutputs" | "realtime">,
  runId: string,
  job?: QueueJob,
) => {
  const executionRunId = job ? codingJobExecutionId(job) ?? runId : runId;
  const managementRun = Boolean(job && isWorkspaceRescanJob(job));
  const investigationRun = Boolean(job && isInvestigationJob(job));
  const { state, events, acceptedOutputProjection } = await readCodingConversationExecution(
    deps,
    runId,
    executionRunId,
    job ? codingJobWorkspaceId(job) : undefined,
    {
      required: true,
      when: (view) => Boolean(
        job
        && !managementRun
        && (job.status === "completed" || view.state.taskGraph?.runId === executionRunId),
      ),
    },
  );
  const conversation = codingConversationFromEvents(events);
  const deliveryProjection = codingControlDeliveriesFromEvents(events);
  const outputValues = {
    ...orchestrationOutputValues(state),
    ...codingAcceptedOutputValues(acceptedOutputProjection),
  };
  const terminal = job ? ["completed", "failed", "canceled"].includes(job.status) : false;
  const repositoryRoot = typeof job?.payload.workingDirectory === "string"
    ? resolve(job.payload.workingDirectory)
    : codingRepositoryRoot();
  const diff = terminal && !managementRun && !investigationRun
    ? await runPatchSummary(executionRunId, repositoryRoot).catch(() => undefined)
    : undefined;
  const result = codingRunResult(outputValues, managementRun ? job?.result : undefined);
  const validationReport = parseRepositoryValidationReport(outputValues.repository_validation_report);
  const tasks = Object.fromEntries(codingExecutionTasks(state).map((task) => [task.taskId, {
    taskId: task.taskId,
    nodeId: task.nodeId,
    capability: task.capability,
    status: task.status,
    attempt: task.attempt,
    ...(task.objective ? { objective: task.objective.slice(0, 4_000) } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    dependencies: task.dependencies.slice(0, 100),
    outputKeys: [...new Set([
      ...Object.entries(state.outputs)
        .filter(([, output]) => output.taskId === task.taskId)
        .map(([projectionKey]) => projectionKey),
      ...acceptedOutputProjection.outputs
        .filter((output) => output.taskId === task.taskId)
        .map((output) => output.projectionKey),
    ])]
      .slice(0, 100),
    artifactIds: [...new Set([
      ...Object.values(state.outputs)
        .filter((output) => output.taskId === task.taskId)
        .map((output) => output.artifactId),
      ...acceptedOutputProjection.outputs
        .filter((output) => output.taskId === task.taskId)
        .map((output) => output.artifactId),
    ])]
      .slice(0, 100),
    ...(task.error ? { error: task.error.slice(0, 4_000) } : {}),
    updatedAt: state.taskGraph?.updatedAt,
  }]));
  const nodes = Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, {
    id: node.id,
    name: node.name,
    capabilities: node.capabilities.slice(0, 100),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.promptProfile ? { promptProfile: node.promptProfile } : {}),
    ...(node.runtime ? { runtime: {
      kind: node.runtime.kind,
      ...(node.runtime.profile ? { profile: node.runtime.profile } : {}),
      ...(typeof node.runtime.metadata?.model === "string"
        ? { metadata: { model: node.runtime.metadata.model.slice(0, 200) } }
        : {}),
    } } : {}),
    status: node.status,
    metadata: {
      ...(typeof node.metadata?.specialty === "string" ? { specialty: node.metadata.specialty } : {}),
      ...(typeof node.metadata?.collaborationRole === "string" ? { collaborationRole: node.metadata.collaborationRole } : {}),
      ...(typeof node.metadata?.authority === "string" ? { authority: node.metadata.authority } : {}),
      ...(Array.isArray(node.metadata?.dependsOnNodeIds) ? { dependsOnNodeIds: node.metadata.dependsOnNodeIds } : {}),
    },
    updatedAt: node.updatedAt,
  }]));
  const outputs = {
    ...Object.fromEntries(Object.entries(state.outputs).map(([key, output]) => [key, {
      outputKey: output.outputKey.slice(0, 500),
      artifactId: output.artifactId.slice(0, 500),
      contentHash: output.contentHash.slice(0, 500),
      origin: output.origin,
      ...(output.taskId ? { taskId: output.taskId.slice(0, 500) } : {}),
      updatedAt: output.updatedAt,
    }])),
    ...Object.fromEntries(acceptedOutputProjection.outputs.map((output) => [output.projectionKey, {
      projectionKey: output.projectionKey.slice(0, 500),
      outputKey: output.outputKey.slice(0, 500),
      artifactId: output.artifactId.slice(0, 500),
      contentHash: output.contentHash.slice(0, 500),
      origin: "task" as const,
      taskId: output.taskId.slice(0, 500),
      nodeId: output.nodeId.slice(0, 500),
      kind: output.kind.slice(0, 500),
      mediaType: output.mediaType.slice(0, 500),
      byteLength: output.byteLength,
    }])),
  };
  const eventLimit = 500;
  const collaboration = codingCollaborationStatus({
    outputs: outputValues,
    taskStatuses: Object.fromEntries(codingExecutionTasks(state).map((task) => [task.taskId, task.status])),
    peerCount: Object.values(state.nodes).filter((node) => node.id !== "coordinator").length,
    certified: codingExecutionCertified(state),
  });
  const collaborationResolution = parseCodingPeerResolution(
    outputValues[CODING_COLLABORATION_RESOLUTION_OUTPUT] ?? "",
  );
  const improvementRuntime = job && !managementRun && job.payload.improvementRuntime !== undefined
    ? parseCodingImprovementRuntimePin(job.payload.improvementRuntime)
    : undefined;
  return {
    schema: CODING_API_SCHEMA,
    ...(deps.realtime ? { realtimeWorkspaceId: deps.realtime.workspaceId } : {}),
    ...(job && codingJobWorkspaceId(job) ? { codingWorkspaceId: codingJobWorkspaceId(job) } : {}),
    run: {
      id: runId,
      executionId: executionRunId,
      stream: codingRunStream(executionRunId),
      conversationStream: codingRunStream(runId),
      repositoryRoot,
      ...(!managementRun && !investigationRun ? {
        branch: typeof job?.payload.branch === "string" ? job.payload.branch : gitRunBranchName(executionRunId),
      } : {}),
      ...(typeof job?.result?.commit === "string" ? { commit: job.result.commit } : {}),
      ...(job && typeof job.payload.objective === "string" ? { objective: job.payload.objective } : {}),
      improvement: improvementRuntime
        ? codingImprovementRuntimeIdentity(improvementRuntime)
        : null,
    },
    conversation: {
      id: runId,
      images: conversation.images,
      messages: conversation.messages.map((message) => {
        const delivery = deliveryProjection.get(message.messageId);
        return {
          ...message,
          ...(delivery ? {
            delivery: {
              ...delivery,
              ...(delivery.recipientNodeId && state.nodes[delivery.recipientNodeId]
                ? { recipientName: state.nodes[delivery.recipientNodeId]!.name }
                : {}),
            },
          } : message.tags.includes("delivery:queued") ? {
            delivery: { messageId: message.messageId, state: terminal ? "superseded" : "queued" },
          } : {}),
        };
      }),
      routes: conversation.routes,
      pendingQuestions: conversation.routes.at(-1)?.disposition === "needs_clarification"
        ? conversation.routes.at(-1)?.questions ?? []
        : [],
      disposition: conversation.routes.at(-1)?.disposition ?? (job ? "ready" : "unplanned"),
      tags: conversation.routes.at(-1)?.tags ?? [],
      selectedNodeIds: conversation.routes.at(-1)?.selectedNodeIds ?? [],
      ...(conversation.routes.at(-1)?.primaryNodeId
        ? { primaryNodeId: conversation.routes.at(-1)?.primaryNodeId }
        : {}),
      ...(conversation.routes.at(-1)?.coordination
        ? { coordination: conversation.routes.at(-1)?.coordination }
        : {}),
    },
    job: job ? codingJobDto(job) : null,
    tasks,
    nodes,
    outputs,
    collaboration: {
      ...collaboration,
      resolution: collaborationResolution ? {
        status: collaborationResolution.status,
        summary: collaborationResolution.summary,
        unresolved: collaborationResolution.unresolved,
      } : null,
      topologyId: state.topologyId ?? null,
      topology: state.topologyId ? state.topologies[state.topologyId] ?? null : null,
      durableStore: "spacetimedb",
    },
    receiptCount: events.length,
    acceptedOutputCount: acceptedOutputProjection.outputs.length,
    acceptedOutputsOmitted: acceptedOutputProjection.omittedCount,
    ...(result ? { result } : {}),
    ...(validationReport ? { validationReport } : {}),
    ...(diff ? { frontier: frontierDto(diff) } : {}),
    events: events.slice(-eventLimit).map(eventDto),
    eventsTruncated: events.length > eventLimit,
  };
};

const jsonObject = async (request: { readonly json: () => Promise<unknown> }): Promise<Record<string, unknown> | undefined> => {
  try {
    const value = await request.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

const enqueueCodingRun = async (
  deps: CodingRouteDeps,
  objective: string,
  reviewPolicy: "auto" | "fast" | "reviewed" = "auto",
  workerRuntime: CodingWorkerRuntime = DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME,
  options: {
    readonly runId?: string;
    readonly conversationId?: string;
    readonly selectedNodeIds?: ReadonlyArray<string>;
    readonly primaryNodeId?: string;
    readonly coordination?: CodingConversationCoordination;
    readonly executionKind?: "mutation" | "investigation";
    readonly conversationTags?: ReadonlyArray<string>;
    readonly humanResolution?: CodingPeerResolution;
    readonly workspace?: CodingRepositoryWorkspace;
    readonly workerModel?: CodingWorkspaceWorkerModel;
    readonly selectionSource?: CodingWorkerSelectionSource;
    readonly workerExecution?: CodingWorkerExecution;
    readonly dependencyResolution?: "registry";
    readonly retryOfJobId?: string;
    readonly jobId?: string;
    readonly continuityNodes?: ReadonlyArray<WorkspaceNode>;
    readonly continuitySource?: {
      readonly deliveryId: string;
      readonly sourceId: string;
      readonly sourceVersion: string;
      readonly sourceHash: string;
      readonly deliveredAt: number;
    };
  } = {},
) => {
  const runId = options.runId ?? newCodingConversationId();
  const conversationId = options.conversationId ?? runId;
  if (!options.coordination) {
    throw new Error("Coding runs require an accepted roster-coordination skill decision");
  }
  const workspace = options.workspace ?? codingDefaultWorkspace();
  const reviewerRuntime = await preferredCodingReviewerRuntime(deps);
  const workerExecution = options.workerExecution ?? createCodingWorkerExecution({
    runtime: workerRuntime,
    source: options.selectionSource ?? "product-default",
    workerModel: options.workerModel,
    ...(options.dependencyResolution ? {
      dependencyResolution: options.dependencyResolution,
    } : {}),
    env: deps.workerExecutionEnvironment,
  });
  const improvementRuntime = deps.activeImprovementSnapshot?.() ?? emptyCodingImprovementRuntimePin();
  const runStream = codingRunStream(runId);
  const executionKind = options.executionKind ?? "mutation";
  const jobInput = {
    ...(options.jobId ? { jobId: options.jobId } : {}),
    agentId: "coding-agent",
    lane: "collect",
    sessionKey: `coding-agent:${workspace.id}`,
    singletonMode: "allow",
    // A small bounded set of receipt-aware recovery attempts lets a long local
    // turn survive transient worker replacement without creating an unbounded
    // retry loop. Task and job lease fences still reject stale side effects.
    maxAttempts: 4,
    payload: {
      kind: "coding-agent.run",
      stream: "agents/coding-agent",
      runId,
      conversationId,
      runStream,
      executionKind,
      branch: gitRoomBranchName(codingRepositoryRoomId(conversationId)),
      objective,
      reviewPolicy,
      coordination: options.coordination,
      workerExecution,
      reviewerRuntime,
      improvementRuntime,
      codingWorkspaceId: workspace.id,
      workspaceProfileStream: workspace.profileStream,
      ...(options.selectedNodeIds?.length ? { selectedNodeIds: [...options.selectedNodeIds] } : {}),
      ...(options.primaryNodeId ? { primaryNodeId: options.primaryNodeId } : {}),
      ...(options.conversationTags?.length ? { conversationTags: [...options.conversationTags] } : {}),
      ...(options.humanResolution ? { humanResolution: options.humanResolution } : {}),
      ...(options.retryOfJobId ? { retryOfJobId: options.retryOfJobId } : {}),
      workingDirectory: workspace.repositoryRoot,
    },
  } satisfies EnqueueJobInput;
  const job = deps.continuity
    && options.primaryNodeId
    && options.continuityNodes
    && options.continuitySource
    ? await deps.continuity.enqueue({
        nodes: options.continuityNodes,
        primaryNodeId: options.primaryNodeId,
        ...options.continuitySource,
        payload: jobInput.payload,
      })
    : await deps.queue.enqueue(jobInput);
  return { runId, job };
};

type WorkspaceRescanEnqueueResult =
  | { readonly status: "enqueued" | "duplicate"; readonly runId: string; readonly job: QueueJob }
  | { readonly status: "conflict"; readonly runId: string; readonly job: QueueJob };

const enqueueWorkspaceRescan = async (input: {
  readonly deps: CodingRouteDeps;
  readonly workspace: CodingRepositoryWorkspace;
  readonly objective: string;
  readonly conversationId?: string;
  readonly requestIdentity: string;
}): Promise<WorkspaceRescanEnqueueResult> => {
  const objective = input.objective.trim().slice(0, 20_000);
  if (!objective) throw new Error("A workspace rescan objective is required");
  const identityHash = hashCanonical({ workspaceId: input.workspace.id, requestIdentity: input.requestIdentity });
  const jobId = `coding-rescan-${identityHash.slice(0, 32)}`;
  const runId = input.conversationId ?? `workspace-rescan-${identityHash.slice(0, 32)}`;
  const sessionKey = `coding-workspace-rescan:${input.workspace.id}`;
  const discoveryExecution = createCodingWorkspaceDiscoveryExecution({
    environment: input.deps.workerExecutionEnvironment,
  });
  const payload = {
    kind: "coding-agent.workspace-rescan",
    stream: "agents/coding-agent",
    runId,
    conversationId: runId,
    runStream: codingRunStream(runId),
    objective,
    requestIdentity: input.requestIdentity,
    codingWorkspaceId: input.workspace.id,
    workspaceProfileStream: input.workspace.profileStream,
    workingDirectory: input.workspace.repositoryRoot,
    workspace: JSON.stringify(input.workspace),
    runKind: "workspace-rescan",
    readOnly: true,
    integratable: false,
    discoveryExecution,
  };
  const unchanged = (job: QueueJob): boolean => isWorkspaceRescanJob(job)
    && job.agentId === "coding-agent"
    && job.lane === "collect"
    && (job.sessionKey === undefined || job.sessionKey === sessionKey)
    && (job.singletonMode === undefined || job.singletonMode === "reject")
    && job.maxAttempts === 1
    && hashCanonical(job.payload) === hashCanonical(payload);
  const exact = await input.deps.queue.getJob(jobId);
  if (exact) {
    return {
      status: unchanged(exact) ? "duplicate" : "conflict",
      runId: codingJobExecutionId(exact)!,
      job: exact,
    };
  }
  const active = input.deps.queue.findActiveBySession
    ? await input.deps.queue.findActiveBySession(sessionKey, jobId)
    : (await input.deps.queue.listJobs({ limit: 200 })).find((job) =>
        job.sessionKey === sessionKey && job.id !== jobId && ["queued", "leased", "running"].includes(job.status));
  if (active) return { status: "conflict", runId: codingJobExecutionId(active)!, job: active };
  try {
    const job = await input.deps.queue.enqueue({
      requestId: `enqueue-rescan-${identityHash.slice(0, 32)}`,
      jobId,
      agentId: "coding-agent",
      lane: "collect",
      sessionKey,
      singletonMode: "reject",
      maxAttempts: 1,
      payload,
    });
    if (!unchanged(job)) return { status: "conflict", runId: codingJobExecutionId(job)!, job };
    return { status: "enqueued", runId: codingJobExecutionId(job)!, job };
  } catch (error) {
    const racedExact = await input.deps.queue.getJob(jobId);
    if (racedExact) {
      return {
        status: unchanged(racedExact) ? "duplicate" : "conflict",
        runId: codingJobExecutionId(racedExact)!,
        job: racedExact,
      };
    }
    const raced = input.deps.queue.findActiveBySession
      ? await input.deps.queue.findActiveBySession(sessionKey, jobId)
      : (await input.deps.queue.listJobs({ limit: 200 })).find((job) =>
          job.sessionKey === sessionKey && job.id !== jobId && ["queued", "leased", "running"].includes(job.status));
    if (raced) return { status: "conflict", runId: codingJobExecutionId(raced)!, job: raced };
    throw error;
  }
};

const publishConversationMessage = async (
  runtime: CodingAgentRuntime,
  message: CodingConversationMessage,
): Promise<boolean> => {
  const event = codingConversationMessageEvent(message);
  const recorded = await runtime.execute(codingRunStream(message.conversationId), {
    type: "emit",
    eventId: `coding-conversation:${message.messageId}`,
    event,
  });
  return recorded.length > 0;
};

type CodingConversationSpeaker = CodingWorkspaceProfile["nodes"][number];

const codingConversationSpeakerAuthor = (speaker: CodingConversationSpeaker) => ({
  id: speaker.id,
  name: typeof speaker.metadata?.givenName === "string"
    ? speaker.metadata.givenName
    : speaker.name.split(",")[0]?.trim() ?? speaker.name,
  ...(typeof speaker.metadata?.displayRole === "string"
    ? { role: speaker.metadata.displayRole }
    : {}),
});

const directlyAddressedConversationNode = (
  message: CodingConversationMessage,
  nodes: CodingWorkspaceProfile["nodes"],
): CodingConversationSpeaker | undefined => {
  const mentionedNodeIds = new Set(codingConversationMentionedNodeIds(message.mentions, nodes));
  const executableMentions = nodes.filter((node) =>
    mentionedNodeIds.has(node.id)
    && node.id !== "coordinator"
    && node.id !== CODING_HUMAN_NODE_ID
    && node.metadata?.participantKind !== "human");
  return executableMentions.length === 1 ? executableMentions[0] : undefined;
};

const publishDirectInformationalReply = async (
  runtime: CodingAgentRuntime,
  message: CodingConversationMessage,
  route: CodingConversationRoute,
  responder: CodingConversationSpeaker | undefined,
): Promise<CodingConversationMessage | undefined> => {
  if (!responder || route.disposition !== "informational" || !route.answer) return undefined;
  const reply = createCodingConversationMessage({
    conversationId: message.conversationId,
    ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}),
    author: { kind: "agent", id: responder.id, name: responder.name },
    source: { kind: "agent" },
    text: route.answer,
    tags: ["intent:informational", "routing:direct-mention"],
    replyTo: message.messageId,
    createdAt: Math.max(Date.now(), route.createdAt + 1),
  });
  await publishConversationMessage(runtime, reply);
  return reply;
};

const publishBoundedInformationalPeerFollowUp = async (input: {
  readonly deps: CodingRouteDeps;
  readonly profile: CodingWorkspaceProfile;
  readonly directReply: CodingConversationMessage | undefined;
  readonly originalResponder: CodingConversationSpeaker | undefined;
  readonly messages: ReadonlyArray<CodingConversationMessage>;
  readonly images: ReadonlyArray<CodingConversationImage>;
  readonly routes: ReadonlyArray<CodingConversationRoute>;
  readonly repositoryContext: CodingConversationRepositoryContext;
  readonly repositoryRoot: string;
}): Promise<void> => {
  const { directReply, originalResponder } = input;
  if (!directReply || !originalResponder
    || (!input.deps.conversationAnswerer && !input.deps.conversationPlanner)) return;
  // One exact agent-authored @mention may create one conversational response.
  // It never recursively plans another follow-up, creates a task, or starts a run.
  const peerResponder = directlyAddressedConversationNode(directReply, input.profile.nodes);
  if (!peerResponder || peerResponder.id === originalResponder.id) return;
  if (input.messages.some((message) =>
    message.replyTo === directReply.messageId && message.author.id === peerResponder.id)) return;
  const originalResponderName = typeof originalResponder.metadata?.givenName === "string"
    ? originalResponder.metadata.givenName
    : originalResponder.name.split(",", 1)[0] ?? originalResponder.name;
  try {
    const followUpMessages = [...input.messages, directReply];
    const productContext = input.deps.conversationProductContext;
    const answer = input.deps.conversationAnswerer
      ? await input.deps.conversationAnswerer({
          messages: followUpMessages,
          images: input.images,
          routes: input.routes,
          workspaceNodes: input.profile.nodes,
          responder: peerResponder,
          repositoryContext: input.repositoryContext,
          ...(productContext ? { productContext } : {}),
        })
      : await (async () => {
          const decision = await input.deps.conversationPlanner?.({
            conversationId: directReply.conversationId,
            messages: followUpMessages,
            images: input.images,
            routes: input.routes,
            workspaceNodes: input.profile.nodes,
            responder: peerResponder,
            repositoryContext: input.repositoryContext,
            repositoryRoot: input.repositoryRoot,
            ...(productContext ? { productContext } : {}),
          });
          if (decision?.disposition !== "informational" || !decision.answer?.trim()) {
            throw new Error("The local conversation runtime did not return a peer reply.");
          }
          return decision.answer;
        })();
    await publishConversationMessage(input.deps.runtime, createCodingConversationMessage({
      conversationId: directReply.conversationId,
      ...(directReply.workspaceId ? { workspaceId: directReply.workspaceId } : {}),
      author: { kind: "agent", id: peerResponder.id, name: peerResponder.name },
      source: { kind: "agent" },
      text: answer,
      tags: ["intent:informational", "routing:agent-mention"],
      mentions: [originalResponderName, "You"],
      replyTo: directReply.messageId,
      createdAt: Math.max(Date.now(), directReply.createdAt + 1),
    }));
  } catch {
    const peerName = typeof peerResponder.metadata?.givenName === "string"
      ? peerResponder.metadata.givenName
      : peerResponder.name.split(",", 1)[0] ?? peerResponder.name;
    await publishConversationMessage(input.deps.runtime, createCodingConversationMessage({
      conversationId: directReply.conversationId,
      ...(directReply.workspaceId ? { workspaceId: directReply.workspaceId } : {}),
      author: { kind: "system", id: "coordinator", name: "Roster" },
      source: { kind: "agent" },
      text: `${peerName} couldn’t answer that handoff just now. @You, mention @${peerName} directly to retry.`,
      tags: ["intent:recovery", "routing:agent-mention"],
      replyTo: directReply.messageId,
      createdAt: Math.max(Date.now(), directReply.createdAt + 1),
    }));
  }
};

const publishSelectedInformationalReplies = async (input: {
  readonly deps: CodingRouteDeps;
  readonly profile: CodingWorkspaceProfile;
  readonly message: CodingConversationMessage;
  readonly route: CodingConversationRoute;
  readonly messages: ReadonlyArray<CodingConversationMessage>;
  readonly images: ReadonlyArray<CodingConversationImage>;
  readonly routes: ReadonlyArray<CodingConversationRoute>;
  readonly repositoryContext: CodingConversationRepositoryContext;
  readonly repositoryRoot: string;
  readonly onDelta?: (
    delta: string,
    responder?: CodingConversationSpeaker,
  ) => void | Promise<void>;
}): Promise<void> => {
  if (input.route.disposition !== "informational"
    || input.route.selectedNodeIds.length === 0
    || (!input.deps.conversationAnswerer && !input.deps.conversationPlanner)) return;
  const nodesById = new Map(input.profile.nodes.map((node) => [node.id, node]));
  let ordinal = 0;
  for (const nodeId of input.route.selectedNodeIds) {
    const responder = nodesById.get(nodeId);
    if (!responder
      || responder.id === "coordinator"
      || responder.id === CODING_HUMAN_NODE_ID
      || responder.metadata?.participantKind === "human"
      || responder.metadata?.participantKind === "system") continue;
    if (input.messages.some((candidate) =>
      candidate.replyTo === input.message.messageId && candidate.author.id === responder.id)) continue;
    ordinal += 1;
    try {
      const productContext = input.deps.conversationProductContext;
      const answer = input.deps.conversationAnswerer
        ? await input.deps.conversationAnswerer({
            messages: input.messages,
            images: input.images,
            routes: input.routes,
            workspaceNodes: input.profile.nodes,
            responder,
            repositoryContext: input.repositoryContext,
            ...(productContext ? { productContext } : {}),
            ...(input.onDelta ? {
              onDelta: (delta: string) => input.onDelta?.(delta, responder),
            } : {}),
          })
        : await (async () => {
            const decision = await input.deps.conversationPlanner?.({
              conversationId: input.message.conversationId,
              messages: input.messages,
              images: input.images,
              routes: input.routes,
              workspaceNodes: input.profile.nodes,
              responder,
              repositoryContext: input.repositoryContext,
              repositoryRoot: input.repositoryRoot,
              ...(productContext ? { productContext } : {}),
              ...(input.onDelta ? {
                onDelta: (delta: string) => input.onDelta?.(delta, responder),
              } : {}),
            });
            if (decision?.disposition !== "informational" || !decision.answer?.trim()) {
              throw new Error("The local conversation runtime did not return a selected participant reply.");
            }
            return decision.answer;
          })();
      await publishConversationMessage(input.deps.runtime, createCodingConversationMessage({
        conversationId: input.message.conversationId,
        ...(input.message.workspaceId ? { workspaceId: input.message.workspaceId } : {}),
        author: { kind: "agent", id: responder.id, name: responder.name },
        source: { kind: "agent" },
        text: answer,
        tags: ["intent:informational", "routing:roster-selection"],
        mentions: ["You"],
        replyTo: input.message.messageId,
        createdAt: Math.max(Date.now(), input.route.createdAt + ordinal),
      }));
    } catch {
      const responderName = typeof responder.metadata?.givenName === "string"
        ? responder.metadata.givenName
        : responder.name.split(",", 1)[0] ?? responder.name;
      await publishConversationMessage(input.deps.runtime, createCodingConversationMessage({
        conversationId: input.message.conversationId,
        ...(input.message.workspaceId ? { workspaceId: input.message.workspaceId } : {}),
        author: { kind: "system", id: "coordinator", name: "Roster" },
        source: { kind: "agent" },
        text: `${responderName} couldn’t answer just now. @You, mention @${responderName} directly to retry.`,
        tags: ["intent:recovery", "routing:roster-selection"],
        mentions: ["You"],
        replyTo: input.message.messageId,
        createdAt: Math.max(Date.now(), input.route.createdAt + ordinal),
      }));
    }
  }
};

class CodingConversationPlannerUnavailableError extends Error {
  readonly code: "planner_unavailable" | "conversation_runtime_unavailable";

  constructor(
    readonly conversationId: string,
    readonly route: CodingConversationRoute,
    readonly plannerError: unknown,
  ) {
    const runtimeFailureClass = codingConversationRuntimeFailureClass(plannerError);
    super(runtimeFailureClass
      ? "The selected conversation runtime is unavailable."
      : "The conversation planner could not return a valid coordination decision.");
    this.code = runtimeFailureClass ? "conversation_runtime_unavailable" : "planner_unavailable";
    this.name = "CodingConversationPlannerUnavailableError";
  }
}

const codingConversationPlannerUnavailableDto = (
  error: CodingConversationPlannerUnavailableError,
) => ({
  schema: CODING_API_SCHEMA,
  ok: false as const,
  code: error.code,
  error: error.message,
  retryable: true,
  runId: error.conversationId,
  conversationId: error.conversationId,
  disposition: error.code,
  route: error.route,
  job: null,
  traceId: error.route.routeId,
});

const publishConversationImages = async (
  runtime: CodingAgentRuntime,
  images: ReadonlyArray<CodingConversationImage>,
): Promise<void> => {
  for (const image of images) {
    await runtime.execute(codingRunStream(image.conversationId), {
      type: "emit",
      eventId: `coding-conversation:${image.artifactId}`,
      event: codingConversationImageEvent(image),
    });
  }
};

const codingConversationImagesFromBody = (
  value: unknown,
  conversationId: string,
): { readonly ok: true; readonly images: ReadonlyArray<CodingConversationImage> }
  | { readonly ok: false; readonly error: string } => {
  if (value === undefined || value === null || value === "") return { ok: true, images: [] };
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ok: false, error: "Images must be a valid JSON array." };
    }
  }
  if (!Array.isArray(candidate) || candidate.length > MAX_CODING_CONVERSATION_IMAGES) {
    return { ok: false, error: `Attach no more than ${MAX_CODING_CONVERSATION_IMAGES} images.` };
  }
  try {
    return {
      ok: true,
      images: candidate.map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("Each image must be an object");
        }
        const image = raw as Readonly<Record<string, unknown>>;
        return createCodingConversationImage({
          conversationId,
          name: typeof image.name === "string" ? image.name : "Attached image",
          mediaType: typeof image.mediaType === "string" ? image.mediaType : "",
          dataUrl: typeof image.dataUrl === "string" ? image.dataUrl : "",
          ...(typeof image.width === "number" ? { width: image.width } : {}),
          ...(typeof image.height === "number" ? { height: image.height } : {}),
        });
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid image attachment.",
    };
  }
};

const codingReviewedSelectionClarification = (
  nodes: ReadonlyArray<WorkspaceNode>,
  error: CodingReviewedSelectionUnavailableError,
) => {
  const human = nodes.find((node) =>
    node.id === CODING_HUMAN_NODE_ID || node.metadata?.participantKind === "human");
  return {
    disposition: "needs_clarification" as const,
    selectedNodeIds: human ? [human.id] : [],
    tags: ["intent:clarification", "risk:reviewer-unavailable"],
    questions: ["Enable or select a saved review-capable workspace node, then retry this request."],
    rationale: error.message,
    confidence: 1,
  };
};

const planConversationTurn = async (input: {
  readonly deps: CodingRouteDeps;
  readonly conversationId: string;
  readonly profile: CodingWorkspaceProfile;
  readonly message: CodingConversationMessage;
  readonly reviewPolicy?: "auto" | "fast" | "reviewed";
  readonly images?: ReadonlyArray<CodingConversationImage>;
  readonly repositoryRoot: string;
  readonly collaborationContext?: CodingConversationCollaborationContext;
  readonly activeRunContext?: CodingConversationActiveRunContext;
  readonly onInformationalDelta?: (
    delta: string,
    responder?: CodingConversationSpeaker,
  ) => void | Promise<void>;
}) => {
  const before = await readRun(input.deps.runtime, input.conversationId);
  const beforeConversation = codingConversationFromEvents(before.events);
  const existingMessage = beforeConversation.messages.find((message) =>
    message.messageId === input.message.messageId);
  const message = existingMessage ?? input.message;
  const recorded = existingMessage
    ? false
    : await publishConversationMessage(input.deps.runtime, message);
  const current = recorded
    ? await readRun(input.deps.runtime, input.conversationId)
    : before;
  const conversation = recorded
    ? codingConversationFromEvents(current.events)
    : beforeConversation;
  const images = [...new Map([
    ...conversation.images,
    ...(input.images ?? []),
  ].map((image) => [image.artifactId, image])).values()];
  const messages = conversation.messages.some((candidate) => candidate.messageId === message.messageId)
    ? conversation.messages
    : [...conversation.messages, message];
  const existingRoute = !recorded
    ? conversation.routes.find((route) => route.inReplyTo === message.messageId)
    : undefined;
  const directResponder = directlyAddressedConversationNode(message, input.profile.nodes);
  const baseRepositoryContext = await (
    input.deps.repositoryContext ?? codingConversationRepositoryContext
  )(input.repositoryRoot);
  const repositoryContext: CodingConversationRepositoryContext = {
    ...baseRepositoryContext,
    fileCount: input.profile.fileCount,
    filesTruncated: input.profile.filesTruncated,
    technologies: input.profile.technologies,
    toolchains: input.profile.toolchains ?? [],
    topLevelAreas: input.profile.topLevelAreas ?? [],
  };
  const priorRoutes = conversation.routes.filter((route) =>
    !route.tags.some((tag) =>
      tag === "risk:planner-unavailable" || tag === "risk:conversation-runtime-unavailable"));
  if (existingRoute && !existingRoute.tags.some((tag) =>
    tag === "risk:planner-unavailable" || tag === "risk:conversation-runtime-unavailable")) {
    const directReply = directResponder
      ? messages.find((candidate) =>
          candidate.replyTo === message.messageId && candidate.author.id === directResponder.id)
        ?? await publishDirectInformationalReply(
          input.deps.runtime,
          message,
          existingRoute,
          directResponder,
        )
      : undefined;
    await publishBoundedInformationalPeerFollowUp({
      deps: input.deps,
      profile: input.profile,
      directReply,
      originalResponder: directResponder,
      messages,
      images,
      routes: priorRoutes,
      repositoryContext,
      repositoryRoot: input.repositoryRoot,
    });
    if (!directResponder) {
      await publishSelectedInformationalReplies({
        deps: input.deps,
        profile: input.profile,
        message,
        route: existingRoute,
        messages,
        images,
        routes: priorRoutes,
        repositoryContext,
        repositoryRoot: input.repositoryRoot,
        ...(input.onInformationalDelta ? { onDelta: input.onInformationalDelta } : {}),
      });
    }
    return {
      route: existingRoute,
      messages,
      objective: codingConversationObjective(messages),
      recorded,
      ...(directReply && directResponder ? { responder: directResponder } : {}),
    };
  }
  const planner = input.deps.conversationPlanner;
  let planned;
  try {
    if (!planner) {
      throw new Error("This Coding route has no configured conversation runtime.");
    }
    planned = await planner({
      conversationId: input.conversationId,
      messages,
      images,
      routes: priorRoutes,
      workspaceNodes: input.profile.nodes,
      repositoryContext,
      repositoryRoot: input.repositoryRoot,
      ...(input.deps.conversationProductContext
        ? { productContext: input.deps.conversationProductContext }
        : {}),
      ...(input.collaborationContext ? { collaborationContext: input.collaborationContext } : {}),
      ...(input.activeRunContext ? { activeRunContext: input.activeRunContext } : {}),
      ...(input.onInformationalDelta ? {
        onDelta: (delta: string) => input.onInformationalDelta?.(delta, directResponder),
      } : {}),
    });
    if (planned.disposition === "informational"
      && input.deps.conversationAnswerer
      && !(input.activeRunContext && planned.answer?.trim())) {
      planned = {
        ...planned,
        answer: await input.deps.conversationAnswerer({
          messages,
          images,
          routes: priorRoutes,
          workspaceNodes: input.profile.nodes,
          ...(directResponder ? { responder: directResponder } : {}),
          repositoryContext,
          ...(input.deps.conversationProductContext
            ? { productContext: input.deps.conversationProductContext }
            : {}),
          ...(input.activeRunContext ? { activeRunContext: input.activeRunContext } : {}),
          ...(input.onInformationalDelta ? {
            onDelta: (delta: string) => input.onInformationalDelta?.(delta, directResponder),
          } : {}),
        }),
      };
    }
    const actionable = planned.disposition === "ready"
      || planned.disposition === "investigating"
      || planned.disposition === "escalated";
    const reviewedRoute = planned.coordination?.reviewMode === "reviewed";
    if (actionable && (input.reviewPolicy === "reviewed" || reviewedRoute)) {
      try {
        const selection = resolveCodingReviewedSelection({
          nodes: input.profile.nodes,
          selectedNodeIds: planned.selectedNodeIds,
          primaryNodeId: planned.primaryNodeId ?? "",
          reviewMode: "reviewed",
        });
        planned = {
          ...planned,
          selectedNodeIds: selection.selectedNodeIds,
          coordination: {
            reviewMode: "reviewed" as const,
            validationScope: planned.coordination?.validationScope ?? "focused",
          },
        };
      } catch (error) {
        if (!(error instanceof CodingReviewedSelectionUnavailableError)) throw error;
        planned = codingReviewedSelectionClarification(input.profile.nodes, error);
      }
    }
    planned = validateCodingConversationPlannerResult(planned, input.profile.nodes);
  } catch (error) {
    const plannerFailure = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/gu, " ")
      .slice(0, 1_000);
    console.error(
      `Coding conversation planner failed for ${input.conversationId}: ${plannerFailure}`,
    );
    const human = input.profile.nodes.find((node) =>
      node.id === CODING_HUMAN_NODE_ID || node.metadata?.participantKind === "human");
    const runtimeFailureClass = codingConversationRuntimeFailureClass(error);
    const runtimeUnavailable = runtimeFailureClass !== undefined;
    const failureRoute = createConversationRouteDecision({
      conversationId: input.conversationId,
      inReplyTo: message.messageId,
      disposition: "needs_clarification",
      selectedNodeIds: human ? [human.id] : [],
      tags: [
        "intent:recovery",
        runtimeUnavailable ? "risk:conversation-runtime-unavailable" : "risk:planner-unavailable",
      ],
      questions: [runtimeUnavailable
        ? "Restore access for the selected conversation runtime or choose another available runtime, then retry this message."
        : "Retry this message after checking the selected conversation runtime."],
      rationale: runtimeUnavailable
        ? `The selected conversation runtime is unavailable (${runtimeFailureClass}).`
        : "The conversation planner could not return a valid coordination decision.",
      confidence: 0,
    });
    await input.deps.runtime.execute(codingRunStream(input.conversationId), {
      type: "emit",
      eventId: `coding-conversation:${failureRoute.routeId}`,
      event: codingConversationRouteEvent(failureRoute),
    });
      throw new CodingConversationPlannerUnavailableError(
      input.conversationId,
      failureRoute,
      error,
    );
  }
  const route = createConversationRouteDecision({
    conversationId: input.conversationId,
    inReplyTo: message.messageId,
    ...planned,
  });
  const event = codingConversationRouteEvent(route);
  await input.deps.runtime.execute(codingRunStream(input.conversationId), {
    type: "emit",
    eventId: `coding-conversation:${route.routeId}`,
    event,
  });
  const directReply = await publishDirectInformationalReply(
    input.deps.runtime,
    message,
    route,
    directResponder,
  );
  await publishBoundedInformationalPeerFollowUp({
    deps: input.deps,
    profile: input.profile,
    directReply,
    originalResponder: directResponder,
    messages,
    images,
    routes: [...priorRoutes, route],
    repositoryContext,
    repositoryRoot: input.repositoryRoot,
  });
  if (!directResponder) {
    await publishSelectedInformationalReplies({
      deps: input.deps,
      profile: input.profile,
      message,
      route,
      messages,
      images,
      routes: [...priorRoutes, route],
      repositoryContext,
      repositoryRoot: input.repositoryRoot,
      ...(input.onInformationalDelta ? { onDelta: input.onInformationalDelta } : {}),
    });
  }
  return {
    route,
    messages,
    objective: codingConversationObjective(messages),
    recorded,
    ...(directReply && directResponder ? { responder: directResponder } : {}),
  };
};

const codingConversationActiveRunContext = (
  state: OrchestrationState,
  job: QueueJob,
  profile: CodingWorkspaceProfile,
): CodingConversationActiveRunContext => {
  const tasks = state.taskGraph?.tasks ?? [];
  const count = (...statuses: ReadonlyArray<string>): number => tasks.filter((task) =>
    statuses.includes(task.status)).length;
  const profileNodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const nodeName = (nodeId: string): string => {
    const node = state.nodes[nodeId] ?? profileNodes.get(nodeId);
    return typeof node?.metadata?.givenName === "string"
      ? node.metadata.givenName
      : node?.name ?? nodeId;
  };
  return {
    runId: codingJobExecutionId(job) ?? String(job.payload.runId ?? job.id),
    jobId: job.id,
    jobStatus: job.status,
    attempt: job.attempt,
    totalTasks: tasks.length,
    readyTasks: count("ready"),
    blockedTasks: count("pending", "waiting"),
    inflightTasks: count("leased", "running"),
    acceptedTasks: count("accepted"),
    failedTasks: count("failed"),
    activeTasks: tasks
      .filter((task) => ["ready", "leased", "running", "waiting"].includes(task.status))
      .slice(0, 12)
      .map((task) => ({
        taskId: task.taskId,
        nodeId: task.nodeId,
        nodeName: nodeName(task.nodeId),
        capability: task.capability,
        status: task.status,
      })),
    latestDurableUpdateAt: Math.max(job.updatedAt, state.taskGraph?.updatedAt ?? 0),
    instruction: "Answer status and progress questions from these durable receipts. Only route a safe-boundary control intent when the message adds, removes, or changes requested work.",
  };
};

const routeActiveCodingConversation = async (input: {
  readonly deps: CodingRouteDeps;
  readonly profile: CodingWorkspaceProfile;
  readonly workspace: CodingRepositoryWorkspace;
  readonly conversationId: string;
  readonly text: string;
  readonly images?: ReadonlyArray<CodingConversationImage>;
  readonly source: CodingConversationSource;
  readonly tags?: ReadonlyArray<string>;
  readonly mentions?: ReadonlyArray<string>;
  readonly replyTo?: string;
  readonly job: QueueJob;
  readonly state: OrchestrationState;
  readonly onInformationalDelta?: (
    delta: string,
    responder?: CodingConversationSpeaker,
  ) => void | Promise<void>;
}) => {
  const images = input.images ?? [];
  if (images.length > 0) await publishConversationImages(input.deps.runtime, images);
  const message = createCodingConversationMessage({
    conversationId: input.conversationId,
    workspaceId: input.workspace.id,
    author: { kind: "user", id: CODING_HUMAN_NODE_ID, name: "You" },
    source: input.source,
    text: input.text,
    tags: [...new Set([...(input.tags ?? []), "delivery:queued"])],
    mentions: input.mentions,
    attachments: images,
    replyTo: input.replyTo,
  });
  const planned = await planConversationTurn({
    deps: input.deps,
    conversationId: input.conversationId,
    profile: input.profile,
    message,
    images,
    reviewPolicy: input.job.payload.reviewPolicy === "reviewed" ? "reviewed" : "auto",
    repositoryRoot: input.workspace.repositoryRoot,
    activeRunContext: codingConversationActiveRunContext(input.state, input.job, input.profile),
    onInformationalDelta: input.onInformationalDelta,
  });
  const actionable = planned.route.disposition === "ready"
    || planned.route.disposition === "investigating"
    || planned.route.disposition === "escalated";
  if (!actionable) {
    return {
      disposition: planned.route.disposition,
      duplicate: !planned.recorded,
      message,
      route: planned.route,
      ...(planned.responder ? { responder: planned.responder } : {}),
    };
  }
  if (!input.deps.roomControl) {
    throw new Error("Room OS control-intent persistence is unavailable.");
  }
  const commandPayload = {
    schema: "coding-control-command/v1",
    workspaceId: input.workspace.id,
    conversationId: input.conversationId,
    runId: codingJobExecutionId(input.job) ?? input.conversationId,
    messageId: message.messageId,
    jobId: input.job.id,
    jobAttempt: input.job.attempt,
    problem: message.text,
    message,
  };
  await input.deps.roomControl.queueIntent({
    roomId: codingJobRoomId(input.conversationId, input.job),
    intentId: message.messageId,
    kind: "follow_up",
    payloadJson: JSON.stringify(commandPayload),
  });
  const command = await input.deps.queue.queueCommand({
    commandId: `coding_command_${hashCanonical(commandPayload).slice(0, 28)}`,
    jobId: input.job.id,
    command: "steer",
    payload: commandPayload,
    by: message.source.kind,
  });
  if (!command) throw new Error("The coding run finished before the follow-up could be delivered.");
  return {
    disposition: "running" as const,
    routeDisposition: planned.route.disposition,
    duplicate: !planned.recorded,
    message,
    route: planned.route,
    command,
  };
};

const conversationSourceFromBody = (
  body: Readonly<Record<string, unknown>> | undefined,
  fallback: "ui" | "api" = "api",
): CodingConversationSource => {
  const candidate = body?.source;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { kind: fallback };
  const source = candidate as Readonly<Record<string, unknown>>;
  const kind = source.kind === "ui" || source.kind === "api" || source.kind === "pr-comment"
    || source.kind === "review-comment" || source.kind === "agent"
    ? source.kind
    : fallback;
  const optional = (key: string, max: number): string | undefined =>
    typeof source[key] === "string" && source[key].trim() ? source[key].trim().slice(0, max) : undefined;
  return {
    kind,
    ...(optional("provider", 80) ? { provider: optional("provider", 80) } : {}),
    ...(optional("repository", 500) ? { repository: optional("repository", 500) } : {}),
    ...(optional("externalId", 500) ? { externalId: optional("externalId", 500) } : {}),
    ...(optional("revision", 160) ? { revision: optional("revision", 160) } : {}),
    ...(optional("url", 2_000) ? { url: optional("url", 2_000) } : {}),
  };
};

const stringList = (value: unknown, max = 24): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, max)
    : [];

const humanCollaborationContext = (
  resolution: ReturnType<typeof parseCodingPeerResolution>,
): CodingConversationCollaborationContext | undefined => resolution?.status === "ambiguous"
  ? {
      stage: "awaiting_human",
      summary: resolution.summary,
      decisions: resolution.decisions.map((decision) => ({
        subjectId: decision.subjectId,
        resolution: decision.resolution,
        rationale: decision.rationale,
        evidence: [...decision.evidence],
      })),
      unresolved: resolution.unresolved.map((item) => ({
        subjectId: item.subjectId,
        reason: item.reason,
        candidateSummaries: item.candidateSummaries,
      })),
    }
  : undefined;

const createAndPlanConversation = async (input: {
  readonly deps: CodingRouteDeps;
  readonly profile: CodingWorkspaceProfile;
  readonly conversationId?: string;
  readonly executionRunId?: string;
  readonly text: string;
  readonly images?: ReadonlyArray<CodingConversationImage>;
  readonly source: CodingConversationSource;
  readonly tags?: ReadonlyArray<string>;
  readonly mentions?: ReadonlyArray<string>;
  readonly replyTo?: string;
  readonly reviewPolicy: "auto" | "fast" | "reviewed";
  /** Explicit API runtime override; otherwise resolve from the selected logical node. */
  readonly workerRuntimeOverride?: CodingWorkerRuntime;
  /** Explicit authenticated API authority for public-registry dependency resolution. */
  readonly dependencyResolution?: "registry";
  readonly workspace: CodingRepositoryWorkspace;
  readonly onInformationalDelta?: (
    delta: string,
    responder?: CodingConversationSpeaker,
  ) => void | Promise<void>;
  readonly collaborationContext?: CodingConversationCollaborationContext;
}) => {
  const conversationId = input.conversationId ?? newCodingConversationId();
  const images = input.images ?? [];
  if (images.length > 0) await publishConversationImages(input.deps.runtime, images);
  const message = createCodingConversationMessage({
    conversationId,
    workspaceId: input.workspace.id,
    author: { kind: "user", id: CODING_HUMAN_NODE_ID, name: "You" },
    source: input.source,
    text: input.text,
    tags: input.tags,
    mentions: input.mentions,
    attachments: images,
    replyTo: input.replyTo,
  });
  const planned = await planConversationTurn({
    deps: input.deps,
    conversationId,
    profile: input.profile,
    message,
    images,
    reviewPolicy: input.reviewPolicy,
    repositoryRoot: input.workspace.repositoryRoot,
    ...(input.collaborationContext ? { collaborationContext: input.collaborationContext } : {}),
    onInformationalDelta: input.onInformationalDelta,
  });
  if (planned.route.disposition !== "ready"
    && planned.route.disposition !== "investigating"
    && planned.route.disposition !== "escalated") {
    return {
      conversationId,
      message,
      route: planned.route,
      objective: planned.objective,
      ...(planned.responder ? { responder: planned.responder } : {}),
    };
  }
  const { workerRuntime, workerModel, selectionSource } = await resolveCodingWorkerSelection(
    input.deps.runtime,
    input.workspace.id,
    {
      ...(planned.route.primaryNodeId ? { nodeId: planned.route.primaryNodeId } : {}),
      ...(input.workerRuntimeOverride ? { override: input.workerRuntimeOverride } : {}),
      ...(input.deps.defaultWorkerRuntime
        ? { defaultRuntime: input.deps.defaultWorkerRuntime }
        : {}),
    },
  );
  if (input.dependencyResolution && (
    input.workerRuntimeOverride !== "codex-cli"
    || workerRuntime !== "codex-cli"
    || selectionSource !== "api-override"
  )) {
    throw new Error("dependencyResolution requires an explicit authenticated codex-cli API override");
  }
  const { job } = await enqueueCodingRun(
    input.deps,
    planned.objective,
    input.reviewPolicy,
    workerRuntime,
    {
      runId: input.executionRunId ?? conversationId,
      conversationId,
      selectedNodeIds: planned.route.selectedNodeIds,
      primaryNodeId: planned.route.primaryNodeId,
      coordination: planned.route.coordination,
      conversationTags: planned.route.tags,
      executionKind: planned.route.disposition === "investigating" ? "investigation" : "mutation",
      ...(workerModel ? { workerModel } : {}),
      selectionSource,
      ...(input.dependencyResolution ? {
        dependencyResolution: input.dependencyResolution,
      } : {}),
      ...(input.collaborationContext ? {
        humanResolution: resolveCodingPeerAmbiguityWithHumanAnswer({
          status: "ambiguous",
          summary: input.collaborationContext.summary,
          decisions: input.collaborationContext.decisions.map((decision) => ({
            ...decision,
            evidence: [...decision.evidence],
          })),
          unresolved: input.collaborationContext.unresolved.map((subject) => ({
            ...subject,
            candidateSummaries: [...subject.candidateSummaries],
          })),
        }, input.text),
      } : {}),
      workspace: input.workspace,
      continuityNodes: input.profile.nodes,
      continuitySource: {
        deliveryId: message.messageId,
        sourceId: message.messageId,
        sourceVersion: planned.route.routeId,
        sourceHash: hashCanonical({ message, route: planned.route }),
        deliveredAt: message.createdAt,
      },
    },
  );
  return { conversationId, message, route: planned.route, objective: planned.objective, job };
};

const createWorkspaceRescanConversation = async (input: {
  readonly deps: CodingRouteDeps;
  readonly profile: CodingWorkspaceProfile;
  readonly conversationId: string;
  readonly text: string;
  readonly source: CodingConversationSource;
  readonly workspace: CodingRepositoryWorkspace;
}) => {
  const message = createCodingConversationMessage({
    conversationId: input.conversationId,
    workspaceId: input.workspace.id,
    author: { kind: "user", id: CODING_HUMAN_NODE_ID, name: "You" },
    source: input.source,
    text: input.text,
  });
  const recorded = await publishConversationMessage(input.deps.runtime, message);
  const current = await readRun(input.deps.runtime, input.conversationId);
  const conversation = codingConversationFromEvents(current.events);
  const queued = await enqueueWorkspaceRescan({
    deps: input.deps,
    workspace: input.workspace,
    objective: input.text,
    conversationId: input.conversationId,
    requestIdentity: message.messageId,
  });
  const existingRoute = !recorded
    ? conversation.routes.find((route) => route.inReplyTo === message.messageId)
    : undefined;
  if (existingRoute) {
    return {
      conversationId: input.conversationId,
      activeRunId: queued.runId,
      message,
      route: existingRoute,
      objective: codingConversationObjective(conversation.messages),
      job: queued.job,
      rescanStatus: queued.status,
    };
  }
  const selectedNodeIds = queued.status === "conflict"
    ? []
    : input.profile.nodes
        .filter((node) => node.metadata?.participantKind !== "human")
        .map((node) => node.id)
        .slice(0, 12);
  const managementPrimaryNodeId = input.profile.nodes.find((node) =>
    selectedNodeIds.includes(node.id) && node.capabilities.includes("implement"))?.id;
  if (queued.status !== "conflict" && !managementPrimaryNodeId) {
    throw new Error("A tracked workspace rescan requires the saved implementation node");
  }
  const route = createConversationRouteDecision({
    conversationId: input.conversationId,
    inReplyTo: message.messageId,
    disposition: queued.status === "conflict" ? "declined" : "ready",
    selectedNodeIds,
    ...(managementPrimaryNodeId ? {
      primaryNodeId: managementPrimaryNodeId,
      coordination: { reviewMode: "reviewed", validationScope: "focused" },
    } : {}),
    tags: ["intent:workspace-scan", "run:workspace-rescan"],
    questions: [],
    rationale: queued.status === "conflict"
      ? "A different team rescan is already active. Open the active tracked objective to follow its progress."
      : queued.status === "duplicate"
        ? "This exact team rescan request already exists; opening its tracked management objective."
        : "Queued the read-only workspace rescan as a visible tracked management objective.",
    confidence: 1,
  });
  await input.deps.runtime.execute(codingRunStream(input.conversationId), {
    type: "emit",
    eventId: `coding-conversation:${route.routeId}`,
    event: codingConversationRouteEvent(route),
  });
  return {
    conversationId: input.conversationId,
    activeRunId: queued.runId,
    message,
    route,
    objective: codingConversationObjective(conversation.messages),
    job: queued.job,
    rescanStatus: queued.status,
  };
};

const boundedGitPatch = async (workingDirectory = process.cwd()): Promise<{
  readonly text: string;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly truncated: boolean;
}> => new Promise((resolvePatch, rejectPatch) => {
  const child = spawn("git", [
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--binary",
    "HEAD",
    "--",
  ], {
    cwd: workingDirectory,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  let bytes = 0;
  let errorBytes = 0;
  let truncated = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 3_000);
  child.stdout.on("data", (value: Buffer) => {
    const remaining = CODING_DIFF_MAX_BYTES - bytes;
    if (remaining > 0) {
      const selected = value.subarray(0, remaining);
      chunks.push(selected);
      bytes += selected.length;
    }
    if (value.length > remaining) {
      truncated = true;
      child.kill();
    }
  });
  child.stderr.on("data", (value: Buffer) => {
    const remaining = 32_768 - errorBytes;
    if (remaining <= 0) return;
    const selected = value.subarray(0, remaining);
    errors.push(selected);
    errorBytes += selected.length;
  });
  child.once("error", (error) => {
    clearTimeout(timeout);
    rejectPatch(error);
  });
  child.once("close", (code) => {
    clearTimeout(timeout);
    if (timedOut) return rejectPatch(new Error("Git diff timed out"));
    if (code !== 0 && !truncated) {
      return rejectPatch(new Error(Buffer.concat(errors).toString("utf8") || "Git diff failed"));
    }
    resolvePatch({
      text: Buffer.concat(chunks).toString("utf8"),
      bytes,
      maxBytes: CODING_DIFF_MAX_BYTES,
      truncated,
    });
  });
});

const gitDiffSummary = async (
  workingDirectory = process.cwd(),
  scope: "checkout" | "run" = "checkout",
  runId?: string,
) => {
  const runGit = async (args: ReadonlyArray<string>): Promise<string> => {
    const result = await execFileAsync("git", [...args], {
      cwd: workingDirectory,
      timeout: 3_000,
      maxBuffer: 262_144,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return result.stdout;
  };
  const [root, summary, status, patch] = await Promise.all([
    runGit(["rev-parse", "--show-toplevel"]),
    runGit(["--no-pager", "diff", "--no-ext-diff", "--no-renames", "--shortstat", "HEAD", "--"]),
    runGit(["--no-pager", "status", "--porcelain=v1", "--no-renames", "--untracked-files=all", "-z"]),
    boundedGitPatch(workingDirectory),
  ]);
  const entries = status.split("\0").filter(Boolean);
  const limit = 500;
  return {
    schema: CODING_API_SCHEMA,
    scope,
    ...(runId ? { runId } : {}),
    repositoryRoot: root.trim(),
    dirty: entries.length > 0,
    summary: summary.trim(),
    files: entries.slice(0, limit).map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) })),
    truncated: entries.length > limit,
    patch,
  };
};

const runPatchSummary = async (runId: string, repositoryRoot = codingRepositoryRoot()) => {
  const root = resolve(repositoryRoot);
  const paths = gitRunWorkspacePaths(root, runId);
  if (await gitRunWorkspaceExists(root, runId)) {
    return gitDiffSummary(paths.workspace, "run", runId);
  }
  const fullPatch = await readGitRunPatch(root, runId) ?? "";
  const bytes = Buffer.byteLength(fullPatch);
  const text = Buffer.from(fullPatch).subarray(0, CODING_DIFF_MAX_BYTES).toString("utf8");
  const filePaths = [...fullPatch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
    .map((match) => match[2] ?? match[1])
    .filter((path): path is string => Boolean(path));
  return {
    schema: CODING_API_SCHEMA,
    scope: "run" as const,
    runId,
    repositoryRoot: root,
    dirty: bytes > 0,
    summary: filePaths.length > 0 ? `${filePaths.length} file${filePaths.length === 1 ? "" : "s"} changed` : "",
    files: filePaths.slice(0, 500).map((path) => ({ status: "M", path })),
    truncated: filePaths.length > 500,
    patch: {
      text,
      bytes: Math.min(bytes, CODING_DIFF_MAX_BYTES),
      maxBytes: CODING_DIFF_MAX_BYTES,
      truncated: bytes > CODING_DIFF_MAX_BYTES,
    },
  };
};

const configuredCodingOperatorAuthority = (): string => {
  const configured = process.env.ROSTER_API_TOKEN;
  return configured
    ? `api-token:${createHash("sha256").update(configured).digest("hex")}`
    : "local-trust";
};

const authenticatedApiOverride = (authorization: string | undefined): boolean =>
  Boolean(process.env.ROSTER_API_TOKEN) && validRosterApiToken(authorization);

export const createCodingRoute = (deps: CodingRouteDeps): AgentRouteModule => ({
  id: "coding-agent",
  kind: "coding",
  paths: {
    shell: "/coding",
    run: "/coding/run",
    apiRuns: `${CODING_API_BASE}/runs`,
    apiRooms: `${CODING_API_BASE}/rooms`,
    apiDiff: `${CODING_API_BASE}/diff`,
    workspaceScan: "/coding/workspace/scan",
    apiWorkspace: `${CODING_API_BASE}/workspace`,
    runtimeLogs: "/coding/runtime-logs",
    roomUpdates: "/coding/room-updates",
    realtimeSession: "/coding/realtime-session",
  },
  register: (app: Hono) => {
    const teamRefreshFlashes = codingTeamRefreshFlashStore();
    const workspaceSettingsFlashes = codingWorkspaceSettingsFlashStore();
    const pageSessions = codingPageSessionStore(deps.pageSessionNow);
    const authorizeCodingPageRun = async (input: {
      readonly token: string | undefined;
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly jobId: string;
      readonly executionId: string;
      readonly requireActiveJob: boolean;
    }): Promise<{
      readonly authorized: true;
      readonly session: CodingPageSession;
      readonly job: QueueJob;
    } | {
      readonly authorized: false;
      readonly status: 401 | 404 | 503;
    }> => {
      if (!deps.realtime) return { authorized: false, status: 503 };
      const session = pageSessions.read(input.token);
      if (!session || session.operatorAuthority !== configuredCodingOperatorAuthority()) {
        return { authorized: false, status: 401 };
      }
      if (
        session.workspaceId !== input.workspaceId
        || session.controlWorkspaceId !== deps.realtime.workspaceId
        || session.conversationId !== input.conversationId
        || session.jobId !== input.jobId
        || session.executionId !== input.executionId
      ) {
        return { authorized: false, status: 404 };
      }
      const job = await findCodingJob(
        deps.queue,
        input.conversationId,
        input.jobId,
        input.workspaceId,
      );
      if (
        !job
        || codingJobExecutionId(job) !== input.executionId
        || codingJobRoomId(input.conversationId, job) !== session.roomId
        || (input.requireActiveJob && !activeCodingRoomUpdateJob(job))
      ) {
        return { authorized: false, status: 404 };
      }
      return { authorized: true, session, job };
    };
    const access = createRosterHttpAccess();
    app.use("/coding", access);
    app.use("/coding/*", access);
    app.use(`${CODING_API_BASE}/*`, access);

    app.post(`${CODING_API_BASE}/realtime-sessions`, async (c) => {
      c.header("Cache-Control", "private, no-store");
      if (!deps.realtime || !deps.realtimeSession) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding realtime is unavailable" }, 503);
      }
      const body = await jsonObject(c.req);
      const workspaceId = safeWorkspaceId(body?.workspaceId);
      const conversationId = typeof body?.conversationId === "string" ? safeRunId(body.conversationId) : undefined;
      const requestedJobId = typeof body?.jobId === "string" ? safeRunId(body.jobId) : undefined;
      const executionId = typeof body?.executionId === "string" ? safeRunId(body.executionId) : undefined;
      if (!workspaceId || !conversationId || !requestedJobId || !executionId) {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "valid workspaceId, conversationId, jobId, and executionId are required",
        }, 400);
      }
      const job = await findCodingJob(deps.queue, conversationId, requestedJobId, workspaceId);
      if (!job || codingJobExecutionId(job) !== executionId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding job not found" }, 404);
      }
      const roomId = codingJobRoomId(conversationId, job);
      const grant = await deps.realtimeSession({
        workspaceId,
        controlWorkspaceId: deps.realtime.workspaceId,
        roomId,
        conversationId,
        jobId: job.id,
        executionId,
      });
      return c.json({
        schema: CODING_API_SCHEMA,
        ok: true,
        sessionId: grant.capabilityId,
        workspaceId,
        controlWorkspaceId: deps.realtime.workspaceId,
        roomId,
        conversationId,
        executionId,
        jobId: job.id,
        uri: grant.uri,
        database: grant.database,
        confirmedReads: grant.confirmedReads,
        capabilitySecret: grant.capabilitySecret,
        expiresAt: grant.expiresAt,
      });
    });

    app.post("/coding/realtime-session", async (c) => {
      c.header("Cache-Control", "private, no-store");
      if (!deps.realtime || !deps.realtimeSession) {
        return c.json({ ok: false, error: "coding realtime is unavailable" }, 503);
      }
      const pageSessionToken = cookieValue(c.req.header("Cookie"), CODING_PAGE_SESSION_COOKIE);
      const session = pageSessions.read(pageSessionToken);
      const operatorAuthority = configuredCodingOperatorAuthority();
      if (!session || session.operatorAuthority !== operatorAuthority) {
        return c.json({ ok: false, error: "unauthorized" }, 401);
      }
      const requestUrl = new URL(c.req.url);
      if (c.req.header("Origin") !== requestUrl.origin || c.req.header("Sec-Fetch-Site") !== "same-origin") {
        return c.json({ ok: false, error: "forbidden" }, 403);
      }
      const body = await jsonObject(c.req);
      const workspaceId = safeWorkspaceId(body?.workspaceId);
      const conversationId = typeof body?.conversationId === "string" ? safeRunId(body.conversationId) : undefined;
      const requestedJobId = typeof body?.jobId === "string" ? safeRunId(body.jobId) : undefined;
      const executionId = typeof body?.executionId === "string" ? safeRunId(body.executionId) : undefined;
      if (!workspaceId || !conversationId || !requestedJobId || !executionId) {
        return c.json({ ok: false, error: "valid workspaceId, conversationId, jobId, and executionId are required" }, 400);
      }
      if (workspaceId !== session.workspaceId
        || session.controlWorkspaceId !== deps.realtime.workspaceId
        || conversationId !== session.conversationId
        || requestedJobId !== session.jobId
        || executionId !== session.executionId) {
        return c.json({ ok: false, error: "coding run not found" }, 404);
      }
      const job = await findCodingJob(deps.queue, conversationId, requestedJobId, session.workspaceId);
      const roomId = job ? codingJobRoomId(conversationId, job) : undefined;
      if (!job || codingJobExecutionId(job) !== executionId || roomId !== session.roomId) {
        return c.json({ ok: false, error: "coding run not found" }, 404);
      }
      const grant = await deps.realtimeSession({
        workspaceId,
        controlWorkspaceId: session.controlWorkspaceId,
        roomId,
        conversationId,
        jobId: job.id,
        executionId,
      });
      const rotatedPageSession = pageSessions.rotate(pageSessionToken, configuredCodingOperatorAuthority());
      if (!rotatedPageSession) {
        return c.json({ ok: false, error: "unauthorized" }, 401);
      }
      c.header("Set-Cookie", codingPageSessionCookie(rotatedPageSession.token, c.req.url));
      return c.json({
        ok: true,
        workspaceId,
        controlWorkspaceId: session.controlWorkspaceId,
        capabilitySecret: grant.capabilitySecret,
        expiresAt: grant.expiresAt,
        pageSessionExpiresAt: rotatedPageSession.expiresAt,
      });
    });

    app.get("/coding/runtime-logs", async (c) => {
      c.header("Cache-Control", "private, no-store");
      const runId = safeRunId(c.req.query("run"));
      const conversationId = safeRunId(c.req.query("conversation"));
      const jobId = safeRunId(c.req.query("job"));
      const workspaceId = safeWorkspaceId(c.req.query("workspace"));
      const afterValue = Number(c.req.query("after") ?? "0");
      if (!runId || !conversationId || !jobId || !workspaceId
        || !Number.isSafeInteger(afterValue) || afterValue < 0) {
        return text(400, "Invalid coding runtime log stream.");
      }
      const pageSessionToken = cookieValue(c.req.header("Cookie"), CODING_PAGE_SESSION_COOKIE);
      const admission = await authorizeCodingPageRun({
        token: pageSessionToken,
        workspaceId,
        conversationId,
        jobId,
        executionId: runId,
        requireActiveJob: false,
      });
      if (!admission.authorized) {
        return admission.status === 401
          ? text(401, "Unauthorized.")
          : admission.status === 503
            ? text(503, "Coding stream authority is unavailable.")
            : text(404, "Coding run not found.");
      }
      const runtimeLogs = deps.runtimeLogs;
      if (!runtimeLogs) return text(503, "Coding runtime diagnostics are unavailable.");

      c.header("Content-Type", "application/x-ndjson; charset=utf-8");
      c.header("X-Accel-Buffering", "no");
      return stream(c, async (output) => {
        let cursor = afterValue;
        let stopped = false;
        let wake: (() => void) | undefined;
        const pending = new NodeRuntimeLogPendingBuffer();
        const unsubscribeSubscription = runtimeLogs.subscribe(runId, (entry) => {
          if (entry.sequence <= cursor) return;
          pending.push(entry);
          wake?.();
          wake = undefined;
        });
        let subscribed = true;
        const unsubscribe = (): void => {
          if (!subscribed) return;
          subscribed = false;
          unsubscribeSubscription();
        };
        const stop = (): void => {
          if (stopped) return;
          stopped = true;
          unsubscribe();
          pending.clear();
          wake?.();
          wake = undefined;
        };
        const activeAuthorizedPage = async (): Promise<boolean> =>
          (await authorizeCodingPageRun({
            token: pageSessionToken,
            workspaceId,
            conversationId,
            jobId,
            executionId: runId,
            requireActiveJob: false,
          })).authorized;
        for (const entry of runtimeLogs.list(runId)) {
          if (entry.sequence > cursor) pending.push(entry);
        }
        output.onAbort(stop);
        try {
          while (!stopped) {
            const entry = pending.shift();
            if (entry) {
              if (entry.sequence <= cursor) continue;
              if (!await activeAuthorizedPage()) {
                stop();
                break;
              }
              cursor = Math.max(cursor, entry.sequence);
              await output.write(`${JSON.stringify({ type: "log", entry })}\n`);
              continue;
            }
            await Promise.race([
              new Promise<void>((resolve) => { wake = resolve; }),
              output.sleep(15_000),
            ]);
            if (!stopped && pending.size === 0) {
              if (!await activeAuthorizedPage()) {
                stop();
                break;
              }
              await output.write(`${JSON.stringify({ type: "heartbeat", at: Date.now() })}\n`);
            }
          }
        } finally {
          stop();
        }
      });
    });

    app.get("/coding/room-updates", async (c) => {
      c.header("Cache-Control", "private, no-store");
      const runId = safeRunId(c.req.query("run"));
      const conversationId = safeRunId(c.req.query("conversation"));
      const jobId = safeRunId(c.req.query("job"));
      const workspaceId = safeWorkspaceId(c.req.query("workspace"));
      if (!runId || !conversationId || !jobId || !workspaceId) {
        return text(400, "Invalid coding room update stream.");
      }
      const pageSessionToken = cookieValue(c.req.header("Cookie"), CODING_PAGE_SESSION_COOKIE);
      const admission = await authorizeCodingPageRun({
        token: pageSessionToken,
        workspaceId,
        conversationId,
        jobId,
        executionId: runId,
        requireActiveJob: true,
      });
      if (!admission.authorized) {
        return admission.status === 401
          ? text(401, "Unauthorized.")
          : admission.status === 503
            ? text(503, "Coding stream authority is unavailable.")
            : text(404, "Coding run not found.");
      }
      const roomUpdates = deps.roomUpdates ?? codingRoomUpdates;

      c.header("Content-Type", "application/x-ndjson; charset=utf-8");
      c.header("X-Accel-Buffering", "no");
      return stream(c, async (output) => {
        let stopped = false;
        let wake: (() => void) | undefined;
        let wakeJobMonitor: (() => void) | undefined;
        const pending = new Map<string, NodeRoomUpdateStoreEvent>();
        const receive = (event: NodeRoomUpdateStoreEvent): void => {
          const next = { type: event.type, update: publicCodingRoomUpdate(event.update) };
          const existing = pending.get(next.update.updateId);
          if (existing && (
            existing.update.sequence > next.update.sequence
            || (
              existing.update.sequence === next.update.sequence
              && existing.type === "settled"
              && next.type === "update"
            )
          )) return;
          pending.delete(next.update.updateId);
          pending.set(next.update.updateId, next);
          if (pending.size > CODING_ROOM_UPDATE_PENDING_LIMIT) {
            const oldest = [...pending.values()].sort((left, right) =>
              (left.update.sequence - right.update.sequence)
              || left.update.updateId.localeCompare(right.update.updateId))[0];
            if (oldest) pending.delete(oldest.update.updateId);
          }
          wake?.();
          wake = undefined;
        };
        const unsubscribeSubscription = deps.roomUpdates
          ? deps.roomUpdates.subscribe(runId, receive)
          : codingRoomUpdates.subscribe(runId, receive);
        let subscribed = true;
        const unsubscribe = (): void => {
          if (!subscribed) return;
          subscribed = false;
          unsubscribeSubscription();
        };
        const stop = (): void => {
          if (stopped) return;
          stopped = true;
          unsubscribe();
          wake?.();
          wake = undefined;
          wakeJobMonitor?.();
          wakeJobMonitor = undefined;
        };
        const activeAuthorizedJob = async (): Promise<boolean> =>
          (await authorizeCodingPageRun({
            token: pageSessionToken,
            workspaceId,
            conversationId,
            jobId,
            executionId: runId,
            requireActiveJob: true,
          })).authorized;
        const waitForJobMonitorInterval = async (startedAt: number): Promise<void> => {
          const remaining = CODING_ROOM_UPDATE_JOB_RECHECK_MS - (Date.now() - startedAt);
          if (stopped || remaining <= 0) return;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, remaining);
            wakeJobMonitor = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wakeJobMonitor = undefined;
        };
        output.onAbort(stop);
        void (async () => {
          while (!stopped) {
            const startedAt = Date.now();
            const current = await deps.queue.waitForJob(
              jobId,
              CODING_ROOM_UPDATE_JOB_RECHECK_MS,
              CODING_ROOM_UPDATE_JOB_RECHECK_MS,
            );
            if (stopped) return;
            if (!current || !isCodingJob(current)
              || codingJobConversationId(current) !== conversationId
              || codingJobWorkspaceId(current) !== workspaceId
              || codingJobExecutionId(current) !== runId
              || !activeCodingRoomUpdateJob(current)) {
              stop();
              return;
            }
            await waitForJobMonitorInterval(startedAt);
          }
        })().catch(stop);
        try {
          const snapshot = roomUpdates.list(runId)
            .map(publicCodingRoomUpdate)
            .sort((left, right) => (left.sequence - right.sequence)
              || left.updateId.localeCompare(right.updateId));
          const snapshotByUpdateId = new Map(snapshot.map((update) => [update.updateId, update]));
          for (const event of pending.values()) {
            const snapshotted = snapshotByUpdateId.get(event.update.updateId);
            const covered = event.type === "settled"
              ? snapshotted?.settled === true && snapshotted.sequence >= event.update.sequence
              : snapshotted !== undefined && snapshotted.sequence >= event.update.sequence;
            if (covered) pending.delete(event.update.updateId);
          }
          const snapshotAuthorized = await activeAuthorizedJob();
          if (stopped || !snapshotAuthorized) {
            stop();
            return;
          }
          await output.write(`${JSON.stringify({ type: "snapshot", updates: snapshot })}\n`);
          while (!stopped) {
            const event = [...pending.values()].sort((left, right) =>
              (left.update.sequence - right.update.sequence)
              || left.update.updateId.localeCompare(right.update.updateId))[0];
            if (event) {
              pending.delete(event.update.updateId);
              const eventAuthorized = await activeAuthorizedJob();
              if (stopped || !eventAuthorized) {
                stop();
                break;
              }
              await output.write(`${JSON.stringify({
                type: event.type,
                update: publicCodingRoomUpdate(event.update),
              })}\n`);
              continue;
            }
            await new Promise<void>((resolve) => {
              const heartbeat = setTimeout(resolve, 15_000);
              wake = () => {
                clearTimeout(heartbeat);
                resolve();
              };
            });
            wake = undefined;
            if (stopped) break;
            const heartbeatAuthorized = await activeAuthorizedJob();
            if (pending.size > 0) continue;
            if (stopped || !heartbeatAuthorized) {
              stop();
              break;
            }
            await output.write(`${JSON.stringify({ type: "heartbeat", at: Date.now() })}\n`);
          }
        } finally {
          stop();
        }
      });
    });

    app.get(`${CODING_API_BASE}/runtimes`, async (c) => {
      try {
        const requestedWorkspaceId = safeWorkspaceId(c.req.query("workspace"));
        if (c.req.query("workspace") && !requestedWorkspaceId) {
          return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid workspace id" }, 400);
        }
        const workspace = requestedWorkspaceId
          ? await resolveCodingWorkspace(deps.runtime, requestedWorkspaceId)
          : undefined;
        if (requestedWorkspaceId && !workspace) {
          return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workspace not found" }, 404);
        }
        const runtimes = await (deps.runtimeDiscovery?.(workspace?.repositoryRoot)
          ?? discoverCodingRuntimeOnboardingOptions(
            process.env,
            process.platform,
            undefined,
            workspace?.repositoryRoot,
          ));
        c.header("Cache-Control", "no-store");
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: true,
          runtimes,
        });
      } catch {
        c.header("Cache-Control", "no-store");
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "runtime discovery unavailable",
        }, 503);
      }
    });

    app.post(`${CODING_API_BASE}/runs`, async (c) => {
      const body = await jsonObject(c.req);
      const objective = typeof body?.objective === "string" ? body.objective.trim() : "";
      if (!objective || objective.length > 20_000) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "objective must be between 1 and 20,000 characters" }, 400);
      }
      const requestedWorkspaceId = safeWorkspaceId(body?.workspaceId);
      if (body?.workspaceId !== undefined && !requestedWorkspaceId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid workspace id" }, 400);
      }
      const selectedWorkspace = await resolveCodingWorkspace(deps.runtime, requestedWorkspaceId);
      if (!selectedWorkspace) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workspace not found" }, 404);
      }
      if (body?.workingDirectory !== undefined && (
        typeof body.workingDirectory !== "string"
        || resolve(body.workingDirectory) !== selectedWorkspace.repositoryRoot
      )) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workingDirectory must match the selected workspace" }, 400);
      }
      const reviewPolicy = codingReviewPolicy(body?.reviewPolicy);
      if (!reviewPolicy) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "reviewPolicy must be auto, fast, or reviewed" }, 400);
      }
      const workerRuntimeOverride = codingWorkerRuntime(body?.workerRuntime);
      if (body?.workerRuntime !== undefined && !workerRuntimeOverride) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workerRuntime must be claude-code, codex-cli, pi-agent, or hermes-agent" }, 400);
      }
      const dependencyResolution = codingDependencyResolution(body?.dependencyResolution);
      if (dependencyResolution && !authenticatedApiOverride(c.req.header("Authorization"))) {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "dependencyResolution requires authenticated API override authority",
        }, 403);
      }
      if (body?.dependencyResolution !== undefined && (
        !dependencyResolution || workerRuntimeOverride !== "codex-cli"
      )) {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "dependencyResolution must be registry with an explicit codex-cli workerRuntime override",
        }, 400);
      }
      const workspace = await readCodingWorkspace(deps.runtime, selectedWorkspace);
      if (!workspace.profile) {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "scan this repository and create the workspace agents before starting a change",
          workspace: { scanned: false, scanEndpoint: `${CODING_API_BASE}/workspace/scan` },
        }, 409);
      }
      const requestedConversationId = typeof body?.conversationId === "string"
        ? safeRunId(body.conversationId)
        : undefined;
      if (body?.conversationId !== undefined && !requestedConversationId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid conversation id" }, 400);
      }
      const turnConversationId = requestedConversationId ?? newCodingConversationId();
      const parsedImages = codingConversationImagesFromBody(body?.images, turnConversationId);
      if (!parsedImages.ok) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: parsedImages.error }, 400);
      }
      if (requestedConversationId) {
        const existingJob = await findCodingJob(deps.queue, requestedConversationId, undefined, selectedWorkspace.id);
        if (existingJob) {
          c.header("Cache-Control", "no-store");
          return c.json({
            schema: CODING_API_SCHEMA,
            ok: true,
            runId: requestedConversationId,
            conversationId: requestedConversationId,
            disposition: ["completed", "failed", "canceled"].includes(existingJob.status) ? "terminal" : "running",
            duplicate: true,
            workspace: workspaceDto(workspace.profile),
            job: codingJobDto(existingJob),
          }, 200);
        }
      }
      let result;
      try {
        result = await createAndPlanConversation({
          deps,
          profile: workspace.profile,
          conversationId: turnConversationId,
          text: objective,
          images: parsedImages.images,
          source: conversationSourceFromBody(body),
          tags: stringList(body?.tags),
          mentions: stringList(body?.mentions, 12),
          ...(typeof body?.replyTo === "string" ? { replyTo: body.replyTo.slice(0, 200) } : {}),
          reviewPolicy,
          ...(workerRuntimeOverride ? { workerRuntimeOverride } : {}),
          ...(dependencyResolution ? { dependencyResolution } : {}),
          workspace: selectedWorkspace,
        });
      } catch (error) {
        if (!(error instanceof CodingConversationPlannerUnavailableError)) throw error;
        const location = `${CODING_API_BASE}/runs/${encodeURIComponent(error.conversationId)}`;
        c.header("Location", location);
        c.header("Cache-Control", "no-store");
        return c.json(codingConversationPlannerUnavailableDto(error), 503);
      }
      const responseRunId = result.conversationId;
      const location = result.job
        ? `${CODING_API_BASE}/runs/${encodeURIComponent(responseRunId)}?job=${encodeURIComponent(result.job.id)}`
        : `${CODING_API_BASE}/runs/${encodeURIComponent(responseRunId)}`;
      c.header("Location", location);
      c.header("Cache-Control", "no-store");
      return c.json({
        schema: CODING_API_SCHEMA,
        ok: true,
        runId: responseRunId,
        conversationId: result.conversationId,
        disposition: result.route.disposition,
        activation: result.job
          ? "dispatched"
          : result.route.disposition === "ready" || result.route.disposition === "investigating" || result.route.disposition === "escalated" ? "queued" : "none",
        route: result.route,
        repositoryRoot: selectedWorkspace.repositoryRoot,
        workspaceId: selectedWorkspace.id,
        workspace: workspaceDto(workspace.profile),
        job: result.job ? codingJobDto(result.job) : null,
      }, result.job || result.route.disposition === "ready" || result.route.disposition === "investigating" || result.route.disposition === "escalated" ? 202 : 200);
    });

    app.get(`${CODING_API_BASE}/workspace`, async (c) => {
      const requestedWorkspaceId = safeWorkspaceId(c.req.query("workspace"));
      if (c.req.query("workspace") && !requestedWorkspaceId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid workspace id" }, 400);
      }
      const selectedWorkspace = await resolveCodingWorkspace(deps.runtime, requestedWorkspaceId);
      if (!selectedWorkspace) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workspace not found" }, 404);
      const workspace = await readCodingWorkspace(deps.runtime, selectedWorkspace);
      c.header("Cache-Control", "no-store");
      return c.json({
        schema: CODING_API_SCHEMA,
        workspace: workspace.profile
          ? workspaceDto(workspace.profile)
          : { scanned: false, repositoryRoot: selectedWorkspace.repositoryRoot },
        workspaceId: selectedWorkspace.id,
      });
    });

    app.post(`${CODING_API_BASE}/workspace/settings`, async (c) => {
      const mediaType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "content type must be application/json" }, 415);
      }
      const body = await jsonObject(c.req);
      const parsed = codingWorkspaceSettingsFormSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "choose a supported implementation agent, runtime, and model for this coding workspace",
        }, 400);
      }
      const { workspaceId, nodeId, workerRuntime, codexModel, piModel, claudeModel, hermesModel } = parsed.data;
      const workspace = await resolveCodingWorkspace(deps.runtime, workspaceId);
      if (!workspace) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workspace not found" }, 404);
      }
      const savedWorkspace = await readCodingWorkspace(deps.runtime, workspace);
      const node = savedWorkspace.profile?.nodes.find((candidate) => candidate.id === nodeId);
      if (!node && nodeId !== "workspace.implementation") {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "choose a specialist from the saved workspace team",
        }, 400);
      }
      const allowedNodeIds = new Set(savedWorkspace.profile?.nodes.map((candidate) => candidate.id)
        ?? ["workspace.implementation"]);
      const settings = await saveCodingWorkspaceSettings(
        deps.runtime,
        workspace.id,
        nodeId,
        workerRuntime,
        { codexModel, piModel, claudeModel, hermesModel },
        allowedNodeIds,
      );
      c.header("Cache-Control", "no-store");
      return c.json({
        schema: CODING_API_SCHEMA,
        ok: true,
        workspaceId: workspace.id,
        nodeId,
        nodeName: node?.name ?? "Implementation specialist",
        settings,
        selectedModel: codingWorkspaceSelectedModel(codingWorkspaceNodePreference(settings, nodeId)),
      });
    });

    app.post(`${CODING_API_BASE}/workspace/scan`, async (c) => {
      const body = await jsonObject(c.req);
      const requestedWorkspaceId = safeWorkspaceId(body?.workspaceId);
      const selectedWorkspace = await resolveCodingWorkspace(deps.runtime, requestedWorkspaceId);
      if (!selectedWorkspace) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workspace not found" }, 404);
      if ((await readCodingWorkspace(deps.runtime, selectedWorkspace)).profile) {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "this workspace is already scanned; use the tracked workspace rescans endpoint",
          trackedRescanEndpoint: `${CODING_API_BASE}/workspace/rescans`,
        }, 409);
      }
      const { profile } = await rescanAndSaveCodingWorkspace(
        deps.runtime,
        selectedWorkspace,
        deps.workspaceReviewer,
        deps.workspaceToolchainOnboarder,
      );
      c.header("Cache-Control", "no-store");
      return c.json({ schema: CODING_API_SCHEMA, ok: true, workspace: workspaceDto(profile) }, 201);
    });

    app.post(`${CODING_API_BASE}/workspace/rescans`, async (c) => {
      const mediaType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "content type must be application/json" }, 415);
      }
      const body = await jsonObject(c.req);
      if (!body) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "request body must be a JSON object" }, 400);
      const requestedWorkspaceId = safeWorkspaceId(body.workspaceId);
      if (body.workspaceId !== undefined && !requestedWorkspaceId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid workspace id" }, 400);
      }
      const objective = body.objective === undefined
        ? "Rescan team and update this workspace's specialist profile"
        : typeof body.objective === "string" ? body.objective.trim() : "";
      if (!objective || objective.length > 20_000) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "objective must be between 1 and 20,000 characters" }, 400);
      }
      const requestIdentity = typeof body.requestId === "string" ? safeRunId(body.requestId) : undefined;
      if (body.requestId !== undefined && !requestIdentity) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid request id" }, 400);
      }
      const selectedWorkspace = await resolveCodingWorkspace(deps.runtime, requestedWorkspaceId);
      if (!selectedWorkspace) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workspace not found" }, 404);
      if (!(await readCodingWorkspace(deps.runtime, selectedWorkspace)).profile) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "scan this repository before requesting a tracked rescan" }, 409);
      }
      const queued = await enqueueWorkspaceRescan({
        deps,
        workspace: selectedWorkspace,
        objective,
        requestIdentity: requestIdentity ?? newCodingConversationId(),
      });
      const browserDestination = codingTrackedRunDestination(selectedWorkspace.id, queued.runId, queued.job.id);
      const statusLocation = `${CODING_API_BASE}/runs/${encodeURIComponent(queued.runId)}?job=${encodeURIComponent(queued.job.id)}`;
      c.header("Cache-Control", "no-store");
      c.header("Location", statusLocation);
      const response = {
        schema: CODING_API_SCHEMA,
        ok: queued.status !== "conflict",
        runId: queued.runId,
        conversationId: queued.runId,
        workspaceId: selectedWorkspace.id,
        statusLocation,
        browserDestination,
        runKind: "workspace-rescan" as const,
        capabilities: { readOnly: true, integratable: false },
        duplicate: queued.status === "duplicate",
        job: codingJobDto(queued.job),
        ...(queued.status === "conflict" ? { error: "a workspace rescan is already active" } : {}),
      };
      return queued.status === "conflict" ? c.json(response, 409) : c.json(response, 202);
    });

    app.get(`${CODING_API_BASE}/runs`, async (c) => {
      const requestedLimit = Number(c.req.query("limit") ?? 50);
      const limit = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 50;
      const workspaceId = safeWorkspaceId(c.req.query("workspace"));
      if (c.req.query("workspace") && !workspaceId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid workspace id" }, 400);
      const jobs = await listCodingJobs(deps.queue, limit, workspaceId);
      c.header("Cache-Control", "no-store");
      return c.json({
        schema: CODING_API_SCHEMA,
        jobs: jobs.map(codingJobDto),
        runs: jobs.map((job) => ({ id: codingJobConversationId(job), job: codingJobDto(job) })),
      });
    });

    app.get(`${CODING_API_BASE}/rooms`, async (c) => {
      const requestedWorkspaceId = safeWorkspaceId(c.req.query("workspace"));
      if (c.req.query("workspace") && !requestedWorkspaceId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid workspace id" }, 400);
      }
      const selectedWorkspace = await resolveCodingWorkspace(deps.runtime, requestedWorkspaceId);
      if (!selectedWorkspace) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding workspace not found" }, 404);
      }
      const rooms = await deps.rooms.list(selectedWorkspace.id);
      c.header("Cache-Control", "no-store");
      return c.json({
        schema: CODING_API_SCHEMA,
        workspaceId: selectedWorkspace.id,
        rooms,
      });
    });

    app.get(`${CODING_API_BASE}/runs/:runId/collaboration.md`, async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid run id" }, 400);
      const selector = codingJobSelector(c);
      if (!selector.valid) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid job id" }, 400);
      }
      const record = await loadCodingCollaborationRecord(deps, runId, selector.jobId);
      if (!record.ok) {
        c.header("Cache-Control", "no-store");
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: record.error }, record.status);
      }
      setCodingCollaborationRecordHeaders(c, record.filename);
      return c.body(record.markdown);
    });

    app.get(`${CODING_API_BASE}/runs/:runId/report.md`, async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid run id" }, 400);
      const selector = codingJobSelector(c);
      if (!selector.valid) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid job id" }, 400);
      }
      const report = await loadCodingInvestigationReport(deps, runId, selector.jobId);
      if (!report.ok) {
        c.header("Cache-Control", "no-store");
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: report.error }, report.status);
      }
      setCodingCollaborationRecordHeaders(c, report.filename);
      return c.body(report.markdown);
    });

    app.get(`${CODING_API_BASE}/runs/:runId`, async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid run id" }, 400);
      const requestedJobId = safeRunId(c.req.query("job"));
      if (c.req.query("job") && !requestedJobId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid job id" }, 400);
      }
      const job = await findCodingJob(deps.queue, runId, requestedJobId);
      if (requestedJobId && !job) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding job not found" }, 404);
      }
      let projection;
      try {
        projection = await runProjection(deps, runId, job);
      } catch (error) {
        if (error instanceof CodingAcceptedOutputProjectionUnavailableError) {
          return c.json({
            schema: CODING_API_SCHEMA,
            ok: false,
            error: "coding accepted output projection is unavailable",
          }, 503);
        }
        throw error;
      }
      if (!job && projection.events.length === 0) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding run not found" }, 404);
      }
      c.header("Cache-Control", "no-store");
      return c.json(projection);
    });

    app.post(`${CODING_API_BASE}/runs/:runId/messages`, async (c) => {
      const conversationId = safeRunId(c.req.param("runId"));
      if (!conversationId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid conversation id" }, 400);
      const body = await jsonObject(c.req);
      const requestedWorkspaceId = safeWorkspaceId(body?.workspaceId);
      if (body?.workspaceId !== undefined && !requestedWorkspaceId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid workspace id" }, 400);
      }
      const selectedWorkspace = await resolveCodingWorkspace(deps.runtime, requestedWorkspaceId);
      if (!selectedWorkspace) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workspace not found" }, 404);
      const messageText = typeof body?.message === "string"
        ? body.message.trim()
        : typeof body?.text === "string" ? body.text.trim() : "";
      if (!messageText || messageText.length > 20_000) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "message must be between 1 and 20,000 characters" }, 400);
      }
      const parsedImages = codingConversationImagesFromBody(body?.images, conversationId);
      if (!parsedImages.ok) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: parsedImages.error }, 400);
      }
      const workspace = await readCodingWorkspace(deps.runtime, selectedWorkspace);
      if (!workspace.profile) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "workspace has not been scanned" }, 409);
      const existing = await readRun(deps.runtime, conversationId);
      if (existing.events.length === 0) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "conversation not found" }, 404);
      const job = await findCodingJob(deps.queue, conversationId, undefined, selectedWorkspace.id);
      const current = await readCodingConversationExecution(
        deps,
        conversationId,
        job ? codingJobExecutionId(job) : undefined,
        selectedWorkspace.id,
      );
      const terminal = Boolean(job && ["completed", "failed", "canceled"].includes(job.status));
      const priorResolution = parseCodingPeerResolution(
        orchestrationOutputValues(current.state)[CODING_COLLABORATION_RESOLUTION_OUTPUT] ?? "",
      );
      const collaborationContext = terminal ? humanCollaborationContext(priorResolution) : undefined;
      const priorConversation = codingConversationFromEvents(existing.events);
      const deliveryRecovery = terminal && await codingDeliveryRecoveryRequired(
        deps.runtime,
        priorConversation.messages,
        current.events,
      );
      const humanContinuation = Boolean(collaborationContext) || deliveryRecovery;
      if (job && !terminal) {
        let routed;
        try {
          routed = await routeActiveCodingConversation({
            deps,
            profile: workspace.profile,
            workspace: selectedWorkspace,
            conversationId,
            text: messageText,
            images: parsedImages.images,
            source: conversationSourceFromBody(body),
            tags: stringList(body?.tags),
            mentions: stringList(body?.mentions, 12),
            ...(typeof body?.replyTo === "string" ? { replyTo: body.replyTo.slice(0, 200) } : {}),
            job,
            state: current.state,
          });
        } catch (error) {
          if (error instanceof CodingConversationPlannerUnavailableError) {
            c.header("Cache-Control", "no-store");
            return c.json(codingConversationPlannerUnavailableDto(error), 503);
          }
          if (error instanceof Error && error.message.includes("finished before")) {
            return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding job is terminal" }, 409);
          }
          throw error;
        }
        c.header("Cache-Control", "no-store");
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: true,
          runId: conversationId,
          conversationId,
          jobId: job.id,
          ...routed,
        }, routed.disposition === "running" && !routed.duplicate ? 202 : 200);
      }
      const reviewPolicy = codingReviewPolicy(body?.reviewPolicy
        ?? (humanContinuation ? job?.payload.reviewPolicy : undefined));
      const workerRuntimeOverride = codingWorkerRuntime(body?.workerRuntime);
      const dependencyResolution = codingDependencyResolution(body?.dependencyResolution);
      if (dependencyResolution && !authenticatedApiOverride(c.req.header("Authorization"))) {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: "dependencyResolution requires authenticated API override authority",
        }, 403);
      }
      if (!reviewPolicy
        || (body?.workerRuntime !== undefined && !workerRuntimeOverride)
        || (body?.dependencyResolution !== undefined
          && (!dependencyResolution || workerRuntimeOverride !== "codex-cli"))) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid review policy or worker runtime" }, 400);
      }
      let result;
      try {
        result = await createAndPlanConversation({
          deps,
          profile: workspace.profile,
          conversationId,
          ...(terminal ? { executionRunId: newCodingConversationId() } : {}),
          text: messageText,
          images: parsedImages.images,
          source: conversationSourceFromBody(body),
          tags: [
            ...stringList(body?.tags),
            ...(collaborationContext ? ["intent:human-resolution"] : []),
            ...(deliveryRecovery ? ["intent:delivery-recovery"] : []),
          ],
          mentions: stringList(body?.mentions, 12),
          ...(typeof body?.replyTo === "string" ? { replyTo: body.replyTo.slice(0, 200) } : {}),
          reviewPolicy,
          ...(workerRuntimeOverride ? { workerRuntimeOverride } : {}),
          ...(dependencyResolution ? { dependencyResolution } : {}),
          workspace: selectedWorkspace,
          ...(collaborationContext ? { collaborationContext } : {}),
        });
      } catch (error) {
        if (!(error instanceof CodingConversationPlannerUnavailableError)) throw error;
        const location = `${CODING_API_BASE}/runs/${encodeURIComponent(error.conversationId)}`;
        c.header("Location", location);
        c.header("Cache-Control", "no-store");
        return c.json(codingConversationPlannerUnavailableDto(error), 503);
      }
      const responseRunId = conversationId;
      const location = result.job
        ? `${CODING_API_BASE}/runs/${encodeURIComponent(responseRunId)}?job=${encodeURIComponent(result.job.id)}`
        : `${CODING_API_BASE}/runs/${encodeURIComponent(responseRunId)}`;
      c.header("Cache-Control", "no-store");
      c.header("Location", location);
      return c.json({
        schema: CODING_API_SCHEMA,
        ok: true,
        conversationId,
        runId: responseRunId,
        disposition: result.route.disposition,
        activation: result.job
          ? "dispatched"
          : result.route.disposition === "ready" || result.route.disposition === "investigating" || result.route.disposition === "escalated" ? "queued" : "none",
        route: result.route,
        job: result.job ? codingJobDto(result.job) : null,
      }, result.job || result.route.disposition === "ready" || result.route.disposition === "investigating" || result.route.disposition === "escalated" ? 202 : 200);
    });

    const controlRun = async (c: Context, command: "steer" | "abort") => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid run id" }, 400);
      const body = await jsonObject(c.req);
      const requestedJobId = typeof body?.jobId === "string" ? safeRunId(body.jobId) : undefined;
      if (body?.jobId !== undefined && !requestedJobId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid job id" }, 400);
      }
      const job = await findCodingJob(deps.queue, runId, requestedJobId);
      if (!job) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding run not found" }, 404);
      const message = typeof body?.message === "string" ? body.message.trim() : "";
      if (command === "steer" && (!message || message.length > 20_000)) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "message must be between 1 and 20,000 characters" }, 400);
      }
      const reason = typeof body?.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 2_000)
        : "Pi operator requested abort";
      const workspaceId = safeWorkspaceId(job.payload.codingWorkspaceId);
      if (command === "steer" && !workspaceId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding job has no workspace scope" }, 409);
      }
      const source = conversationSourceFromBody(body);
      const conversationMessage = command === "steer" ? createCodingConversationMessage({
        conversationId: runId,
        workspaceId,
        author: { kind: "user", id: CODING_HUMAN_NODE_ID, name: "You" },
        source,
        text: message,
        tags: ["delivery:queued"],
      }) : undefined;
      if (conversationMessage) await publishConversationMessage(deps.runtime, conversationMessage);
      const commandPayload = conversationMessage ? {
        schema: "coding-control-command/v1",
        workspaceId,
        conversationId: runId,
        runId: codingJobExecutionId(job) ?? runId,
        messageId: conversationMessage.messageId,
        jobId: job.id,
        jobAttempt: job.attempt,
        problem: conversationMessage.text,
        message: conversationMessage,
      } : { reason };
      const queued = await deps.queue.queueCommand({
        ...(conversationMessage ? {
          commandId: `coding_command_${hashCanonical(commandPayload).slice(0, 28)}`,
        } : {}),
        jobId: job.id,
        command,
        payload: commandPayload,
        by: conversationMessage ? source.kind : "pi.extension",
      });
      if (!queued) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding job is terminal" }, 409);
      c.header("Cache-Control", "no-store");
      return c.json({
        schema: CODING_API_SCHEMA,
        ok: true,
        runId,
        jobId: job.id,
        command: queued,
        ...(conversationMessage ? { message: conversationMessage } : {}),
      }, 202);
    };

    app.post(`${CODING_API_BASE}/runs/:runId/steer`, (c) => controlRun(c, "steer"));
    app.post(`${CODING_API_BASE}/runs/:runId/abort`, (c) => controlRun(c, "abort"));

    const integrateCompletedRun = async (runId: string, requestedJobId?: string) => {
      const job = await findCodingJob(deps.queue, runId, requestedJobId);
      if (!job) throw new Error("Coding run not found");
      const integrationInput = codingIntegrationInput(job);
      if (!integrationInput) throw new Error("Only a completed coding run with a certified commit can be integrated");
      const executionStream = codingRunStream(integrationInput.runId);
      const { state } = await readRun(deps.runtime, integrationInput.runId);
      if (!codingExecutionCertified(state)) {
        throw new Error("The coding task graph has not completed certification");
      }
      const request = {
        schema: "roster.coding-integration.request.v1",
        runId,
        executionRunId: integrationInput.runId,
        sourceBranch: gitRunBranchName(integrationInput.runId),
        sourceCommit: integrationInput.expectedCommit,
        targetBranch: integrationInput.baselineBranch,
        expectedTargetCommit: integrationInput.baselineCommit,
      } as const;
      const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      await deps.runtime.execute(executionStream, {
        type: "emit",
        eventId: `coding-integration-request:${requestHash}`,
        event: inlineArtifactPublishedEvent({
          runId: integrationInput.runId,
          artifactId: `integration-request-${requestHash.slice(0, 24)}`,
          origin: "input",
          outputKey: "integration_request",
          nodeId: state.domain?.coordinatorId ?? "coordinator",
          kind: "coding.integration.request",
          inputVersions: {},
        }, JSON.stringify(request)),
      });
      const integrate = deps.integrateRun ?? integrateGitRunBranch;
      const integration = await integrate(integrationInput);
      const result = {
        schema: "roster.coding-integration.result.v1",
        runId,
        executionRunId: integrationInput.runId,
        status: integration.alreadyIntegrated ? "already_integrated" : "integrated",
        targetBranch: integrationInput.baselineBranch,
        resultingCommit: integrationInput.expectedCommit,
      } as const;
      const resultHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
      await deps.runtime.execute(executionStream, {
        type: "emit",
        eventId: `coding-integration-result:${resultHash}`,
        event: inlineArtifactPublishedEvent({
          runId: integrationInput.runId,
          artifactId: `integration-result-${resultHash.slice(0, 24)}`,
          origin: "input",
          outputKey: "integration_result",
          nodeId: state.domain?.coordinatorId ?? "coordinator",
          kind: "coding.integration.result",
          inputVersions: { integration_request: requestHash },
        }, JSON.stringify(result)),
      });
      return { job, integration, result };
    };

    const closeCompletedRun = async (conversationId: string, requestedJobId?: string): Promise<{
      readonly job: QueueJob;
      readonly disposition: CodingDeliveryDisposition;
      readonly duplicate: boolean;
    }> => {
      const job = await findCodingJob(deps.queue, conversationId, requestedJobId);
      if (!job) throw new Error("Coding run not found");
      const integrationInput = codingIntegrationInput(job);
      if (!integrationInput) {
        throw new Error("Only a completed coding run with a certified branch can be closed this way");
      }
      const executionStream = codingRunStream(integrationInput.runId);
      const { state, events } = await readRun(deps.runtime, integrationInput.runId);
      if (!codingExecutionCertified(state)) {
        throw new Error("The coding task graph has not completed certification");
      }
      const existing = codingDeliveryDispositionFromEvents(events);
      const certifiedBranch = integrationInput.branchName ?? gitRunBranchName(integrationInput.runId);
      if (existing
        && existing.jobId === job.id
        && existing.commit === integrationInput.expectedCommit
        && existing.branch === certifiedBranch) {
        return { job, disposition: existing, duplicate: true };
      }
      const integration = await (deps.integrationStatus ?? gitRunIntegrationStatus)(integrationInput);
      if (integration.integrated) throw new Error("This certified change is already merged");
      const branchExists = integrationInput.branchName
        ? await (deps.branchExists ?? gitBranchExists)(integrationInput.repositoryRoot, integrationInput.branchName)
        : await (deps.runBranchExists ?? gitRunBranchExists)(integrationInput.repositoryRoot, integrationInput.runId);
      if (!branchExists) {
        throw new Error("The certified room branch no longer exists and cannot be kept");
      }
      const disposition = createCodingDeliveryDisposition({
        conversationId,
        executionRunId: integrationInput.runId,
        jobId: job.id,
        branch: certifiedBranch,
        commit: integrationInput.expectedCommit,
      });
      await deps.runtime.execute(executionStream, {
        type: "emit",
        eventId: `coding-delivery-disposition:${disposition.dispositionId}`,
        event: codingDeliveryDispositionEvent(disposition, state.domain?.coordinatorId ?? "coordinator"),
      });
      return { job, disposition, duplicate: false };
    };

    const retryFailedRun = async (conversationId: string, requestedJobId: string) => {
      const failedJob = await findCodingJob(deps.queue, conversationId, requestedJobId);
      if (!failedJob) throw new Error("Coding run not found");
      const failedExecution = await readCodingConversationExecution(
        deps,
        conversationId,
        codingJobExecutionId(failedJob),
        codingJobWorkspaceId(failedJob),
      );
      const graphFailure = failedExecution.state.taskGraph?.tasks.find((task) =>
        task.capability !== "coordinate.graph"
        && (task.status === "failed" || task.status === "canceled"));
      if (failedJob.status !== "failed" && failedJob.status !== "canceled" && !graphFailure) {
        throw new Error("Only a failed or canceled coding run can be retried");
      }
      const existingRetry = (await listCodingJobs(deps.queue, 200, codingJobWorkspaceId(failedJob)))
        .find((job) => job.payload.retryOfJobId === failedJob.id);
      if (existingRetry) return { source: failedJob, retry: existingRetry, duplicate: true };
      const catalog = await readCodingWorkspaceCatalog(deps.runtime);
      const workspace = catalog.find((candidate) => candidate.id === codingJobWorkspaceId(failedJob));
      if (!workspace) throw new Error("The coding workspace for this run no longer exists");
      const saved = await readCodingWorkspace(deps.runtime, workspace);
      if (!saved.profile) throw new Error("Scan this repository and create its agents before retrying");
      const objective = typeof failedJob.payload.objective === "string"
        ? failedJob.payload.objective.trim().slice(0, 17_500)
        : "Retry the previous failed coding execution.";
      const failure = (failedJob.lastError
        ?? failedJob.canceledReason
        ?? graphFailure?.error
        ?? "The previous execution did not complete.").slice(0, 800);
      const message = createCodingConversationMessage({
        conversationId,
        workspaceId: workspace.id,
        author: { kind: "user", id: CODING_HUMAN_NODE_ID, name: "You" },
        source: { kind: "ui" },
        text: `Retry the previous bounded execution from its recorded baseline. Original objective: ${objective}\n\nPrevious failure: ${failure}`,
        tags: ["intent:retry", `retry-of:${failedJob.id}`],
      });
      await publishConversationMessage(deps.runtime, message);
      const selectedNodeIds = Array.isArray(failedJob.payload.selectedNodeIds)
        ? failedJob.payload.selectedNodeIds.filter((value): value is string => typeof value === "string").slice(0, 12)
        : [];
      const primaryNodeId = typeof failedJob.payload.primaryNodeId === "string"
        ? failedJob.payload.primaryNodeId
        : undefined;
      const coordination = parseCodingConversationCoordination(failedJob.payload.coordination);
      if (!coordination) {
        throw new Error("The failed coding job is missing its accepted coordination decision");
      }
      if (!primaryNodeId) {
        throw new Error("The failed coding job is missing its selected primary workspace node");
      }
      const reviewPolicy = codingReviewPolicy(failedJob.payload.reviewPolicy) ?? "auto";
      const reviewMode = codingReviewMode(coordination, reviewPolicy);
      let resolvedSelection: ReturnType<typeof resolveCodingReviewedSelection>;
      try {
        resolvedSelection = resolveCodingReviewedSelection({
          nodes: saved.profile.nodes,
          selectedNodeIds,
          primaryNodeId,
          reviewMode,
        });
      } catch (error) {
        if (!(error instanceof CodingReviewedSelectionUnavailableError)) throw error;
        const clarification = codingReviewedSelectionClarification(saved.profile.nodes, error);
        const route = createConversationRouteDecision({
          conversationId,
          inReplyTo: message.messageId,
          ...clarification,
        });
        await deps.runtime.execute(codingRunStream(conversationId), {
          type: "emit",
          eventId: `coding-conversation:${route.routeId}`,
          event: codingConversationRouteEvent(route),
        });
        return { source: failedJob, route, duplicate: false };
      }
      const retryCoordination = { ...coordination, reviewMode };
      const retryExecutionKind = failedJob.payload.executionKind === "investigation"
        ? "investigation" as const
        : "mutation" as const;
      const route = createConversationRouteDecision({
        conversationId,
        inReplyTo: message.messageId,
        disposition: retryExecutionKind === "investigation" ? "investigating" : "ready",
        selectedNodeIds: resolvedSelection.selectedNodeIds,
        primaryNodeId,
        coordination: retryCoordination,
        tags: ["intent:retry", "execution:fresh-baseline"],
        questions: [],
        rationale: "The operator explicitly requested a fresh bounded retry of a failed execution.",
        confidence: 1,
      });
      await deps.runtime.execute(codingRunStream(conversationId), {
        type: "emit",
        eventId: `coding-conversation:${route.routeId}`,
        event: codingConversationRouteEvent(route),
      });
      const previousExecution = parseCodingWorkerExecution(failedJob.payload.workerExecution);
      if (!previousExecution) {
        throw new Error("The failed coding job is missing its Roster v2 worker execution snapshot");
      }
      const workerRuntime = previousExecution.runtime;
      const { job } = await enqueueCodingRun(deps, objective, reviewPolicy, workerRuntime, {
        runId: newCodingConversationId(),
        conversationId,
        selectedNodeIds: resolvedSelection.selectedNodeIds,
        primaryNodeId,
        coordination: retryCoordination,
        conversationTags: [
          ...stringList(failedJob.payload.conversationTags),
          "intent:retry",
          `retry-of:${failedJob.id}`,
        ],
        executionKind: retryExecutionKind,
        workspace,
        workerExecution: previousExecution,
        continuityNodes: saved.profile.nodes,
        continuitySource: {
          deliveryId: message.messageId,
          sourceId: message.messageId,
          sourceVersion: route.routeId,
          sourceHash: hashCanonical({ message, route }),
          deliveredAt: message.createdAt,
        },
        retryOfJobId: failedJob.id,
        jobId: `coding_retry_${hashCanonical({ conversationId, failedJobId: failedJob.id }).slice(0, 28)}`,
      });
      return { source: failedJob, retry: job, duplicate: false };
    };

    app.post(`${CODING_API_BASE}/runs/:runId/integrate`, async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid run id" }, 400);
      const body = await jsonObject(c.req);
      const requestedJobId = typeof body?.jobId === "string" ? safeRunId(body.jobId) : undefined;
      if (body?.jobId !== undefined && !requestedJobId) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid job id" }, 400);
      }
      try {
        const integrated = await integrateCompletedRun(runId, requestedJobId);
        c.header("Cache-Control", "no-store");
        return c.json({ schema: CODING_API_SCHEMA, ok: true, runId, integration: integrated.result }, 200);
      } catch (error) {
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, 409);
      }
    });

    app.post(`${CODING_API_BASE}/runs/:runId/close`, async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid run id" }, 400);
      const body = await jsonObject(c.req);
      const requestedJobId = typeof body?.jobId === "string" ? safeRunId(body.jobId) : undefined;
      if (!requestedJobId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "jobId is required" }, 400);
      try {
        const closed = await closeCompletedRun(runId, requestedJobId);
        c.header("Cache-Control", "no-store");
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: true,
          runId,
          duplicate: closed.duplicate,
          disposition: closed.disposition,
        }, 200);
      } catch (error) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: error instanceof Error ? error.message : String(error) }, 409);
      }
    });

    app.post(`${CODING_API_BASE}/runs/:runId/retry`, async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid run id" }, 400);
      const body = await jsonObject(c.req);
      const requestedJobId = typeof body?.jobId === "string" ? safeRunId(body.jobId) : undefined;
      if (!requestedJobId) return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "jobId is required" }, 400);
      try {
        const retried = await retryFailedRun(runId, requestedJobId);
        const retryJob = "retry" in retried ? retried.retry : undefined;
        const clarificationRoute = "route" in retried ? retried.route : undefined;
        c.header("Cache-Control", "no-store");
        return c.json({
          schema: CODING_API_SCHEMA,
          ok: true,
          conversationId: runId,
          duplicate: retried.duplicate,
          ...(clarificationRoute ? {
            disposition: clarificationRoute.disposition,
            route: clarificationRoute,
          } : {}),
          job: retryJob ? codingJobDto(retryJob) : null,
        }, retryJob && !retried.duplicate ? 202 : 200);
      } catch (error) {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: error instanceof Error ? error.message : String(error) }, 409);
      }
    });

    app.get(`${CODING_API_BASE}/diff`, async (c) => {
      try {
        const requestedRunId = c.req.query("runId");
        const runId = requestedRunId ? safeRunId(requestedRunId) : undefined;
        if (requestedRunId && !runId) {
          return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid run id" }, 400);
        }
        const rawJobId = c.req.query("job");
        const requestedJobId = safeRunId(rawJobId);
        if (rawJobId && !requestedJobId) {
          return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "invalid job id" }, 400);
        }
        if (requestedJobId && !runId) {
          return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "job requires runId" }, 400);
        }
        const job = runId ? await findCodingJob(deps.queue, runId, requestedJobId) : undefined;
        if (requestedJobId && !job) {
          return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "coding job not found" }, 404);
        }
        const repositoryRoot = typeof job?.payload.workingDirectory === "string"
          ? resolve(job.payload.workingDirectory)
          : codingRepositoryRoot();
        const patchRunId = job ? codingJobExecutionId(job) ?? runId : runId;
        c.header("Cache-Control", "no-store");
        return c.json(patchRunId ? await runPatchSummary(patchRunId, repositoryRoot) : await gitDiffSummary(repositoryRoot));
      } catch {
        return c.json({ schema: CODING_API_SCHEMA, ok: false, error: "Git diff summary unavailable" }, 409);
      }
    });

    app.get("/coding/runs/:runId/collaboration.md", async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return text(400, "Invalid coding run.");
      const selector = codingJobSelector(c);
      if (!selector.valid) return text(400, "Invalid coding job.");
      const record = await loadCodingCollaborationRecord(deps, runId, selector.jobId);
      if (!record.ok) return text(record.status, record.status === 503
        ? "Coding collaboration replay is unavailable."
        : record.error === "coding run not found"
          ? "Coding run not found."
          : record.error === "coding job not found"
            ? "Coding job not found."
            : "Coding collaboration records are available only for terminal jobs.", {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      setCodingCollaborationRecordHeaders(c, record.filename);
      return c.body(record.markdown);
    });

    app.get("/coding/runs/:runId/report.md", async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return text(400, "Invalid coding run.");
      const selector = codingJobSelector(c);
      if (!selector.valid) return text(400, "Invalid coding job.");
      const report = await loadCodingInvestigationReport(deps, runId, selector.jobId);
      if (!report.ok) return text(report.status, report.error, {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      setCodingCollaborationRecordHeaders(c, report.filename);
      return c.body(report.markdown);
    });

    app.get("/coding/runs/:runId/review", async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return text(400, "Invalid coding run.");
      const requestedJobId = safeRunId(c.req.query("job"));
      if (c.req.query("job") && !requestedJobId) return text(400, "Invalid coding job.");
      const rawJob = await findCodingJob(deps.queue, runId, requestedJobId);
      if (requestedJobId && !rawJob) return text(404, "Coding job not found.");
      const repositoryRoot = typeof rawJob?.payload.workingDirectory === "string"
        ? resolve(rawJob.payload.workingDirectory)
        : codingRepositoryRoot();
      const patchRunId = rawJob ? codingJobExecutionId(rawJob) ?? runId : runId;
      const [{ state, events }, projectedJob, diff] = await Promise.all([
        readRun(deps.runtime, patchRunId),
        jobProjection(deps.queue, rawJob?.id, deps.integrationStatus, { runId }),
        runPatchSummary(patchRunId, repositoryRoot),
      ]);
      const job = jobWithDeliveryDisposition(projectedJob, events);
      if (!job && events.length === 0) return text(404, "Coding run not found.");
      const nonce = randomBytes(18).toString("base64");
      return html(codingReviewShell({
        state,
        runId,
        job,
        diff: diff as CodingReviewDiff,
        nonce,
        showGlobalNavigation: deps.showGlobalNavigation,
        ...(rawJob ? { workspaceId: codingJobWorkspaceId(rawJob) } : {}),
      }), {
        "Content-Security-Policy": [
          "default-src 'self'",
          "img-src 'self' data: blob:",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          `script-src 'self' 'nonce-${nonce}'`,
          `style-src 'self' 'nonce-${nonce}'`,
        ].join("; "),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
    });

    app.get("/coding", async (c) => {
      const composerDraft = c.req.query("draft");
      if (
        composerDraft !== undefined
        && (composerDraft.length > 20_000 || /[\u0000-\u001F\u007F-\u009F]/u.test(composerDraft))
      ) return text(400, "Invalid coding draft.");
      const rawRunId = c.req.query("run");
      const runId = safeRunId(rawRunId);
      if (rawRunId && !runId) return text(400, "Invalid coding run.");
      const rawJobId = c.req.query("job");
      const jobId = safeRunId(rawJobId);
      if (rawJobId && !jobId) return text(400, "Invalid coding job.");
      if (jobId && !runId) return text(400, "A coding job requires a valid run.");
      const requestedWorkspaceId = safeWorkspaceId(c.req.query("workspace"));
      if (c.req.query("workspace") && !requestedWorkspaceId) return text(400, "Invalid coding workspace.");
      const catalog = await readCodingWorkspaceCatalog(deps.runtime);
      const conversationOwner = runId
        ? await codingPageConversationOwner(deps, catalog, runId, jobId)
        : undefined;
      if (conversationOwner?.job && !conversationOwner.workspace) {
        return text(404, jobId ? "Coding job not found." : "Coding workspace not found.");
      }
      if (requestedWorkspaceId && conversationOwner?.workspace
        && requestedWorkspaceId !== conversationOwner.workspace.id) {
        return text(404, "Coding run not found in this workspace.");
      }
      const selectedWorkspace = requestedWorkspaceId
        ? catalog.find((workspace) => workspace.id === requestedWorkspaceId)
        : conversationOwner?.workspace ?? catalog[0];
      if (!selectedWorkspace) return text(404, "Coding workspace not found.");
      if (!requestedWorkspaceId && runId && conversationOwner?.workspace
        && conversationOwner.workspace.id !== catalog[0]?.id) {
        const canonical = new URL(c.req.url).searchParams;
        canonical.set("workspace", conversationOwner.workspace.id);
        if (!jobId && conversationOwner.job) canonical.set("job", conversationOwner.job.id);
        return c.redirect(`/coding?${canonical.toString()}`, 302);
      }
      const teamRefreshFlash = teamRefreshFlashes.consume(c.req.query("teamRefresh"), selectedWorkspace);
      const workspaceSettingsFlash = workspaceSettingsFlashes.consume(c.req.query("settingsSaved"), selectedWorkspace.id);
      const rawJob = runId
        ? conversationOwner?.job && codingJobWorkspaceId(conversationOwner.job) === selectedWorkspace.id
          ? conversationOwner.job
          : await findCodingJob(deps.queue, runId, jobId, selectedWorkspace.id)
        : undefined;
      if (jobId && !rawJob) return text(404, "Coding job not found.");
      const rawConversationJob = runId && jobId
        ? await findCodingJob(deps.queue, runId, undefined, selectedWorkspace.id)
        : rawJob;
      const executionRunId = rawJob ? codingJobExecutionId(rawJob) : undefined;
      const [{ state, events, eventTimestamps }, job, projectedConversationJob, repository, recentJobs, savedWorkspace, workspaceProfiles, runtimeOptions, workspaceSettings, attentionItems, rooms] = await Promise.all([
        readCodingConversationExecution(deps, runId, executionRunId, selectedWorkspace.id),
        jobProjection(
          deps.queue,
          rawJob?.id,
          deps.integrationStatus,
          runId ? { runId, workspaceId: selectedWorkspace.id } : undefined,
        ),
        rawConversationJob?.id !== rawJob?.id
          ? jobProjection(
              deps.queue,
              rawConversationJob?.id,
              deps.integrationStatus,
              runId ? { runId, workspaceId: selectedWorkspace.id } : undefined,
            )
          : Promise.resolve(undefined),
        repositoryIdentity(selectedWorkspace.repositoryRoot),
        listCodingJobs(deps.queue, 25, selectedWorkspace.id),
        readCodingWorkspace(deps.runtime, selectedWorkspace),
        Promise.all(catalog.map(async (workspace) => ({
          workspace,
          profile: (await readCodingWorkspace(deps.runtime, workspace)).profile,
        }))),
        availableCodingWorkerRuntimeOptions(deps, selectedWorkspace.repositoryRoot),
        readCodingWorkspaceSettings(deps.runtime, selectedWorkspace.id),
        codingAttentionItems(deps.queue, deps.runtime, catalog, deps.integrationStatus),
        deps.rooms.list(selectedWorkspace.id),
      ]);
      const continuitySummaries = savedWorkspace.profile && deps.continuity
        ? await deps.continuity.summaries(savedWorkspace.profile.nodes.map((node) => node.id))
        : {};
      const selectedJob = jobWithDeliveryDisposition(job, events);
      const conversationJob = rawConversationJob?.id === rawJob?.id ? selectedJob : projectedConversationJob;
      const nonce = randomBytes(18).toString("base64");
      const operatorAuthority = configuredCodingOperatorAuthority();
      const pageSessionToken = deps.realtime && rawJob && runId && executionRunId && operatorAuthority
        ? pageSessions.issue({
            workspaceId: selectedWorkspace.id,
            controlWorkspaceId: deps.realtime.workspaceId,
            roomId: codingJobRoomId(runId, rawJob),
            conversationId: runId,
            jobId: rawJob.id,
            executionId: executionRunId,
            operatorAuthority,
          })
        : undefined;
      return html(codingShell({
        state,
        events,
        eventTimestamps,
        runId,
        job: selectedJob,
        conversationJob,
        composerDraft,
        nonce,
        showGlobalNavigation: deps.showGlobalNavigation,
        repositoryPath: repository.path,
        gitRemote: repository.remote,
        gitAccount: repository.account,
        repository,
        recentRuns: recentJobs.map((recentJob) => {
          const recent = codingJobDto(recentJob);
          return selectedJob?.id === recent.id && selectedJob.deliveryDisposition
            ? { ...recent, deliveryDisposition: selectedJob.deliveryDisposition }
            : recent;
        }),
        rooms,
        workspaceProfile: savedWorkspace.profile,
        continuitySummaries,
        workspaceId: selectedWorkspace.id,
        workspaces: workspaceProfiles.map(({ workspace, profile }) => ({
          id: workspace.id,
          name: basename(workspace.repositoryRoot),
          repositoryPath: workspace.repositoryRoot,
          selected: workspace.id === selectedWorkspace.id,
          scanned: Boolean(profile),
        })),
        runtimeOptions,
        workspaceSettings,
        attentionItems,
        workspaceWorkerRuntime: workspaceSettings?.workerRuntime ?? DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME,
        workspaceCodexModel: workspaceSettings?.codexModel ?? DEFAULT_CODING_WORKSPACE_CODEX_MODEL,
        workspacePiModel: workspaceSettings?.piModel ?? DEFAULT_CODING_WORKSPACE_PI_MODEL,
        workspaceClaudeModel: workspaceSettings?.claudeModel ?? DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL,
        workspaceHermesModel: workspaceSettings?.hermesModel ?? DEFAULT_CODING_WORKSPACE_HERMES_MODEL,
        rescanRequestId: newCodingConversationId(),
        ...(workspaceSettingsFlash ? {
          workspaceSettingsNotice: `${workspaceSettingsFlash.nodeName} · ${workspaceSettingsFlash.workerRuntime === "pi-agent" ? "Pi Code" : workspaceSettingsFlash.workerRuntime === "claude-code" ? "Claude Code" : workspaceSettingsFlash.workerRuntime === "hermes-agent" ? "Hermes Agent" : "Codex CLI"} · ${workspaceSettingsFlash.workerModel} saved for future mutation assignments.`,
          workspaceSettingsNoticeNodeId: workspaceSettingsFlash.nodeId,
        } : {}),
        chatModel: workspaceSettings
          ? codingWorkspaceSelectedModel(workspaceSettings)
          : deps.conversationModel ?? DEFAULT_OPENAI_MODEL,
        ...(deps.realtime ? {
          realtime: {
            ...deps.realtime,
            ...(executionRunId ? { activeRunId: executionRunId } : {}),
          },
        } : {}),
        ...(teamRefreshFlash ? {
          teamRefreshNotice: teamRefreshFlash.kind === "refreshed"
            ? "Team refresh complete. The saved profile applies to future conversations; existing runs keep their original roster."
            : "Repository scan complete. The saved specialist profile is ready for future conversations.",
        } : {}),
      }), {
        "Content-Security-Policy": [
          "default-src 'self'",
          "img-src 'self' data: blob:",
          ...(deps.realtime ? (() => {
            const http = new URL(deps.realtime.uri);
            const socket = new URL(deps.realtime.uri);
            socket.protocol = http.protocol === "https:" ? "wss:" : "ws:";
            return [`connect-src 'self' ${http.origin} ${socket.origin}`];
          })() : []),
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          // spacetimedb@2.6.1 generates algebraic serializers with Function(...).
          `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`,
          `style-src 'self' 'nonce-${nonce}'`,
        ].join("; "),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        ...(pageSessionToken ? {
          "Set-Cookie": codingPageSessionCookie(pageSessionToken, c.req.url),
          "Cache-Control": "private, no-store",
        } : {}),
      });
    });

    app.get("/coding/workspaces/browse", async (c) => {
      const requestedPath = c.req.query("path")?.trim() || homedir();
      try {
        const directory = await browseCodingDirectory(requestedPath);
        c.header("Cache-Control", "no-store");
        return c.json({ schema: "roster.coding-directory.v1", ...directory });
      } catch (error) {
        c.header("Cache-Control", "no-store");
        return c.json({
          schema: "roster.coding-directory.v1",
          error: error instanceof Error ? error.message : "Could not open this folder.",
        }, 400);
      }
    });

    app.post("/coding/workspaces", async (c) => {
      const enhanced = c.req.header("Accept")?.includes("application/json") ?? false;
      const body = await c.req.parseBody();
      const repositoryPath = typeof body.repositoryPath === "string" ? body.repositoryPath.trim() : "";
      if (!repositoryPath || repositoryPath.length > 4_096) {
        const error = "Enter an absolute Git repository root.";
        return enhanced ? c.json({ ok: false, error }, 400) : text(400, error);
      }
      try {
        const repositoryRoot = await canonicalGitRepository(repositoryPath);
        const fallback = codingDefaultWorkspace();
        const workspace = repositoryRoot === fallback.repositoryRoot
          ? fallback
          : codingRepositoryWorkspace(repositoryRoot);
        const saved = await readCodingWorkspace(deps.runtime, workspace);
        if (!saved.profile) {
          await rescanAndSaveCodingWorkspace(
            deps.runtime,
            workspace,
            deps.workspaceReviewer,
            deps.workspaceToolchainOnboarder,
          );
        }
        const destination = `/coding?workspace=${encodeURIComponent(workspace.id)}`;
        return enhanced
          ? c.json({ schema: "roster.coding-workspace-add.v1", ok: true, destination })
          : c.redirect(destination, 303);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not add this Git repository.";
        return enhanced ? c.json({ ok: false, error: message }, 400) : text(400, message);
      }
    });

    app.post(
      "/coding/workspace/settings",
      zValidator("form", codingWorkspaceSettingsFormSchema, (result) => {
        if (!result.success) return text(400, "Choose a supported implementation agent and model for this coding workspace.");
      }),
      async (c) => {
        const { workspaceId, nodeId, workerRuntime, codexModel, piModel, claudeModel, hermesModel } = c.req.valid("form");
        const workspace = await resolveCodingWorkspace(deps.runtime, workspaceId);
        if (!workspace) return text(404, "Coding workspace not found.");
        const savedWorkspace = await readCodingWorkspace(deps.runtime, workspace);
        const node = savedWorkspace.profile?.nodes.find((candidate) => candidate.id === nodeId);
        if (!node && nodeId !== "workspace.implementation") {
          return text(400, "Choose a specialist from the saved workspace team.");
        }
        const allowedNodeIds = new Set(savedWorkspace.profile?.nodes.map((candidate) => candidate.id)
          ?? ["workspace.implementation"]);
        const settings = await saveCodingWorkspaceSettings(deps.runtime, workspace.id, nodeId, workerRuntime, {
          codexModel,
          piModel,
          claudeModel,
          hermesModel,
        }, allowedNodeIds);
        const token = workspaceSettingsFlashes.issue({
          workspaceId: workspace.id,
          nodeId,
          nodeName: node?.name ?? "Implementation specialist",
          workerRuntime,
          workerModel: codingWorkspaceSelectedModel(codingWorkspaceNodePreference(settings, nodeId)),
        });
        return c.redirect(`/coding?workspace=${encodeURIComponent(workspace.id)}&settingsSaved=${token}`, 303);
      },
    );

    app.post("/coding/workspace/scan", async (c) => {
      const enhanced = c.req.header("Accept")?.includes("application/json") ?? false;
      const body = await c.req.parseBody();
      const workspaceId = safeWorkspaceId(body.workspaceId);
      const requestIdentity = typeof body.requestId === "string" ? safeRunId(body.requestId) : undefined;
      if (body.requestId !== undefined && !requestIdentity) {
        return enhanced
          ? c.json({ ok: false, error: "Invalid rescan request id." }, 400)
          : text(400, "Invalid rescan request id.");
      }
      const workspace = await resolveCodingWorkspace(deps.runtime, workspaceId);
      if (!workspace) {
        return enhanced
          ? c.json({ ok: false, error: "Coding workspace not found." }, 404)
          : text(404, "Coding workspace not found.");
      }
      try {
        const savedWorkspace = await readCodingWorkspace(deps.runtime, workspace);
        const previouslyScanned = Boolean(savedWorkspace.profile);
        if (savedWorkspace.profile) {
          const stableRequestIdentity = requestIdentity ?? newCodingConversationId();
          const conversationId = `workspace-rescan-${hashCanonical({
            workspaceId: workspace.id,
            requestIdentity: stableRequestIdentity,
          }).slice(0, 32)}`;
          const result = await createWorkspaceRescanConversation({
            deps,
            profile: savedWorkspace.profile,
            conversationId,
            workspace,
            text: "Rescan this workspace repository and update the specialist team",
            source: { kind: "ui", externalId: stableRequestIdentity },
          });
          if (!result.job) throw new Error("Tracked team rescan did not create a job");
          const destinationRunId = result.rescanStatus === "conflict"
            ? result.activeRunId
            : result.conversationId;
          const destination = codingTrackedRunDestination(workspace.id, destinationRunId, result.job.id);
          if (result.rescanStatus === "conflict") {
            c.header("Cache-Control", "no-store");
            c.header("Location", destination);
            return enhanced
              ? c.json({ ok: false, error: "A team rescan is already active.", destination }, 409)
              : c.text(`A team rescan is already active: ${destination}`, 409, {
                  "Cache-Control": "no-store",
                  Location: destination,
                });
          }
          return enhanced
            ? c.json({
                ok: true,
                destination,
                runId: destinationRunId,
                duplicate: result.rescanStatus === "duplicate",
                job: codingJobDto(result.job),
              }, 202)
            : c.redirect(destination, 303);
        }
        const saved = await rescanAndSaveCodingWorkspace(
          deps.runtime,
          workspace,
          deps.workspaceReviewer,
          deps.workspaceToolchainOnboarder,
        );
        const token = teamRefreshFlashes.issue({
          workspaceId: saved.workspace.id,
          profileStream: saved.workspace.profileStream,
          kind: previouslyScanned ? "refreshed" : "created",
        });
        const destination = codingTeamRefreshDestination({
          workspaceId: saved.workspace.id,
          token,
          ...(typeof body.returnTo === "string" ? { returnTo: body.returnTo } : {}),
          ...(typeof body.selectedAgent === "string" ? { selectedAgent: body.selectedAgent } : {}),
        });
        return enhanced
          ? c.json({ ok: true, destination })
          : c.redirect(destination, 303);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not refresh this repository team.";
        return enhanced
          ? c.json({ ok: false, error: message }, 500)
          : text(500, message);
      }
    });

    app.post("/coding/runs/:runId/integrate", async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return text(400, "Invalid coding run.");
      const body = await c.req.parseBody();
      const requestedJobId = typeof body.jobId === "string" ? safeRunId(body.jobId) : undefined;
      if (body.jobId !== undefined && !requestedJobId) return text(400, "Invalid coding job.");
      try {
        const integrated = await integrateCompletedRun(runId, requestedJobId);
        return c.redirect(`/coding?workspace=${encodeURIComponent(codingJobWorkspaceId(integrated.job))}&run=${encodeURIComponent(runId)}&job=${encodeURIComponent(integrated.job.id)}`, 303);
      } catch (error) {
        return text(409, error instanceof Error ? error.message : String(error));
      }
    });

    app.post("/coding/runs/:runId/close", async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return text(400, "Invalid coding run.");
      const body = await c.req.parseBody();
      const requestedJobId = typeof body.jobId === "string" ? safeRunId(body.jobId) : undefined;
      if (!requestedJobId) return text(400, "A certified coding job is required.");
      try {
        const closed = await closeCompletedRun(runId, requestedJobId);
        return c.redirect(`/coding?workspace=${encodeURIComponent(codingJobWorkspaceId(closed.job))}&run=${encodeURIComponent(runId)}&job=${encodeURIComponent(closed.job.id)}`, 303);
      } catch (error) {
        return text(409, error instanceof Error ? error.message : String(error));
      }
    });

    app.post("/coding/runs/:runId/retry", async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return text(400, "Invalid coding run.");
      const body = await c.req.parseBody();
      const requestedJobId = typeof body.jobId === "string" ? safeRunId(body.jobId) : undefined;
      if (!requestedJobId) return text(400, "A failed coding job is required.");
      try {
        const retried = await retryFailedRun(runId, requestedJobId);
        const retryJob = "retry" in retried ? retried.retry : undefined;
        const workspaceId = codingJobWorkspaceId(retryJob ?? retried.source);
        return c.redirect(retryJob
          ? `/coding?workspace=${encodeURIComponent(workspaceId)}&run=${encodeURIComponent(runId)}&job=${encodeURIComponent(retryJob.id)}`
          : `/coding?workspace=${encodeURIComponent(workspaceId)}&run=${encodeURIComponent(runId)}`, 303);
      } catch (error) {
        return text(409, error instanceof Error ? error.message : String(error));
      }
    });

    app.post("/coding/runs/:runId/react", async (c) => {
      const runId = safeRunId(c.req.param("runId"));
      if (!runId) return text(400, "Invalid coding conversation.");
      const body = await c.req.parseBody();
      const messageId = typeof body.messageId === "string" ? safeRunId(body.messageId) : undefined;
      const emoji = typeof body.emoji === "string" && CODING_ROOM_REACTION_EMOJIS.includes(body.emoji as CodingRoomReactionEmoji)
        ? body.emoji as CodingRoomReactionEmoji
        : undefined;
      if (!messageId || !emoji) return text(400, "Choose a supported reaction for a durable room message.");
      const conversation = await readRun(deps.runtime, runId);
      if (!codingConversationFromEvents(conversation.events).messages.some((message) => message.messageId === messageId)) {
        return text(404, "Room message not found.");
      }
      const reaction = createCodingRoomReaction({
        conversationId: runId,
        messageId,
        authorId: CODING_HUMAN_NODE_ID,
        emoji,
      });
      await deps.runtime.execute(codingRunStream(runId), {
        type: "emit",
        eventId: `coding-room-reaction:${reaction.reactionId}`,
        event: codingRoomReactionEvent(reaction),
      });
      const params = new URLSearchParams({ run: runId });
      const workspaceId = typeof body.workspaceId === "string" ? safeWorkspaceId(body.workspaceId) : undefined;
      const jobId = typeof body.jobId === "string" ? safeRunId(body.jobId) : undefined;
      if (workspaceId) params.set("workspace", workspaceId);
      if (jobId) params.set("job", jobId);
      return c.redirect(`/coding?${params.toString()}`, 303);
    });

    app.post(
      "/coding/run",
      zValidator("form", codingRunFormSchema, (result) => {
        if (!result.success) return text(400, "Enter a coding objective up to 20,000 characters.");
      }),
      async (c) => {
        const { objective, images, conversationId, reviewPolicy, workspaceId, externalId } = c.req.valid("form");
        const selectedWorkspace = await resolveCodingWorkspace(deps.runtime, workspaceId);
        if (!selectedWorkspace) return text(404, "Coding workspace not found.");
        const workspace = await readCodingWorkspace(deps.runtime, selectedWorkspace);
        if (!workspace.profile) return text(409, "Scan this repository and create its agents first.");
        const profile = workspace.profile;
        const turnConversationId = conversationId ?? newCodingConversationId();
        const parsedImages = codingConversationImagesFromBody(images, turnConversationId);
        if (!parsedImages.ok) return text(400, parsedImages.error);
        const submit = async (onInformationalDelta?: (
          delta: string,
          responder?: CodingConversationSpeaker,
        ) => void | Promise<void>) => {
          const activeJob = conversationId
            ? await findCodingJob(deps.queue, conversationId, undefined, selectedWorkspace.id)
            : undefined;
          if (activeJob && !["completed", "failed", "canceled"].includes(activeJob.status)) {
            const activeExecution = await readCodingConversationExecution(
              deps,
              turnConversationId,
              codingJobExecutionId(activeJob),
              selectedWorkspace.id,
            );
            const routed = await routeActiveCodingConversation({
              deps,
              profile,
              workspace: selectedWorkspace,
              conversationId: turnConversationId,
              text: objective,
              images: parsedImages.images,
              source: { kind: "ui", ...(externalId ? { externalId } : {}) },
              job: activeJob,
              state: activeExecution.state,
              ...(onInformationalDelta ? { onInformationalDelta } : {}),
            });
            const responder = "responder" in routed ? routed.responder : undefined;
            return {
              disposition: routed.disposition,
              ...(routed.route.answer ? { answer: routed.route.answer } : {}),
              ...(responder ? { author: codingConversationSpeakerAuthor(responder) } : {}),
              location: `/coding?workspace=${encodeURIComponent(selectedWorkspace.id)}&run=${encodeURIComponent(turnConversationId)}&job=${encodeURIComponent(activeJob.id)}`,
            };
          }
          const continuation = conversationId
            ? await readCodingConversationExecution(
                deps,
                conversationId,
                activeJob ? codingJobExecutionId(activeJob) : undefined,
                selectedWorkspace.id,
              )
            : undefined;
          const collaborationContext = continuation
            ? humanCollaborationContext(parseCodingPeerResolution(
                orchestrationOutputValues(continuation.state)[CODING_COLLABORATION_RESOLUTION_OUTPUT] ?? "",
              ))
            : undefined;
          const deliveryRecovery = continuation
            ? await codingDeliveryRecoveryRequired(
                deps.runtime,
                codingConversationFromEvents(continuation.events).messages,
                continuation.events,
              )
            : false;
          const humanContinuation = Boolean(collaborationContext) || deliveryRecovery;
          const result = await createAndPlanConversation({
            deps,
            profile,
            conversationId: turnConversationId,
            ...(activeJob ? { executionRunId: newCodingConversationId() } : {}),
            text: objective,
            images: parsedImages.images,
            source: { kind: "ui", ...(externalId ? { externalId } : {}) },
            ...(humanContinuation ? { tags: [
              ...(collaborationContext ? ["intent:human-resolution"] : []),
              ...(deliveryRecovery ? ["intent:delivery-recovery"] : []),
            ] } : {}),
            reviewPolicy: reviewPolicy ?? "auto",
            workspace: selectedWorkspace,
            ...(collaborationContext ? { collaborationContext } : {}),
            ...(onInformationalDelta ? { onInformationalDelta } : {}),
          });
          const responder = "responder" in result ? result.responder : undefined;
          return {
            disposition: !result.job
              && (result.route.disposition === "ready" || result.route.disposition === "investigating" || result.route.disposition === "escalated")
              ? "running"
              : result.route.disposition,
            routeDisposition: result.route.disposition,
            activation: result.job ? "dispatched" : "queued",
            ...(result.route.answer ? { answer: result.route.answer } : {}),
            ...(responder ? { author: codingConversationSpeakerAuthor(responder) } : {}),
            location: result.job
              ? `/coding?workspace=${encodeURIComponent(selectedWorkspace.id)}&run=${encodeURIComponent(result.conversationId)}&job=${encodeURIComponent(result.job.id)}`
              : `/coding?workspace=${encodeURIComponent(selectedWorkspace.id)}&run=${encodeURIComponent(result.conversationId)}`,
          };
        };

        if (c.req.header("Accept")?.includes("application/x-ndjson")) {
          c.header("Content-Type", "application/x-ndjson; charset=utf-8");
          c.header("Cache-Control", "no-store");
          c.header("X-Accel-Buffering", "no");
          return stream(c, async (output) => {
            const write = (value: Readonly<Record<string, unknown>>) => output.write(`${JSON.stringify(value)}\n`);
            await write({ type: "accepted", conversationId: turnConversationId, model: deps.conversationModel ?? DEFAULT_OPENAI_MODEL });
            await write({
              type: "progress",
              stage: "routing",
              label: "Routing",
              message: conversationId
                ? "Checking the live run…"
                : "Thinking…",
            });
            try {
              const result = await submit(async (delta, responder) => {
                await write({
                  type: "delta",
                  delta,
                  ...(responder ? { author: codingConversationSpeakerAuthor(responder) } : {}),
                });
              });
              if (result.disposition === "ready" || result.disposition === "investigating") {
                await write({
                  type: "progress",
                  stage: "starting",
                  label: "Starting",
                  message: "Starting work…",
                });
              } else if (result.disposition === "running") {
                await write({
                  type: "progress",
                  stage: "queued",
                  label: "Queued",
                  message: "Queued for the next safe handoff.",
                });
              }
              await write({ type: "result", ...result });
            } catch (error) {
              if (error instanceof CodingConversationPlannerUnavailableError) {
                await write({
                  type: "error",
                  ...codingConversationPlannerUnavailableDto(error),
                  location: `/coding?workspace=${encodeURIComponent(selectedWorkspace.id)}&run=${encodeURIComponent(error.conversationId)}`,
                });
                return;
              }
              await write({ type: "error", error: error instanceof Error ? error.message : String(error) });
            }
          });
        }

        try {
          const result = await submit();
          return c.redirect(result.location, 303);
        } catch (error) {
          if (error instanceof CodingConversationPlannerUnavailableError) {
            c.header("Cache-Control", "no-store");
            c.header(
              "Location",
              `/coding?workspace=${encodeURIComponent(selectedWorkspace.id)}&run=${encodeURIComponent(error.conversationId)}`,
            );
            return text(503, `${error.message} Trace: ${error.route.routeId}`);
          }
          return text(409, error instanceof Error ? error.message : String(error));
        }
      },
    );

  },
});

const factory: AgentModuleFactory = (ctx) => {
  const localOnly = codingUsesLocalRuntimesOnly();
  const defaultWorkerRuntime = codingDefaultWorkerRuntime();
  const conversationModel = codingConversationModel();
  const localConversationModel = codingLocalConversationModel(defaultWorkerRuntime);
  const conversationProductContext = codingConversationProductContext();
  const nodeRuntimes = ctx.runtime<NodeRuntimeRegistry>("coding-node-runtimes");
  const roomControl = ctx.helper<NonNullable<CodingRouteDeps["roomControl"]>>(
    "codingRoomControl",
    (value): value is NonNullable<CodingRouteDeps["roomControl"]> =>
      typeof value === "object"
      && value !== null
      && "queueIntent" in value
      && typeof value.queueIntent === "function",
  );
  const realtime = ctx.helper<NonNullable<CodingRouteDeps["realtime"]>>(
    "codingRealtime",
    (value): value is NonNullable<CodingRouteDeps["realtime"]> => {
      if (typeof value !== "object" || value === null) return false;
      const candidate = value as Partial<NonNullable<CodingRouteDeps["realtime"]>>;
      return candidate.enabled === true
        && typeof candidate.uri === "string"
        && typeof candidate.database === "string"
        && typeof candidate.confirmedReads === "boolean"
        && typeof candidate.workspaceId === "string";
    },
  );
  const realtimeSession = ctx.helper<NonNullable<CodingRouteDeps["realtimeSession"]>>(
    "codingRealtimeSession",
    (value): value is NonNullable<CodingRouteDeps["realtimeSession"]> => typeof value === "function",
  );
  const acceptedOutputs = ctx.helper<NonNullable<CodingRouteDeps["acceptedOutputs"]>>(
    "codingAcceptedOutputs",
    (value): value is NonNullable<CodingRouteDeps["acceptedOutputs"]> =>
      typeof value === "function",
  );
  const activeImprovementSnapshot = ctx.helper<NonNullable<CodingRouteDeps["activeImprovementSnapshot"]>>(
    "codingActiveImprovementSnapshot",
    (value): value is NonNullable<CodingRouteDeps["activeImprovementSnapshot"]> =>
      typeof value === "function",
  );
  const continuity = ctx.helper<NonNullable<CodingRouteDeps["continuity"]>>(
    "codingNodeContinuity",
    (value): value is NonNullable<CodingRouteDeps["continuity"]> =>
      typeof value === "object"
      && value !== null
      && "queue" in value
      && typeof value.queue === "object"
      && value.queue !== null
      && "enqueue" in value
      && typeof value.enqueue === "function"
      && "summaries" in value
      && typeof value.summaries === "function",
  );
  return createCodingRoute({
    runtime: ctx.runtime<CodingAgentRuntime>("coding-agent"),
    queue: continuity?.queue ?? ctx.queue,
    continuity,
    rooms: ctx.runtime<CodingRoomDirectory>("coding-room-directory"),
    showGlobalNavigation: resolveRosterServerSurface() === "full",
    roomControl,
    realtime,
    realtimeSession,
    acceptedOutputs: acceptedOutputs ?? (async () => {
      throw new CodingAcceptedOutputProjectionUnavailableError();
    }),
    activeImprovementSnapshot,
    ...(localOnly ? {
      conversationPlanner: localRuntimeCodingConversationPlanner({
        runtimes: nodeRuntimes,
        execution: async ({ repositoryRoot }) => {
          const workspace = codingRepositoryWorkspace(repositoryRoot ?? codingRepositoryRoot());
          const selection = await resolveCodingWorkerSelection(
            ctx.runtime<CodingAgentRuntime>("coding-agent"),
            workspace.id,
            { defaultRuntime: defaultWorkerRuntime },
          );
          return createCodingWorkerExecution({
            runtime: selection.workerRuntime,
            source: selection.selectionSource,
            workerModel: selection.workerModel,
          });
        },
      }),
    } : {
      conversationPlanner: modelCodingConversationPlanner(ctx.llmStructured, conversationModel),
      conversationAnswerer: modelCodingConversationAnswerer(
        ctx.llmText,
        conversationModel,
      ),
      workspaceToolchainOnboarder: modelCodingWorkspaceToolchainOnboarder(ctx.llmStructured),
    }),
    workspaceReviewer: piCodingWorkspaceAgentReviewer(
      nodeRuntimes,
    ),
    defaultWorkerRuntime,
    conversationProductContext,
    conversationModel: localOnly ? localConversationModel : conversationModel,
    runtimeLogs: codingRuntimeLogs,
    roomUpdates: codingRoomUpdates,
  });
};

export default factory;
