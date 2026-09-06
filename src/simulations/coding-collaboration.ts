import type { EntropySource } from "determined";

import { hashCanonical } from "../core/canonical.js";
import {
  clampCodingAgentTurnPolicy,
  createCodingAgentTurn,
  planCodingAgentTurns,
  type CodingAgentTurnPlan,
} from "../domains/coding-agent-turn.js";
import {
  CODING_COLLABORATION_RESOLUTION_OUTPUT,
  codingCollaborationArtifactId,
  codingCollaborationContributions,
  codingResolutionCoverage,
  isCodingCollaborationOutputKey,
  parseCodingPeerResolution,
  unresolvedCodingCollaborationConflicts,
} from "../domains/coding-collaboration.js";
import {
  validateCodingConversationPlannerResult,
} from "../domains/coding-conversation.js";
import {
  defineCodingAgentPlatform,
  evaluateCodingConsensus,
  previewCodingAgentGraph,
  runCodingAgent,
  type CodingAgentExecutionResult,
} from "../domains/coding.js";
import { codingHumanWorkspaceNode, type CodingWorkspaceDependency } from "../domains/coding-workspace.js";
import { InMemoryDataReferenceStore } from "../engine/dataflow/data-reference-store.js";
import {
  InMemoryTaskGraphControl,
  taskGraphEffectiveTask,
  taskGraphTask,
  type TaskGraphControl,
} from "../engine/orchestration/task-graph-control.js";
import {
  balancedCompositionTree,
  compositionBracket,
  compositionLeaves,
} from "../engine/orchestration/topology.js";
import type { JsonValue, WorkspaceNode } from "../engine/orchestration/types.js";
import {
  NODE_EXECUTION_SCHEMA_VERSION,
  NodeRuntimeRegistry,
  type NodeExecutionEnvelope,
  type NodeRuntimeExecutionControl,
} from "../engine/runtime/node-runtime.js";
import {
  ROSTER_CONSULT_FUNCTION_ID,
  ROSTER_NODE_CONSULTATION_SCHEMA_VERSION,
  type RosterPlatformExecutionOptions,
} from "../engine/platform/roster-platform.js";
import {
  ROSTER_CATALOG_INVOKE_FUNCTION_ID,
  ROSTER_CATALOG_SEARCH_FUNCTION_ID,
} from "../engine/runtime/node-function-plane.js";
import { NodeRoomUpdateStore } from "../engine/runtime/node-room-updates.js";
import {
  SharedWorkspaceLedger,
  createRosterTaskContext,
} from "../engine/workspace/shared-workspace.js";
import {
  initialOrchestrationState,
  nodeRuntimeBoundEvent,
  orchestrationConfiguredEvent,
  reduceOrchestration,
  taskGraphProjectedEvent,
  topologySelectedEvent,
  type OrchestrationEvent,
  type OrchestrationState,
} from "../modules/orchestration.js";

export type CodingSimulationInvariant = {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly evidence: string;
};

export type CodingCollaborationSimulationDetails = {
  readonly requestedSpecialists: number;
  readonly selectedSpecialists: number;
  readonly taskCount: number;
  readonly routedResponseCount: number;
  readonly conflictsObserved: number;
  readonly humanEscalations: number;
  readonly certificationBlocks: number;
  readonly staleUpdates: number;
  readonly duplicateDeliveries: number;
  readonly durableResumeExact: boolean;
  readonly graphProjectionExact: boolean;
  readonly replicaConvergenceExact: boolean;
  readonly turnPlannerConvergenceExact: boolean;
  readonly turnPlannerEscalationExact: boolean;
  readonly consultationTurns: number;
  readonly consultationInvocations: number;
  readonly consultationTaskCount: number;
  readonly consultationMaxDepth: number;
  readonly consultationReplayExact: boolean;
  readonly consultationAnySelectionExact: boolean;
  readonly consultationEvidenceTransfers: number;
  readonly invariants: ReadonlyArray<CodingSimulationInvariant>;
};

export type CodingCollaborationSimulationRecord = {
  readonly ts: number;
  readonly event: OrchestrationEvent;
};

export type CodingCollaborationSimulationResult = {
  readonly state: OrchestrationState;
  readonly execution: CodingAgentExecutionResult;
  readonly records: ReadonlyArray<CodingCollaborationSimulationRecord>;
  readonly completionOrder: ReadonlyArray<string>;
  /** Observable inner-loop completion transitions used for schedule coverage. */
  readonly transitionOrder: ReadonlyArray<{
    readonly index: number;
    readonly batch: number;
    readonly taskId: string;
    readonly phase: string;
  }>;
  readonly peakParallel: number;
  readonly faultRecoveries: number;
  readonly graphExpansions: number;
  readonly semanticDigest: string;
  readonly details: CodingCollaborationSimulationDetails;
  readonly stages: ReadonlyArray<{ readonly id: string; readonly label: string; readonly tasks: number }>;
  readonly taskGraph: ReadonlyArray<{
    readonly taskId: string;
    readonly nodeId: string;
    readonly capability: string;
    readonly outputKey: string;
    readonly dependencyTaskIds: ReadonlyArray<string>;
    readonly status: CodingAgentExecutionResult["snapshot"]["tasks"][number]["status"];
    readonly attempt: number;
  }>;
  readonly expansions: ReadonlyArray<{
    readonly parentTaskId: string;
    readonly expansionKey: string;
    readonly expansionHash: string;
    readonly childTaskIds: ReadonlyArray<string>;
    readonly continuationTaskId: string;
  }>;
};

const SPECIALTIES = [
  "implementation",
  "api",
  "data",
  "quality",
  "runtime",
  "security",
  "documentation",
  "ui",
] as const;

const STAGE_LABELS: Readonly<Record<string, string>> = {
  room: "Model-authored start updates",
  propose: "Independent proposals",
  respond: "Dependency-routed discussion",
  resolve: "Conflict-scoped resolution",
  implement: "Repository mutation",
  review: "Independent review",
  remediate: "Finding reconciliation",
  certify: "Exact-frontier endorsement",
};

const syntheticWorkspaceNodes = (count: number): ReadonlyArray<WorkspaceNode> => {
  const boundedCount = Math.max(2, Math.floor(count));
  const nodes: WorkspaceNode[] = [];
  for (let index = 0; index < boundedCount; index += 1) {
    const specialty = SPECIALTIES[index % SPECIALTIES.length] ?? "quality";
    const role = index === 0 ? "worker" : "supervisor";
    const previous = nodes.at(-1);
    nodes.push({
      id: `simulation.${specialty}.${String(index + 1).padStart(3, "0")}`,
      name: index === 0 ? "Avery, Implementation Peer" : `${specialty[0]?.toUpperCase()}${specialty.slice(1)} Peer ${index}`,
      capabilities: role === "worker"
        ? ["implement", "propose", "respond", "remediate"]
        : ["review", "propose", "respond", "certify"],
      runtime: { kind: "roster-native", profile: `simulation.${specialty}` },
      metadata: {
        role,
        specialty,
        group: "Entropy simulation peers",
        repositoryReason: `Exercise the ${specialty} boundary in the coding collaboration simulator.`,
        ...(previous ? { dependsOnNodeIds: [previous.id] } : {}),
      },
    });
  }
  return nodes;
};

const shuffle = <T>(values: ReadonlyArray<T>, entropy: EntropySource, reason: string): T[] => {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(entropy.random(`${reason}:${index}`) * (index + 1));
    [shuffled[index], shuffled[selected]] = [shuffled[selected]!, shuffled[index]!];
  }
  return shuffled;
};

const proposalValue = (position: number, mutationPeer: boolean): string => JSON.stringify({
  status: "proposal",
  summary: mutationPeer
    ? "Keep the export behind the existing authenticated browser session."
    : "Use a short-lived signed URL for the exported record.",
  recommendations: [
    {
      subjectId: "delivery-contract",
      recommendation: mutationPeer || position % 2 === 0
        ? "Return an authenticated attachment from the existing application route"
        : "Return a short-lived signed download URL",
      rationale: "Both designs are implementable, so repository evidence alone cannot choose product intent.",
      evidence: ["src/agents/coding.agent.ts", "src/views/coding.ts"],
      confidence: 0.82,
    },
    {
      subjectId: "validation",
      recommendation: "Verify authorization, bounded output, and deterministic replay",
      rationale: "The collaboration record is derived from durable bounded state.",
      evidence: ["tests/smoke/coding-demo.test.ts"],
      confidence: 0.94,
    },
  ],
  questions: mutationPeer ? [] : ["Which delivery experience does the workspace operator want?"],
});

const responseValue = (): string => JSON.stringify({
  status: "response",
  summary: "The dependency evidence narrows implementation but preserves the product choice.",
  answers: [{
    subjectId: "validation",
    response: "Use the existing authenticated route and deterministic replay fixtures.",
    rationale: "Those boundaries are already owned by the Coding workspace.",
    evidence: ["src/agents/coding.agent.ts"],
    confidence: 0.93,
  }],
  openQuestions: [{
    subjectId: "delivery-contract",
    question: "Should delivery remain in-session or use a signed URL?",
    reason: "Repository evidence cannot decide the intended operator experience.",
  }],
});

const ambiguousResolutionValue = (): string => JSON.stringify({
  status: "ambiguous",
  summary: "The peers need operator intent for the delivery contract.",
  decisions: [{
    subjectId: "validation",
    resolution: "Verify authorization, bounded output, and deterministic replay",
    rationale: "Every peer agrees on the evidence boundary.",
    evidence: ["tests/smoke/coding-demo.test.ts"],
  }],
  unresolved: [{
    subjectId: "delivery-contract",
    reason: "Both delivery mechanisms satisfy the repository contract.",
    candidateSummaries: ["authenticated attachment", "short-lived signed URL"],
  }],
});

const resolvedResolutionValue = (): string => JSON.stringify({
  status: "resolved",
  summary: "The operator selected an authenticated in-session attachment.",
  decisions: [
    {
      subjectId: "delivery-contract",
      resolution: "Return an authenticated attachment from the existing application route",
      rationale: "The human participant supplied the missing product intent.",
      evidence: ["human:delivery-contract", "src/agents/coding.agent.ts"],
    },
    {
      subjectId: "validation",
      resolution: "Verify authorization, bounded output, and deterministic replay",
      rationale: "Every peer agrees on the evidence boundary.",
      evidence: ["tests/smoke/coding-demo.test.ts"],
    },
  ],
  unresolved: [],
});

const stageReports = (
  topologicalOrder: ReadonlyArray<string>,
  tasks: ReadonlyArray<{ readonly id: string; readonly capability: string }>,
): ReadonlyArray<{ readonly id: string; readonly label: string; readonly tasks: number }> => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const capabilities: string[] = [];
  for (const taskId of topologicalOrder) {
    const capability = byId.get(taskId)?.capability;
    if (capability && !capabilities.includes(capability)) capabilities.push(capability);
  }
  return capabilities.map((capability) => ({
    id: capability,
    label: STAGE_LABELS[capability] ?? capability,
    tasks: tasks.filter((task) => task.capability === capability).length,
  }));
};

export const runCodingCollaborationSimulation = async (input: {
  readonly agents: number;
  readonly maxParallel: number;
  readonly injectFaults: boolean;
  readonly entropy: EntropySource;
}): Promise<CodingCollaborationSimulationResult> => {
  const runId = "simulation-coding-collaboration";
  const requestedNodes = syntheticWorkspaceNodes(input.agents);
  const primary = requestedNodes[0];
  if (!primary) throw new Error("Coding collaboration simulation requires a mutation peer");
  const codingOptions = {
    workspaceNodes: requestedNodes,
    selectedNodeIds: requestedNodes.map((node) => node.id),
    primaryNodeId: primary.id,
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    reviewPolicy: "reviewed",
    workerRuntime: "claude-code",
    reviewerRuntime: "codex-cli",
    maxNodes: 8,
    // The production Coding graph reserves one accepted model-authored room
    // announcement before each substantive peer turn. Keep this adversarial
    // campaign at three selected specialists so the base graph plus two nested
    // consultations and Roster's control tasks remain inside maxTasks=32.
    maxSupervisors: 2,
    maxParallel: Math.min(6, Math.max(1, input.maxParallel)),
  } as const;
  const codingInput = {
    objective: "Add a bounded authenticated collaboration-record export with durable replay evidence.",
    runId,
  };
  const platform = defineCodingAgentPlatform(codingOptions, codingInput);
  const compiled = previewCodingAgentGraph({ ...codingOptions, ...codingInput });
  const planNodes = compiled.nodes.filter((node) => node.id !== platform.definition.coordinatorId);
  const proposalTasks = compiled.tasks.filter((task) => task.capability === "propose");
  const consultationRootTask = proposalTasks.find((task) => task.nodeId === primary.id)
    ?? proposalTasks[0];
  if (!consultationRootTask) {
    throw new Error("Coding collaboration simulation requires one proposal consultation root");
  }
  const consultationRootRecipients = planNodes
    .filter((node) =>
      node.id !== consultationRootTask.nodeId
      && node.capabilities.includes("respond"))
    .slice(0, 2);
  if (consultationRootRecipients.length === 0) {
    throw new Error("Coding collaboration simulation requires one eligible consultation peer");
  }
  const nestedConsultationAuthor = consultationRootRecipients[0];
  const nestedConsultationRecipients = nestedConsultationAuthor
    ? planNodes
        .filter((node) =>
          node.id !== consultationRootTask.nodeId
          && node.id !== nestedConsultationAuthor.id
          && node.capabilities.includes("respond"))
        .slice(0, 2)
    : [];
  const certificationKeys = compiled.tasks
    .filter((task) => task.capability === "certify")
    .flatMap((task) => task.provides);

  const records: CodingCollaborationSimulationRecord[] = [];
  let state = initialOrchestrationState;
  let clock = 0;
  const apply = (event: OrchestrationEvent): void => {
    clock += 1;
    state = reduceOrchestration(state, event, clock);
    records.push({ ts: clock, event });
  };

  apply(orchestrationConfiguredEvent(runId, platform.registry.pack));
  for (const node of planNodes) {
    apply({ type: "node.spawned", runId, node, reason: "Dynamic coding simulation demand" });
  }
  const topology = balancedCompositionTree(planNodes.map((node) => node.id));
  const topologyEvent = topologySelectedEvent({
    runId,
    operation: "initialize",
    bracket: compositionBracket(topology),
    leaves: compositionLeaves(topology),
    reason: "Peer task dependencies express collaboration order without permanent authority.",
  });
  apply(topologyEvent);
  for (const node of planNodes) {
    apply(nodeRuntimeBoundEvent({
      runId,
      nodeId: node.id,
      runtime: node.runtime,
      epoch: 1,
      topologyVersion: topologyEvent.topologyId,
      sessionId: `simulation-session-${node.id}`,
    }));
  }

  const collaboration = new SharedWorkspaceLedger(codingCollaborationArtifactId(runId));
  const taskWorkspace = new SharedWorkspaceLedger(`simulation-task-workspace:${runId}`);
  let replicaA: SharedWorkspaceLedger | undefined;
  let replicaB: SharedWorkspaceLedger | undefined;
  try {
    const taskGraph = new InMemoryTaskGraphControl();
    const dataReferences = new InMemoryDataReferenceStore();
    const roomUpdates = new NodeRoomUpdateStore();
    const runtimeCalls = new Map<string, number>();
    const runtimeCompletionOrder: string[] = [];
    let activeRuntimes = 0;
    let peakParallel = 0;
    const runtimeValue = (taskId: string, capability: string, nodeId: string): string => {
      const proposalIndex = proposalTasks.findIndex((candidate) => candidate.id === taskId);
      const node = platform.registry.node(nodeId);
      if (capability === "room") {
        return JSON.stringify({
          summary: `Simulation node ${node.name} is starting ${taskId.slice("announce-".length)}.`,
        });
      }
      if (capability === "propose") return proposalValue(proposalIndex, node.metadata?.role === "worker");
      if (capability === "respond") return responseValue();
      if (capability === "resolve") return resolvedResolutionValue();
      if (capability === "implement") {
        return JSON.stringify({
          changedFiles: ["src/views/coding-collaboration-record.ts"],
          validation: ["focused"],
        });
      }
      if (capability === "review") {
        return JSON.stringify({ findings: [], evidence: ["focused simulation review"] });
      }
      if (capability === "remediate") {
        return JSON.stringify({
          status: "verified",
          summary: "I reconciled the simulated review evidence into the certified frontier.",
          validation: ["focused simulation validation"],
          frontierHash: "frontier-simulation-certified",
        });
      }
      if (capability === "certify") {
        return JSON.stringify({
          verdict: "approve",
          frontierHash: "frontier-simulation-certified",
          summary: "The simulated frontier is coherent.",
          evidence: [
            "consumed final_report frontier identity without a shared Git index",
            "entropy replay",
            "CRDT convergence",
          ],
        });
      }
      if (capability === "synthesize") {
        return JSON.stringify({
          status: "completed",
          summary: "I completed the simulated change and verified its certified frontier.",
          frontierHash: "frontier-simulation-certified",
        });
      }
      return JSON.stringify({ status: "completed" });
    };
    let consultationInvocations = 0;
    let consultationReplayExact = true;
    let consultationAnySelectionExact = true;
    let consultationEvidenceTransfers = 0;
    const invokeConsultation = async (input: {
      readonly envelope: NodeExecutionEnvelope;
      readonly control: NodeRuntimeExecutionControl;
      readonly turnKey: string;
      readonly question: string;
      readonly recipientNodeIds: ReadonlyArray<string>;
      readonly responseRequirement: "any" | "all";
      readonly replay?: boolean;
    }): Promise<void> => {
      const invokeFunction = input.control.invokeFunction;
      if (!invokeFunction) throw new Error("Coding consultation simulation has no function plane");
      const functionControl = {
        executionId: input.envelope.executionId,
        runId: input.envelope.runId,
        nodeId: input.envelope.node.id,
        taskId: input.envelope.task.taskId,
        ...(input.envelope.trace ? { trace: input.envelope.trace } : {}),
        ...(input.control.signal ? { signal: input.control.signal } : {}),
      };
      const search = await invokeFunction({
        functionId: ROSTER_CATALOG_SEARCH_FUNCTION_ID,
        value: { query: "consult", limit: 4 },
      }, functionControl);
      if (search.status !== "completed") throw new Error("Consultation catalog search failed");
      const catalog = search.output as {
        readonly catalogVersion: string;
        readonly entries: ReadonlyArray<{
          readonly id: string;
          readonly version: string;
          readonly providers: ReadonlyArray<{ readonly providerId: string; readonly epoch: number }>;
        }>;
      };
      const consult = catalog.entries.find((entry) => entry.id === ROSTER_CONSULT_FUNCTION_ID);
      const provider = consult?.providers[0];
      if (!consult || !provider) throw new Error("Consultation catalog has no pinned provider");
      const invocation = {
        functionId: ROSTER_CATALOG_INVOKE_FUNCTION_ID,
        value: {
          operation: "call",
          catalogVersion: catalog.catalogVersion,
          functionId: consult.id,
          functionVersion: consult.version,
          providerId: provider.providerId,
          providerEpoch: provider.epoch,
          value: {
            schemaVersion: ROSTER_NODE_CONSULTATION_SCHEMA_VERSION,
            turnKey: input.turnKey,
            question: input.question,
            recipients: input.recipientNodeIds.map((nodeId) => ({ nodeId, capability: "respond" })),
            responseRequirement: input.responseRequirement,
            evidence: ["simulation:accepted-frontier"],
          },
        },
      } as const;
      const first = await invokeFunction(invocation, functionControl);
      consultationInvocations += 1;
      if (first.status !== "completed") throw new Error("Consultation invocation failed");
      const firstOutput = first.output as {
        readonly childTaskIds: ReadonlyArray<string>;
      };
      if (input.responseRequirement === "any") {
        consultationAnySelectionExact = consultationAnySelectionExact
          && firstOutput.childTaskIds.length === 1;
      }
      if (input.replay) {
        const replayed = await invokeFunction(invocation, functionControl);
        consultationInvocations += 1;
        consultationReplayExact = consultationReplayExact
          && hashCanonical(replayed) === hashCanonical(first);
      }
    };
    const resolvedDependencyValues = (envelope: NodeExecutionEnvelope): ReadonlyArray<unknown> => {
      const input = envelope.input as {
        readonly dependencies?: Readonly<Record<string, {
          readonly resolvedDataReferences?: ReadonlyArray<{ readonly value: unknown }>;
        } | null>>;
      } | undefined;
      return Object.values(input?.dependencies ?? {}).flatMap((dependency) =>
        dependency?.resolvedDataReferences?.map(({ value }) => value) ?? []);
    };
    const adapter = (kind: "claude-code" | "codex-cli") => ({
      kind,
      executeEnvelope: async (
        envelope: NodeExecutionEnvelope,
        control: NodeRuntimeExecutionControl,
      ) => {
        runtimeCalls.set(envelope.task.taskId, (runtimeCalls.get(envelope.task.taskId) ?? 0) + 1);
        activeRuntimes += 1;
        peakParallel = Math.max(peakParallel, activeRuntimes);
        try {
          const delayRounds = 1 + Math.floor(
            input.entropy.random(`coding:runtime-order:${envelope.task.taskId}`) * 8,
          );
          for (let round = 0; round < delayRounds; round += 1) await Promise.resolve();
          if (envelope.task.taskId === consultationRootTask.id) {
            await invokeConsultation({
              envelope,
              control,
              turnKey: "delivery-authority",
              question: "Which accepted boundary should govern collaboration-record delivery?",
              recipientNodeIds: consultationRootRecipients.map((node) => node.id),
              responseRequirement: "all",
              replay: true,
            });
            return {
              schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
              status: "completed" as const,
              output: "delegated to bounded peers",
            };
          }
          if (
            nestedConsultationAuthor
            && nestedConsultationRecipients.length > 0
            && envelope.node.id === nestedConsultationAuthor.id
            && envelope.task.taskId.startsWith("consult_")
          ) {
            await invokeConsultation({
              envelope,
              control,
              turnKey: "delivery-evidence",
              question: "Which evidence source proves the delivery boundary?",
              recipientNodeIds: nestedConsultationRecipients.map((node) => node.id),
              responseRequirement: "any",
            });
            return {
              schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
              status: "completed" as const,
              output: "delegated for one deterministic peer answer",
            };
          }
          if (envelope.resultContract.mode === "text") {
            const dependencies = resolvedDependencyValues(envelope);
            if (envelope.task.taskId.startsWith("continue_")) {
              consultationEvidenceTransfers += dependencies.length;
            }
            return {
              schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
              status: "completed" as const,
              output: dependencies.length
                ? `Reconciled ${dependencies.length} accepted peer answer(s).`
                : `Evidence response from ${envelope.node.name}.`,
            };
          }
          const outputKey = envelope.resultContract.mode === "json"
            ? (envelope.resultContract.schema as { readonly required?: ReadonlyArray<string> }).required?.[0]
            : undefined;
          if (!outputKey) {
            throw new Error(`Coding simulation task ${envelope.task.taskId} has no JSON output key`);
          }
          const value = runtimeValue(
            envelope.task.taskId,
            envelope.task.capability,
            envelope.node.id,
          );
          return {
            schemaVersion: NODE_EXECUTION_SCHEMA_VERSION,
            status: "completed" as const,
            output: {
              [outputKey]: envelope.task.capability === "room"
                || envelope.task.capability === "remediate"
                || envelope.task.capability === "synthesize"
                ? JSON.parse(value) as JsonValue
                : value,
            },
          };
        } finally {
          activeRuntimes -= 1;
          runtimeCompletionOrder.push(envelope.task.taskId);
        }
      },
    });
    const runtimes = new NodeRuntimeRegistry([
      adapter("claude-code"),
      adapter("codex-cli"),
    ]);
    const createTaskContext: RosterPlatformExecutionOptions["createTaskContext"] = ({
      runId: taskRunId,
      node,
      definition,
      lease,
    }) => createRosterTaskContext({
      node,
      ledger: taskWorkspace,
      fence: {
        runId: taskRunId,
        taskId: definition.taskId,
        nodeId: definition.nodeId,
        fence: BigInt(lease.fence),
        runtimeBindingEpoch: definition.runtimeBindingEpoch,
        frontierVersion: definition.inputs.frontierVersion,
        topologyVersion: definition.inputs.topologyVersion,
        catalogVersion: definition.inputs.catalogVersion,
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
            throw new Error(`Coding simulation task ${definition.taskId} no longer owns its workspace fence`);
          }
        },
      },
    });
    const faultTaskId = input.injectFaults
      ? compiled.tasks.find((task) => task.capability === "implement")?.id
      : undefined;
    let faultTriggered = false;
    const crashingTaskGraph = faultTaskId
      ? new Proxy(taskGraph, {
          get(target, property, receiver) {
            if (property === "accept") {
              return async (accepted: Parameters<TaskGraphControl["accept"]>[0]) => {
                const outcome = await target.accept(accepted);
                if (!faultTriggered && accepted.lease.taskId === faultTaskId) {
                  faultTriggered = true;
                  throw new Error("simulated coordinator crash after durable acceptance");
                }
                return outcome;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as TaskGraphControl
      : taskGraph;
    const execute = (control: TaskGraphControl) => runCodingAgent({
      ...codingOptions,
      ...codingInput,
      nodeRuntimes: runtimes,
      taskGraph: control,
      dataReferences,
      createTaskContext,
      roomUpdates,
    });
    let execution: CodingAgentExecutionResult;
    if (faultTaskId) {
      try {
        await execute(crashingTaskGraph);
        throw new Error("Coding collaboration simulation fault was not exercised");
      } catch (error) {
        if (!faultTriggered) throw error;
      }
      execution = await execute(taskGraph);
    } else {
      execution = await execute(taskGraph);
    }
    if (execution.status !== "completed") {
      throw new Error(
        `${execution.completion.blocked ?? "Coding collaboration simulation did not complete"}; `
        + `accepted outputs: ${Object.keys(execution.outputs).sort().join(", ") || "none"}`,
      );
    }
    apply(taskGraphProjectedEvent(runId, execution.snapshot));
    for (const node of planNodes) {
      apply({ type: "node.retired", runId, nodeId: node.id, reason: "Simulation frontier settled" });
    }

    const durableUpdates: Uint8Array[] = [];
    let frontierVersion = "coding-peer-proposals-simulation-v1";
    let conflictsObserved = 0;
    let humanEscalations = 0;
    let certificationBlocks = 0;
    let ambiguityChecked = false;
    const publishCollaboration = (entry: {
      readonly outputKey: string;
      readonly value: string;
      readonly nodeId: string;
      readonly taskId: string;
    }): void => {
      const resolution = entry.outputKey === CODING_COLLABORATION_RESOLUTION_OUTPUT
        ? parseCodingPeerResolution(entry.value)
        : undefined;
      const priorProjection = resolution
        ? collaboration.project({ frontierVersion, topologyVersion: topologyEvent.topologyId })
        : undefined;
      if (resolution && priorProjection) {
        conflictsObserved = Math.max(conflictsObserved, priorProjection.conflicts.length);
        const coverage = codingResolutionCoverage(resolution, priorProjection.conflicts);
        if (coverage.missingSubjectIds.length) {
          throw new Error(`Coding simulation resolution omitted ${coverage.missingSubjectIds.join(", ")}`);
        }
        if (!ambiguityChecked) {
          ambiguityChecked = true;
          const ambiguousValue = ambiguousResolutionValue();
          const ambiguous = parseCodingPeerResolution(ambiguousValue);
          if (!ambiguous) throw new Error("Coding simulation produced an invalid ambiguity fixture");
          const unresolved = unresolvedCodingCollaborationConflicts(
            ambiguous,
            priorProjection.conflicts.flatMap((conflict) => conflict.candidateUpdateIds),
          );
          const blocked = evaluateCodingConsensus({
            [CODING_COLLABORATION_RESOLUTION_OUTPUT]: ambiguousValue,
          }, certificationKeys);
          const humanRoute = validateCodingConversationPlannerResult({
            disposition: "needs_clarification",
            selectedNodeIds: ["human.operator"],
            tags: ["intent:clarification"],
            questions: ["Should delivery remain in-session or use a signed URL?"],
            rationale: "Repository evidence cannot establish product intent.",
            confidence: 1,
          }, [...compiled.nodes, codingHumanWorkspaceNode()]);
          if (blocked.done || unresolved.length !== 1 || !humanRoute.selectedNodeIds.includes("human.operator")) {
            throw new Error("Coding simulation allowed an ambiguous frontier to bypass the human participant");
          }
          certificationBlocks += 1;
          humanEscalations += 1;
        }
        if (priorProjection.conflicts.length && resolution.status !== "ambiguous") {
          frontierVersion = `coding-peer-resolution-${hashCanonical({
            priorProjection: priorProjection.versionHash,
            resolution,
          }).slice(0, 24)}`;
        }
      }
      const contributions = codingCollaborationContributions({
        ...entry,
        ...(priorProjection ? { priorProjection } : {}),
      });
      if (!contributions.length) {
        throw new Error(`Coding simulation task ${entry.taskId} produced no collaboration entry`);
      }
      for (const contribution of contributions) {
        const published = collaboration.publish({
          runId,
          taskId: entry.taskId,
          nodeId: entry.nodeId,
          frontierVersion,
          topologyVersion: topologyEvent.topologyId,
          inputVersions: contribution.inputVersions,
          entry: contribution.entry,
        });
        durableUpdates.push(new Uint8Array(published.update));
      }
      if (resolution) {
        const projected = collaboration.project({ frontierVersion, topologyVersion: topologyEvent.topologyId });
        const unresolved = unresolvedCodingCollaborationConflicts(
          resolution,
          priorProjection?.conflicts.flatMap((conflict) => conflict.candidateUpdateIds) ?? [],
        );
        if (projected.conflicts.length || unresolved.length) {
          throw new Error("Coding simulation resolved frontier remains conflicted");
        }
      }
    };
    const tasksById = new Map(compiled.tasks.map((task) => [task.id, task]));
    for (const taskId of compiled.topologicalOrder) {
      const task = tasksById.get(taskId);
      if (!task) continue;
      for (const outputKey of task.provides) {
        const value = execution.outputs[outputKey];
        if (!value || !isCodingCollaborationOutputKey(outputKey)) continue;
        publishCollaboration({ outputKey, value, nodeId: task.nodeId, taskId });
      }
    }

  const finalProjection = collaboration.project({ frontierVersion, topologyVersion: topologyEvent.topologyId });
  replicaA = new SharedWorkspaceLedger(codingCollaborationArtifactId(runId));
  replicaB = new SharedWorkspaceLedger(codingCollaborationArtifactId(runId));
  const deliveriesA = shuffle(durableUpdates, input.entropy, "coding:replica-a");
  const deliveriesB = shuffle(durableUpdates, input.entropy, "coding:replica-b");
  for (const update of deliveriesA) replicaA.apply(update);
  for (const update of deliveriesB) replicaB.apply(update);
  const duplicateCount = Math.min(
    durableUpdates.length,
    Math.max(1, Math.floor(input.entropy.random("coding:duplicates") * 4)),
  );
  for (let index = 0; index < duplicateCount; index += 1) {
    const updateA = deliveriesA[index];
    const updateB = deliveriesB.at(-(index + 1));
    if (updateA) replicaA.apply(updateA);
    if (updateB) replicaB.apply(updateB);
  }
  const replicaProjectionA = replicaA.project({ frontierVersion, topologyVersion: topologyEvent.topologyId });
  const replicaProjectionB = replicaB.project({ frontierVersion, topologyVersion: topologyEvent.topologyId });
  const replicaConvergenceExact = hashCanonical(replicaProjectionA) === hashCanonical(replicaProjectionB)
    && hashCanonical(replicaProjectionA) === hashCanonical(finalProjection);
  const projectedTasks = state.taskGraph?.tasks ?? [];
  const graphProjectionExact = state.taskGraph?.projectionVersion
    === taskGraphProjectedEvent(runId, execution.snapshot).graph.projectionVersion
    && hashCanonical(projectedTasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      attempt: task.attempt,
    }))) === hashCanonical(execution.snapshot.tasks.map((task) => ({
      taskId: task.definition.taskId,
      status: task.status,
      attempt: task.attempt,
    })).sort((left, right) => left.taskId.localeCompare(right.taskId)));
  const consensus = evaluateCodingConsensus(execution.outputs, certificationKeys);
  const faultRecoveries = faultTriggered ? 1 : 0;
  const durableResumeExact = !faultTaskId
    || (
      faultTriggered
      && runtimeCalls.get(faultTaskId) === 1
      && taskGraphTask(execution.snapshot, faultTaskId)?.status === "accepted"
      && taskGraphTask(execution.snapshot, faultTaskId)?.attempt === 1
    );
  const routedResponseCount = compiled.tasks.filter((task) => task.capability === "respond").length;
  const selectedSpecialists = planNodes.filter((node) => node.metadata?.collaborationRole !== "temporary-resolver").length;
  const certificationFrontierTransportExact = compiled.tasks
    .filter((task) => task.capability === "certify")
    .every((task) =>
      task.objective.includes("final_report.frontierHash")
      && task.objective.includes("Do not run `git add`")
      && !task.objective.includes("Before returning, run `git add"));
  const announcementRecords = execution.snapshot.tasks.filter((record) =>
    record.definition.capability === "room");
  const announcementsExact = announcementRecords.length > 0
    && announcementRecords.every((record) => {
      const presentationText = record.outcome?.artifacts[0]?.presentationText;
      return record.status === "accepted"
        && record.attempt === 1
        && record.definition.result.mode === "json"
        && record.definition.result.outputKey.startsWith("room_announcement_")
        && typeof presentationText === "string"
        && presentationText.length >= 1
        && presentationText.length <= 420;
    });
  const compiledTaskIds = new Set(compiled.tasks.map((task) => task.id));
  const consultationExpansions = execution.snapshot.expansions.filter((expansion) =>
    expansion.expansionKey.startsWith("consult_"));
  const consultationTaskIds = new Set(consultationExpansions.flatMap((expansion) => [
    ...expansion.childTaskIds,
    expansion.continuationTaskId,
  ]));
  const consultationTaskCount = consultationTaskIds.size;
  const orchestrationTaskCount = execution.snapshot.tasks.filter((record) =>
    !compiledTaskIds.has(record.definition.taskId)
    && !consultationTaskIds.has(record.definition.taskId)).length;
  const materializedByParent = new Map<string, string>();
  for (const expansion of consultationExpansions) {
    for (const taskId of [...expansion.childTaskIds, expansion.continuationTaskId]) {
      materializedByParent.set(taskId, expansion.parentTaskId);
    }
  }
  const consultationDepth = (parentTaskId: string, seen = new Set<string>()): number => {
    if (seen.has(parentTaskId)) throw new Error("Consultation simulation contains a continuation cycle");
    const materializingParent = materializedByParent.get(parentTaskId);
    if (!materializingParent) return 1;
    seen.add(parentTaskId);
    return 1 + consultationDepth(materializingParent, seen);
  };
  const consultationMaxDepth = Math.max(
    0,
    ...consultationExpansions.map((expansion) => consultationDepth(expansion.parentTaskId)),
  );
  const expectedConsultationTurns = nestedConsultationRecipients.length > 0 ? 2 : 1;
  if (nestedConsultationRecipients.length > 0 && nestedConsultationAuthor) {
    const nestedExpansion = consultationExpansions.find((expansion) =>
      taskGraphTask(execution.snapshot, expansion.parentTaskId)?.definition.nodeId
        === nestedConsultationAuthor.id);
    const selectedNodeIds = nestedExpansion?.childTaskIds.map((taskId) =>
      taskGraphTask(execution.snapshot, taskId)?.definition.nodeId) ?? [];
    const expectedNodeId = nestedConsultationRecipients
      .map((node) => node.id)
      .sort((left, right) => left.localeCompare(right))[0];
    consultationAnySelectionExact = consultationAnySelectionExact
      && selectedNodeIds.length === 1
      && selectedNodeIds[0] === expectedNodeId;
  }
  const effectiveConsultationRoot = taskGraphEffectiveTask(
    execution.snapshot,
    consultationRootTask.id,
  );
  const consultationGraphExact = consultationExpansions.length === expectedConsultationTurns
    && taskGraphTask(execution.snapshot, consultationRootTask.id)?.status === "skipped"
    && effectiveConsultationRoot?.status === "accepted"
    && consultationTaskCount > expectedConsultationTurns
    && execution.snapshot.tasks.length <= platform.definition.policy.maxTasks;

  // Phase 1 agent-turn planner: prove reordered/duplicate turn delivery converges and one
  // bounded-path-exhaustion route escalates. This is a pure projection over the same synthetic
  // roster; it never executes or persists a task.
  const turnOriginatingTaskId = `${runId}-turns`;
  const turnDependencies: ReadonlyArray<CodingWorkspaceDependency> = planNodes.slice(0, -1).map((node, index) => ({
    nodeId: node.id,
    dependsOnNodeId: planNodes[index + 1]!.id,
    reason: "Synthetic collaboration chain for the entropy simulator.",
  }));
  const turnPolicy = clampCodingAgentTurnPolicy({ maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 4 });
  const turnQuestion = createCodingAgentTurn({
    kind: "question",
    authorNodeId: planNodes[0]!.id,
    recipients: [planNodes[1]!.id],
    subjectId: "entropy-turn-routing",
    originatingTaskId: turnOriginatingTaskId,
    responseRequirement: "any",
    body: "Should the entropy replay treat duplicate turns as idempotent?",
  });
  const turnAnswer = createCodingAgentTurn({
    kind: "answer",
    authorNodeId: planNodes[1]!.id,
    recipients: [planNodes[0]!.id],
    subjectId: "entropy-turn-routing",
    replyToTurnId: turnQuestion.turnId,
    originatingTaskId: turnOriginatingTaskId,
    responseRequirement: "none",
    body: "Yes, identical content converges on one settled obligation.",
  });
  const forwardTurnPlan: CodingAgentTurnPlan = planCodingAgentTurns({
    originatingTaskId: turnOriginatingTaskId,
    nodes: planNodes,
    dependencies: turnDependencies,
    policy: turnPolicy,
    turns: [turnQuestion, turnAnswer],
  });
  const reorderedTurns = shuffle(
    [turnAnswer, turnQuestion, turnAnswer, turnQuestion, turnAnswer],
    input.entropy,
    "coding:turn-delivery",
  );
  const reorderedTurnPlan: CodingAgentTurnPlan = planCodingAgentTurns({
    originatingTaskId: turnOriginatingTaskId,
    nodes: planNodes,
    dependencies: turnDependencies,
    policy: turnPolicy,
    turns: reorderedTurns,
  });
  const turnPlannerConvergenceExact = hashCanonical(forwardTurnPlan) === hashCanonical(reorderedTurnPlan)
    && forwardTurnPlan.unresolvedObligations.length === 0
    && Boolean(forwardTurnPlan.continuationId);

  const exhaustedTurnPolicy = clampCodingAgentTurnPolicy({ maxNodes: 8, maxTasks: 16, maxParallel: 4, maxDepth: 0 });
  const exhaustedTurn = createCodingAgentTurn({
    kind: "question",
    authorNodeId: planNodes[0]!.id,
    recipients: [planNodes[1]!.id],
    subjectId: "entropy-turn-exhaustion",
    originatingTaskId: turnOriginatingTaskId,
    responseRequirement: "any",
    body: "Bounded route exhaustion fixture: no follow-up round remains available.",
  });
  const exhaustedTurnPlan: CodingAgentTurnPlan = planCodingAgentTurns({
    originatingTaskId: turnOriginatingTaskId,
    nodes: planNodes,
    dependencies: turnDependencies,
    policy: exhaustedTurnPolicy,
    turns: [exhaustedTurn],
  });
  const turnPlannerEscalationExact = exhaustedTurnPlan.humanEscalation?.reason === "bounded-path-exhausted"
    && exhaustedTurnPlan.continuationId === undefined;

  const invariants: CodingSimulationInvariant[] = [
    {
      id: "bounded-dag",
      label: "Dynamic plan stays inside Coding bounds",
      passed: compiled.nodes.length <= 8
        && compiled.tasks.length <= 24
        && execution.snapshot.tasks.length <= platform.definition.policy.maxTasks
        && routedResponseCount < proposalTasks.length,
      evidence: `${compiled.nodes.length} nodes, ${compiled.tasks.length} planned / `
        + `${execution.snapshot.tasks.length} live tasks, ${routedResponseCount} routed responses`,
    },
    {
      id: "peer-topology",
      label: "Specialists remain peers",
      passed: planNodes.every((node) => node.parentId === undefined),
      evidence: `${planNodes.length} run nodes have no parent authority`,
    },
    {
      id: "authored-announcements",
      label: "Every substantive peer turn starts with one bounded model-authored update",
      passed: announcementsExact,
      evidence: `${announcementRecords.length} accepted one-attempt room announcement(s)`,
    },
    {
      id: "ambiguity-gate",
      label: "Ambiguity reaches the human before mutation",
      passed: conflictsObserved > 0 && humanEscalations === 1 && certificationBlocks === 1,
      evidence: `${conflictsObserved} semantic conflict, ${humanEscalations} human escalation`,
    },
    {
      id: "frontier-certification",
      label: "Only a conflict-free exact frontier certifies",
      passed: consensus.done && finalProjection.conflicts.length === 0 && finalProjection.staleUpdateIds.length > 0,
      evidence: `${finalProjection.acceptedUpdateIds.length} accepted, ${finalProjection.staleUpdateIds.length} stale updates`,
    },
    {
      id: "frontier-transport",
      label: "Read-only certifiers consume frontier identity without sharing a Git index",
      passed: certificationFrontierTransportExact,
      evidence: `${certificationKeys.length} certification task(s) bind to final_report.frontierHash`,
    },
    {
      id: "runtime-recovery",
      label: "Durably accepted work survives coordinator recovery",
      passed: input.injectFaults ? faultRecoveries === 1 && durableResumeExact : faultRecoveries === 0,
      evidence: `${faultRecoveries} recovered coordinator fault; accepted task executed once`,
    },
    {
      id: "convergent-replay",
      label: "Graph projection and duplicate CRDT delivery converge",
      passed: graphProjectionExact && replicaConvergenceExact,
      evidence: `${execution.snapshot.tasks.length} projected tasks, ${duplicateCount * 2} duplicate deliveries`,
    },
    {
      id: "turn-planner-entropy",
      label: "Reordered/duplicated agent-turn delivery converges and one exhausted route escalates",
      passed: turnPlannerConvergenceExact && turnPlannerEscalationExact,
      evidence: `${forwardTurnPlan.settledObligations.length} settled obligation(s), continuation `
        + `${forwardTurnPlan.continuationId ? "present" : "absent"}, exhausted escalation `
        + `${exhaustedTurnPlan.humanEscalation?.reason ?? "none"}`,
    },
    {
      id: "emergent-consultation",
      label: "Dynamic peer discussions stay replay-exact and schedule-independent",
      passed: consultationGraphExact
        && consultationReplayExact
        && consultationAnySelectionExact
        && consultationEvidenceTransfers > 0,
      evidence: `${consultationExpansions.length} emergent turn(s), depth ${consultationMaxDepth}, `
        + `${consultationTaskCount} materialized tasks, ${consultationEvidenceTransfers} accepted answer transfer(s)`,
    },
  ];
  if (invariants.some((invariant) => !invariant.passed)) {
    throw new Error(`Coding collaboration simulation invariant failed: ${invariants.filter((item) => !item.passed).map((item) => item.id).join(", ")}`);
  }

  const semanticDigest = hashCanonical({
    executionStatus: execution.status,
    acceptedTasks: execution.snapshot.tasks
      .filter((task) => task.status === "accepted")
      .map((task) => task.definition.taskId)
      .sort(),
    outputs: execution.outputs,
    workspace: finalProjection,
    selectedSpecialists,
    routedResponseCount,
    conflictsObserved,
    humanEscalations,
    certificationBlocks,
    faultRecoveries,
    durableResumeExact,
    graphProjectionExact,
    certificationFrontierTransportExact,
    turnPlannerConvergenceExact,
    turnPlannerEscalationExact,
    turnPlannerContinuationId: forwardTurnPlan.continuationId,
    consultationTurns: consultationExpansions.length,
    consultationInvocations,
    consultationTaskCount,
    consultationMaxDepth,
    consultationReplayExact,
    consultationAnySelectionExact,
    consultationEvidenceTransfers,
    consultationRootOutcomeTaskId: effectiveConsultationRoot?.definition.taskId,
  });
  return {
    state,
    execution,
    records,
    completionOrder: runtimeCompletionOrder,
    transitionOrder: runtimeCompletionOrder.map((taskId, index) => ({
      index,
      batch: index,
      taskId,
      phase: "runtime.completed",
    })),
    peakParallel,
    faultRecoveries,
    graphExpansions: execution.snapshot.expansions.length,
    semanticDigest,
    details: {
      requestedSpecialists: input.agents,
      selectedSpecialists,
      taskCount: execution.snapshot.tasks.length,
      routedResponseCount,
      conflictsObserved,
      humanEscalations,
      certificationBlocks,
      staleUpdates: finalProjection.staleUpdateIds.length,
      duplicateDeliveries: duplicateCount * 2,
      durableResumeExact,
      graphProjectionExact,
      replicaConvergenceExact,
      turnPlannerConvergenceExact,
      turnPlannerEscalationExact,
      consultationTurns: consultationExpansions.length,
      consultationInvocations,
      consultationTaskCount,
      consultationMaxDepth,
      consultationReplayExact,
      consultationAnySelectionExact,
      consultationEvidenceTransfers,
      invariants,
    },
    stages: [
      ...stageReports(compiled.topologicalOrder, compiled.tasks),
      ...(orchestrationTaskCount > 0
        ? [{ id: "control", label: "Roster graph control", tasks: orchestrationTaskCount }]
        : []),
      ...(consultationTaskCount > 0
        ? [{ id: "consultation", label: "Emergent peer consultation", tasks: consultationTaskCount }]
        : []),
    ],
    taskGraph: execution.snapshot.tasks.map((record) => {
      const task = record.definition;
      return {
        taskId: task.taskId,
        nodeId: task.nodeId,
        capability: task.capability,
        outputKey: task.result.mode === "none" ? "" : task.result.outputKey,
        dependencyTaskIds: task.dependencies.map((dependency) => dependency.taskId),
        status: record.status,
        attempt: record.attempt,
      };
    }).sort((left, right) => left.taskId.localeCompare(right.taskId)),
    expansions: consultationExpansions.map((expansion) => ({
      parentTaskId: expansion.parentTaskId,
      expansionKey: expansion.expansionKey,
      expansionHash: expansion.expansionHash,
      childTaskIds: [...expansion.childTaskIds],
      continuationTaskId: expansion.continuationTaskId,
    })),
  };
  } finally {
    replicaA?.destroy();
    replicaB?.destroy();
    taskWorkspace.destroy();
    collaboration.destroy();
  }
};
