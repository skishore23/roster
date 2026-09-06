// ============================================================================
// Writer Roster Module - domain receipts projected beside the orchestration kernel
// ============================================================================

import type { Decide, Reducer } from "../core/types.js";
import type { OrchestrationEvent, OrchestrationState } from "./orchestration.js";
import { initialOrchestrationState, isOrchestrationEvent, reduceOrchestration } from "./orchestration.js";

export type WriterEvent =
  | OrchestrationEvent
  | {
      readonly type: "problem.set";
      readonly runId: string;
      readonly problem: string;
      readonly agentId?: string;
    }
  | {
      readonly type: "problem.appended";
      readonly runId: string;
      readonly append: string;
      readonly agentId?: string;
    }
  | {
      readonly type: "run.configured";
      readonly runId: string;
      readonly agentId?: string;
      readonly workflow: { id: string; version: string };
      readonly config: { readonly maxParallel: number };
      readonly model: string;
      readonly promptHash?: string;
      readonly promptPath?: string;
    }
  | {
      readonly type: "run.status";
      readonly runId: string;
      readonly status: "running" | "failed" | "completed";
      readonly agentId?: string;
      readonly note?: string;
    }
  | {
      readonly type: "solution.finalized";
      readonly runId: string;
      readonly agentId: string;
      readonly content: string;
      readonly confidence: number;
    }
  | {
      readonly type: "context.pruned";
      readonly runId: string;
      readonly agentId?: string;
      readonly stepId?: string;
      readonly stage: string;
      readonly mode: "soft" | "hard";
      readonly before: number;
      readonly after: number;
      readonly note?: string;
    }
  | {
      readonly type: "context.compacted";
      readonly runId: string;
      readonly agentId?: string;
      readonly stepId?: string;
      readonly stage: string;
      readonly reason: "threshold" | "overflow";
      readonly before: number;
      readonly after: number;
      readonly note?: string;
    }
  | {
      readonly type: "overflow.recovered";
      readonly runId: string;
      readonly agentId?: string;
      readonly stepId?: string;
      readonly stage: string;
      readonly note?: string;
    }
  | {
      readonly type: "subagent.merged";
      readonly runId: string;
      readonly agentId?: string;
      readonly stepId?: string;
      readonly subJobId: string;
      readonly subRunId: string;
      readonly task: string;
      readonly summary: string;
    };

export type WriterCmd = {
  readonly type: "emit";
  readonly event: WriterEvent;
  readonly eventId: string;
  readonly expectedPrev?: string;
};

export type WriterState = {
  readonly runId?: string;
  readonly problem: string;
  readonly status: "idle" | "running" | "failed" | "completed";
  readonly statusNote?: string;
  readonly config?: {
    readonly maxParallel: number;
    readonly model: string;
    readonly promptHash?: string;
    readonly promptPath?: string;
    readonly workflowId: string;
    readonly workflowVersion: string;
    readonly updatedAt: number;
  };
  readonly orchestration: OrchestrationState;
  readonly solution?: {
    readonly content: string;
    readonly confidence: number;
    readonly updatedAt: number;
  };
};

export const initial: WriterState = {
  problem: "",
  status: "idle",
  orchestration: initialOrchestrationState,
};

export const decide: Decide<WriterCmd, WriterEvent> = (cmd) => [cmd.event];

export const reduce: Reducer<WriterState, WriterEvent> = (state, event, ts) => {
  if (isOrchestrationEvent(event)) {
    return {
      ...state,
      orchestration: reduceOrchestration(state.orchestration, event, ts),
    };
  }
  switch (event.type) {
    case "problem.set":
      return {
        ...initial,
        runId: event.runId,
        problem: event.problem,
        status: "running",
      };
    case "problem.appended": {
      const append = event.append.trim();
      if (!append) return state;
      const base = state.problem.trim();
      const problem = base ? `${base}\n\n${append}` : append;
      return { ...state, problem };
    }
    case "run.configured":
      return {
        ...state,
        config: {
          maxParallel: event.config.maxParallel,
          model: event.model,
          promptHash: event.promptHash,
          promptPath: event.promptPath,
          workflowId: event.workflow.id,
          workflowVersion: event.workflow.version,
          updatedAt: ts,
        },
      };
    case "run.status":
      return {
        ...state,
        status: event.status,
        statusNote: event.note ?? state.statusNote,
      };
    case "solution.finalized":
      return {
        ...state,
        status: state.status === "failed" ? "failed" : "completed",
        solution: {
          content: event.content,
          confidence: event.confidence,
          updatedAt: ts,
        },
      };
    case "context.pruned":
    case "context.compacted":
    case "overflow.recovered":
    case "subagent.merged":
      return state;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};
