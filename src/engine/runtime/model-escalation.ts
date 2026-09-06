import { randomUUID } from "node:crypto";

import type { ModelUsage } from "./model.js";

export type ModelFailureClass =
  | "contract"
  | "authentication"
  | "authorization"
  | "budget"
  | "rate-limit"
  | "timeout"
  | "provider-uncertain"
  | "provider"
  | "unknown";

export type ModelEscalationStage = {
  readonly id: string;
  readonly model: string;
  readonly estimatedCostMicros: bigint;
  readonly maxAttempts: number;
};

export type ModelEscalationPolicy = {
  readonly id: string;
  readonly version: string;
  readonly stages: ReadonlyArray<ModelEscalationStage>;
  readonly escalateOn: ReadonlySet<ModelFailureClass>;
};

export type ModelEscalationBudget = {
  readonly reserve: (input: {
    readonly requestId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly model: string;
    readonly estimatedCostMicros: bigint;
  }) => Promise<{
    readonly settle: (usage?: ModelUsage) => Promise<void>;
    readonly release: (reason: string) => Promise<void>;
  }>;
};

export type ModelEscalationEvent = {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly stageId: string;
  readonly model: string;
  readonly attempt: number;
  readonly type: "attempt.started" | "attempt.correcting" | "stage.escalated" | "attempt.completed";
  readonly failureClass?: ModelFailureClass;
  readonly reason?: string;
};

export const defineModelEscalationPolicy = (input: {
  readonly id: string;
  readonly version?: string;
  readonly stages: ReadonlyArray<ModelEscalationStage>;
  readonly escalateOn?: ReadonlyArray<ModelFailureClass>;
}): ModelEscalationPolicy => {
  if (!/^[a-z][a-z0-9.-]{2,79}$/.test(input.id)) throw new Error(`Invalid model escalation policy id ${input.id}`);
  if (input.stages.length < 1 || input.stages.length > 4) {
    throw new Error("Model escalation policies require between one and four stages");
  }
  const stageIds = new Set<string>();
  for (const stage of input.stages) {
    if (!stage.id.trim() || !stage.model.trim()) throw new Error("Model escalation stages require id and model");
    if (stage.maxAttempts < 1 || stage.maxAttempts > 4) throw new Error(`Invalid maxAttempts for escalation stage ${stage.id}`);
    if (stage.estimatedCostMicros < 0n) throw new Error(`Invalid estimated cost for escalation stage ${stage.id}`);
    if (stageIds.has(stage.id)) throw new Error(`Duplicate model escalation stage ${stage.id}`);
    stageIds.add(stage.id);
  }
  return Object.freeze({
    id: input.id,
    version: input.version ?? "1.0",
    stages: Object.freeze(input.stages.map((stage) => Object.freeze({ ...stage }))),
    escalateOn: new Set<ModelFailureClass>(input.escalateOn ?? ["contract"]),
  });
};

const errorDescription = (error: unknown): string => {
  const candidate = error as {
    readonly failureClass?: unknown;
    readonly status?: unknown;
    readonly code?: unknown;
    readonly name?: unknown;
    readonly message?: unknown;
  } | undefined;
  return [candidate?.status, candidate?.code, candidate?.name, candidate?.message]
    .filter((value) => value !== undefined)
    .map(String)
    .join(" ");
};

export const classifyModelFailure = (error: unknown): ModelFailureClass => {
  const candidate = error as {
    readonly failureClass?: unknown;
    readonly status?: unknown;
  } | undefined;
  const explicit = candidate?.failureClass;
  if (typeof explicit === "string" && [
    "contract", "authentication", "authorization", "budget", "rate-limit",
    "timeout", "provider-uncertain", "provider", "unknown",
  ].includes(explicit)) {
    return explicit as ModelFailureClass;
  }
  const description = errorDescription(error);
  if (/structured|schema|zod|invalid encoded json|geometry|unknown part|contract/i.test(description)) return "contract";
  if (
    candidate?.status === 401
    || /OPENAI_API_KEY (?:missing|not set)|incorrect api key|authentication|invalid[_ -]api key|unauthorized/i.test(description)
  ) return "authentication";
  if (candidate?.status === 403 || /forbidden|permission denied/i.test(description)) return "authorization";
  if (candidate?.status === 402 || /budget|insufficient_quota|billing|exceeded (?:your )?(?:current )?quota/i.test(description)) return "budget";
  if (candidate?.status === 429 || /\b429\b|rate.?limit/i.test(description)) return "rate-limit";
  if (/timeout|timed out|deadline|\b408\b/i.test(description)) return "timeout";
  if (/outcome is uncertain|reservation remains held|settlement failed|\b5\d\d\b|connection reset|socket hang up/i.test(description)) {
    return "provider-uncertain";
  }
  if (/provider|model not found|context(?: |_)?length|maximum context/i.test(description)) return "provider";
  return "unknown";
};

export const isClearlyUnchargedModelFailure = (error: unknown): boolean => {
  const candidate = error as { readonly status?: unknown } | undefined;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  if (status !== undefined && [400, 401, 402, 403, 404, 409, 413, 415, 422, 429].includes(status)) return true;
  return ["authentication", "authorization", "budget", "rate-limit", "provider"].includes(classifyModelFailure(error));
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const executeModelEscalation = async <Response, Result>(input: {
  readonly policy: ModelEscalationPolicy;
  readonly runId?: string;
  readonly taskId?: string;
  readonly requestIdPrefix?: string;
  readonly budget?: ModelEscalationBudget;
  readonly invoke: (context: {
    readonly requestId: string;
    readonly stage: ModelEscalationStage;
    readonly attempt: number;
    readonly previousError?: string;
    readonly escalatedFrom?: ModelEscalationStage;
  }) => Promise<{ readonly response: Response; readonly usage?: ModelUsage }>;
  readonly normalize: (response: Response) => Result;
  readonly onEvent?: (event: ModelEscalationEvent) => void | Promise<void>;
}): Promise<Result> => {
  if (input.budget && (!input.runId?.trim() || !input.taskId?.trim())) {
    throw new Error("Model escalation budget enforcement requires both runId and taskId");
  }
  let previousError = "";
  let previousStage: ModelEscalationStage | undefined;

  for (let stageIndex = 0; stageIndex < input.policy.stages.length; stageIndex += 1) {
    const stage = input.policy.stages[stageIndex]!;
    if (stageIndex > 0) {
      await input.onEvent?.({
        policyId: input.policy.id,
        policyVersion: input.policy.version,
        runId: input.runId,
        taskId: input.taskId,
        stageId: stage.id,
        model: stage.model,
        attempt: 1,
        type: "stage.escalated",
        failureClass: "contract",
        reason: previousError,
      });
    }

    for (let attempt = 1; attempt <= stage.maxAttempts; attempt += 1) {
      const requestId = `${input.requestIdPrefix ?? "model"}_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      await input.onEvent?.({
        policyId: input.policy.id,
        policyVersion: input.policy.version,
        runId: input.runId,
        taskId: input.taskId,
        stageId: stage.id,
        model: stage.model,
        attempt,
        type: attempt === 1 ? "attempt.started" : "attempt.correcting",
        reason: previousError || undefined,
      });
      const reservation = input.budget && input.runId && input.taskId
        ? await input.budget.reserve({
            requestId,
            runId: input.runId,
            taskId: input.taskId,
            model: stage.model,
            estimatedCostMicros: stage.estimatedCostMicros,
          })
        : undefined;

      let providerResult: { readonly response: Response; readonly usage?: ModelUsage };
      try {
        providerResult = await input.invoke({
          requestId,
          stage,
          attempt,
          previousError: previousError || undefined,
          escalatedFrom: previousStage,
        });
      } catch (error) {
        const failure = classifyModelFailure(error);
        if (reservation) {
          if (!isClearlyUnchargedModelFailure(error)) {
            throw new Error("Model provider outcome is uncertain; the reservation remains held for reconciliation", { cause: error });
          }
          await reservation.release(message(error));
        }
        if (failure !== "contract") throw error;
        previousError = message(error);
        if (attempt < stage.maxAttempts) continue;
        if (!input.policy.escalateOn.has(failure) || stageIndex === input.policy.stages.length - 1) {
          throw new Error(`Model escalation policy ${input.policy.id} exhausted after ${stage.id}: ${previousError}`);
        }
        break;
      }

      if (reservation) {
        try {
          await reservation.settle(providerResult.usage);
        } catch (error) {
          throw new Error("Model usage settlement failed; the reservation remains held for reconciliation", { cause: error });
        }
      }

      try {
        const result = input.normalize(providerResult.response);
        await input.onEvent?.({
          policyId: input.policy.id,
          policyVersion: input.policy.version,
          runId: input.runId,
          taskId: input.taskId,
          stageId: stage.id,
          model: stage.model,
          attempt,
          type: "attempt.completed",
        });
        return result;
      } catch (error) {
        // The provider has already returned and settled. Any rejection from
        // the caller-supplied normalizer is therefore a deterministic domain
        // contract failure, regardless of the domain's wording.
        const failure: ModelFailureClass = "contract";
        previousError = message(error);
        if (failure !== "contract") throw error;
        if (attempt < stage.maxAttempts) continue;
        if (!input.policy.escalateOn.has(failure) || stageIndex === input.policy.stages.length - 1) {
          throw new Error(`Model escalation policy ${input.policy.id} exhausted after ${stage.id}: ${previousError}`);
        }
        break;
      }
    }
    previousStage = stage;
  }
  throw new Error(`Model escalation policy ${input.policy.id} exhausted without a result`);
};
