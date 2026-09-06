import { hashCanonical } from "../../core/canonical.js";
import type { RosterFunctionEffect } from "../functions/function-directory.js";
import {
  validateRuntimeEmissionClassification,
  type RuntimeEmissionClassification,
} from "./runtime-emission.js";

export const RUNTIME_EXTENSION_ROLLOUT_RECORD_VERSION =
  "roster.runtime-extension-rollout-record.v1" as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const MAX_ID_BYTES = 240;
const MAX_HASH_BYTES = 256;
const MAX_REASON_BYTES = 2_000;
export const MAX_RUNTIME_EXTENSION_CANARY_EVIDENCE = 32;

export type RuntimeExtensionRolloutAuthority = {
  readonly authorityId: string;
  readonly kind: "human" | "deterministic-policy";
  readonly authorizationHash: string;
};

export type RuntimeExtensionAuthorityEnvelope = {
  readonly functionGrants: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<string>;
  readonly allowedEffects: ReadonlyArray<RosterFunctionEffect>;
  readonly workspaceOperations: ReadonlyArray<"read" | "publish">;
  readonly allowGraphExpansion: boolean;
};

export type RuntimeExtensionRolloutBudget = {
  readonly maxCanaryRuns: number;
  readonly maxTasks: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number;
  readonly maxWallTimeMs: number;
};

export type RuntimeExtensionCanaryEvidence = {
  readonly canaryId: string;
  readonly outcomeHash: string;
  readonly verdict: "passed" | "failed";
  readonly tasks: number;
  readonly tokens: number;
  readonly costMicros: number;
  readonly wallTimeMs: number;
};

export type RuntimeExtensionRolloutProposal = {
  readonly extensionId: string;
  readonly artifactHash: string;
  readonly manifestHash: string;
  readonly proposerId: string;
  readonly baselineEpoch: number;
  readonly targetEpoch: number;
  readonly lastKnownGoodArtifactHash: string;
  readonly lastKnownGoodManifestHash: string;
  readonly baselineAuthority: RuntimeExtensionAuthorityEnvelope;
  readonly candidateAuthority: RuntimeExtensionAuthorityEnvelope;
  readonly baselineBudget: RuntimeExtensionRolloutBudget;
  readonly candidateBudget: RuntimeExtensionRolloutBudget;
  readonly emission: RuntimeEmissionClassification;
};

type RuntimeExtensionRolloutBody =
  | {
      readonly type: "proposed";
      readonly proposal: RuntimeExtensionRolloutProposal;
    }
  | {
      readonly type: "verified";
      readonly authority: RuntimeExtensionRolloutAuthority;
      readonly evidenceHash: string;
    }
  | {
      readonly type: "warming";
      readonly evidenceHash: string;
    }
  | {
      readonly type: "canary";
      readonly authority: RuntimeExtensionRolloutAuthority;
      readonly evidence: ReadonlyArray<RuntimeExtensionCanaryEvidence>;
    }
  | {
      readonly type: "promoted";
      readonly authority: RuntimeExtensionRolloutAuthority;
      readonly evidenceHash: string;
    }
  | {
      readonly type: "rejected";
      readonly authority: RuntimeExtensionRolloutAuthority;
      readonly reason: string;
      readonly evidenceHash: string;
    }
  | {
      readonly type: "rollback-forward";
      readonly authority: RuntimeExtensionRolloutAuthority;
      readonly reason: string;
      readonly evidenceHash: string;
      readonly epoch: number;
      readonly artifactHash: string;
      readonly manifestHash: string;
    };

export type RuntimeExtensionRolloutRecord = {
  readonly schemaVersion: typeof RUNTIME_EXTENSION_ROLLOUT_RECORD_VERSION;
  readonly recordId: string;
  readonly rolloutId: string;
  readonly sequence: number;
  readonly previousRecordId?: string;
  readonly body: RuntimeExtensionRolloutBody;
};

export type RuntimeExtensionRolloutStatus = RuntimeExtensionRolloutBody["type"];

export type RuntimeExtensionRolloutProjection = {
  readonly rolloutId: string;
  readonly status: RuntimeExtensionRolloutStatus;
  readonly proposal: RuntimeExtensionRolloutProposal;
  readonly currentEpoch: number;
  readonly currentArtifactHash: string;
  readonly currentManifestHash: string;
  readonly verifier?: RuntimeExtensionRolloutAuthority;
  readonly warmingEvidenceHash?: string;
  readonly canaryAuthority?: RuntimeExtensionRolloutAuthority;
  readonly canaryEvidence: ReadonlyArray<RuntimeExtensionCanaryEvidence>;
  readonly promotionAuthority?: RuntimeExtensionRolloutAuthority;
  readonly rejection?: {
    readonly authority: RuntimeExtensionRolloutAuthority;
    readonly reason: string;
    readonly evidenceHash: string;
  };
  readonly rollback?: {
    readonly authority: RuntimeExtensionRolloutAuthority;
    readonly reason: string;
    readonly evidenceHash: string;
    readonly epoch: number;
  };
  /** Complete append-only transition history; projection never deletes records. */
  readonly recordIds: ReadonlyArray<string>;
};

const encodedBytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const boundedText = (
  value: string,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (
    !normalized
    || encodedBytes(normalized) > maximum
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

const nonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
};

const normalizeAuthority = (
  authority: RuntimeExtensionRolloutAuthority,
): RuntimeExtensionRolloutAuthority => {
  if (authority.kind !== "human" && authority.kind !== "deterministic-policy") {
    throw new Error("Runtime extension rollout authority kind is unsupported");
  }
  return Object.freeze({
    authorityId: boundedId(authority.authorityId, "Runtime extension rollout authorityId"),
    kind: authority.kind,
    authorizationHash: boundedHash(
      authority.authorizationHash,
      "Runtime extension rollout authorizationHash",
    ),
  });
};

const normalizedIds = (
  values: ReadonlyArray<string>,
  label: string,
): ReadonlyArray<string> => {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const normalized = values.map((value) => boundedId(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate entries`);
  }
  if (normalized.length > 256) throw new Error(`${label} exceeds 256 entries`);
  return Object.freeze(normalized.sort());
};

const normalizeEffects = (
  values: ReadonlyArray<RosterFunctionEffect>,
): ReadonlyArray<RosterFunctionEffect> => {
  if (!Array.isArray(values)) throw new Error("Runtime extension allowedEffects must be an array");
  const normalized = [...new Set(values)].sort();
  if (
    normalized.length !== values.length
    || normalized.some((value) =>
      value !== "read" && value !== "write" && value !== "external")
  ) {
    throw new Error("Runtime extension allowedEffects must be unique supported effects");
  }
  return Object.freeze(normalized);
};

const normalizeWorkspaceOperations = (
  values: ReadonlyArray<"read" | "publish">,
): ReadonlyArray<"read" | "publish"> => {
  if (!Array.isArray(values)) {
    throw new Error("Runtime extension workspaceOperations must be an array");
  }
  const normalized = [...new Set(values)].sort();
  if (
    normalized.length !== values.length
    || normalized.some((value) => value !== "read" && value !== "publish")
  ) {
    throw new Error("Runtime extension workspaceOperations must be unique supported operations");
  }
  return Object.freeze(normalized);
};

const normalizeAuthorityEnvelope = (
  authority: RuntimeExtensionAuthorityEnvelope,
): RuntimeExtensionAuthorityEnvelope => {
  if (typeof authority.allowGraphExpansion !== "boolean") {
    throw new Error("Runtime extension allowGraphExpansion must be a boolean");
  }
  return Object.freeze({
    functionGrants: normalizedIds(
      authority.functionGrants,
      "Runtime extension function grant",
    ),
    scopes: normalizedIds(authority.scopes, "Runtime extension scope"),
    allowedEffects: normalizeEffects(authority.allowedEffects),
    workspaceOperations: normalizeWorkspaceOperations(authority.workspaceOperations),
    allowGraphExpansion: authority.allowGraphExpansion,
  });
};

const normalizeBudget = (
  budget: RuntimeExtensionRolloutBudget,
): RuntimeExtensionRolloutBudget => Object.freeze({
  maxCanaryRuns: positiveInteger(budget.maxCanaryRuns, "Runtime extension maxCanaryRuns"),
  maxTasks: positiveInteger(budget.maxTasks, "Runtime extension maxTasks"),
  maxTokens: nonNegativeInteger(budget.maxTokens, "Runtime extension maxTokens"),
  maxCostMicros: nonNegativeInteger(
    budget.maxCostMicros,
    "Runtime extension maxCostMicros",
  ),
  maxWallTimeMs: positiveInteger(
    budget.maxWallTimeMs,
    "Runtime extension maxWallTimeMs",
  ),
});

const assertSubset = (
  candidate: ReadonlyArray<string>,
  baseline: ReadonlyArray<string>,
  label: string,
): void => {
  const allowed = new Set(baseline);
  const widened = candidate.filter((value) => !allowed.has(value));
  if (widened.length > 0) {
    throw new Error(`Runtime extension candidate widens ${label}: ${widened.join(", ")}`);
  }
};

const assertNoAuthorityWidening = (
  baseline: RuntimeExtensionAuthorityEnvelope,
  candidate: RuntimeExtensionAuthorityEnvelope,
): void => {
  assertSubset(candidate.functionGrants, baseline.functionGrants, "function grants");
  assertSubset(candidate.scopes, baseline.scopes, "scopes");
  assertSubset(candidate.allowedEffects, baseline.allowedEffects, "allowed effects");
  assertSubset(candidate.workspaceOperations, baseline.workspaceOperations, "workspace operations");
  if (candidate.allowGraphExpansion && !baseline.allowGraphExpansion) {
    throw new Error("Runtime extension candidate widens graph-expansion authority");
  }
};

const assertNoBudgetWidening = (
  baseline: RuntimeExtensionRolloutBudget,
  candidate: RuntimeExtensionRolloutBudget,
): void => {
  for (const key of [
    "maxCanaryRuns",
    "maxTasks",
    "maxTokens",
    "maxCostMicros",
    "maxWallTimeMs",
  ] as const) {
    if (candidate[key] > baseline[key]) {
      throw new Error(`Runtime extension candidate widens budget ${key}`);
    }
  }
};

const normalizeProposal = (
  input: RuntimeExtensionRolloutProposal,
): RuntimeExtensionRolloutProposal => {
  const baselineAuthority = normalizeAuthorityEnvelope(input.baselineAuthority);
  const candidateAuthority = normalizeAuthorityEnvelope(input.candidateAuthority);
  const baselineBudget = normalizeBudget(input.baselineBudget);
  const candidateBudget = normalizeBudget(input.candidateBudget);
  const emission = validateRuntimeEmissionClassification(input.emission);
  if (emission.kind === "immediate-nonrepeatable") {
    throw new Error("Runtime extension canaries prohibit immediate-nonrepeatable emissions");
  }
  assertNoAuthorityWidening(baselineAuthority, candidateAuthority);
  assertNoBudgetWidening(baselineBudget, candidateBudget);
  const baselineEpoch = positiveInteger(input.baselineEpoch, "Runtime extension baselineEpoch");
  const targetEpoch = positiveInteger(input.targetEpoch, "Runtime extension targetEpoch");
  if (targetEpoch <= baselineEpoch) {
    throw new Error("Runtime extension targetEpoch must advance beyond baselineEpoch");
  }
  return Object.freeze({
    extensionId: boundedId(input.extensionId, "Runtime extension rollout extensionId"),
    artifactHash: boundedHash(input.artifactHash, "Runtime extension artifactHash"),
    manifestHash: boundedHash(input.manifestHash, "Runtime extension manifestHash"),
    proposerId: boundedId(input.proposerId, "Runtime extension proposerId"),
    baselineEpoch,
    targetEpoch,
    lastKnownGoodArtifactHash: boundedHash(
      input.lastKnownGoodArtifactHash,
      "Runtime extension lastKnownGoodArtifactHash",
    ),
    lastKnownGoodManifestHash: boundedHash(
      input.lastKnownGoodManifestHash,
      "Runtime extension lastKnownGoodManifestHash",
    ),
    baselineAuthority,
    candidateAuthority,
    baselineBudget,
    candidateBudget,
    emission,
  });
};

const normalizeCanaryEvidence = (
  input: ReadonlyArray<RuntimeExtensionCanaryEvidence>,
  budget: RuntimeExtensionRolloutBudget,
): ReadonlyArray<RuntimeExtensionCanaryEvidence> => {
  if (!Array.isArray(input) || input.length < 1) {
    throw new Error("Runtime extension canary requires bounded evidence");
  }
  if (
    input.length > MAX_RUNTIME_EXTENSION_CANARY_EVIDENCE
    || input.length > budget.maxCanaryRuns
  ) {
    throw new Error("Runtime extension canary evidence exceeds its bounded run count");
  }
  const normalized = input.map((evidence) => {
    if (evidence.verdict !== "passed" && evidence.verdict !== "failed") {
      throw new Error("Runtime extension canary verdict must be passed or failed");
    }
    return Object.freeze({
      canaryId: boundedId(evidence.canaryId, "Runtime extension canaryId"),
      outcomeHash: boundedHash(evidence.outcomeHash, "Runtime extension canary outcomeHash"),
      verdict: evidence.verdict,
      tasks: positiveInteger(evidence.tasks, "Runtime extension canary tasks"),
      tokens: nonNegativeInteger(evidence.tokens, "Runtime extension canary tokens"),
      costMicros: nonNegativeInteger(
        evidence.costMicros,
        "Runtime extension canary costMicros",
      ),
      wallTimeMs: nonNegativeInteger(
        evidence.wallTimeMs,
        "Runtime extension canary wallTimeMs",
      ),
    });
  }).sort((left, right) => left.canaryId.localeCompare(right.canaryId));
  if (new Set(normalized.map(({ canaryId }) => canaryId)).size !== normalized.length) {
    throw new Error("Runtime extension canary evidence contains duplicate canaryId values");
  }
  const totals = normalized.reduce((sum, evidence) => ({
    tasks: sum.tasks + evidence.tasks,
    tokens: sum.tokens + evidence.tokens,
    costMicros: sum.costMicros + evidence.costMicros,
    wallTimeMs: sum.wallTimeMs + evidence.wallTimeMs,
  }), { tasks: 0, tokens: 0, costMicros: 0, wallTimeMs: 0 });
  if (
    totals.tasks > budget.maxTasks
    || totals.tokens > budget.maxTokens
    || totals.costMicros > budget.maxCostMicros
    || totals.wallTimeMs > budget.maxWallTimeMs
  ) {
    throw new Error("Runtime extension canary evidence exceeds its candidate budget");
  }
  return Object.freeze(normalized);
};

const normalizedBody = (
  body: RuntimeExtensionRolloutBody,
  proposal?: RuntimeExtensionRolloutProposal,
): RuntimeExtensionRolloutBody => {
  switch (body.type) {
    case "proposed":
      return Object.freeze({ type: body.type, proposal: normalizeProposal(body.proposal) });
    case "verified":
      return Object.freeze({
        type: body.type,
        authority: normalizeAuthority(body.authority),
        evidenceHash: boundedHash(body.evidenceHash, "Runtime extension verification evidenceHash"),
      });
    case "warming":
      return Object.freeze({
        type: body.type,
        evidenceHash: boundedHash(body.evidenceHash, "Runtime extension warming evidenceHash"),
      });
    case "canary":
      if (!proposal) throw new Error("Runtime extension canary normalization requires its proposal");
      return Object.freeze({
        type: body.type,
        authority: normalizeAuthority(body.authority),
        evidence: normalizeCanaryEvidence(body.evidence, proposal.candidateBudget),
      });
    case "promoted":
      return Object.freeze({
        type: body.type,
        authority: normalizeAuthority(body.authority),
        evidenceHash: boundedHash(body.evidenceHash, "Runtime extension promotion evidenceHash"),
      });
    case "rejected":
      return Object.freeze({
        type: body.type,
        authority: normalizeAuthority(body.authority),
        reason: boundedText(body.reason, "Runtime extension rejection reason", MAX_REASON_BYTES),
        evidenceHash: boundedHash(body.evidenceHash, "Runtime extension rejection evidenceHash"),
      });
    case "rollback-forward":
      return Object.freeze({
        type: body.type,
        authority: normalizeAuthority(body.authority),
        reason: boundedText(body.reason, "Runtime extension rollback reason", MAX_REASON_BYTES),
        evidenceHash: boundedHash(body.evidenceHash, "Runtime extension rollback evidenceHash"),
        epoch: positiveInteger(body.epoch, "Runtime extension rollback epoch"),
        artifactHash: boundedHash(body.artifactHash, "Runtime extension rollback artifactHash"),
        manifestHash: boundedHash(body.manifestHash, "Runtime extension rollback manifestHash"),
      });
    default: {
      const _exhaustive: never = body;
      return _exhaustive;
    }
  }
};

const recordContent = (input: {
  readonly rolloutId: string;
  readonly sequence: number;
  readonly previousRecordId?: string;
  readonly body: RuntimeExtensionRolloutBody;
}) => Object.freeze({
  schemaVersion: RUNTIME_EXTENSION_ROLLOUT_RECORD_VERSION,
  rolloutId: boundedId(input.rolloutId, "Runtime extension rolloutId"),
  sequence: positiveInteger(input.sequence, "Runtime extension rollout sequence"),
  ...(input.previousRecordId
    ? { previousRecordId: boundedId(input.previousRecordId, "Runtime extension previousRecordId") }
    : {}),
  body: input.body,
});

const createRecord = (input: {
  readonly rolloutId: string;
  readonly sequence: number;
  readonly previousRecordId?: string;
  readonly body: RuntimeExtensionRolloutBody;
}): RuntimeExtensionRolloutRecord => {
  const content = recordContent(input);
  return Object.freeze({
    ...content,
    recordId: `runtime_rollout_record_${hashCanonical(content).slice(0, 28)}`,
  });
};

export const createRuntimeExtensionRolloutProposal = (
  proposalInput: RuntimeExtensionRolloutProposal,
): RuntimeExtensionRolloutRecord => {
  const proposal = normalizeProposal(proposalInput);
  const rolloutId = `runtime_rollout_${hashCanonical(proposal).slice(0, 28)}`;
  return createRecord({
    rolloutId,
    sequence: 1,
    body: Object.freeze({ type: "proposed", proposal }),
  });
};

export const validateRuntimeExtensionRolloutRecord = (
  record: RuntimeExtensionRolloutRecord,
  proposal?: RuntimeExtensionRolloutProposal,
): RuntimeExtensionRolloutRecord => {
  if (!record || record.schemaVersion !== RUNTIME_EXTENSION_ROLLOUT_RECORD_VERSION) {
    throw new Error("Runtime extension rollout record has an unsupported schemaVersion");
  }
  const body = normalizedBody(record.body, proposal ?? (
    record.body.type === "proposed" ? record.body.proposal : undefined
  ));
  const expectedRolloutId = body.type === "proposed"
    ? `runtime_rollout_${hashCanonical(body.proposal).slice(0, 28)}`
    : boundedId(record.rolloutId, "Runtime extension rolloutId");
  if (expectedRolloutId !== record.rolloutId) {
    throw new Error("Runtime extension rollout identity does not match its proposal");
  }
  const expected = createRecord({
    rolloutId: record.rolloutId,
    sequence: record.sequence,
    ...(record.previousRecordId ? { previousRecordId: record.previousRecordId } : {}),
    body,
  });
  if (
    expected.recordId !== record.recordId
    || hashCanonical(expected) !== hashCanonical(record)
  ) {
    throw new Error("Runtime extension rollout record identity does not match its exact contents");
  }
  return expected;
};

const initialProjection = (
  proposalRecord: RuntimeExtensionRolloutRecord,
): RuntimeExtensionRolloutProjection => {
  if (proposalRecord.body.type !== "proposed") {
    throw new Error("Runtime extension rollout history must begin with proposed");
  }
  const proposal = proposalRecord.body.proposal;
  return Object.freeze({
    rolloutId: proposalRecord.rolloutId,
    status: "proposed",
    proposal,
    currentEpoch: proposal.baselineEpoch,
    currentArtifactHash: proposal.lastKnownGoodArtifactHash,
    currentManifestHash: proposal.lastKnownGoodManifestHash,
    canaryEvidence: Object.freeze([]),
    recordIds: Object.freeze([proposalRecord.recordId]),
  });
};

const assertIndependentAuthority = (
  projection: RuntimeExtensionRolloutProjection,
  authority: RuntimeExtensionRolloutAuthority,
  action: string,
): void => {
  if (
    authority.authorityId === projection.proposal.proposerId
    || authority.authorityId === projection.proposal.extensionId
  ) {
    throw new Error(`Runtime extension ${action} requires independent authority and forbids self-promotion`);
  }
};

const applyRecord = (
  projection: RuntimeExtensionRolloutProjection,
  record: RuntimeExtensionRolloutRecord,
): RuntimeExtensionRolloutProjection => {
  const nextRecordIds = Object.freeze([...projection.recordIds, record.recordId]);
  switch (record.body.type) {
    case "proposed":
      throw new Error("Runtime extension rollout contains more than one proposal");
    case "verified":
      if (projection.status !== "proposed") {
        throw new Error("Runtime extension rollout can verify only a proposed candidate");
      }
      assertIndependentAuthority(projection, record.body.authority, "verification");
      return Object.freeze({
        ...projection,
        status: "verified",
        verifier: record.body.authority,
        recordIds: nextRecordIds,
      });
    case "warming":
      if (projection.status !== "verified") {
        throw new Error("Runtime extension rollout can warm only a verified candidate");
      }
      return Object.freeze({
        ...projection,
        status: "warming",
        warmingEvidenceHash: record.body.evidenceHash,
        recordIds: nextRecordIds,
      });
    case "canary":
      if (projection.status !== "warming") {
        throw new Error("Runtime extension rollout can canary only a warming candidate");
      }
      assertIndependentAuthority(projection, record.body.authority, "canary");
      if (record.body.authority.authorityId === projection.verifier?.authorityId) {
        throw new Error("Runtime extension canary authority must be independent from verification authority");
      }
      return Object.freeze({
        ...projection,
        status: "canary",
        canaryAuthority: record.body.authority,
        canaryEvidence: record.body.evidence,
        recordIds: nextRecordIds,
      });
    case "promoted":
      if (projection.status !== "canary") {
        throw new Error("Runtime extension rollout can promote only a canary candidate");
      }
      if (projection.canaryEvidence.some(({ verdict }) => verdict !== "passed")) {
        throw new Error("Runtime extension rollout cannot promote failed canary evidence");
      }
      assertIndependentAuthority(projection, record.body.authority, "promotion");
      if (record.body.authority.authorityId === projection.verifier?.authorityId) {
        throw new Error("Runtime extension promotion authority must be independent from verification authority");
      }
      if (record.body.authority.authorityId === projection.canaryAuthority?.authorityId) {
        throw new Error("Runtime extension promotion authority must be independent from canary authority");
      }
      return Object.freeze({
        ...projection,
        status: "promoted",
        currentEpoch: projection.proposal.targetEpoch,
        currentArtifactHash: projection.proposal.artifactHash,
        currentManifestHash: projection.proposal.manifestHash,
        promotionAuthority: record.body.authority,
        recordIds: nextRecordIds,
      });
    case "rejected":
      if (
        projection.status === "promoted"
        || projection.status === "rejected"
        || projection.status === "rollback-forward"
      ) {
        throw new Error(`Runtime extension rollout cannot reject from ${projection.status}`);
      }
      assertIndependentAuthority(projection, record.body.authority, "rejection");
      return Object.freeze({
        ...projection,
        status: "rejected",
        rejection: Object.freeze({
          authority: record.body.authority,
          reason: record.body.reason,
          evidenceHash: record.body.evidenceHash,
        }),
        recordIds: nextRecordIds,
      });
    case "rollback-forward":
      if (projection.status !== "promoted") {
        throw new Error("Runtime extension rollback-forward requires a promoted candidate");
      }
      assertIndependentAuthority(projection, record.body.authority, "rollback-forward");
      if (
        record.body.authority.authorityId === projection.verifier?.authorityId
        || record.body.authority.authorityId === projection.canaryAuthority?.authorityId
        || record.body.authority.authorityId === projection.promotionAuthority?.authorityId
      ) {
        throw new Error("Runtime extension rollback-forward authority must be independent from prior rollout authorities");
      }
      if (record.body.epoch <= projection.currentEpoch) {
        throw new Error("Runtime extension rollback-forward must use a higher epoch");
      }
      if (
        record.body.artifactHash !== projection.proposal.lastKnownGoodArtifactHash
        || record.body.manifestHash !== projection.proposal.lastKnownGoodManifestHash
      ) {
        throw new Error("Runtime extension rollback-forward must restore the exact last-known-good artifact");
      }
      return Object.freeze({
        ...projection,
        status: "rollback-forward",
        currentEpoch: record.body.epoch,
        currentArtifactHash: record.body.artifactHash,
        currentManifestHash: record.body.manifestHash,
        rollback: Object.freeze({
          authority: record.body.authority,
          reason: record.body.reason,
          evidenceHash: record.body.evidenceHash,
          epoch: record.body.epoch,
        }),
        recordIds: nextRecordIds,
      });
    default: {
      const _exhaustive: never = record.body;
      return _exhaustive;
    }
  }
};

export const projectRuntimeExtensionRollout = (
  records: ReadonlyArray<RuntimeExtensionRolloutRecord>,
): RuntimeExtensionRolloutProjection => {
  if (!Array.isArray(records) || records.length < 1) {
    throw new Error("Runtime extension rollout projection requires history");
  }
  const proposalInputs = records.filter(({ body }) => body.type === "proposed");
  const proposalCandidates = new Map(proposalInputs.map((record) => [record.recordId, record]));
  if (proposalCandidates.size !== 1) {
    throw new Error("Runtime extension rollout history requires one exact proposal");
  }
  const proposalRecord = validateRuntimeExtensionRolloutRecord(
    [...proposalCandidates.values()][0]!,
  );
  if (proposalRecord.body.type !== "proposed") {
    throw new Error("Runtime extension rollout history requires a proposed root");
  }
  const proposal = proposalRecord.body.proposal;
  const unique = new Map<string, RuntimeExtensionRolloutRecord>();
  for (const input of records) {
    const record = validateRuntimeExtensionRolloutRecord(input, proposal);
    if (record.rolloutId !== proposalRecord.rolloutId) {
      throw new Error("Runtime extension rollout history mixes rollout identities");
    }
    const prior = unique.get(record.recordId);
    if (prior && hashCanonical(prior) !== hashCanonical(record)) {
      throw new Error("Runtime extension rollout recordId has conflicting contents");
    }
    unique.set(record.recordId, record);
  }
  const ordered = [...unique.values()].sort((left, right) =>
    left.sequence - right.sequence || left.recordId.localeCompare(right.recordId));
  if (ordered[0]?.recordId !== proposalRecord.recordId) {
    throw new Error("Runtime extension rollout proposal must be sequence one");
  }
  let projection = initialProjection(proposalRecord);
  for (let index = 1; index < ordered.length; index += 1) {
    const record = ordered[index]!;
    const previous = ordered[index - 1]!;
    if (
      record.sequence !== index + 1
      || record.previousRecordId !== previous.recordId
    ) {
      throw new Error("Runtime extension rollout history is not one exact hash-linked sequence");
    }
    projection = applyRecord(projection, record);
  }
  return projection;
};

const appendRecord = (
  history: ReadonlyArray<RuntimeExtensionRolloutRecord>,
  body: RuntimeExtensionRolloutBody,
): RuntimeExtensionRolloutRecord => {
  const projection = projectRuntimeExtensionRollout(history);
  const previousRecordId = projection.recordIds.at(-1)!;
  return createRecord({
    rolloutId: projection.rolloutId,
    sequence: projection.recordIds.length + 1,
    previousRecordId,
    body: normalizedBody(body, projection.proposal),
  });
};

export const verifyRuntimeExtensionRollout = (
  history: ReadonlyArray<RuntimeExtensionRolloutRecord>,
  input: {
    readonly authority: RuntimeExtensionRolloutAuthority;
    readonly evidenceHash: string;
  },
): RuntimeExtensionRolloutRecord => {
  const record = appendRecord(history, {
    type: "verified",
    authority: input.authority,
    evidenceHash: input.evidenceHash,
  });
  projectRuntimeExtensionRollout([...history, record]);
  return record;
};

export const warmRuntimeExtensionRollout = (
  history: ReadonlyArray<RuntimeExtensionRolloutRecord>,
  input: { readonly evidenceHash: string },
): RuntimeExtensionRolloutRecord => {
  const record = appendRecord(history, { type: "warming", evidenceHash: input.evidenceHash });
  projectRuntimeExtensionRollout([...history, record]);
  return record;
};

export const recordRuntimeExtensionCanary = (
  history: ReadonlyArray<RuntimeExtensionRolloutRecord>,
  input: {
    readonly authority: RuntimeExtensionRolloutAuthority;
    readonly evidence: ReadonlyArray<RuntimeExtensionCanaryEvidence>;
  },
): RuntimeExtensionRolloutRecord => {
  const record = appendRecord(history, {
    type: "canary",
    authority: input.authority,
    evidence: input.evidence,
  });
  projectRuntimeExtensionRollout([...history, record]);
  return record;
};

export const promoteRuntimeExtensionRollout = (
  history: ReadonlyArray<RuntimeExtensionRolloutRecord>,
  input: {
    readonly authority: RuntimeExtensionRolloutAuthority;
    readonly evidenceHash: string;
  },
): RuntimeExtensionRolloutRecord => {
  const record = appendRecord(history, {
    type: "promoted",
    authority: input.authority,
    evidenceHash: input.evidenceHash,
  });
  projectRuntimeExtensionRollout([...history, record]);
  return record;
};

export const rejectRuntimeExtensionRollout = (
  history: ReadonlyArray<RuntimeExtensionRolloutRecord>,
  input: {
    readonly authority: RuntimeExtensionRolloutAuthority;
    readonly reason: string;
    readonly evidenceHash: string;
  },
): RuntimeExtensionRolloutRecord => {
  const record = appendRecord(history, {
    type: "rejected",
    authority: input.authority,
    reason: input.reason,
    evidenceHash: input.evidenceHash,
  });
  projectRuntimeExtensionRollout([...history, record]);
  return record;
};

/**
 * Rollback is a forward deployment of the exact last-known-good artifact at a
 * new epoch. The promoted candidate and every transition remain in history.
 */
export const rollbackRuntimeExtensionRolloutForward = (
  history: ReadonlyArray<RuntimeExtensionRolloutRecord>,
  input: {
    readonly authority: RuntimeExtensionRolloutAuthority;
    readonly epoch: number;
    readonly reason: string;
    readonly evidenceHash: string;
  },
): RuntimeExtensionRolloutRecord => {
  const projection = projectRuntimeExtensionRollout(history);
  const record = appendRecord(history, {
    type: "rollback-forward",
    authority: input.authority,
    epoch: input.epoch,
    reason: input.reason,
    evidenceHash: input.evidenceHash,
    artifactHash: projection.proposal.lastKnownGoodArtifactHash,
    manifestHash: projection.proposal.lastKnownGoodManifestHash,
  });
  projectRuntimeExtensionRollout([...history, record]);
  return record;
};
