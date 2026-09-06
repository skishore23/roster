import assert from "node:assert/strict";
import test from "node:test";

import {
  canvasModelUsageCostMicros,
  createCanvasTaskExecutionLedger,
  resolveCanvasModelPricing,
} from "../../src/agents/canvas.model-budget.ts";

test("Canvas usage pricing separates cached input and rounds micro-dollar costs up", () => {
  const pricing = resolveCanvasModelPricing({
    CANVAS_INPUT_COST_MICROS_PER_MILLION_TOKENS: "2000000",
    CANVAS_CACHED_INPUT_COST_MICROS_PER_MILLION_TOKENS: "500000",
    CANVAS_OUTPUT_COST_MICROS_PER_MILLION_TOKENS: "10000000",
  });
  assert.equal(canvasModelUsageCostMicros({
    model: "painter-model",
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    outputTokens: 100_000,
    reasoningTokens: 0,
    totalTokens: 1_100_000,
  }, pricing), 2_700_000n);
  assert.equal(canvasModelUsageCostMicros({
    model: "painter-model",
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
    totalTokens: 2,
  }, pricing), 12n, "each independently priced token class rounds up");
});

test("Canvas task ledger settles exact usage and projects accepted-outcome accounting", async () => {
  const ledger = createCanvasTaskExecutionLedger({
    pricing: {
      inputMicrosPerMillionTokens: 2_000_000n,
      cachedInputMicrosPerMillionTokens: 500_000n,
      outputMicrosPerMillionTokens: 10_000_000n,
    },
  });
  const settled = await ledger.reserve({
    requestId: "request-settle",
    runId: "canvas-budget",
    taskId: "paint.sky",
    model: "painter-model",
    estimatedCostMicros: 300_000n,
  });

  await Promise.all([
    settled.settle({
      model: "painter-model",
      inputTokens: 10_000,
      cachedInputTokens: 2_000,
      outputTokens: 1_000,
      reasoningTokens: 100,
      totalTokens: 11_000,
    }),
    settled.settle({
      model: "painter-model",
      inputTokens: 10_000,
      cachedInputTokens: 2_000,
      outputTokens: 1_000,
      reasoningTokens: 100,
      totalTokens: 11_000,
    }),
  ]);
  await settled.settle();

  const released = await ledger.reserve({
    requestId: "request-release",
    runId: "canvas-budget",
    taskId: "paint.sky",
    model: "painter-model",
    estimatedCostMicros: 300_000n,
  });
  await Promise.all([
    released.release("provider rejected request"),
    released.release("provider rejected request"),
  ]);
  await released.release("ignored duplicate");

  const usage = ledger.taskAccounting("canvas-budget", "paint.sky");
  assert.deepEqual(usage, {
    runId: "canvas-budget",
    taskId: "paint.sky",
    modelCalls: 2,
    releasedCalls: 1,
    pendingCalls: 0,
    costMicros: 27_000n,
    inputTokens: 10_000n,
    cachedInputTokens: 2_000n,
    outputTokens: 1_000n,
    reasoningTokens: 100n,
    totalTokens: 11_000n,
    overBudget: false,
    acceptedOutcomeUsage: {
      inputTokens: 10_000,
      cachedInputTokens: 2_000,
      outputTokens: 1_000,
      reasoningTokens: 100,
      totalTokens: 11_000,
      costUsd: 0.027,
    },
  });
  assert.deepEqual(
    ledger.taskUsage("canvas-budget", "paint.sky"),
    usage?.acceptedOutcomeUsage
  );

  ledger.forgetTask("canvas-budget", "paint.sky");
  assert.equal(ledger.trackedTaskCount(), 0);
});

test("Canvas task ledger accounts missing provider usage conservatively", async () => {
  const ledger = createCanvasTaskExecutionLedger({
    limits: { reservedTokensPerCall: 40_000n },
  });
  const reservation = await ledger.reserve({
    requestId: "request-no-usage",
    runId: "canvas-budget",
    taskId: "plan",
    model: "director-model",
    estimatedCostMicros: 345_678n,
  });
  await reservation.settle();

  const usage = ledger.taskAccounting("canvas-budget", "plan");
  assert.equal(usage?.costMicros, 345_678n);
  assert.equal(usage?.totalTokens, 40_000n);
  assert.equal(usage?.acceptedOutcomeUsage.costUsd, 0.345678);
  assert.equal(usage?.acceptedOutcomeUsage.totalTokens, 40_000);
});

test("Canvas task ledger rejects calls beyond cost, token, concurrency, and call bounds", async () => {
  const ledger = createCanvasTaskExecutionLedger({
    limits: {
      maxModelCallsPerTask: 2,
      maxPendingCallsPerTask: 1,
      maxCostMicrosPerTask: 500_000n,
      maxTokensPerTask: 60_000n,
      reservedTokensPerCall: 30_000n,
    },
  });
  const pending = await ledger.reserve({
    requestId: "request-one",
    runId: "canvas-budget",
    taskId: "bounded-task",
    model: "painter-model",
    estimatedCostMicros: 200_000n,
  });
  await assert.rejects(() => ledger.reserve({
    requestId: "request-concurrent",
    runId: "canvas-budget",
    taskId: "bounded-task",
    model: "painter-model",
    estimatedCostMicros: 100_000n,
  }), /pending model-call bound/);
  await pending.release("clear rejection");

  await assert.rejects(() => ledger.reserve({
    requestId: "request-too-expensive",
    runId: "canvas-budget",
    taskId: "bounded-task",
    model: "painter-model",
    estimatedCostMicros: 600_000n,
  }), /model cost bound/);

  const final = await ledger.reserve({
    requestId: "request-final",
    runId: "canvas-budget",
    taskId: "bounded-task",
    model: "painter-model",
    estimatedCostMicros: 200_000n,
  });
  await final.settle({
    model: "painter-model",
    inputTokens: 20_000,
    cachedInputTokens: 0,
    outputTokens: 10_000,
    reasoningTokens: 0,
    totalTokens: 30_000,
  });
  await assert.rejects(() => ledger.reserve({
    requestId: "request-call-overflow",
    runId: "canvas-budget",
    taskId: "bounded-task",
    model: "painter-model",
    estimatedCostMicros: 1n,
  }), /2-call bound/);
});

test("Canvas task usage cannot be accepted or forgotten with an unsettled provider call", async () => {
  const ledger = createCanvasTaskExecutionLedger();
  const pending = await ledger.reserve({
    requestId: "request-pending",
    runId: "canvas-budget",
    taskId: "paint.sky",
    model: "painter-model",
    estimatedCostMicros: 300_000n,
  });
  assert.throws(
    () => ledger.taskUsage("canvas-budget", "paint.sky"),
    /unsettled provider calls/
  );
  assert.throws(
    () => ledger.forgetTask("canvas-budget", "paint.sky"),
    /unsettled provider calls/
  );
  await pending.release("provider rejected request");
  ledger.forgetTask("canvas-budget", "paint.sky");
});
