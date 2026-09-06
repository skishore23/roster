import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableOpenAIRateLimit,
  openAIRequestLimits,
  openAIRetryLimits,
} from "../../src/adapters/openai.ts";
import {
  codingCliViewerLimits,
  workspaceViewerLimits,
} from "../../src/adapters/spacetimedb-web-access.ts";

test("OpenAI request and rate-limit retry settings reject malformed numeric input", () => {
  assert.deepEqual(openAIRequestLimits({
    OPENAI_MAX_OUTPUT_TOKENS: "not-a-number",
    OPENAI_SDK_MAX_RETRIES: "Infinity",
    OPENAI_TIMEOUT_MS: "",
  }), {
    maxOutputTokens: 4_096,
    maxRetries: 1,
    timeoutMs: 120_000,
  });
  assert.deepEqual(openAIRetryLimits({
    OPENAI_MAX_RETRIES: "not-a-number",
    OPENAI_RETRY_BASE_MS: "Infinity",
  }), {
    maxRetries: 3,
    baseDelayMs: 500,
  });
  assert.deepEqual(openAIRetryLimits({
    OPENAI_MAX_RETRIES: "99.8",
    OPENAI_RETRY_BASE_MS: "99999.8",
  }), {
    maxRetries: 10,
    baseDelayMs: 60_000,
  });
});

test("OpenAI retries transient throttles but not hard 429 quota failures", () => {
  assert.equal(isRetryableOpenAIRateLimit(Object.assign(
    new Error("Rate limit reached for requests"),
    { status: 429, code: "rate_limit_exceeded" },
  )), true);
  assert.equal(isRetryableOpenAIRateLimit(Object.assign(
    new Error("You exceeded your current quota and billing limit"),
    { status: 429, code: "insufficient_quota" },
  )), false);
  assert.equal(isRetryableOpenAIRateLimit(Object.assign(
    new Error("You exceeded your current quota"),
    { status: 429 },
  )), false);
});

test("workspace viewer capability limits are finite u32-compatible integers", () => {
  assert.deepEqual(workspaceViewerLimits({
    ROSTER_VIEWER_MAX_USES: "NaN",
    ROSTER_VIEWER_TTL_SECONDS: "Infinity",
  }), {
    maxUses: 10_000,
    ttlSeconds: 86_400,
  });
  assert.deepEqual(workspaceViewerLimits({
    ROSTER_VIEWER_MAX_USES: "23.9",
    ROSTER_VIEWER_TTL_SECONDS: "90.9",
  }), {
    maxUses: 23,
    ttlSeconds: 90,
  });
  assert.deepEqual(codingCliViewerLimits({}), { maxUses: 8, ttlSeconds: 600 });
  assert.deepEqual(codingCliViewerLimits({
    ROSTER_CODING_CLI_VIEWER_MAX_USES: "999",
    ROSTER_CODING_CLI_VIEWER_TTL_SECONDS: "999999",
  }), { maxUses: 32, ttlSeconds: 3_600 });
});
