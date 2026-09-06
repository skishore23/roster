import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelProviderHealthRegistry,
  ModelProviderUnavailableError,
} from "../../src/engine/runtime/model-provider-health.js";

test("hard provider failures block new admission until an explicit reset", async () => {
  let calls = 0;
  const registry = new ModelProviderHealthRegistry();
  const quota = Object.assign(new Error("insufficient_quota: billing limit reached"), {
    status: 429,
    code: "insufficient_quota",
  });

  await assert.rejects(
    registry.execute("OpenAI", async () => {
      calls += 1;
      throw quota;
    }),
    (error: unknown) => error === quota,
  );
  assert.deepEqual(registry.snapshot("openai"), {
    providerId: "openai",
    state: "blocked",
    failureClass: "budget",
    retryable: false,
    note: "Model provider quota or billing is unavailable. Update the account limit and restart Roster.",
  });

  await assert.rejects(
    registry.execute("openai", async () => {
      calls += 1;
      return "must not run";
    }),
    (error: unknown) =>
      error instanceof ModelProviderUnavailableError
      && error.failureClass === "budget"
      && error.retryable === false,
  );
  assert.equal(calls, 1, "blocked admission must not call the provider again");

  registry.reset("openai");
  assert.equal(await registry.execute("openai", async () => "healthy"), "healthy");
  assert.equal(registry.snapshot("openai").state, "available");
});

test("rate-limit cooldown is bounded and expires deterministically", async () => {
  let now = 10_000;
  const registry = new ModelProviderHealthRegistry(2_000, () => now);
  registry.recordFailure("openai", Object.assign(new Error("rate limit"), {
    status: 429,
    code: "rate_limit_exceeded",
  }));

  assert.deepEqual(registry.snapshot("openai"), {
    providerId: "openai",
    state: "cooldown",
    failureClass: "rate-limit",
    retryable: true,
    note: "The model provider is temporarily rate-limiting new work.",
    unavailableUntil: 12_000,
  });
  now = 11_999;
  assert.throws(() => registry.assertAvailable("openai"), ModelProviderUnavailableError);
  now = 12_000;
  assert.equal(registry.snapshot("openai").state, "available");
});

test("explicit structured failures survive wrapper boundaries", () => {
  const registry = new ModelProviderHealthRegistry();
  registry.recordFailure("openai", {
    failureClass: "authorization",
    message: "sanitized public message",
  });
  const snapshot = registry.snapshot("openai");
  assert.equal(snapshot.state, "blocked");
  assert.equal(snapshot.failureClass, "authorization");
});
