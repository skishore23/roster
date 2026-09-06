// ============================================================================
// Canvas model accounting - provider-neutral, task-scoped execution ledger
// ============================================================================

import type { NodeExecutionUsage } from "../engine/orchestration/types.js";
import type { ModelUsage } from "../engine/runtime/model.js";
import type { CanvasModelBudget } from "./canvas.model.js";

const TOKENS_PER_MILLION = 1_000_000n;
const MICROS_PER_DOLLAR = 1_000_000;
const MAX_RATE_MICROS = 1_000_000_000_000n;
const MAX_IDENTIFIER_LENGTH = 240;

/**
 * Rates are micro-dollars per one million tokens. The defaults deliberately
 * overestimate the lower-cost Canvas routes so an unknown/new model fails on
 * the safe side until operators provide its current prices.
 */
export type CanvasModelPricing = {
  readonly inputMicrosPerMillionTokens: bigint;
  readonly cachedInputMicrosPerMillionTokens: bigint;
  readonly outputMicrosPerMillionTokens: bigint;
};

export const DEFAULT_CANVAS_MODEL_PRICING: CanvasModelPricing = Object.freeze({
  inputMicrosPerMillionTokens: 5_000_000n,
  cachedInputMicrosPerMillionTokens: 1_250_000n,
  outputMicrosPerMillionTokens: 25_000_000n,
});

const boundedRate = (value: string | undefined, fallback: bigint): bigint => {
  try {
    const parsed = BigInt(value ?? "");
    return parsed >= 0n && parsed <= MAX_RATE_MICROS ? parsed : fallback;
  } catch {
    return fallback;
  }
};

export const resolveCanvasModelPricing = (
  env: Readonly<Record<string, string | undefined>> = process.env
): CanvasModelPricing => ({
  inputMicrosPerMillionTokens: boundedRate(
    env.CANVAS_INPUT_COST_MICROS_PER_MILLION_TOKENS,
    DEFAULT_CANVAS_MODEL_PRICING.inputMicrosPerMillionTokens
  ),
  cachedInputMicrosPerMillionTokens: boundedRate(
    env.CANVAS_CACHED_INPUT_COST_MICROS_PER_MILLION_TOKENS,
    DEFAULT_CANVAS_MODEL_PRICING.cachedInputMicrosPerMillionTokens
  ),
  outputMicrosPerMillionTokens: boundedRate(
    env.CANVAS_OUTPUT_COST_MICROS_PER_MILLION_TOKENS,
    DEFAULT_CANVAS_MODEL_PRICING.outputMicrosPerMillionTokens
  ),
});

const tokenCount = (value: number): bigint => (
  Number.isFinite(value) && value > 0 ? BigInt(Math.floor(value)) : 0n
);

const pricedTokens = (tokens: bigint, rateMicros: bigint): bigint => {
  if (tokens === 0n || rateMicros === 0n) return 0n;
  return (tokens * rateMicros + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;
};

export const canvasModelUsageCostMicros = (
  usage: ModelUsage,
  pricing: CanvasModelPricing = DEFAULT_CANVAS_MODEL_PRICING
): bigint => {
  const inputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = tokenCount(usage.cachedInputTokens) > inputTokens
    ? inputTokens
    : tokenCount(usage.cachedInputTokens);
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const outputTokens = tokenCount(usage.outputTokens);
  return pricedTokens(uncachedInputTokens, pricing.inputMicrosPerMillionTokens)
    + pricedTokens(cachedInputTokens, pricing.cachedInputMicrosPerMillionTokens)
    + pricedTokens(outputTokens, pricing.outputMicrosPerMillionTokens);
};

export type CanvasTaskExecutionLedgerLimits = {
  readonly maxTrackedTasks: number;
  readonly maxModelCallsPerTask: number;
  readonly maxPendingCallsPerTask: number;
  readonly maxCostMicrosPerTask: bigint;
  readonly maxTokensPerTask: bigint;
  /**
   * Every call reserves this many tokens before dispatch. Provider usage
   * replaces the reservation after settlement. It prevents retries with
   * missing usage from bypassing the task token bound.
   */
  readonly reservedTokensPerCall: bigint;
};

export const DEFAULT_CANVAS_TASK_EXECUTION_LIMITS: CanvasTaskExecutionLedgerLimits =
  Object.freeze({
    maxTrackedTasks: 4_096,
    maxModelCallsPerTask: 8,
    maxPendingCallsPerTask: 4,
    maxCostMicrosPerTask: 6_000_000n,
    maxTokensPerTask: 262_144n,
    reservedTokensPerCall: 32_768n,
  });

export type CanvasTaskExecutionUsage = {
  readonly runId: string;
  readonly taskId: string;
  readonly modelCalls: number;
  readonly releasedCalls: number;
  readonly pendingCalls: number;
  readonly costMicros: bigint;
  readonly inputTokens: bigint;
  readonly cachedInputTokens: bigint;
  readonly outputTokens: bigint;
  readonly reasoningTokens: bigint;
  readonly totalTokens: bigint;
  readonly overBudget: boolean;
  /** Projection admitted by the task-level AcceptedTaskOutcome boundary. */
  readonly acceptedOutcomeUsage: NodeExecutionUsage;
};

export type CanvasTaskExecutionLedger = CanvasModelBudget & {
  /**
   * Returns the provider-neutral usage admitted by AcceptedTaskOutcome, or
   * undefined when the task made no model calls. Acceptance must wait until all
   * provider calls settle or are explicitly released.
   */
  readonly taskUsage: (runId: string, taskId: string) => NodeExecutionUsage | undefined;
  /** Exact micro-dollar and call-count diagnostics for operators and tests. */
  readonly taskAccounting: (
    runId: string,
    taskId: string
  ) => CanvasTaskExecutionUsage | undefined;
  /**
   * Drops accounting only after the task outcome is durably accepted or the
   * task is terminally failed. Pending provider calls cannot be forgotten.
   */
  readonly forgetTask: (runId: string, taskId: string) => void;
  readonly trackedTaskCount: () => number;
};

type MutableTaskUsage = {
  readonly runId: string;
  readonly taskId: string;
  calls: number;
  releasedCalls: number;
  costMicros: bigint;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  totalTokens: bigint;
  reservedCostMicros: bigint;
  reservedTokens: bigint;
  readonly pendingRequestIds: Set<string>;
  readonly requestIds: Set<string>;
  overBudget: boolean;
};

type ReservationState = "reserved" | "settled" | "released";
type OperationKind = "settle" | "release";

const boundedInteger = (value: number, name: string, minimum = 1): number => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
};

const boundedBigInt = (value: bigint, name: string, minimum = 0n): bigint => {
  if (value < minimum) throw new Error(`${name} must be greater than or equal to ${minimum}`);
  return value;
};

const normalizeLimits = (
  input: Partial<CanvasTaskExecutionLedgerLimits> | undefined
): CanvasTaskExecutionLedgerLimits => {
  const limits = { ...DEFAULT_CANVAS_TASK_EXECUTION_LIMITS, ...input };
  return Object.freeze({
    maxTrackedTasks: boundedInteger(limits.maxTrackedTasks, "maxTrackedTasks"),
    maxModelCallsPerTask: boundedInteger(limits.maxModelCallsPerTask, "maxModelCallsPerTask"),
    maxPendingCallsPerTask: boundedInteger(limits.maxPendingCallsPerTask, "maxPendingCallsPerTask"),
    maxCostMicrosPerTask: boundedBigInt(limits.maxCostMicrosPerTask, "maxCostMicrosPerTask"),
    maxTokensPerTask: boundedBigInt(limits.maxTokensPerTask, "maxTokensPerTask"),
    reservedTokensPerCall: boundedBigInt(limits.reservedTokensPerCall, "reservedTokensPerCall", 1n),
  });
};

const assertedIdentifier = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`${name} must contain between 1 and ${MAX_IDENTIFIER_LENGTH} characters`);
  }
  return normalized;
};

const taskKey = (runId: string, taskId: string): string => `${runId.length}:${runId}${taskId}`;

const safeNumber = (value: bigint, name: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} exceeds the accepted outcome safe-integer range`);
  }
  return Number(value);
};

const usageProjection = (task: MutableTaskUsage): CanvasTaskExecutionUsage => {
  const costMicros = safeNumber(task.costMicros, "Canvas task cost");
  const pendingCalls = task.pendingRequestIds.size;
  return Object.freeze({
    runId: task.runId,
    taskId: task.taskId,
    modelCalls: task.calls,
    releasedCalls: task.releasedCalls,
    pendingCalls,
    costMicros: task.costMicros,
    inputTokens: task.inputTokens,
    cachedInputTokens: task.cachedInputTokens,
    outputTokens: task.outputTokens,
    reasoningTokens: task.reasoningTokens,
    totalTokens: task.totalTokens,
    overBudget: task.overBudget,
    acceptedOutcomeUsage: Object.freeze({
      inputTokens: safeNumber(task.inputTokens, "Canvas input tokens"),
      cachedInputTokens: safeNumber(task.cachedInputTokens, "Canvas cached input tokens"),
      outputTokens: safeNumber(task.outputTokens, "Canvas output tokens"),
      reasoningTokens: safeNumber(task.reasoningTokens, "Canvas reasoning tokens"),
      totalTokens: safeNumber(task.totalTokens, "Canvas total tokens"),
      costUsd: costMicros / MICROS_PER_DOLLAR,
    }),
  });
};

/**
 * Accounts model attempts inside the task runtime without making a provider or
 * database adapter the budget authority. Roster still reserves run-level cost
 * when it leases the task and admits these totals only with AcceptedTaskOutcome.
 */
export const createCanvasTaskExecutionLedger = (input?: {
  readonly pricing?: CanvasModelPricing;
  readonly limits?: Partial<CanvasTaskExecutionLedgerLimits>;
}): CanvasTaskExecutionLedger => {
  const pricing = input?.pricing ?? resolveCanvasModelPricing();
  const limits = normalizeLimits(input?.limits);
  const tasks = new Map<string, MutableTaskUsage>();
  const requestIds = new Set<string>();

  const getOrCreateTask = (runId: string, taskId: string): MutableTaskUsage => {
    const key = taskKey(runId, taskId);
    const current = tasks.get(key);
    if (current) return current;
    if (tasks.size >= limits.maxTrackedTasks) {
      throw new Error(`Canvas execution ledger reached its ${limits.maxTrackedTasks}-task bound`);
    }
    const created: MutableTaskUsage = {
      runId,
      taskId,
      calls: 0,
      releasedCalls: 0,
      costMicros: 0n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      reasoningTokens: 0n,
      totalTokens: 0n,
      reservedCostMicros: 0n,
      reservedTokens: 0n,
      pendingRequestIds: new Set<string>(),
      requestIds: new Set<string>(),
      overBudget: false,
    };
    tasks.set(key, created);
    return created;
  };

  return {
    reserve: async (rawInput) => {
      const requestId = assertedIdentifier(rawInput.requestId, "Canvas model request id");
      const runId = assertedIdentifier(rawInput.runId, "Canvas run id");
      const taskId = assertedIdentifier(rawInput.taskId, "Canvas task id");
      assertedIdentifier(rawInput.model, "Canvas model id");
      const estimatedCostMicros = boundedBigInt(
        rawInput.estimatedCostMicros,
        "Canvas estimated model cost"
      );
      if (requestIds.has(requestId)) {
        throw new Error(`Canvas model request ${requestId} is already registered`);
      }
      if (estimatedCostMicros > limits.maxCostMicrosPerTask) {
        throw new Error(`Canvas task ${taskId} would exceed its model cost bound`);
      }
      if (limits.reservedTokensPerCall > limits.maxTokensPerTask) {
        throw new Error(`Canvas task ${taskId} would exceed its model token bound`);
      }

      const task = getOrCreateTask(runId, taskId);
      if (task.overBudget) throw new Error(`Canvas task ${taskId} has exhausted its model budget`);
      if (task.calls >= limits.maxModelCallsPerTask) {
        throw new Error(`Canvas task ${taskId} reached its ${limits.maxModelCallsPerTask}-call bound`);
      }
      if (task.pendingRequestIds.size >= limits.maxPendingCallsPerTask) {
        throw new Error(`Canvas task ${taskId} reached its pending model-call bound`);
      }
      if (
        task.costMicros
        + task.reservedCostMicros
        + estimatedCostMicros
        > limits.maxCostMicrosPerTask
      ) {
        throw new Error(`Canvas task ${taskId} would exceed its model cost bound`);
      }
      if (
        task.totalTokens
        + task.reservedTokens
        + limits.reservedTokensPerCall
        > limits.maxTokensPerTask
      ) {
        throw new Error(`Canvas task ${taskId} would exceed its model token bound`);
      }

      requestIds.add(requestId);
      task.requestIds.add(requestId);
      task.calls += 1;
      task.reservedCostMicros += estimatedCostMicros;
      task.reservedTokens += limits.reservedTokensPerCall;
      task.pendingRequestIds.add(requestId);

      let state: ReservationState = "reserved";
      let operationKind: OperationKind | undefined;
      let operation: Promise<void> | undefined;

      const transact = (
        kind: OperationKind,
        effect: () => void
      ): Promise<void> => {
        if (state === (kind === "settle" ? "settled" : "released")) return Promise.resolve();
        if (state !== "reserved") {
          return Promise.reject(new Error(`Canvas model reservation was already ${state}`));
        }
        if (operation) {
          return operationKind === kind
            ? operation
            : Promise.reject(new Error(`Canvas model reservation is already being ${operationKind}d`));
        }
        operationKind = kind;
        operation = Promise.resolve().then(() => {
          effect();
          state = kind === "settle" ? "settled" : "released";
        }).finally(() => {
          operation = undefined;
          operationKind = undefined;
        });
        return operation;
      };

      const releaseReservation = (): void => {
        task.reservedCostMicros -= estimatedCostMicros;
        task.reservedTokens -= limits.reservedTokensPerCall;
        task.pendingRequestIds.delete(requestId);
      };

      return {
        settle: (usage) => transact("settle", () => {
          releaseReservation();
          const inputTokens = usage ? tokenCount(usage.inputTokens) : 0n;
          const cachedInputTokens = usage
            ? (
                tokenCount(usage.cachedInputTokens) > inputTokens
                  ? inputTokens
                  : tokenCount(usage.cachedInputTokens)
              )
            : 0n;
          const outputTokens = usage ? tokenCount(usage.outputTokens) : 0n;
          const reasoningTokens = usage ? tokenCount(usage.reasoningTokens) : 0n;
          const reportedTotal = usage ? tokenCount(usage.totalTokens) : 0n;
          const totalTokens = usage
            ? (
                reportedTotal > inputTokens + outputTokens
                  ? reportedTotal
                  : inputTokens + outputTokens
              )
            : limits.reservedTokensPerCall;
          task.costMicros += usage
            ? canvasModelUsageCostMicros(usage, pricing)
            : estimatedCostMicros;
          task.inputTokens += inputTokens;
          task.cachedInputTokens += cachedInputTokens;
          task.outputTokens += outputTokens;
          task.reasoningTokens += reasoningTokens;
          task.totalTokens += totalTokens;
          task.overBudget = task.costMicros > limits.maxCostMicrosPerTask
            || task.totalTokens > limits.maxTokensPerTask;
        }),
        release: (_reason) => transact("release", () => {
          releaseReservation();
          task.releasedCalls += 1;
        }),
      };
    },
    taskUsage: (rawRunId, rawTaskId) => {
      const runId = assertedIdentifier(rawRunId, "Canvas run id");
      const taskId = assertedIdentifier(rawTaskId, "Canvas task id");
      const task = tasks.get(taskKey(runId, taskId));
      if (!task) return undefined;
      if (task.pendingRequestIds.size > 0) {
        throw new Error(`Canvas task ${taskId} still has unsettled provider calls`);
      }
      return usageProjection(task).acceptedOutcomeUsage;
    },
    taskAccounting: (rawRunId, rawTaskId) => {
      const runId = assertedIdentifier(rawRunId, "Canvas run id");
      const taskId = assertedIdentifier(rawTaskId, "Canvas task id");
      const task = tasks.get(taskKey(runId, taskId));
      if (!task) return undefined;
      if (task.pendingRequestIds.size > 0) {
        throw new Error(`Canvas task ${taskId} still has unsettled provider calls`);
      }
      return usageProjection(task);
    },
    forgetTask: (rawRunId, rawTaskId) => {
      const runId = assertedIdentifier(rawRunId, "Canvas run id");
      const taskId = assertedIdentifier(rawTaskId, "Canvas task id");
      const key = taskKey(runId, taskId);
      const task = tasks.get(key);
      if (!task) return;
      if (task.pendingRequestIds.size > 0) {
        throw new Error(`Canvas task ${taskId} still has unsettled provider calls`);
      }
      for (const requestId of task.requestIds) requestIds.delete(requestId);
      tasks.delete(key);
    },
    trackedTaskCount: () => tasks.size,
  };
};
