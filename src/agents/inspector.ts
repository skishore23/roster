// ============================================================================
// Roster Replay - prompt-driven run analysis
// ============================================================================

import type { Runtime } from "../core/runtime.js";
import type {
  InspectorCmd,
  InspectorEvent,
  InspectorMode,
  InspectorSource,
  InspectorState,
  InspectorTimelineBucket,
} from "../modules/inspector.js";
import { reduce as reduceInspector, initial as initialInspector } from "../modules/inspector.js";
import type { Chain } from "../core/types.js";
import { renderPrompt, type InspectorPromptConfig } from "../prompts/inspector.js";
import type { RunLifecycle, WorkflowSpec } from "../engine/runtime/workflow.js";
import { defineWorkflowAgent, runDefinedWorkflowAgent } from "../sdk/agent.js";

// ============================================================================
// Types
// ============================================================================

export type InspectorReceiptRecord = {
  readonly raw: string;
  readonly data?: Readonly<Record<string, unknown>>;
};

export const inspectorRecordsFromChain = <Body>(chain: Chain<Body>): InspectorReceiptRecord[] =>
  chain.map((receipt) => {
    const raw = JSON.stringify(receipt);
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { raw, data: parsed as Readonly<Record<string, unknown>> }
      : { raw };
  });

export const sliceInspectorRecords = (
  records: ReadonlyArray<InspectorReceiptRecord>,
  order: "asc" | "desc",
  limit: number,
): InspectorReceiptRecord[] => {
  if (limit <= 0) return [];
  return order === "desc" ? records.slice(-limit).reverse() : records.slice(0, limit);
};

export const buildInspectorContext = (
  records: ReadonlyArray<InspectorReceiptRecord>,
  maxChars: number,
): string => {
  let output = "";
  for (const receipt of records) {
    const line = receipt.raw.trim();
    if (!line) continue;
    if (output.length + line.length + 1 > maxChars) break;
    output += `${line}\n`;
  }
  return output.trim();
};

export const buildInspectorTimeline = (
  records: ReadonlyArray<InspectorReceiptRecord>,
  depth: number,
): Array<{ readonly label: string; readonly count: number }> => {
  const level = Math.max(1, Math.min(depth, 3));
  const buckets: Array<{ label: string; count: number }> = [];
  const index = new Map<string, number>();
  for (const receipt of records) {
    const rawBody = receipt.data?.body;
    const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? rawBody as Readonly<Record<string, unknown>>
      : undefined;
    const type = typeof body?.type === "string" ? body.type : "receipt";
    const prefix = type.split(".")[0] || type;
    const agentId = typeof body?.agentId === "string"
      ? body.agentId
      : typeof body?.agent === "string"
        ? body.agent
        : typeof body?.role === "string"
          ? body.role
          : "";
    const label = level === 1 ? "run" : level === 2 ? prefix : agentId ? `${prefix}/${agentId}` : prefix;
    const position = index.get(label);
    if (position === undefined) {
      index.set(label, buckets.length);
      buckets.push({ label, count: 1 });
    } else {
      const bucket = buckets[position];
      if (bucket) buckets[position] = { ...bucket, count: bucket.count + 1 };
    }
  }
  return buckets;
};

export type ReceiptTooling = {
  readonly readStream: (name: string) => Promise<InspectorReceiptRecord[]>;
  readonly sliceRecords: (records: ReadonlyArray<InspectorReceiptRecord>, order: "asc" | "desc", limit: number) => InspectorReceiptRecord[];
  readonly buildContext: (records: ReadonlyArray<InspectorReceiptRecord>, maxChars: number) => string;
  readonly buildTimeline: (records: ReadonlyArray<InspectorReceiptRecord>, depth: number) => Array<{ label: string; count: number }>;
};

export type InspectorRunInput = {
  readonly stream: string;
  readonly runId: string;
  readonly groupId?: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly source: InspectorSource;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly at?: number;
  readonly question: string;
  readonly mode: InspectorMode;
  readonly depth: number;
  readonly runtime: Runtime<InspectorCmd, InspectorEvent, InspectorState>;
  readonly prompts: InspectorPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly tools: ReceiptTooling;
  readonly broadcast?: () => void;
};

// ============================================================================
// Workflow
// ============================================================================

type InspectorWorkflowConfig = {
  readonly groupId?: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly source: InspectorSource;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly at?: number;
  readonly question: string;
  readonly mode: InspectorMode;
  readonly depth: number;
};

type InspectorWorkflowDeps = {
  readonly runtime: Runtime<InspectorCmd, InspectorEvent, InspectorState>;
  readonly prompts: InspectorPromptConfig;
  readonly llmText: (opts: { system?: string; user: string }) => Promise<string>;
  readonly model: string;
  readonly promptHash?: string;
  readonly promptPath?: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly tools: ReceiptTooling;
  readonly broadcast?: () => void;
};

const INSPECTOR_LIFECYCLE: RunLifecycle<InspectorWorkflowDeps, InspectorEvent, InspectorState, InspectorWorkflowConfig> = {
  reducer: reduceInspector,
  initial: initialInspector,
  init: (ctx, runId) => [
    {
      type: "run.configured",
      runId,
      model: ctx.model,
      promptHash: ctx.promptHash,
      promptPath: ctx.promptPath,
    },
  ],
};

const INSPECTOR_WORKFLOW: WorkflowSpec<InspectorWorkflowDeps, InspectorWorkflowConfig, InspectorEvent, InspectorState> = {
  id: "receipt-inspector",
  version: "0.2",
  lifecycle: INSPECTOR_LIFECYCLE,
  run: async (ctx, config) => {
    const {
      prompts,
      llmText,
      apiReady,
      apiNote,
      tools,
    } = ctx;
    const { groupId, agentId, agentName, source, order, limit, at, question, mode, depth } = config;
    const runId = ctx.runId;

    const emit = async (event: InspectorEvent) => {
      await ctx.emit(event);
    };

    const withMeta = <T extends InspectorEvent>(event: T): T => ({
      ...event,
      groupId,
      agentId,
      agentName,
    });

    const callTool = async <T>(
      name: string,
      input: Record<string, unknown>,
      fn: () => Promise<T>,
      summarize?: (result: T) => string
    ): Promise<T> => {
      const started = Date.now();
      try {
        const result = await fn();
        const summary = summarize ? summarize(result) : undefined;
        await emit(withMeta({
          type: "tool.called",
          runId,
          tool: name,
          input,
          summary,
          durationMs: Date.now() - started,
        }));
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await emit(withMeta({
          type: "tool.called",
          runId,
          tool: name,
          input,
          summary: "failed",
          durationMs: Date.now() - started,
          error,
        }));
        throw err;
      }
    };

    if (!apiReady) {
      await emit(withMeta({
        type: "run.status",
        runId,
        status: "failed",
        note: apiNote ?? "OPENAI_API_KEY not set",
      }));
      await emit(withMeta({
        type: "analysis.set",
        runId,
        content: apiNote ?? "OPENAI_API_KEY not set",
      }));
      return;
    }

    await emit(withMeta({ type: "run.status", runId, status: "running" }));

    let records: InspectorReceiptRecord[] = [];
    let slice: InspectorReceiptRecord[] = [];
    let context = "";
    let timeline: InspectorTimelineBucket[] = [];

    try {
      records = await callTool(
        "receipt.read",
        { stream: source.name },
        () => tools.readStream(source.name),
        (result) => `records:${result.length}`
      );
      const visibleRecords = at === undefined ? records : records.slice(0, Math.max(0, Math.min(at, records.length)));
      slice = await callTool(
        "receipt.slice",
        { order, limit, at: at ?? "live" },
        () => Promise.resolve(tools.sliceRecords(visibleRecords, order, limit)),
        (result) => `slice:${result.length}`
      );
      context = await callTool(
        "receipt.context",
        { maxChars: 12000 },
        () => Promise.resolve(tools.buildContext(slice, 12000)),
        (result) => `chars:${result.length}`
      );
      timeline = await callTool(
        "receipt.timeline",
        { depth },
        () => Promise.resolve(tools.buildTimeline(visibleRecords, depth)),
        (result) => `buckets:${result.length}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit(withMeta({
        type: "run.status",
        runId,
        status: "failed",
        note: message,
      }));
      await emit(withMeta({
        type: "analysis.set",
        runId,
        content: message,
      }));
      return;
    }

    await emit(withMeta({
      type: "context.set",
      runId,
      source,
      order,
      limit,
      total: records.length,
      shown: slice.length,
    }));

    await emit(withMeta({
      type: "question.set",
      runId,
      mode,
      depth,
      question,
    }));

    await emit(withMeta({
      type: "timeline.set",
      runId,
      depth,
      buckets: timeline,
    }));

    const template = prompts.modes[mode] ?? prompts.modes.qa ?? "";
    const user = renderPrompt(template, {
      question,
      context,
      depth: String(depth),
    });

    const content = await llmText({ system: prompts.system, user });

    await emit(withMeta({
      type: "analysis.set",
      runId,
      content: content.trim() || "No analysis generated.",
    }));
    await emit(withMeta({ type: "run.status", runId, status: "completed" }));
  },
};

const INSPECTOR_RECEIPT_RUNTIME = defineWorkflowAgent<
  InspectorCmd,
  InspectorWorkflowDeps,
  InspectorEvent,
  InspectorState,
  InspectorWorkflowConfig
>({
  id: INSPECTOR_WORKFLOW.id,
  version: INSPECTOR_WORKFLOW.version,
  reducer: reduceInspector,
  initial: initialInspector,
  lifecycle: {
    init: INSPECTOR_LIFECYCLE.init,
    resume: INSPECTOR_LIFECYCLE.resume,
    shouldIndex: INSPECTOR_LIFECYCLE.shouldIndex,
  },
  run: INSPECTOR_WORKFLOW.run,
});

// ============================================================================
// Runner
// ============================================================================

export const runReceiptInspector = async (input: InspectorRunInput): Promise<void> => {
  const {
    stream,
    runId,
    groupId,
    agentId,
    agentName,
    source,
    order,
    limit,
    at,
    question,
    mode,
    depth,
    runtime,
    prompts,
    llmText,
    model,
    promptHash,
    promptPath,
    apiReady,
    apiNote,
    tools,
    broadcast,
  } = input;

  const emit = async (event: InspectorEvent) => {
    const eventId = `${stream}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    await runtime.execute(stream, { type: "emit", event, eventId });
    if (broadcast) broadcast();
  };

  await runDefinedWorkflowAgent({
    spec: INSPECTOR_RECEIPT_RUNTIME,
    ctx: {
      stream,
      runId,
      emit,
      now: Date.now,
      runtime,
      prompts,
      llmText,
      model,
      promptHash,
      promptPath,
      apiReady,
      apiNote,
      tools,
      broadcast,
    },
    config: { groupId, agentId, agentName, source, order, limit, at, question, mode, depth },
  });
};
