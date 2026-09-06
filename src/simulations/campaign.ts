import {
  RecordingEntropySource,
  ReplayingEntropySource,
  type EntropySource,
} from "determined";

import { hashCanonical } from "../core/canonical.js";
import { InMemoryDataReferenceStore } from "../engine/dataflow/data-reference-store.js";
import { materializeNodeDemand, reflectOnOrchestration, type NodeDemand } from "../engine/orchestration/adaptive.js";
import {
  InMemoryTaskGraphControl,
  taskGraphTask,
  type TaskGraphControlSnapshot,
} from "../engine/orchestration/task-graph-control.js";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
} from "../engine/orchestration/task-graph.js";
import {
  balancedCompositionTree,
  compositionBracket,
  compositionLeaves,
  contractCompositionLeaf,
  leftCombCompositionTree,
  parseCompositionBracket,
  topologyPairKey,
  type CompositionTree,
} from "../engine/orchestration/topology.js";
import type { DomainPack, WorkspaceNode } from "../engine/orchestration/types.js";
import {
  ROSTER_EXPAND_FUNCTION_ID,
  ROSTER_NODE_TASK_HANDLER,
  createRosterRootTask,
  defineRosterPlatform,
} from "../engine/platform/roster-platform.js";
import type {
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../engine/platform/protocol.js";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  type NodeRuntimeAdapter,
} from "../engine/runtime/node-runtime.js";
import {
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
} from "../engine/runtime/node-function-plane.js";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
} from "../engine/workspace/shared-workspace.js";
import {
  initialOrchestrationState,
  functionActivityRecordedEvent,
  orchestrationConfiguredEvent,
  reduceOrchestration,
  reflectionRecordedEvent,
  taskGraphProjectedEvent,
  topologySelectedEvent,
  type OrchestrationEvent,
  type OrchestrationState,
} from "../modules/orchestration.js";
import { createDeterminedTaskRuntime } from "./determined-task-runtime.js";
import { VirtualClock } from "../core/clock.js";
import {
  runRuntimeLifecycleSimulation,
  type RuntimeLifecycleSimulationReport,
} from "./runtime-lifecycle.js";
import {
  runCodingCollaborationSimulation,
  type CodingCollaborationSimulationDetails,
} from "./coding-collaboration.js";
import {
  runCodingTerminalProjectionSimulation,
  type CodingTerminalProjectionSimulationReport,
} from "./coding-terminal-projection.js";

export type CoordinationPattern = "collaboration" | "adaptive" | "fanout" | "hierarchy" | "pipeline";

export type CoordinationPatternDefinition = {
  readonly id: CoordinationPattern;
  readonly label: string;
  readonly topology: string;
  readonly acceptance: string;
  readonly example: string;
  readonly href: string;
};

export const COORDINATION_PATTERNS: ReadonlyArray<CoordinationPatternDefinition> = [
  {
    id: "collaboration",
    label: "Coding Collaboration",
    topology: "Dynamic specialist DAG with conflict-scoped escalation",
    acceptance: "Ambiguity must reach the human; every accepted Git frontier is conflict-free and replay-exact",
    example: "Coding Workspace",
    href: "/coding",
  },
  {
    id: "adaptive",
    label: "Adaptive Topology",
    topology: "Demand-driven population with local Tamari rotations",
    acceptance: "Reflection closes evidence gaps before stop or retirement",
    example: "Adaptive Proof",
    href: "/theorem",
  },
  {
    id: "fanout",
    label: "Parallel Fan-out",
    topology: "One immutable frontier with independent workers",
    acceptance: "All workers complete before deterministic fan-in",
    example: "Proof Swarm",
    href: "/axiom-simple",
  },
  {
    id: "hierarchy",
    label: "Verification Hierarchy",
    topology: "Worker frontier, pod review, then one synthesis gate",
    acceptance: "Every review layer completes before certification",
    example: "Verified Proof",
    href: "/axiom",
  },
  {
    id: "pipeline",
    label: "Staged Pipeline",
    topology: "Research, structure, critique, revision, composition",
    acceptance: "Versioned stage outputs feed one final composition",
    example: "Writer Roster",
    href: "/writer",
  },
];

export type SimulationCampaignInput = {
  readonly pattern: CoordinationPattern;
  readonly agents: number;
  readonly maxParallel: number;
  readonly schedules: number;
  readonly injectFaults: boolean;
  readonly seed: number;
};

export type SimulationStageReport = {
  readonly id: string;
  readonly label: string;
  readonly tasks: number;
};

export type SimulationScheduleReport = {
  readonly seed: number;
  readonly seedHex: string;
  readonly entropyDraws: number;
  readonly converged: boolean;
  readonly replayExact: boolean;
  readonly peakParallel: number;
  readonly faultRecoveries: number;
  readonly completionDigest: string;
  readonly transitionCount: number;
  readonly transitionDigest: string;
};

export type SimulationTopologyReport = {
  readonly operation: "initialize" | "graft" | "contract" | "rotate";
  readonly leaves: number;
  readonly bracket: string;
  readonly reason: string;
};

export type SimulationReplayFrame = {
  readonly position: number;
  readonly ts: number;
  readonly kind: string;
  readonly label: string;
  readonly activeAgents: number;
  readonly totalAgents: number;
  readonly topology: string;
  readonly nodeId?: string;
  readonly taskId?: string;
  readonly planId?: string;
  readonly outputKey?: string;
  readonly needs?: ReadonlyArray<string>;
  readonly reflectionPolicyId?: string;
  readonly reflectionActions?: ReadonlyArray<string>;
  readonly evidenceGaps?: number;
  readonly acceptedTasks?: number;
  readonly failedTasks?: number;
  readonly retriedTasks?: number;
  readonly functionOperation?: string;
  readonly functionId?: string;
  readonly providerId?: string;
  readonly providerEpoch?: number;
  readonly catalogVersion?: string;
};

export type SimulationTaskReport = {
  readonly taskId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly outputKey: string;
  readonly dependencyTaskIds: ReadonlyArray<string>;
  readonly parentTaskId?: string;
  readonly status: "pending" | "ready" | "leased" | "running" | "waiting" | "accepted" | "failed" | "canceled" | "skipped";
  readonly attempt: number;
  readonly error?: string;
};

export type SimulationExpansionReport = {
  readonly parentTaskId: string;
  readonly expansionKey: string;
  readonly expansionHash: string;
  readonly childTaskIds: ReadonlyArray<string>;
  readonly continuationTaskId: string;
};

export type SimulationCampaignReport = {
  readonly campaignId: string;
  readonly input: SimulationCampaignInput;
  readonly pattern: CoordinationPatternDefinition;
  readonly durationMs: number;
  readonly stages: ReadonlyArray<SimulationStageReport>;
  readonly schedules: ReadonlyArray<SimulationScheduleReport>;
  readonly topologies: ReadonlyArray<SimulationTopologyReport>;
  readonly replayFrames: ReadonlyArray<SimulationReplayFrame>;
  readonly taskGraph?: ReadonlyArray<SimulationTaskReport>;
  readonly expansions?: ReadonlyArray<SimulationExpansionReport>;
  readonly application?: CodingCollaborationSimulationDetails;
  /** Cross-layer terminal-state and delivery fault matrix for the Coding room. */
  readonly terminalProjection?: CodingTerminalProjectionSimulationReport;
  /** Framework-level lifecycle schedule search run beside the domain campaign. */
  readonly runtimeLifecycle: RuntimeLifecycleSimulationReport;
  readonly summary: {
    readonly converged: boolean;
    readonly requestedAgents: number;
    readonly exercisedAgents: number;
    readonly exactReplays: number;
    readonly scheduleVariants: number;
    readonly faultRecoveries: number;
    readonly peakParallel: number;
    readonly receiptsPerRun: number;
    readonly finalActiveAgents: number;
    readonly entropyDraws: number;
    readonly graphExpansions: number;
    readonly catalogSearches: number;
    readonly catalogInvocations: number;
  };
};

type EventRecord = {
  readonly ts: number;
  readonly event: OrchestrationEvent;
};

type StageSpec = {
  readonly id: string;
  readonly label: string;
  readonly taskIds: ReadonlyArray<string>;
};

type SimulationTaskSpec = {
  readonly taskId: string;
  readonly stageId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly objective: string;
  readonly outputKey: string;
  readonly dependencyTaskIds: ReadonlyArray<string>;
  readonly parentTaskId?: string;
};

type ScenarioResult = {
  readonly state: OrchestrationState;
  readonly records: ReadonlyArray<EventRecord>;
  readonly completionOrder: ReadonlyArray<string>;
  readonly peakParallel: number;
  readonly faultRecoveries: number;
  readonly transitionOrder?: ReadonlyArray<{
    readonly index: number;
    readonly batch: number;
    readonly taskId: string;
    readonly phase: string;
  }>;
  readonly graphExpansions?: number;
  readonly semanticDigest?: string;
  readonly details?: CodingCollaborationSimulationDetails;
  readonly stages?: ReadonlyArray<SimulationStageReport>;
  readonly taskGraph?: ReadonlyArray<SimulationTaskReport>;
  readonly expansions?: ReadonlyArray<SimulationExpansionReport>;
};

class SeededEntropySource implements EntropySource {
  private state: number;

  constructor(seed: number) {
    const unsigned = seed >>> 0;
    const mixed = (
      Math.imul(unsigned ^ (unsigned >>> 16), 0x85ebca6b)
      + 0x9e3779b9
    ) >>> 0;
    this.state = mixed === 0 ? 0x6d2b79f5 : mixed;
  }

  random(_reason: string): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

const clampInteger = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? Math.floor(value) : minimum));

export const normalizeSimulationCampaignInput = (
  input: Partial<SimulationCampaignInput>
): SimulationCampaignInput => {
  const pattern = COORDINATION_PATTERNS.some((candidate) => candidate.id === input.pattern)
    ? input.pattern as CoordinationPattern
    : "adaptive";
  // The Coding campaign deliberately exercises independent proposal,
  // mutation, review, resolution, and certification roles. Admit enough nodes
  // to satisfy that adversarial contract instead of failing deep in a run.
  const minimumAgents = pattern === "collaboration" ? 6 : 2;
  const agents = clampInteger(input.agents ?? 12, minimumAgents, 128);
  return {
    pattern,
    agents,
    maxParallel: clampInteger(input.maxParallel ?? 6, 1, Math.min(32, agents)),
    schedules: clampInteger(input.schedules ?? 6, 1, 20),
    injectFaults: input.injectFaults ?? true,
    seed: clampInteger(input.seed ?? 0x51f15e, 0, 0xffff_ffff),
  };
};

const taskIds = (stage: string, count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_unused, index) => `${stage}_${String(index + 1).padStart(3, "0")}`);

const buildStages = (pattern: CoordinationPattern, agents: number): ReadonlyArray<StageSpec> => {
  switch (pattern) {
    case "collaboration":
      return [{ id: "collaboration", label: "Dynamic coding collaboration", taskIds: taskIds("coding", agents) }];
    case "adaptive":
      return [{ id: "frontier", label: "Adaptive frontier", taskIds: taskIds("route", agents) }];
    case "fanout":
      return [
        { id: "fanout", label: "Independent workers", taskIds: taskIds("worker", agents) },
        { id: "fanin", label: "Deterministic fan-in", taskIds: ["fanin_001"] },
      ];
    case "hierarchy":
      return [
        { id: "workers", label: "Worker frontier", taskIds: taskIds("worker", agents) },
        { id: "review", label: "Pod review", taskIds: taskIds("review", Math.max(1, Math.ceil(agents / 4))) },
        { id: "gate", label: "Verification gate", taskIds: ["gate_001"] },
      ];
    case "pipeline":
      return [
        { id: "research", label: "Research", taskIds: taskIds("research", agents) },
        { id: "structure", label: "Structure", taskIds: taskIds("structure", Math.max(1, Math.ceil(agents / 3))) },
        { id: "critique", label: "Critique", taskIds: taskIds("critique", Math.max(1, Math.ceil(agents / 2))) },
        { id: "revision", label: "Revision", taskIds: taskIds("revision", Math.max(1, Math.ceil(agents / 3))) },
        { id: "composition", label: "Composition", taskIds: ["composition_001"] },
      ];
  }
};

const buildSimulationPack = (input: SimulationCampaignInput): DomainPack => ({
  id: `simulation-${input.pattern}`,
  version: "1",
  policyVersion: "simulation-campaign-v1",
  coordinatorId: "coordinator",
  capabilities: [
    { id: "coordinate", description: "Coordinate a simulated frontier." },
    { id: "work", description: "Complete one simulated unit of work." },
  ],
  nodes: [{
    id: "coordinator",
    name: "Coordinator",
    capabilities: ["coordinate"],
    runtime: { kind: "simulation-coordinator", profile: "simulation.coordinator" },
  }],
  limits: {
    maxNodes: input.agents + 1,
    maxTasks: 10_000,
    maxParallel: input.maxParallel,
    maxDepth: 16,
  },
});

const workerDemands = (
  pattern: CoordinationPattern,
  count: number
): ReadonlyArray<NodeDemand> => Array.from({ length: count }, (_unused, index) => ({
  capability: "work",
  objective: `Complete ${pattern} frontier partition ${index + 1}.`,
  name: `Worker ${index + 1}`,
  focus: `partition-${index + 1}`,
  group: pattern === "hierarchy" ? `Pod ${Math.floor(index / 4) + 1}` : "Simulation frontier",
  metadata: { pattern, partition: index + 1 },
}));

const buildSimulationTasks = (
  pattern: CoordinationPattern,
  stages: ReadonlyArray<StageSpec>,
  workers: ReadonlyArray<WorkspaceNode>,
): ReadonlyArray<SimulationTaskSpec> => {
  if (workers.length === 0) throw new Error("Simulation graph requires at least one worker");
  const tasks: SimulationTaskSpec[] = [];
  let previousTaskIds: ReadonlyArray<string> = [];
  for (const stage of stages) {
    stage.taskIds.forEach((taskId, index) => {
      const hierarchyPodStart = pattern === "hierarchy" && stage.id === "review"
        ? index * 4
        : undefined;
      const workerIndex = hierarchyPodStart ?? (index % workers.length);
      const worker = workers[workerIndex];
      if (!worker) throw new Error(`Simulation stage ${stage.id} could not assign ${taskId}`);
      const dependencyTaskIds = hierarchyPodStart === undefined
        ? [...previousTaskIds]
        : previousTaskIds.slice(hierarchyPodStart, hierarchyPodStart + 4);
      const parentTaskId = previousTaskIds.length > 0
        ? previousTaskIds[hierarchyPodStart ?? (index % previousTaskIds.length)]
        : undefined;
      tasks.push({
        taskId,
        stageId: stage.id,
        nodeId: worker.id,
        capability: "work",
        objective: hierarchyPodStart === undefined
          ? `Complete ${stage.label.toLowerCase()} task ${index + 1}.`
          : `Review pod ${index + 1} using only its ${dependencyTaskIds.length} worker artifact${dependencyTaskIds.length === 1 ? "" : "s"}.`,
        parentTaskId,
        dependencyTaskIds,
        outputKey: `simulation.${stage.id}.${taskId}`,
      });
    });
    previousTaskIds = stage.taskIds;
  }
  return tasks;
};

const ADAPTIVE_REVIEW_OUTPUT = "simulation.adaptive.review.evidence";

const buildAdaptiveRemediationTask = (
  frontierTasks: ReadonlyArray<SimulationTaskSpec>,
  reviewer: WorkspaceNode,
): SimulationTaskSpec => ({
  taskId: "evidence_review_001",
  stageId: "evidence-remediation",
  nodeId: reviewer.id,
  capability: "work",
  objective: "Review the completed adaptive frontier and publish the missing acceptance evidence.",
  dependencyTaskIds: frontierTasks.map((task) => task.taskId),
  outputKey: ADAPTIVE_REVIEW_OUTPUT,
});

const campaignExecutionPolicy = (
  campaign: SimulationCampaignInput,
): RunExecutionPolicy => ({
  maxTasks: 10_000,
  maxDepth: 16,
  maxFanout: 512,
  maxInflight: campaign.maxParallel,
  maxReady: 10_000,
  maxBlocked: 10_000,
  maxAttempts: campaign.injectFaults ? 2 : 1,
  maxContextBytes: 16 * 1_048_576,
  maxCostMicros: 1_000_000_000,
  maxTokens: 100_000_000,
  maxWallTimeMs: 120_000,
});

const taskDefinition = (input: {
  readonly runId: string;
  readonly topologyVersion: string;
  readonly catalogVersion: string;
  readonly task: SimulationTaskSpec;
  readonly retryFaults: boolean;
}): DynamicTaskDefinition => createDynamicTaskDefinition({
  taskId: input.task.taskId,
  semanticKey: `${input.runId}:${input.task.stageId}:${input.task.taskId}`,
  nodeId: input.task.nodeId,
  capability: input.task.capability,
  objective: input.task.objective,
  handler: ROSTER_NODE_TASK_HANDLER,
  acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
  result: {
    mode: "text",
    outputKey: input.task.outputKey,
  },
  dependencies: input.task.dependencyTaskIds.map((taskId) => ({
    taskId,
    condition: "accepted",
  })),
  join: { kind: "all-success" },
  inputs: {
    inputVersions: Object.fromEntries(input.task.dependencyTaskIds.map((taskId) => [
      taskId,
      hashCanonical({ runId: input.runId, taskId }),
    ])),
    dataReferences: [],
    frontierVersion: `${input.runId}:frontier`,
    topologyVersion: input.topologyVersion,
    catalogVersion: input.catalogVersion,
  },
  runtimeBindingEpoch: 0,
  retry: {
    maxAttempts: input.retryFaults ? 2 : 1,
    initialBackoffMs: 1,
    maximumBackoffMs: 1,
  },
  timeoutMs: 30_000,
  sideEffect: "pure",
  estimatedCostMicros: 0,
  ...(input.task.parentTaskId ? { parentTaskId: input.task.parentTaskId } : {}),
});

const taskReports = (
  snapshot: TaskGraphControlSnapshot,
): ReadonlyArray<SimulationTaskReport> => snapshot.tasks.map((record) => ({
  taskId: record.definition.taskId,
  nodeId: record.definition.nodeId,
  capability: record.definition.capability,
  outputKey: record.definition.result.mode === "none"
    ? ""
    : record.definition.result.outputKey,
  dependencyTaskIds: record.definition.dependencies.map((dependency) => dependency.taskId),
  ...(record.definition.parentTaskId ? { parentTaskId: record.definition.parentTaskId } : {}),
  status: record.status,
  attempt: record.attempt,
  ...(record.error ? { error: record.error } : {}),
})).sort((left, right) => left.taskId.localeCompare(right.taskId));

const replayRecords = (records: ReadonlyArray<EventRecord>): OrchestrationState => {
  let state = initialOrchestrationState;
  for (const record of records) state = reduceOrchestration(state, record.event, record.ts);
  return state;
};

const simulationReplayLabel = (event: OrchestrationEvent): string => {
  switch (event.type) {
    case "orchestration.configured": return `Configured ${event.nodes.length} initial node${event.nodes.length === 1 ? "" : "s"}`;
    case "node.spawned": return `${event.node.name} joined the frontier`;
    case "node.retired": return `${event.nodeId} retired from the frontier`;
    case "node.runtime.bound": return `${event.binding.nodeId} rebound ${event.binding.runtime.kind} at epoch ${event.binding.epoch}`;
    case "reflection.recorded": return `Reflection ${event.iteration}: ${event.reason}`;
    case "topology.selected": return `${event.operation} topology: ${event.bracket}`;
    case "task.graph.projected": {
      const accepted = event.graph.tasks.filter((task) => task.status === "accepted").length;
      const retried = event.graph.tasks.filter((task) => task.attempt > 1).length;
      return `Task graph projected: ${accepted}/${event.graph.tasks.length} accepted, ${retried} retried`;
    }
    default: return event.type.replace(/[._:-]+/g, " ");
  }
};

const simulationReplayEvidence = (event: OrchestrationEvent): Partial<SimulationReplayFrame> => {
  switch (event.type) {
    case "node.spawned":
      return { nodeId: event.node.id };
    case "node.retired":
      return { nodeId: event.nodeId };
    case "artifact.published":
      return {
        nodeId: event.nodeId,
        ...(event.taskId ? { taskId: event.taskId } : {}),
        outputKey: event.outputKey,
      };
    case "reflection.recorded":
      return {
        reflectionPolicyId: event.policyId,
        reflectionActions: event.actions.map((action) => action.type),
        evidenceGaps: event.observation.evidenceGaps,
      };
    case "task.graph.projected":
      return {
        acceptedTasks: event.graph.tasks.filter((task) => task.status === "accepted").length,
        failedTasks: event.graph.tasks.filter((task) => task.status === "failed").length,
        retriedTasks: event.graph.tasks.filter((task) => task.attempt > 1).length,
      };
    case "function.activity.recorded":
      return {
        nodeId: event.activity.nodeId,
        taskId: event.activity.taskId,
        functionOperation: event.activity.operation,
        ...(event.activity.functionId ? { functionId: event.activity.functionId } : {}),
        ...(event.activity.providerId ? { providerId: event.activity.providerId } : {}),
        ...(event.activity.providerEpoch ? { providerEpoch: event.activity.providerEpoch } : {}),
        ...(event.activity.catalogVersion ? { catalogVersion: event.activity.catalogVersion } : {}),
      };
    default:
      return {};
  }
};

const buildSimulationReplayFrames = (records: ReadonlyArray<EventRecord>): ReadonlyArray<SimulationReplayFrame> => {
  let state = initialOrchestrationState;
  return records.map((record, index) => {
    state = reduceOrchestration(state, record.event, record.ts);
    const topology = state.topologyId ? state.topologies[state.topologyId] : undefined;
    const nodes = Object.values(state.nodes);
    return {
      position: index + 1,
      ts: record.ts,
      kind: record.event.type,
      label: simulationReplayLabel(record.event),
      activeAgents: nodes.filter((node) => node.status === "active").length,
      totalAgents: nodes.length,
      topology: topology?.bracket ?? "No topology selected",
      ...simulationReplayEvidence(record.event),
    };
  });
};

const runScenario = async (input: {
  readonly campaign: SimulationCampaignInput;
  readonly stages: ReadonlyArray<StageSpec>;
  readonly entropy: EntropySource;
  readonly faultSeed: number;
}): Promise<ScenarioResult> => {
  const runId = `simulation-${input.campaign.pattern}`;
  const pack = buildSimulationPack(input.campaign);
  const records: EventRecord[] = [];
  let state = initialOrchestrationState;
  let ts = 0;
  const apply = (event: OrchestrationEvent): void => {
    ts += 1;
    records.push({ ts, event });
    state = reduceOrchestration(state, event, ts);
  };

  apply(orchestrationConfiguredEvent(runId, pack));
  const demands = workerDemands(input.campaign.pattern, input.campaign.agents);
  const initialReflection = reflectOnOrchestration({
    runId,
    policyId: "simulation-population",
    policyVersion: pack.policyVersion,
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
    maxNodes: pack.limits.maxNodes,
    unmetDemands: demands,
  });
  apply(reflectionRecordedEvent(runId, initialReflection));
  const workers: WorkspaceNode[] = [];
  for (const [index, action] of initialReflection.actions.entries()) {
    if (action.type !== "spawn") continue;
    const worker = materializeNodeDemand({
      runId,
      reflectionId: initialReflection.reflectionId,
      index,
      coordinatorId: pack.coordinatorId,
      demand: action.demand,
    });
    workers.push(worker);
    apply({ type: "node.spawned", runId, node: worker, reason: initialReflection.reason });
  }
  const leaves = [...workers.map((worker) => worker.id), "review"];
  let topology: CompositionTree = input.campaign.pattern === "adaptive"
    ? leftCombCompositionTree(leaves)
    : balancedCompositionTree(leaves);
  let topologyEvent = topologySelectedEvent({
    runId,
    operation: "initialize",
    bracket: compositionBracket(topology),
    leaves: compositionLeaves(topology),
    reason: `Initialize the ${input.campaign.pattern} composition frontier.`,
  });
  apply(topologyEvent);

  const allTaskIds = input.stages.flatMap((stage) => stage.taskIds);
  const faultTaskId = input.campaign.injectFaults
    ? allTaskIds[input.faultSeed % allTaskIds.length]
    : undefined;
  const tasks = [...buildSimulationTasks(input.campaign.pattern, input.stages, workers)];
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const outputs = new Map<string, string>();
  const runtime = createDeterminedTaskRuntime({
    entropy: input.entropy,
    ...(faultTaskId ? { faultTaskId } : {}),
  });
  const clock = new VirtualClock();
  const taskGraph = new InMemoryTaskGraphControl(clock);
  const dataReferences = new InMemoryDataReferenceStore({
    // Every accepted text task owns at most one immutable value. The default
    // store limit of 256 is below the valid 128-worker pipeline envelope.
    maxEntries: Math.min(4_096, tasks.length + 4),
  });
  const ledger = new SharedWorkspaceLedger(`simulation:${runId}`);
  const topologyVersion = topologyEvent.topologyId;
  const catalogVersion = `${pack.id}@${pack.version}`;
  const coordinator = pack.nodes.find((node) => node.id === pack.coordinatorId);
  if (!coordinator) throw new Error("Simulation platform has no coordinator");
  const coordinatorRuntime: NodeRuntimeAdapter = {
    kind: "simulation-coordinator",
    executeEnvelope: async (envelope, executionControl) => {
      if (envelope.task.taskId === "campaign_complete") {
        return {
          schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
          status: "completed",
          output: "The dynamically expanded simulation DAG completed.",
        };
      }
      if (envelope.task.taskId !== "campaign_root") {
        throw new Error(`Simulation coordinator cannot execute ${envelope.task.taskId}`);
      }
      if (!executionControl.invokeFunction) {
        throw new Error("Simulation coordinator has no live function plane");
      }
      const control = {
        executionId: envelope.executionId,
        runId: envelope.runId,
        nodeId: envelope.node.id,
        taskId: envelope.task.taskId,
        ...(envelope.trace ? { trace: envelope.trace } : {}),
        ...(executionControl.signal ? { signal: executionControl.signal } : {}),
      };
      const search = await executionControl.invokeFunction({
        functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
        value: { query: "expand", capabilities: ["coordinate"], limit: 4 },
      }, control);
      if (search.status !== "completed") {
        throw new Error("Simulation catalog search did not complete");
      }
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
      const provider = expansion?.providers[0];
      if (!expansion || !provider) {
        throw new Error("Simulation catalog did not expose a pinned graph expansion provider");
      }
      const invoked = await executionControl.invokeFunction({
        functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
        value: {
          operation: "call",
          catalogVersion: snapshot.catalogVersion,
          functionId: expansion.id,
          functionVersion: expansion.version,
          providerId: provider.providerId,
          providerEpoch: provider.epoch,
          value: {
            expansionKey: `campaign-${input.campaign.pattern}-dag-v1`,
            children: tasks.map((task) => ({
              taskId: task.taskId,
              semanticKey: `${runId}:${task.stageId}:${task.taskId}`,
              nodeId: task.nodeId,
              capability: task.capability,
              objective: task.objective,
              dependencyTaskIds: task.dependencyTaskIds,
              result: { mode: "text", outputKey: task.outputKey },
              estimatedCostMicros: 0,
            })),
            continuation: {
              taskId: "campaign_complete",
              semanticKey: `${runId}:campaign-complete`,
              nodeId: coordinator.id,
              capability: "coordinate",
              objective: "Close the accepted dynamically expanded campaign frontier.",
              result: { mode: "none" },
              join: { kind: "all-success" },
              estimatedCostMicros: 0,
            },
          },
        },
      }, control);
      if (invoked.status !== "completed") {
        throw new Error("Simulation graph expansion did not complete");
      }
      return {
        schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
        status: "completed",
        output: "The live catalog expanded the campaign DAG.",
      };
    },
  };
  const platform = defineRosterPlatform({
    id: pack.id,
    version: pack.version,
    policyVersion: pack.policyVersion,
    coordinatorId: pack.coordinatorId,
    capabilities: pack.capabilities,
    nodes: [
      { ...coordinator, runtime: { kind: coordinatorRuntime.kind } },
      ...workers,
    ],
    maxNodes: pack.limits.maxNodes,
    policy: campaignExecutionPolicy(input.campaign),
  });
  const root = createRosterRootTask({
    taskId: "campaign_root",
    semanticKey: `${runId}:campaign-root`,
    nodeId: coordinator.id,
    capability: "coordinate",
    objective: `Discover and publish the bounded ${input.campaign.pattern} DAG.`,
    inputs: {
      inputVersions: { campaign: hashCanonical(input.campaign) },
      dataReferences: [],
      frontierVersion: `${runId}:frontier`,
      topologyVersion,
      catalogVersion,
    },
    result: { mode: "none" },
    retry: {
      maxAttempts: input.campaign.injectFaults ? 2 : 1,
      initialBackoffMs: 1,
      maximumBackoffMs: 1,
    },
    timeoutMs: 30_000,
    estimatedCostMicros: 0,
  });
  const execution = platform.createExecution({
    runId,
    seedTasks: [root],
    taskGraph,
    dataReferences,
    nodeRuntimes: new NodeRuntimeRegistry([coordinatorRuntime]),
    createTaskContext: ({ runId: taskRunId, node, definition, lease }) =>
      createRosterTaskContext({
        node,
        ledger,
        fence: {
          runId: taskRunId,
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
            const record = taskGraphTask(await taskGraph.snapshot(), definition.taskId);
            if (
              !record
              || (record.status !== "leased" && record.status !== "running")
              || record.leaseOwner !== lease.owner
              || record.leaseFence !== lease.fence
            ) {
              throw new Error(`Simulation task ${definition.taskId} no longer owns its workspace fence`);
            }
          },
        },
      }),
    nativeExecute: async (context) => runtime.execute(context, async () => {
      const task = tasksById.get(context.definition.taskId);
      if (!task) throw new Error(`Simulation graph has no task ${context.definition.taskId}`);
      const dependencyValues = await Promise.all(task.dependencyTaskIds.map(async (taskId) => {
        const reference = context.dependencyDataReferences[taskId]?.[0]?.reference;
        if (!reference) throw new Error(`Simulation task ${task.taskId} is missing ${taskId}`);
        const value = await context.readDataReference(reference, { signal: context.signal });
        if (typeof value !== "string") {
          throw new Error(`Simulation dependency ${taskId} did not publish text`);
        }
        return value;
      }));
      const output = task.stageId === "evidence-remediation"
        ? hashCanonical({
            policy: "adaptive-evidence-review-v1",
            reviewer: task.nodeId,
            frontier: task.dependencyTaskIds.map((taskId, index) => ({
              taskId,
              value: dependencyValues[index],
            })),
          })
        : hashCanonical({
            pattern: input.campaign.pattern,
            stage: task.stageId,
            taskId: task.taskId,
            inputs: dependencyValues,
          });
      outputs.set(task.outputKey, output);
      return output;
    }),
    clock,
    readyBatchRunner: async (entries) => {
      await runtime.runReadyBatch(entries);
      // One logical millisecond per completed batch makes retry eligibility
      // replayable independently of the host's scheduling speed.
      await clock.advanceBy(1);
    },
    onFunctionActivity: async (activity) => {
      apply(functionActivityRecordedEvent(runId, activity));
    },
  });
  const firstQuiescence = await execution.dispatchUntilQuiescent();
  if (firstQuiescence.deadlocked) {
    throw new Error(`Simulation ${input.campaign.pattern} task graph deadlocked`);
  }
  let graphSnapshot = await execution.snapshot();
  const incomplete = graphSnapshot.tasks.filter((record) =>
    record.status !== "accepted" && record.status !== "skipped");
  if (incomplete.length > 0) {
    throw new Error(
      `Simulation graph did not converge: ${incomplete.map((record) =>
        `${record.definition.taskId}:${record.status}:${record.error ?? ""}`).join(", ")}`,
    );
  }
  apply(taskGraphProjectedEvent(runId, graphSnapshot));
  const firstSnapshot = runtime.snapshot();
  const completionOrder = [...firstSnapshot.completionOrder];
  let peakParallel = firstSnapshot.peakParallel;
  const faultRecoveries = firstSnapshot.faultMatches;
  let adaptiveRemediationTasks = 0;

  let reflectionIteration = 1;
  if (input.campaign.pattern === "adaptive") {
    reflectionIteration += 1;
    const lastWorker = workers.at(-1);
    if (!lastWorker) throw new Error("Adaptive simulation has no reviewer for acceptance evidence");
    const evidenceGaps = outputs.has(ADAPTIVE_REVIEW_OUTPUT) ? 0 : 1;
    const adaptiveReflection = reflectOnOrchestration({
      runId,
      policyId: "simulation-adaptation",
      policyVersion: pack.policyVersion,
      iteration: reflectionIteration,
      observation: {
        activeNodes: workers.length + 1,
        pendingTasks: 0,
        runningTasks: 0,
        failedTasks: 0,
        conflicts: 0,
        evidenceGaps,
        stagnationRounds: 0,
        goalSatisfied: false,
      },
      maxNodes: pack.limits.maxNodes,
      topology,
      affinities: new Map([[topologyPairKey(lastWorker.id, "review"), 8]]),
    });
    apply(reflectionRecordedEvent(runId, adaptiveReflection));
    const rotation = adaptiveReflection.actions.find((action) => action.type === "rebracket");
    if (rotation?.type === "rebracket") {
      const rotated = parseCompositionBracket(rotation.bracket);
      if (!rotated) throw new Error("Adaptive simulation selected an invalid bracket");
      topology = rotated;
      topologyEvent = topologySelectedEvent({
        runId,
        previousTopologyId: topologyEvent.topologyId,
        operation: "rotate",
        previousBracket: rotation.previousBracket,
        bracket: rotation.bracket,
        leaves: compositionLeaves(topology),
        direction: rotation.direction,
        score: rotation.score,
        reason: adaptiveReflection.reason,
      });
      apply(topologyEvent);
    }

    const replans = adaptiveReflection.actions.filter((action) => action.type === "replan");
    if (evidenceGaps > 0 && replans.length !== 1) {
      throw new Error("Adaptive evidence gap did not produce exactly one bounded replan action");
    }
    if (replans.length > 0) {
      const remediationTask = buildAdaptiveRemediationTask(tasks, lastWorker);
      tasks.push(remediationTask);
      tasksById.set(remediationTask.taskId, remediationTask);
      await execution.taskGraph.enqueue(taskDefinition({
        runId,
        topologyVersion: topologyEvent.topologyId,
        catalogVersion,
        task: remediationTask,
        retryFaults: false,
      }));
      const remediationQuiescence = await execution.dispatchUntilQuiescent();
      if (remediationQuiescence.deadlocked) {
        throw new Error("Adaptive evidence remediation deadlocked");
      }
      graphSnapshot = await execution.snapshot();
      apply(taskGraphProjectedEvent(runId, graphSnapshot));
      if (
        taskGraphTask(graphSnapshot, remediationTask.taskId)?.status !== "accepted"
        || !outputs.has(ADAPTIVE_REVIEW_OUTPUT)
      ) {
        throw new Error(
          taskGraphTask(graphSnapshot, remediationTask.taskId)?.error
            ?? "Adaptive evidence remediation did not publish acceptance evidence",
        );
      }
      const remediationSnapshot = runtime.snapshot();
      completionOrder.splice(
        0,
        completionOrder.length,
        ...remediationSnapshot.completionOrder,
      );
      peakParallel = Math.max(peakParallel, remediationSnapshot.peakParallel);
      adaptiveRemediationTasks = 1;
    }

    reflectionIteration += 1;
    const remainingEvidenceGaps = outputs.has(ADAPTIVE_REVIEW_OUTPUT) ? 0 : 1;
    const retirable = workers.length > 2 ? [lastWorker.id] : [];
    const consolidation = reflectOnOrchestration({
      runId,
      policyId: "simulation-consolidation",
      policyVersion: pack.policyVersion,
      iteration: reflectionIteration,
      observation: {
        activeNodes: workers.length + 1,
        pendingTasks: 0,
        runningTasks: 0,
        failedTasks: 0,
        conflicts: 0,
        evidenceGaps: remainingEvidenceGaps,
        stagnationRounds: 0,
        goalSatisfied: false,
      },
      maxNodes: pack.limits.maxNodes,
      retirableNodeIds: retirable,
      topology,
    });
    apply(reflectionRecordedEvent(runId, consolidation));
    for (const action of consolidation.actions) {
      if (action.type !== "retire") continue;
      apply({ type: "node.retired", runId, nodeId: action.nodeId, reason: consolidation.reason });
      const contracted = contractCompositionLeaf(topology, action.nodeId);
      if (!contracted) throw new Error("Adaptive simulation contracted the complete frontier");
      topologyEvent = topologySelectedEvent({
        runId,
        previousTopologyId: topologyEvent.topologyId,
        operation: "contract",
        previousBracket: compositionBracket(topology),
        bracket: compositionBracket(contracted),
        leaves: compositionLeaves(contracted),
        reason: consolidation.reason,
      });
      topology = contracted;
      apply(topologyEvent);
    }
  }

  reflectionIteration += 1;
  const terminal = reflectOnOrchestration({
    runId,
    policyId: "simulation-acceptance",
    policyVersion: pack.policyVersion,
    iteration: reflectionIteration,
    observation: {
      activeNodes: Object.values(state.nodes).filter((node) => node.status === "active").length,
      pendingTasks: 0,
      runningTasks: 0,
      failedTasks: 0,
      conflicts: 0,
      evidenceGaps: input.campaign.pattern === "adaptive"
        && !outputs.has(ADAPTIVE_REVIEW_OUTPUT)
        ? 1
        : 0,
      stagnationRounds: 0,
      goalSatisfied: true,
    },
    maxNodes: pack.limits.maxNodes,
    topology,
  });
  apply(reflectionRecordedEvent(runId, terminal));
  if (terminal.actions.length !== 1 || terminal.actions[0]?.type !== "stop") {
    throw new Error("Simulation acceptance policy did not reach stop");
  }

  const replayedState = replayRecords(records);
  if (hashCanonical(replayedState) !== hashCanonical(state)) {
    throw new Error("Simulation receipt replay diverged from the live projection");
  }
  const finalTaskGraph = taskReports(graphSnapshot);
  const finalRuntime = runtime.snapshot();
  return {
    state,
    records,
    completionOrder,
    peakParallel,
    faultRecoveries,
    transitionOrder: finalRuntime.transitions,
    graphExpansions: graphSnapshot.expansions.length,
    semanticDigest: hashCanonical({
      tasks: finalTaskGraph.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        outputKey: task.outputKey,
      })),
      outputs: Object.fromEntries([...outputs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))),
      activeAgents: Object.values(state.nodes)
        .filter((node) => node.status === "active")
        .map((node) => node.id)
        .sort(),
      topology: state.topologyId ? state.topologies[state.topologyId]?.bracket : undefined,
    }),
    stages: [
      ...input.stages.map((stage) => ({ id: stage.id, label: stage.label, tasks: stage.taskIds.length })),
      ...(adaptiveRemediationTasks > 0
        ? [{ id: "evidence-remediation", label: "Acceptance evidence remediation", tasks: adaptiveRemediationTasks }]
        : []),
    ],
    taskGraph: finalTaskGraph,
    expansions: graphSnapshot.expansions.map((expansion) => ({
      parentTaskId: expansion.parentTaskId,
      expansionKey: expansion.expansionKey,
      expansionHash: expansion.expansionHash,
      childTaskIds: [...expansion.childTaskIds],
      continuationTaskId: expansion.continuationTaskId,
    })),
  };
};

export const runSimulationCampaign = async (
  rawInput: Partial<SimulationCampaignInput>
): Promise<SimulationCampaignReport> => {
  const startedAt = Date.now();
  const input = normalizeSimulationCampaignInput(rawInput);
  const pattern = COORDINATION_PATTERNS.find((candidate) => candidate.id === input.pattern)
    ?? COORDINATION_PATTERNS[0];
  if (!pattern) throw new Error("Simulation pattern catalog is empty");
  const stages = buildStages(input.pattern, input.agents);
  const reports: SimulationScheduleReport[] = [];
  const semanticDigests = new Set<string>();
  const orderDigests = new Set<string>();
  let firstScenario: ScenarioResult | undefined;

  for (let index = 0; index < input.schedules; index += 1) {
    const seed = (input.seed + Math.imul(index, 0x9e3779b1)) >>> 0;
    const recording = new RecordingEntropySource(new SeededEntropySource(seed));
    const first = input.pattern === "collaboration"
      ? await runCodingCollaborationSimulation({
          agents: input.agents,
          maxParallel: input.maxParallel,
          injectFaults: input.injectFaults,
          entropy: recording,
        })
      : await runScenario({
          campaign: input,
          stages,
          entropy: recording,
          faultSeed: seed,
        });
    const entropyRecords = recording.getRecords();
    const replaySource = new ReplayingEntropySource(entropyRecords);
    let replayEntropyDraws = 0;
    const replayEntropy: EntropySource = {
      random: (reason) => {
        replayEntropyDraws += 1;
        return replaySource.random(reason);
      },
    };
    const replay = input.pattern === "collaboration"
      ? await runCodingCollaborationSimulation({
          agents: input.agents,
          maxParallel: input.maxParallel,
          injectFaults: input.injectFaults,
          entropy: replayEntropy,
        })
      : await runScenario({
          campaign: input,
          stages,
          entropy: replayEntropy,
          faultSeed: seed,
        });
    const semanticDigest = first.semanticDigest ?? hashCanonical(first.state);
    const completionDigest = hashCanonical(first.completionOrder);
    const transitionOrder = "transitionOrder" in first ? first.transitionOrder ?? [] : [];
    const transitionDigest = hashCanonical(transitionOrder);
    const replayExact = replayEntropyDraws === entropyRecords.length && hashCanonical({
      records: first.records,
      state: first.state,
      completionOrder: first.completionOrder,
      peakParallel: first.peakParallel,
      faultRecoveries: first.faultRecoveries,
      transitionOrder,
      graphExpansions: "graphExpansions" in first ? first.graphExpansions : undefined,
      details: first.details,
      taskGraph: "taskGraph" in first ? first.taskGraph : undefined,
      expansions: "expansions" in first ? first.expansions : undefined,
    }) === hashCanonical({
      records: replay.records,
      state: replay.state,
      completionOrder: replay.completionOrder,
      peakParallel: replay.peakParallel,
      faultRecoveries: replay.faultRecoveries,
      transitionOrder: "transitionOrder" in replay ? replay.transitionOrder ?? [] : [],
      graphExpansions: "graphExpansions" in replay ? replay.graphExpansions : undefined,
      details: replay.details,
      taskGraph: "taskGraph" in replay ? replay.taskGraph : undefined,
      expansions: "expansions" in replay ? replay.expansions : undefined,
    });
    semanticDigests.add(semanticDigest);
    orderDigests.add(completionDigest);
    firstScenario ??= first;
    reports.push({
      seed,
      seedHex: `0x${seed.toString(16).padStart(8, "0")}`,
      entropyDraws: entropyRecords.length,
      converged: true,
      replayExact,
      peakParallel: first.peakParallel,
      faultRecoveries: first.faultRecoveries,
      completionDigest: completionDigest.slice(0, 12),
      transitionCount: transitionOrder.length,
      transitionDigest: transitionDigest.slice(0, 12),
    });
  }

  if (!firstScenario) throw new Error("Simulation campaign produced no schedules");
  const topologies = Object.values(firstScenario.state.topologies)
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .map((topology) => ({
      operation: topology.operation,
      leaves: topology.leaves.length,
      bracket: topology.bracket,
      reason: topology.reason,
    }));
  const exactReplays = reports.filter((report) => report.replayExact).length;
  const runtimeLifecycle = await runRuntimeLifecycleSimulation({
    schedules: input.schedules,
    injectFaults: input.injectFaults,
    seed: (input.seed ^ 0xc0d15e) >>> 0,
  });
  const terminalProjection = input.pattern === "collaboration"
    ? runCodingTerminalProjectionSimulation({
        schedules: input.schedules,
        seed: (input.seed ^ 0x7e2d_91c3) >>> 0,
        injectFaults: input.injectFaults,
      })
    : undefined;
  const converged = semanticDigests.size === 1
    && exactReplays === reports.length
    && runtimeLifecycle.summary.passed
    && (terminalProjection?.passed ?? true);
  return {
    campaignId: `campaign_${hashCanonical(input).slice(0, 16)}`,
    input,
    pattern,
    durationMs: Date.now() - startedAt,
    stages: firstScenario.stages
      ?? stages.map((stage) => ({ id: stage.id, label: stage.label, tasks: stage.taskIds.length })),
    schedules: reports.map((report) => ({ ...report, converged })),
    topologies,
    replayFrames: buildSimulationReplayFrames(firstScenario.records),
    ...(firstScenario.taskGraph ? { taskGraph: firstScenario.taskGraph } : {}),
    ...("expansions" in firstScenario && firstScenario.expansions
      ? { expansions: firstScenario.expansions }
      : {}),
    ...(firstScenario.details ? { application: firstScenario.details } : {}),
    ...(terminalProjection ? { terminalProjection } : {}),
    runtimeLifecycle,
    summary: {
      converged,
      requestedAgents: input.agents,
      exercisedAgents: firstScenario.details?.selectedSpecialists
        ?? Object.values(firstScenario.state.nodes).filter((node) => node.status === "active").length,
      exactReplays,
      scheduleVariants: orderDigests.size,
      faultRecoveries: reports.reduce((total, report) => total + report.faultRecoveries, 0),
      peakParallel: Math.max(...reports.map((report) => report.peakParallel)),
      receiptsPerRun: firstScenario.records.length,
      finalActiveAgents: Object.values(firstScenario.state.nodes)
        .filter((node) => node.status === "active").length,
      entropyDraws: reports.reduce((total, report) => total + report.entropyDraws, 0),
      graphExpansions: firstScenario.graphExpansions ?? 0,
      catalogSearches: firstScenario.state.functionActivities.filter((activity) =>
        activity.operation === "catalog.search").length,
      catalogInvocations: firstScenario.state.functionActivities.filter((activity) =>
        activity.operation === "function.call").length,
    },
  };
};
