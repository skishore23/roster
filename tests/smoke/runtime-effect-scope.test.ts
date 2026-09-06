import assert from "node:assert/strict";
import test from "node:test";

import {
  activateRuntimeComponent,
  MAX_RUNTIME_EFFECT_CLEANUP_TIMEOUT_MS,
  MAX_RUNTIME_EFFECT_DISPOSERS,
  RuntimeEffectCleanupDeadlineError,
  RuntimeEffectCleanupError,
  RuntimeEffectOperationError,
  RuntimeEffectScope,
  runWithRuntimeEffectScope,
  type RuntimeEffectOwner,
} from "../../src/engine/runtime/runtime-effect-scope.js";

const activationOwner = {
  kind: "activation" as const,
  activationId: "runtime-test-activation",
};

test("runtime effect scope disposes sync and async effects in LIFO order exactly once", async () => {
  const order: string[] = [];
  const scope = new RuntimeEffectScope({ owner: activationOwner });
  scope.defer(() => { order.push("first"); }, "first");
  scope.defer(async () => {
    order.push("second:start");
    await Promise.resolve();
    order.push("second:end");
  }, "second");
  scope.defer(() => { order.push("third"); }, "third");

  const firstClose = scope.close();
  const concurrentClose = scope.close();
  assert.strictEqual(concurrentClose, firstClose);
  assert.equal(scope.state, "closing");
  assert.throws(
    () => scope.defer(() => undefined),
    /after scope entered closing state/,
  );

  await firstClose;
  assert.deepEqual(order, ["third", "second:start", "second:end", "first"]);
  assert.equal(scope.state, "closed");
  assert.equal(scope.size, 0);
  assert.strictEqual(scope.close(), firstClose);
  await scope.close();
  assert.deepEqual(order, ["third", "second:start", "second:end", "first"]);
});

test("runtime effect scope enforces disposer and cleanup bounds", async () => {
  const scope = new RuntimeEffectScope({
    owner: activationOwner,
    limits: { maxDisposers: 2, cleanupTimeoutMs: 50 },
  });
  scope.defer(() => undefined);
  scope.defer(() => undefined);
  assert.throws(
    () => scope.defer(() => undefined),
    /exceeded maxDisposers=2/,
  );
  await scope.close();

  assert.throws(() => new RuntimeEffectScope({
    owner: activationOwner,
    limits: { maxDisposers: MAX_RUNTIME_EFFECT_DISPOSERS + 1 },
  }), /maxDisposers must be between/);
  assert.throws(() => new RuntimeEffectScope({
    owner: activationOwner,
    limits: { cleanupTimeoutMs: MAX_RUNTIME_EFFECT_CLEANUP_TIMEOUT_MS + 1 },
  }), /cleanupTimeoutMs must be between/);
});

test("ordinary cleanup failures do not prevent lower LIFO disposers", async () => {
  const order: string[] = [];
  const cleanupFailure = new Error("top cleanup failed");
  const scope = new RuntimeEffectScope({ owner: activationOwner });
  scope.defer(() => { order.push("bottom"); }, "bottom");
  scope.defer(() => {
    order.push("top");
    throw cleanupFailure;
  }, "top");

  await assert.rejects(scope.close(), (error: unknown) => {
    assert.ok(error instanceof RuntimeEffectCleanupError);
    assert.equal(error.code, "ROSTER_RUNTIME_EFFECT_CLEANUP_FAILED");
    assert.deepEqual(error.owner, activationOwner);
    assert.equal(error.failures.length, 1);
    assert.equal(error.failures[0]?.kind, "disposer");
    assert.equal(error.failures[0]?.ordinal, 2);
    assert.equal(error.failures[0]?.label, "top");
    assert.equal(error.failures[0]?.error, cleanupFailure);
    assert.equal(error.errors[0], cleanupFailure);
    assert.equal(Object.isFrozen(error.failures), true);
    assert.equal(Object.isFrozen(error.failures[0]), true);
    return true;
  });
  assert.deepEqual(order, ["top", "bottom"]);
  assert.equal(scope.state, "closed");
});

test("one total cleanup deadline bounds a stuck disposer without violating awaited LIFO", async () => {
  let lowerDisposed = false;
  const scope = new RuntimeEffectScope({
    owner: activationOwner,
    limits: { cleanupTimeoutMs: 30 },
  });
  scope.defer(() => { lowerDisposed = true; }, "lower");
  scope.defer(() => new Promise<void>(() => undefined), "stuck");

  const startedAt = performance.now();
  await assert.rejects(scope.close(), (error: unknown) => {
    assert.ok(error instanceof RuntimeEffectCleanupError);
    assert.equal(error.failures.length, 1);
    const failure = error.failures[0];
    assert.equal(failure?.kind, "deadline");
    assert.equal(failure?.ordinal, 2);
    assert.equal(failure?.label, "stuck");
    assert.ok(failure?.error instanceof RuntimeEffectCleanupDeadlineError);
    assert.equal(failure?.error.remainingDisposers, 2);
    assert.equal(failure?.error.cleanupTimeoutMs, 30);
    return true;
  });
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 20 && elapsed < 500, `cleanup elapsed ${elapsed}ms`);
  assert.equal(lowerDisposed, false);
  assert.equal(scope.state, "closed");
});

test("activation failure rolls back partial effects and rethrows the primary when cleanup succeeds", async () => {
  const order: string[] = [];
  const primary = new Error("activation failed");
  let thrown: unknown;
  try {
    await activateRuntimeComponent({
      owner: activationOwner,
      activate: (scope) => {
        scope.defer(() => { order.push("first"); });
        scope.defer(async () => { order.push("second"); });
        throw primary;
      },
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, primary);
  assert.deepEqual(order, ["second", "first"]);
});

test("activation preserves stable primary and cleanup error metadata", async () => {
  const order: string[] = [];
  const primary = Object.freeze({ reason: "activation rejected" });
  const cleanup = new Error("cleanup rejected");

  await assert.rejects(activateRuntimeComponent({
    owner: activationOwner,
    activate: (scope) => {
      scope.defer(() => { order.push("lower"); }, "lower");
      scope.defer(() => {
        order.push("upper");
        throw cleanup;
      }, "upper");
      throw primary;
    },
  }), (error: unknown) => {
    assert.ok(error instanceof RuntimeEffectOperationError);
    assert.equal(error.code, "ROSTER_RUNTIME_EFFECT_OPERATION_AND_CLEANUP_FAILED");
    assert.equal(error.phase, "activation");
    assert.equal(error.primaryError, primary);
    assert.equal(error.cause, primary);
    assert.ok(error.cleanupError instanceof RuntimeEffectCleanupError);
    assert.equal(error.cleanupError.failures[0]?.error, cleanup);
    assert.deepEqual(error.errors, [primary, error.cleanupError]);
    assert.deepEqual(error.owner, activationOwner);
    return true;
  });
  assert.deepEqual(order, ["upper", "lower"]);
});

test("successful activation transfers one explicit close handle", async () => {
  let disposed = 0;
  const active = await activateRuntimeComponent({
    owner: activationOwner,
    activate: (scope) => {
      scope.defer(() => { disposed += 1; });
      return Object.freeze({ ready: true });
    },
  });
  assert.deepEqual(active.value, { ready: true });
  assert.equal(active.scope.state, "open");
  const firstClose = active.close();
  assert.strictEqual(active.close(), firstClose);
  await firstClose;
  assert.equal(disposed, 1);
});

test("all owner kinds are snapshotted and lifecycle objects reject serialization", async () => {
  const owners: RuntimeEffectOwner[] = [
    { kind: "activation", activationId: "activation-a" },
    {
      kind: "task-attempt",
      executionId: "execution-a",
      runId: "run-a",
      taskId: "task-a",
      attempt: 2,
      fence: 3,
    },
    { kind: "runtime-binding", nodeId: "node-a", epoch: 4 },
    { kind: "process", processId: "server-a" },
  ];
  for (const owner of owners) {
    const scope = new RuntimeEffectScope({ owner });
    assert.notStrictEqual(scope.owner, owner);
    assert.deepEqual(scope.owner, owner);
    assert.equal(Object.isFrozen(scope.owner), true);
    assert.throws(() => JSON.stringify(scope), /process-local and cannot be serialized/);
    await scope.close();
  }

  const active = await activateRuntimeComponent({
    owner: activationOwner,
    activate: () => "ready",
  });
  assert.throws(() => JSON.stringify(active), /process-local and cannot be serialized/);
  await active.close();
});

test("bounded execution closes attempt effects on success and preserves dual failure", async () => {
  const order: string[] = [];
  const owner = {
    kind: "task-attempt" as const,
    executionId: "execution-run-helper",
    runId: "run-helper",
    taskId: "task-helper",
    attempt: 1,
    fence: 2,
  };
  assert.equal(await runWithRuntimeEffectScope({
    owner,
    run: (scope) => {
      scope.defer(() => { order.push("closed"); });
      return "completed";
    },
  }), "completed");
  assert.deepEqual(order, ["closed"]);

  const primary = new Error("execution failed");
  await assert.rejects(runWithRuntimeEffectScope({
    owner,
    run: (scope) => {
      scope.defer(() => {
        throw new Error("execution cleanup failed");
      });
      throw primary;
    },
  }), (error: unknown) => {
    assert.ok(error instanceof RuntimeEffectOperationError);
    assert.equal(error.phase, "execution");
    assert.equal(error.primaryError, primary);
    return true;
  });
});
