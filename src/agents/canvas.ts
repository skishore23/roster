import { hashCanonical, sha256 } from "../core/canonical.js";
import type { Runtime } from "../core/runtime.js";
import { DEFAULT_OPENAI_MODEL } from "../models.js";
import {
  canvasPainterParts,
  deriveCanvasNodeDemands,
  materializeCanvasNode,
  validateCanvasScene,
  canvasAdaptiveDomain,
  canonicalCanvasScene,
  sceneHash,
  type CanvasNodeRole,
  type CanvasNodeSpec,
} from "../domains/canvas.js";
import { reflectOnOrchestration } from "../engine/orchestration/adaptive.js";
import {
  createDistributedControlProposal,
  type DistributedControlEndorsement,
  type DistributedControlPayload,
} from "../engine/orchestration/distributed-control.js";
import { reconcileDistributedControl } from "../engine/orchestration/distributed-control-runtime.js";
import { DistributedControlSession } from "../engine/orchestration/distributed-session.js";
import {
  createValidationCouncilProjector,
  createValidationReportUpdate,
  ValidationCouncilLedger,
  type ValidationReport,
} from "../engine/orchestration/validation-council.js";
import {
  certifyComposition,
  createCompositionProposal,
} from "../engine/orchestration/composition.js";
import {
  balancedCompositionTree,
  compositionBracket,
  compositionLeaves,
} from "../engine/orchestration/topology.js";
import type { NodeRuntimeRegistry } from "../engine/runtime/node-runtime.js";
import {
  classifyModelFailure,
  type ModelFailureClass,
} from "../engine/runtime/model-escalation.js";
import { createQueuedEmitter } from "../engine/runtime/workflow.js";
import {
  CanvasSceneLedger,
  canvasPatchContentHash,
  normalizeCanvasPatch,
} from "../engine/visual/scene.js";
import type { JsonValue, WorkspaceNodeRuntime } from "../engine/orchestration/types.js";
import type { RunExecutionPolicy } from "../engine/platform/protocol.js";
import type { CanvasCmd, CanvasEvent, CanvasModelRouting, CanvasReview, CanvasState } from "../modules/canvas.js";
import { CANVAS_MAX_PAINTERS, CANVAS_MIN_PAINTERS } from "../modules/canvas.js";
import {
  compositionCertifiedEvent,
  compositionProposedEvent,
  inlineArtifactPublishedEvent,
  orchestrationConfiguredEvent,
  reflectionRecordedEvent,
  taskGraphProjectedEvent,
  topologySelectedEvent,
} from "../modules/orchestration.js";
import { canvasRunStream } from "./canvas.streams.js";
import {
  canvasVisualCompletionGate,
  canvasVisualQualityGate,
  type CanvasModel,
  type CanvasValidationSpecialty,
  type CanvasVisualCritique,
} from "./canvas.model.js";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createAcceptedTaskOutcome,
  createDefaultDynamicTaskAcceptanceRegistry,
  createDynamicTaskDefinition,
} from "../engine/orchestration/task-graph.js";
import {
  taskGraphTask,
} from "../engine/orchestration/task-graph-control.js";
import {
  defineRosterPlatform,
  ROSTER_EXPAND_FUNCTION_ID,
  type RosterPlatformExecutionOptions,
} from "../engine/platform/roster-platform.js";

export const CANVAS_WORKFLOW_ID = "canvas-illustration";
export const CANVAS_WORKFLOW_VERSION = "4.4";
export const CANVAS_MAX_DECISION_FRONTIERS = 6;
// This task supervises a bounded graph of independently leased model/repair
// tasks. A wall-clock deadline here can expire while a healthy child is still
// settling, so child provider timeouts, task leases, frontier count, and run
// budget are the authoritative bounds.
export const CANVAS_DELIBERATION_TIMEOUT_MS = 0;

const CANVAS_VALIDATORS: ReadonlyArray<{
  readonly role: CanvasNodeRole;
  readonly specialty: CanvasValidationSpecialty;
}> = [
  {
    role: "validator-semantic",
    specialty: {
      id: "semantic",
      label: "Subject and prompt validator",
      instructions: "Concentrate on literal prompt match, subject identity, requested counts, requested relationships, and thumbnail recognizability. Report missing or incorrect content even when the image is attractive.",
      modelTier: "critic",
    },
  },
  {
    role: "validator-composition",
    specialty: {
      id: "composition",
      label: "Composition validator",
      instructions: "Concentrate on focal hierarchy, balance, scale, negative space, occlusion, and whether independently owned parts read as one composition.",
      modelTier: "finisher",
    },
  },
  {
    role: "validator-consistency",
    specialty: {
      id: "consistency",
      label: "Consistency and finish validator",
      instructions: "Concentrate on cross-part seams, alignment, line weight, lighting direction, palette agreement, repeated-form consistency, detail density, and unresolved finishing artifacts. Make minor findings actionable.",
      modelTier: "finisher",
    },
  },
];

export const CANVAS_REPAIR_PART_BUDGET = Object.freeze({
  first: 3,
  final: 2,
  rescue: 1,
} as const);

export type CanvasRepairRound = keyof typeof CANVAS_REPAIR_PART_BUDGET;

export const selectCanvasRepairScope = (
  critique: CanvasVisualCritique,
  round: CanvasRepairRound
): {
  readonly critique: CanvasVisualCritique;
  readonly partIds: ReadonlyArray<string>;
  readonly deferredPartCount: number;
} => {
  const majorIssues = critique.issues.filter((issue) => issue.severity === "major");
  const relevantIssues = round !== "first" && majorIssues.length > 0
    ? majorIssues
    : [...critique.issues];
  const prioritizedIssues = [...relevantIssues].sort((left, right) =>
    Number(right.severity === "major") - Number(left.severity === "major")
  );
  const allPartIds = [...new Set(prioritizedIssues.map((issue) => issue.partId))];
  const partIds = allPartIds.slice(0, CANVAS_REPAIR_PART_BUDGET[round]);
  const partIdSet = new Set(partIds);
  return {
    critique: {
      ...critique,
      issues: prioritizedIssues.filter((issue) => partIdSet.has(issue.partId)),
    },
    partIds,
    deferredPartCount: allPartIds.length - partIds.length,
  };
};

export type CanvasRunConfig = {
  readonly maxParallel: number;
  readonly staggerMs: number;
};

export type CanvasExecutionPlane = Pick<
  RosterPlatformExecutionOptions,
  "taskGraph" | "dataReferences" | "createTaskContext"
> & {
  /** Required when attaching to a graph execution whose policy already exists. */
  readonly policy?: RunExecutionPolicy;
};

export const CANVAS_DEFAULT_CONFIG: CanvasRunConfig = {
  maxParallel: 5,
  staggerMs: 360,
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
};

export const normalizeCanvasConfig = (input: Partial<CanvasRunConfig> = {}): CanvasRunConfig => ({
  // This UI field is the exact painter population as well as the painter-frontier concurrency.
  maxParallel: clampInteger(
    input.maxParallel,
    CANVAS_DEFAULT_CONFIG.maxParallel,
    CANVAS_MIN_PAINTERS,
    CANVAS_MAX_PAINTERS
  ),
  staggerMs: clampInteger(input.staggerMs, CANVAS_DEFAULT_CONFIG.staggerMs, 0, 2_000),
});

export type CanvasRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream?: string;
  readonly prompt: string;
  readonly config?: Partial<CanvasRunConfig>;
  readonly runtime: Runtime<CanvasCmd, CanvasEvent, CanvasState>;
  readonly canvasModel: CanvasModel;
  readonly models?: CanvasModelRouting;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady?: boolean;
  readonly apiNote?: string;
  /** Explicit graph, value, and task-fenced workspace authority. */
  readonly executionPlane: CanvasExecutionPlane;
  readonly nodeRuntimes?: NodeRuntimeRegistry;
  /** Resolve a replaceable agent runtime for each newly materialized specialist. */
  readonly runtimeForDemand?: (
    demand: Parameters<typeof materializeCanvasNode>[0]["demand"],
  ) => WorkspaceNodeRuntime | undefined;
  readonly now?: () => number;
  readonly broadcast?: (event: CanvasEvent) => void | Promise<void>;
};

export type CanvasRunResult = {
  readonly runId: string;
  readonly stream: string;
  readonly runStream: string;
  readonly status: CanvasState["status"];
  readonly sceneHash?: string;
  readonly objectCount: number;
  readonly failureClass?: ModelFailureClass;
  readonly failureMessage?: string;
  readonly retryable?: boolean;
};

const painterDelayMultiplier = (index: number): number => .55 + (index % 4) * .22;

export const shouldAcceptCanvasVisualCandidate = (
  before: CanvasVisualCritique,
  after: CanvasVisualCritique
): boolean => {
  const beforeGate = canvasVisualQualityGate(before);
  const afterGate = canvasVisualQualityGate(after);
  if (afterGate.pass) return true;
  if (afterGate.majorIssueCount > beforeGate.majorIssueCount) return false;
  if (afterGate.mean < beforeGate.mean - .5) return false;
  const scoreNames = Object.keys(before.scores) as ReadonlyArray<keyof CanvasVisualCritique["scores"]>;
  if (scoreNames.some((name) => after.scores[name] < before.scores[name] - 6)) return false;
  const beforeBlocking = beforeGate.majorIssueCount + beforeGate.failedDimensions.length;
  const afterBlocking = afterGate.majorIssueCount + afterGate.failedDimensions.length;
  if (afterBlocking < beforeBlocking) return true;
  if (afterBlocking > beforeBlocking) return false;
  const beforeMinor = before.issues.filter((issue) => issue.severity === "minor").length;
  const afterMinor = after.issues.filter((issue) => issue.severity === "minor").length;
  return afterGate.mean >= beforeGate.mean + 1
    || (afterMinor < beforeMinor && afterGate.mean >= beforeGate.mean - 1);
};

const waitFor = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (ms <= 0) {
    resolve();
    return;
  }
  const timer = setTimeout(resolve, ms);
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Canvas task aborted"));
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
});

export const publicCanvasFailureMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const failureClass = classifyModelFailure(error);
  if (/OPENAI_API_KEY not set/i.test(message)) return "OPENAI_API_KEY not set";
  if (failureClass === "authentication" || failureClass === "authorization") {
    return "Model provider authentication failed. Check the server-side Canvas credentials.";
  }
  if (failureClass === "budget") {
    return "The model provider quota or billing limit is exhausted. Update the server-side account limit before starting a new run.";
  }
  if (failureClass === "rate-limit") {
    return "The model provider is rate-limiting the studio. This run can be retried safely.";
  }
  if (failureClass === "timeout") {
    return "A model call timed out before the scene frontier could be completed.";
  }
  if (/structured canvas generation failed|structured output|zod|model escalation policy .* exhausted/i.test(message)) {
    const safeDomainDetail = message.match(
      /exhausted after [^:]+:\s*((?:Canvas|Art Director|Composition scaffold|Anchor|Visual brief|Planned subject|Art direction)[\s\S]*)$/i
    )?.[1]
      ?.replace(/\s+/g, " ")
      .slice(0, 280);
    return safeDomainDetail
      ? `The artist model did not return valid structured artwork after the bounded correction pass. Last contract issue: ${safeDomainDetail}`
      : "The artist model did not return valid structured artwork after the bounded correction pass.";
  }
  return message
    .replace(/https?:\/\/\S+/g, "[link removed]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[credential removed]")
    .slice(0, 500);
};

export const runCanvasRoster = async (input: CanvasRunInput): Promise<CanvasRunResult> => {
  const runStream = input.runStream ?? canvasRunStream(input.stream, input.runId);
  const persistedState = await input.runtime.state(runStream);
  const resuming = persistedState.runId === input.runId;
  if (resuming && persistedState.status === "completed") {
    return {
      runId: input.runId,
      stream: input.stream,
      runStream,
      status: "completed",
      sceneHash: persistedState.final?.sceneHash,
      objectCount: persistedState.final?.objectCount ?? Object.keys(persistedState.objects).length,
    };
  }

  const config = resuming && persistedState.config
    ? {
        maxParallel: persistedState.config.maxParallel,
        staggerMs: persistedState.config.staggerMs,
      }
    : normalizeCanvasConfig(input.config);
  const prompt = (resuming ? persistedState.prompt : input.prompt).trim()
    || "Draw a tiny red bicycle leaning beside a moonlit lighthouse";
  const boundModels = input.canvasModel.routing;
  const suppliedModels = input.models;
  const configuredModels = resuming ? persistedState.config?.models : undefined;
  const expectedModels = configuredModels ?? suppliedModels;
  const routingMismatch = Boolean(boundModels && expectedModels && (
    boundModels.director !== expectedModels.director
    || boundModels.painter !== expectedModels.painter
    || boundModels.critic !== expectedModels.critic
    || boundModels.finisher !== expectedModels.finisher
    || boundModels.finisherEscalation !== expectedModels.finisherEscalation
  ));
  const models = configuredModels ?? boundModels ?? suppliedModels ?? {
    director: DEFAULT_OPENAI_MODEL,
    painter: DEFAULT_OPENAI_MODEL,
    critic: DEFAULT_OPENAI_MODEL,
    finisher: DEFAULT_OPENAI_MODEL,
    finisherEscalation: DEFAULT_OPENAI_MODEL,
  };
  const emit = createQueuedEmitter<CanvasCmd, CanvasEvent, CanvasState>({
    runtime: input.runtime,
    stream: runStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId }),
    onEmit: input.broadcast,
  });
  const ledger = new CanvasSceneLedger();
  const critiqueCache = new Map<string, CanvasVisualCritique>();
  const projectedPatchIds = new Set(Object.keys(persistedState.patches));
  const projectAcceptedPatch = async (
    patchInput: Parameters<typeof normalizeCanvasPatch>[0],
    origin: unknown,
    agentId: string,
  ): Promise<void> => {
    const patch = normalizeCanvasPatch(patchInput);
    if (projectedPatchIds.has(patch.patchId)) return;
    const current = await input.runtime.state(runStream);
    const persisted = current.patches[patch.patchId];
    if (persisted) {
      const { updatedAt: _updatedAt, ...persistedPatch } = persisted;
      if (canvasPatchContentHash(persistedPatch) !== canvasPatchContentHash(patch)) {
        throw new Error(`Canvas patch ${patch.patchId} changed after accepted projection`);
      }
      ledger.add(patch, origin);
      projectedPatchIds.add(patch.patchId);
      return;
    }
    const update = ledger.add(patch, origin);
    await emit({
      type: "scene.patch.applied",
      runId: input.runId,
      agentId,
      patch,
      updateHash: hashCanonical([...update]),
    });
    projectedPatchIds.add(patch.patchId);
  };

  try {
    if (!resuming) {
      await emit({ type: "prompt.set", runId: input.runId, prompt, agentId: "orchestrator" });
    }
    if (routingMismatch) {
      throw new Error("Canvas model routing does not match the routing bound to the model implementation");
    }
    if (!persistedState.config) {
      await emit({
        type: "run.configured",
        runId: input.runId,
        agentId: "orchestrator",
        models,
        promptHash: input.promptHash,
        promptPath: input.promptPath,
        config,
        workflow: { id: CANVAS_WORKFLOW_ID, version: CANVAS_WORKFLOW_VERSION },
      });
    }

    if (resuming) {
      const patches = Object.values(persistedState.patches).sort((left, right) =>
        left.updatedAt - right.updatedAt || left.patchId.localeCompare(right.patchId)
      );
      for (const { updatedAt: _updatedAt, ...patch } of patches) {
        ledger.add(patch, "resume");
      }
    }

    if (input.apiReady === false) throw new Error(input.apiNote ?? "OPENAI_API_KEY not set");
    let scenePlan = persistedState.plan;
    if (!scenePlan) {
      await emit({
        type: "run.status",
        runId: input.runId,
        agentId: "orchestrator",
        status: "planning",
        note: "The Art Director is interpreting the brief and designing the artist team.",
      });
      scenePlan = await input.canvasModel.plan({
        prompt,
        painterCount: config.maxParallel,
        runId: input.runId,
        taskId: "__canvas_coordinator__",
      });
    }
    const painterParts = canvasPainterParts(scenePlan);
    const painterRoles = painterParts.map((part) => part.role);
    const demands = deriveCanvasNodeDemands(scenePlan);
    const domain = canvasAdaptiveDomain(config.maxParallel, demands);
    if (!persistedState.orchestration.domain) {
      await emit(orchestrationConfiguredEvent(input.runId, domain.pack));
    }
    if (!persistedState.plan) {
      await emit({ type: "scene.planned", runId: input.runId, agentId: "orchestrator", plan: scenePlan });
    }

    const setupState = await input.runtime.state(runStream);
    const replayedInitialReflection = setupState.orchestration.reflections.find((reflection) =>
      reflection.policyId === "canvas-population" && reflection.iteration === 1
    );
    const initialReflection = replayedInitialReflection ?? reflectOnOrchestration({
        runId: input.runId,
        policyId: "canvas-population",
        policyVersion: domain.pack.policyVersion,
        iteration: 1,
        observation: {
          activeNodes: 1,
          pendingTasks: demands.length,
          runningTasks: 0,
          failedTasks: 0,
          conflicts: 0,
          evidenceGaps: 0,
          stagnationRounds: 0,
          goalSatisfied: false,
          note: "The visual brief has been decomposed into semantic scene responsibilities.",
        },
        maxNodes: domain.pack.limits.maxNodes,
        unmetDemands: demands,
      });
    if (!replayedInitialReflection) {
      await emit(reflectionRecordedEvent(input.runId, initialReflection));
    }

    const spawned: CanvasNodeSpec[] = [];
    for (const [index, action] of initialReflection.actions.entries()) {
      if (action.type !== "spawn") continue;
      const demand = demands.find((candidate) => candidate.capability === action.demand.capability);
      if (!demand) continue;
      const persistedAgent = Object.values(setupState.orchestration.nodes).find((candidate) =>
        candidate.status === "active"
        && candidate.id !== domain.pack.coordinatorId
        && candidate.capabilities.includes(demand.capability)
      );
      if (persistedAgent) {
        const { status: _status, updatedAt: _updatedAt, ...agent } = persistedAgent;
        spawned.push({
          ...agent,
          role: demand.role,
          focus: demand.focus ?? demand.objective,
        });
        continue;
      }
      const agent = materializeCanvasNode({
        runId: input.runId,
        reflectionId: initialReflection.reflectionId,
        index,
        demand,
        runtime: input.runtimeForDemand?.(demand),
      });
      spawned.push(agent);
      await emit({ type: "node.spawned", runId: input.runId, node: agent, reason: initialReflection.reason });
    }
    const registry = domain.registry.extendNodes(spawned);
    const topology = balancedCompositionTree(painterRoles);
    if (!setupState.orchestration.topologyId) {
      await emit(topologySelectedEvent({
        runId: input.runId,
        operation: "initialize",
        bracket: compositionBracket(topology),
        leaves: compositionLeaves(topology),
        reason: "Semantic canvas parts form the initial composition frontier.",
      }));
    }
    if (!setupState.orchestration.outputs.prompt) {
      await emit(inlineArtifactPublishedEvent({
        runId: input.runId,
        artifactId: `canvas-prompt-${hashCanonical(prompt).slice(0, 20)}`,
        origin: "input",
        outputKey: "prompt",
        nodeId: "orchestrator",
        kind: "canvas.prompt",
        inputVersions: {},
      }, prompt));
    }
    if (!setupState.orchestration.outputs["composition.scaffold"]) {
      await emit(inlineArtifactPublishedEvent({
        runId: input.runId,
        artifactId: scenePlan.compositionScaffold.scaffoldVersion,
        sharedArtifactId: `${input.runId}:composition.scaffold`,
        origin: "input",
        outputKey: "composition.scaffold",
        nodeId: "orchestrator",
        kind: "canvas.composition-scaffold",
        frontierVersion: scenePlan.compositionScaffold.scaffoldVersion,
        topologyVersion: setupState.orchestration.topologyId ?? `plan:${scenePlan.planVersion}`,
        inputVersions: { prompt: hashCanonical(prompt), plan: scenePlan.planVersion },
      }, JSON.stringify(scenePlan.compositionScaffold)));
    }
    if (!resuming || persistedState.status !== "running") {
      await emit({
        type: "run.status",
        runId: input.runId,
        agentId: "orchestrator",
        status: "running",
        note: resuming
          ? `${painterParts.length} specialist artists resumed from the persisted scene frontier.`
          : `${painterParts.length} specialist artists started together from the shared scene plan.`,
      });
    }

    const agentForRole = (role: CanvasNodeRole): CanvasNodeSpec => {
      const found = spawned.find((candidate) => candidate.role === role);
      if (!found) throw new Error(`Canvas population is missing ${role}`);
      return found;
    };

    const validationAgents = CANVAS_VALIDATORS.map((validator) => ({
      ...validator,
      agent: agentForRole(validator.role),
    }));
    const leadValidator = validationAgents[0]!.agent;
    const graphDepthLimit =
      input.executionPlane.policy?.maxDepth ?? CANVAS_MAX_DECISION_FRONTIERS;

    const reviewRenderedProjection = async (round: number) => {
      const projection = ledger.project();
      const structuralReview = validateCanvasScene(scenePlan, projection.objects, projection.conflicts);
      const currentHash = sceneHash(projection.objects);
      for (const validator of validationAgents) {
        await emit({
          type: "run.status",
          runId: input.runId,
          agentId: validator.agent.id,
          status: "reviewing",
          note: `${validator.agent.name} is independently inspecting distributed frontier ${round} for ${validator.specialty.id}.`,
        });
      }
      if (structuralReview.verdict !== "pass") {
        await emit({
          type: "scene.reviewed",
          runId: input.runId,
          agentId: leadValidator.id,
          review: structuralReview,
          sceneHash: currentHash,
        });
        throw new Error(structuralReview.notes.join("; ") || "Structural validation failed");
      }
      let visualCritique = critiqueCache.get(currentHash);
      if (!visualCritique) {
        const activeValidators = input.canvasModel.validationCouncil
          ? validationAgents
          : [validationAgents[0]!];
        const critiques = await Promise.all(activeValidators.map(async (validator) => ({
          validator,
          critique: await input.canvasModel.critique({
            prompt,
            plan: scenePlan,
            objects: projection.objects,
            runId: input.runId,
            taskId: "deliberate.scene",
            specialty: input.canvasModel.validationCouncil ? validator.specialty : undefined,
          }),
        })));
        const scoreKeysFor = (specialty: CanvasValidationSpecialty["id"]): ReadonlyArray<keyof CanvasVisualCritique["scores"]> => (
          specialty === "semantic" ? ["promptMatch", "recognizability"]
            : specialty === "composition" ? ["composition", "coherence"]
              : ["polish"]
        );
        const structuralReport: ValidationReport = {
          reportId: `structural-${currentHash}`,
          validatorId: "canvas-structural-projector",
          validatorRole: "structural",
          validatorKind: "deterministic",
          frontierVersion: `scene:${currentHash}`,
          artifactHash: currentHash,
          verdict: "pass",
          scores: {},
          findings: [],
          evidenceRefs: [currentHash],
          summary: structuralReview.checks.join("; "),
        };
        const modelReports: ValidationReport[] = critiques.map(({ validator, critique }) => ({
          reportId: `${validator.specialty.id}-${currentHash}`,
          validatorId: validator.agent.id,
          validatorRole: validator.specialty.id,
          validatorKind: "model",
          frontierVersion: `scene:${currentHash}`,
          artifactHash: currentHash,
          verdict: critique.verdict === "pass" ? "pass" : "repair",
          scores: Object.fromEntries(scoreKeysFor(validator.specialty.id).map((key) => [key, critique.scores[key]])),
          findings: critique.issues.map((issue) => ({
            dimension: validator.specialty.id,
            severity: issue.severity,
            subjectId: issue.partId,
            problem: issue.problem,
            repairInstruction: issue.repairInstruction,
          })),
          evidenceRefs: [currentHash],
          summary: critique.summary,
        }));
        const councilPolicy = {
            requiredRoles: input.canvasModel.validationCouncil
              ? ["structural", "semantic", "composition", "consistency"]
              : ["structural", "semantic"],
            minimumPassingReports: input.canvasModel.validationCouncil ? 4 : 2,
            scoreFloors: {
              promptMatch: 70,
              recognizability: 70,
              composition: 65,
              coherence: 60,
              polish: 55,
            },
            polishOnActionableMinor: true,
          } as const;
        const validationLedger = new ValidationCouncilLedger();
        const validationArtifactId = `${input.runId}:validation:${currentHash}`;
        const validationFrontier = `scene:${currentHash}`;
        const validationTopology = setupState.orchestration.topologyId ?? `plan:${scenePlan.planVersion}`;
        try {
          for (const report of [structuralReport, ...modelReports]) {
            validationLedger.add(createValidationReportUpdate({
              artifactId: validationArtifactId,
              runId: input.runId,
              taskId: "deliberate.scene",
              frontierVersion: validationFrontier,
              topologyVersion: validationTopology,
              report,
            }));
          }
          const projectedCouncil = validationLedger.project(
            validationArtifactId,
            { frontierVersion: validationFrontier, topologyVersion: validationTopology },
            createValidationCouncilProjector({ artifactHash: currentHash, policy: councilPolicy }),
          );
          const council = projectedCouncil.value;
        const critiqueFor = (specialty: CanvasValidationSpecialty["id"]): CanvasVisualCritique => (
          critiques.find((candidate) => candidate.validator.specialty.id === specialty)?.critique
            ?? critiques[0]!.critique
        );
        const semantic = critiqueFor("semantic");
        const composition = critiqueFor("composition");
        const consistency = critiqueFor("consistency");
        const issueKeys = new Set<string>();
        const issues = critiques.flatMap(({ critique }) => critique.issues).filter((issue) => {
          const key = `${issue.partId}:${issue.problem}:${issue.repairInstruction}`;
          if (issueKeys.has(key)) return false;
          issueKeys.add(key);
          return true;
        });
        visualCritique = {
          verdict: council.decision === "certify" ? "pass" : "repair",
          summary: `${council.reason}. ${critiques.map(({ validator, critique }) => `${validator.specialty.label}: ${critique.summary}`).join(" ")}`.slice(0, 500),
          scores: {
            promptMatch: semantic.scores.promptMatch,
            recognizability: semantic.scores.recognizability,
            composition: composition.scores.composition,
            coherence: composition.scores.coherence,
            polish: consistency.scores.polish,
          },
          issues,
        };
        for (const { validator, critique } of critiques) {
          await emit({
            type: "scene.reviewed",
            runId: input.runId,
            agentId: validator.agent.id,
            review: {
              verdict: critique.verdict === "pass" ? "pass" : "fail",
              scope: `validator-${validator.specialty.id}`,
              scores: critique.scores,
              checks: [`${validator.specialty.label}: ${critique.summary}`],
              notes: critique.issues.map((issue) => `[${issue.severity}] ${issue.partId}: ${issue.problem}`),
            },
            sceneHash: currentHash,
          });
        }
        critiqueCache.set(currentHash, visualCritique);
        } finally {
          validationLedger.destroy();
        }
      }
      const scoreSummary = Object.entries(visualCritique.scores)
        .map(([name, score]) => `${name} ${score}/100`)
        .join(", ");
      const review = {
        verdict: visualCritique.verdict === "pass" ? "pass" as const : "fail" as const,
        qualityStatus: visualCritique.verdict === "pass" ? "certified" as const : undefined,
        scope: "rendered-visual" as const,
        scores: visualCritique.scores,
        checks: [
          ...structuralReview.checks,
          `Validation council frontier ${round}: ${scoreSummary}`,
          visualCritique.summary,
        ],
        notes: [
          ...structuralReview.notes,
          ...visualCritique.issues.map((issue) =>
            `[${issue.severity}] ${issue.partId}: ${issue.problem} Repair: ${issue.repairInstruction}`
          ),
        ],
      };
      await emit({
        type: "scene.reviewed",
        runId: input.runId,
        agentId: leadValidator.id,
        review,
        sceneHash: currentHash,
      });
      return { projection, currentHash, review, visualCritique };
    };

    const acceptVisualFrontierWithNotes = async (
      review: CanvasReview,
      visualCritique: CanvasVisualCritique
    ): Promise<{ readonly review: CanvasReview; readonly visualCritique: CanvasVisualCritique }> => {
      const completion = canvasVisualCompletionGate(visualCritique);
      if (!completion.pass) {
        throw new Error(
          `The rendered image is not usable enough to complete (prompt ${visualCritique.scores.promptMatch}, recognizability ${visualCritique.scores.recognizability}, mean ${completion.mean.toFixed(1)})`
        );
      }
      const projection = ledger.project();
      const currentHash = sceneHash(projection.objects);
      const acceptedReview: CanvasReview = {
        ...review,
        verdict: "pass",
        qualityStatus: "accepted-with-notes",
        checks: [
          ...review.checks,
          "The scene remained recognizable and structurally valid after the bounded finishing budget; remaining visual issues are recorded as non-blocking notes.",
        ],
      };
      const acceptedCritique: CanvasVisualCritique = { ...visualCritique, verdict: "pass" };
      await emit({
        type: "scene.reviewed",
        runId: input.runId,
        agentId: leadValidator.id,
        review: acceptedReview,
        sceneHash: currentHash,
      });
      await emit({
        type: "run.status",
        runId: input.runId,
        agentId: leadValidator.id,
        status: "running",
        note: "The usable scene is completing with visual notes; no remaining quality preference will block the run.",
      });
      return { review: acceptedReview, visualCritique: acceptedCritique };
    };

    type CanvasTaskControl = {
      readonly signal: AbortSignal;
      readonly expandRepair: (input: {
        readonly review: CanvasReview;
        readonly critique: CanvasVisualCritique;
        readonly round: CanvasRepairRound;
        readonly nextRound: number;
        readonly partIds: ReadonlyArray<string>;
      }) => Promise<void>;
    };

    const scheduleRenderedProjectionRepair = async (
      review: CanvasReview,
      critique: CanvasVisualCritique,
      round: CanvasRepairRound,
      iteration: number,
      control: CanvasTaskControl,
    ): Promise<boolean> => {
      const repairScope = selectCanvasRepairScope(critique, round);
      const targetedPartIds = [...repairScope.partIds];
      const deferredPartCount = repairScope.deferredPartCount;
      if (
        critique.verdict === "pass"
        || targetedPartIds.length === 0
        || iteration >= Math.min(CANVAS_MAX_DECISION_FRONTIERS, graphDepthLimit)
      ) {
        await emit({
          type: "run.status",
          runId: input.runId,
          agentId: agentForRole("composer").id,
          status: "running",
          note: round === "first"
            ? "The first rendered PNG passed; no repair patches were needed."
            : round === "final"
              ? "The repaired PNG passed; the focused revision was skipped."
              : "The focused revision passed; the rescue edit was skipped.",
        });
        return false;
      }

      await emit({
        type: "run.status",
        runId: input.runId,
        agentId: agentForRole("composer").id,
        status: "running",
        note: round === "first"
          ? `The Finishing Artist is repairing ${targetedPartIds.join(", ")} in one parallel round${deferredPartCount > 0 ? `; ${deferredPartCount} lower-priority part(s) were deferred by the cost budget` : ""}.`
          : round === "final"
            ? `The Finishing Artist is applying the focused revision to ${targetedPartIds.join(", ")}, one contact boundary at a time${deferredPartCount > 0 ? `; ${deferredPartCount} lower-priority part(s) remain deferred` : ""}.`
            : `The Art Director requested one rescue edit for ${targetedPartIds.join(", ")}; the best prior frontier remains protected${deferredPartCount > 0 ? ` and ${deferredPartCount} lower-priority part(s) remain notes` : ""}.`,
      });
      await control.expandRepair({
        review,
        critique: repairScope.critique,
        round,
        nextRound: iteration + 1,
        partIds: targetedPartIds,
      });
      return true;
    };

    type CanvasPlatformTask = {
      readonly id: string;
      readonly nodeId: string;
      readonly capability: string;
      readonly objective: string;
      readonly needs: ReadonlyArray<string>;
      readonly provides: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly run: (
        ctx: { readonly runId: string },
        inputs: Readonly<Record<string, unknown>>,
        control: CanvasTaskControl,
      ) => Promise<Readonly<Record<string, unknown>>>;
      readonly normalizeOutput?: (
        output: Readonly<Record<string, unknown>>,
      ) => Promise<Readonly<Record<string, JsonValue>>>;
      readonly projectAcceptedOutput?: (
        output: Readonly<Record<string, JsonValue>>,
      ) => Promise<void>;
    };

    const tasks: ReadonlyArray<CanvasPlatformTask> = [
      ...painterParts.map((part, index) => {
        const role = part.role;
        const agent = agentForRole(role);
        const normalizeOwnedPatch = (rawPatch: unknown) => {
          const decoded = typeof rawPatch === "string" ? JSON.parse(rawPatch) : rawPatch;
          const patch = normalizeCanvasPatch(decoded as Parameters<typeof normalizeCanvasPatch>[0]);
          if (
            patch.runId !== input.runId
            || patch.agentId !== agent.id
            || patch.taskId !== `paint.${role}`
            || patch.partId !== part.id
          ) {
            throw new Error(`Canvas patch for ${part.id} crossed its assigned member or task boundary`);
          }
          return patch;
        };
        return {
          id: `paint.${role}`,
          nodeId: agent.id,
          capability: agent.capabilities[0],
          objective: part.objective,
          // Painters own semantic features, not isolated sections. They share the
          // same versioned composition scaffold while retaining independent patches.
          needs: part.needs,
          provides: [part.outputKey],
          run: async (_ctx: { readonly runId: string }, inputs: Readonly<Record<string, unknown>>, control: { readonly signal: AbortSignal }) => {
            const persistedPatch = Object.values(setupState.patches).find((candidate) =>
              candidate.taskId === `paint.${role}` && candidate.partId === part.id
            );
            if (persistedPatch) {
              const { updatedAt: _updatedAt, ...patch } = persistedPatch;
              return { [part.outputKey]: JSON.stringify(patch) };
            }
            await waitFor(Math.round(config.staggerMs * painterDelayMultiplier(index)), control.signal);
            const painted = await input.canvasModel.paint({
              prompt,
              runId: input.runId,
              plan: scenePlan,
              part,
              agentId: agent.id,
              taskId: `paint.${role}`,
              baseSceneHash: hashCanonical({
                prompt: inputs.prompt,
                planVersion: scenePlan.planVersion,
                scaffoldVersion: scenePlan.compositionScaffold.scaffoldVersion,
                scaffold: inputs["composition.scaffold"],
                anchors: scenePlan.anchors,
                partId: part.id,
              }),
            });
            return { [part.outputKey]: JSON.stringify(painted.patch) };
          },
          normalizeOutput: async (output: Readonly<Record<string, unknown>>) => {
            const patch = normalizeOwnedPatch(output[part.outputKey]);
            return { [part.outputKey]: JSON.stringify(patch) };
          },
          projectAcceptedOutput: async (output: Readonly<Record<string, JsonValue>>) => {
            const patch = normalizeOwnedPatch(output[part.outputKey]);
            await projectAcceptedPatch(
              patch,
              { agentId: agent.id, taskId: `paint.${role}` },
              agent.id,
            );
          },
        };
      }),
      {
        id: "deliberate.scene",
        nodeId: leadValidator.id,
        capability: "critique.semantic",
        objective: "Let the artist peers inspect, propose, challenge, repair, and certify successive shared scene frontiers.",
        needs: painterParts.map((part) => part.outputKey),
        provides: ["scene.review", "scene.visual-critique"],
        timeoutMs: CANVAS_DELIBERATION_TIMEOUT_MS,
        run: async (_ctx, taskInputs, control) => {
          await waitFor(Math.round(config.staggerMs * .2), control.signal);
          const critic = leadValidator;
          const finisher = agentForRole("composer");
          const peerArtist = agentForRole(painterParts.find((part) => part.compositionRole === "PRIMARY")?.role ?? painterParts[0]!.role);
          const nodeRoles = {
            [critic.id]: "critic",
            [finisher.id]: "finisher",
            [peerArtist.id]: "artist",
          };
          const peerVoteFor = async (inputVote: {
            readonly agent: CanvasNodeSpec;
            readonly role: "artist" | "finisher";
            readonly responsibility: string;
            readonly action: Parameters<NonNullable<CanvasModel["controlVote"]>>[0]["action"];
            readonly critique: CanvasVisualCritique;
            readonly evidenceRef: string;
          }): Promise<DistributedControlEndorsement> => {
            const decision = input.canvasModel.controlVote
              ? await input.canvasModel.controlVote({
                  prompt,
                  runId: input.runId,
                  taskId: "deliberate.scene",
                  plan: scenePlan,
                  role: inputVote.role,
                  responsibility: inputVote.responsibility,
                  action: inputVote.action,
                  critique: inputVote.critique,
                })
              : {
                  verdict: "endorse" as const,
                  reason: "Injected model fallback: the proposal is bounded and matches this role's owned responsibility.",
                };
            return {
              kind: "endorsement",
              proposalId: "",
              nodeId: inputVote.agent.id,
              nodeRole: inputVote.role,
              verdict: decision.verdict,
              reason: decision.reason,
              evidenceRefs: [inputVote.evidenceRef],
            };
          };
          let lastReview: CanvasReview | undefined;
          let lastCritique: CanvasVisualCritique | undefined;
          if (taskInputs["scene.repair.accepted"] === false) {
            const priorReview = taskInputs["deliberation.review"] as CanvasReview | undefined;
            const priorCritique = taskInputs["deliberation.critique"] as CanvasVisualCritique | undefined;
            if (priorReview && priorCritique) {
              const accepted = await acceptVisualFrontierWithNotes(priorReview, priorCritique);
              return {
                "scene.review": JSON.stringify(accepted.review),
                "scene.visual-critique": JSON.stringify(accepted.visualCritique),
              };
            }
          }

          const startingRound = Number(taskInputs["deliberation.round"] ?? 1);
          for (let round = startingRound; round <= CANVAS_MAX_DECISION_FRONTIERS; round += 1) {
            if (control.signal.aborted) throw control.signal.reason ?? new Error("Canvas deliberation aborted");
            const reviewed = await reviewRenderedProjection(round);
            lastReview = reviewed.review;
            lastCritique = reviewed.visualCritique;
            const session = new DistributedControlSession({
              runId: input.runId,
              artifactId: `${input.runId}:distributed-control:${round}`,
              frontierVersion: `scene:${reviewed.currentHash}`,
              topologyVersion: setupState.orchestration.topologyId ?? `plan:${scenePlan.planVersion}`,
              inputVersions: { scene: reviewed.currentHash, plan: scenePlan.planVersion },
              nodeRoles,
              emit,
            });
            try {
              if (reviewed.visualCritique.verdict === "pass") {
                const proposal = createDistributedControlProposal({
                  authorNodeId: critic.id,
                  authorRole: "critic",
                  rationale: "The rendered frontier meets the visible quality contract and is ready for certification.",
                  action: {
                    type: "certify_frontier",
                    projectionHash: reviewed.currentHash,
                    conflictCount: reviewed.projection.conflicts.length,
                    reason: "Visible review and structural projection both pass.",
                  },
                  evidenceRefs: [reviewed.currentHash],
                });
                await session.publish({ nodeId: critic.id, taskId: "deliberate.scene", payload: proposal });
                const peerVotes = await Promise.all([
                  peerVoteFor({
                    agent: finisher,
                    role: "finisher",
                    responsibility: "Protect repair feasibility, successful scene geometry, and finishing quality.",
                    action: proposal.action,
                    critique: reviewed.visualCritique,
                    evidenceRef: reviewed.currentHash,
                  }),
                  peerVoteFor({
                    agent: peerArtist,
                    role: "artist",
                    responsibility: peerArtist.focus,
                    action: proposal.action,
                    critique: reviewed.visualCritique,
                    evidenceRef: reviewed.currentHash,
                  }),
                ]);
                for (const vote of peerVotes) {
                  await session.publish({
                    nodeId: vote.nodeId,
                    taskId: "deliberate.scene",
                    payload: {
                      ...vote,
                      proposalId: proposal.proposalId,
                    },
                  });
                }
                const projected = await session.projectAndCertify();
                if (projected.value.acceptedActions.length === 0) {
                  await emit({
                    type: "run.status",
                    runId: input.runId,
                    agentId: finisher.id,
                    status: "running",
                    note: "Peer certification did not reach the required independent endorsements; the unresolved findings are being routed into a bounded polish pass.",
                  });
                  const challengedCritique: CanvasVisualCritique = {
                    ...reviewed.visualCritique,
                    verdict: "repair",
                  };
                  const stage: CanvasRepairRound = round === 1 ? "first" : round === 2 ? "final" : "rescue";
                  if (await scheduleRenderedProjectionRepair(
                    reviewed.review,
                    challengedCritique,
                    stage,
                    round,
                    control,
                  )) {
                    return {};
                  }
                  if (round < 2) continue;
                  const accepted = await acceptVisualFrontierWithNotes(reviewed.review, challengedCritique);
                  return {
                    "scene.review": JSON.stringify(accepted.review),
                    "scene.visual-critique": JSON.stringify(accepted.visualCritique),
                  };
                }
                await reconcileDistributedControl({
                  projection: projected.value,
                  certifiedVersionHash: projected.versionHash,
                  projectionVersionHash: projected.versionHash,
                  conflictCount: projected.conflicts.length,
                  effects: {
                    spawnTasks: async () => {}, retireNode: async () => {}, transferBudget: async () => {},
                    setJoinStrategy: async () => {}, certifyFrontier: async () => {},
                  },
                });
                return {
                  "scene.review": JSON.stringify(reviewed.review),
                  "scene.visual-critique": JSON.stringify(reviewed.visualCritique),
                };
              }

              const stage: CanvasRepairRound = round === 1 ? "first" : round === 2 ? "final" : "rescue";
              const scope = selectCanvasRepairScope(reviewed.visualCritique, stage);
              if (scope.partIds.length === 0) {
                const accepted = await acceptVisualFrontierWithNotes(reviewed.review, reviewed.visualCritique);
                return {
                  "scene.review": JSON.stringify(accepted.review),
                  "scene.visual-critique": JSON.stringify(accepted.visualCritique),
                };
              }
              const proposal = createDistributedControlProposal({
                authorNodeId: critic.id,
                authorRole: "critic",
                rationale: reviewed.visualCritique.summary,
                action: {
                  type: "spawn_tasks",
                  joinStrategy: "best-score",
                  tasks: scope.partIds.map((partId) => ({
                    taskId: `repair-${round}-${partId}`,
                    role: "finisher",
                    capability: "paint.repair",
                    kind: "repair" as const,
                    objective: reviewed.visualCritique.issues.find((issue) => issue.partId === partId)?.repairInstruction
                      ?? `Repair ${partId} against the current visible frontier.`,
                    parentTaskId: "deliberate.scene",
                    dependencies: [],
                    estimatedCostMicros: round === 1 ? 300_000 : 500_000,
                  })),
                },
                evidenceRefs: [reviewed.currentHash],
              });
              await session.publish({ nodeId: critic.id, taskId: "deliberate.scene", payload: proposal });
              const rawPeerVote = await peerVoteFor({
                agent: finisher,
                role: "finisher",
                responsibility: "Judge whether proposed repairs are executable, bounded, and preserve successful peer work.",
                action: proposal.action,
                critique: reviewed.visualCritique,
                evidenceRef: reviewed.currentHash,
              });
              const peerVote: DistributedControlPayload = {
                ...rawPeerVote,
                proposalId: proposal.proposalId,
              };
              await session.publish({ nodeId: finisher.id, taskId: "deliberate.scene", payload: peerVote });
              const projected = await session.projectAndCertify();
              if (projected.value.acceptedActions.length === 0) {
                await emit({
                  type: "run.status",
                  runId: input.runId,
                  agentId: finisher.id,
                  status: "running",
                  note: "The proposed repair did not receive an independent endorsement; the council will re-evaluate once before completing with explicit notes.",
                });
                if (round < 2) continue;
                const accepted = await acceptVisualFrontierWithNotes(reviewed.review, reviewed.visualCritique);
                return {
                  "scene.review": JSON.stringify(accepted.review),
                  "scene.visual-critique": JSON.stringify(accepted.visualCritique),
                };
              }
              let expanded = false;
              await reconcileDistributedControl({
                projection: projected.value,
                certifiedVersionHash: projected.versionHash,
                projectionVersionHash: projected.versionHash,
                conflictCount: projected.conflicts.length,
                effects: {
                  spawnTasks: async () => {
                    expanded = await scheduleRenderedProjectionRepair(
                      reviewed.review,
                      reviewed.visualCritique,
                      stage,
                      round,
                      control,
                    );
                  },
                  retireNode: async () => {}, transferBudget: async () => {}, setJoinStrategy: async () => {}, certifyFrontier: async () => {},
                },
              });
              if (expanded) return {};
              if (!expanded) {
                const accepted = await acceptVisualFrontierWithNotes(reviewed.review, reviewed.visualCritique);
                return {
                  "scene.review": JSON.stringify(accepted.review),
                  "scene.visual-critique": JSON.stringify(accepted.visualCritique),
                };
              }
            } finally {
              session.destroy();
            }
          }

          if (!lastReview || !lastCritique) throw new Error("No distributed Canvas frontier was reviewed");
          const accepted = await acceptVisualFrontierWithNotes(lastReview, lastCritique);
          return {
            "scene.review": JSON.stringify(accepted.review),
            "scene.visual-critique": JSON.stringify(accepted.visualCritique),
          };
        },
      },
      {
        id: "compose.scene",
        nodeId: agentForRole("composer").id,
        capability: "compose.final",
        objective: "Finish the artwork from the accepted painted layers.",
        needs: ["scene.review"],
        provides: ["scene.final"],
        run: async (_ctx, _inputs, control) => {
          await waitFor(Math.round(config.staggerMs * .3), control.signal);
          const projection = ledger.project();
          if (projection.conflicts.length > 0) throw new Error("Canvas composition still has Yjs conflicts");
          return { "scene.final": canonicalCanvasScene(projection.objects) };
        },
      },
    ];

    const executionState = await input.runtime.state(runStream);
    const taskById = new Map(tasks.map((task) => [task.id, task] as const));
    const taskByOutput = new Map(tasks.flatMap((task) =>
      task.provides.map((outputKey) => [outputKey, task.id] as const)
    ));
    const initialOutputs: Readonly<Record<string, JsonValue>> = {
      prompt,
      "composition.scaffold": JSON.stringify(scenePlan.compositionScaffold),
    };
    const taskGraph = input.executionPlane.taskGraph;
    const dataReferences = input.executionPlane.dataReferences;
    const initialReference = await dataReferences.put({
      value: initialOutputs,
      mediaType: "application/json",
      metadata: { kind: "canvas.initial-inputs" },
    });
    const topologyVersion = executionState.orchestration.topologyId ?? `plan:${scenePlan.planVersion}`;
    const catalogVersion = `canvas-catalog:${CANVAS_WORKFLOW_VERSION}`;
    const frontierVersion = `canvas-frontier:${hashCanonical({
      runId: input.runId,
      prompt,
      planVersion: scenePlan.planVersion,
    })}`;
    const acceptancePolicy = {
      policyId: "canvas.accept.projected-task-output",
      policyVersion: "1",
    } as const;
    const acceptance = createDefaultDynamicTaskAcceptanceRegistry();
    acceptance.register(acceptancePolicy, async ({ runId, definition, attempt, draft }) => {
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
        throw new Error(`Canvas task ${definition.taskId} must return a JSON object`);
      }
      const output = draft as Readonly<Record<string, JsonValue>>;
      const task = taskById.get(definition.taskId);
      if (task?.projectAcceptedOutput) {
        await task.projectAcceptedOutput(output);
      } else if (
        definition.semanticKey.startsWith("canvas:repair:")
        && output["scene.repair.accepted"] === true
      ) {
        const rawPatch = output["scene.repair.patch"];
        const patch = normalizeCanvasPatch(
          (typeof rawPatch === "string" ? JSON.parse(rawPatch) : rawPatch) as
            Parameters<typeof normalizeCanvasPatch>[0],
        );
        if (
          patch.runId !== input.runId
          || patch.agentId !== definition.nodeId
          || patch.taskId !== definition.taskId
        ) {
          throw new Error(`Canvas repair ${definition.taskId} crossed its accepted task boundary`);
        }
        await projectAcceptedPatch(
          patch,
          {
            agentId: definition.nodeId,
            taskId: definition.taskId,
            phase: "dynamic-visual-repair",
          },
          definition.nodeId,
        );
      } else if (!definition.semanticKey.startsWith("canvas:repair:")) {
        throw new Error(`Canvas task ${definition.taskId} has no accepted-output projector`);
      }
      const encoded = JSON.stringify(output);
      const contentHash = hashCanonical(output);
      return createAcceptedTaskOutcome({
        runId,
        taskId: definition.taskId,
        nodeId: definition.nodeId,
        attempt,
        definitionHash: definition.definitionHash,
        inputVersions: definition.inputs.inputVersions,
        frontierVersion: definition.inputs.frontierVersion,
        topologyVersion: definition.inputs.topologyVersion,
        catalogVersion: definition.inputs.catalogVersion,
        acceptancePolicyId: definition.acceptance.policyId,
        acceptancePolicyVersion: definition.acceptance.policyVersion,
        artifacts: [{
          artifactId: `artifact_${contentHash.slice(0, 28)}`,
          outputKey: definition.result.mode === "none" ? definition.taskId : definition.result.outputKey,
          kind: "json",
          contentHash,
          mediaType: "application/json",
          byteLength: Buffer.byteLength(encoded),
          storage: "inline",
        }],
      });
    });
    const defaultTimeoutMs = Math.max(180_000, config.staggerMs * 8);
    const seedTasks = tasks.map((task) => {
      const dependencyIds = [...new Set(task.needs
        .map((need) => taskByOutput.get(need))
        .filter((taskId): taskId is string => Boolean(taskId)))];
      const initialNeeds = task.needs.filter((need) => Object.hasOwn(initialOutputs, need));
      return createDynamicTaskDefinition({
        taskId: task.id,
        semanticKey: `canvas:${CANVAS_WORKFLOW_VERSION}:${task.id}`,
        nodeId: task.nodeId,
        capability: task.capability,
        objective: task.objective,
        handler: { kind: "roster.node", version: "1" },
        acceptance: task.projectAcceptedOutput ? acceptancePolicy : DEFAULT_DYNAMIC_ACCEPTANCE,
        result: { mode: "json", outputKey: task.id, schema: true },
        dependencies: dependencyIds.map((taskId) => ({
          taskId,
          condition: task.id === "compose.scene" && taskId === "deliberate.scene"
            ? "terminal" as const
            : "accepted" as const,
        })),
        join: task.id === "compose.scene"
          ? { kind: "all-terminal" }
          : { kind: "all-success" },
        inputs: {
          inputVersions: Object.fromEntries(task.needs.map((need) => [
            need,
            taskByOutput.has(need)
              ? `task:${taskByOutput.get(need)}`
              : hashCanonical(initialOutputs[need] ?? null),
          ])),
          dataReferences: initialNeeds.length > 0 ? [initialReference] : [],
          frontierVersion,
          topologyVersion,
          catalogVersion,
        },
        runtimeBindingEpoch: 0,
        retry: {
          maxAttempts: 1,
          initialBackoffMs: 250,
          maximumBackoffMs: 2_000,
        },
        timeoutMs: task.timeoutMs ?? defaultTimeoutMs,
        sideEffect: "idempotent",
        estimatedCostMicros: 0,
      });
    });
    const maxGraphTasks = tasks.length
      + CANVAS_MAX_DECISION_FRONTIERS * (CANVAS_REPAIR_PART_BUDGET.first + 1);
    const localExecutionPolicy = {
      maxTasks: maxGraphTasks,
      maxDepth: CANVAS_MAX_DECISION_FRONTIERS,
      maxFanout: CANVAS_REPAIR_PART_BUDGET.first + 1,
      maxInflight: Math.min(config.maxParallel, tasks.length),
      maxReady: maxGraphTasks,
      maxBlocked: maxGraphTasks,
      maxAttempts: 1,
      maxContextBytes: 128 * 1_048_576,
      maxCostMicros: 20_000_000,
      maxTokens: 2_000_000,
      maxWallTimeMs: Math.max(
        600_000,
        seedTasks.reduce((total, definition) => total + Math.max(definition.timeoutMs, defaultTimeoutMs), 0),
      ),
    };
    const executionPolicy = input.executionPlane.policy ?? localExecutionPolicy;
    const platform = defineRosterPlatform({
      id: "canvas",
      version: CANVAS_WORKFLOW_VERSION,
      policyVersion: domain.pack.policyVersion,
      coordinatorId: domain.pack.coordinatorId,
      coordinatorCapability: "coordinate",
      capabilities: domain.pack.capabilities,
      nodes: registry.pack.nodes,
      maxNodes: registry.pack.limits.maxNodes,
      policy: executionPolicy,
      access: (node, definition) => {
        const canExpand = node.id === domain.pack.coordinatorId
          || definition.capability === "critique.semantic";
        return canExpand
          ? {
              functionGrants: [ROSTER_EXPAND_FUNCTION_ID],
              scopes: ["roster:graph:expand"],
              allowedEffects: ["read", "write"],
            }
          : { allowedEffects: ["read"] };
      },
      workspaceOperations: () => ["read"],
    });
    const outputs: Record<string, JsonValue> = { ...initialOutputs };
    const execution = platform.createExecution({
        runId: input.runId,
        seedTasks,
        taskGraph,
        dataReferences,
        createTaskContext: input.executionPlane.createTaskContext,
        onSnapshot: (snapshot) => emit(taskGraphProjectedEvent(input.runId, snapshot)),
        acceptance,
        nodeRuntimes: input.nodeRuntimes,
        nativeExecute: async (taskContext) => {
          if (taskContext.definition.semanticKey.startsWith("canvas:repair:")) {
            const contextReference = taskContext.definition.inputs.dataReferences[0];
            if (!contextReference) {
              throw new Error(`Canvas repair ${taskContext.definition.taskId} has no repair context`);
            }
            const rawContext = await taskContext.readDataReference(contextReference, {
              signal: taskContext.signal,
            });
            if (!rawContext || typeof rawContext !== "object" || Array.isArray(rawContext)) {
              throw new Error(`Canvas repair ${taskContext.definition.taskId} has invalid repair context`);
            }
            const repairContext = rawContext as Readonly<Record<string, JsonValue>>;
            const partId = typeof repairContext.partId === "string" ? repairContext.partId : "";
            const round = repairContext.round;
            if (round !== "first" && round !== "final" && round !== "rescue") {
              throw new Error(`Canvas repair ${taskContext.definition.taskId} has an invalid stage`);
            }
            const critique = repairContext.critique as CanvasVisualCritique;
            const part = painterParts.find((candidate) => candidate.id === partId);
            const before = ledger.project();
            const originalPatch = before.patches.find((candidate) => candidate.partId === partId);
            if (!part || !originalPatch) {
              throw new Error(`Visual repair cannot resolve canvas part ${partId}`);
            }
            const baseSceneHash = sceneHash(before.objects);
            const finisher = agentForRole("composer");
            const repaired = await input.canvasModel.repair({
              prompt,
              runId: input.runId,
              plan: scenePlan,
              part,
              agentId: finisher.id,
              taskId: taskContext.definition.taskId,
              baseSceneHash,
              originalPatch,
              sceneObjects: before.objects,
              critique,
              repairStage: round,
            });
            const patch = normalizeCanvasPatch(repaired.patch);
            if (
              patch.runId !== input.runId
              || patch.agentId !== finisher.id
              || patch.taskId !== taskContext.definition.taskId
              || patch.partId !== partId
            ) {
              throw new Error(`Canvas repair ${taskContext.definition.taskId} crossed its assigned boundary`);
            }
            const candidateObjects = [
              ...before.objects.filter((object) => object.partId !== partId),
              ...patch.objects,
            ];
            const structure = validateCanvasScene(scenePlan, candidateObjects, []);
            if (structure.verdict !== "pass") {
              await emit({
                type: "run.status",
                runId: input.runId,
                agentId: finisher.id,
                status: "running",
                note: `The ${round} repair candidate was rejected before acceptance because it broke the structural contract.`,
              });
              return {
                "scene.repair.accepted": false,
                "scene.repair.patch": JSON.stringify(patch),
              };
            }
            const candidateCritique = await input.canvasModel.critique({
              prompt,
              plan: scenePlan,
              objects: candidateObjects,
              runId: input.runId,
              taskId: taskContext.definition.taskId,
            });
            if (!shouldAcceptCanvasVisualCandidate(critique, candidateCritique)) {
              const beforeQuality = canvasVisualQualityGate(critique);
              const candidateQuality = canvasVisualQualityGate(candidateCritique);
              await emit({
                type: "run.status",
                runId: input.runId,
                agentId: finisher.id,
                status: "running",
                note: `The ${round} candidate was rejected at acceptance (${candidateQuality.mean.toFixed(1)} vs ${beforeQuality.mean.toFixed(1)}); the stronger prior frontier remains live.`,
              });
              return {
                "scene.repair.accepted": false,
                "scene.repair.patch": JSON.stringify(patch),
              };
            }
            const beforeQuality = canvasVisualQualityGate(critique);
            const candidateQuality = canvasVisualQualityGate(candidateCritique);
            await emit({
              type: "run.status",
              runId: input.runId,
              agentId: finisher.id,
              status: "running",
              note: `The ${round} candidate improved the visual frontier (${beforeQuality.mean.toFixed(1)} → ${candidateQuality.mean.toFixed(1)}) and entered accepted projection.`,
            });
            if (!input.canvasModel.validationCouncil) {
              critiqueCache.set(sceneHash(candidateObjects), candidateCritique);
            }
            return {
              "scene.repair.accepted": true,
              "scene.repair.patch": JSON.stringify(patch),
            };
          }

          const task = taskById.get(taskContext.definition.taskId)
            ?? (
              taskContext.definition.semanticKey.startsWith("canvas:deliberate:")
                ? taskById.get("deliberate.scene")
                : undefined
            );
          if (!task) throw new Error(`Canvas task ${taskContext.definition.taskId} has no implementation`);
          const taskInputs: Record<string, unknown> = { ...initialOutputs };
          for (const reference of taskContext.definition.inputs.dataReferences) {
            const value = await taskContext.readDataReference(reference, {
              signal: taskContext.signal,
            });
            if (value && typeof value === "object" && !Array.isArray(value)) {
              Object.assign(taskInputs, value);
            }
          }
          let repairRejected = false;
          for (const references of Object.values(taskContext.dependencyDataReferences)) {
            for (const { reference } of references) {
              const value = await taskContext.readDataReference(reference, {
                signal: taskContext.signal,
              });
              if (value && typeof value === "object" && !Array.isArray(value)) {
                const record = value as Readonly<Record<string, JsonValue>>;
                if (record["scene.repair.accepted"] === false) {
                  repairRejected = true;
                }
                Object.assign(taskInputs, record);
              }
            }
          }
          if (repairRejected) taskInputs["scene.repair.accepted"] = false;
          const draft = await task.run(
            { runId: input.runId },
            taskInputs,
            {
              signal: taskContext.signal,
              expandRepair: async ({ review, critique, round, nextRound, partIds }) => {
                const before = ledger.project();
                const baseSceneHash = sceneHash(before.objects);
                const parentTaskId = taskContext.definition.taskId;
                const finisher = agentForRole("composer");
                const repairDefinitions = [];
                let priorRepairTaskId: string | undefined;
                for (const partId of partIds) {
                  const repairTaskId = `repair.${round}.${partId}.${baseSceneHash.slice(0, 12)}`;
                  const contextReference = await dataReferences.put({
                    value: JSON.parse(JSON.stringify({
                      partId,
                      round,
                      critique,
                    })) as JsonValue,
                    mediaType: "application/json",
                    metadata: {
                      kind: "canvas.repair-context",
                      parentTaskId,
                      partId,
                    },
                  });
                  const dependencies = round !== "first" && priorRepairTaskId
                    ? [{ taskId: priorRepairTaskId, condition: "accepted" as const }]
                    : [];
                  repairDefinitions.push(createDynamicTaskDefinition({
                    taskId: repairTaskId,
                    semanticKey: `canvas:repair:${round}:${partId}:${baseSceneHash.slice(0, 12)}`,
                    parentTaskId,
                    nodeId: finisher.id,
                    capability: "compose.final",
                    objective: critique.issues.find((issue) => issue.partId === partId)?.repairInstruction
                      ?? `Repair ${partId} against the accepted scene frontier.`,
                    handler: { kind: "roster.node", version: "1" },
                    acceptance: acceptancePolicy,
                    result: { mode: "json", outputKey: "scene.repair", schema: true },
                    dependencies,
                    join: { kind: "all-success" },
                    inputs: {
                      inputVersions: {
                        "scene.frontier": baseSceneHash,
                        critique: hashCanonical(critique),
                      },
                      dataReferences: [contextReference],
                      frontierVersion: `scene:${baseSceneHash}`,
                      topologyVersion,
                      catalogVersion,
                    },
                    runtimeBindingEpoch: 0,
                    retry: {
                      maxAttempts: 1,
                      initialBackoffMs: 250,
                      maximumBackoffMs: 2_000,
                    },
                    timeoutMs: defaultTimeoutMs,
                    sideEffect: "idempotent",
                    estimatedCostMicros: round === "first" ? 300_000 : 500_000,
                  }));
                  priorRepairTaskId = repairTaskId;
                }
                const continuationTaskId =
                  `deliberate.scene.r${nextRound}.${baseSceneHash.slice(0, 12)}`;
                const continuationReference = await dataReferences.put({
                  value: JSON.parse(JSON.stringify({
                    "deliberation.round": nextRound,
                    "deliberation.review": review,
                    "deliberation.critique": critique,
                  })) as JsonValue,
                  mediaType: "application/json",
                  metadata: {
                    kind: "canvas.deliberation-continuation",
                    parentTaskId,
                  },
                });
                const continuation = createDynamicTaskDefinition({
                  taskId: continuationTaskId,
                  semanticKey:
                    `canvas:deliberate:${nextRound}:${baseSceneHash.slice(0, 12)}`,
                  parentTaskId,
                  nodeId: leadValidator.id,
                  capability: "critique.semantic",
                  objective: `Review accepted Canvas repair frontier ${nextRound}.`,
                  handler: { kind: "roster.node", version: "1" },
                  acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
                  result: { mode: "json", outputKey: "scene.review", schema: true },
                  dependencies: repairDefinitions.map((definition) => ({
                    taskId: definition.taskId,
                    condition: "accepted" as const,
                  })),
                  join: { kind: "all-success" },
                  inputs: {
                    inputVersions: {
                      "scene.frontier": baseSceneHash,
                      round: String(nextRound),
                    },
                    dataReferences: [continuationReference],
                    frontierVersion: `scene:${baseSceneHash}`,
                    topologyVersion,
                    catalogVersion,
                  },
                  runtimeBindingEpoch: 0,
                  retry: {
                    maxAttempts: 1,
                    initialBackoffMs: 250,
                    maximumBackoffMs: 2_000,
                  },
                  timeoutMs: CANVAS_DELIBERATION_TIMEOUT_MS,
                  sideEffect: "idempotent",
                  estimatedCostMicros: 0,
                });
                await taskContext.expand({
                  expansionKey:
                    `canvas-repair-${round}-${baseSceneHash.slice(0, 12)}`,
                  definitions: [...repairDefinitions, continuation],
                  continuationTaskId,
                });
              },
            },
          );
          const normalized = task.normalizeOutput
            ? await task.normalizeOutput(draft)
            : draft;
          const encoded = JSON.stringify(normalized);
          if (encoded === undefined) {
            throw new Error(`Canvas task ${task.id} returned a non-serializable result`);
          }
          return JSON.parse(encoded) as JsonValue;
        },
      });
    await execution.dispatchUntilQuiescent();
    const snapshot = await execution.snapshot();
    for (const entry of snapshot.outcomeDataReferences) {
      const value = await dataReferences.read(entry.reference);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(outputs, value);
      }
    }
    if (taskGraphTask(snapshot, "compose.scene")?.status !== "accepted") {
      const failed = snapshot.tasks.find((record) => record.status === "failed");
      throw new Error(failed?.error ?? "Canvas task graph did not accept the final scene");
    }

    const content = typeof outputs["scene.final"] === "string" ? outputs["scene.final"] : "";
    if (!content) throw new Error("Canvas plan completed without a final scene artifact");
    const finalReviewRaw = typeof outputs["scene.review"] === "string" ? outputs["scene.review"] : "";
    if (!finalReviewRaw) throw new Error("Canvas plan completed without a final visual review");
    const finalReview = JSON.parse(finalReviewRaw) as CanvasReview;
    const completedWithNotes = finalReview.qualityStatus === "accepted-with-notes";
    const projection = ledger.project();
    const finalHash = sceneHash(projection.objects);
    const inputVersions = Object.fromEntries(
      projection.patches.map((patch) => [patch.partId, canvasPatchContentHash(patch)])
    );
    const contract = {
      compositionId: "canvas.final",
      planVersion: scenePlan.planVersion,
      boundaryHash: hashCanonical({ planVersion: scenePlan.planVersion, parts: painterRoles }),
      inputVersions,
      requiredEvidenceKinds: ["structural-validation", "visual-critique"],
    } as const;
    const proposal = createCompositionProposal({
      compositionId: contract.compositionId,
      planVersion: contract.planVersion,
      nodeId: agentForRole("composer").id,
      capability: "compose.final",
      boundaryHash: contract.boundaryHash,
      inputVersions,
      content,
      evidence: [{
        id: `canvas-review-${finalHash.slice(0, 20)}`,
        kind: "structural-validation",
        verdict: "pass",
        artifactHash: sha256(content),
      }, {
        id: `canvas-visual-critique-${finalHash.slice(0, 20)}`,
        kind: "visual-critique",
        verdict: "pass",
        artifactHash: sha256(
          typeof outputs["scene.visual-critique"] === "string"
            ? outputs["scene.visual-critique"]
            : "",
        ),
      }],
    });
    await emit(compositionProposedEvent(input.runId, proposal));
    const certified = certifyComposition({ registry, contract, proposal });
    if (!certified.ok) {
      await emit({ type: "composition.rejected", runId: input.runId, compositionId: contract.compositionId, proposalId: proposal.proposalId, reason: certified.reason, detail: certified.detail });
      throw new Error(certified.detail);
    }
    await emit(compositionCertifiedEvent(input.runId, certified.certification));

    const finalReflection = reflectOnOrchestration({
      runId: input.runId,
      policyId: "canvas-population",
      policyVersion: domain.pack.policyVersion,
      iteration: 2,
      observation: {
        activeNodes: spawned.length + 1,
        pendingTasks: 0,
        runningTasks: 0,
        failedTasks: 0,
        conflicts: 0,
        evidenceGaps: 0,
        stagnationRounds: 0,
        goalSatisfied: true,
        note: completedWithNotes
          ? "The canonical scene passed structural validation and the usable-output completion gate with visual notes preserved."
          : "The canonical scene passed structural validation, rendered PNG critique, and composition certification.",
      },
      maxNodes: domain.pack.limits.maxNodes,
    });
    await emit(reflectionRecordedEvent(input.runId, finalReflection));
    await emit({ type: "scene.finalized", runId: input.runId, agentId: agentForRole("composer").id, sceneHash: finalHash, objectCount: projection.objects.length, content });
    await emit({
      type: "run.status",
      runId: input.runId,
      agentId: "orchestrator",
      status: "completed",
      note: completedWithNotes
        ? "Scene completed with visual notes after the bounded finishing passes."
        : "Scene certified against the complete visual frontier.",
    });

    return { runId: input.runId, stream: input.stream, runStream, status: "completed", sceneHash: finalHash, objectCount: projection.objects.length };
  } catch (error) {
    const message = publicCanvasFailureMessage(error);
    const failureClass = classifyModelFailure(error);
    // Only a clear 429 rejection is safe to repeat automatically. Timeouts
    // and uncertain provider failures may already have consumed work.
    const retryable = failureClass === "rate-limit";
    try {
      await emit({
        type: "run.status",
        runId: input.runId,
        agentId: "orchestrator",
        status: "failed",
        note: message,
        failure: { class: failureClass, retryable },
      });
    } catch {
      // Preserve the original workflow failure when a terminal receipt cannot be appended.
    }
    const state = await input.runtime.state(runStream);
    return {
      runId: input.runId,
      stream: input.stream,
      runStream,
      status: "failed",
      sceneHash: state.final?.sceneHash,
      objectCount: Object.keys(state.objects).length,
      failureClass,
      failureMessage: message,
      retryable,
    };
  } finally {
    ledger.destroy();
  }
};
