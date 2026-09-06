// ============================================================================
// Writer Roster workflow - orchestration-kernel multi-agent writing
// ============================================================================

import type { Runtime } from "../core/runtime.js";
import { hashCanonical } from "../core/canonical.js";
import type { WriterCmd, WriterEvent, WriterState } from "../modules/writer.js";
import { type WriterPromptConfig } from "../prompts/writer.js";
import { parseFormNum, type AgentRunControl, createQueuedEmitter, type EmitFn, type RunLifecycle, type WorkflowSpec } from "../engine/runtime/workflow.js";
import { compilePrompt, versionPromptInputs } from "../engine/orchestration/prompt.js";
import { certifyComposition, createCompositionProposal } from "../engine/orchestration/composition.js";
import {
  compositionCertifiedEvent,
  compositionProposedEvent,
  inlineArtifactPublishedEvent,
  orchestrationConfiguredEvent,
  orchestrationOutputValues,
  promptCompiledEvent,
  reflectionRecordedEvent,
  taskGraphProjectedEvent,
  topologySelectedEvent,
} from "../modules/orchestration.js";
import { reflectOnOrchestration } from "../engine/orchestration/adaptive.js";
import { balancedCompositionTree, compositionBracket, compositionLeaves } from "../engine/orchestration/topology.js";
import {
  deriveWriterNodeDemands,
  materializeWriterNode,
  writerAdaptiveDomain,
  type WriterNodeSpec,
} from "../domains/writer.js";
import { defineWorkflowAgent, runDefinedWorkflowAgent } from "../sdk/agent.js";
import { WRITER_WORKFLOW_ID, WRITER_WORKFLOW_VERSION, WRITER_EXAMPLES } from "./writer.constants.js";
import { writerBranchStream, writerRunStream } from "./writer.streams.js";
import { reduce as reduceWriter, initial as initialWriter } from "../modules/writer.js";
import { resolveRuntimeLimits } from "../engine/runtime/limits.js";
import {
  DEFAULT_DYNAMIC_ACCEPTANCE,
  createDynamicTaskDefinition,
} from "../engine/orchestration/task-graph.js";
import { taskGraphTask } from "../engine/orchestration/task-graph-control.js";
import {
  defineRosterPlatform,
  type RosterPlatformExecutionOptions,
} from "../engine/platform/roster-platform.js";
import type { JsonValue } from "../engine/orchestration/types.js";

// ============================================================================
// Types
// ============================================================================

export type WriterRunConfig = {
  readonly maxParallel: number;
};

export type WriterRunControl = AgentRunControl;

export type WriterExecutionPlane = Pick<
  RosterPlatformExecutionOptions,
  "taskGraph" | "dataReferences" | "createTaskContext"
>;

export const WRITER_DEFAULT_CONFIG: WriterRunConfig = {
  maxParallel: resolveRuntimeLimits().maxParallel,
};

export const normalizeWriterConfig = (input: Partial<WriterRunConfig>): WriterRunConfig => ({
  maxParallel: resolveRuntimeLimits({ maxParallel: input.maxParallel }).maxParallel,
});

export const parseWriterConfig = (form: Record<string, string>): WriterRunConfig =>
  normalizeWriterConfig({
    maxParallel: parseFormNum(form.parallel),
  });

type WriterWorkflowConfig = WriterRunConfig & {
  readonly problem: string;
};

type WriterWorkflowDeps = {
  readonly runtime: Runtime<WriterCmd, WriterEvent, WriterState>;
  readonly prompts: WriterPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly emitIndex: (event: WriterEvent) => Promise<void>;
  readonly control?: WriterRunControl;
  readonly executionPlane: WriterExecutionPlane;
};

export type WriterRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly runStream?: string;
  readonly problem: string;
  readonly config: WriterRunConfig;
  readonly runtime: Runtime<WriterCmd, WriterEvent, WriterState>;
  readonly prompts: WriterPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly broadcast?: () => void;
  readonly now?: () => number;
  readonly control?: WriterRunControl;
  /** Explicit graph, value, and task-fenced workspace authority. */
  readonly executionPlane: WriterExecutionPlane;
};

// ============================================================================
// Workflow spec
// ============================================================================

const writerProblemArtifact = (runId: string, problem: string) => inlineArtifactPublishedEvent({
  runId,
  artifactId: `artifact-${hashCanonical({ runId, outputKey: "problem", problem }).slice(0, 24)}`,
  origin: "input",
  outputKey: "problem",
  nodeId: "orchestrator",
  kind: "input.problem",
  inputVersions: {},
}, problem);

const WRITER_LIFECYCLE: RunLifecycle<WriterWorkflowDeps, WriterEvent, WriterState, WriterWorkflowConfig> = {
  reducer: reduceWriter,
  initial: initialWriter,
  init: (ctx, runId, config) => [
    { type: "problem.set", runId, problem: config.problem, agentId: "orchestrator" },
    {
      type: "run.configured",
      runId,
      agentId: "orchestrator",
      workflow: { id: WRITER_WORKFLOW_ID, version: WRITER_WORKFLOW_VERSION },
      config: { maxParallel: config.maxParallel },
      model: ctx.model,
      promptHash: ctx.promptHash,
      promptPath: ctx.promptPath,
    },
    orchestrationConfiguredEvent(
      runId,
      writerAdaptiveDomain(config.maxParallel, resolveRuntimeLimits().maxNodes).pack
    ),
    { type: "run.status", runId, status: "running", agentId: "orchestrator" },
    writerProblemArtifact(runId, config.problem),
  ],
  resume: (_ctx, runId, state, config) => {
    const events: WriterEvent[] = [];
    if (!state.orchestration.domain) {
      events.push(orchestrationConfiguredEvent(
        runId,
        writerAdaptiveDomain(config.maxParallel, resolveRuntimeLimits().maxNodes).pack
      ));
    }
    const problem = state.problem || config.problem;
    if (state.status !== "running" && state.status !== "completed") {
      events.push({ type: "run.status", runId, status: "running", agentId: "orchestrator", note: "resumed" });
    }
    if (problem && !state.orchestration.outputs.problem) {
      events.push(writerProblemArtifact(runId, problem));
    }
    return events;
  },
};

const WRITER_WORKFLOW: WorkflowSpec<WriterWorkflowDeps, WriterWorkflowConfig, WriterEvent, WriterState> = {
  id: WRITER_WORKFLOW_ID,
  version: WRITER_WORKFLOW_VERSION,
  lifecycle: WRITER_LIFECYCLE,
  run: async (ctx, config) => {
    const { runtime, prompts, llmText: llmRaw, apiReady, apiNote, control } = ctx;
    const { maxParallel } = config;
    let problemText = (ctx.resume ? (ctx.state?.problem || config.problem) : (config.problem || ctx.state?.problem || "")).trim();
    const runId = ctx.runId;
    const domain = writerAdaptiveDomain(maxParallel, resolveRuntimeLimits().maxNodes);
    const initialDemands = deriveWriterNodeDemands(problemText || config.problem, maxParallel);
    const initialReflection = reflectOnOrchestration({
      runId,
      policyId: "writer-population",
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
        note: "Editorial capability demand derived from the writing objective.",
      },
      maxNodes: domain.pack.limits.maxNodes,
      unmetDemands: initialDemands,
    });
    const persistedWorkers = Object.values(ctx.state?.orchestration.nodes ?? {})
      .filter((agent) => agent.id !== domain.pack.coordinatorId)
      .map(({ status: _status, updatedAt: _updatedAt, ...agent }) => agent);
    const dynamicAgents: WriterNodeSpec[] = persistedWorkers.length > 0
      ? persistedWorkers.map((agent) => ({
          ...agent,
          role: (typeof agent.metadata?.role === "string" ? agent.metadata.role : "researcher") as WriterNodeSpec["role"],
          promptKey: agent.promptProfile ?? agent.id,
          focus: typeof agent.metadata?.focus === "string" ? agent.metadata.focus : undefined,
        }))
      : initialDemands.map((demand, index) => materializeWriterNode({
          runId,
          reflectionId: initialReflection.reflectionId,
          index,
          demand,
        }));
    const registry = domain.registry.extendNodes(dynamicAgents);

    const taskBranchEmitters = new Map<string, EmitFn<WriterEvent>>();
    let workflowTaskIds: Set<string> | null = null;

    const ensureTaskBranch = async (taskId: string, agentId?: string) => {
      if (!workflowTaskIds || !workflowTaskIds.has(taskId)) return;
      if (taskBranchEmitters.has(taskId)) return;

      const branchName = writerBranchStream(ctx.stream, taskId);
      const existing = await runtime.branch(branchName);
      if (!existing) {
        const forkPoint = (await runtime.chain(ctx.stream)).length;
        await runtime.fork(ctx.stream, forkPoint, branchName);
      }

      const emitBranch = createQueuedEmitter({
        runtime,
        stream: branchName,
        wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as WriterCmd),
        onError: (err) => console.error(`writer branch emit failed (${agentId ?? taskId})`, err),
      });

      taskBranchEmitters.set(taskId, emitBranch);
    };

    const emit = async (event: WriterEvent) => {
      const taskId = "taskId" in event && typeof event.taskId === "string"
        ? event.taskId
        : "stepId" in event && typeof event.stepId === "string"
          ? event.stepId
          : undefined;
      if (taskId) {
        await ensureTaskBranch(taskId, "agentId" in event ? event.agentId : undefined);
      }
      await ctx.emit(event);
      if (taskId) {
        const emitBranch = taskBranchEmitters.get(taskId);
        if (emitBranch) await emitBranch(event);
      }
    };

    const isContextOverflow = (err: unknown): boolean => {
      const message = err instanceof Error ? err.message : String(err);
      return /context|token|maximum context|input too large|prompt too long/i.test(message);
    };

    const softTrim = (text: string, headChars: number, tailChars: number): string => {
      if (text.length <= headChars + tailChars + 16) return text;
      return `${text.slice(0, headChars)}\n\n[... trimmed ...]\n\n${text.slice(-tailChars)}`;
    };

    const compactPrompt = (text: string, targetChars: number): string => {
      if (text.length <= targetChars) return text;
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      const head = lines.slice(0, 20).join("\n");
      const tail = lines.slice(-12).join("\n");
      const merged = `${head}\n\n[... compacted context ...]\n\n${tail}`.trim();
      if (merged.length <= targetChars) return merged;
      return softTrim(merged, Math.floor(targetChars * 0.6), Math.floor(targetChars * 0.3));
    };

    const applyContextPolicy = async (stage: string, user: string, agentId?: string, stepId?: string): Promise<string> => {
      const HARD_THRESHOLD = 45_000;
      const SOFT_THRESHOLD = 10_000;
      const COMPACT_THRESHOLD = 16_000;
      let next = user;
      if (next.length > HARD_THRESHOLD) {
        const before = next.length;
        next = "[Context pruned due to size. Produce concise output.]";
        await emit({
          type: "context.pruned",
          runId,
          agentId,
          stepId,
          stage,
          mode: "hard",
          before,
          after: next.length,
          note: "hard clear applied",
        });
      } else if (next.length > SOFT_THRESHOLD) {
        const before = next.length;
        next = softTrim(next, 3_500, 2_800);
        await emit({
          type: "context.pruned",
          runId,
          agentId,
          stepId,
          stage,
          mode: "soft",
          before,
          after: next.length,
          note: "soft trim applied",
        });
      }
      if (next.length > COMPACT_THRESHOLD) {
        const before = next.length;
        next = compactPrompt(next, 8_000);
        await emit({
          type: "context.compacted",
          runId,
          agentId,
          stepId,
          stage,
          reason: "threshold",
          before,
          after: next.length,
          note: "pre-call compaction",
        });
      }
      return next;
    };

    const callLlm = async (opts: {
      readonly system?: string;
      readonly user: string;
      readonly stage: string;
      readonly agentId?: string;
      readonly stepId?: string;
    }): Promise<string> => {
      if (await checkAbort(`${opts.stage}.before_llm`)) {
        throw new Error(`canceled at ${opts.stage}.before_llm`);
      }
      const pruned = await applyContextPolicy(opts.stage, opts.user, opts.agentId, opts.stepId);
      try {
        const out = await llmRaw({ system: opts.system, user: pruned });
        if (await checkAbort(`${opts.stage}.after_llm`)) {
          throw new Error(`canceled at ${opts.stage}.after_llm`);
        }
        return out;
      } catch (err) {
        if (!isContextOverflow(err)) throw err;
        const compacted = compactPrompt(pruned, 6_000);
        await emit({
          type: "context.compacted",
          runId,
          agentId: opts.agentId,
          stepId: opts.stepId,
          stage: opts.stage,
          reason: "overflow",
          before: pruned.length,
          after: compacted.length,
          note: "retry after overflow",
        });
        await emit({
          type: "overflow.recovered",
          runId,
          agentId: opts.agentId,
          stepId: opts.stepId,
          stage: opts.stage,
          note: "recovered by compacting prompt and retrying once",
        });
        const out = await llmRaw({ system: opts.system, user: compacted });
        if (await checkAbort(`${opts.stage}.after_overflow_retry`)) {
          throw new Error(`canceled at ${opts.stage}.after_overflow_retry`);
        }
        return out;
      }
    };

    const applyControlCommands = async (): Promise<void> => {
      if (!control?.pullCommands) return;
      const commands = await control.pullCommands();
      for (const command of commands) {
        const payload = command.payload ?? {};
        if (typeof payload.problem === "string" && payload.problem.trim().length > 0) {
          problemText = payload.problem.trim();
          await emit(writerProblemArtifact(runId, problemText));
          continue;
        }
        if (typeof payload.note === "string" && payload.note.trim().length > 0) {
          problemText = `${problemText}\n\nFollow-up:\n${payload.note}`.trim();
          await emit(writerProblemArtifact(runId, problemText));
        }
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
      await emit({ type: "node.spawned", runId, node: agent, reason: initialReflection.reason });
    }
    if (!ctx.state?.orchestration.topologyId) {
      const researchLeaves = dynamicAgents
        .filter((agent) => agent.role === "researcher")
        .map((agent) => agent.id);
      const topology = balancedCompositionTree([...researchLeaves, "editorial-review"]);
      await emit(topologySelectedEvent({
        runId,
        operation: "initialize",
        bracket: compositionBracket(topology),
        leaves: compositionLeaves(topology),
        reason: "Initial adaptive editorial frontier.",
      }));
    }

    const asText = (value: unknown, fallback = ""): string => {
      if (typeof value === "string") return value;
      if (value === undefined || value === null) return fallback;
      return String(value);
    };

    type WriterTaskDefinition = {
      readonly id: string;
      readonly nodeId: string;
      readonly capability: string;
      readonly objective: string;
      readonly needs: ReadonlyArray<string>;
      readonly output: string;
      readonly templateKey: string;
      readonly stage: string;
      readonly fallback: string;
      readonly variables: (state: Readonly<Record<string, unknown>>) => Record<string, string>;
    };

    const roleAgent = (role: Exclude<WriterNodeSpec["role"], "researcher">): WriterNodeSpec => {
      const found = dynamicAgents.find((agent) => agent.role === role);
      if (!found) throw new Error(`Adaptive writer population has no ${role} capability owner`);
      return found;
    };
    const researchers = dynamicAgents.filter((agent) => agent.role === "researcher");
    const researchOutputs = researchers.map((_agent, index) => `research.${index + 1}`);
    const architect = roleAgent("architect");
    const drafter = roleAgent("drafter");
    const logicCritic = roleAgent("critic.logic");
    const styleCritic = roleAgent("critic.style");
    const editor = roleAgent("editor");
    const synthesizer = roleAgent("synthesizer");

    const joinedResearch = (state: Readonly<Record<string, unknown>>): string =>
      researchOutputs.map((output) => state[output])
        .map((value) => asText(value))
        .filter((value) => value.length > 0)
        .join("\n\n");

    const researchDefinitions: ReadonlyArray<WriterTaskDefinition> = researchers.map((agent, index) => ({
      id: `research.${index + 1}`,
      nodeId: agent.id,
      capability: "research",
      objective: typeof agent.metadata?.objective === "string" ? agent.metadata.objective : "Develop an independent research route.",
      needs: ["problem"],
      output: researchOutputs[index] ?? `research.${index + 1}`,
      templateKey: "research",
      stage: "research",
      fallback: "No research output.",
      variables: (state) => ({
        problem: asText(state.problem, problemText),
        focus: typeof agent.metadata?.focus === "string" ? agent.metadata.focus : "independent route",
      }),
    }));

    const taskDefinitions: ReadonlyArray<WriterTaskDefinition> = [
      ...researchDefinitions,
      {
        id: "outline",
        nodeId: architect.id,
        capability: "structure",
        objective: "Compose the research artifacts into a coherent outline.",
        needs: ["problem", ...researchOutputs],
        output: "outline",
        templateKey: "outline",
        stage: "outline",
        fallback: "No outline produced.",
        variables: (state) => ({ problem: asText(state.problem, problemText), research: joinedResearch(state) }),
      },
      {
        id: "draft",
        nodeId: drafter.id,
        capability: "draft",
        objective: "Produce a complete draft from the accepted outline and research.",
        needs: ["problem", "outline", ...researchOutputs],
        output: "draft",
        templateKey: "draft",
        stage: "draft",
        fallback: "No draft produced.",
        variables: (state) => ({
          problem: asText(state.problem, problemText),
          outline: asText(state.outline),
          research: joinedResearch(state),
        }),
      },
      {
        id: "critique.logic",
        nodeId: logicCritic.id,
        capability: "criticize.logic",
        objective: "Find factual, logical, and structural defects in the draft.",
        needs: ["draft"],
        output: "critique.logic",
        templateKey: "critique_logic",
        stage: "critic",
        fallback: "No critique.",
        variables: (state) => ({ draft: asText(state.draft) }),
      },
      {
        id: "critique.style",
        nodeId: styleCritic.id,
        capability: "criticize.style",
        objective: "Find tone, clarity, and readability defects in the draft.",
        needs: ["draft"],
        output: "critique.style",
        templateKey: "critique_style",
        stage: "critic",
        fallback: "No critique.",
        variables: (state) => ({ draft: asText(state.draft) }),
      },
      {
        id: "revise",
        nodeId: editor.id,
        capability: "edit",
        objective: "Reconcile independent critiques into a revised document.",
        needs: ["draft", "critique.logic", "critique.style"],
        output: "revision",
        templateKey: "revise",
        stage: "edit",
        fallback: "No revision produced.",
        variables: (state) => ({
          draft: asText(state.draft),
          critique_logic: asText(state["critique.logic"]),
          critique_style: asText(state["critique.style"]),
        }),
      },
      {
        id: "final",
        nodeId: synthesizer.id,
        capability: "compose",
        objective: "Produce the final document from the verified revision.",
        needs: ["revision"],
        output: "final",
        templateKey: "final",
        stage: "synthesize",
        fallback: "No final output.",
        variables: (state) => ({ revision: asText(state.revision) }),
      },
    ];

    const taskRuns = new Map(taskDefinitions.map((definition) => [
      definition.id,
      async (state: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, JsonValue>>> => {
        const assigned = registry.assertNodeAssignment(definition.nodeId, definition.capability);
        const variables = definition.variables(state);
        const compiled = compilePrompt(registry, {
          runId,
          taskId: definition.id,
          nodeId: definition.nodeId,
          capability: definition.capability,
          template: {
            id: `${domain.pack.id}.${definition.templateKey}`,
            version: ctx.promptHash ?? WRITER_WORKFLOW_VERSION,
            system: prompts.system[assigned.promptProfile ?? definition.nodeId] ?? "",
            user: prompts.user[definition.templateKey] ?? "",
          },
          variables,
          inputVersions: versionPromptInputs(variables),
        });
        await emit(promptCompiledEvent(compiled));
        const text = await callLlm({
          system: compiled.system,
          user: compiled.user,
          stage: definition.stage,
          agentId: definition.nodeId,
          stepId: definition.id,
        });
        return { [definition.output]: text.trim() || definition.fallback };
      },
    ] as const));

    workflowTaskIds = new Set(taskDefinitions.map((task) => task.id));

    const state = await runtime.state(ctx.stream);
    const initialOutputs: Record<string, JsonValue> = {
      ...orchestrationOutputValues(state.orchestration),
      problem: problemText,
    };
    const taskByOutput = new Map(taskDefinitions.map((definition) => [
      definition.output,
      definition.id,
    ] as const));
    const taskGraph = ctx.executionPlane.taskGraph;
    const dataReferences = ctx.executionPlane.dataReferences;
    const problemReference = await dataReferences.put({
      value: problemText,
      mediaType: "text/plain",
      metadata: { outputKey: "problem" },
    });
    const topologyVersion = state.orchestration.topologyId ?? `writer-topology:${runId}`;
    const seedTasks = taskDefinitions.map((definition) => {
      const dependencyIds = [...new Set(definition.needs
        .map((need) => taskByOutput.get(need))
        .filter((taskId): taskId is string => Boolean(taskId)))];
      return createDynamicTaskDefinition({
        taskId: definition.id,
        semanticKey: `writer:${WRITER_WORKFLOW_VERSION}:${definition.id}`,
        nodeId: definition.nodeId,
        capability: definition.capability,
        objective: definition.objective,
        handler: { kind: "roster.node", version: "1" },
        acceptance: DEFAULT_DYNAMIC_ACCEPTANCE,
        result: { mode: "json", outputKey: definition.output, schema: true },
        dependencies: dependencyIds.map((taskId) => ({
          taskId,
          condition: "accepted" as const,
        })),
        join: { kind: "all-success" },
        inputs: {
          inputVersions: Object.fromEntries(definition.needs.map((need) => [
            need,
            taskByOutput.has(need)
              ? `task:${taskByOutput.get(need)}`
              : hashCanonical(initialOutputs[need] ?? null),
          ])),
          dataReferences: definition.needs.includes("problem") ? [problemReference] : [],
          frontierVersion: `writer-frontier:${hashCanonical({ runId, problemText })}`,
          topologyVersion,
          catalogVersion: `writer-catalog:${WRITER_WORKFLOW_VERSION}`,
        },
        runtimeBindingEpoch: 0,
        retry: {
          maxAttempts: 2,
          initialBackoffMs: 250,
          maximumBackoffMs: 2_000,
        },
        timeoutMs: Number(process.env.PLANNER_STEP_TIMEOUT_MS ?? 90_000),
        sideEffect: "idempotent",
        estimatedCostMicros: 0,
      });
    });
    const executionPolicy = {
      maxTasks: taskDefinitions.length,
      maxDepth: 1,
      maxFanout: taskDefinitions.length,
      maxInflight: Math.min(maxParallel, taskDefinitions.length),
      maxReady: taskDefinitions.length,
      maxBlocked: taskDefinitions.length,
      maxAttempts: 2,
      maxContextBytes: 64 * 1_048_576,
      maxCostMicros: 10_000_000,
      maxTokens: 1_000_000,
      maxWallTimeMs: Math.max(120_000, seedTasks.reduce((sum, task) => sum + task.timeoutMs, 0)),
    };
    const platform = defineRosterPlatform({
      id: "writer",
      version: WRITER_WORKFLOW_VERSION,
      policyVersion: domain.pack.policyVersion,
      coordinatorId: domain.pack.coordinatorId,
      coordinatorCapability: "coordinate",
      capabilities: domain.pack.capabilities,
      nodes: registry.pack.nodes,
      maxNodes: registry.pack.limits.maxNodes,
      policy: executionPolicy,
    });
    const outputs: Record<string, JsonValue> = { ...initialOutputs };
    const execution = platform.createExecution({
        runId,
        seedTasks,
        taskGraph,
        dataReferences,
        createTaskContext: ctx.executionPlane.createTaskContext,
        onSnapshot: (snapshot) => emit(taskGraphProjectedEvent(runId, snapshot)),
        nativeExecute: async (taskContext) => {
          const runTask = taskRuns.get(taskContext.definition.taskId);
          if (!runTask) throw new Error(`Writer task ${taskContext.definition.taskId} has no implementation`);
          const acceptedInputs: Record<string, unknown> = { ...initialOutputs };
          for (const references of Object.values(taskContext.dependencyDataReferences)) {
            for (const { reference } of references) {
              const value = await taskContext.readDataReference(reference, {
                signal: taskContext.signal,
              });
              if (value && typeof value === "object" && !Array.isArray(value)) {
                Object.assign(acceptedInputs, value);
              }
            }
          }
          const result = await runTask(acceptedInputs);
          Object.assign(outputs, result);
          return result;
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
    if (taskGraphTask(snapshot, "final")?.status !== "accepted") {
      const failed = snapshot.tasks.find((record) => record.status === "failed");
      throw new Error(failed?.error ?? "Writer task graph did not accept the final output");
    }

    if (await checkAbort("orchestration")) return;

    const final = typeof outputs.final === "string" ? outputs.final : "";
    if (!final.trim()) {
      await emit({
        type: "run.status",
        runId,
        status: "failed",
        agentId: "orchestrator",
        note: "Orchestration completed without final output",
      });
      return;
    }

      const revision = typeof outputs.revision === "string" ? outputs.revision : "";
      const finalReflection = reflectOnOrchestration({
        runId,
        policyId: "writer-reflection",
        policyVersion: domain.pack.policyVersion,
        iteration: (state.orchestration.reflections.at(-1)?.iteration ?? 1) + 1,
        observation: {
          activeNodes: dynamicAgents.length + 1,
          pendingTasks: 0,
          runningTasks: 0,
          failedTasks: snapshot.tasks.filter((task) => task.status === "failed").length,
          conflicts: 0,
          evidenceGaps: final.trim() ? 0 : 1,
          stagnationRounds: 0,
          goalSatisfied: Boolean(final.trim()),
          note: "Editorial task graph completed; evaluate the final composition gate.",
        },
        maxNodes: domain.pack.limits.maxNodes,
      });
      await emit(reflectionRecordedEvent(runId, finalReflection));
      const inputVersions = { revision: hashCanonical(revision) };
      const contract = {
        compositionId: "writer.final",
        planVersion: `${WRITER_WORKFLOW_ID}@${WRITER_WORKFLOW_VERSION}`,
        boundaryHash: hashCanonical({ domain: domain.pack.id, output: "final", inputs: ["revision"] }),
        inputVersions,
        requiredEvidenceKinds: ["workflow"],
      } as const;
      const proposal = createCompositionProposal({
        compositionId: contract.compositionId,
        planVersion: contract.planVersion,
        nodeId: synthesizer.id,
        capability: "compose",
        boundaryHash: contract.boundaryHash,
        inputVersions,
        content: final,
        evidence: [{
          id: `evidence-${hashCanonical({ runId, kind: "workflow", final }).slice(0, 24)}`,
          kind: "workflow",
          verdict: "pass",
          artifactHash: hashCanonical(final),
        }],
      });
      await emit(compositionProposedEvent(runId, proposal));
      const composition = certifyComposition({ registry, contract, proposal });
      if (!composition.ok) {
        await emit({
          type: "composition.rejected",
          runId,
          compositionId: contract.compositionId,
          proposalId: proposal.proposalId,
          reason: composition.reason,
          detail: composition.detail,
        });
        await emit({
          type: "run.status",
          runId,
          status: "failed",
          agentId: "orchestrator",
          note: `Final composition rejected: ${composition.detail}`,
        });
        return;
      }
      await emit(compositionCertifiedEvent(runId, composition.certification));

      await emit({
        type: "solution.finalized",
        runId,
        agentId: synthesizer.id,
        content: final,
        confidence: 0.7,
      });
      await emit({ type: "run.status", runId, status: "completed", agentId: "orchestrator" });
  },
};

const WRITER_RECEIPT_RUNTIME = defineWorkflowAgent<
  WriterCmd,
  WriterWorkflowDeps,
  WriterEvent,
  WriterState,
  WriterWorkflowConfig
>({
  id: WRITER_WORKFLOW_ID,
  version: WRITER_WORKFLOW_VERSION,
  reducer: reduceWriter,
  initial: initialWriter,
  lifecycle: {
    init: WRITER_LIFECYCLE.init,
    resume: WRITER_LIFECYCLE.resume,
    shouldIndex: WRITER_LIFECYCLE.shouldIndex,
  },
  run: WRITER_WORKFLOW.run,
});

// ============================================================================
// Public run entry
// ============================================================================

export const runWriterRoster = async (input: WriterRunInput): Promise<void> => {
  const now = input.now ?? Date.now;
  const baseStream = input.stream;
  const runStream = input.runStream ?? writerRunStream(baseStream, input.runId);

  const emitRun = createQueuedEmitter({
    runtime: input.runtime,
    stream: runStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as WriterCmd),
    onEmit: () => input.broadcast?.(),
    onError: (err) => console.error("writer emit failed", err),
  });
  const emitIndex = createQueuedEmitter({
    runtime: input.runtime,
    stream: baseStream,
    wrap: (event, meta) => ({ type: "emit", event, eventId: meta.eventId } as WriterCmd),
    onError: (err) => console.error("writer index emit failed", err),
  });

  try {
    await runDefinedWorkflowAgent({
      spec: WRITER_RECEIPT_RUNTIME,
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
        executionPlane: input.executionPlane,
      },
      config: { ...input.config, problem: input.problem },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    const failureEvent: WriterEvent = {
      type: "run.status",
      runId: input.runId,
      status: "failed",
      agentId: "orchestrator",
      note: message,
    };
    await emitRun(failureEvent);
    await emitIndex(failureEvent);
  }
};

// ============================================================================
// Re-exports for server/views
// ============================================================================

export {
  WRITER_WORKFLOW_ID,
  WRITER_WORKFLOW_VERSION,
  WRITER_EXAMPLES,
};
