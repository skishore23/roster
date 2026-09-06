// ============================================================================
// Theorem Roster workflow - Receipt-native mini framework
// ============================================================================

import { createHash } from "node:crypto";

import type { Runtime } from "../core/runtime.js";
import type { TheoremAxiomEvidence, TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { reduce as reduceTheorem, initial as initialTheorem } from "../modules/theorem.js";
import { type TheoremPromptConfig } from "../prompts/theorem.js";
import { compilePrompt, versionPromptInputs } from "../engine/orchestration/prompt.js";
import { certifyComposition, createCompositionProposal } from "../engine/orchestration/composition.js";
import {
  compositionCertifiedEvent,
  compositionProposedEvent,
  inlineArtifactPublishedEvent,
  orchestrationConfiguredEvent,
  promptCompiledEvent,
  reflectionRecordedEvent,
  topologySelectedEvent,
} from "../modules/orchestration.js";
import { reflectOnOrchestration } from "../engine/orchestration/adaptive.js";
import type { LlmText, ModelUsage } from "../engine/runtime/model.js";
import {
  compositionBracket,
  compositionLeaves,
  contractCompositionLeaf,
  graftCompositionLeaf,
  parseCompositionBracket,
  topologyForLeaves,
  type CompositionTree,
} from "../engine/orchestration/topology.js";

import { clampNumber, parseFormNum, type AgentRunControl, createQueuedEmitter, type EmitFn, type RunLifecycle, type WorkflowSpec } from "../engine/runtime/workflow.js";
import { defineWorkflowAgent, runDefinedWorkflowAgent } from "../sdk/agent.js";
import {
  THEOREM_WORKFLOW_ID,
  THEOREM_WORKFLOW_VERSION,
  THEOREM_EXAMPLES,
} from "./theorem.constants.js";
import {
  buildTheoremRuns,
  buildTheoremSteps,
  getLatestTheoremRunId,
  sliceTheoremChain,
  sliceTheoremChainByStep,
  type TheoremRunSummary,
} from "./theorem.runs.js";
import {
  bracketString,
  computeTopologyWeights,
  type BracketTree,
} from "./theorem.rebracket.js";
import { evaluateRoundRebracketEvidence } from "./theorem.evidence.js";
import {
  callWithStructuredRetries,
  formatAttemptPayload,
  formatCritiquePayload,
  formatLemmaPayload,
  formatMergePayload,
  formatPatchPayload,
  formatProofPayload,
  formatVerifyPayload,
  parseAttemptPayload,
  parseCritiquePayload,
  parseLemmaPayload,
  parseMergePayload,
  parseOrchestratorDecision,
  parsePatchPayload,
  parseProofPayload,
  parseVerifyPayload,
  type AxiomDelegatePayload,
  type ParsedOrchestratorDecision,
  type ProofPayload,
} from "./theorem.structured.js";
import type { AxiomTaskHints } from "./axiom/config.js";
import { buildMemorySlice, memoryBudget, type MemoryPhase } from "./theorem.memory.js";
import { theoremBranchStream, theoremRunStream } from "./theorem.streams.js";
import {
  buildVersionedMergePlan,
  type VersionedMergeStep,
} from "../engine/merge/versioned-contract.js";
import {
  CrdtMergeLedger,
  createCrdtMergeProposal,
  createMergeProposalUpdate,
  type CrdtMergeStepProjection,
} from "../engine/merge/crdt-ledger.js";
import { buildTheoremRunResult, classifyTheoremFailure, type TheoremRunResult } from "./theorem.result.js";
import {
  createTheoremPlatformPhaseRunner,
  type TheoremPlatformExecutionPlaneFactory,
  type TheoremPlatformPhaseRunner,
  type TheoremPlatformTaskRuntime,
  type TheoremTaskExecutionControl,
} from "./theorem.platform.js";
import {
  deriveTheoremNodeDemands,
  materializeTheoremNode,
  theoremAdaptiveDomain,
  type TheoremNodeDemand,
  type TheoremNodeSpec,
} from "../domains/theorem.js";
import { resolveRuntimeLimits } from "../engine/runtime/limits.js";

// ============================================================================
// Types
// ============================================================================

export type TheoremRunConfig = {
  readonly rounds: number;
  readonly maxDepth: number;
  readonly memoryWindow: number;
  readonly branchThreshold: number;
  readonly maxParallel?: number;
};

export type TheoremRunControl = AgentRunControl;
export type TheoremAxiomPolicy = "optional" | "required";

export type TheoremAxiomDelegateResult = {
  readonly status: string;
  readonly summary: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly stream?: string;
  readonly outcome?: string;
  readonly evidence?: ReadonlyArray<Omit<TheoremAxiomEvidence, "phase">>;
  readonly verifiedCandidateContent?: string;
  readonly verifiedCandidateHash?: string;
  readonly verifiedFormalStatementHash?: string;
};

export type { TheoremFailureClass, TheoremRunResult } from "./theorem.result.js";

export const THEOREM_DEFAULT_CONFIG: TheoremRunConfig = {
  rounds: 2,
  maxDepth: 2,
  memoryWindow: 60,
  branchThreshold: 2,
  maxParallel: resolveRuntimeLimits().maxParallel,
};

export const normalizeTheoremConfig = (input: Partial<TheoremRunConfig>): TheoremRunConfig => ({
  rounds: clampNumber(
    Number.isFinite(input.rounds ?? NaN) ? input.rounds! : THEOREM_DEFAULT_CONFIG.rounds,
    1,
    5
  ),
  maxDepth: clampNumber(
    Number.isFinite(input.maxDepth ?? NaN) ? input.maxDepth! : THEOREM_DEFAULT_CONFIG.maxDepth,
    1,
    4
  ),
  memoryWindow: clampNumber(
    Number.isFinite(input.memoryWindow ?? NaN) ? input.memoryWindow! : THEOREM_DEFAULT_CONFIG.memoryWindow,
    5,
    200
  ),
  branchThreshold: clampNumber(
    Number.isFinite(input.branchThreshold ?? NaN) ? input.branchThreshold! : THEOREM_DEFAULT_CONFIG.branchThreshold,
    1,
    6
  ),
  maxParallel: resolveRuntimeLimits({ maxParallel: input.maxParallel }).maxParallel,
});

const hashText = (input: string): string =>
  createHash("sha256").update(input, "utf-8").digest("hex");

const mapWithConcurrency = async <Input, Output>(
  items: ReadonlyArray<Input>,
  limit: number,
  run: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> => {
  const results: Output[] = new Array(items.length);
  let nextIndex = 0;
  let stopped = false;
  let failure: unknown;
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const workers = Array.from({ length: Math.min(items.length, normalizedLimit) }, async () => {
    while (true) {
      if (stopped) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await run(items[index]!, index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          failure = error;
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (stopped) throw failure;
  return results;
};

class RunAbortedError extends Error {
  constructor(stage: string) {
    super(`canceled at ${stage}`);
    this.name = "RunAbortedError";
  }
}

const boundedEnvInteger = (
  name: string,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

const extractPrimaryDeclarationName = (content: string): string | undefined => {
  const match = content.match(/\b(?:theorem|lemma)\s+([A-Za-z0-9_'.]+)/);
  return match?.[1];
};

const softTrim = (text: string, headChars: number, tailChars: number): string => {
  if (text.length <= headChars + tailChars + 16) return text;
  return `${text.slice(0, headChars)}\n\n[... trimmed ...]\n\n${text.slice(-tailChars)}`;
};

const isPromptSectionHeader = (line: string): boolean =>
  /^(Problem|Memory|Latest summary \(if any\)|Summary|Attempts|Attempt|Critiques|Verifier notes|Current proof|Proof|Task|Return JSON only in this schema|Left \(.*\)|Right \(.*\)|Merge these leaves for .+):$/.test(line.trim());

const trimPromptSectionBody = (body: string, limit: number): string => {
  const trimmed = body.trim();
  if (trimmed.length <= limit) return trimmed;
  const headChars = Math.max(120, Math.floor(limit * 0.55));
  const tailChars = Math.max(80, Math.floor(limit * 0.25));
  return softTrim(trimmed, headChars, tailChars);
};

export const compactTheoremPrompt = (text: string, targetChars: number): string => {
  if (text.length <= targetChars) return text;

  const lines = text.split("\n");
  const sections: Array<{ header: string; body: string }> = [];
  let currentHeader: string | undefined;
  let currentBody: string[] = [];

  const flushSection = () => {
    if (!currentHeader) return;
    sections.push({
      header: currentHeader,
      body: currentBody.join("\n").trim(),
    });
  };

  for (const line of lines) {
    if (isPromptSectionHeader(line)) {
      flushSection();
      currentHeader = line.trim();
      currentBody = [];
      continue;
    }
    currentBody.push(line);
  }
  flushSection();

  if (sections.length <= 1) {
    const compactLines = lines.filter((line) => line.trim().length > 0);
    const head = compactLines.slice(0, 24).join("\n");
    const tail = compactLines.slice(-16).join("\n");
    const merged = `${head}\n\n[... compacted context ...]\n\n${tail}`.trim();
    if (merged.length <= targetChars) return merged;
    return softTrim(merged, Math.floor(targetChars * 0.6), Math.floor(targetChars * 0.3));
  }

  const sectionWeight = (header: string): number => {
    if (/^Problem:$/.test(header)) return 3;
    if (/^Task:$/.test(header)) return 2;
    if (/^Return JSON only in this schema:$/.test(header)) return 2;
    if (/^(Left \(.*\)|Right \(.*\)|Summary:|Proof:|Current proof:|Verifier notes:|Attempts:|Attempt:|Merge these leaves for .+:)$/.test(header)) {
      return 2;
    }
    return 1;
  };

  const fixedChars = sections.reduce((total, section) => total + section.header.length + 2, 0) + Math.max(0, (sections.length - 1) * 2);
  const minBodyBudget = 120;
  const minRequired = fixedChars + (sections.length * minBodyBudget);
  if (minRequired > targetChars) {
    return softTrim(text, Math.floor(targetChars * 0.6), Math.floor(targetChars * 0.3));
  }

  const totalWeight = sections.reduce((total, section) => total + sectionWeight(section.header), 0);
  let remaining = targetChars - fixedChars;
  let remainingWeight = totalWeight;
  const rendered = sections.map((section, index) => {
    const weight = sectionWeight(section.header);
    const sectionsLeft = sections.length - index;
    const minReservedForRest = (sectionsLeft - 1) * minBodyBudget;
    const proportional = Math.floor((remaining * weight) / Math.max(1, remainingWeight));
    const budget = Math.max(minBodyBudget, Math.min(section.body.length, remaining - minReservedForRest, proportional || minBodyBudget));
    remaining -= budget;
    remainingWeight -= weight;
    return `${section.header}\n${trimPromptSectionBody(section.body, budget)}`.trim();
  }).join("\n\n");

  if (rendered.length <= targetChars) return rendered;
  return softTrim(rendered, Math.floor(targetChars * 0.65), Math.floor(targetChars * 0.25));
};

const mergeTaskHints = (
  base: AxiomTaskHints | undefined,
  extra: AxiomTaskHints | undefined
): AxiomTaskHints | undefined => {
  if (!base && !extra) return undefined;
  const preferredTools = [...new Set([...(extra?.preferredTools ?? []), ...(base?.preferredTools ?? [])])];
  return {
    ...(preferredTools.length > 0 ? { preferredTools } : {}),
    reason: extra?.reason ?? base?.reason,
    targetPath: extra?.targetPath ?? base?.targetPath,
    formalStatementPath: extra?.formalStatementPath ?? base?.formalStatementPath,
    declarationName: extra?.declarationName ?? base?.declarationName,
  };
};

const inferAxiomTaskHints = (opts: {
  readonly phase: "attempt" | "verify";
  readonly content: string;
  readonly notes?: ReadonlyArray<string>;
  readonly formalStatementPath?: string;
}): AxiomTaskHints | undefined => {
  const noteText = opts.notes?.join("\n") ?? "";
  const haystack = `${opts.content}\n${noteText}`;
  const declarationName = extractPrimaryDeclarationName(opts.content);
  const nameConflict = /already declared|has already been declared|name conflict|collid|namespace|rename/i.test(haystack);
  const haveObligation = /\bhave\b/.test(opts.content) || /have statement|callsite|extract have/i.test(noteText);
  const decompose = opts.content.length > 1_600 || /monolithic|decompose|split into lemmas|intermediate lemma/i.test(noteText);

  const preferredTools = [
    ...(nameConflict ? ["lean.rename"] : []),
    ...(haveObligation ? ["lean.have2lemma", "lean.have2sorry"] : []),
    ...(decompose && !haveObligation ? ["lean.theorem2lemma"] : []),
    ...(opts.phase === "verify" ? ["lean.theorem2sorry", "lean.verify"] : ["lean.check", "lean.repair"]),
  ];

  const reason = nameConflict
    ? "name_conflict"
    : haveObligation
      ? "extract_have_obligation"
      : decompose
        ? "decompose_theorem"
        : undefined;

  if (preferredTools.length === 0 && !reason && !opts.formalStatementPath && !declarationName) return undefined;
  return {
    ...(preferredTools.length > 0 ? { preferredTools } : {}),
    ...(reason ? { reason } : {}),
    ...(opts.formalStatementPath ? { formalStatementPath: opts.formalStatementPath } : {}),
    ...(declarationName ? { declarationName } : {}),
  };
};

export const parseTheoremConfig = (form: Record<string, string>): TheoremRunConfig =>
  normalizeTheoremConfig({
    rounds: parseFormNum(form.rounds),
    maxDepth: parseFormNum(form.depth),
    memoryWindow: parseFormNum(form.memory),
    branchThreshold: parseFormNum(form.branch),
    maxParallel: parseFormNum(form.concurrency),
  });

type TheoremWorkflowConfig = TheoremRunConfig & {
  readonly problem: string;
};

type TheoremWorkflowDeps = {
  readonly runtime: Runtime<TheoremCmd, TheoremEvent, TheoremState>;
  readonly prompts: TheoremPromptConfig;
  readonly llmText: LlmText;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly emitIndex: (event: TheoremEvent) => Promise<void>;
  readonly control?: TheoremRunControl;
  readonly axiomDelegate?: (input: {
    readonly task: string;
    readonly config?: Readonly<Record<string, unknown>>;
    readonly timeoutMs?: number;
  }) => Promise<TheoremAxiomDelegateResult>;
  readonly axiomPolicy?: TheoremAxiomPolicy;
  readonly axiomConfig?: Readonly<Record<string, unknown>>;
  readonly taskRuntime?: TheoremPlatformTaskRuntime;
  readonly createPlatformExecutionPlanes: TheoremPlatformExecutionPlaneFactory;
  readonly initialBracket?: string;
  readonly broadcast?: () => void;
};

export type TheoremRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream?: string;
  readonly problem: string;
  readonly config: TheoremRunConfig;
  readonly runtime: Runtime<TheoremCmd, TheoremEvent, TheoremState>;
  readonly prompts: TheoremPromptConfig;
  readonly llmText: LlmText;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly broadcast?: () => void;
  readonly now?: () => number;
  readonly control?: TheoremRunControl;
  readonly axiomDelegate?: TheoremWorkflowDeps["axiomDelegate"];
  readonly axiomPolicy?: TheoremAxiomPolicy;
  readonly axiomConfig?: TheoremWorkflowDeps["axiomConfig"];
  readonly taskRuntime?: TheoremPlatformTaskRuntime;
  readonly createPlatformExecutionPlanes: TheoremPlatformExecutionPlaneFactory;
  readonly initialBracket?: string;
};

// ============================================================================
// Workflow spec
// ============================================================================

const THEOREM_LIFECYCLE: RunLifecycle<TheoremWorkflowDeps, TheoremEvent, TheoremState, TheoremWorkflowConfig> = {
  reducer: reduceTheorem,
  initial: initialTheorem,
  init: (ctx, runId, config) => {
    const limits = resolveRuntimeLimits({ maxParallel: config.maxParallel });
    const domain = theoremAdaptiveDomain(limits.maxParallel, limits.maxNodes);
    return [
      { type: "problem.set", runId, problem: config.problem, agentId: "orchestrator" },
      {
        type: "run.configured",
        runId,
        agentId: "orchestrator",
        workflow: { id: THEOREM_WORKFLOW_ID, version: THEOREM_WORKFLOW_VERSION },
        config: {
          rounds: config.rounds,
          depth: config.maxDepth,
          memoryWindow: config.memoryWindow,
          branchThreshold: config.branchThreshold,
          maxParallel: limits.maxParallel,
        },
        model: ctx.model,
        promptHash: ctx.promptHash,
        promptPath: ctx.promptPath,
      },
      orchestrationConfiguredEvent(runId, domain.pack),
    ];
  },
  resume: (_ctx, runId, state, config) => {
    if (state.orchestration.domain) return [];
    const limits = resolveRuntimeLimits({ maxParallel: config.maxParallel });
    return [orchestrationConfiguredEvent(
      runId,
      theoremAdaptiveDomain(limits.maxParallel, limits.maxNodes).pack
    )];
  },
};

const THEOREM_WORKFLOW: WorkflowSpec<TheoremWorkflowDeps, TheoremWorkflowConfig, TheoremEvent, TheoremState> = {
  id: THEOREM_WORKFLOW_ID,
  version: THEOREM_WORKFLOW_VERSION,
  lifecycle: THEOREM_LIFECYCLE,
  run: async (ctx, config) => {
    const { runtime, prompts, llmText: llmRaw, apiReady, apiNote, control } = ctx;
    const { rounds, maxDepth, memoryWindow, branchThreshold, problem: inputProblem } = config;
    const limits = resolveRuntimeLimits({ maxParallel: config.maxParallel });
    const maxParallel = limits.maxParallel;
    const runId = ctx.runId;
    const domain = theoremAdaptiveDomain(maxParallel, limits.maxNodes);
    const objectiveDemands = deriveTheoremNodeDemands(inputProblem, maxParallel);
    const initialDemands = objectiveDemands.filter((demand) => demand.role === "explorer");
    const initialReflection = reflectOnOrchestration({
      runId,
      policyId: "theorem-population",
      policyVersion: domain.pack.policyVersion,
      iteration: 1,
      observation: {
        activeNodes: 1,
        pendingTasks: initialDemands.length,
        runningTasks: 0,
        failedTasks: 0,
        conflicts: 0,
        evidenceGaps: initialDemands.length,
        stagnationRounds: 0,
        goalSatisfied: false,
        note: "Initial capability demand derived from the theorem objective.",
      },
      maxNodes: domain.pack.limits.maxNodes,
      unmetDemands: initialDemands,
    });
    const persistedWorkers = Object.values(ctx.state?.orchestration.nodes ?? {})
      .filter((agent) => agent.id !== domain.pack.coordinatorId)
      .map(({ status: _status, updatedAt: _updatedAt, ...agent }) => agent);
    let dynamicAgents: TheoremNodeSpec[] = persistedWorkers.length > 0
      ? persistedWorkers.map((agent) => {
          const role = typeof agent.metadata?.role === "string" ? agent.metadata.role : "explorer";
          const podId = typeof agent.metadata?.podId === "string" ? agent.metadata.podId : agent.id;
          return {
            ...agent,
            role: role as TheoremNodeSpec["role"],
            podId,
            promptKey: agent.promptProfile ?? agent.id,
            focus: typeof agent.metadata?.focus === "string" ? agent.metadata.focus : undefined,
          };
        })
      : initialDemands.map((demand, index) => materializeTheoremNode({
          runId,
          reflectionId: initialReflection.reflectionId,
          index,
          demand,
        }));
    let registry = domain.registry.extendNodes(dynamicAgents);
    let explorers = dynamicAgents.filter((agent) => agent.role === "explorer");
    const agentById = new Map(dynamicAgents.map((agent) => [agent.id, agent] as const));
    const axiomPolicy = ctx.axiomPolicy ?? "optional";
    const axiomConfig = ctx.axiomConfig;

    const agentBranchEmitters = new Map<string, EmitFn<TheoremEvent>>();
    const agentBranchStreams = new Map<string, string>();
    const initialAgentIds = dynamicAgents.map((agent) => agent.id);

    const emitMain = async (event: TheoremEvent) => {
      await ctx.emit(event);
    };

    const ensureAgentBranch = async (agentId: string, forkAt?: number) => {
      if (agentId === "orchestrator") return;
      if (agentBranchEmitters.has(agentId)) return;

      const branchName = theoremBranchStream(ctx.stream, agentId);
      agentBranchStreams.set(agentId, branchName);

      const existing = await runtime.branch(branchName);
      let forkPoint = forkAt;
      if (!existing) {
        forkPoint = forkPoint ?? (await runtime.chain(ctx.stream)).length;
        await runtime.fork(ctx.stream, forkPoint, branchName);
        await emitMain({
          type: "branch.created",
          runId,
          branchId: branchName,
          forkAt: forkPoint,
          note: `Agent branch for ${agentId}`,
        });
      }

      const emitBranch = createQueuedEmitter({
        runtime,
        stream: branchName,
        wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as TheoremCmd),
        onEmit: () => ctx.broadcast?.(),
        onError: (err) => console.error(`theorem branch emit failed (${agentId})`, err),
      });
      agentBranchEmitters.set(agentId, emitBranch);
    };

    const shouldRouteToBranch = (event: TheoremEvent): boolean => {
      switch (event.type) {
        case "attempt.proposed":
        case "lemma.proposed":
        case "critique.raised":
        case "patch.applied":
          return true;
        default:
          return false;
      }
    };

    const shouldRouteToMain = (event: TheoremEvent): boolean => {
      switch (event.type) {
        case "summary.made":
        case "solution.finalized":
        case "verification.report":
          return true;
        default:
          return !shouldRouteToBranch(event);
      }
    };

    const emit = async (event: TheoremEvent) => {
      const agentId = "agentId" in event ? event.agentId : undefined;
      if (agentId && shouldRouteToBranch(event)) {
        await ensureAgentBranch(agentId);
        const emitBranch = agentBranchEmitters.get(agentId);
        if (emitBranch) await emitBranch(event);
        return;
      }
      if (shouldRouteToMain(event)) {
        await emitMain(event);
      }
    };

    const ensureRoleAgent = async (
      role: Exclude<TheoremNodeSpec["role"], "orchestrator" | "explorer">,
      reason: string
    ): Promise<TheoremNodeSpec> => {
      const existing = dynamicAgents.find((agent) => agent.role === role);
      if (existing) return existing;
      const demand = objectiveDemands.find((candidate) => candidate.role === role);
      if (!demand) throw new Error(`Theorem domain has no ${role} capability demand`);
      const spawned = materializeTheoremNode({
        runId,
        reflectionId: initialReflection.reflectionId,
        index: dynamicAgents.length,
        demand,
      });
      registry = registry.extendNodes([spawned]);
      dynamicAgents = [...dynamicAgents, spawned];
      agentById.set(spawned.id, spawned);
      await emit({ type: "node.spawned", runId, node: spawned, reason });
      await ensureAgentBranch(spawned.id);
      return spawned;
    };

    const capabilityForPhase = (phase: string): string => {
      switch (phase) {
        case "orchestrate": return "coordinate";
        case "attempt": return "solve";
        case "lemma": return "extract";
        case "critique": return "criticize";
        case "patch": return "repair";
        case "merge":
        case "merge.commit": return "compose";
        case "verify": return "verify";
        case "final":
        case "revise":
        case "revise.commit":
        case "finalize": return "finalize";
        default: throw new Error(`Theorem phase ${phase} has no capability binding`);
      }
    };

    let executePhase: TheoremPlatformPhaseRunner;

    const compileTheoremTaskPrompt = async (opts: {
      readonly taskId: string;
      readonly agentId: string;
      readonly capability: string;
      readonly templateKey: string;
      readonly variables: Readonly<Record<string, string>>;
      readonly constraints?: ReadonlyArray<string>;
    }) => {
      const nodeId = opts.agentId.split(":", 1)[0] ?? opts.agentId;
      const assigned = registry.assertNodeAssignment(nodeId, opts.capability);
      const compiled = compilePrompt(registry, {
        runId,
        taskId: opts.taskId,
        nodeId,
        capability: opts.capability,
        template: {
          id: `${domain.pack.id}.${opts.templateKey}`,
          version: ctx.promptHash ?? THEOREM_WORKFLOW_VERSION,
          system: prompts.system[assigned.promptProfile ?? nodeId] ?? "",
          user: prompts.user[opts.templateKey] ?? "",
        },
        variables: opts.variables,
        inputVersions: versionPromptInputs(opts.variables),
        constraints: opts.constraints,
      });
      await emit(promptCompiledEvent(compiled));
      return compiled;
    };

    const emitFailure = async (failure: NonNullable<Extract<TheoremEvent, { type: "failure.report" }>["failure"]>) => {
      await emit({
        type: "failure.report",
        runId,
        agentId: "orchestrator",
        failure,
      });
    };

    const isContextOverflow = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : String(err);
      return /context|token|maximum context|input too large|prompt too long/i.test(message);
    };

    const applyContextPolicy = async (stage: string, user: string): Promise<string> => {
      const HARD_THRESHOLD = 50_000;
      const SOFT_THRESHOLD = 12_000;
      let next = user;
      if (next.length > HARD_THRESHOLD) {
        const before = next.length;
        next = compactTheoremPrompt(next, 12_000);
        await emit({
          type: "context.pruned",
          runId,
          agentId: "orchestrator",
          stage,
          mode: "hard",
          before,
          after: next.length,
          note: "hard section-preserving trim applied",
        });
      } else if (next.length > SOFT_THRESHOLD) {
        const before = next.length;
        next = compactTheoremPrompt(next, 7_000);
        await emit({
          type: "context.pruned",
          runId,
          agentId: "orchestrator",
          stage,
          mode: "soft",
          before,
          after: next.length,
          note: "soft section-preserving trim applied",
        });
      }
      return next;
    };

    const runStartedAt = Date.now();
    const maxLlmCalls = boundedEnvInteger("ROSTER_MAX_LLM_CALLS", 64, 1, 10_000);
    const maxRunTokens = boundedEnvInteger("ROSTER_MAX_RUN_TOKENS", 250_000, 1_000, 100_000_000);
    const maxRunMs = boundedEnvInteger("ROSTER_MAX_RUN_MS", 600_000, 5_000, 86_400_000);
    let llmCalls = 0;
    let runTokens = 0;
    let budgetFailureEmitted = false;

    const failBudget = async (message: string): Promise<never> => {
      if (!budgetFailureEmitted) {
        budgetFailureEmitted = true;
        await emitFailure({
          stage: "budget",
          failureClass: "budget_exhausted",
          message,
          retryable: false,
        });
      }
      throw new Error(message);
    };

    const assertRunBudget = async (stage: string, reserveCallSlot = false): Promise<void> => {
      if (Date.now() - runStartedAt >= maxRunMs) {
        await failBudget(`Run time budget exceeded at ${stage} (${maxRunMs}ms)`);
      }
      if (llmCalls > maxLlmCalls || (reserveCallSlot && llmCalls >= maxLlmCalls)) {
        await failBudget(`Model call budget exceeded at ${stage} (${maxLlmCalls} calls)`);
      }
      if (runTokens >= maxRunTokens) {
        await failBudget(`Model token budget exceeded at ${stage} (${maxRunTokens} tokens)`);
      }
    };

    const recordModelUsage = async (call: number, usage: ModelUsage): Promise<void> => {
      runTokens += usage.totalTokens;
      await emit({ type: "model.usage", runId, call, ...usage });
    };

    const llmText = async (opts: { system?: string; user: string }): Promise<string> => {
      const stage = "agent-loop";
      if (await checkAbort(`${stage}.before_llm`)) {
        throw new RunAbortedError(`${stage}.before_llm`);
      }
      await assertRunBudget(stage, true);
      llmCalls += 1;
      const call = llmCalls;
      const pruned = await applyContextPolicy(stage, opts.user);
      try {
        const out = await llmRaw({
          system: opts.system,
          user: pruned,
          onUsage: (usage) => recordModelUsage(call, usage),
        });
        if (await checkAbort(`${stage}.after_llm`)) {
          throw new RunAbortedError(`${stage}.after_llm`);
        }
        if (runTokens > maxRunTokens) {
          await failBudget(`Model token budget exceeded after call ${call} (${runTokens}/${maxRunTokens})`);
        }
        return out;
      } catch (err) {
        if (err instanceof RunAbortedError) throw err;
        if (!isContextOverflow(err)) throw err;
        await assertRunBudget(`${stage}.overflow_retry`, true);
        llmCalls += 1;
        const retryCall = llmCalls;
        const compacted = compactTheoremPrompt(pruned, 7_000);
        await emit({
          type: "context.compacted",
          runId,
          agentId: "orchestrator",
          stage,
          reason: "overflow",
          before: pruned.length,
          after: compacted.length,
          note: "retry after overflow",
        });
        await emit({
          type: "overflow.recovered",
          runId,
          agentId: "orchestrator",
          stage,
          note: "recovered by compacting prompt and retrying once",
        });
        const out = await llmRaw({
          system: opts.system,
          user: compacted,
          onUsage: (usage) => recordModelUsage(retryCall, usage),
        });
        if (await checkAbort(`${stage}.after_overflow_retry`)) {
          throw new RunAbortedError(`${stage}.after_overflow_retry`);
        }
        return out;
      }
    };

    const checkAbort = async (stage: string): Promise<boolean> => {
      if (!control?.checkAbort) return false;
      const aborted = await control.checkAbort();
      if (!aborted) return false;
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: `canceled at ${stage}`,
      });
      return true;
    };

    const applyControlCommands = async (): Promise<void> => {
      if (!control?.pullCommands) return;
      const commands = await control.pullCommands();
      for (const command of commands) {
        const payload = command.payload ?? {};
        if (typeof payload.problem === "string" && payload.problem.trim().length > 0) {
          const nextProblem = payload.problem.trim();
          problemText = nextProblem;
          await emit({
            type: "problem.set",
            runId,
            agentId: "orchestrator",
            problem: problemText,
          });
          continue;
        }
        if (typeof payload.note === "string" && payload.note.trim().length > 0) {
          const append = `Follow-up:\n${payload.note.trim()}`;
          problemText = `${problemText}\n\n${append}`.trim();
          await emit({
            type: "problem.appended",
            runId,
            agentId: "orchestrator",
            append,
          });
        }
      }
    };

    const loadCombinedChain = async () => {
      const mainChain = await runtime.chain(ctx.stream);
      if (agentBranchStreams.size === 0) return mainChain;
      const branchChains = await Promise.all(
        [...agentBranchStreams.values()].map((stream) => runtime.chain(stream))
      );
      const combined = [...mainChain, ...branchChains.flat()];
      combined.sort((a, b) => a.ts - b.ts || a.stream.localeCompare(b.stream) || a.id.localeCompare(b.id));
      return combined;
    };

    const claimId = (prefix: string) => `${prefix}_${ctx.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const executeSinglePhase = async <Output>(opts: {
      readonly phase: string;
      readonly agentId: string;
      readonly round?: number;
      readonly run: (control: TheoremTaskExecutionControl) => Promise<Output>;
    }): Promise<Output> => {
      const results = await executePhase({
        phase: opts.phase,
        round: opts.round,
        items: [opts.agentId],
        maxParallel: 1,
        actor: (agentId) => agentId,
        run: async (_agentId, _index, execution) => {
          const details = {
            runId,
            phase: opts.phase,
            agentId: opts.agentId,
            ...(opts.round === undefined ? {} : { round: opts.round }),
          };
          await execution.checkpoint("invocation.started", details);
          await execution.failpoint("invocation.before", details);
          const output = await opts.run(execution);
          await execution.checkpoint("invocation.completed", details);
          return output;
        },
      });
      if (results.length !== 1) {
        throw new Error(`Phase ${opts.phase} for ${opts.agentId} did not produce exactly one result`);
      }
      return results[0] as Output;
    };

    const existingChain = await runtime.chain(ctx.stream);
    const resume = Boolean(ctx.resume);
    let problemText = (resume ? (ctx.state?.problem || inputProblem) : (inputProblem || ctx.state?.problem || "")).trim();

    if (!problemText) {
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: "problem required",
      });
      return;
    }

    if (!apiReady) {
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: apiNote ?? "OPENAI_API_KEY not set",
      });
      await emit({
        type: "solution.finalized",
        runId,
        agentId: "orchestrator",
        content: apiNote ?? "OPENAI_API_KEY not set",
        confidence: 0,
        gaps: ["Missing OPENAI_API_KEY"],
      });
      return;
    }

    await applyControlCommands();
    if (await checkAbort("bootstrap")) return;

    if ((ctx.state?.orchestration.reflections.length ?? 0) === 0) {
      await emit(reflectionRecordedEvent(runId, initialReflection));
    }
    const configuredAgentIds = new Set(Object.keys(ctx.state?.orchestration.nodes ?? {}));
    for (const agent of dynamicAgents) {
      if (configuredAgentIds.has(agent.id)) continue;
      await emit({
        type: "node.spawned",
        runId,
        node: agent,
        reason: initialReflection.reason,
      });
    }

    const forkPoint = (await runtime.chain(ctx.stream)).length;
    for (const agentId of initialAgentIds) {
      await ensureAgentBranch(agentId, forkPoint);
    }

    const axiomTimeoutMs = boundedEnvInteger("ROSTER_AXIOM_TIMEOUT_MS", 60_000, 5_000, 180_000);
    const axiomFailureLimit = boundedEnvInteger("ROSTER_AXIOM_FAILURE_LIMIT", 2, 1, 10);
    let consecutiveAxiomFailures = 0;
    let axiomCircuitOpen = false;
    let latestAxiomFailureEvidence: ReadonlyArray<TheoremAxiomEvidence> = [];

    const runAxiomDelegate = async (opts: {
      readonly request?: AxiomDelegatePayload;
      readonly agentId: string;
      readonly round: number;
      readonly phase: "attempt" | "verify";
      readonly targetClaimId?: string;
    }): Promise<{
      readonly summary: string;
      readonly outcome?: string;
      readonly evidence: ReadonlyArray<TheoremAxiomEvidence>;
      readonly verifiedCandidateContent?: string;
      readonly verifiedCandidateHash?: string;
      readonly verifiedFormalStatementHash?: string;
    }> => {
      const request = opts.request;
      if (!request?.task?.trim()) {
        return { summary: "", evidence: [] };
      }

      const input = {
        task: request.task,
        config: request.config,
        hints: request.hints,
        phase: opts.phase,
        round: opts.round,
        ...(opts.targetClaimId ? { targetClaimId: opts.targetClaimId } : {}),
      } as Record<string, unknown>;
      const started = Date.now();

      if (axiomCircuitOpen) {
        await emit({
          type: "tool.called",
          runId,
          agentId: opts.agentId,
          tool: "axiom.delegate",
          input,
          summary: "skipped; circuit open",
          durationMs: Date.now() - started,
          error: `axiom delegate paused after ${consecutiveAxiomFailures} consecutive failures`,
        });
        return {
          summary: `Axiom worker skipped: circuit open after ${consecutiveAxiomFailures} consecutive failures.`,
          outcome: "delegate_circuit_open",
          evidence: latestAxiomFailureEvidence,
        };
      }

      if (!ctx.axiomDelegate) {
        await emit({
          type: "tool.called",
          runId,
          agentId: opts.agentId,
          tool: "axiom.delegate",
          input,
          summary: "failed",
          durationMs: Date.now() - started,
          error: "axiom delegate unavailable",
        });
        return { summary: "Axiom worker unavailable.", outcome: "delegate_unavailable", evidence: [] };
      }

      try {
        const result = await ctx.axiomDelegate({
          task: request.task,
          config: request.config,
          timeoutMs: axiomTimeoutMs,
        });
        if (await checkAbort(`axiom.${opts.phase}.after_delegate`)) {
          throw new RunAbortedError(`axiom.${opts.phase}.after_delegate`);
        }
        const delegateFailed = result.status === "failed" || /fail|timeout|cancel/i.test(result.outcome ?? "");
        consecutiveAxiomFailures = delegateFailed ? consecutiveAxiomFailures + 1 : 0;
        axiomCircuitOpen = consecutiveAxiomFailures >= axiomFailureLimit;
        const evidence = (result.evidence ?? []).map((item) => ({
          ...item,
          phase: opts.phase,
          subJobId: result.jobId ?? item.subJobId,
          subRunId: result.runId ?? item.subRunId,
        }));
        if (delegateFailed && evidence.length > 0) latestAxiomFailureEvidence = evidence;
        else if (!delegateFailed) latestAxiomFailureEvidence = [];
        await emit({
          type: "tool.called",
          runId,
          agentId: opts.agentId,
          tool: "axiom.delegate",
          input,
          summary: `status=${result.status}${result.outcome ? `; outcome=${result.outcome}` : ""}${result.runId ? `; run=${result.runId}` : ""}`,
          durationMs: Date.now() - started,
        });
        await emit({
          type: "subagent.merged",
          runId,
          agentId: opts.agentId,
          subJobId: result.jobId ?? `axiom_${opts.round}_${Date.now().toString(36)}`,
          subRunId: result.runId ?? `axiom_${opts.round}_${Date.now().toString(36)}`,
          task: request.task,
          summary: result.summary,
          outcome: result.outcome,
          evidence,
        });
        return {
          summary: result.summary.trim(),
          outcome: result.outcome,
          evidence,
          verifiedCandidateContent: result.verifiedCandidateContent,
          verifiedCandidateHash: result.verifiedCandidateHash,
          verifiedFormalStatementHash: result.verifiedFormalStatementHash,
        };
      } catch (err) {
        if (err instanceof RunAbortedError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        consecutiveAxiomFailures += 1;
        axiomCircuitOpen = consecutiveAxiomFailures >= axiomFailureLimit;
        await emit({
          type: "tool.called",
          runId,
          agentId: opts.agentId,
          tool: "axiom.delegate",
          input,
          summary: "failed",
          durationMs: Date.now() - started,
          error: message,
        });
        return { summary: `Axiom worker failed: ${message}`, outcome: "delegate_failed", evidence: [] };
      }
    };

    const withAxiomDefaults = (request?: AxiomDelegatePayload, opts?: {
      readonly phase: "attempt" | "verify";
      readonly content: string;
      readonly notes?: ReadonlyArray<string>;
    }): AxiomDelegatePayload | undefined => {
      if (!request?.task?.trim()) return undefined;
      const formalStatementPath = typeof axiomConfig?.formalStatementPath === "string"
        ? axiomConfig.formalStatementPath
        : undefined;
      const taskHints = mergeTaskHints(
        inferAxiomTaskHints({
          phase: opts?.phase ?? "attempt",
          content: opts?.content ?? request.task,
          notes: opts?.notes,
          formalStatementPath,
        }),
        request.hints
      );
      const mergedConfig = {
        ...(axiomConfig ?? {}),
        ...(request.config ?? {}),
        ...(taskHints ? { taskHints } : {}),
        ...(opts?.phase === "verify" && axiomPolicy === "required"
          ? {
              requiredValidation: {
                kind: "axle-verify" as const,
                ...(formalStatementPath ? { formalStatementPath } : {}),
              },
            }
          : {}),
      };
      return {
        task: request.task.trim(),
        config: Object.keys(mergedConfig).length > 0 ? mergedConfig : undefined,
        hints: taskHints,
      };
    };

    const buildForcedAxiomTask = (opts: {
      readonly phase: "attempt" | "verify";
      readonly agentId: string;
      readonly round: number;
      readonly content: string;
      readonly notes?: ReadonlyArray<string>;
    }): AxiomDelegatePayload => {
      const formalStatementPath = typeof axiomConfig?.formalStatementPath === "string"
        ? axiomConfig.formalStatementPath
        : undefined;
      const taskHints = inferAxiomTaskHints({
        phase: opts.phase,
        content: opts.content,
        notes: opts.notes,
        formalStatementPath,
      });
      const intro = opts.phase === "verify"
        ? "Use AXLE as the required ground-truth verifier for this theorem roster run."
        : "Use AXLE to formalize or stress-test this theorem branch.";
      const label = opts.phase === "verify" ? "Candidate proof" : "Branch attempt";
      const requirements = opts.phase === "verify"
        ? [
            "- work in Lean 4 with Mathlib",
            "- produce or load the exact sorried formal statement for the candidate using `lean.theorem2sorry` or `lean.theorem2sorry_file`",
            "- run `lean.verify` or `lean.verify_file` against that exact formal statement as the final gate",
            "- if a theorem name conflicts with Mathlib, wrap the candidate in a unique namespace or rename the declaration before verification",
            "- if verification passes, keep the verified candidate unchanged and report the exact AXLE verification result",
            "- if verification fails, report the failure diagnostics and do not claim success",
          ]
        : [
            "- work in Lean 4 with Mathlib when formalization is needed",
            "- use AXLE check, verify, repair, simplification, or disproval tools as appropriate",
            "- explain whether the branch is valid, needs repair, or is false",
            "- if a Lean artifact is produced, keep it minimal and executable",
          ];
      return {
        task: [
          intro,
          `Problem:`,
          problemText,
          ...(opts.phase === "verify" && formalStatementPath
            ? ["", "Formal statement artifact:", formalStatementPath]
            : []),
          "",
          `${label}:`,
          opts.content,
          "",
          "Requirements:",
          ...requirements,
        ].join("\n").trim(),
        config: {
          ...(axiomConfig ?? {}),
          ...(taskHints ? { taskHints } : {}),
          ...(opts.phase === "verify" && axiomPolicy === "required"
            ? {
                requiredValidation: {
                  kind: "axle-verify" as const,
                  ...(formalStatementPath ? { formalStatementPath } : {}),
                },
              }
            : {}),
        },
        hints: taskHints,
      };
    };

    const structuredRetries = boundedEnvInteger("ROSTER_STRUCTURED_RETRIES", 2, 0, 10);

    const existingRebrackets = existingChain.filter((r) => r.body.type === "rebracket.applied") as Array<{
      body: Extract<TheoremEvent, { type: "rebracket.applied" }>;
    }>;
    let reflectionIteration = Math.max(
      1,
      existingChain.filter((receipt) => receipt.body.type === "reflection.recorded").length
    );
    const existingTopologies = existingChain.filter((receipt) => receipt.body.type === "topology.selected") as Array<{
      body: Extract<TheoremEvent, { type: "topology.selected" }>;
    }>;
    const coordinationLeaves = () => [...explorers.map((agent) => agent.id), "review"];
    const previousTopology = existingTopologies.at(-1)?.body;
    let currentTopology: CompositionTree = previousTopology
      ? parseCompositionBracket(previousTopology.bracket) ?? topologyForLeaves(coordinationLeaves())
      : topologyForLeaves(coordinationLeaves(), ctx.initialBracket);
    let currentTopologyId = previousTopology?.topologyId;
    let currentBracket = compositionBracket(currentTopology);
    if (!currentTopologyId) {
      const initialized = topologySelectedEvent({
        runId,
        operation: "initialize",
        bracket: currentBracket,
        leaves: compositionLeaves(currentTopology),
        reason: "Initial adaptive artifact frontier.",
      });
      await emit(initialized);
      currentTopologyId = initialized.topologyId;
    }
    executePhase = createTheoremPlatformPhaseRunner({
      runId,
      registry: () => registry,
      topologyVersion: () => currentTopologyId
        ?? `theorem_topology_${hashText(currentBracket).slice(0, 24)}`,
      emit: async (event) => emit(event),
      taskRuntime: ctx.taskRuntime,
      createExecutionPlanes: ctx.createPlatformExecutionPlanes,
      resolve: ({ phase, round, actor }) => {
        const nodeId = actor.split(":", 1)[0] ?? actor;
        return {
          taskId: `${phase}:r${round ?? 0}:${actor}`,
          nodeId,
          capability: capabilityForPhase(phase),
          objective: `Execute theorem ${phase} work for round ${round ?? 0}.`,
        };
      },
    });

    const summaryEvents = existingChain.filter((r) => r.body.type === "summary.made") as Array<{
      body: Extract<TheoremEvent, { type: "summary.made" }>;
    }>;
    const latestSummaryEvent = summaryEvents[summaryEvents.length - 1]?.body;
    const summaryClaimId = latestSummaryEvent?.claimId;
    let summaryText = summaryClaimId
      ? summaryEvents.filter((r) => r.body.claimId === summaryClaimId).map((r) => r.body.content).join("")
      : "";
    let focusHints: Record<string, string> = {};
    const runOrchestratorDecision = async (
      prompt: string,
      system: string,
      round: number
    ): Promise<{ decision: ParsedOrchestratorDecision; raw: string }> => executeSinglePhase({
      phase: "orchestrate",
      agentId: "orchestrator",
      round,
      run: async (execution) => {
        await execution.failpoint("llm.before", { runId, phase: "orchestrate", agentId: "orchestrator", round });
        const parsed = await callWithStructuredRetries({
          llmText,
          system,
          user: prompt,
          parse: parseOrchestratorDecision,
          retries: structuredRetries,
        });
        await execution.checkpoint("llm.after", { runId, phase: "orchestrate", agentId: "orchestrator", round });
        return { decision: parsed.value, raw: parsed.raw.trim() };
      },
    });

    const activeExplorerRoster = (): string => explorers
      .map((agent) => `${agent.id}: ${agent.focus ?? "independent proof route"}`)
      .join("\n");

    const resolveFocusHints = (requested?: Readonly<Record<string, string>>): Record<string, string> => {
      const resolved: Record<string, string> = {};
      for (const [key, value] of Object.entries(requested ?? {})) {
        const agent = explorers.find((candidate) =>
          candidate.id === key || candidate.promptProfile === key || candidate.promptKey === key
        );
        if (agent) resolved[agent.id] = value;
      }
      return resolved;
    };

    const hasSeed = existingRebrackets.some((r) => /initial bracket seed/i.test(r.body.note ?? ""));
    const completedRounds = resume ? Math.max(0, existingRebrackets.length - (hasSeed ? 1 : 0)) : 0;
    let startRound = resume ? Math.min(rounds, completedRounds + 1) : 1;
    let skipRounds = false;

    if (startRound === 1 && prompts.user.orchestrate) {
      const compiled = await compileTheoremTaskPrompt({
        taskId: "orchestrate:r0:orchestrator",
        agentId: "orchestrator",
        capability: "coordinate",
        templateKey: "orchestrate",
        variables: {
          problem: problemText,
          agents: activeExplorerRoster(),
          summary: summaryText ? `Summary:\n${summaryText}` : "",
          attempts: "(none yet)",
        },
      });
      const orchestratePrompt = compiled.user;
      const { decision, raw } = await runOrchestratorDecision(
        orchestratePrompt,
        compiled.system,
        0
      );
      const done = decision.action === "done" && summaryText.trim().length > 0;
      focusHints = resolveFocusHints(decision.focus);
      await emit({
        type: "orchestrator.decision",
        runId,
        agentId: "orchestrator",
        round: 0,
        action: done ? "done" : "continue",
        reason: decision.reason ?? "Pre-round decision",
        skipLemma: done || decision.skipLemma,
        skipCritique: done || decision.skipCritique,
        skipPatch: done || decision.skipPatch,
        skipMerge: done || decision.skipMerge,
        focus: decision.focus,
        raw,
      });
      const requestedSpawnFocuses = decision.spawn.slice(0, Math.max(0, maxParallel - explorers.length));
      if (requestedSpawnFocuses.length > 0) {
        const demands: TheoremNodeDemand[] = requestedSpawnFocuses.map((focus, index) => ({
          capability: "solve",
          objective: `Develop an orchestrator-requested independent route: ${focus}`,
          name: `Explorer ${explorers.length + index + 1}`,
          role: "explorer",
          promptKey: `explorer_${(["a", "b", "c"] as const)[(explorers.length + index) % 3]}`,
          promptProfile: `explorer_${(["a", "b", "c"] as const)[(explorers.length + index) % 3]}`,
          group: "Independent proof routes",
          focus,
          metadata: { role: "explorer", sourceRound: 0 },
        }));
        reflectionIteration += 1;
        const populationReflection = reflectOnOrchestration({
          runId,
          policyId: "theorem-orchestrator-population",
          policyVersion: domain.pack.policyVersion,
          iteration: reflectionIteration,
          observation: {
            activeNodes: dynamicAgents.length + 1,
            pendingTasks: 0,
            runningTasks: 0,
            failedTasks: 0,
            conflicts: 0,
            evidenceGaps: demands.length,
            stagnationRounds: 0,
            goalSatisfied: false,
            note: decision.reason,
          },
          maxNodes: domain.pack.limits.maxNodes,
          unmetDemands: demands,
          topology: currentTopology,
        });
        await emit(reflectionRecordedEvent(runId, populationReflection));
        for (const [index, action] of populationReflection.actions.entries()) {
          if (action.type !== "spawn") continue;
          const spawned = materializeTheoremNode({
            runId,
            reflectionId: populationReflection.reflectionId,
            index,
            demand: action.demand as TheoremNodeDemand,
          });
          registry = registry.extendNodes([spawned]);
          dynamicAgents = [...dynamicAgents, spawned];
          explorers = [...explorers, spawned];
          agentById.set(spawned.id, spawned);
          await emit({ type: "node.spawned", runId, node: spawned, reason: populationReflection.reason });
          await ensureAgentBranch(spawned.id);
          if (!currentTopologyId) throw new Error("Adaptive topology is not initialized");
          const grafted = graftCompositionLeaf(currentTopology, "review", spawned.id, "before");
          const graftEvent = topologySelectedEvent({
            runId,
            previousTopologyId: currentTopologyId,
            operation: "graft",
            previousBracket: currentBracket,
            bracket: compositionBracket(grafted),
            leaves: compositionLeaves(grafted),
            reason: `Grafted orchestrator-requested route ${spawned.name}.`,
          });
          await emit(graftEvent);
          currentTopology = grafted;
          currentTopologyId = graftEvent.topologyId;
          currentBracket = graftEvent.bracket;
        }
        focusHints = {
          ...Object.fromEntries(explorers.filter((agent) => agent.focus).map((agent) => [agent.id, agent.focus as string])),
          ...focusHints,
        };
      }
      if (done) {
        skipRounds = true;
        startRound = rounds + 1;
      }
    }

    if (startRound > rounds && !skipRounds) return;

    for (let round = startRound; round <= rounds; round += 1) {
      await applyControlCommands();
      if (await checkAbort(`round-${round}`)) return;
      await emit({
        type: "run.status",
        runId,
        status: "running",
        agentId: "orchestrator",
        note: `Round ${round}/${rounds}`,
      });

      const chainBefore = await loadCombinedChain();
      const runSliceBefore = sliceTheoremChain(chainBefore, runId);
      let memoryTruncated = false;
      const memoryFor = async (
        phase: MemoryPhase,
        chain: typeof runSliceBefore,
        targetClaimId?: string
      ) => {
        const started = Date.now();
        const input = {
          phase,
          window: memoryWindow,
          maxChars: memoryBudget(memoryWindow, phase),
          targetClaimId,
          bracket: currentBracket,
        };
        const slice = buildMemorySlice(chain, input);
        await emit({
          type: "tool.called",
          runId,
          agentId: "orchestrator",
          tool: "memory.summarize",
          input,
          summary: `chars:${slice.text.length};items:${slice.items.length};truncated:${slice.truncated ? "1" : "0"}`,
          durationMs: Date.now() - started,
        });
        if (slice.truncated) memoryTruncated = true;
        if (slice.text || slice.items.length > 0) {
          await emit({
            type: "memory.slice",
            runId,
            agentId: "orchestrator",
            phase,
            window: memoryWindow,
            bracket: currentBracket,
            maxChars: slice.maxChars,
            chars: slice.text.length,
            itemCount: slice.items.length,
            items: slice.items,
            truncated: slice.truncated,
            targetClaimId,
          });
        }
        return slice.text;
      };
      const memoryAttempt = await memoryFor("attempt", runSliceBefore);

      const roundAttempts = await executePhase({
        phase: "attempt",
        round,
        items: explorers,
        maxParallel,
        failureMode: "best-effort",
        minimumSuccesses: 1,
        actor: (agent) => agent.id,
        run: async (agent, _index, execution) => {
          const executionDetails = { runId, phase: "attempt", agentId: agent.id, round };
          await execution.checkpoint("invocation.started", executionDetails);
          const attemptId = claimId(`attempt_r${round}`);
          const focusHint = focusHints[agent.id] ?? agent.focus;
          const focusBlock = focusHint ? `Focus:\n${focusHint}\n\n` : "";
          const memoryBlock = memoryAttempt ? `Memory:\n${memoryAttempt}` : "";
          const summaryBlock = summaryText ? `Latest summary:\n${summaryText}` : "";
          const compiled = await compileTheoremTaskPrompt({
            taskId: `attempt:r${round}:${agent.id}`,
            agentId: agent.id,
            capability: "solve",
            templateKey: "attempt",
            variables: {
              problem: problemText,
              focus: focusBlock,
              memory: memoryBlock,
              summary: summaryBlock,
            },
          });
          const prompt = compiled.user;
          await execution.failpoint("llm.before", executionDetails);
          const attemptResult = await callWithStructuredRetries({
            llmText,
            system: compiled.system,
            user: prompt,
            parse: parseAttemptPayload,
            retries: structuredRetries,
          });
          await execution.checkpoint("llm.after", executionDetails);
          let content = formatAttemptPayload(attemptResult.value);
          const axiomRequest = withAxiomDefaults(attemptResult.value.axiom, {
            phase: "attempt",
            content,
          });
          if (axiomRequest?.task?.trim()) {
            await execution.failpoint("delegation.before", executionDetails);
          }
          const axiomResult = await runAxiomDelegate({
            request: axiomRequest,
            agentId: agent.id,
            round,
            phase: "attempt",
            targetClaimId: attemptId,
          });
          if (axiomRequest?.task?.trim()) {
            await execution.checkpoint("delegation.after", executionDetails);
          }
          if (axiomResult.summary) {
            content = `${content}\n\nAXIOM Worker:\n${axiomResult.summary}`.trim();
          }
          const attemptEvent: TheoremEvent = {
            type: "attempt.proposed",
            runId,
            claimId: attemptId,
            agentId: agent.id,
            content,
          };
          await execution.failpoint("receipt.before", executionDetails);
          await emit(attemptEvent);
          await execution.checkpoint("receipt.after", executionDetails);
          await execution.checkpoint("invocation.completed", executionDetails);
          return { id: attemptId, agentId: agent.id, podId: agent.podId, content };
        },
      });
      const successfulExplorerIds = new Set(roundAttempts.map((attempt) => attempt.agentId));
      const failedExplorers = explorers.filter((agent) => !successfulExplorerIds.has(agent.id));
      for (const failedExplorer of failedExplorers) {
        await emit({
          type: "node.retired",
          runId,
          nodeId: failedExplorer.id,
          reason: `Round ${round} attempt failed; removed from the active composition frontier.`,
        });
        dynamicAgents = dynamicAgents.filter((agent) => agent.id !== failedExplorer.id);
        explorers = explorers.filter((agent) => agent.id !== failedExplorer.id);
        if (!currentTopologyId) throw new Error("Adaptive topology is not initialized");
        const contracted = contractCompositionLeaf(currentTopology, failedExplorer.id);
        if (!contracted) throw new Error("Failed explorer contraction removed the complete topology");
        const contractEvent = topologySelectedEvent({
          runId,
          previousTopologyId: currentTopologyId,
          operation: "contract",
          previousBracket: currentBracket,
          bracket: compositionBracket(contracted),
          leaves: compositionLeaves(contracted),
          reason: `Contracted failed route ${failedExplorer.name}.`,
        });
        await emit(contractEvent);
        currentTopology = contracted;
        currentTopologyId = contractEvent.topologyId;
        currentBracket = contractEvent.bracket;
      }
      if (await checkAbort(`round-${round}-attempts`)) return;

      const attemptText = roundAttempts.map((a) => `# ${a.agentId}\n${a.content}`).join("\n\n");

      let skipLemma = false;
      let skipCritique = false;
      let skipPatch = false;
      let skipMerge = false;
      let stopAfterRound = false;

      if (prompts.user.orchestrate) {
        const compiled = await compileTheoremTaskPrompt({
          taskId: `orchestrate:r${round}:orchestrator`,
          agentId: "orchestrator",
          capability: "coordinate",
          templateKey: "orchestrate",
          variables: {
            problem: problemText,
            agents: activeExplorerRoster(),
            summary: summaryText ? `Summary:\n${summaryText}` : "",
            attempts: attemptText,
          },
        });
        const orchestratePrompt = compiled.user;
        const { decision, raw } = await runOrchestratorDecision(
          orchestratePrompt,
          compiled.system,
          round
        );
        const done = decision.action === "done";
        skipLemma = done || decision.skipLemma;
        skipCritique = done || decision.skipCritique;
        skipPatch = done || decision.skipPatch;
        skipMerge = done || decision.skipMerge;
        focusHints = resolveFocusHints(decision.focus);
        stopAfterRound = done;
        await emit({
          type: "orchestrator.decision",
          runId,
          agentId: "orchestrator",
          round,
          action: done ? "done" : "continue",
          reason: decision.reason,
          skipLemma,
          skipCritique,
          skipPatch,
          skipMerge,
          focus: decision.focus,
          raw,
        });
      }
      if (await checkAbort(`round-${round}-orchestrate`)) return;

      const lemmaId = claimId(`lemma_r${round}`);
      let lemmaOutput = "";
      if (!skipLemma) {
        const lemmaAgent = await ensureRoleAgent("lemma", `Round ${round} requires lemma extraction.`);
        const memoryLemma = await memoryFor("lemma", runSliceBefore);
        lemmaOutput = await executeSinglePhase({
          phase: "lemma",
          agentId: lemmaAgent.id,
          round,
          run: async (execution) => {
            const executionDetails = { runId, phase: "lemma", agentId: lemmaAgent.id, round };
            const compiled = await compileTheoremTaskPrompt({
              taskId: `lemma:r${round}:${lemmaAgent.id}`,
              agentId: lemmaAgent.id,
              capability: "extract",
              templateKey: "lemma",
              variables: {
                problem: problemText,
                memory: memoryLemma ? `Memory:\n${memoryLemma}` : "",
                attempts: attemptText,
              },
            });
            const lemmaPrompt = compiled.user;
            await execution.failpoint("llm.before", executionDetails);
            const lemmaResult = await callWithStructuredRetries({
              llmText,
              system: compiled.system,
              user: lemmaPrompt,
              parse: parseLemmaPayload,
              retries: structuredRetries,
            });
            await execution.checkpoint("llm.after", executionDetails);
            const content = formatLemmaPayload(lemmaResult.value);
            await execution.failpoint("receipt.before", executionDetails);
            await emit({
              type: "lemma.proposed",
              runId,
              claimId: lemmaId,
              agentId: lemmaAgent.id,
              content,
            });
            await execution.checkpoint("receipt.after", executionDetails);
            return content;
          },
        });
      }
      if (await checkAbort(`round-${round}-lemma`)) return;

      let patches: Array<{ id: string; targetId: string; content: string }> = [];

      const criticAgent = skipCritique
        ? undefined
        : await ensureRoleAgent("critic", `Round ${round} requires adversarial review.`);
      const critiques = !criticAgent
        ? []
        : await (async () => {
            const results = await executePhase({
              phase: "critique",
              round,
              items: roundAttempts,
              maxParallel,
              actor: (attempt) => `${criticAgent.id}:${attempt.agentId}`,
              run: async (attempt, _index, execution) => {
                const executionDetails = {
                  runId,
                  phase: "critique",
                  agentId: criticAgent.id,
                  targetAgentId: attempt.agentId,
                  round,
                };
                await execution.checkpoint("invocation.started", executionDetails);
                const critiqueId = claimId(`critique_r${round}`);
                const memoryCritique = await memoryFor("critique", runSliceBefore, attempt.id);
                const compiled = await compileTheoremTaskPrompt({
                  taskId: `critique:r${round}:${criticAgent.id}:${attempt.agentId}`,
                  agentId: criticAgent.id,
                  capability: "criticize",
                  templateKey: "critique",
                  variables: {
                    problem: problemText,
                    memory: memoryCritique ? `Memory:\n${memoryCritique}` : "",
                    attempt: attempt.content,
                  },
                });
                const critiquePrompt = compiled.user;
                await execution.failpoint("llm.before", executionDetails);
                const critiqueResult = await callWithStructuredRetries({
                  llmText,
                  system: compiled.system,
                  user: critiquePrompt,
                  parse: parseCritiquePayload,
                  retries: structuredRetries,
                });
                await execution.checkpoint("llm.after", executionDetails);
                const critiqueContent = formatCritiquePayload(critiqueResult.value);
                await execution.failpoint("receipt.before", executionDetails);
                await emit({
                  type: "critique.raised",
                  runId,
                  claimId: critiqueId,
                  agentId: criticAgent.id,
                  targetClaimId: attempt.id,
                  content: critiqueContent,
                });
                await execution.checkpoint("receipt.after", executionDetails);
                await execution.checkpoint("invocation.completed", executionDetails);
                return { id: critiqueId, targetId: attempt.id, content: critiqueContent };
              },
            });
            return results;
          })();
      if (await checkAbort(`round-${round}-critique`)) return;

      if (!skipPatch) {
        const verifierAgent = await ensureRoleAgent("verifier", `Round ${round} requires candidate repair.`);
        patches = await executePhase({
          phase: "patch",
          round,
          items: roundAttempts,
          maxParallel,
          actor: (attempt) => `${verifierAgent.id}:${attempt.agentId}`,
          run: async (attempt, _index, execution) => {
            const executionDetails = {
              runId,
              phase: "patch",
              agentId: verifierAgent.id,
              targetAgentId: attempt.agentId,
              round,
            };
            await execution.checkpoint("invocation.started", executionDetails);
            const patchId = claimId(`patch_r${round}`);
            const memoryPatch = await memoryFor("patch", runSliceBefore, attempt.id);
            const critiquesForAttempt = critiques
              .filter((critique) => critique.targetId === attempt.id)
              .map((critique) => critique.content)
              .join("\n");
            const compiled = await compileTheoremTaskPrompt({
              taskId: `patch:r${round}:${verifierAgent.id}:${attempt.agentId}`,
              agentId: verifierAgent.id,
              capability: "repair",
              templateKey: "patch",
              variables: {
                problem: problemText,
                memory: memoryPatch ? `Memory:\n${memoryPatch}` : "",
                attempt: attempt.content,
                critiques: critiquesForAttempt || "No critique.",
              },
            });
            const patchPrompt = compiled.user;
            await execution.failpoint("llm.before", executionDetails);
            const patchResult = await callWithStructuredRetries({
              llmText,
              system: compiled.system,
              user: patchPrompt,
              parse: parsePatchPayload,
              retries: structuredRetries,
            });
            await execution.checkpoint("llm.after", executionDetails);
            const patchContent = formatPatchPayload(patchResult.value);
            await execution.failpoint("receipt.before", executionDetails);
            await emit({
              type: "patch.applied",
              runId,
              claimId: patchId,
              agentId: verifierAgent.id,
              targetClaimId: attempt.id,
              content: patchContent,
            });
            await execution.checkpoint("receipt.after", executionDetails);
            await execution.checkpoint("invocation.completed", executionDetails);
            return { id: patchId, targetId: attempt.id, content: patchContent };
          },
        });
      }
      if (await checkAbort(`round-${round}-patch`)) return;

      const chainAfterCrit = await loadCombinedChain();
      const runSliceAfterCrit = sliceTheoremChain(chainAfterCrit, runId);
      const memoryMerge = skipMerge ? "" : await memoryFor("merge", runSliceAfterCrit);

      type MergeValue = { text: string; uses: string[]; version: string };
      const criticPodUses = [
        !skipLemma && lemmaOutput.trim() ? lemmaId : undefined,
        ...critiques.map((c) => c.id),
        ...patches.map((p) => p.id),
      ].filter((value): value is string => Boolean(value));
      const criticText = [
        lemmaOutput.trim(),
        ...critiques.map((c) => c.content.trim()),
        ...patches.map((p) => p.content.trim()),
      ].filter(Boolean).join("\n\n");
      const leafOutputs: Record<string, MergeValue> = Object.fromEntries([
        ...roundAttempts.map((attempt) => [attempt.agentId, {
          text: compactTheoremPrompt(attempt.content, 8_000),
          uses: [attempt.id],
          version: hashText(`${attempt.agentId}|${attempt.id}|${attempt.content}`),
        } satisfies MergeValue] as const),
        ["review", {
          text: criticText,
          uses: criticPodUses,
          version: hashText(`review|${criticPodUses.join("|")}|${criticText}`),
        } satisfies MergeValue] as const,
      ]);

      const mergeTree = currentTopology;
      const mergePlan = buildVersionedMergePlan({
        runId,
        round,
        bracket: currentBracket,
        tree: mergeTree,
        maxDepth,
        sourceVersions: Object.fromEntries(
          Object.entries(leafOutputs).map(([podId, value]) => [`pod:${podId}`, value.version])
        ),
        leafLabel: (leaf) => leaf === "review" ? "Review and synthesis" : agentById.get(leaf)?.name ?? leaf,
      });
      const mergeLedger = new CrdtMergeLedger();
      if (!skipMerge) {
        await emit({
          type: "merge.frontier.selected",
          runId,
          agentId: "orchestrator",
          planVersion: mergePlan.planVersion,
          round,
          bracket: mergePlan.bracket,
          sourceVersions: mergePlan.sourceVersions,
          steps: mergePlan.steps,
        });
      }

      const synthesizerAgent = await ensureRoleAgent(
        "synthesizer",
        skipMerge ? "A final proof must be synthesized." : `Round ${round} requires artifact composition.`
      );

      const publishMergeProposal = async (opts: {
        readonly step: VersionedMergeStep;
        readonly content: string;
        readonly uses: ReadonlyArray<string>;
        readonly inputVersions: ReadonlyArray<string>;
        readonly execution: TheoremTaskExecutionControl;
      }) => {
        const executionDetails = {
          runId,
          phase: "merge",
          agentId: synthesizerAgent.id,
          mergeId: opts.step.mergeId,
          round,
        };
        const proposal = createCrdtMergeProposal({
          mergeId: opts.step.mergeId,
          planVersion: mergePlan.planVersion,
          inputVersions: opts.inputVersions,
          outputHash: hashText(opts.content),
          boundaryHash: opts.step.boundaryHash,
          content: opts.content,
          inputClaimIds: opts.uses,
        });
        const update = createMergeProposalUpdate(proposal);
        await opts.execution.checkpoint("proposal.after", executionDetails);
        await opts.execution.failpoint("crdt.apply.before", executionDetails);
        mergeLedger.apply(update);
        await opts.execution.checkpoint("crdt.apply.after", executionDetails);
        return proposal;
      };

      const findMergeNode = (
        node: BracketTree,
        targetBracket: string
      ): [BracketTree, BracketTree] | undefined => {
        if (typeof node === "string") return undefined;
        if (bracketString(node) === targetBracket) return node;
        return findMergeNode(node[0], targetBracket) ?? findMergeNode(node[1], targetBracket);
      };

      if (skipMerge) {
        summaryText = [attemptText, lemmaOutput].filter(Boolean).join("\n\n");
        mergeLedger.destroy();
      } else {
        const valuesByRef = new Map<string, MergeValue>(
          Object.entries(leafOutputs).map(([podId, value]) => [`pod:${podId}`, value])
        );
        const pending = new Map(mergePlan.steps.map((step) => [step.mergeId, step] as const));

        try {
          while (pending.size > 0) {
            const ready = mergePlan.steps.filter((step) =>
              pending.has(step.mergeId) && step.inputRefs.every((ref) => valuesByRef.has(ref))
            );
            if (ready.length === 0) {
              throw new Error(`Merge plan ${mergePlan.planVersion} has no executable frontier`);
            }

            await executePhase({
              phase: "merge",
              round,
              items: ready,
              maxParallel,
              actor: (step) => `${synthesizerAgent.id}:${step.mergeId}`,
              run: async (step, _index, execution) => {
                const executionDetails = {
                  runId,
                  phase: "merge",
                  agentId: synthesizerAgent.id,
                  mergeId: step.mergeId,
                  round,
                };
                await execution.checkpoint("invocation.started", executionDetails);
                const node = findMergeNode(mergeTree, step.bracket);
                if (!node) throw new Error(`Merge node ${step.bracket} is missing from plan ${mergePlan.planVersion}`);
                const entries = step.inputRefs.map((ref) => {
                  const value = valuesByRef.get(ref);
                  if (!value) throw new Error(`Merge ${step.mergeId} is missing input ${ref}`);
                  return value;
                });
                const uses = [...new Set(entries.flatMap((entry) => entry.uses))];
                const mergeLeaves = step.dependsOn.length === 0;
                const variables: Record<string, string> = mergeLeaves
                  ? {
                      problem: problemText,
                      memory: memoryMerge ? `Memory:\n${memoryMerge}` : "",
                      payload: step.inputRefs
                        .map((ref, entryIndex) => `${ref.replace(/^pod:/, "")}:\n${entries[entryIndex]?.text ?? ""}`)
                        .join("\n\n"),
                      bracket: step.bracket,
                    }
                  : {
                      problem: problemText,
                      memory: memoryMerge ? `Memory:\n${memoryMerge}` : "",
                      left: entries[0]?.text ?? "",
                      right: entries[1]?.text ?? "",
                      left_bracket: bracketString(node[0]),
                      right_bracket: bracketString(node[1]),
                      bracket: step.bracket,
                    };
                const compiled = await compileTheoremTaskPrompt({
                  taskId: `merge:r${round}:${synthesizerAgent.id}:${step.mergeId}`,
                  agentId: synthesizerAgent.id,
                  capability: "compose",
                  templateKey: mergeLeaves ? "merge_leaves" : "merge_pair",
                  variables,
                });
                const mergePrompt = compiled.user;
                await execution.failpoint("llm.before", executionDetails);
                const merged = await callWithStructuredRetries({
                  llmText,
                  system: compiled.system,
                  user: mergePrompt,
                  parse: parseMergePayload,
                  retries: structuredRetries,
                });
                await execution.checkpoint("llm.after", executionDetails);
                const proposal = await publishMergeProposal({
                  step,
                  content: formatMergePayload(merged.value),
                  uses,
                  inputVersions: entries.map((entry) => entry.version),
                  execution,
                });
                await execution.checkpoint("invocation.completed", executionDetails);
                return { step, proposal };
              },
            });

            const projection = mergeLedger.project(mergePlan);
            const accepted: Array<{
              readonly step: VersionedMergeStep;
              readonly projection: Extract<CrdtMergeStepProjection, { readonly status: "accepted" }>;
            }> = [];
            for (const step of ready) {
              const projected = projection.steps[step.mergeId];
              if (projected?.status === "accepted") {
                accepted.push({ step, projection: projected });
                continue;
              }
              const invalid = projection.invalidProposals.find((candidate) => candidate.mergeId === step.mergeId);
              const reason = projected?.status === "conflict"
                ? "output_conflict"
                : invalid?.reason ?? "dependency_incomplete";
              const detail = projected?.detail ?? `CRDT projection missing for ${step.mergeId}`;
              const proposalIds = projected && "proposals" in projected
                ? projected.proposals.map((proposal) => proposal.proposalId)
                : [];
              const compositionReason = reason === "dependency_incomplete"
                  ? "missing_evidence"
                  : reason;
              await emit({
                type: "composition.rejected",
                runId,
                compositionId: step.mergeId,
                proposalId: proposalIds[0],
                reason: compositionReason,
                detail,
              });
              throw new Error(`merge ${step.mergeId} unresolved by CRDT projection: ${reason} (${detail})`);
            }

            const completed = await executePhase({
              phase: "merge.commit",
              round,
              items: accepted,
              maxParallel,
              actor: ({ step }) => `${synthesizerAgent.id}:${step.mergeId}`,
              run: async ({ step, projection: resolved }, _index, execution) => {
                const executionDetails = {
                  runId,
                  phase: "merge.commit",
                  agentId: synthesizerAgent.id,
                  mergeId: step.mergeId,
                  round,
                };
                const proposal = resolved.proposal;
                const outputClaimId = `merge_r${round}_${resolved.resolutionId.slice(0, 16)}`;
                const inputVersions = Object.fromEntries(
                  step.inputRefs.map((ref, index) => [ref, proposal.inputVersions[index] ?? ""])
                );
                const compositionContract = {
                  compositionId: proposal.mergeId,
                  planVersion: proposal.planVersion,
                  boundaryHash: proposal.boundaryHash,
                  inputVersions,
                  requiredEvidenceKinds: ["crdt-resolution"],
                } as const;
                const compositionProposal = createCompositionProposal({
                  compositionId: proposal.mergeId,
                  planVersion: proposal.planVersion,
                  nodeId: synthesizerAgent.id,
                  capability: "compose",
                  boundaryHash: proposal.boundaryHash,
                  inputVersions,
                  outputHash: proposal.outputHash,
                  content: proposal.content,
                  evidence: [{
                    id: `evidence-${resolved.resolutionId}`,
                    kind: "crdt-resolution",
                    verdict: "pass",
                    artifactHash: proposal.outputHash,
                  }],
                });
                await execution.checkpoint("invocation.started", executionDetails);
                await execution.failpoint("apply.before", executionDetails);
                await emit(inlineArtifactPublishedEvent({
                  runId,
                  artifactId: outputClaimId,
                  origin: "task",
                  outputKey: `merge:${step.mergeId}`,
                  taskId: `merge.commit:r${round}:${synthesizerAgent.id}:${step.mergeId}`,
                  nodeId: synthesizerAgent.id,
                  kind: "proof.merge",
                  inputVersions,
                }, proposal.content));
                await emit(compositionProposedEvent(runId, compositionProposal));
                const composition = certifyComposition({
                  registry,
                  contract: compositionContract,
                  proposal: compositionProposal,
                });
                if (!composition.ok) {
                  await emit({
                    type: "composition.rejected",
                    runId,
                    compositionId: compositionContract.compositionId,
                    proposalId: compositionProposal.proposalId,
                    reason: composition.reason,
                    detail: composition.detail,
                  });
                  throw new Error(`Composition ${compositionContract.compositionId} rejected: ${composition.detail}`);
                }
                await emit(compositionCertifiedEvent(runId, composition.certification));
                await execution.checkpoint("apply.after", executionDetails);
                await emit({
                  type: "summary.made",
                  runId,
                  claimId: outputClaimId,
                  agentId: synthesizerAgent.id,
                  bracket: step.bracket,
                  content: proposal.content,
                  uses: [...proposal.inputClaimIds],
                });
                await execution.checkpoint("receipt.after", executionDetails);
                await execution.checkpoint("invocation.completed", executionDetails);
                return {
                  step,
                  value: {
                    text: proposal.content,
                    uses: [...proposal.inputClaimIds],
                    version: proposal.outputHash,
                  } satisfies MergeValue,
                };
              },
            });
            for (const result of completed) {
              valuesByRef.set(result.step.mergeId, result.value);
              pending.delete(result.step.mergeId);
            }
          }

          const rootStep = mergePlan.steps[mergePlan.steps.length - 1];
          const merged = rootStep ? valuesByRef.get(rootStep.mergeId) : undefined;
          if (!merged) throw new Error(`Merge plan ${mergePlan.planVersion} did not produce a root output`);
          summaryText = merged.text;
        } finally {
          mergeLedger.destroy();
        }
      }
      if (await checkAbort(`round-${round}-merge`)) return;

      const chainAfterRound = await loadCombinedChain();
      const runSlice = sliceTheoremChain(chainAfterRound, runId);
      const evidence = evaluateRoundRebracketEvidence(runSlice, round, branchThreshold);
      const agentToLeaf = new Map(dynamicAgents.map((agent) => [
        agent.id,
        agent.role === "explorer" ? agent.id : "review",
      ] as const));
      const affinities = computeTopologyWeights(runSlice, agentToLeaf);
      const expansionDemand: TheoremNodeDemand | undefined = evidence.shouldRebracket && round < rounds && !stopAfterRound
        ? {
            capability: "solve",
            objective: `Open a new proof route after reflection ${reflectionIteration + 1}.`,
            name: `Explorer ${explorers.length + 1}`,
            role: "explorer",
            promptKey: `explorer_${(["a", "b", "c"] as const)[explorers.length % 3]}`,
            promptProfile: `explorer_${(["a", "b", "c"] as const)[explorers.length % 3]}`,
            group: "Independent proof routes",
            focus: `Attack the unresolved evidence from round ${round} without reusing the current merge assumptions.`,
            metadata: { role: "explorer", sourceRound: round },
          }
        : undefined;
      reflectionIteration += 1;
      const reflection = reflectOnOrchestration({
        runId,
        policyId: "theorem-reflection",
        policyVersion: domain.pack.policyVersion,
        iteration: reflectionIteration,
        observation: {
          activeNodes: dynamicAgents.length + 1,
          pendingTasks: 0,
          runningTasks: 0,
          failedTasks: runSlice.reduce(
            (total, receipt) => receipt.body.type === "task.graph.projected"
              ? total + receipt.body.graph.tasks.filter((task) => task.status === "failed").length
              : total,
            0,
          ),
          conflicts: runSlice.filter((receipt) => receipt.body.type === "composition.rejected").length,
          evidenceGaps: evidence.shouldRebracket ? 1 : 0,
          stagnationRounds: evidence.shouldRebracket ? 1 : 0,
          goalSatisfied: stopAfterRound,
          note: evidence.note,
        },
        maxNodes: domain.pack.limits.maxNodes,
        unmetDemands: expansionDemand ? [expansionDemand] : [],
        retirableNodeIds: !evidence.shouldRebracket && round < rounds && explorers.length > 2
          ? [explorers[explorers.length - 1]?.id ?? ""]
          : [],
        topology: currentTopology,
        affinities,
        topologyHysteresis: 0.1,
      });
      await emit(reflectionRecordedEvent(runId, reflection));
      await emit({
        type: "merge.evidence.computed",
        runId,
        agentId: "orchestrator",
        mergePolicyId: "tamari-local-reflection",
        mergePolicyVersion: "2.0.0",
        note: `${evidence.note}; ${reflection.reason}`,
      });
      let mergeReason = "rotation skipped";
      const rotation = reflection.actions.find((action) => action.type === "rebracket");
      if (rotation?.type === "rebracket") {
        const nextTree = parseCompositionBracket(rotation.bracket);
        if (!nextTree || !currentTopologyId) throw new Error("Adaptive rebracketing produced an invalid topology");
        const topologyEvent = topologySelectedEvent({
          runId,
          previousTopologyId: currentTopologyId,
          operation: "rotate",
          previousBracket: currentBracket,
          bracket: rotation.bracket,
          leaves: compositionLeaves(nextTree),
          direction: rotation.direction,
          score: rotation.score,
          reason: reflection.reason,
        });
        await emit(topologyEvent);
        currentTopology = nextTree;
        currentTopologyId = topologyEvent.topologyId;
        currentBracket = rotation.bracket;
        mergeReason = reflection.reason;
        await emit({
          type: "merge.candidate.scored",
          runId,
          agentId: "orchestrator",
          mergePolicyId: "tamari-local-reflection",
          candidateId: rotation.bracket,
          score: { coordination: rotation.score, gain: rotation.gain },
        });
        await emit({
          type: "rebracket.applied",
          runId,
          agentId: "orchestrator",
          bracket: currentBracket,
          score: evidence.score,
          note: `${reflection.reason}; ${evidence.note}${memoryTruncated ? "; memory truncated" : "; memory stable"}`,
        });
      } else {
        await emit({
          type: "rebracket.applied",
          runId,
          agentId: "orchestrator",
          bracket: currentBracket,
          score: evidence.score,
          note: `Rotation skipped (${evidence.note}${memoryTruncated ? "; memory truncated" : "; memory stable"})`,
        });
      }
      await emit({
        type: "merge.applied",
        runId,
        agentId: "orchestrator",
        mergePolicyId: "tamari-local-reflection",
        mergePolicyVersion: "2.0.0",
        candidateId: currentBracket,
        reason: mergeReason,
      });

      for (const [index, action] of reflection.actions.entries()) {
        if (action.type !== "spawn") continue;
        const demand = action.demand as TheoremNodeDemand;
        const spawned = materializeTheoremNode({
          runId,
          reflectionId: reflection.reflectionId,
          index,
          demand,
        });
        registry = registry.extendNodes([spawned]);
        dynamicAgents = [...dynamicAgents, spawned];
        explorers = [...explorers, spawned];
        agentById.set(spawned.id, spawned);
        await emit({ type: "node.spawned", runId, node: spawned, reason: reflection.reason });
        await ensureAgentBranch(spawned.id);
        if (!currentTopologyId) throw new Error("Adaptive topology is not initialized");
        const grafted = graftCompositionLeaf(currentTopology, "review", spawned.id, "before");
        const graftEvent = topologySelectedEvent({
          runId,
          previousTopologyId: currentTopologyId,
          operation: "graft",
          previousBracket: currentBracket,
          bracket: compositionBracket(grafted),
          leaves: compositionLeaves(grafted),
          reason: `Grafted ${spawned.name} into the active artifact frontier.`,
        });
        await emit(graftEvent);
        currentTopology = grafted;
        currentTopologyId = graftEvent.topologyId;
        currentBracket = graftEvent.bracket;
      }

      for (const action of reflection.actions) {
        if (action.type !== "retire") continue;
        const retired = dynamicAgents.find((agent) => agent.id === action.nodeId);
        if (!retired || retired.role !== "explorer" || !currentTopologyId) continue;
        await emit({ type: "node.retired", runId, nodeId: retired.id, reason: reflection.reason });
        dynamicAgents = dynamicAgents.filter((agent) => agent.id !== retired.id);
        explorers = explorers.filter((agent) => agent.id !== retired.id);
        const contracted = contractCompositionLeaf(currentTopology, retired.id);
        if (!contracted) throw new Error("Adaptive retirement removed the complete topology");
        const contractEvent = topologySelectedEvent({
          runId,
          previousTopologyId: currentTopologyId,
          operation: "contract",
          previousBracket: currentBracket,
          bracket: compositionBracket(contracted),
          leaves: compositionLeaves(contracted),
          reason: `Contracted redundant route ${retired.name}.`,
        });
        await emit(contractEvent);
        currentTopology = contracted;
        currentTopologyId = contractEvent.topologyId;
        currentBracket = contractEvent.bracket;
      }

      if (stopAfterRound) break;
    }

    if (await checkAbort("finalize")) return;
    const synthesizerAgent = await ensureRoleAgent("synthesizer", "A final proof must be synthesized.");
    const verifierAgent = await ensureRoleAgent("verifier", "The final proof requires verification.");

    const endMarker = "END_OF_PROOF";
    const finalId = claimId("solution");

    const trimProof = (text: string): { content: string; gaps: string[]; confidence: number } => {
      let confidence = 0.5;
      const confLine = text.split("\n").find((line) => line.toLowerCase().startsWith("confidence:"));
      if (confLine) {
        const value = Number(confLine.replace(/confidence:/i, "").trim());
        if (!Number.isNaN(value)) confidence = Math.max(0, Math.min(1, value));
      }
      const trimmed = text.includes(endMarker)
        ? text.split(endMarker)[0].trim()
        : text.trim();
      const gaps = text.includes(endMarker) ? [] : ["Missing END_OF_PROOF marker"];
      return { content: trimmed, gaps, confidence };
    };

    const proofCandidate = (payload: ProofPayload): { content: string; gaps: string[]; confidence: number } => {
      const trimmed = trimProof(formatProofPayload(payload));
      return {
        content: trimmed.content,
        gaps: [...new Set([...payload.gaps, ...trimmed.gaps])],
        confidence: payload.confidence ?? trimmed.confidence,
      };
    };

    const verifyProof = async (proof: string): Promise<{
      readonly status: "valid" | "needs" | "false";
      readonly trust: "model" | "formal";
      readonly report: string;
      readonly evidence?: TheoremAxiomEvidence;
      readonly verifiedContent?: string;
    }> => executeSinglePhase({
      phase: "verify",
      agentId: verifierAgent.id,
      round: rounds,
      run: async (execution) => {
        const executionDetails = { runId, phase: "verify", agentId: verifierAgent.id, round: rounds };
        const compiled = await compileTheoremTaskPrompt({
          taskId: `verify:r${rounds}:${verifierAgent.id}:${hashText(proof).slice(0, 12)}`,
          agentId: verifierAgent.id,
          capability: "verify",
          templateKey: "verify",
          variables: { proof },
        });
        const verifyPrompt = compiled.user;
        await execution.failpoint("llm.before", executionDetails);
        const verifyResult = await callWithStructuredRetries({
          llmText,
          system: compiled.system,
          user: verifyPrompt,
          parse: parseVerifyPayload,
          retries: structuredRetries,
        });
        await execution.checkpoint("llm.after", executionDetails);
        let verifyOutput = formatVerifyPayload(verifyResult.value);
        const verifyAxiomRequest = withAxiomDefaults(verifyResult.value.axiom, {
          phase: "verify",
          content: proof,
          notes: verifyResult.value.notes,
        })
          ?? (axiomPolicy === "required"
            ? buildForcedAxiomTask({
                phase: "verify",
                agentId: verifierAgent.id,
                round: rounds,
                content: proof,
                notes: verifyResult.value.notes,
              })
            : undefined);
        if (verifyAxiomRequest?.task?.trim()) {
          await execution.failpoint("delegation.before", executionDetails);
        }
        const axiomResult = await runAxiomDelegate({
          request: verifyAxiomRequest,
          agentId: verifierAgent.id,
          round: rounds,
          phase: "verify",
          targetClaimId: finalId,
        });
        if (verifyAxiomRequest?.task?.trim()) {
          await execution.checkpoint("delegation.after", executionDetails);
        }
        if (axiomResult.summary) {
          verifyOutput = `${verifyOutput}\n\nAXIOM Worker:\n${axiomResult.summary}`.trim();
        }
        const finalVerifyEvidence = [...axiomResult.evidence].reverse().find((item) =>
          item.phase === "verify" && (item.tool === "lean.verify" || item.tool === "lean.verify_file")
        );
        let verifiedContent = axiomResult.verifiedCandidateContent;
        let status = verifyResult.value.status;
        let trust: "model" | "formal" = "model";

        if (axiomPolicy === "required") {
          if (!finalVerifyEvidence) {
            status = "needs";
            verifyOutput = `${verifyOutput}\n\nAXIOM verification evidence missing: final queued subrun did not emit successful lean.verify evidence.`.trim();
          } else if (!finalVerifyEvidence.ok) {
            status = verifyResult.value.status === "false" ? "false" : "needs";
          } else if (
            !verifiedContent
            || !axiomResult.verifiedCandidateHash
            || hashText(verifiedContent) !== axiomResult.verifiedCandidateHash
            || finalVerifyEvidence.candidateHash !== axiomResult.verifiedCandidateHash
            || finalVerifyEvidence.formalStatementHash !== axiomResult.verifiedFormalStatementHash
          ) {
            status = "needs";
            verifiedContent = undefined;
            verifyOutput = `${verifyOutput}\n\nAXIOM artifact mismatch: verified candidate hash or formal-statement hash did not match the merged theorem artifact.`.trim();
          } else {
            status = "valid";
            trust = "formal";
          }
        } else if (finalVerifyEvidence?.ok && verifiedContent && axiomResult.verifiedCandidateHash === hashText(verifiedContent)) {
          status = "valid";
          trust = "formal";
        }

        await execution.failpoint("receipt.before", executionDetails);
        await emit({
          type: "verification.report",
          runId,
          agentId: verifierAgent.id,
          status,
          trust,
          content: verifyOutput.trim(),
          evidence: finalVerifyEvidence,
        });
        await execution.checkpoint("receipt.after", executionDetails);
        return {
          status,
          trust,
          report: verifyOutput.trim(),
          evidence: finalVerifyEvidence,
          verifiedContent,
        };
      },
    });

    const passKRaw = Number.parseInt(process.env.THEOREM_PASS_K ?? "2", 10);
    const passK = clampNumber(Number.isFinite(passKRaw) ? passKRaw : 2, 1, 4);
    const finalVariables = {
      problem: problemText,
      summary: summaryText ? `Summary:\n${summaryText}` : "",
    };

    const candidateRuns: Array<{
      content: string;
      gaps: string[];
      confidence: number;
      verify: {
        status: "valid" | "needs" | "false";
        trust: "model" | "formal";
        report: string;
        evidence?: TheoremAxiomEvidence;
        verifiedContent?: string;
      };
    }> = [];
    const statusScore = (status: "valid" | "needs" | "false"): number =>
      status === "valid" ? 2 : status === "needs" ? 1 : 0;

    for (let k = 0; k < passK; k += 1) {
      const compiled = await compileTheoremTaskPrompt({
        taskId: `final:r${rounds}:${synthesizerAgent.id}:candidate-${k + 1}`,
        agentId: synthesizerAgent.id,
        capability: "finalize",
        templateKey: "final",
        variables: finalVariables,
        constraints: passK > 1
          ? [`Candidate ${k + 1}/${passK}: prefer a distinct valid route if possible.`]
          : undefined,
      });
      const candidatePrompt = compiled.user;
      const finalResult = await executeSinglePhase({
        phase: "final",
        agentId: `${synthesizerAgent.id}:candidate-${k + 1}`,
        round: rounds,
        run: async (execution) => {
          const executionDetails = {
            runId,
            phase: "final",
            agentId: synthesizerAgent.id,
            candidate: k + 1,
            round: rounds,
          };
          await execution.failpoint("llm.before", executionDetails);
          const result = await callWithStructuredRetries({
            llmText,
            system: compiled.system,
            user: candidatePrompt,
            parse: parseProofPayload,
            retries: structuredRetries,
          });
          await execution.checkpoint("llm.after", executionDetails);
          return result;
        },
      });
      const trimmed = proofCandidate(finalResult.value);
      const verify = await verifyProof(trimmed.content);
      candidateRuns.push({
        content: verify.verifiedContent ?? trimmed.content,
        gaps: trimmed.gaps,
        confidence: trimmed.confidence,
        verify,
      });
    }

    candidateRuns.sort((a, b) =>
      statusScore(b.verify.status) - statusScore(a.verify.status)
      || b.confidence - a.confidence
    );
    const bestCandidate = candidateRuns[0];
    if (!bestCandidate) {
      throw new Error("No final proof candidate generated");
    }
    let { content, gaps, confidence, verify } = bestCandidate;

    const maxVerifyRounds = 3;
    for (let i = 0; i < maxVerifyRounds && verify.status !== "valid"; i += 1) {
      const verifyReport = `${verify.report}\n\nRequirements:\n- Address each verifier note explicitly.\n- Add a short \"Resolution checklist\" section mapping each note to the fix.\n- If a note cannot be resolved, add a GAP with the reason.\n- Keep the same format and end with END_OF_PROOF.`;
      const compiled = await compileTheoremTaskPrompt({
        taskId: `revise:r${rounds}:${synthesizerAgent.id}:revision-${i + 1}`,
        agentId: synthesizerAgent.id,
        capability: "finalize",
        templateKey: "revise",
        variables: {
          problem: problemText,
          verify_report: verifyReport,
          proof: content,
        },
      });
      const revisePrompt = compiled.user;
      const revised = await executeSinglePhase({
        phase: "revise",
        agentId: `${synthesizerAgent.id}:revision-${i + 1}`,
        round: rounds,
        run: async (execution) => {
          const executionDetails = {
            runId,
            phase: "revise",
            agentId: synthesizerAgent.id,
            revision: i + 1,
            round: rounds,
          };
          await execution.failpoint("llm.before", executionDetails);
          const result = await callWithStructuredRetries({
            llmText,
            system: compiled.system,
            user: revisePrompt,
            parse: parseProofPayload,
            retries: structuredRetries,
          });
          await execution.checkpoint("llm.after", executionDetails);
          return result;
        },
      });
      const next = proofCandidate(revised.value);
      content = next.content;
      gaps = next.gaps;
      confidence = next.confidence;
      await executeSinglePhase({
        phase: "revise.commit",
        agentId: synthesizerAgent.id,
        round: rounds,
        run: async (execution) => {
          const executionDetails = {
            runId,
            phase: "revise.commit",
            agentId: synthesizerAgent.id,
            revision: i + 1,
            round: rounds,
          };
          await execution.failpoint("receipt.before", executionDetails);
          await emit({
            type: "patch.applied",
            runId,
            claimId: claimId("solution_patch"),
            agentId: synthesizerAgent.id,
            targetClaimId: finalId,
            content,
          });
          await execution.checkpoint("receipt.after", executionDetails);
        },
      });
      verify = await verifyProof(content);
      if (verify.verifiedContent) {
        content = verify.verifiedContent;
      }
    }

    const mergedGaps = verify.status === "valid"
      ? gaps
      : [...gaps, `Verifier status: ${verify.status}`];
    const noteLine = verify.report.split("\n").find((line) => line.toLowerCase().startsWith("notes:"));
    const failureDetail = noteLine ? noteLine.replace(/notes:/i, "").trim() : `Verifier status: ${verify.status}`;
    const completionNotes = [
      verify.status === "valid" && verify.trust === "model" ? "Model verified; formal verification not established" : undefined,
      mergedGaps.length > 0 ? `${mergedGaps.length} declared gap(s)` : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    const note = verify.status === "valid"
      ? completionNotes.join("; ") || undefined
      : `Final verification failed: ${failureDetail}`;
    const terminalVerificationFailure = axiomPolicy === "required" && verify.status !== "valid";
    if (await checkAbort("finalize.commit")) return;
    await assertRunBudget("finalize.commit");
    await executeSinglePhase({
      phase: "finalize",
      agentId: "orchestrator",
      round: rounds,
      run: async (execution) => {
        const executionDetails = { runId, phase: "finalize", agentId: "orchestrator", round: rounds };
        await execution.failpoint("solution.before", executionDetails);
        const inputVersions = {
          summary: hashText(summaryText),
          proof: hashText(content),
        };
        const finalContract = {
          compositionId: "theorem.final",
          planVersion: `${THEOREM_WORKFLOW_ID}@${THEOREM_WORKFLOW_VERSION}`,
          boundaryHash: hashText(`${THEOREM_WORKFLOW_ID}|final|summary|proof`),
          inputVersions,
          requiredEvidenceKinds: [verify.trust === "formal" ? "formal-verification" : "model-verification"],
        } as const;
        const finalProposal = createCompositionProposal({
          compositionId: finalContract.compositionId,
          planVersion: finalContract.planVersion,
          nodeId: synthesizerAgent.id,
          capability: "finalize",
          boundaryHash: finalContract.boundaryHash,
          inputVersions,
          content,
          evidence: [{
            id: `evidence-${hashText(`${runId}|verification|${verify.status}|${hashText(verify.report)}`).slice(0, 24)}`,
            kind: verify.trust === "formal" ? "formal-verification" : "model-verification",
            verdict: verify.status === "valid" ? "pass" : "fail",
            artifactHash: verify.evidence?.candidateHash ?? hashText(content),
          }],
        });
        await emit(inlineArtifactPublishedEvent({
          runId,
          artifactId: finalId,
          origin: "task",
          outputKey: "theorem.final",
          taskId: `finalize:r${rounds}:orchestrator`,
          nodeId: "orchestrator",
          kind: "proof.final",
          inputVersions,
        }, content));
        await emit(compositionProposedEvent(runId, finalProposal));
        const finalComposition = certifyComposition({
          registry,
          contract: finalContract,
          proposal: finalProposal,
        });
        if (finalComposition.ok) {
          await emit(compositionCertifiedEvent(runId, finalComposition.certification));
        } else {
          await emit({
            type: "composition.rejected",
            runId,
            compositionId: finalContract.compositionId,
            proposalId: finalProposal.proposalId,
            reason: finalComposition.reason,
            detail: finalComposition.detail,
          });
        }
        await emit({
          type: "solution.finalized",
          runId,
          agentId: synthesizerAgent.id,
          content,
          confidence,
          gaps: mergedGaps,
        });
        await execution.checkpoint("solution.after", executionDetails);
        if (terminalVerificationFailure) {
          const failureClass = classifyTheoremFailure({
            status: verify.status,
            trust: verify.trust,
            content: verify.report,
            evidence: verify.evidence,
            updatedAt: ctx.now(),
          }, axiomPolicy === "required") ?? "verification_failed";
          await emitFailure({
            stage: "verification",
            failureClass,
            message: note ?? `Final verification failed: ${verify.status}`,
            details: verify.report,
            retryable: true,
            evidence: verify.evidence ? { ...verify.evidence } : undefined,
          });
        }
        await execution.failpoint("status.before", executionDetails);
        await emit({
          type: "run.status",
          runId,
          status: terminalVerificationFailure ? "failed" : "completed",
          agentId: "orchestrator",
          note,
        });
        await execution.checkpoint("status.after", executionDetails);
      },
    });
  },
};

const THEOREM_RECEIPT_RUNTIME = defineWorkflowAgent<
  TheoremCmd,
  TheoremWorkflowDeps,
  TheoremEvent,
  TheoremState,
  TheoremWorkflowConfig
>({
  id: THEOREM_WORKFLOW_ID,
  version: THEOREM_WORKFLOW_VERSION,
  reducer: reduceTheorem,
  initial: initialTheorem,
  lifecycle: {
    init: THEOREM_LIFECYCLE.init,
    resume: THEOREM_LIFECYCLE.resume,
    shouldIndex: THEOREM_LIFECYCLE.shouldIndex,
  },
  run: THEOREM_WORKFLOW.run,
});

// ============================================================================
// Public run entry
// ============================================================================

export const runTheoremRoster = async (input: TheoremRunInput): Promise<TheoremRunResult> => {
  const now = input.now ?? Date.now;
  const baseStream = input.stream;
  const runStream = input.runStream ?? theoremRunStream(baseStream, input.runId);
  const emitRun = createQueuedEmitter({
    runtime: input.runtime,
    stream: runStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as TheoremCmd),
    onEmit: () => input.broadcast?.(),
    onError: (err) => console.error("theorem emit failed", err),
  });
  const emitIndex = createQueuedEmitter({
    runtime: input.runtime,
    stream: baseStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as TheoremCmd),
    onError: (err) => console.error("theorem index emit failed", err),
  });

  try {
    await runDefinedWorkflowAgent({
      spec: THEOREM_RECEIPT_RUNTIME,
      ctx: {
        stream: runStream,
        runId: input.runId,
        emit: emitRun,
        now,
        runtime: input.runtime,
        prompts: input.prompts,
        llmText: input.llmText,
        model: input.model,
        promptHash: input.promptHash,
        promptPath: input.promptPath,
        apiReady: input.apiReady,
        apiNote: input.apiNote,
        emitIndex,
        control: input.control,
        axiomDelegate: input.axiomDelegate,
        axiomPolicy: input.axiomPolicy,
        axiomConfig: input.axiomConfig,
        taskRuntime: input.taskRuntime,
        createPlatformExecutionPlanes: input.createPlatformExecutionPlanes,
        initialBracket: input.initialBracket,
        broadcast: input.broadcast,
      },
      config: { ...normalizeTheoremConfig(input.config), problem: input.problem },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    const failedState = await input.runtime.state(runStream);
    if (!failedState.failure) {
      const failureReportEvent: TheoremEvent = {
        type: "failure.report",
        runId: input.runId,
        agentId: "orchestrator",
        failure: {
          stage: "runtime",
          failureClass: "runtime_error",
          message,
          retryable: true,
        },
      };
      await emitRun(failureReportEvent);
      await emitIndex(failureReportEvent);
    }
    const terminalMessage = failedState.failure?.message ?? message;
    const statusEvent: TheoremEvent = {
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: terminalMessage,
    };
    await emitRun(statusEvent);
    await emitIndex(statusEvent);
  }
  const state = await input.runtime.state(runStream);
  return buildTheoremRunResult({
    runId: input.runId,
    stream: baseStream,
    runStream,
    state,
    requiresFinalAxiomVerify: input.axiomPolicy === "required",
  });
};

// ============================================================================
// Re-exports for server/views
// ============================================================================

export {
  THEOREM_WORKFLOW_ID,
  THEOREM_WORKFLOW_VERSION,
  THEOREM_EXAMPLES,
  buildTheoremRuns,
  buildTheoremSteps,
  getLatestTheoremRunId,
  mapWithConcurrency,
  sliceTheoremChain,
  sliceTheoremChainByStep,
  type TheoremRunSummary,
};
