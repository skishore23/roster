import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RUNTIME_BINDING_ATTEMPT_LEASES,
  RuntimeBindingDrainTimeoutError,
  RuntimeBindingEpochLifecycleManager,
  RuntimeBindingPublishRollbackError,
} from "../../src/engine/runtime/runtime-binding-lifecycle.js";
import { RuntimeEffectCleanupError } from "../../src/engine/runtime/runtime-effect-scope.js";

type TestRuntime = {
  readonly name: string;
};

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const publishFirstEpoch = async (
  manager: RuntimeBindingEpochLifecycleManager<TestRuntime>,
  events: string[] = [],
): Promise<void> => {
  const transition = await manager.replace({
    epoch: 1,
    activate: (scope, identity) => {
      events.push(`activate:${identity.nodeId}:${identity.epoch}`);
      scope.defer(() => { events.push("close:one"); });
      return { name: "one" };
    },
    validateReady: (runtime, identity) => {
      events.push(`ready:${runtime.name}:${identity.epoch}`);
    },
    publish: (identity) => {
      events.push(`publish:${identity.nodeId}:${identity.epoch}`);
    },
  });
  assert.equal(transition.identity.nodeId, "node-a");
  assert.equal(transition.identity.epoch, 1);
  assert.deepEqual(transition.diagnostics, []);
};

test("candidate stays private through readiness and durable publication", async () => {
  const events: string[] = [];
  const manager = new RuntimeBindingEpochLifecycleManager<TestRuntime>({ nodeId: "node-a" });
  await manager.replace({
    epoch: 1,
    activate: (scope, identity) => {
      events.push(`activate:${identity.epoch}`);
      assert.throws(() => manager.acquire({ attemptId: "too-early" }), /has no current epoch/);
      scope.defer(() => { events.push("close:one"); });
      return { name: "one" };
    },
    validateReady: (runtime) => {
      events.push(`ready:${runtime.name}`);
      assert.throws(() => manager.acquire({ attemptId: "still-private" }), /has no current epoch/);
    },
    publish: (identity) => {
      events.push(`publish:${identity.epoch}`);
      assert.throws(() => manager.acquire({ attemptId: "not-yet-current" }), /has no current epoch/);
    },
  });
  const lease = manager.acquire({ attemptId: "attempt-one" });
  assert.equal(lease.nodeId, "node-a");
  assert.equal(lease.epoch, 1);
  assert.equal(lease.runtime.name, "one");
  lease.release();
  lease.release();
  assert.deepEqual(events, ["activate:1", "ready:one", "publish:1"]);
  await manager.close();
  assert.deepEqual(events, ["activate:1", "ready:one", "publish:1", "close:one"]);
});

test("published candidate becomes current while the prior epoch drains", async () => {
  const events: string[] = [];
  const manager = new RuntimeBindingEpochLifecycleManager<TestRuntime>({
    nodeId: "node-a",
    limits: { drainTimeoutMs: 1_000 },
  });
  await publishFirstEpoch(manager, events);
  const oldLease = manager.acquire({ attemptId: "old-attempt" });

  const replacing = manager.replace({
    epoch: 2,
    activate: (scope) => {
      events.push("activate:two");
      scope.defer(() => { events.push("close:two"); });
      return { name: "two" };
    },
    validateReady: () => { events.push("ready:two"); },
    publish: () => { events.push("publish:two"); },
  });
  await waitUntil(() => events.includes("publish:two"), "epoch two publication");

  const newLease = manager.acquire({ attemptId: "new-attempt" });
  assert.equal(newLease.epoch, 2);
  assert.equal(newLease.runtime.name, "two");
  assert.equal(events.includes("close:one"), false);
  oldLease.release();
  const transition = await replacing;
  assert.equal(transition.previousEpoch, 1);
  assert.deepEqual(transition.diagnostics, []);
  assert.equal(events.includes("close:one"), true);
  newLease.release();
  await manager.close();
});

test("readiness failure rolls back candidate without publishing", async () => {
  const manager = new RuntimeBindingEpochLifecycleManager<TestRuntime>({ nodeId: "node-a" });
  await publishFirstEpoch(manager);
  const readiness = new Error("candidate is not ready");
  let candidateClosed = 0;
  let published = false;
  await assert.rejects(manager.replace({
    epoch: 2,
    activate: (scope) => {
      scope.defer(() => { candidateClosed += 1; });
      return { name: "two" };
    },
    validateReady: () => { throw readiness; },
    publish: () => { published = true; },
  }), (error: unknown) => error === readiness);
  assert.equal(candidateClosed, 1);
  assert.equal(published, false);
  const lease = manager.acquire({ attemptId: "still-old" });
  assert.equal(lease.epoch, 1);
  lease.release();
  await manager.close();
});

test("publish failure rolls back candidate and leaves prior epoch current", async () => {
  const manager = new RuntimeBindingEpochLifecycleManager<TestRuntime>({ nodeId: "node-a" });
  await publishFirstEpoch(manager);
  const publishFailure = new Error("durable publish failed");
  let candidateClosed = 0;
  await assert.rejects(manager.replace({
    epoch: 2,
    activate: (scope) => {
      scope.defer(() => { candidateClosed += 1; });
      return { name: "two" };
    },
    validateReady: () => undefined,
    publish: () => { throw publishFailure; },
  }), (error: unknown) => error === publishFailure);
  assert.equal(candidateClosed, 1);
  const lease = manager.acquire({ attemptId: "still-one" });
  assert.equal(lease.epoch, 1);
  lease.release();
  await manager.close();
});

test("publish and rollback failure preserve both errors", async () => {
  const manager = new RuntimeBindingEpochLifecycleManager<TestRuntime>({ nodeId: "node-a" });
  const publishFailure = Object.freeze({ durable: "failed" });
  const cleanupFailure = new Error("candidate cleanup failed");
  await assert.rejects(manager.replace({
    epoch: 1,
    activate: (scope) => {
      scope.defer(() => { throw cleanupFailure; }, "candidate-cleanup");
      return { name: "one" };
    },
    validateReady: () => undefined,
    publish: () => { throw publishFailure; },
  }), (error: unknown) => {
    assert.ok(error instanceof RuntimeBindingPublishRollbackError);
    assert.equal(error.code, "ROSTER_RUNTIME_BINDING_PUBLISH_AND_ROLLBACK_FAILED");
    assert.equal(error.publishError, publishFailure);
    assert.equal(error.cause, publishFailure);
    assert.ok(error.cleanupError instanceof RuntimeEffectCleanupError);
    assert.equal(error.cleanupError.failures[0]?.error, cleanupFailure);
    assert.deepEqual(error.identity, { nodeId: "node-a", epoch: 1 });
    return true;
  });
  assert.equal(manager.current, undefined);
  await manager.close();
});

test("old cleanup failure after publish is forward diagnostics and never rollback", async () => {
  const cleanupFailure = new Error("old epoch cleanup failed");
  const manager = new RuntimeBindingEpochLifecycleManager<TestRuntime>({ nodeId: "node-a" });
  await manager.replace({
    epoch: 1,
    activate: (scope) => {
      scope.defer(() => { throw cleanupFailure; });
      return { name: "one" };
    },
    validateReady: () => undefined,
    publish: () => undefined,
  });
  let epochTwoPublished = 0;
  const transition = await manager.replace({
    epoch: 2,
    activate: () => ({ name: "two" }),
    validateReady: () => undefined,
    publish: () => { epochTwoPublished += 1; },
  });
  assert.equal(epochTwoPublished, 1);
  assert.equal(transition.diagnostics.length, 1);
  assert.equal(transition.diagnostics[0]?.kind, "cleanup-failed");
  assert.equal(transition.diagnostics[0]?.identity.epoch, 1);
  assert.equal(transition.diagnostics[0]?.error.failures[0]?.error, cleanupFailure);
  const lease = manager.acquire({ attemptId: "epoch-two" });
  assert.equal(lease.epoch, 2);
  lease.release();
  await manager.close();
});

test("drain timeout aborts bounded old leases then closes the old epoch", async () => {
  const events: string[] = [];
  const manager = new RuntimeBindingEpochLifecycleManager<TestRuntime>({
    nodeId: "node-a",
    limits: { drainTimeoutMs: 30 },
  });
  await publishFirstEpoch(manager, events);
  const oldLease = manager.acquire({ attemptId: "stuck-attempt" });
  const startedAt = performance.now();
  const transition = await manager.replace({
    epoch: 2,
    activate: () => ({ name: "two" }),
    validateReady: () => undefined,
    publish: () => undefined,
  });
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 20 && elapsed < 500, `drain elapsed ${elapsed}ms`);
  assert.equal(oldLease.signal.aborted, true);
  assert.ok(oldLease.signal.reason instanceof RuntimeBindingDrainTimeoutError);
  assert.equal(events.includes("close:one"), true);
  assert.equal(transition.diagnostics.length, 1);
  const diagnostic = transition.diagnostics[0];
  assert.equal(diagnostic?.kind, "drain-timeout");
  if (diagnostic?.kind === "drain-timeout") {
    assert.deepEqual(diagnostic.error.attemptIds, ["stuck-attempt"]);
    assert.equal(diagnostic.error.epoch, 1);
  }
  oldLease.release();
  await manager.close();
});

test("epochs and active attempt leases remain strictly bounded", async () => {
  const manager = new RuntimeBindingEpochLifecycleManager<TestRuntime>({
    nodeId: "node-a",
    limits: { maxAttemptLeases: 2 },
  });
  await publishFirstEpoch(manager);
  const first = manager.acquire({ attemptId: "first" });
  const second = manager.acquire({ attemptId: "second" });
  assert.throws(() => manager.acquire({ attemptId: "third" }), /exceeded maxAttemptLeases=2/);
  assert.throws(() => manager.acquire({ attemptId: "first" }), /already leased attempt first/);
  await assert.rejects(manager.replace({
    epoch: 1,
    activate: () => ({ name: "duplicate" }),
    validateReady: () => undefined,
    publish: () => undefined,
  }), /must be greater than published epoch 1/);
  first.release();
  second.release();
  assert.throws(() => new RuntimeBindingEpochLifecycleManager({
    nodeId: "node-a",
    limits: { maxAttemptLeases: MAX_RUNTIME_BINDING_ATTEMPT_LEASES + 1 },
  }), /maxAttemptLeases must be between/);
  assert.throws(() => JSON.stringify(manager), /process-local and cannot be serialized/);
  await manager.close();
});
