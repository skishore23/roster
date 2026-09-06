import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRuntimeEmissionMatchesFunctionEffects,
  assertRuntimeEmissionMatchesTaskSideEffect,
  assertRuntimeEmissionRetryAllowed,
  createRuntimeCompensationEvidence,
  createRuntimeEmissionClassification,
  createRuntimeEmissionIntent,
  runtimeEmissionForFunctionEffects,
  runtimeEmissionForTaskSideEffect,
  runtimeEmissionPermitsAutomaticRetry,
  taskSideEffectForRuntimeEmission,
  validateRuntimeCompensationEvidence,
  validateRuntimeEmissionIntent,
  type RuntimeCompensationEvidence,
  type RuntimeEmissionIntent,
} from "../../src/engine/runtime/runtime-emission.ts";

const idempotentClassification = () => createRuntimeEmissionClassification({
  kind: "idempotent-with-key",
  idempotencyKey: "payments:invoice-42:attempt-family-1",
});

const compensatableClassification = () => createRuntimeEmissionClassification({
  kind: "compensatable",
  compensation: {
    handlerId: "payments.refund",
    handlerVersion: "2",
    idempotencyKey: "refund:charge-42",
    equivalenceId: "payments.refunded",
    equivalenceVersion: "1",
  },
});

const intent = (
  classification = idempotentClassification(),
  overrides: Partial<Parameters<typeof createRuntimeEmissionIntent>[0]> = {},
): RuntimeEmissionIntent => createRuntimeEmissionIntent({
  runId: "run-42",
  taskId: "charge-card",
  nodeId: "billing-node",
  operationId: "payments.charge",
  attempt: 1,
  taskDefinitionHash: "task-definition-sha256",
  payloadHash: "payload-sha256",
  classification,
  ...overrides,
});

test("runtime emission idempotency keys are explicit, bounded, and mapped from existing contracts", () => {
  const taskClassification = runtimeEmissionForTaskSideEffect("idempotent", {
    idempotencyKey: " task-key-42 ",
  });
  assert.equal(taskClassification.kind, "idempotent-with-key");
  assert.equal(taskClassification.idempotencyKey, "task-key-42");
  assert.equal(taskSideEffectForRuntimeEmission(taskClassification), "idempotent");
  assert.doesNotThrow(() =>
    assertRuntimeEmissionMatchesTaskSideEffect(taskClassification, "idempotent"));
  assert.throws(
    () => runtimeEmissionForTaskSideEffect("idempotent"),
    /requires an exact idempotencyKey/,
  );
  assert.throws(
    () => createRuntimeEmissionClassification({
      kind: "idempotent-with-key",
      idempotencyKey: " ",
    }),
    /idempotencyKey must be non-empty/,
  );
  assert.throws(
    () => createRuntimeEmissionClassification({
      kind: "idempotent-with-key",
      idempotencyKey: "k".repeat(513),
    }),
    /idempotencyKey must be non-empty, bounded/,
  );

  const functionClassification = runtimeEmissionForFunctionEffects({
    effects: ["external", "write"],
    idempotency: "supported",
    idempotencyKey: "provider-call-42",
  });
  assert.equal(functionClassification.kind, "idempotent-with-key");
  assert.doesNotThrow(() => assertRuntimeEmissionMatchesFunctionEffects({
    classification: functionClassification,
    effects: ["write", "external"],
    idempotency: "supported",
  }));
  assert.throws(() => assertRuntimeEmissionMatchesFunctionEffects({
    classification: functionClassification,
    effects: ["external"],
    idempotency: "none",
  }), /requires function idempotency support/);
});

test("runtime emission intents have immutable exact-content identities", () => {
  const first = intent();
  const replay = intent();
  const changedPayload = intent(idempotentClassification(), { payloadHash: "payload-sha256-b" });

  assert.deepEqual(replay, first);
  assert.notEqual(changedPayload.intentId, first.intentId);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.classification), true);
  assert.equal(validateRuntimeEmissionIntent(first).intentId, first.intentId);

  const forged = {
    ...first,
    payloadHash: "forged-payload-sha256",
  } as RuntimeEmissionIntent;
  assert.throws(
    () => validateRuntimeEmissionIntent(forged),
    /identity does not match its exact contents/,
  );
});

test("compensation is immutable forward evidence and invalid compensation fails closed", () => {
  const originalIntent = intent(compensatableClassification());
  const evidence = createRuntimeCompensationEvidence({
    intent: originalIntent,
    emissionEvidenceHash: "charge-provider-receipt-sha256",
    compensationAttempt: 1,
    outcome: "completed",
    resultHash: "refund-provider-receipt-sha256",
  });

  assert.equal(evidence.semantics, "forward-compensation");
  assert.equal(evidence.intentId, originalIntent.intentId);
  assert.equal("reverted" in evidence, false);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.compensation), true);
  assert.equal(
    validateRuntimeCompensationEvidence({ intent: originalIntent, evidence }).evidenceId,
    evidence.evidenceId,
  );

  assert.throws(() => createRuntimeCompensationEvidence({
    intent: intent(createRuntimeEmissionClassification({ kind: "immediate-nonrepeatable" })),
    emissionEvidenceHash: "provider-receipt-sha256",
    compensationAttempt: 1,
    outcome: "completed",
    resultHash: "result-sha256",
  }), /requires a compensatable emission intent/);
  assert.throws(() => createRuntimeCompensationEvidence({
    intent: originalIntent,
    emissionEvidenceHash: "provider-receipt-sha256",
    compensationAttempt: 1,
    outcome: "completed",
    error: "A completed record cannot carry failure text.",
  }), /requires resultHash and forbids error/);
  assert.throws(() => createRuntimeCompensationEvidence({
    intent: originalIntent,
    emissionEvidenceHash: "provider-receipt-sha256",
    compensationAttempt: 1,
    outcome: "failed",
    resultHash: "result-sha256",
  }), /requires error and forbids resultHash/);

  const forged = {
    ...evidence,
    semantics: "reversal",
  } as unknown as RuntimeCompensationEvidence;
  assert.throws(
    () => validateRuntimeCompensationEvidence({ intent: originalIntent, evidence: forged }),
    /unsupported forward-evidence contract/,
  );
});

test("immediate and compensatable emissions prohibit automatic retry", () => {
  const immediate = createRuntimeEmissionClassification({
    kind: "immediate-nonrepeatable",
  });
  const compensatable = compensatableClassification();
  const deferred = createRuntimeEmissionClassification({
    kind: "deferred-until-acceptance",
  });

  assert.equal(runtimeEmissionPermitsAutomaticRetry(immediate), false);
  assert.equal(runtimeEmissionPermitsAutomaticRetry(compensatable), false);
  assert.equal(runtimeEmissionPermitsAutomaticRetry(deferred), true);
  assert.equal(taskSideEffectForRuntimeEmission(immediate), "non-repeatable");
  assert.equal(taskSideEffectForRuntimeEmission(compensatable), "non-repeatable");
  assert.doesNotThrow(() => assertRuntimeEmissionRetryAllowed(immediate, 1));
  assert.throws(
    () => assertRuntimeEmissionRetryAllowed(immediate, 2),
    /cannot be retried automatically/,
  );
  assert.throws(
    () => assertRuntimeEmissionRetryAllowed(compensatable, 2),
    /cannot be retried automatically/,
  );
  assert.doesNotThrow(() => assertRuntimeEmissionRetryAllowed(deferred, 2));
  assert.throws(
    () => assertRuntimeEmissionMatchesTaskSideEffect(immediate, "idempotent"),
    /requires task sideEffect non-repeatable/,
  );
});

test("read-only functions cannot claim emission and emitting functions cannot claim no-emission", () => {
  const readOnly = runtimeEmissionForFunctionEffects({ effects: ["read"] });
  assert.equal(readOnly.kind, "no-emission");
  assert.doesNotThrow(() => assertRuntimeEmissionMatchesFunctionEffects({
    classification: readOnly,
    effects: ["read"],
  }));
  assert.throws(() => assertRuntimeEmissionMatchesFunctionEffects({
    classification: readOnly,
    effects: ["write"],
  }), /incompatible with write or external/);
  assert.throws(() => assertRuntimeEmissionMatchesFunctionEffects({
    classification: createRuntimeEmissionClassification({
      kind: "immediate-nonrepeatable",
    }),
    effects: ["read"],
  }), /requires a write or external function effect/);
});
