import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyModelFailure,
  defineModelEscalationPolicy,
  executeModelEscalation,
  type ModelEscalationEvent,
} from "../../src/engine/runtime/model-escalation.js";

const policy = defineModelEscalationPolicy({
  id: "test.contract-recovery",
  version: "1.0",
  stages: [
    { id: "economy", model: "small-model", estimatedCostMicros: 10n, maxAttempts: 2 },
    { id: "strong", model: "strong-model", estimatedCostMicros: 30n, maxAttempts: 1 },
  ],
  escalateOn: ["contract"],
});

test("central model escalation corrects locally then promotes only the failed task", async () => {
  const calls: string[] = [];
  const events: ModelEscalationEvent[] = [];
  const result = await executeModelEscalation({
    policy,
    runId: "run",
    taskId: "task",
    invoke: async ({ stage, attempt, previousError, escalatedFrom }) => {
      calls.push(`${stage.id}:${attempt}:${Boolean(previousError)}:${escalatedFrom?.id ?? "none"}`);
      return { response: { valid: stage.id === "strong" } };
    },
    normalize: (response) => {
      if (!response.valid) throw new Error("domain contract rejected the result");
      return "accepted";
    },
    onEvent: (event) => { events.push(event); },
  });

  assert.equal(result, "accepted");
  assert.deepEqual(calls, [
    "economy:1:false:none",
    "economy:2:true:none",
    "strong:1:true:economy",
  ]);
  assert.ok(events.some((event) => event.type === "stage.escalated" && event.model === "strong-model"));
});

test("central model escalation releases clear rejection and never promotes authentication failures", async () => {
  const reserved: string[] = [];
  const released: string[] = [];
  await assert.rejects(executeModelEscalation({
    policy,
    runId: "run",
    taskId: "task",
    budget: {
      reserve: async ({ model }) => {
        reserved.push(model);
        return {
          settle: async () => {},
          release: async () => { released.push(model); },
        };
      },
    },
    invoke: async () => {
      const error = new Error("authentication failed") as Error & { status: number };
      error.status = 401;
      throw error;
    },
    normalize: (response: unknown) => response,
  }), /authentication failed/);

  assert.deepEqual(reserved, ["small-model"]);
  assert.deepEqual(released, ["small-model"]);
});

test("central model escalation retains uncertain reservations and prevents duplicate spend", async () => {
  let released = false;
  await assert.rejects(executeModelEscalation({
    policy,
    runId: "run",
    taskId: "task",
    budget: {
      reserve: async () => ({
        settle: async () => {},
        release: async () => { released = true; },
      }),
    },
    invoke: async () => { throw new Error("connection reset after provider request"); },
    normalize: (response: unknown) => response,
  }), /outcome is uncertain/);
  assert.equal(released, false);
});

test("central model failure classification is shared across agent extensions", () => {
  assert.equal(classifyModelFailure(new Error("invalid encoded JSON geometry")), "contract");
  assert.equal(classifyModelFailure(new Error("rate limit 429")), "rate-limit");
  assert.equal(classifyModelFailure(Object.assign(
    new Error("429 You exceeded your current quota and billing limit"),
    { status: 429, code: "insufficient_quota" },
  )), "budget");
  assert.equal(classifyModelFailure(Object.assign(new Error("request rejected"), { status: 401 })), "authentication");
  assert.equal(classifyModelFailure(Object.assign(new Error("request rejected"), { status: 402 })), "budget");
  assert.equal(classifyModelFailure(Object.assign(new Error("request rejected"), { status: 403 })), "authorization");
  assert.equal(classifyModelFailure(new Error("OPENAI_API_KEY not set")), "authentication");
  assert.equal(classifyModelFailure(new Error("model call timed out")), "timeout");
});
