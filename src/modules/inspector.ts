// ============================================================================
// Roster Replay module - prompt-driven run analysis
// ============================================================================

import type { Decide, Reducer } from "../core/types.js";

export type InspectorMode = "analyze" | "improve" | "timeline" | "qa";

export type InspectorSource = {
  readonly kind: "stream";
  readonly name: string;
};

export type InspectorTimelineBucket = {
  readonly label: string;
  readonly count: number;
};

export type InspectorEvent =
  | {
      readonly type: "context.set";
      readonly runId: string;
      readonly groupId?: string;
      readonly agentId?: string;
      readonly agentName?: string;
      readonly source: InspectorSource;
      readonly order: "asc" | "desc";
      readonly limit: number;
      readonly total: number;
      readonly shown: number;
    }
  | {
      readonly type: "tool.called";
      readonly runId: string;
      readonly groupId?: string;
      readonly agentId?: string;
      readonly agentName?: string;
      readonly tool: string;
      readonly input?: Record<string, unknown>;
      readonly summary?: string;
      readonly durationMs?: number;
      readonly error?: string;
    }
  | {
      readonly type: "question.set";
      readonly runId: string;
      readonly groupId?: string;
      readonly agentId?: string;
      readonly agentName?: string;
      readonly mode: InspectorMode;
      readonly depth: number;
      readonly question: string;
    }
  | {
      readonly type: "timeline.set";
      readonly runId: string;
      readonly groupId?: string;
      readonly agentId?: string;
      readonly agentName?: string;
      readonly depth: number;
      readonly buckets: ReadonlyArray<InspectorTimelineBucket>;
    }
  | {
      readonly type: "analysis.set";
      readonly runId: string;
      readonly groupId?: string;
      readonly agentId?: string;
      readonly agentName?: string;
      readonly content: string;
    }
  | {
      readonly type: "run.status";
      readonly runId: string;
      readonly groupId?: string;
      readonly agentId?: string;
      readonly agentName?: string;
      readonly status: "running" | "failed" | "completed";
      readonly note?: string;
    }
  | {
      readonly type: "run.configured";
      readonly runId: string;
      readonly groupId?: string;
      readonly agentId?: string;
      readonly agentName?: string;
      readonly model: string;
      readonly promptHash?: string;
      readonly promptPath?: string;
    };

export type InspectorCmd = {
  readonly type: "emit";
  readonly event: InspectorEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type InspectorState = {
  readonly runId?: string;
  readonly status: "idle" | "running" | "failed" | "completed";
  readonly statusNote?: string;
  readonly source?: InspectorSource;
  readonly question?: string;
  readonly mode?: InspectorMode;
  readonly analysis?: string;
  readonly timeline?: { readonly depth: number; readonly buckets: ReadonlyArray<InspectorTimelineBucket> };
  readonly config?: { readonly model: string; readonly promptHash?: string; readonly promptPath?: string; readonly updatedAt: number };
};

export const initial: InspectorState = { status: "idle" };

export const decide: Decide<InspectorCmd, InspectorEvent> = (cmd) => [cmd.event];

export const reduce: Reducer<InspectorState, InspectorEvent> = (state, event, ts) => {
  switch (event.type) {
    case "context.set":
      return {
        ...state,
        runId: event.runId,
        source: event.source,
      };
    case "question.set":
      return {
        ...state,
        runId: event.runId,
        question: event.question,
        mode: event.mode,
      };
    case "timeline.set":
      return {
        ...state,
        runId: event.runId,
        timeline: { depth: event.depth, buckets: event.buckets },
      };
    case "analysis.set":
      return {
        ...state,
        runId: event.runId,
        analysis: event.content,
      };
    case "run.status":
      return {
        ...state,
        runId: event.runId,
        status: event.status === "completed" ? "completed" : event.status === "failed" ? "failed" : "running",
        statusNote: event.note ?? state.statusNote,
      };
    case "run.configured":
      return {
        ...state,
        runId: event.runId,
        config: {
          model: event.model,
          promptHash: event.promptHash,
          promptPath: event.promptPath,
          updatedAt: ts,
        },
      };
    default:
      return state;
  }
};
