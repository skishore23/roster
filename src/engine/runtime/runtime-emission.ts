import { hashCanonical } from "../../core/canonical.js";
import type {
  RosterFunctionEffect,
  RosterFunctionIdempotency,
} from "../functions/function-directory.js";
import type { DynamicTaskDefinition } from "../platform/protocol.js";

export const ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION =
  "roster.runtime-emission-classification.v1" as const;
export const ROSTER_RUNTIME_EMISSION_INTENT_VERSION =
  "roster.runtime-emission-intent.v1" as const;
export const ROSTER_RUNTIME_COMPENSATION_EVIDENCE_VERSION =
  "roster.runtime-compensation-evidence.v1" as const;

const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/u;
const MAX_ID_BYTES = 240;
const MAX_VERSION_BYTES = 120;
const MAX_HASH_BYTES = 256;
const MAX_IDEMPOTENCY_KEY_BYTES = 512;
const MAX_ERROR_BYTES = 4_000;

type RuntimeEmissionClassificationBase = {
  readonly schemaVersion: typeof ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION;
  readonly classificationId: string;
};

type RuntimeEmissionClassificationContent =
  | {
      readonly schemaVersion: typeof ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION;
      readonly kind: "no-emission";
    }
  | {
      readonly schemaVersion: typeof ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION;
      readonly kind: "deferred-until-acceptance";
    }
  | {
      readonly schemaVersion: typeof ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION;
      readonly kind: "idempotent-with-key";
      readonly idempotencyKey: string;
    }
  | {
      readonly schemaVersion: typeof ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION;
      readonly kind: "immediate-nonrepeatable";
    }
  | {
      readonly schemaVersion: typeof ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION;
      readonly kind: "compensatable";
      readonly compensation: RuntimeCompensationSpecification;
    };

export type RuntimeCompensationSpecification = {
  readonly handlerId: string;
  readonly handlerVersion: string;
  readonly idempotencyKey: string;
  /** Application-owned equivalence; compensation does not restore exact history. */
  readonly equivalenceId: string;
  readonly equivalenceVersion: string;
};

export type RuntimeEmissionClassification =
  | RuntimeEmissionClassificationBase & {
      readonly kind: "no-emission";
    }
  | RuntimeEmissionClassificationBase & {
      readonly kind: "deferred-until-acceptance";
    }
  | RuntimeEmissionClassificationBase & {
      readonly kind: "idempotent-with-key";
      readonly idempotencyKey: string;
    }
  | RuntimeEmissionClassificationBase & {
      readonly kind: "immediate-nonrepeatable";
    }
  | RuntimeEmissionClassificationBase & {
      readonly kind: "compensatable";
      readonly compensation: RuntimeCompensationSpecification;
    };

export type RuntimeEmissionClassificationInput =
  | { readonly kind: "no-emission" }
  | { readonly kind: "deferred-until-acceptance" }
  | {
      readonly kind: "idempotent-with-key";
      readonly idempotencyKey: string;
    }
  | { readonly kind: "immediate-nonrepeatable" }
  | {
      readonly kind: "compensatable";
      readonly compensation: RuntimeCompensationSpecification;
    };

export type RuntimeEmissionIntent = {
  readonly schemaVersion: typeof ROSTER_RUNTIME_EMISSION_INTENT_VERSION;
  readonly intentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly taskDefinitionHash: string;
  readonly payloadHash: string;
  readonly classification: RuntimeEmissionClassification;
};

export type RuntimeCompensationEvidence = {
  readonly schemaVersion: typeof ROSTER_RUNTIME_COMPENSATION_EVIDENCE_VERSION;
  readonly evidenceId: string;
  readonly semantics: "forward-compensation";
  readonly intentId: string;
  readonly emissionEvidenceHash: string;
  readonly compensationAttempt: number;
  readonly compensation: RuntimeCompensationSpecification;
  readonly outcome: "completed" | "failed";
  readonly resultHash?: string;
  readonly error?: string;
};

const encodedBytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const boundedText = (
  value: string,
  label: string,
  maximumBytes: number,
): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (
    !normalized
    || encodedBytes(normalized) > maximumBytes
    || /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error(`${label} must be non-empty, bounded, and contain no control characters`);
  }
  return normalized;
};

const boundedId = (value: string, label: string): string => {
  const normalized = boundedText(value, label, MAX_ID_BYTES);
  if (!ID_PATTERN.test(normalized)) throw new Error(`${label} is not a valid identifier`);
  return normalized;
};

const boundedHash = (value: string, label: string): string =>
  boundedText(value, label, MAX_HASH_BYTES);

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
};

const idempotencyKey = (value: string, label: string): string =>
  boundedText(value, label, MAX_IDEMPOTENCY_KEY_BYTES);

const normalizeCompensation = (
  input: RuntimeCompensationSpecification,
): RuntimeCompensationSpecification => Object.freeze({
  handlerId: boundedId(input.handlerId, "Runtime compensation handlerId"),
  handlerVersion: boundedText(
    input.handlerVersion,
    "Runtime compensation handlerVersion",
    MAX_VERSION_BYTES,
  ),
  idempotencyKey: idempotencyKey(
    input.idempotencyKey,
    "Runtime compensation idempotencyKey",
  ),
  equivalenceId: boundedId(
    input.equivalenceId,
    "Runtime compensation equivalenceId",
  ),
  equivalenceVersion: boundedText(
    input.equivalenceVersion,
    "Runtime compensation equivalenceVersion",
    MAX_VERSION_BYTES,
  ),
});

const classificationContent = (
  input: RuntimeEmissionClassificationInput,
): RuntimeEmissionClassificationContent => {
  switch (input.kind) {
    case "no-emission":
    case "deferred-until-acceptance":
    case "immediate-nonrepeatable":
      return {
        schemaVersion: ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION,
        kind: input.kind,
      };
    case "idempotent-with-key":
      return {
        schemaVersion: ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION,
        kind: input.kind,
        idempotencyKey: idempotencyKey(
          input.idempotencyKey,
          "Runtime emission idempotencyKey",
        ),
      };
    case "compensatable":
      return {
        schemaVersion: ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION,
        kind: input.kind,
        compensation: normalizeCompensation(input.compensation),
      };
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
};

export const createRuntimeEmissionClassification = (
  input: RuntimeEmissionClassificationInput,
): RuntimeEmissionClassification => {
  const content = classificationContent(input);
  return Object.freeze({
    ...content,
    classificationId: `runtime_emission_class_${hashCanonical(content).slice(0, 28)}`,
  } as RuntimeEmissionClassification);
};

export const validateRuntimeEmissionClassification = (
  classification: RuntimeEmissionClassification,
): RuntimeEmissionClassification => {
  if (
    !classification
    || classification.schemaVersion !== ROSTER_RUNTIME_EMISSION_CLASSIFICATION_VERSION
  ) {
    throw new Error("Runtime emission classification has an unsupported schemaVersion");
  }
  let expected: RuntimeEmissionClassification;
  switch (classification.kind) {
    case "no-emission":
    case "deferred-until-acceptance":
    case "immediate-nonrepeatable":
      expected = createRuntimeEmissionClassification({ kind: classification.kind });
      break;
    case "idempotent-with-key":
      expected = createRuntimeEmissionClassification({
        kind: classification.kind,
        idempotencyKey: classification.idempotencyKey,
      });
      break;
    case "compensatable":
      expected = createRuntimeEmissionClassification({
        kind: classification.kind,
        compensation: classification.compensation,
      });
      break;
    default:
      throw new Error("Runtime emission classification has an unsupported kind");
  }
  if (
    expected.classificationId !== classification.classificationId
    || hashCanonical(expected) !== hashCanonical(classification)
  ) {
    throw new Error("Runtime emission classification identity does not match its exact contents");
  }
  return expected;
};

export const createRuntimeEmissionIntent = (input: {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly taskDefinitionHash: string;
  readonly payloadHash: string;
  readonly classification: RuntimeEmissionClassification;
}): RuntimeEmissionIntent => {
  const classification = validateRuntimeEmissionClassification(input.classification);
  const content = Object.freeze({
    schemaVersion: ROSTER_RUNTIME_EMISSION_INTENT_VERSION,
    runId: boundedId(input.runId, "Runtime emission runId"),
    taskId: boundedId(input.taskId, "Runtime emission taskId"),
    nodeId: boundedId(input.nodeId, "Runtime emission nodeId"),
    operationId: boundedId(input.operationId, "Runtime emission operationId"),
    attempt: positiveInteger(input.attempt, "Runtime emission attempt"),
    taskDefinitionHash: boundedHash(
      input.taskDefinitionHash,
      "Runtime emission taskDefinitionHash",
    ),
    payloadHash: boundedHash(input.payloadHash, "Runtime emission payloadHash"),
    classification,
  });
  return Object.freeze({
    ...content,
    intentId: `runtime_emission_intent_${hashCanonical(content).slice(0, 28)}`,
  });
};

export const validateRuntimeEmissionIntent = (
  intent: RuntimeEmissionIntent,
): RuntimeEmissionIntent => {
  if (!intent || intent.schemaVersion !== ROSTER_RUNTIME_EMISSION_INTENT_VERSION) {
    throw new Error("Runtime emission intent has an unsupported schemaVersion");
  }
  const expected = createRuntimeEmissionIntent({
    runId: intent.runId,
    taskId: intent.taskId,
    nodeId: intent.nodeId,
    operationId: intent.operationId,
    attempt: intent.attempt,
    taskDefinitionHash: intent.taskDefinitionHash,
    payloadHash: intent.payloadHash,
    classification: intent.classification,
  });
  if (
    expected.intentId !== intent.intentId
    || hashCanonical(expected) !== hashCanonical(intent)
  ) {
    throw new Error("Runtime emission intent identity does not match its exact contents");
  }
  return expected;
};

/**
 * Records a compensation attempt as a new fact. It does not erase the original
 * emission intent or claim that durable history was reversed.
 */
export const createRuntimeCompensationEvidence = (input: {
  readonly intent: RuntimeEmissionIntent;
  readonly emissionEvidenceHash: string;
  readonly compensationAttempt: number;
  readonly outcome: "completed" | "failed";
  readonly resultHash?: string;
  readonly error?: string;
}): RuntimeCompensationEvidence => {
  const intent = validateRuntimeEmissionIntent(input.intent);
  if (intent.classification.kind !== "compensatable") {
    throw new Error("Runtime compensation requires a compensatable emission intent");
  }
  const outcome = input.outcome;
  if (outcome !== "completed" && outcome !== "failed") {
    throw new Error("Runtime compensation outcome must be completed or failed");
  }
  const resultHash = input.resultHash === undefined
    ? undefined
    : boundedHash(input.resultHash, "Runtime compensation resultHash");
  const error = input.error === undefined
    ? undefined
    : boundedText(input.error, "Runtime compensation error", MAX_ERROR_BYTES);
  if (outcome === "completed" && (!resultHash || error)) {
    throw new Error("Completed runtime compensation requires resultHash and forbids error");
  }
  if (outcome === "failed" && (!error || resultHash)) {
    throw new Error("Failed runtime compensation requires error and forbids resultHash");
  }
  const content = Object.freeze({
    schemaVersion: ROSTER_RUNTIME_COMPENSATION_EVIDENCE_VERSION,
    semantics: "forward-compensation" as const,
    intentId: intent.intentId,
    emissionEvidenceHash: boundedHash(
      input.emissionEvidenceHash,
      "Runtime compensation emissionEvidenceHash",
    ),
    compensationAttempt: positiveInteger(
      input.compensationAttempt,
      "Runtime compensation attempt",
    ),
    compensation: intent.classification.compensation,
    outcome,
    ...(resultHash ? { resultHash } : {}),
    ...(error ? { error } : {}),
  });
  return Object.freeze({
    ...content,
    evidenceId: `runtime_compensation_${hashCanonical(content).slice(0, 28)}`,
  });
};

export const validateRuntimeCompensationEvidence = (input: {
  readonly intent: RuntimeEmissionIntent;
  readonly evidence: RuntimeCompensationEvidence;
}): RuntimeCompensationEvidence => {
  const { evidence } = input;
  if (
    !evidence
    || evidence.schemaVersion !== ROSTER_RUNTIME_COMPENSATION_EVIDENCE_VERSION
    || evidence.semantics !== "forward-compensation"
  ) {
    throw new Error("Runtime compensation evidence has an unsupported forward-evidence contract");
  }
  const expected = createRuntimeCompensationEvidence({
    intent: input.intent,
    emissionEvidenceHash: evidence.emissionEvidenceHash,
    compensationAttempt: evidence.compensationAttempt,
    outcome: evidence.outcome,
    ...(evidence.resultHash !== undefined ? { resultHash: evidence.resultHash } : {}),
    ...(evidence.error !== undefined ? { error: evidence.error } : {}),
  });
  if (
    evidence.intentId !== input.intent.intentId
    || expected.evidenceId !== evidence.evidenceId
    || hashCanonical(expected) !== hashCanonical(evidence)
  ) {
    throw new Error("Runtime compensation evidence identity does not match its exact contents");
  }
  return expected;
};

export const taskSideEffectForRuntimeEmission = (
  classification: RuntimeEmissionClassification,
): DynamicTaskDefinition["sideEffect"] => {
  const validated = validateRuntimeEmissionClassification(classification);
  switch (validated.kind) {
    case "no-emission":
    case "deferred-until-acceptance":
      return "pure";
    case "idempotent-with-key":
      return "idempotent";
    case "immediate-nonrepeatable":
    case "compensatable":
      return "non-repeatable";
    default: {
      const _exhaustive: never = validated;
      return _exhaustive;
    }
  }
};

export const runtimeEmissionForTaskSideEffect = (
  sideEffect: DynamicTaskDefinition["sideEffect"],
  options: { readonly idempotencyKey?: string } = {},
): RuntimeEmissionClassification => {
  switch (sideEffect) {
    case "pure":
      return createRuntimeEmissionClassification({ kind: "no-emission" });
    case "idempotent":
      if (options.idempotencyKey === undefined) {
        throw new Error("Idempotent task emission requires an exact idempotencyKey");
      }
      return createRuntimeEmissionClassification({
        kind: "idempotent-with-key",
        idempotencyKey: options.idempotencyKey,
      });
    case "non-repeatable":
      return createRuntimeEmissionClassification({ kind: "immediate-nonrepeatable" });
    default:
      throw new Error("Task sideEffect has an unsupported value");
  }
};

export const assertRuntimeEmissionMatchesTaskSideEffect = (
  classification: RuntimeEmissionClassification,
  sideEffect: DynamicTaskDefinition["sideEffect"],
): RuntimeEmissionClassification => {
  const validated = validateRuntimeEmissionClassification(classification);
  const expected = taskSideEffectForRuntimeEmission(validated);
  if (expected !== sideEffect) {
    throw new Error(
      `Runtime emission ${validated.kind} requires task sideEffect ${expected}, not ${sideEffect}`,
    );
  }
  return validated;
};

const normalizedFunctionEffects = (
  effects: ReadonlyArray<RosterFunctionEffect>,
): ReadonlyArray<RosterFunctionEffect> => {
  const normalized = [...new Set(effects)].sort();
  if (
    normalized.some((effect) =>
      effect !== "read" && effect !== "write" && effect !== "external")
  ) {
    throw new Error("Runtime emission function effects contain an unsupported value");
  }
  return normalized;
};

const functionMayEmit = (effects: ReadonlyArray<RosterFunctionEffect>): boolean =>
  effects.includes("write") || effects.includes("external");

export const runtimeEmissionForFunctionEffects = (input: {
  readonly effects: ReadonlyArray<RosterFunctionEffect>;
  readonly idempotency?: RosterFunctionIdempotency;
  readonly idempotencyKey?: string;
}): RuntimeEmissionClassification => {
  const effects = normalizedFunctionEffects(input.effects);
  if (!functionMayEmit(effects)) {
    return createRuntimeEmissionClassification({ kind: "no-emission" });
  }
  if (
    input.idempotencyKey !== undefined
    && (input.idempotency === "required" || input.idempotency === "supported")
  ) {
    return createRuntimeEmissionClassification({
      kind: "idempotent-with-key",
      idempotencyKey: input.idempotencyKey,
    });
  }
  return createRuntimeEmissionClassification({ kind: "immediate-nonrepeatable" });
};

export const assertRuntimeEmissionMatchesFunctionEffects = (input: {
  readonly classification: RuntimeEmissionClassification;
  readonly effects: ReadonlyArray<RosterFunctionEffect>;
  readonly idempotency?: RosterFunctionIdempotency;
}): RuntimeEmissionClassification => {
  const classification = validateRuntimeEmissionClassification(input.classification);
  const effects = normalizedFunctionEffects(input.effects);
  const mayEmit = functionMayEmit(effects);
  if (classification.kind === "no-emission" && mayEmit) {
    throw new Error("no-emission is incompatible with write or external function effects");
  }
  if (classification.kind !== "no-emission" && !mayEmit) {
    throw new Error(`${classification.kind} requires a write or external function effect`);
  }
  if (
    classification.kind === "idempotent-with-key"
    && input.idempotency !== "required"
    && input.idempotency !== "supported"
  ) {
    throw new Error("idempotent-with-key requires function idempotency support");
  }
  return classification;
};

export const runtimeEmissionPermitsAutomaticRetry = (
  classification: RuntimeEmissionClassification,
): boolean => {
  const kind = validateRuntimeEmissionClassification(classification).kind;
  return kind !== "immediate-nonrepeatable" && kind !== "compensatable";
};

export const assertRuntimeEmissionRetryAllowed = (
  classification: RuntimeEmissionClassification,
  nextAttempt: number,
): void => {
  positiveInteger(nextAttempt, "Runtime emission next attempt");
  if (nextAttempt > 1 && !runtimeEmissionPermitsAutomaticRetry(classification)) {
    throw new Error(
      `Runtime emission ${classification.kind} cannot be retried automatically after execution begins`,
    );
  }
};
