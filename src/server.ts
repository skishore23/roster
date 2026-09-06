// ============================================================================
// Server - Hono transport + manifest-based routing
// ============================================================================

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { createRosterHttpAccess, rosterHttpConfiguration } from "./runtime/http-access.js";
import { serve } from "@hono/node-server";

import { createSpacetimeJobQueue } from "./adapters/spacetimedb-job-queue.js";
import { SpacetimeNodeContinuityControl } from "./adapters/spacetimedb-node-continuity.js";
import { CodingNodeContinuity } from "./adapters/coding-node-continuity.js";
import {
  connectSpacetimeControlPlaneFromEnv,
  spacetimeStartupFailure,
  type SpacetimeControlPlane,
} from "./adapters/spacetimedb-control.js";
import {
  SpacetimeTaskGraphControl,
  spacetimeRosterExecutionPolicy,
} from "./adapters/spacetimedb-task-graph-control.js";
import {
  SpacetimeEventRepository,
  spacetimeBranchStore,
  spacetimeStore,
} from "./adapters/spacetimedb-runtime.js";
import { SpacetimeWebAccess } from "./adapters/spacetimedb-web-access.js";
import {
  createMemoryTools,
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
} from "./adapters/memory-tools.js";
import { createDelegationTools } from "./adapters/delegation.js";
import { createHeartbeat, type HeartbeatSpec } from "./adapters/heartbeat.js";
import { fold } from "./core/chain.js";
import { canonicalize, hashCanonical } from "./core/canonical.js";
import { resolvePackageResource } from "./core/package-resource.js";
import { createRuntime } from "./core/runtime.js";
import type {
  ProposalRecord,
  SelfImprovementCmd,
  SelfImprovementEvent,
  SelfImprovementState,
} from "./modules/self-improvement.js";
import {
  decide as decideSelfImprovement,
  reduce as reduceSelfImprovement,
  initial as initialSelfImprovement,
} from "./modules/self-improvement.js";
import type { InspectorEvent } from "./modules/inspector.js";
import { decide as decideInspector, reduce as reduceInspector, initial as initialInspector } from "./modules/inspector.js";
import type { TheoremEvent } from "./modules/theorem.js";
import { decide as decideTheorem, reduce as reduceTheorem, initial as initialTheorem } from "./modules/theorem.js";
import type { WriterEvent } from "./modules/writer.js";
import { decide as decideWriter, reduce as reduceWriter, initial as initialWriter } from "./modules/writer.js";
import type { AgentEvent } from "./modules/agent.js";
import { decide as decideAgent, reduce as reduceAgent, initial as initialAgent } from "./modules/agent.js";
import type {
  AxiomSimpleCmd,
  AxiomSimpleEvent,
  AxiomSimpleState,
  AxiomSimpleWorkerSnapshot,
  AxiomSimpleWorkerStatus,
  AxiomSimpleWorkerValidation,
} from "./modules/axiom-simple.js";
import {
  decide as decideAxiomSimple,
  reduce as reduceAxiomSimple,
  initial as initialAxiomSimple,
} from "./modules/axiom-simple.js";
import {
  llmStructured as openAiLlmStructured,
  llmText as openAiLlmText,
  embed as openAiEmbed,
} from "./adapters/openai.js";
import { DEFAULT_OPENAI_MODEL } from "./models.js";
import { loadTheoremPrompts, hashTheoremPrompts } from "./prompts/theorem.js";
import { loadWriterPrompts, hashWriterPrompts } from "./prompts/writer.js";
import { loadInspectorPrompts, hashInspectorPrompts } from "./prompts/inspector.js";
import { loadAgentPrompts, hashAgentPrompts } from "./prompts/agent.js";
import { loadAxiomPrompts, hashAxiomPrompts } from "./prompts/axiom.js";
import { runTheoremRoster, normalizeTheoremConfig } from "./agents/theorem.js";
import { runWriterRoster, normalizeWriterConfig } from "./agents/writer.js";
import { runAgent, normalizeAgentConfig } from "./agents/agent.js";
import { runAxiom, normalizeAxiomConfig } from "./agents/axiom.js";
import { runAxiomSimple, normalizeAxiomSimpleConfig, type AxiomSimpleWorkerLauncher } from "./agents/axiom-simple.js";
import { theoremRunStream } from "./agents/theorem.streams.js";
import { writerRunStream } from "./agents/writer.streams.js";
import { agentRunStream } from "./agents/agent.streams.js";
import { axiomSimpleRunStream } from "./agents/axiom-simple.streams.js";
import {
  buildInspectorContext,
  buildInspectorTimeline,
  inspectorRecordsFromChain,
  runReceiptInspector,
  sliceInspectorRecords,
} from "./agents/inspector.js";
import { inspectorAnalysisStream } from "./agents/inspector.streams.js";
import { maybeQueueAxiomRosterVerifyFailureFollowUp } from "./agents/axiom-roster-recovery.js";
import { loadAgentRoutes } from "./framework/agent-loader.js";
import { makeEventId, html, text } from "./framework/http.js";
import { drainServer, serverDrainAllowsRequest } from "./framework/server-drain.js";
import { JobWorker, jobResultRequestsRetry, type JobHandler } from "./engine/runtime/job-worker.js";
import { ModelProviderHealthRegistry } from "./engine/runtime/model-provider-health.js";
import { isTerminalQueueJob, waitForOwnedJob } from "./engine/runtime/delegated-job.js";
import type { EnqueueJobInput } from "./engine/runtime/job-queue.js";
import { evaluateImprovementProposal } from "./engine/runtime/improvement-harness.js";
import { AutonomousSelfImprovementController } from "./engine/runtime/autonomous-self-improvement.js";
import { projectRuntimeExtensionRollout } from "./engine/runtime/runtime-extension-rollout.js";
import {
  SelfImprovementFramework,
  assertImprovementTargetBaseline,
} from "./engine/runtime/self-improvement-framework.js";
import { runHeadlessAgent, type HeadlessAgentEvent } from "./framework/headless-agent-runner.js";
import {
  createCodingRoomControlIntent,
  prepareCodingAgentGitRun,
  runCodingAgent,
  type CodingAgentExecutionResult,
  type CodingReviewerRuntime,
} from "./domains/coding.js";
import { createCodingRosterMemoryRepository } from "./domains/coding-memory.js";
import { createCompositeRosterMemoryRepository } from "./engine/runtime/node-memory-plane.js";
import { createNodeTrajectoryRollupCollector } from "./engine/runtime/node-trajectory-rollup.js";
import {
  CODING_WORKSPACE_CAPABILITIES,
  CODING_WORKSPACE_PROFILE_OUTPUT,
  codingWorkspaceNodesFromState,
  discoverCodingRepositorySkills,
  parseCodingWorkspaceProfile,
} from "./domains/coding-workspace.js";
import {
  applyWorkspaceParticipantProfiles,
  workspaceParticipantProfileFromRow,
} from "./engine/workspace/participant-profile.js";
import {
  codingWorkerExecutionRosterOptions,
  parseCodingWorkerExecution,
} from "./domains/coding-execution.js";
import {
  createCodingWorkspaceDiscoveryExecution,
  piCodingWorkspaceAgentReviewer,
} from "./domains/coding-workspace-enrichment.js";
import { modelCodingWorkspaceToolchainOnboarder } from "./domains/coding-workspace-toolchain.js";
import {
  codingConversationFromEvents,
  parseCodingConversationCoordination,
} from "./domains/coding-conversation.js";
import { codingConversationRuntimeAttachments } from "./domains/coding-conversation-runtime.js";
import {
  codingControlDeliveryAttemptsFromEvents,
  pendingCodingControlMessages,
} from "./domains/coding-control-ingress.js";
import { parseCodingPeerResolution } from "./domains/coding-collaboration.js";
import {
  admitCodingAutonomousImprovement,
  createCodingImprovementRuntimePin,
  evaluateCodingImprovementArtifact,
  parseCodingImprovementRuntimePin,
  type CodingImprovementRuntimePin,
} from "./domains/coding-improvements.js";
import {
  projectCodingAcceptedOutputs,
  type CodingAcceptedOutputProjection,
} from "./domains/coding-accepted-outputs.js";
import {
  codingRepositoryRoomId,
  codingRoomGitFrontierEvent,
  codingRoomGitFrontierFromEvents,
  codingRoomProjection,
  createCodingRoomGitFrontier,
} from "./domains/coding-room.js";
import {
  advanceGitRoomBranch,
  captureGitRunPatch,
  commitGitRunBranch,
  createGitRunWorkspace,
  disposeGitRunWorkspace,
  ensureGitRoomBranch,
  prepareGitRunWorkspaceDependencies,
} from "./engine/runtime/git-run-workspace.js";
import {
  ROSTER_CODING_VALIDATION_ENV_FILE,
  ROSTER_CODING_VALIDATION_ENV_KEYS,
  resolveCodingValidationEnvironment,
} from "./engine/runtime/coding-cli-environment.js";
import { createStandardNodeRuntimeRegistry } from "./engine/runtime/standard-node-runtimes.js";
import { createFileSystemDataReferenceStore } from "./engine/dataflow/filesystem-data-reference-store.js";
import type { DataReferenceStore } from "./engine/dataflow/data-reference-store.js";
import type { TaskGraphControl } from "./engine/orchestration/task-graph-control.js";
import {
  SpacetimeSharedWorkspace,
  createSpacetimeTaskGraphWorkspaceContextFactory,
} from "./engine/workspace/spacetimedb-shared-workspace.js";
import {
  initialOrchestrationState,
  orchestrationOutputValues,
  reduceOrchestration,
  taskGraphProjectedEvent,
  type OrchestrationEvent,
  type OrchestrationState,
} from "./modules/orchestration.js";
import {
  codingRoomUpdates,
  codingRuntimeLogs,
  codingUsesLocalRuntimesOnly,
  executeCodingWorkspaceRescanJob,
  type CodingAgentCommand,
} from "./agents/coding.agent.js";
import { landingPageHtml, landingSecurityHeaders } from "./views/landing.js";
import {
  resolveRosterServerSurface,
  selectServerSurfaceJobHandlers,
  serverSurfaceAgentModuleNames,
  serverSurfaceAllowsPath,
} from "./runtime/server-surface.js";

// ============================================================================
// Config
// ============================================================================

const PORT = Number(process.env.PORT ?? 8787);
const HTTP_CONFIGURATION = rosterHttpConfiguration();
const SERVER_SURFACE = resolveRosterServerSurface();
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const WORKSPACE_ID = process.env.ROSTER_WORKSPACE_ID?.trim() || "roster/default";
const WORKSPACE_NAME = process.env.ROSTER_WORKSPACE_NAME?.trim() || "Roster local workspace";
const ROSTER_PLATFORM_DATA_DIR = path.join(DATA_DIR, "roster-platform");
const ROSTER_TASK_LEASE_MS = 15_000;
const prepareImprovementDependencies = process.env.IMPROVEMENT_PREPARE_DEPENDENCIES !== "0";
const improvementAuthorityTokens = (() => {
  const raw = process.env.IMPROVEMENT_AUTHORITY_TOKENS_JSON;
  if (!raw?.trim()) return new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("IMPROVEMENT_AUTHORITY_TOKENS_JSON must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("IMPROVEMENT_AUTHORITY_TOKENS_JSON must be a JSON object");
  }
  const entries = Object.entries(parsed).map(([actorId, token]) => {
    if (!actorId.trim() || typeof token !== "string" || token.length < 16 || token.length > 512) {
      throw new Error("Improvement authority tokens require bounded actor ids and 16-512 character secrets");
    }
    return [actorId, token] as const;
  });
  return new Map(entries);
})();
const OPENAI_PROVIDER_ID = "openai";
const modelProviderHealth = new ModelProviderHealthRegistry();
const llmText: typeof openAiLlmText = (options) =>
  modelProviderHealth.execute(OPENAI_PROVIDER_ID, () => openAiLlmText(options));
const llmStructured: typeof openAiLlmStructured = (options) =>
  modelProviderHealth.execute(OPENAI_PROVIDER_ID, () => openAiLlmStructured(options));
const embed: typeof openAiEmbed = (texts) =>
  modelProviderHealth.execute(OPENAI_PROVIDER_ID, () => openAiEmbed(texts));

const rosterDataReferenceNamespace = (namespace: string): string =>
  `${namespace.split(":", 1)[0] ?? "run"}:${hashCanonical(namespace).slice(0, 32)}`;

const createDurableRosterExecutionPlanes = (
  control: SpacetimeControlPlane,
  taskGraph: TaskGraphControl,
  namespace: string,
  roomId: string,
  runId: string,
) => {
  const identity = rosterDataReferenceNamespace(namespace);
  const workspace = new SpacetimeSharedWorkspace({
    control,
    workspaceId: WORKSPACE_ID,
    roomId,
    runId,
    artifactId: `workspace_${hashCanonical(identity).slice(0, 28)}`,
  });
  return {
    taskGraph,
    dataReferences: createFileSystemDataReferenceStore({
      directory: path.join(ROSTER_PLATFORM_DATA_DIR, "data-references"),
      namespace: identity,
    }),
    createTaskContext: createSpacetimeTaskGraphWorkspaceContextFactory({ taskGraph, workspace }),
    dispose: async () => {
      workspace.close();
    },
  };
};

// ============================================================================
// Composition: Store -> Runtime
// ============================================================================

const spacetimeControlPlane = await connectSpacetimeControlPlaneFromEnv();
if (!spacetimeControlPlane) {
  throw new Error("SpacetimeDB is required for every Roster runtime; SPACETIMEDB_ENABLED=0 is no longer a server fallback");
}
const createSubscribedRosterExecutionPlanes = async (input: {
  readonly runId: string;
  readonly kind: string;
  readonly namespace: string;
  readonly receiptStreamId: string;
  readonly roomId?: string;
  readonly roomKey?: string;
  readonly roomTitle?: string;
}) => {
  const roomId = input.roomId ?? input.runId;
  const subscription = spacetimeControlPlane.subscribeRosterExecution(input.runId);
  try {
    await subscription.ready;
  } catch (error) {
    subscription.close();
    throw error;
  }
  const taskGraph = new SpacetimeTaskGraphControl({
    control: spacetimeControlPlane,
    workspaceId: WORKSPACE_ID,
    kind: input.kind,
    receiptStreamId: input.receiptStreamId,
    leaseMs: ROSTER_TASK_LEASE_MS,
    room: {
      id: roomId,
      roomKey: input.roomKey ?? `${input.kind}:${roomId}`,
      title: input.roomTitle ?? `${input.kind} ${roomId}`,
    },
  });
  const planes = createDurableRosterExecutionPlanes(
    spacetimeControlPlane,
    taskGraph,
    input.namespace,
    roomId,
    input.runId,
  );
  return {
    ...planes,
    dispose: async () => {
      try {
        await planes.dispose();
      } finally {
        subscription.close();
      }
    },
  };
};

const codingAcceptedOutputs = async (runId: string): Promise<CodingAcceptedOutputProjection> => {
  const subscription = spacetimeControlPlane.subscribeRosterExecution(runId);
  try {
    await subscription.ready;
    const projection = spacetimeControlPlane.rosterSnapshot(runId);
    const execution = projection.executions.find((candidate) => candidate.runId === runId);
    if (!execution) {
      throw new Error(`Spacetime Roster execution ${runId} is not projected`);
    }
    if (execution.kind !== "coding" && execution.kind !== "coding-investigation") {
      throw new Error(`Spacetime Roster execution ${runId} is not a Coding execution`);
    }
    const taskGraph = new SpacetimeTaskGraphControl({
      control: spacetimeControlPlane,
      workspaceId: WORKSPACE_ID,
      kind: execution.kind,
      leaseMs: ROSTER_TASK_LEASE_MS,
      existingExecution: true,
    });
    const snapshot = await taskGraph.initialize({
      runId,
      policy: spacetimeRosterExecutionPolicy(spacetimeControlPlane, runId),
      seedTasks: [],
    });
    const dataReferences = createFileSystemDataReferenceStore({
      directory: path.join(ROSTER_PLATFORM_DATA_DIR, "data-references"),
      namespace: rosterDataReferenceNamespace(`coding:${runId}`),
    });
    return projectCodingAcceptedOutputs(snapshot, dataReferences);
  } finally {
    subscription.close();
  }
};

spacetimeControlPlane.onDisconnect((error) => {
  console.error("SpacetimeDB control-plane connection closed; terminating for supervised restart", error);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
const eventRepository = new SpacetimeEventRepository(
  spacetimeControlPlane,
  WORKSPACE_ID,
  WORKSPACE_NAME,
);
let spacetimeWebAccess: SpacetimeWebAccess;
try {
  await eventRepository.initialize();
  spacetimeWebAccess = await SpacetimeWebAccess.create(spacetimeControlPlane, WORKSPACE_ID);
} catch (error) {
  spacetimeControlPlane.disconnect();
  throw spacetimeStartupFailure(spacetimeControlPlane.config, error);
}
const codingRoomControl = {
  queueIntent: (input: {
    readonly roomId: string;
    readonly intentId: string;
    readonly kind: "follow_up" | "steer";
    readonly payloadJson: string;
  }) => spacetimeControlPlane.connection.reducers.queueRosterRoomControlIntent({
    workspaceId: WORKSPACE_ID,
    ...input,
  }),
};
const codingRealtime = {
  enabled: true as const,
  uri: spacetimeWebAccess.uri,
  database: spacetimeControlPlane.config.database,
  confirmedReads: spacetimeControlPlane.config.confirmedReads,
  workspaceId: WORKSPACE_ID,
  capabilitySecret: spacetimeWebAccess.capabilitySecret,
};
const codingRealtimeSession = (scope: { readonly executionId: string }) =>
  spacetimeWebAccess.createViewerSession(scope.executionId);
const codingValidationEnvironment = resolveCodingValidationEnvironment();
// The selector itself can reveal the location of a secret-bearing file.
// Consume it before any local model runtime is materialized.
delete process.env[ROSTER_CODING_VALIDATION_ENV_FILE];
delete process.env[ROSTER_CODING_VALIDATION_ENV_KEYS];
const codingNodeRuntimes = createStandardNodeRuntimeRegistry({
  codingEnvironment: {
    ROSTER_WORKSPACE_ID: WORKSPACE_ID,
    ROSTER_WORKSPACE_NAME: WORKSPACE_NAME,
  },
  commandEnvironment: {
    ...codingValidationEnvironment,
    SPACETIMEDB_URI: spacetimeControlPlane.config.uri,
    SPACETIMEDB_DATABASE: spacetimeControlPlane.config.database,
    SPACETIMEDB_TOKEN: spacetimeControlPlane.auth.token,
  },
});

const makeStore = <E,>() => spacetimeStore<E>(eventRepository);
const branchStore = spacetimeBranchStore(eventRepository);

const theoremStore = makeStore<TheoremEvent>();
const theoremRuntime = createRuntime(
  theoremStore,
  branchStore,
  decideTheorem,
  reduceTheorem,
  initialTheorem
);

const writerStore = makeStore<WriterEvent>();
const writerRuntime = createRuntime(
  writerStore,
  branchStore,
  decideWriter,
  reduceWriter,
  initialWriter
);

const axiomSimpleStore = makeStore<AxiomSimpleEvent>();
const axiomSimpleRuntime = createRuntime<AxiomSimpleCmd, AxiomSimpleEvent, AxiomSimpleState>(
  axiomSimpleStore,
  branchStore,
  decideAxiomSimple,
  reduceAxiomSimple,
  initialAxiomSimple
);

const agentStore = makeStore<AgentEvent>();
const agentRuntime = createRuntime(
  agentStore,
  branchStore,
  decideAgent,
  reduceAgent,
  initialAgent
);

const inspectorStore = makeStore<InspectorEvent>();
const inspectorRuntime = createRuntime(
  inspectorStore,
  branchStore,
  decideInspector,
  reduceInspector,
  initialInspector
);

const selfImprovementStore = makeStore<SelfImprovementEvent>();
const selfImprovementRuntime = createRuntime<SelfImprovementCmd, SelfImprovementEvent, SelfImprovementState>(
  selfImprovementStore,
  branchStore,
  decideSelfImprovement,
  reduceSelfImprovement,
  initialSelfImprovement
);

const memoryStore = makeStore<MemoryEvent>();
const memoryRuntime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
  memoryStore,
  branchStore,
  decideMemory,
  reduceMemory,
  initialMemoryState
);

const codingStore = makeStore<OrchestrationEvent>();
const codingRuntime = createRuntime<CodingAgentCommand, OrchestrationEvent, OrchestrationState>(
  codingStore,
  branchStore,
  (command) => [command.event],
  reduceOrchestration,
  initialOrchestrationState,
);

// ============================================================================
// Prompts + Models
// ============================================================================

const THEOREM_PROMPTS = loadTheoremPrompts();
const THEOREM_PROMPTS_HASH = hashTheoremPrompts(THEOREM_PROMPTS);
const THEOREM_PROMPTS_PATH = "prompts/theorem.prompts.json";
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
const THEOREM_MODEL = OPENAI_MODEL;

const AXIOM_ROSTER_PROMPTS = loadTheoremPrompts({ name: "axiom-roster", tag: "axiom-roster" });
const AXIOM_ROSTER_PROMPTS_HASH = hashTheoremPrompts(AXIOM_ROSTER_PROMPTS);
const AXIOM_ROSTER_PROMPTS_PATH = "prompts/axiom-roster.prompts.json";
const AXIOM_ROSTER_MODEL = OPENAI_MODEL;

const WRITER_PROMPTS = loadWriterPrompts();
const WRITER_PROMPTS_HASH = hashWriterPrompts(WRITER_PROMPTS);
const WRITER_PROMPTS_PATH = "prompts/writer.prompts.json";
const WRITER_MODEL = OPENAI_MODEL;

const INSPECTOR_PROMPTS = loadInspectorPrompts();
const INSPECTOR_PROMPTS_HASH = hashInspectorPrompts(INSPECTOR_PROMPTS);
const INSPECTOR_PROMPTS_PATH = "prompts/inspector.prompts.json";
const INSPECTOR_MODEL = OPENAI_MODEL;

const AGENT_PROMPTS = loadAgentPrompts();
const AGENT_PROMPTS_HASH = hashAgentPrompts(AGENT_PROMPTS);
const AGENT_PROMPTS_PATH = "prompts/agent.prompts.json";
const AGENT_MODEL = OPENAI_MODEL;

const AXIOM_PROMPTS = loadAxiomPrompts();
const AXIOM_PROMPTS_HASH = hashAxiomPrompts(AXIOM_PROMPTS);
const AXIOM_PROMPTS_PATH = "prompts/axiom.prompts.json";
const AXIOM_MODEL = OPENAI_MODEL;
const CANVAS_MODEL = OPENAI_MODEL;

const IMPROVEMENT_STREAM = "improvement";
const selfImprovementFramework = new SelfImprovementFramework({
  artifacts: createFileSystemDataReferenceStore({
    directory: path.join(ROSTER_PLATFORM_DATA_DIR, "data-references"),
    namespace: rosterDataReferenceNamespace("self-improvement"),
    limits: { maxEntries: 4_096, maxValueBytes: 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 },
  }),
});
const jobWorkerId = process.env.JOB_WORKER_ID ?? `worker_${process.pid}`;
const jobPollMs = Number(process.env.JOB_POLL_MS ?? 250);
// Coding turns routinely span minutes. A two-minute lease tolerates brief
// local runtime and connection stalls while the worker still renews it every
// third of the interval; exact lease fences continue to guard side effects.
const jobLeaseMs = Number(process.env.JOB_LEASE_MS ?? 120_000);
const subJobWaitMsRaw = Number(process.env.SUBJOB_WAIT_MS ?? 1_500);
const subJobWaitMs = Number.isFinite(subJobWaitMsRaw)
  ? Math.max(0, Math.min(Math.floor(subJobWaitMsRaw), 30_000))
  : 1_500;
const subJobPollMsRaw = Number(process.env.SUBJOB_WAIT_POLL_MS ?? 250);
const subJobPollMs = Number.isFinite(subJobPollMsRaw)
  ? Math.max(20, Math.min(Math.floor(subJobPollMsRaw), 2_000))
  : 250;
const subJobJoinWaitMsRaw = Number(process.env.SUBJOB_JOIN_WAIT_MS ?? 180_000);
const subJobJoinWaitMs = Number.isFinite(subJobJoinWaitMsRaw)
  ? Math.max(0, Math.min(Math.floor(subJobJoinWaitMsRaw), 600_000))
  : 180_000;

const memoryTools = createMemoryTools({
  dir: DATA_DIR,
  runtime: memoryRuntime,
  embed: process.env.OPENAI_API_KEY ? embed : undefined,
});
const eventId = (stream: string): string => makeEventId(stream);

const proposalState = async () => selfImprovementRuntime.state(IMPROVEMENT_STREAM);

const emitImprovement = async (event: SelfImprovementEvent): Promise<void> => {
  await selfImprovementRuntime.execute(IMPROVEMENT_STREAM, {
    type: "emit",
    eventId: eventId(IMPROVEMENT_STREAM),
    event,
  });
};

class ImprovementTransitionConflictError extends Error {}

const emitImprovementTransition = async (
  event: Extract<SelfImprovementEvent, { readonly type: "proposal.transitioned" }>,
  expectedRecordId: string,
  validate?: (state: SelfImprovementState, proposal: ProposalRecord) => void,
): Promise<void> => {
  if (event.rolloutRecord.previousRecordId !== expectedRecordId) {
    throw new ImprovementTransitionConflictError("improvement transition was built from a stale rollout head");
  }
  const eventKey = eventId(IMPROVEMENT_STREAM);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const chain = await selfImprovementRuntime.chain(IMPROVEMENT_STREAM);
    const state = fold(chain, reduceSelfImprovement, initialSelfImprovement);
    const proposal = state.proposals[event.proposalId];
    const currentRecordId = proposal?.rolloutHistory.at(-1)?.recordId;
    if (!proposal || currentRecordId !== expectedRecordId) {
      throw new ImprovementTransitionConflictError(
        `improvement rollout head changed; current expectedRecordId is ${currentRecordId ?? "<none>"}`,
      );
    }
    try {
      validate?.(state, proposal);
    } catch (error) {
      throw new ImprovementTransitionConflictError(error instanceof Error ? error.message : String(error));
    }
    try {
      await selfImprovementRuntime.execute(IMPROVEMENT_STREAM, {
        type: "emit",
        eventId: eventKey,
        expectedPrev: chain.at(-1)?.hash ?? "",
        event,
      });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Expected prev hash") || attempt === 3) {
        throw error;
      }
    }
  }
};

const autonomousSelfImprovement = new AutonomousSelfImprovementController({
  framework: selfImprovementFramework,
  state: proposalState,
  emit: emitImprovement,
  emitTransition: emitImprovementTransition,
  evaluate: async (artifact, phase) => {
    const configured = artifact.artifactType === "harness_patch"
      ? Boolean(process.env.IMPROVEMENT_HARNESS_COMMAND_JSON?.trim())
      : Boolean(process.env.IMPROVEMENT_VALIDATE_COMMAND_JSON?.trim());
    return configured
      ? evaluateImprovementProposal({
          artifactType: artifact.artifactType,
          target: artifact.target,
          patch: canonicalize(artifact.patch),
          repositoryRoot: process.cwd(),
          prepareDependencies: prepareImprovementDependencies,
        })
      : evaluateCodingImprovementArtifact(artifact, phase);
  },
  rollbackFailureThreshold: 2,
});

const queue = await createSpacetimeJobQueue({
  control: spacetimeControlPlane,
  workspaceId: WORKSPACE_ID,
});
const codingContinuityControl = new SpacetimeNodeContinuityControl({
  control: spacetimeControlPlane,
  workspaceId: WORKSPACE_ID,
});
await codingContinuityControl.initialize();
const codingContinuityDataReferences = createFileSystemDataReferenceStore({
  directory: path.join(ROSTER_PLATFORM_DATA_DIR, "data-references"),
  namespace: rosterDataReferenceNamespace("coding-node-continuity"),
});
const codingNodeContinuity = new CodingNodeContinuity({
  workspaceId: WORKSPACE_ID,
  control: codingContinuityControl,
  jobs: queue,
  dataReferences: codingContinuityDataReferences,
  memoryVersion: (scopeId) => memoryTools.version(scopeId),
});

const enqueueJob = async (job: EnqueueJobInput): Promise<void> => {
  await queue.enqueue(job);
};

const createRunControl = (jobId: string) => ({
  jobId,
  checkAbort: async (): Promise<boolean> => {
    const job = await queue.getJob(jobId);
    if (!job) return false;
    if (job.status === "canceled") return true;
    if (job.abortRequested) return true;
    const abortCommands = await queue.consumeCommands(jobId, ["abort"]);
    return abortCommands.length > 0;
  },
  pullCommands: async (): Promise<ReadonlyArray<{ command: "steer" | "follow_up"; payload?: Record<string, unknown> }>> => {
    const commands = await queue.consumeCommands(jobId, ["steer", "follow_up"]);
    return commands
      .filter((cmd): cmd is typeof cmd & { command: "steer" | "follow_up" } =>
        cmd.command === "steer" || cmd.command === "follow_up"
      )
      .map((cmd) => ({ command: cmd.command, payload: cmd.payload }));
  },
});

// ============================================================================
// Agent Runner Factory
// ============================================================================

type AgentRunControl = {
  readonly jobId?: string;
  readonly checkAbort?: () => Promise<boolean>;
  readonly pullCommands?: () => Promise<ReadonlyArray<{ command: "steer" | "follow_up"; payload?: Record<string, unknown> }>>;
};

type AgentRunner = (
  payload: Record<string, unknown>,
  control?: AgentRunControl
) => Promise<Record<string, unknown> | void>;

const extractRunPayload = (payload: Record<string, unknown>, defaultStream: string) => ({
  stream: typeof payload.stream === "string" && payload.stream.trim() ? payload.stream : defaultStream,
  runId: typeof payload.runId === "string" && payload.runId.trim()
    ? payload.runId
    : `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  runStream: typeof payload.runStream === "string" && payload.runStream.trim().length > 0
    ? payload.runStream
    : undefined,
  problem: typeof payload.problem === "string" ? payload.problem : "",
});

const apiStatus = () => {
  if (!process.env.OPENAI_API_KEY) {
    return { apiReady: false, apiNote: "OPENAI_API_KEY not set" } as const;
  }
  const health = modelProviderHealth.snapshot(OPENAI_PROVIDER_ID);
  return {
    apiReady: health.state === "available",
    apiNote: health.state === "available" ? undefined : health.note,
  } as const;
};

type AgentRunnerSpec = {
  readonly defaultStream: string;
  readonly normalizeConfig: (input: Record<string, unknown>) => unknown;
  readonly runtime: unknown;
  readonly prompts: unknown;
  readonly model: string;
  readonly promptHash: string;
  readonly promptPath: string;
  readonly runFn: (input: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  readonly extras?: Record<string, unknown>;
  readonly prepare?: (input: {
    readonly stream: string;
    readonly runId: string;
    readonly runStream?: string;
    readonly problem: string;
    readonly payload: Record<string, unknown>;
    readonly control?: AgentRunControl;
  }) => Promise<{
    readonly extras?: Record<string, unknown>;
    readonly dispose?: () => void | Promise<void>;
  }>;
};

const createAgentRunner = (spec: AgentRunnerSpec): AgentRunner =>
  async (payload, control) => {
    const { stream, runId, runStream, problem } = extractRunPayload(payload, spec.defaultStream);
    const configInput = typeof payload.config === "object" && payload.config
      ? payload.config as Record<string, unknown> : {};
    const config = spec.normalizeConfig(configInput);
    const { apiReady, apiNote } = apiStatus();
    const prepared = await spec.prepare?.({
      stream,
      runId,
      runStream,
      problem,
      payload,
      control,
    });
    try {
      const runnerResult = await spec.runFn({
        stream, runId, runStream, problem, config,
        runtime: spec.runtime, prompts: spec.prompts,
        llmText: (opts: Record<string, unknown>) => llmText(opts as { system?: string; user: string }),
        model: spec.model, promptHash: spec.promptHash, promptPath: spec.promptPath,
        apiReady, apiNote, control,
        broadcast: () => undefined,
        ...(spec.extras ?? {}),
        ...(prepared?.extras ?? {}),
      });
      return {
        runId,
        stream,
        ...(runnerResult ?? {}),
      };
    } finally {
      await prepared?.dispose?.();
    }
  };

let theoremRunner: AgentRunner;
let axiomRosterRunner: AgentRunner;
let axiomSimpleRunner: AgentRunner;

const writerRunner = createAgentRunner({
  defaultStream: "agents/writer",
  normalizeConfig: normalizeWriterConfig, runtime: writerRuntime,
  prompts: WRITER_PROMPTS, model: WRITER_MODEL,
  promptHash: WRITER_PROMPTS_HASH, promptPath: WRITER_PROMPTS_PATH,
  runFn: runWriterRoster as (input: Record<string, unknown>) => Promise<void>,
  prepare: async ({ stream, runId, runStream }) => {
    const planes = await createSubscribedRosterExecutionPlanes({
      runId,
      kind: "writer",
      namespace: `writer:${runId}`,
      receiptStreamId: runStream ?? writerRunStream(stream, runId),
    });
    const { dispose, ...executionPlane } = planes;
    return {
      extras: { executionPlane },
      dispose,
    };
  },
});

const delegationTools = createDelegationTools({
  enqueue: async (opts) => {
    const created = await queue.enqueue({
      agentId: opts.agentId,
      payload: opts.payload,
      lane: "collect",
      singletonMode: "allow",
      maxAttempts: 2,
    });
    return { id: created.id };
  },
  waitForJob: async (jobId, timeoutMs) => {
    const job = await queue.waitForJob(jobId, timeoutMs, subJobPollMs);
    if (!job) throw new Error(`job ${jobId} not found`);
    return { id: job.id, status: job.status, result: job.result, lastError: job.lastError };
  },
  getJob: async (jobId) => {
    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    return { id: job.id, status: job.status, result: job.result, lastError: job.lastError };
  },
  inspectStream: async (stream) => (await eventRepository.read<Record<string, unknown>>(stream))
    .map((receipt) => ({ ts: receipt.ts, body: receipt.body })),
});

const agentRunner = createAgentRunner({
  defaultStream: "agents/agent",
  normalizeConfig: normalizeAgentConfig, runtime: agentRuntime,
  prompts: AGENT_PROMPTS, model: AGENT_MODEL,
  promptHash: AGENT_PROMPTS_HASH, promptPath: AGENT_PROMPTS_PATH,
  runFn: runAgent as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  extras: { memoryTools, delegationTools, workspaceRoot: process.cwd(), llmStructured },
});

const axiomRunner = createAgentRunner({
  defaultStream: "agents/axiom",
  normalizeConfig: normalizeAxiomConfig, runtime: agentRuntime,
  prompts: AXIOM_PROMPTS, model: AXIOM_MODEL,
  promptHash: AXIOM_PROMPTS_HASH, promptPath: AXIOM_PROMPTS_PATH,
  runFn: runAxiom as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  extras: { memoryTools, delegationTools, workspaceRoot: process.cwd(), llmStructured },
});

const clipText = (value: string | undefined, max = 280): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

const mapAxiomSimpleWorkerStatus = (status?: string): AxiomSimpleWorkerStatus => {
  switch (status) {
    case "queued":
      return "queued";
    case "leased":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "missing";
  }
};

const createTheoremExecutionPlaneFactory = (
  receiptStreamId: string,
  kind: "theorem-phase" | "axiom-phase",
) => async (scope: { readonly runId: string }) =>
  createSubscribedRosterExecutionPlanes({
    runId: scope.runId,
    kind,
    namespace: `${kind}:${scope.runId}`,
    receiptStreamId,
  });

const latestToolPath = (input: Record<string, unknown>): string | undefined => {
  const keys = [
    "path",
    "outputPath",
    "output_path",
    "formalStatementPath",
    "formal_statement_path",
    "outputDir",
    "output_dir",
  ] as const;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

const reverseFind = <T,>(items: ReadonlyArray<T>, pred: (item: T) => boolean): T | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && pred(item)) return item;
  }
  return undefined;
};

const toAxiomSimpleWorkerValidation = (
  receipt: { readonly body: Extract<AgentEvent, { readonly type: "validation.report" }> } | undefined,
): AxiomSimpleWorkerValidation | undefined => {
  if (!receipt) return undefined;
  const evidence = receipt.body.evidence;
  return {
    gate: receipt.body.gate,
    ok: receipt.body.ok,
    summary: receipt.body.summary,
    tool: evidence?.tool,
    candidateHash: evidence?.candidateHash,
    formalStatementHash: evidence?.formalStatementHash,
    candidateContent: evidence?.candidateContent,
    formalStatement: evidence?.formalStatement,
    failedDeclarations: evidence?.failedDeclarations ?? [],
  };
};

const extractAxiomSimpleWorkerData = (opts: {
  readonly runChain: Awaited<ReturnType<typeof agentRuntime.chain>>;
  readonly childRunId: string;
  readonly childStream: string;
  readonly jobId: string;
  readonly queueStatus?: string;
  readonly queueError?: string;
}) => {
  const runState = fold(opts.runChain, reduceAgent, initialAgent);
  const validations = opts.runChain.filter((receipt): receipt is typeof receipt & {
    readonly body: Extract<AgentEvent, { readonly type: "validation.report" }>;
  } => receipt.body.type === "validation.report");
  const toolCalls = opts.runChain.filter((receipt): receipt is typeof receipt & {
    readonly body: Extract<AgentEvent, { readonly type: "tool.called" }>;
  } => receipt.body.type === "tool.called");
  const toolObservations = opts.runChain.filter((receipt): receipt is typeof receipt & {
    readonly body: Extract<AgentEvent, { readonly type: "tool.observed" }>;
  } => receipt.body.type === "tool.observed");
  const failureReports = opts.runChain.filter((receipt): receipt is typeof receipt & {
    readonly body: Extract<AgentEvent, { readonly type: "failure.report" }>;
  } => receipt.body.type === "failure.report");
  const finalResponse = reverseFind(opts.runChain, (receipt) => receipt.body.type === "response.finalized") as
    | (typeof opts.runChain[number] & { readonly body: Extract<AgentEvent, { readonly type: "response.finalized" }> })
    | undefined;
  const finalStatus = reverseFind(opts.runChain, (receipt) => receipt.body.type === "run.status") as
    | (typeof opts.runChain[number] & { readonly body: Extract<AgentEvent, { readonly type: "run.status" }> })
    | undefined;
  const latestValidation = validations[validations.length - 1];
  const successfulVerifyReceipt = reverseFind(validations, (receipt) => {
    const evidence = receipt.body.evidence;
    if (!receipt.body.ok) return false;
    if (!evidence?.candidateHash || !evidence.formalStatementHash) return false;
    return evidence.tool === "lean.verify" || evidence.tool === "lean.verify_file";
  });
  const latestObservation = toolObservations[toolObservations.length - 1];
  const latestTool = toolCalls[toolCalls.length - 1];
  const touchedPaths = [...new Set(toolCalls
    .map((receipt) => latestToolPath(receipt.body.input))
    .filter((value): value is string => Boolean(value)))];

  let status = mapAxiomSimpleWorkerStatus(opts.queueStatus);
  if ((status === "queued" || status === "running" || status === "missing") && runState.status === "completed") status = "completed";
  if ((status === "queued" || status === "running" || status === "missing") && runState.status === "failed") status = "failed";

  const validation = toAxiomSimpleWorkerValidation(latestValidation);
  const successfulVerify = toAxiomSimpleWorkerValidation(successfulVerifyReceipt);
  const candidateHash = successfulVerify?.candidateHash ?? validation?.candidateHash;
  const formalStatementHash = successfulVerify?.formalStatementHash ?? validation?.formalStatementHash;
  const failedDeclarations = successfulVerify?.failedDeclarations ?? validation?.failedDeclarations ?? [];
  const failureMessage = failureReports[failureReports.length - 1]?.body.failure.message
    ?? finalStatus?.body.note
    ?? opts.queueError;
  const failureCount = toolCalls.filter((receipt) => Boolean(receipt.body.error)).length
    + validations.filter((receipt) => !receipt.body.ok).length
    + failureReports.length;
  const outputExcerpt = clipText(
    finalResponse?.body.content
    ?? latestValidation?.body.summary
    ?? finalStatus?.body.note
    ?? failureMessage,
  );
  const summary = [
    status === "missing" ? `status: ${opts.queueStatus ?? "missing"}` : `status: ${status}`,
    latestValidation?.body.summary ? `validation: ${latestValidation.body.summary}` : "",
    finalStatus?.body.note ? `note: ${finalStatus.body.note}` : "",
    failureMessage && failureMessage !== finalStatus?.body.note ? `failure: ${failureMessage}` : "",
    clipText(finalResponse?.body.content, 400) ?? "",
  ].filter(Boolean).join("\n");

  const snapshot: AxiomSimpleWorkerSnapshot = {
    childRunId: opts.childRunId,
    jobId: opts.jobId,
    childStream: opts.childStream,
    status,
    iteration: runState.iteration,
    lastTool: latestTool?.body.tool,
    lastToolSummary: latestTool?.body.summary ?? latestTool?.body.error,
    validationGate: latestValidation?.body.gate,
    validationSummary: latestValidation?.body.summary,
    validationOk: latestValidation?.body.ok,
    verifyTool: successfulVerify?.tool,
    verified: successfulVerify?.ok,
    outputExcerpt,
    observationExcerpt: clipText(latestObservation?.body.output),
    touchedPath: touchedPaths[touchedPaths.length - 1],
    candidateHash,
    formalStatementHash,
    failedDeclarations,
    failureCount,
  };

  return {
    status,
    snapshot,
    summary: summary || `Axiom worker ${opts.childRunId} produced no receipts yet.`,
    finalResponse: finalResponse?.body.content,
    validation,
    successfulVerify,
    candidateContent: successfulVerify?.candidateContent ?? validation?.candidateContent ?? finalResponse?.body.content,
    formalStatement: successfulVerify?.formalStatement ?? validation?.formalStatement,
    failureMessage,
    touchedPaths,
    signature: JSON.stringify({
      status,
      iteration: runState.iteration,
      tool: latestTool?.body.tool,
      validation: latestValidation?.body.summary,
      response: finalResponse?.body.content,
      failure: failureMessage,
      candidateHash,
      formalStatementHash,
      touchedPath: touchedPaths[touchedPaths.length - 1],
    }),
  };
};

const launchAxiomSimpleWorker: AxiomSimpleWorkerLauncher = async (input) => {
  const childRunId = `${input.parentRunId}_${input.workerId}_${Date.now().toString(36)}`;
  const childStream = "agents/axiom";
  const created = await queue.enqueue({
    agentId: "axiom",
    lane: "follow_up",
    sessionKey: `axiom-simple:${input.parentRunId}:${input.workerId}`,
    singletonMode: "allow",
    maxAttempts: 2,
    payload: {
      kind: "axiom.run",
      stream: childStream,
      runId: childRunId,
      problem: input.task,
      config: {
        maxIterations: 12,
        maxToolOutputChars: 6_000,
        memoryScope: "axiom",
        workspace: ".",
        leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
        leanTimeoutSeconds: 120,
        autoRepair: true,
        ...(input.config ?? {}),
      },
      isSubAgent: true,
    },
  });

  await input.onStarted?.({
    jobId: created.id,
    childRunId,
    childStream,
    status: "queued",
  });

  const requestedTimeoutMs = input.timeoutMs ?? subJobJoinWaitMs;
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(0, Math.min(Math.floor(requestedTimeoutMs), 600_000))
    : subJobJoinWaitMs;
  let lastSignature = "";
  let latestData: ReturnType<typeof extractAxiomSimpleWorkerData> | undefined;

  const observeWorker = async (job: Awaited<ReturnType<typeof queue.getJob>>) => {
    const runChain = await agentRuntime.chain(agentRunStream(childStream, childRunId));
    const data = extractAxiomSimpleWorkerData({
      runChain,
      childRunId,
      childStream,
      jobId: created.id,
      queueStatus: job?.status,
      queueError: job?.lastError,
    });
    latestData = data;

    if (data.signature !== lastSignature) {
      lastSignature = data.signature;
      await input.onProgress?.(data.snapshot);
    }
  };

  const waited = await waitForOwnedJob({
    queue,
    jobId: created.id,
    timeoutMs,
    pollMs: subJobPollMs,
    timeoutReason: `Axiom Simple worker timed out after ${timeoutMs}ms`,
    canceledBy: `axiom-simple:${input.parentRunId}`,
    onObserved: observeWorker,
  });

  if (waited.job && isTerminalQueueJob(waited.job) && !waited.timedOut) {
    const data = latestData;
    if (data) {
      return {
        workerId: input.workerId,
        label: input.label,
        strategy: input.strategy,
        phase: input.phase,
        sourceWorkerId: input.sourceWorkerId,
        status: data.status,
        jobId: created.id,
        childRunId,
        childStream,
        snapshot: data.snapshot,
        summary: data.summary,
        finalResponse: data.finalResponse,
        validation: data.validation,
        successfulVerify: data.successfulVerify,
        candidateContent: data.candidateContent,
        formalStatement: data.formalStatement,
        failureMessage: data.failureMessage,
        touchedPaths: data.touchedPaths,
      };
    }
  }

  const timedData = latestData ?? extractAxiomSimpleWorkerData({
    runChain: await agentRuntime.chain(agentRunStream(childStream, childRunId)),
    childRunId,
    childStream,
    jobId: created.id,
    queueStatus: waited.job?.status,
    queueError: waited.job?.lastError,
  });
  const timeoutNote = waited.timedOut
    ? `timed out after ${timeoutMs}ms; child job canceled`
    : `child job missing (${created.id})`;
  const timeoutSummary = [
    timeoutNote,
    timedData.validation?.summary ? `validation: ${timedData.validation.summary}` : "",
    timedData.failureMessage ? `failure: ${timedData.failureMessage}` : "",
    clipText(timedData.finalResponse, 400) ?? "",
  ].filter(Boolean).join("\n");

  return {
    workerId: input.workerId,
    label: input.label,
    strategy: input.strategy,
    phase: input.phase,
    sourceWorkerId: input.sourceWorkerId,
    status: "failed",
    jobId: created.id,
    childRunId,
    childStream,
    snapshot: timedData.snapshot,
    summary: timeoutSummary || timeoutNote,
    finalResponse: timedData.finalResponse,
    validation: timedData.validation,
    successfulVerify: timedData.successfulVerify,
    candidateContent: timedData.candidateContent,
    formalStatement: timedData.formalStatement,
    failureMessage: [timeoutNote, timedData.failureMessage].filter(Boolean).join("; "),
    touchedPaths: timedData.touchedPaths,
  };
};

const delegateAxiomForTheorem = async (input: {
  readonly task: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}) => {
  const runId = `theorem_axiom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const stream = "agents/axiom";
  const created = await queue.enqueue({
    agentId: "axiom",
    lane: "follow_up",
    sessionKey: `theorem:axiom:${runId}`,
    singletonMode: "allow",
    maxAttempts: 2,
    payload: {
      kind: "axiom.run",
      stream,
      runId,
      problem: input.task,
      config: {
        maxIterations: 12,
        maxToolOutputChars: 6_000,
        memoryScope: "axiom",
        workspace: ".",
        leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
        leanTimeoutSeconds: 120,
        autoRepair: true,
        ...(input.config ?? {}),
      },
      isSubAgent: true,
    },
  });

  const requestedTimeoutMs = input.timeoutMs ?? 180_000;
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(0, Math.min(Math.floor(requestedTimeoutMs), 600_000))
    : 180_000;
  const waited = await waitForOwnedJob({
    queue,
    jobId: created.id,
    timeoutMs,
    pollMs: subJobPollMs,
    timeoutReason: `Theorem Axiom delegation timed out after ${timeoutMs}ms`,
    canceledBy: `theorem:${runId}`,
  });
  const settled = waited.job;
  if (!settled) {
    return {
      jobId: created.id,
      runId,
      stream,
      status: "missing",
      summary: `Axiom subjob missing (${created.id}).`,
    };
  }
  if (waited.timedOut) {
    return {
      jobId: created.id,
      runId,
      stream,
      status: "failed",
      outcome: "delegate_timeout",
      summary: `Axiom subjob timed out after ${timeoutMs}ms and was canceled (${created.id}).`,
    };
  }

  const runChain = await agentRuntime.chain(agentRunStream(stream, runId));
  const finalResponse = [...runChain].reverse().find((receipt) => receipt.body.type === "response.finalized") as
    | { body: Extract<AgentEvent, { type: "response.finalized" }> }
    | undefined;
  const finalStatus = [...runChain].reverse().find((receipt) => receipt.body.type === "run.status") as
    | { body: Extract<AgentEvent, { type: "run.status" }> }
    | undefined;
  const validations = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
    receipt.body.type === "validation.report"
  );
  const toolCalls = runChain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.called" }> } =>
    receipt.body.type === "tool.called"
  );
  const leanTools = [...new Set(toolCalls
    .map((receipt) => receipt.body.tool)
    .filter((tool) => tool.startsWith("lean.")))];
  const axleValidations = validations.filter((receipt) =>
    receipt.body.gate.startsWith("axle")
    && receipt.body.evidence
  );
  const verifyValidations = axleValidations.filter((receipt) => {
    const tool = receipt.body.evidence?.tool;
    return tool === "lean.verify" || tool === "lean.verify_file";
  });
  const successfulFinalVerify = [...verifyValidations].reverse().find((receipt) =>
    receipt.body.ok
    && receipt.body.evidence?.candidateHash
    && receipt.body.evidence?.formalStatementHash
  );
  const theoremToSorryFailure = [...toolCalls].reverse().find((receipt) =>
    (receipt.body.tool === "lean.theorem2sorry" || receipt.body.tool === "lean.theorem2sorry_file")
    && Boolean(receipt.body.error)
  );
  const latestValidation = validations[validations.length - 1];

  const validationEvidence = axleValidations
    .map((receipt) => {
      const evidence = receipt.body.evidence;
      if (!evidence?.tool) return undefined;
      return {
        tool: evidence.tool,
        environment: evidence.environment,
        candidateHash: evidence.candidateHash,
        formalStatementHash: evidence.formalStatementHash,
        candidateContent: evidence.candidateContent,
        formalStatement: evidence.formalStatement,
        ok: receipt.body.ok,
        failedDeclarations: evidence.failedDeclarations ?? [],
        timings: evidence.timings,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const requiredValidation = input.config?.requiredValidation;
  const requiresFinalVerify = Boolean(
    requiredValidation
    && typeof requiredValidation === "object"
    && !Array.isArray(requiredValidation)
    && (requiredValidation as Readonly<Record<string, unknown>>).kind === "axle-verify"
  );
  const successfulAxleCheck = [...axleValidations].reverse().find((receipt) => receipt.body.ok);

  const outcome = (() => {
    if (settled.status === "canceled") return "delegate_canceled";
    if (settled.status === "failed") return "delegate_failed";
    if (finalStatus?.body.status === "failed") return "delegate_failed";
    if (theoremToSorryFailure) return "theorem2sorry_failed";
    if (verifyValidations.length === 0 && axleValidations.length === 0) return "no_axle_validation";
    if (verifyValidations.length === 0) {
      if (requiresFinalVerify) return "no_final_verify";
      return successfulAxleCheck ? "checked" : "axle_check_failed";
    }
    if (!successfulFinalVerify) return "axle_verify_failed";
    return "verified";
  })();

  const summary = [
    `status: ${settled.status}`,
    `outcome: ${outcome}`,
    leanTools.length > 0 ? `AXLE tools: ${leanTools.join(", ")}` : "",
    finalStatus?.body.note ? `note: ${finalStatus.body.note}` : "",
    latestValidation?.body.summary ? `validation: ${latestValidation.body.summary}` : "",
    finalResponse?.body.content ?? "",
  ].filter(Boolean).join("\n");

  return {
    jobId: created.id,
    runId,
    stream,
    status: settled.status,
    outcome,
    evidence: validationEvidence,
    verifiedCandidateContent: successfulFinalVerify?.body.evidence?.candidateContent,
    verifiedCandidateHash: successfulFinalVerify?.body.evidence?.candidateHash,
    verifiedFormalStatementHash: successfulFinalVerify?.body.evidence?.formalStatementHash,
    summary: summary || JSON.stringify(settled.result ?? { status: settled.status }),
  };
};

theoremRunner = createAgentRunner({
  defaultStream: "agents/theorem",
  normalizeConfig: normalizeTheoremConfig, runtime: theoremRuntime,
  prompts: THEOREM_PROMPTS, model: THEOREM_MODEL,
  promptHash: THEOREM_PROMPTS_HASH, promptPath: THEOREM_PROMPTS_PATH,
  runFn: runTheoremRoster as unknown as (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  extras: { axiomDelegate: delegateAxiomForTheorem },
  prepare: async ({ stream, runId, runStream }) => ({
    extras: {
      createPlatformExecutionPlanes: createTheoremExecutionPlaneFactory(
        runStream ?? theoremRunStream(stream, runId),
        "theorem-phase",
      ),
    },
  }),
});

axiomRosterRunner = async (payload, control) => {
  const { stream, runId, runStream, problem } = extractRunPayload(payload, "agents/axiom-roster");
  const configInput = typeof payload.config === "object" && payload.config
    ? payload.config as Record<string, unknown>
    : {};
  const config = normalizeTheoremConfig(configInput);
  const { apiReady, apiNote } = apiStatus();
  const receiptStreamId = runStream ?? theoremRunStream(stream, runId);
  const result = await runTheoremRoster({
    stream,
    runId,
    runStream,
    problem,
    config,
    runtime: theoremRuntime,
    prompts: AXIOM_ROSTER_PROMPTS,
    llmText,
    model: AXIOM_ROSTER_MODEL,
    promptHash: AXIOM_ROSTER_PROMPTS_HASH,
    promptPath: AXIOM_ROSTER_PROMPTS_PATH,
    apiReady,
    apiNote,
    control,
    broadcast: () => undefined,
    axiomDelegate: delegateAxiomForTheorem,
    createPlatformExecutionPlanes: createTheoremExecutionPlaneFactory(
      receiptStreamId,
      "axiom-phase",
    ),
    axiomPolicy: "required",
    axiomConfig: {
      maxIterations: 12,
      leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
      autoRepair: true,
    },
  });
  const recovery = control?.jobId
    ? await maybeQueueAxiomRosterVerifyFailureFollowUp({
        queue,
        theoremRuntime,
        payload,
        result,
        jobId: control.jobId,
        onJobQueued: () => undefined,
        onReceipt: () => undefined,
  })
    : {};
  return { ...result, ...recovery };
};

axiomSimpleRunner = async (payload, control) => {
  const { stream, runId, runStream, problem } = extractRunPayload(payload, "agents/axiom-simple");
  const configInput = typeof payload.config === "object" && payload.config
    ? payload.config as Record<string, unknown>
    : {};
  const config = normalizeAxiomSimpleConfig(configInput);
  const result = await runAxiomSimple({
    stream,
    runId,
    runStream,
    problem,
    config,
    runtime: axiomSimpleRuntime,
    control,
    launchWorker: launchAxiomSimpleWorker,
    broadcast: () => undefined,
  });
  return result as unknown as Record<string, unknown>;
};

const inspectorRunner = async (payload: Record<string, unknown>): Promise<void> => {
  const runId = typeof payload.runId === "string" && payload.runId.trim()
    ? payload.runId
    : `inspect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const groupId = typeof payload.groupId === "string" ? payload.groupId : undefined;
  const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
  const agentName = typeof payload.agentName === "string" ? payload.agentName : undefined;
  const sourceName = typeof payload.source === "object" && payload.source && typeof (payload.source as Record<string, unknown>).name === "string"
    ? String((payload.source as Record<string, unknown>).name)
    : "";
  const mode = typeof payload.mode === "string"
    && ["analyze", "improve", "timeline", "qa"].includes(payload.mode)
    ? payload.mode as "analyze" | "improve" | "timeline" | "qa"
    : "analyze";
  const order = payload.order === "asc" ? "asc" : "desc";
  const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
    ? Math.max(10, Math.min(Math.floor(payload.limit), 5000))
    : 200;
  const at = typeof payload.at === "number" && Number.isFinite(payload.at)
    ? Math.max(0, Math.floor(payload.at))
    : undefined;
  const depth = typeof payload.depth === "number" && Number.isFinite(payload.depth)
    ? Math.max(1, Math.min(Math.floor(payload.depth), 3))
    : 2;
  const question = typeof payload.question === "string" && payload.question.trim() ? payload.question : "Analyze this run.";
  const provider = apiStatus();
  const apiReady = typeof payload.apiReady === "boolean"
    ? payload.apiReady && provider.apiReady
    : provider.apiReady;
  const apiNote = typeof payload.apiNote === "string"
    ? payload.apiNote
    : (apiReady ? undefined : provider.apiNote);
  if (!sourceName) throw new Error("inspector source stream required");
  const safeSourceName = await ensureInspectorStreamExists(sourceName);

  await runReceiptInspector({
    stream: inspectorAnalysisStream(safeSourceName),
    runId,
    groupId,
    agentId,
    agentName,
    source: { kind: "stream", name: safeSourceName },
    order,
    limit,
    at,
    question,
    mode,
    depth,
    runtime: inspectorRuntime,
    prompts: INSPECTOR_PROMPTS,
    llmText,
    model: INSPECTOR_MODEL,
    promptHash: INSPECTOR_PROMPTS_HASH,
    promptPath: INSPECTOR_PROMPTS_PATH,
    apiReady,
    apiNote,
    tools: {
      readStream: async (sourceStream) => inspectorRecordsFromChain(await inspectorRuntime.chain(sourceStream)),
      sliceRecords: sliceInspectorRecords,
      buildContext: buildInspectorContext,
      buildTimeline: buildInspectorTimeline,
    },
  });
};

const parseDelegateTask = (payload: Record<string, unknown> | undefined): { task: string; agentId?: string } | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = payload.delegate_task;
  if (!candidate || typeof candidate !== "object") return undefined;
  const rec = candidate as Record<string, unknown>;
  const task = typeof rec.task === "string" ? rec.task.trim() : "";
  if (!task) return undefined;
  const agentId = typeof rec.agentId === "string" && rec.agentId.trim().length > 0 ? rec.agentId.trim() : undefined;
  return { task, agentId };
};

type SubJobSummary = {
  readonly summary: string;
  readonly done: boolean;
};

const summarizeSubJobSnapshot = (
  done: Awaited<ReturnType<typeof queue.getJob>>,
): SubJobSummary => {
  if (!done) return { summary: "sub-agent status: missing", done: true };
  if (done.status === "completed") return { summary: JSON.stringify(done.result ?? { status: done.status }), done: true };
  if (done.status === "queued" || done.status === "leased" || done.status === "running") {
    return { summary: `sub-agent status: pending (${done.status}; job ${done.id})`, done: false };
  }
  return { summary: `sub-agent status: ${done.status}`, done: true };
};

const summarizeSubJob = async (jobId: string, timeoutMs = subJobWaitMs): Promise<SubJobSummary> => {
  const done = await queue.waitForJob(jobId, timeoutMs, subJobPollMs);
  const summarized = summarizeSubJobSnapshot(done);
  return !done && summarized.done
    ? { ...summarized, summary: `sub-agent status: missing (${jobId})` }
    : summarized;
};

const scheduleSubJobJoin = (opts: {
  readonly parentJobId: string;
  readonly subJobId: string;
  readonly subRunId: string;
  readonly emitMerged: (summary: string) => Promise<void>;
}) => {
  void (async () => {
    const waited = await waitForOwnedJob({
      queue,
      jobId: opts.subJobId,
      timeoutMs: subJobJoinWaitMs,
      pollMs: subJobPollMs,
      timeoutReason: `Sub-agent join timed out after ${subJobJoinWaitMs}ms`,
      canceledBy: "subagent-join",
    });
    const settled = waited.timedOut
      ? {
        summary: `sub-agent join timed out after ${subJobJoinWaitMs}ms; cancellation requested; status: ${waited.job?.status ?? "missing"} (job ${opts.subJobId})`,
        done: true,
      }
      : summarizeSubJobSnapshot(waited.job);

    await opts.emitMerged(settled.summary);

    const parent = await queue.getJob(opts.parentJobId);
    if (!parent) return;
    if (parent.status === "queued" || parent.status === "leased" || parent.status === "running") {
      await queue.queueCommand({
        jobId: opts.parentJobId,
        command: "follow_up",
        payload: { note: `Sub-agent summary (${opts.subRunId}):\n${settled.summary}` },
        by: "subagent-join",
      });
    }
  })().catch((err) => {
    console.error("sub-agent join failed", err);
  });
};

// ============================================================================
// Worker Handler Factory
// ============================================================================

type WorkerHandlerSpec = {
  readonly defaultStream: string;
  readonly defaultAgentId: string;
  readonly kind: string;
  readonly defaultSubConfig: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly runtime: { execute: (stream: string, cmd: any) => Promise<unknown> };
  readonly runStreamFn: (base: string, runId: string) => string;
  readonly runner: AgentRunner;
  readonly mergeEventExtras?: Record<string, unknown>;
};

const mergeCommands = (
  merged: Record<string, unknown>,
  commands: ReadonlyArray<{ command: string; payload?: Record<string, unknown> }>,
) => {
  for (const cmd of commands) {
    if (cmd.command === "steer" && cmd.payload) {
      if (typeof cmd.payload.problem === "string") merged.problem = cmd.payload.problem;
      if (typeof cmd.payload.config === "object" && cmd.payload.config) {
        merged.config = { ...(merged.config as Record<string, unknown> | undefined), ...(cmd.payload.config as Record<string, unknown>) };
      }
    }
    if (cmd.command === "follow_up" && typeof cmd.payload?.note === "string") {
      const base = typeof merged.problem === "string" ? merged.problem : "";
      merged.problem = `${base}\n\nFollow-up:\n${cmd.payload.note}`.trim();
    }
  }
};

const handleDelegates = async (
  spec: WorkerHandlerSpec,
  job: { readonly id: string; readonly payload: Record<string, unknown> },
  merged: Record<string, unknown>,
  commands: ReadonlyArray<{ command: string; payload?: Record<string, unknown> }>,
) => {
  if (Boolean(merged.isSubAgent)) return;
  for (const cmd of commands) {
    if (cmd.command !== "follow_up") continue;
    const delegate = parseDelegateTask(cmd.payload as Record<string, unknown> | undefined);
    if (!delegate) continue;

    const parentStream = String(merged.stream);
    const parentRunId = String(merged.runId);
    const subRunId = `${parentRunId}_sub_${Date.now().toString(36)}`;
    const subStream = `${parentStream}/sub/${subRunId}`;

    const subJob = await queue.enqueue({
      agentId: delegate.agentId ?? spec.defaultAgentId,
      lane: "follow_up",
      sessionKey: `subagent:${job.id}:${subRunId}`,
      singletonMode: "allow",
      maxAttempts: 1,
      payload: {
        kind: spec.kind,
        stream: subStream, runId: subRunId,
        problem: delegate.task,
        config: spec.defaultSubConfig,
        isSubAgent: true,
      },
    });

    const summaryNow = await summarizeSubJob(subJob.id);
    const base = typeof merged.problem === "string" ? merged.problem : "";
    merged.problem = `${base}\n\nSub-agent summary (${subRunId}):\n${summaryNow.summary}`.trim();

    const rs = typeof merged.runStream === "string" && merged.runStream.trim().length > 0
      ? merged.runStream
      : spec.runStreamFn(parentStream, parentRunId);

    const mergedEvent = {
      type: "subagent.merged", runId: parentRunId, agentId: "orchestrator",
      subJobId: subJob.id, subRunId, task: delegate.task,
      ...(spec.mergeEventExtras ?? {}),
    };

    const emitMerged = async (summary: string) => {
      await spec.runtime.execute(rs, {
        type: "emit", eventId: makeEventId(rs),
        event: { ...mergedEvent, summary },
      });
    };

    await emitMerged(summaryNow.summary);

    if (!summaryNow.done) {
      scheduleSubJobJoin({ parentJobId: job.id, subJobId: subJob.id, subRunId, emitMerged });
    }
  }
};

const createWorkerHandler = (spec: WorkerHandlerSpec): JobHandler =>
  async (job, ctx) => {
    const commands = await ctx.pullCommands(["steer", "follow_up"]);
    const merged = { ...job.payload } as Record<string, unknown>;
    if (typeof merged.stream !== "string" || !merged.stream.trim()) merged.stream = spec.defaultStream;
    if (typeof merged.runId !== "string" || !merged.runId.trim()) {
      merged.runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    }
    mergeCommands(merged, commands);
    await handleDelegates(spec, job, merged, commands);
    const result = await spec.runner(merged, createRunControl(job.id));
    const normalizedResult: Record<string, unknown> = {
      runId: merged.runId as string | undefined,
      stream: merged.stream as string | undefined,
      ...(result ?? {}),
    };
    if (normalizedResult.status === "failed") {
      const failure = typeof normalizedResult.failure === "object" && normalizedResult.failure && !Array.isArray(normalizedResult.failure)
        ? normalizedResult.failure as Record<string, unknown>
        : undefined;
      const failureMessage = typeof failure?.message === "string" && failure.message.trim()
        ? failure.message
        : undefined;
      return {
        ok: false,
        error: typeof normalizedResult.note === "string" && normalizedResult.note.trim()
          ? normalizedResult.note
          : failureMessage
            ? failureMessage
          : "run failed",
        result: normalizedResult,
        noRetry: !jobResultRequestsRetry(normalizedResult),
      };
    }
    return { ok: true, result: normalizedResult };
  };

const observePinnedCodingImprovements = async (
  pin: CodingImprovementRuntimePin | undefined,
  execution: CodingAgentExecutionResult,
): Promise<void> => {
  if (!pin || pin.snapshot.improvements.length === 0) return;
  const verdict = execution.status === "completed" ? "passed" as const : "failed" as const;
  const observedAt = Date.now();
  const evidenceHash = hashCanonical({
    schemaVersion: "roster.coding-improvement-observation.v1",
    runId: execution.runId,
    snapshotHash: pin.snapshot.snapshotHash,
    status: execution.status,
    completion: execution.completion,
  });
  for (const improvement of pin.snapshot.improvements) {
    await autonomousSelfImprovement.observe({
      proposalId: improvement.proposalId,
      runId: execution.runId,
      verdict,
      evidenceHash,
      observedAt,
    });
  }
};

const admitAcceptedCodingImprovement = async (
  execution: CodingAgentExecutionResult,
  dataReferences: DataReferenceStore,
): Promise<void> => {
  const projection = await projectCodingAcceptedOutputs(execution.snapshot, dataReferences);
  await admitCodingAutonomousImprovement(
    projection,
    (input) => autonomousSelfImprovement.admit(input),
  );
};

await selfImprovementFramework.reconcile(await selfImprovementRuntime.state(IMPROVEMENT_STREAM));
await autonomousSelfImprovement.resumeAll().catch((error) => {
  console.error("Autonomous self-improvement resume failed", error);
});

const worker = new JobWorker({
  queue,
  workerId: jobWorkerId,
  pollMs: jobPollMs,
  leaseMs: jobLeaseMs,
  concurrency: Math.max(1, Number(process.env.JOB_CONCURRENCY ?? 10)),
  onError: (error) => console.error("Roster job worker error", error),
  handlers: selectServerSurfaceJobHandlers(SERVER_SURFACE, {
    "coding-agent": async (job, ctx) => {
      const continuityWake = await codingNodeContinuity.unwrap(job);
      if (continuityWake) {
        if (!job.leaseOwner || !job.leaseFence) {
          return { ok: false, error: "coding continuity wake requires an active durable worker lease", noRetry: false };
        }
        await codingContinuityControl.admitWake({
          workspaceId: WORKSPACE_ID,
          nodeId: continuityWake.manifest.nodeId,
          wakeId: continuityWake.manifest.wake.wakeId,
          admittedAt: Date.now(),
          lease: { workerId: job.leaseOwner, fence: job.leaseFence },
        });
        job = continuityWake.job;
      }
      const objective = typeof job.payload.objective === "string" ? job.payload.objective.trim() : "";
      const runId = typeof job.payload.runId === "string" ? job.payload.runId.trim() : "";
      const conversationId = typeof job.payload.conversationId === "string"
        ? job.payload.conversationId.trim()
        : runId;
      const runStream = typeof job.payload.runStream === "string" ? job.payload.runStream.trim() : "";
      const workingDirectory = typeof job.payload.workingDirectory === "string"
        ? job.payload.workingDirectory.trim()
        : "";
      if (!objective || !runId || !conversationId || !runStream || !workingDirectory) {
        return { ok: false, error: "coding-agent job requires objective, runId, runStream, and an explicit workspace root", noRetry: true };
      }
      if (job.payload.kind === "coding-agent.workspace-rescan") {
        try {
          const snapshottedDiscovery = parseCodingWorkerExecution(job.payload.discoveryExecution);
          if (job.payload.discoveryExecution !== undefined && !snapshottedDiscovery) {
            return { ok: false, error: "workspace-rescan job contains an invalid discovery execution snapshot", noRetry: true };
          }
          const discoveryExecution = createCodingWorkspaceDiscoveryExecution({
            ...(snapshottedDiscovery ? { execution: snapshottedDiscovery } : {}),
          });
          if (discoveryExecution.runtime !== "pi-agent") {
            return { ok: false, error: "workspace-rescan discovery must use Pi", noRetry: true };
          }
          const rescanPlanes = await createSubscribedRosterExecutionPlanes({
            runId,
            kind: "coding-workspace-rescan",
            receiptStreamId: runStream,
            namespace: `coding-workspace-rescan:${runId}`,
          });
          try {
            const result = await executeCodingWorkspaceRescanJob({
              runtime: codingRuntime,
              job,
              ...rescanPlanes,
              reviewer: piCodingWorkspaceAgentReviewer(codingNodeRuntimes, {
                execution: discoveryExecution,
                runId,
                signal: ctx.signal,
                onLog: (entry) => codingRuntimeLogs.append(entry),
              }),
              ...(codingUsesLocalRuntimesOnly()
                ? {}
                : { toolchainOnboarder: modelCodingWorkspaceToolchainOnboarder(llmStructured) }),
              assertLease: ctx.assertLease,
              signal: ctx.signal,
            });
            return { ok: true, result };
          } finally {
            await rescanPlanes.dispose();
          }
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            noRetry: true,
          };
        }
      }
      const executionKind = job.payload.executionKind === "investigation"
        ? "investigation" as const
        : "mutation" as const;
      let improvementRuntime: ReturnType<typeof parseCodingImprovementRuntimePin> | undefined;
      try {
        improvementRuntime = job.payload.improvementRuntime === undefined
          ? undefined
          : parseCodingImprovementRuntimePin(job.payload.improvementRuntime);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          noRetry: true,
        };
      }
      const humanResolution = job.payload.humanResolution === undefined
        ? undefined
        : parseCodingPeerResolution(JSON.stringify(job.payload.humanResolution));
      if (job.payload.humanResolution !== undefined && (
        !humanResolution
        || humanResolution.status === "ambiguous"
        || humanResolution.unresolved.length > 0
      )) {
        return { ok: false, error: "coding-agent job contains an invalid human collaboration resolution", noRetry: true };
      }
      if (!job.leaseOwner || job.leaseFence === undefined) {
        return { ok: false, error: "coding-agent job requires an active durable worker lease", noRetry: false };
      }
      await ctx.assertLease();
      const roomId = codingRepositoryRoomId(conversationId);
      const conversationStream = `agents/coding-agent/runs/${conversationId}`;
      const conversationReceipts = await codingRuntime.chain(conversationStream);
      const conversationEvents = conversationReceipts.map((receipt) => receipt.body);
      const recordedRoomFrontier = codingRoomGitFrontierFromEvents(conversationEvents);
      const roomBranch = await ensureGitRoomBranch({
        repositoryRoot: workingDirectory,
        roomId,
        ...(recordedRoomFrontier ? {
          recorded: {
            branchName: recordedRoomFrontier.branch,
            commit: recordedRoomFrontier.commit,
            ...(recordedRoomFrontier.targetBranch ? {
              targetBranch: recordedRoomFrontier.targetBranch,
              targetCommit: recordedRoomFrontier.targetCommit,
            } : {}),
          },
        } : {}),
      });
      const roomFrontier = recordedRoomFrontier ?? createCodingRoomGitFrontier({
        conversationId,
        roomId,
        branch: roomBranch.branchName,
        commit: roomBranch.commit,
        epoch: 0,
        ...(roomBranch.targetBranch ? {
          targetBranch: roomBranch.targetBranch,
          targetCommit: roomBranch.targetCommit,
        } : {}),
      });
      if (roomBranch.created) {
        await codingRuntime.execute(conversationStream, {
          type: "emit",
          eventId: `coding-room-frontier:${roomFrontier.frontierId}`,
          event: codingRoomGitFrontierEvent(roomFrontier),
        });
      }
      const codingRoom = codingRoomProjection({
        conversationId,
        job: {
          id: job.id,
          status: job.status,
          branch: roomBranch.branchName,
          objective,
        },
        nodes: [],
      });
      const codingExecutionPlanes = await createSubscribedRosterExecutionPlanes({
        runId,
        kind: executionKind === "investigation" ? "coding-investigation" : "coding",
        receiptStreamId: runStream,
        namespace: `coding:${runId}`,
        roomId: codingRoom.roomId,
        roomKey: `coding:${codingRoom.roomId}`,
        roomTitle: codingRoom.title,
      });
      const trajectoryMemory = createNodeTrajectoryRollupCollector({
        dataReferences: codingExecutionPlanes.dataReferences,
      });
      try {
        const current = await queue.getJob(job.id);
        if (current?.status === "canceled") {
          return { ok: false, error: "coding job was superseded before execution", noRetry: true };
        }
        if (typeof job.payload.workspaceProfileStream !== "string") {
          return { ok: false, error: "coding job is missing its Roster v2 workspace profile stream", noRetry: true };
        }
        const workspaceProfileStream = job.payload.workspaceProfileStream;
        const workspaceState = await codingRuntime.state(workspaceProfileStream).catch(() => initialOrchestrationState);
        const workspaceNodes = codingWorkspaceNodesFromState(workspaceState);
        const parsedWorkspaceProfile = parseCodingWorkspaceProfile(
          orchestrationOutputValues(workspaceState)[CODING_WORKSPACE_PROFILE_OUTPUT],
          workspaceNodes,
        );
        const participantProfiles = spacetimeControlPlane.workspaceSnapshot(WORKSPACE_ID)
          .participantProfiles.flatMap((row) => {
            const profile = workspaceParticipantProfileFromRow(row);
            return profile ? [profile] : [];
          });
        const effectiveWorkspaceNodes = applyWorkspaceParticipantProfiles(
          parsedWorkspaceProfile?.nodes ?? workspaceNodes,
          participantProfiles,
          new Set(CODING_WORKSPACE_CAPABILITIES.map((capability) => capability.id)),
        );
        const workspaceProfile = parsedWorkspaceProfile
          ? { ...parsedWorkspaceProfile, nodes: effectiveWorkspaceNodes }
          : undefined;
        const workspace = await createGitRunWorkspace({
          repositoryRoot: workingDirectory,
          runId,
          baseBranch: roomBranch.branchName,
          expectedBaseCommit: roomFrontier.commit,
        });
        const executionDirectory = workspace.workingDirectory;
        try {
          if (executionKind === "mutation") {
            await prepareGitRunWorkspaceDependencies(workspace, {
              ...(workspaceProfile?.executionProfile ? { executionProfile: workspaceProfile.executionProfile } : {}),
              signal: ctx.signal,
            });
          }
          await ctx.assertLease();
          const reviewPolicy = job.payload.reviewPolicy === "fast" || job.payload.reviewPolicy === "reviewed"
            ? job.payload.reviewPolicy
            : "auto";
          const workerExecution = parseCodingWorkerExecution(job.payload.workerExecution);
          if (!workerExecution) {
            return { ok: false, error: "coding-agent job is missing a valid Roster v2 worker execution snapshot", noRetry: true };
          }
          const workerRuntime = workerExecution.runtime;
          const reviewerRuntime: CodingReviewerRuntime = job.payload.reviewerRuntime === "claude-code"
            ? "claude-code"
            : "codex-cli";
          const repositorySkills = await discoverCodingRepositorySkills(executionDirectory);
          const selectedNodeIds = Array.isArray(job.payload.selectedNodeIds)
            ? job.payload.selectedNodeIds.filter((value): value is string => typeof value === "string").slice(0, 12)
            : [];
          const primaryNodeId = typeof job.payload.primaryNodeId === "string"
            && selectedNodeIds.includes(job.payload.primaryNodeId)
            ? job.payload.primaryNodeId
            : undefined;
          const coordination = parseCodingConversationCoordination(job.payload.coordination);
          if (!coordination) {
            return {
              ok: false,
              error: "coding-agent job is missing its accepted coordination decision",
              noRetry: true,
            };
          }
          const codingWorkspaceId = typeof job.payload.codingWorkspaceId === "string"
            && job.payload.codingWorkspaceId.trim()
            ? job.payload.codingWorkspaceId.trim()
            : undefined;
          const durableConversation = codingConversationFromEvents(
            conversationEvents,
          );
          const executionAttachments = codingConversationRuntimeAttachments(durableConversation);
          const execution = await runCodingAgent({
            runId,
            objective,
            executionKind,
            signal: ctx.signal,
            roomUpdates: codingRoomUpdates,
            ...codingExecutionPlanes,
            reviewPolicy,
            ...codingWorkerExecutionRosterOptions(workerExecution),
            reviewerRuntime,
            repositoryPlacement: {
              root: workspace.repositoryRoot,
              branch: roomBranch.branchName,
              commit: roomFrontier.commit,
              worktree: executionDirectory,
            },
            roomControlIntents: {
              workspaceId: WORKSPACE_ID,
              roomId: codingRoom.roomId,
              authority: {
                pending: async ({ workspaceId, roomId, runId: targetRunId }) =>
                  spacetimeControlPlane
                    .pendingRosterRoomControlIntents(workspaceId, roomId)
                    .filter((intent) =>
                      intent.kind === "follow_up"
                      && (!intent.targetRunId || intent.targetRunId === targetRunId)
                    )
                    .map((intent) => {
                      const payload = JSON.parse(intent.payloadJson) as Record<string, unknown>;
                      const message = typeof payload.message === "object" && payload.message
                        ? payload.message as Record<string, unknown>
                        : undefined;
                      const text = typeof payload.problem === "string"
                        ? payload.problem
                        : typeof message?.text === "string"
                          ? message.text
                          : "";
                      return createCodingRoomControlIntent({
                        workspaceId,
                        roomId,
                        intentId: intent.intentId,
                        kind: "follow-up" as const,
                        text,
                        createdAtMs: Number(intent.createdAt.microsSinceUnixEpoch / 1_000n),
                        ...(typeof payload.messageId === "string"
                          ? { messageId: payload.messageId }
                          : {}),
                      });
                    })
                    .filter((intent) => intent.text.trim().length > 0),
                consume: async (intent) => {
                  await spacetimeControlPlane.consumeRosterRoomControlIntent({
                    workspaceId: intent.workspaceId,
                    roomId: intent.roomId,
                    intentId: intent.intentId,
                    runId: intent.runId,
                    consumerId: `coding_consumer_${hashCanonical({
                      boundaryTaskId: intent.boundaryTaskId,
                      expansionKey: intent.expansionKey,
                    }).slice(0, 28)}`,
                  });
                },
              },
            },
            ...(workspaceProfile?.executionProfile ? {
              repositoryExecutionProfile: workspaceProfile.executionProfile,
            } : {}),
            ...(effectiveWorkspaceNodes.length ? { workspaceNodes: effectiveWorkspaceNodes } : {}),
            ...(participantProfiles.length ? { participantProfiles } : {}),
            ...(selectedNodeIds.length ? { selectedNodeIds } : {}),
            ...(primaryNodeId ? { primaryNodeId } : {}),
            coordination,
            ...(executionAttachments.length ? { executionAttachments } : {}),
            memoryRepository: createCompositeRosterMemoryRepository([
              createCodingRosterMemoryRepository({
                memory: memoryTools,
                workspaceScopeId: `workspace:${hashCanonical(
                  codingWorkspaceId ?? path.resolve(workingDirectory),
                ).slice(0, 24)}`,
                nodePrivateMemory: {
                  workspaceId: WORKSPACE_ID,
                  nodeIds: effectiveWorkspaceNodes
                    .filter((node) => node.continuity?.mode === "workspace")
                    .map((node) => node.id),
                },
                conversationId,
                runId,
                conversationReceipts: () =>
                  codingRuntime.chain(`agents/coding-agent/runs/${conversationId}`),
                runReceipts: () => codingRuntime.chain(runStream),
              }),
              trajectoryMemory.repository,
            ]),
            onNodeTrajectory: trajectoryMemory.observe,
            ...(humanResolution ? { humanResolution } : {}),
            ...(repositorySkills.length ? { repositorySkills } : {}),
            ...(codingWorkspaceId ? { controlIngress: {
              workspaceId: codingWorkspaceId,
              conversationId,
              jobId: job.id,
              jobAttempt: job.attempt,
              claimCommands: async (consumeId) => {
                await ctx.pullCommands(["steer", "follow_up"], consumeId);
              },
              pendingMessages: async () => {
                const conversationStream = `agents/coding-agent/runs/${conversationId}`;
                const listedJobs = await queue.listJobs({ limit: 200 });
                const relatedJobs = [
                  job,
                  ...listedJobs.filter((candidate) => candidate.id !== job.id
                    && candidate.agentId === "coding-agent"
                    && candidate.payload.kind === "coding-agent.run"
                    && (candidate.payload.conversationId ?? candidate.payload.runId) === conversationId
                    && candidate.payload.codingWorkspaceId === codingWorkspaceId),
                ];
                const executionStreamByRunId = new Map<string, string>();
                for (const candidate of relatedJobs) {
                  if (typeof candidate.payload.runId !== "string") continue;
                  executionStreamByRunId.set(
                    candidate.payload.runId,
                    typeof candidate.payload.runStream === "string"
                      ? candidate.payload.runStream
                      : `agents/coding-agent/runs/${candidate.payload.runId}`,
                  );
                }
                executionStreamByRunId.set(runId, runStream);
                const streams = [...new Set([conversationStream, ...executionStreamByRunId.values()])];
                const eventsByStream = new Map(await Promise.all(streams.map(async (streamId) => [
                  streamId,
                  (await codingRuntime.chain(streamId)).map((receipt) => receipt.body),
                ] as const)));
                const conversationEvents = eventsByStream.get(conversationStream) ?? [];
                const conversation = codingConversationFromEvents(conversationEvents);
                const deliveryAttempts = codingControlDeliveryAttemptsFromEvents(
                  streams.flatMap((streamId) => eventsByStream.get(streamId) ?? []),
                );
                // Mirrored conversation receipts carry the originating run ID,
                // so execution-local completion can be resolved without
                // assuming the currently selected continuation owns the task.
                const referencedRunIds = [...new Set(
                  [...deliveryAttempts.values()].flatMap((attempts) =>
                    attempts.flatMap((delivery) => delivery.runId ? [delivery.runId] : [])),
                )].slice(0, 200);
                for (const referencedRunId of referencedRunIds) {
                  if (executionStreamByRunId.has(referencedRunId)) continue;
                  executionStreamByRunId.set(
                    referencedRunId,
                    `agents/coding-agent/runs/${referencedRunId}`,
                  );
                }
                const missingStreams = [...new Set(executionStreamByRunId.values())]
                  .filter((streamId) => !eventsByStream.has(streamId));
                await Promise.all(missingStreams.map(async (streamId) => {
                  eventsByStream.set(
                    streamId,
                    (await codingRuntime.chain(streamId)).map((receipt) => receipt.body),
                  );
                }));
                const stateByRunId = new Map([...executionStreamByRunId].map(([executionId, streamId]) => [
                  executionId,
                  (eventsByStream.get(streamId) ?? []).reduce(
                    (current, event) => reduceOrchestration(current, event, Date.now()),
                    initialOrchestrationState,
                  ),
                ]));
                const runIdByJobId = new Map(relatedJobs.flatMap((candidate) =>
                  typeof candidate.payload.runId === "string" ? [[candidate.id, candidate.payload.runId] as const] : []));
                return pendingCodingControlMessages({
                  messages: conversation.messages,
                  deliveryAttempts,
                  currentJobId: job.id,
                  currentJobAttempt: job.attempt,
                  recipientTaskCompleted: (delivery) => {
                    const deliveryRunId = delivery.runId
                      ?? (delivery.jobId ? runIdByJobId.get(delivery.jobId) : undefined);
                    return Boolean(deliveryRunId && delivery.recipientTaskId
                      && stateByRunId.get(deliveryRunId)?.taskGraph?.tasks.some((task) =>
                        task.taskId === delivery.recipientTaskId && task.status === "accepted"));
                  },
                });
              },
            } } : {}),
            nodeRuntimes: codingNodeRuntimes,
            onGraphSnapshot: async (snapshot) => {
              await codingRuntime.execute(runStream, {
                type: "emit",
                eventId: makeEventId(runStream),
                event: taskGraphProjectedEvent(runId, snapshot),
              });
            },
            workingDirectory: executionDirectory,
            ...(improvementRuntime ? { activeImprovementSnapshot: improvementRuntime.snapshot } : {}),
            onNodeLog: (entry) => codingRuntimeLogs.append(entry),
          });
          await observePinnedCodingImprovements(improvementRuntime, execution).catch((error) => {
            console.error(`Autonomous improvement observation failed for Coding run ${runId}`, error);
          });
          if (executionKind === "investigation") {
            if (execution.status !== "completed") {
              await spacetimeControlPlane.finalizeRosterExecution({
                runId,
                outcome: "failed",
                reason: execution.completion.blocked ?? "Repository investigation did not complete",
              });
              return {
                ok: false,
                error: execution.completion.blocked ?? "Repository investigation did not complete",
                noRetry: execution.status === "blocked",
              };
            }
            await ctx.assertLease();
            await spacetimeControlPlane.finalizeRosterExecution({ runId, outcome: "completed" });
            return {
              ok: true,
              result: {
                runId,
                runStream,
                runKind: "investigation",
                status: "completed",
                reviewPolicy,
                workerRuntime,
                readOnly: true,
                integratable: false,
                isolated: true,
                noChanges: true,
                branch: roomBranch.branchName,
                commit: roomFrontier.commit,
              },
            };
          }
          const gitRun = await prepareCodingAgentGitRun({ workspace, execution, runId, runStream });
          if (gitRun.status === "failed") {
            await spacetimeControlPlane.finalizeRosterExecution({
              runId,
              outcome: "failed",
              reason: gitRun.result.error,
            });
            return gitRun.result;
          }
          const prepared = gitRun.prepared;
          // Certification is necessary but not sufficient: the worker must
          // still own the exact durable lease attempt before committing the
          // reviewed delta to its durable run branch.
          await ctx.assertLease();
          const commitOutcome = await commitGitRunBranch(
            workspace,
            `Roster: ${objective}`,
            prepared,
          );
          let acceptedRoomFrontier = roomFrontier;
          if (!commitOutcome.noChanges) {
            await advanceGitRoomBranch({
              repositoryRoot: workspace.repositoryRoot,
              roomId,
              expectedCommit: roomFrontier.commit,
              certifiedCommit: commitOutcome.commit,
            });
            acceptedRoomFrontier = createCodingRoomGitFrontier({
              conversationId,
              roomId,
              branch: roomBranch.branchName,
              commit: commitOutcome.commit,
              epoch: roomFrontier.epoch + 1,
              previousCommit: roomFrontier.commit,
              executionRunId: runId,
              ...(roomFrontier.targetBranch ? {
                targetBranch: roomFrontier.targetBranch,
                targetCommit: roomFrontier.targetCommit,
              } : {}),
            });
            await codingRuntime.execute(conversationStream, {
              type: "emit",
              eventId: `coding-room-frontier:${acceptedRoomFrontier.frontierId}`,
              event: codingRoomGitFrontierEvent(acceptedRoomFrontier),
            });
          }
          await spacetimeControlPlane.finalizeRosterExecution({
            runId,
            outcome: "completed",
          });
          await admitAcceptedCodingImprovement(execution, codingExecutionPlanes.dataReferences).catch((error) => {
            console.error(`Autonomous improvement admission failed for Coding run ${runId}`, error);
          });
          return {
            ok: true,
            result: {
              runId,
              runStream,
              status: "completed",
              reviewPolicy,
              workerRuntime,
              isolated: true,
              branch: roomBranch.branchName,
              commit: acceptedRoomFrontier.commit,
              gitOutcome: commitOutcome.outcome,
              noChanges: commitOutcome.noChanges,
              ...(roomFrontier.targetBranch ? {
                baselineBranch: roomFrontier.targetBranch,
                baselineCommit: roomFrontier.targetCommit,
              } : {}),
              sourceCheckoutDirty: workspace.sourceCheckoutDirty,
            },
          };
        } catch (error) {
          await captureGitRunPatch(workspace).catch(() => undefined);
          throw error;
        } finally {
          await disposeGitRunWorkspace(workspace, { keepBranch: false });
        }
      } finally {
        await codingExecutionPlanes.dispose();
      }
    },
    theorem: createWorkerHandler({
      defaultStream: "agents/theorem", defaultAgentId: "theorem", kind: "theorem.run",
      defaultSubConfig: { rounds: 1, maxDepth: 1, memoryWindow: 40, branchThreshold: 2 },
      runtime: theoremRuntime, runStreamFn: theoremRunStream, runner: theoremRunner,
    }),
    "axiom-roster": createWorkerHandler({
      defaultStream: "agents/axiom-roster", defaultAgentId: "axiom-roster", kind: "axiom-roster.run",
      defaultSubConfig: { rounds: 2, maxDepth: 2, memoryWindow: 60, branchThreshold: 2 },
      runtime: theoremRuntime, runStreamFn: theoremRunStream, runner: axiomRosterRunner,
    }),
    "axiom-simple": createWorkerHandler({
      defaultStream: "agents/axiom-simple", defaultAgentId: "axiom-simple", kind: "axiom-simple.run",
      defaultSubConfig: { workerCount: 3, repairMode: "auto" },
      runtime: axiomSimpleRuntime, runStreamFn: axiomSimpleRunStream, runner: axiomSimpleRunner,
    }),
    writer: createWorkerHandler({
      defaultStream: "agents/writer", defaultAgentId: "writer", kind: "writer.run",
      defaultSubConfig: { maxParallel: 1 },
      runtime: writerRuntime, runStreamFn: writerRunStream, runner: writerRunner,
      mergeEventExtras: { stepId: "delegate_task" },
    }),
    agent: createWorkerHandler({
      defaultStream: "agents/agent", defaultAgentId: "agent", kind: "agent.run",
      defaultSubConfig: { maxIterations: 3, maxToolOutputChars: 2500, memoryScope: "agent", workspace: "." },
      runtime: agentRuntime, runStreamFn: agentRunStream, runner: agentRunner,
    }),
    axiom: createWorkerHandler({
      defaultStream: "agents/axiom", defaultAgentId: "axiom", kind: "axiom.run",
      defaultSubConfig: {
        maxIterations: 12,
        maxToolOutputChars: 6000,
        memoryScope: "axiom",
        workspace: ".",
        leanEnvironment: process.env.AXIOM_LEAN_ENVIRONMENT ?? "lean-4.28.0",
        leanTimeoutSeconds: 120,
        autoRepair: true,
      },
      runtime: agentRuntime, runStreamFn: agentRunStream, runner: axiomRunner,
    }),
    inspector: async (job, ctx) => {
      await ctx.pullCommands(["steer", "follow_up"]);
      await inspectorRunner(job.payload);
      const sourceStream = extractInspectorSourceName(job.payload);
      return {
        ok: true,
        result: {
          runId: job.payload.runId as string | undefined,
          stream: sourceStream ? inspectorAnalysisStream(sourceStream) : undefined,
        },
      };
    },
  }),
});
worker.start();

// ============================================================================
// Heartbeat
// ============================================================================

const parseHeartbeatSpecs = (): ReadonlyArray<HeartbeatSpec> => {
  const specs: HeartbeatSpec[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^HEARTBEAT_(\w+)_INTERVAL_MS$/);
    if (!match || !value) continue;
    const agentId = match[1].toLowerCase();
    const intervalMs = Number(value);
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) continue;
    specs.push({
      id: `heartbeat:${agentId}`,
      agentId,
      intervalMs,
      payload: { kind: `${agentId}.heartbeat` },
    });
  }
  return specs;
};

const heartbeats = (SERVER_SURFACE === "repository" ? [] : parseHeartbeatSpecs()).map((spec) =>
  createHeartbeat(spec, {
    enqueue: async (opts) => {
      const created = await queue.enqueue({
        agentId: opts.agentId,
        payload: opts.payload,
        lane: "collect",
        singletonMode: "cancel",
        sessionKey: `heartbeat:${opts.agentId}`,
        maxAttempts: 1,
      });
      return { id: created.id };
    },
  })
);
for (const hb of heartbeats) hb.start();

const app = new Hono();
let shuttingDown = false;

app.use("*", createRosterHttpAccess());

app.use("*", async (c, next) => {
  if (!serverSurfaceAllowsPath(SERVER_SURFACE, c.req.path)) {
    return text(404, "Not found");
  }
  if (shuttingDown && !serverDrainAllowsRequest(c.req.method)) {
    c.header("Retry-After", "5");
    return text(503, "Roster is draining active jobs. Retry this change after the server restarts.");
  }
  await next();
});

app.onError((err) => {
  if (err instanceof BadJsonError) return text(400, err.message);
  console.error(err);
  return text(500, "Server error");
});

app.get("/healthz", (c) => c.json({
  ok: true,
  service: "roster",
  state: shuttingDown ? "draining" : "running",
  uptimeSeconds: Math.floor(process.uptime()),
}));

app.get("/readyz", (c) => {
  const provider = process.env.OPENAI_API_KEY
    ? modelProviderHealth.snapshot(OPENAI_PROVIDER_ID)
    : undefined;
  return c.json({
    ok: !shuttingDown,
    service: "roster",
    state: shuttingDown ? "draining" : "ready",
    controlPlane: "connected",
    workspaceId: WORKSPACE_ID,
    modelCredentials: process.env.OPENAI_API_KEY ? "configured" : "missing",
    modelProvider: provider?.state ?? "unconfigured",
    modelFailureClass: provider?.failureClass,
  }, shuttingDown ? 503 : 200);
});

app.get("/api/v2/room-os/health", (c) => c.json({
  schema: "roster.room-os-health.v1",
  apiVersion: "v2",
  ok: true,
  durableStore: "spacetime",
}, 200, {
  "Cache-Control": "no-store",
}));

app.get("/", (c) => {
  if (SERVER_SURFACE === "repository") return c.redirect("/coding", 302);
  const nonce = randomBytes(18).toString("base64");
  return html(landingPageHtml(nonce), { ...landingSecurityHeaders(nonce) });
});

app.get("/assets/canvas-client.js", async () => {
  const asset = resolvePackageResource("public", "assets", "canvas-client.js");
  try {
    const body = await fs.promises.readFile(asset);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return text(404, "Canvas client bundle is not built");
  }
});

app.get("/assets/roster-client.js", async () => {
  const asset = resolvePackageResource("public", "assets", "roster-client.js");
  try {
    const body = await fs.promises.readFile(asset);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return text(404, "Roster client bundle is not built");
  }
});

app.get("/assets/roster-shell.js", async () => {
  const asset = resolvePackageResource("public", "assets", "roster-shell.js");
  try {
    const body = await fs.promises.readFile(asset);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return text(404, "Roster shell bundle is not built");
  }
});

app.get("/assets/coding-client.js", async () => {
  const asset = resolvePackageResource("public", "assets", "coding-client.js");
  try {
    const body = await fs.promises.readFile(asset);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return text(404, "Coding client bundle is not built");
  }
});

app.get("/assets/coding-enhancements.js", async () => {
  const asset = resolvePackageResource("public", "assets", "coding-enhancements.js");
  try {
    const body = await fs.promises.readFile(asset);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return text(404, "Coding enhancements bundle is not built");
  }
});

app.get("/assets/coding-mermaid-renderer.js", async () => {
  const asset = resolvePackageResource("public", "assets", "coding-mermaid-renderer.js");
  try {
    const body = await fs.promises.readFile(asset);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return text(404, "Coding Mermaid renderer bundle is not built");
  }
});

const routes = await loadAgentRoutes({
  llmText,
  llmStructured,
  enqueueJob,
  queue,
  runHeadlessAgent: (input) => runHeadlessAgent({
    ...input,
    store: spacetimeStore<HeadlessAgentEvent>(eventRepository),
    branchStore,
  }),
  runtimes: {
    theorem: theoremRuntime,
    "axiom-simple": axiomSimpleRuntime,
    writer: writerRuntime,
    agent: agentRuntime,
    axiom: agentRuntime,
    "coding-agent": codingRuntime,
    "coding-room-directory": eventRepository,
    "coding-node-runtimes": codingNodeRuntimes,
    inspector: inspectorRuntime,
    selfImprovement: selfImprovementRuntime,
    memory: memoryRuntime,
  },
  prompts: {
    theorem: THEOREM_PROMPTS,
    writer: WRITER_PROMPTS,
    inspector: INSPECTOR_PROMPTS,
    agent: AGENT_PROMPTS,
    axiom: AXIOM_PROMPTS,
  },
  promptHashes: {
    theorem: THEOREM_PROMPTS_HASH,
    writer: WRITER_PROMPTS_HASH,
    inspector: INSPECTOR_PROMPTS_HASH,
    agent: AGENT_PROMPTS_HASH,
    axiom: AXIOM_PROMPTS_HASH,
  },
  promptPaths: {
    theorem: THEOREM_PROMPTS_PATH,
    writer: WRITER_PROMPTS_PATH,
    inspector: INSPECTOR_PROMPTS_PATH,
    agent: AGENT_PROMPTS_PATH,
    axiom: AXIOM_PROMPTS_PATH,
  },
  models: {
    coding: OPENAI_MODEL,
    theorem: THEOREM_MODEL,
    writer: WRITER_MODEL,
    inspector: INSPECTOR_MODEL,
    agent: AGENT_MODEL,
    axiom: AXIOM_MODEL,
    canvas: CANVAS_MODEL,
  },
  helpers: {
    memoryTools,
    delegationTools,
    modelProviderHealth,
    spacetimeControlPlane,
    spacetimeWebAccess,
    codingRoomControl,
    codingAcceptedOutputs,
    codingActiveImprovementSnapshot: () => createCodingImprovementRuntimePin(
      selfImprovementFramework.snapshot(),
      selfImprovementFramework.runtimeGenerationId(),
    ),
    improvementAudit: async () => {
      const state = await proposalState();
      const runtime = selfImprovementFramework.snapshot();
      return {
        generationId: selfImprovementFramework.runtimeGenerationId(),
        activeCount: runtime.improvements.length,
        proposals: Object.values(state.proposals)
          .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
          .slice(0, 20)
          .map((proposal) => ({
            id: proposal.id,
            status: proposal.status,
            artifactType: proposal.artifact.artifactType,
            target: proposal.artifact.target,
            source: proposal.source.kind === "coding-certified-output"
              ? `Coding run ${proposal.source.runId} · node ${proposal.source.nodeId}`
              : `Operator ${proposal.source.actorId}`,
            transitionCount: proposal.rolloutHistory.length,
            observationCount: proposal.observations.length,
            updatedAt: proposal.updatedAt,
          })),
      };
    },
    codingRealtime,
    codingRealtimeSession,
    codingNodeContinuity,
    workspaceId: WORKSPACE_ID,
  },
}, {
  moduleNames: serverSurfaceAgentModuleNames(SERVER_SURFACE),
});

routes.forEach((route) => route.register(app));

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

class BadJsonError extends Error {
  constructor(msg: string) { super(msg); }
}

const readJsonBody = async (req: Request): Promise<Record<string, unknown>> => {
  const rawText = await req.text();
  if (!rawText.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); } catch {
    throw new BadJsonError("Malformed JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadJsonError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

const extractInspectorSourceName = (payload: Record<string, unknown>): string => {
  const source = payload.source;
  if (!source || typeof source !== "object") return "";
  const name = (source as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
};

const ensureInspectorStreamExists = async (rawSourceName: string): Promise<string> => {
  const sourceName = rawSourceName.trim();
  if (!sourceName) throw new Error("inspector source stream required");
  if (sourceName.length > 500 || /[\u0000-\u001f\u007f]/.test(sourceName)) {
    throw new Error("inspector source stream is invalid");
  }
  if (!eventRepository.streamMetadata(sourceName)) throw new Error("inspector source stream not found");
  return sourceName;
};

app.post("/agents/:id/jobs", async (c) => {
  const agentId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  let payload = (typeof body.payload === "object" && body.payload)
    ? body.payload as Record<string, unknown>
    : body;
  const lane = body.lane === "steer" || body.lane === "follow_up" || body.lane === "collect"
    ? body.lane
    : "collect";
  const jobId = typeof body.jobId === "string" ? body.jobId : undefined;
  const maxAttempts = typeof body.maxAttempts === "number" && Number.isFinite(body.maxAttempts)
    ? Math.max(1, Math.min(Math.floor(body.maxAttempts), 8))
    : 2;
  const singleton = (typeof body.singleton === "object" && body.singleton)
    ? body.singleton as Record<string, unknown>
    : undefined;
  const sessionKey = typeof body.sessionKey === "string"
    ? body.sessionKey
    : (typeof singleton?.key === "string" ? singleton.key : undefined);
  const singletonMode = body.singletonMode === "allow" || body.singletonMode === "cancel" || body.singletonMode === "steer" || body.singletonMode === "reject"
    ? body.singletonMode
    : (singleton?.mode === "allow" || singleton?.mode === "cancel" || singleton?.mode === "steer" || singleton?.mode === "reject"
      ? singleton.mode
      : "allow");

  const payloadKind = typeof payload.kind === "string" ? payload.kind : "";
  const isInspector = agentId === "inspector" || payloadKind === "inspector.run";
  if (isInspector) {
    const sourceName = extractInspectorSourceName(payload);
    if (!sourceName) return text(400, "inspector source stream required");
    let safeSourceName: string;
    try {
      safeSourceName = await ensureInspectorStreamExists(sourceName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) return text(404, "inspector source stream not found");
      return text(400, message);
    }
    payload = {
      ...payload,
      stream: inspectorAnalysisStream(safeSourceName),
      source: { kind: "stream", name: safeSourceName },
    };
  }

  const job = await queue.enqueue({
    jobId,
    agentId,
    lane,
    sessionKey,
    singletonMode,
    payload,
    maxAttempts,
  });
  return jsonResponse(202, { ok: true, job });
});

app.post("/jobs/:id/steer", async (c) => {
  const jobId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const payload = (typeof body.payload === "object" && body.payload)
    ? body.payload as Record<string, unknown>
    : body;
  const queued = await queue.queueCommand({
    jobId,
    command: "steer",
    payload,
    by: typeof body.by === "string" ? body.by : undefined,
  });
  if (!queued) return text(404, "job not found");
  return jsonResponse(202, { ok: true, command: queued });
});

app.post("/jobs/:id/follow-up", async (c) => {
  const jobId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const payload = (typeof body.payload === "object" && body.payload)
    ? body.payload as Record<string, unknown>
    : body;
  const queued = await queue.queueCommand({
    jobId,
    command: "follow_up",
    payload,
    by: typeof body.by === "string" ? body.by : undefined,
  });
  if (!queued) return text(404, "job not found");
  return jsonResponse(202, { ok: true, command: queued });
});

app.post("/jobs/:id/abort", async (c) => {
  const jobId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const reason = typeof body.reason === "string" ? body.reason : "abort requested";
  const queued = await queue.queueCommand({
    jobId,
    command: "abort",
    payload: { reason },
    by: typeof body.by === "string" ? body.by : undefined,
  });
  if (!queued) return text(404, "job not found");
  return jsonResponse(202, { ok: true, command: queued });
});

app.get("/jobs/:id", async (c) => {
  const job = await queue.getJob(c.req.param("id"));
  if (!job) return text(404, "job not found");
  return jsonResponse(200, job);
});

app.get("/jobs/:id/wait", async (c) => {
  const timeoutMsRaw = Number(c.req.query("timeoutMs") ?? 15_000);
  const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(0, Math.min(timeoutMsRaw, 120_000)) : 15_000;
  const job = await queue.waitForJob(c.req.param("id"), timeoutMs, 200);
  if (!job) return text(404, "job not found");
  return jsonResponse(200, job);
});

app.get("/jobs", async (c) => {
  const status = c.req.query("status");
  const parsed = status === "queued"
    || status === "leased"
    || status === "running"
    || status === "completed"
    || status === "failed"
    || status === "canceled"
    ? status
    : undefined;
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 50;
  const jobs = await queue.listJobs({ status: parsed, limit });
  return jsonResponse(200, { jobs });
});

app.post("/memory/:scope/read", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const entries = await memoryTools.read({ scope, limit });
  return jsonResponse(200, { entries });
});

app.get("/memory/scopes", async () =>
  jsonResponse(200, { scopes: await memoryTools.scopes() }));

app.post("/memory/:scope/search", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const query = typeof body.query === "string" ? body.query : "";
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const entries = await memoryTools.search({ scope, query, limit });
  return jsonResponse(200, { entries });
});

app.post("/memory/:scope/open", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 200)
    : [];
  if (ids.length === 0) return text(400, "ids required");
  const entries = await memoryTools.open({ scope, ids });
  return jsonResponse(200, { entries });
});

app.post("/memory/:scope/summarize", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const query = typeof body.query === "string" ? body.query : undefined;
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const maxChars = typeof body.maxChars === "number" ? body.maxChars : undefined;
  const result = await memoryTools.summarize({ scope, query, limit, maxChars });
  return jsonResponse(200, result);
});

app.post("/memory/:scope/commit", async (c) => {
  if (c.req.header("X-Roster-Memory-Authority") !== "commit") {
    return text(403, "trusted memory commit authority required");
  }
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const textValue = typeof body.text === "string" ? body.text : "";
  if (!textValue.trim()) return text(400, "text required");
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  const entry = await memoryTools.commit({
    scope,
    text: textValue,
    tags,
    meta: typeof body.meta === "object" && body.meta ? body.meta as Record<string, unknown> : undefined,
  });
  return jsonResponse(201, { entry });
});

app.post("/memory/:scope/proposals", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const textValue = typeof body.text === "string" ? body.text : "";
  const proposedBy = typeof body.proposedBy === "string" ? body.proposedBy : "";
  if (!textValue.trim()) return text(400, "text required");
  if (!proposedBy.trim()) return text(400, "proposedBy required");
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  const sourceReferences = Array.isArray(body.sourceReferences)
    ? body.sourceReferences.flatMap((reference) => {
        if (!reference || typeof reference !== "object" || Array.isArray(reference)) return [];
        const value = reference as Record<string, unknown>;
        if (typeof value.sourceId !== "string" || typeof value.contentHash !== "string") return [];
        return [{
          sourceId: value.sourceId,
          contentHash: value.contentHash,
          ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
        }];
      })
    : undefined;
  const proposal = await memoryTools.propose({
    scope,
    text: textValue,
    proposedBy,
    ...(tags?.length ? { tags } : {}),
    ...(typeof body.meta === "object" && body.meta && !Array.isArray(body.meta)
      ? { meta: body.meta as Record<string, unknown> }
      : {}),
    ...(sourceReferences?.length ? { sourceReferences } : {}),
  });
  return jsonResponse(202, { proposal });
});

app.get("/memory/:scope/proposals", async (c) => {
  const status = c.req.query("status");
  const parsedStatus = status === "pending" || status === "accepted" || status === "rejected"
    ? status
    : undefined;
  const limitValue = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(Math.floor(limitValue), 500)) : 50;
  const proposals = await memoryTools.proposals({
    scope: c.req.param("scope"),
    ...(parsedStatus ? { status: parsedStatus } : {}),
    limit,
  });
  return jsonResponse(200, { proposals });
});

app.post("/memory/:scope/proposals/:proposalId/accept", async (c) => {
  if (c.req.header("X-Roster-Memory-Authority") !== "decide") {
    return text(403, "memory decision authority required");
  }
  const body = await readJsonBody(c.req.raw);
  const decidedBy = typeof body.decidedBy === "string" ? body.decidedBy : "";
  if (!decidedBy.trim()) return text(400, "decidedBy required");
  const entry = await memoryTools.accept({
    scope: c.req.param("scope"),
    proposalId: c.req.param("proposalId"),
    decidedBy,
  });
  return jsonResponse(200, { entry });
});

app.post("/memory/:scope/proposals/:proposalId/reject", async (c) => {
  if (c.req.header("X-Roster-Memory-Authority") !== "decide") {
    return text(403, "memory decision authority required");
  }
  const body = await readJsonBody(c.req.raw);
  const decidedBy = typeof body.decidedBy === "string" ? body.decidedBy : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!decidedBy.trim()) return text(400, "decidedBy required");
  if (!reason.trim()) return text(400, "reason required");
  const proposal = await memoryTools.reject({
    scope: c.req.param("scope"),
    proposalId: c.req.param("proposalId"),
    decidedBy,
    reason,
  });
  return jsonResponse(200, { proposal });
});

app.post("/memory/:scope/diff", async (c) => {
  const scope = c.req.param("scope");
  const body = await readJsonBody(c.req.raw);
  const fromTs = typeof body.fromTs === "number" ? body.fromTs : Number.NaN;
  if (!Number.isFinite(fromTs)) return text(400, "fromTs required");
  const toTs = typeof body.toTs === "number" ? body.toTs : undefined;
  const entries = await memoryTools.diff({ scope, fromTs, toTs });
  return jsonResponse(200, { entries });
});

const improvementExpectedRecordId = (
  body: Readonly<Record<string, unknown>>,
): string | undefined => improvementActor(body, "expectedRecordId");

const improvementActor = (
  body: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const improvementAuthorization = (
  actorId: string,
  body: Readonly<Record<string, unknown>>,
): string | undefined => {
  const supplied = improvementActor(body, "authorizationToken");
  const expected = improvementAuthorityTokens.get(actorId);
  if (!supplied || !expected) return undefined;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    return undefined;
  }
  return hashCanonical({ actorId, token: supplied });
};

const createImprovementProposal = async (input: {
  readonly body: Readonly<Record<string, unknown>>;
  readonly source: Extract<SelfImprovementEvent, { readonly type: "proposal.created" }>["source"];
  readonly patch: string;
}): Promise<{ readonly proposalId: string; readonly recordId: string }> => {
  const { body } = input;
  const artifactType = body.artifactType === "prompt_patch"
    || body.artifactType === "policy_patch"
    || body.artifactType === "harness_patch"
    ? body.artifactType
    : undefined;
  if (!artifactType) throw new Error("artifactType required");
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!target) throw new Error("target required");
  const proposalId = typeof body.proposalId === "string" && body.proposalId.trim()
    ? body.proposalId.trim()
    : `proposal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const state = await proposalState();
  const event = await selfImprovementFramework.createProposalEvent({
    state,
    proposalId,
    artifactType,
    target,
    patch: input.patch,
    source: input.source,
  });
  await emitImprovement(event);
  return { proposalId, recordId: event.rolloutRecord.recordId };
};

app.post("/improvement/proposals", async (c) => {
  const body = await readJsonBody(c.req.raw);
  const patch = typeof body.patch === "string" ? body.patch : "";
  if (!patch.trim()) return text(400, "patch required");
  const actorId = improvementActor(body, "createdBy");
  if (!actorId) return text(400, "createdBy required");
  try {
    const created = await createImprovementProposal({
      body,
      patch,
      source: { kind: "operator", actorId },
    });
    return jsonResponse(201, { ok: true, ...created });
  } catch (error) {
    return text(400, error instanceof Error ? error.message : String(error));
  }
});

app.post("/improvement/:id/validate", async (c) => {
  const proposalId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const validatorId = improvementActor(body, "validatedBy");
  const expectedRecordId = improvementExpectedRecordId(body);
  const authorizationHash = validatorId ? improvementAuthorization(validatorId, body) : undefined;
  if (!validatorId) return text(400, "validatedBy required");
  if (!expectedRecordId) return text(400, "expectedRecordId required");
  if (!authorizationHash) return text(403, "validator authority denied");
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  if (proposal.rolloutHistory.at(-1)?.recordId !== expectedRecordId) {
    return text(409, `improvement rollout head changed; current expectedRecordId is ${proposal.rolloutHistory.at(-1)?.recordId ?? "<none>"}`);
  }
  if (proposal.status !== "proposed") return text(409, "proposal is not awaiting verification");
  if (validatorId === proposal.source.actorId) return text(409, "proposal author cannot verify its own candidate");
  const artifact = await selfImprovementFramework.artifact(proposal);
  const harness = await evaluateImprovementProposal({
    artifactType: artifact.artifactType,
    target: artifact.target,
    patch: canonicalize(artifact.patch),
    repositoryRoot: process.cwd(),
    prepareDependencies: prepareImprovementDependencies,
  });
  const event = selfImprovementFramework.verificationEvent({
    proposal,
    expectedRecordId,
    validatorId,
    authorizationHash,
    status: harness.status,
    report: harness.report,
    evidenceHash: harness.evidenceHash,
  });
  try {
    await emitImprovementTransition(event, expectedRecordId);
  } catch (error) {
    if (error instanceof ImprovementTransitionConflictError) return text(409, error.message);
    throw error;
  }
  return jsonResponse(200, {
    ok: harness.status === "passed",
    proposalId,
    status: harness.status,
    report: harness.report,
    checks: harness.checks,
    evidenceHash: harness.evidenceHash,
    recordId: event.rolloutRecord.recordId,
    requestedBy: validatorId,
  });
});

app.post("/improvement/:id/approve", async (c) => {
  const proposalId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const canaryBy = improvementActor(body, "canaryBy");
  const expectedRecordId = improvementExpectedRecordId(body);
  const authorizationHash = canaryBy ? improvementAuthorization(canaryBy, body) : undefined;
  if (!canaryBy) return text(400, "canaryBy required");
  if (!expectedRecordId) return text(400, "expectedRecordId required");
  if (!authorizationHash) return text(403, "canary authority denied");
  const state = await proposalState();
  let proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  if (proposal.rolloutHistory.at(-1)?.recordId !== expectedRecordId) {
    return text(409, `improvement rollout head changed; current expectedRecordId is ${proposal.rolloutHistory.at(-1)?.recordId ?? "<none>"}`);
  }
  if (proposal.status !== "verified" || proposal.validation?.status !== "passed") {
    return text(409, "proposal must be independently verified before canary");
  }
  if (canaryBy === proposal.source.actorId || canaryBy === proposal.validation.validatedBy) {
    return text(409, "canary requires authority independent from author and verifier");
  }
  const warmingEvent = await selfImprovementFramework.warmingEvent(proposal, expectedRecordId);
  try {
    await emitImprovementTransition(warmingEvent, expectedRecordId);
  } catch (error) {
    if (error instanceof ImprovementTransitionConflictError) return text(409, error.message);
    throw error;
  }
  proposal = (await proposalState()).proposals[proposalId]!;
  const artifact = await selfImprovementFramework.artifact(proposal);
  const harness = await evaluateImprovementProposal({
    artifactType: artifact.artifactType,
    target: artifact.target,
    patch: canonicalize(artifact.patch),
    repositoryRoot: process.cwd(),
    prepareDependencies: prepareImprovementDependencies,
  });
  const canary = {
    canaryId: `canary_${harness.evidenceHash.slice(0, 28)}`,
    outcomeHash: harness.evidenceHash,
    verdict: harness.status,
    tasks: 1,
    tokens: 0,
    costMicros: 0,
    wallTimeMs: harness.wallTimeMs,
  } as const;
  const warmingRecordId = warmingEvent.rolloutRecord.recordId;
  const canaryEvent = selfImprovementFramework.canaryEvent({
    proposal,
    expectedRecordId: warmingRecordId,
    canaryBy,
    authorizationHash,
    evidence: [canary],
  });
  try {
    await emitImprovementTransition(canaryEvent, warmingRecordId);
  } catch (error) {
    if (error instanceof ImprovementTransitionConflictError) return text(409, error.message);
    throw error;
  }
  return jsonResponse(harness.status === "passed" ? 200 : 409, {
    ok: harness.status === "passed",
    proposalId,
    status: "canary",
    recordId: canaryEvent.rolloutRecord.recordId,
    canaryBy,
    evidence: canary,
  });
});

app.post("/improvement/:id/apply", async (c) => {
  const proposalId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const promoterId = improvementActor(body, "appliedBy");
  const expectedRecordId = improvementExpectedRecordId(body);
  const authorizationHash = promoterId ? improvementAuthorization(promoterId, body) : undefined;
  if (!promoterId) return text(400, "appliedBy required");
  if (!expectedRecordId) return text(400, "expectedRecordId required");
  if (!authorizationHash) return text(403, "promotion authority denied");
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  if (proposal.rolloutHistory.at(-1)?.recordId !== expectedRecordId) {
    return text(409, `improvement rollout head changed; current expectedRecordId is ${proposal.rolloutHistory.at(-1)?.recordId ?? "<none>"}`);
  }
  if (proposal.status !== "canary") return text(409, "proposal must pass canary before promotion");
  const rollout = projectRuntimeExtensionRollout(proposal.rolloutHistory);
  if (
    promoterId === proposal.source.actorId
    || promoterId === proposal.validation?.validatedBy
    || promoterId === rollout.canaryAuthority?.authorityId
  ) {
    return text(409, "promotion requires authority independent from author, verifier, and canary");
  }
  try {
    assertImprovementTargetBaseline(state, proposal);
  } catch (error) {
    return text(409, error instanceof Error ? error.message : String(error));
  }
  const event = await selfImprovementFramework.promotionEvent({
    state,
    proposal,
    expectedRecordId,
    promoterId,
    authorizationHash,
    evidenceHash: hashCanonical({ proposalId, promoterId, authorizationHash, action: "promote" }),
  });
  try {
    await emitImprovementTransition(event, expectedRecordId, assertImprovementTargetBaseline);
  } catch (error) {
    if (error instanceof ImprovementTransitionConflictError) return text(409, error.message);
    throw error;
  }
  const active = await selfImprovementFramework.reconcile(await proposalState());
  return jsonResponse(200, {
    ok: true,
    proposalId,
    status: "promoted",
    recordId: event.rolloutRecord.recordId,
    generationId: selfImprovementFramework.runtimeGenerationId(),
    snapshotHash: active.snapshotHash,
  });
});

app.post("/improvement/:id/revert", async (c) => {
  const proposalId = c.req.param("id");
  const body = await readJsonBody(c.req.raw);
  const authorityId = improvementActor(body, "revertedBy");
  const expectedRecordId = improvementExpectedRecordId(body);
  const authorizationHash = authorityId ? improvementAuthorization(authorityId, body) : undefined;
  const reason = improvementActor(body, "reason");
  if (!authorityId) return text(400, "revertedBy required");
  if (!expectedRecordId) return text(400, "expectedRecordId required");
  if (!authorizationHash) return text(403, "rollback authority denied");
  if (!reason) return text(400, "reason required");
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  if (proposal.rolloutHistory.at(-1)?.recordId !== expectedRecordId) {
    return text(409, `improvement rollout head changed; current expectedRecordId is ${proposal.rolloutHistory.at(-1)?.recordId ?? "<none>"}`);
  }
  if (proposal.status !== "promoted") return text(409, "proposal must be promoted before rollback");
  const rollout = projectRuntimeExtensionRollout(proposal.rolloutHistory);
  if (
    authorityId === proposal.source.actorId
    || authorityId === rollout.verifier?.authorityId
    || authorityId === rollout.canaryAuthority?.authorityId
    || authorityId === rollout.promotionAuthority?.authorityId
  ) return text(409, "rollback-forward requires authority independent from every prior rollout gate");
  const event = await selfImprovementFramework.rollbackEvent({
    state,
    proposal,
    expectedRecordId,
    authorityId,
    authorizationHash,
    reason,
    evidenceHash: hashCanonical({ proposalId, authorityId, authorizationHash, reason }),
  });
  try {
    await emitImprovementTransition(event, expectedRecordId);
  } catch (error) {
    if (error instanceof ImprovementTransitionConflictError) return text(409, error.message);
    throw error;
  }
  const active = await selfImprovementFramework.reconcile(await proposalState());
  return jsonResponse(200, {
    ok: true,
    proposalId,
    status: "rollback-forward",
    recordId: event.rolloutRecord.recordId,
    generationId: selfImprovementFramework.runtimeGenerationId(),
    snapshotHash: active.snapshotHash,
  });
});

app.get("/improvement/runtime", async () => {
  const snapshot = selfImprovementFramework.snapshot();
  return jsonResponse(200, {
    ...snapshot,
    generationId: selfImprovementFramework.runtimeGenerationId(),
  });
});

app.get("/improvement/:id", async (c) => {
  const proposalId = c.req.param("id");
  const state = await proposalState();
  const proposal = state.proposals[proposalId];
  if (!proposal) return text(404, "proposal not found");
  return jsonResponse(200, proposal);
});

app.get("/improvement", async () => {
  const state = await proposalState();
  const proposals = Object.values(state.proposals).sort((a, b) => b.updatedAt - a.updatedAt);
  return jsonResponse(200, { proposals });
});


app.notFound(() => text(404, "Not found"));

const httpServer = serve({ fetch: app.fetch, port: PORT, hostname: HTTP_CONFIGURATION.hostname }, () => {
  console.log(`Roster server listening on http://localhost:${PORT}`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Roster server received ${signal}; serving status and process logs while active job leases drain`);
  void drainServer({
    stopWorker: () => worker.stop(),
    stopHeartbeats: () => {
      for (const heartbeat of heartbeats) heartbeat.stop();
    },
    drainWorker: () => worker.drain(),
    closeHttp: () => new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    closeResources: async () => {
      await selfImprovementFramework.close();
      codingContinuityControl.close();
      queue.close();
      eventRepository.close();
      spacetimeControlPlane.disconnect();
    },
    onError: (phase, error) => console.error(`Roster server ${phase} drain failed`, error),
  });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
