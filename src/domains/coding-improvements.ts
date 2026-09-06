import { canonicalize, hashCanonical } from "../core/canonical.js";
import type {
  CodingAcceptedOutput,
  CodingAcceptedOutputProjection,
} from "./coding-accepted-outputs.js";
import type { JsonValue } from "../engine/orchestration/types.js";
import type { HarnessResult } from "../engine/runtime/improvement-harness.js";
import {
  ACTIVE_IMPROVEMENT_SERVICE,
  ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION,
  normalizeImprovementTarget,
  type ImprovementArtifactDocument,
  type ActiveImprovementSnapshot,
} from "../engine/runtime/self-improvement-framework.js";
import { compileRuntimeExtensionPlan } from "../engine/runtime/runtime-extension.js";
import type {
  ImprovementArtifactType,
  ImprovementProposalSource,
} from "../modules/self-improvement.js";

export const CODING_IMPROVEMENT_RUNTIME_PIN_VERSION =
  "roster.coding-improvement-runtime-pin.v1" as const;

/** Keeps the complete immutable policy body and its process-runtime generation correlated. */
export type CodingImprovementRuntimePin = {
  readonly schemaVersion: typeof CODING_IMPROVEMENT_RUNTIME_PIN_VERSION;
  readonly generationId: string;
  readonly snapshot: ActiveImprovementSnapshot;
};

export type CodingImprovementRuntimeIdentity = {
  readonly snapshotHash: string;
  readonly generationId: string;
};

const MAX_PINNED_IMPROVEMENTS = 128;
const MAX_PINNED_SNAPSHOT_CHARS = 128_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const GENERATION_PATTERN = /^runtime_generation_[a-f0-9]{28}$/u;
const MAX_CANDIDATE_PATCH_BYTES = 512 * 1024;

export type CodingAutonomousImprovementCandidate = {
  readonly artifactType: ImprovementArtifactType;
  readonly target: "coding.prompt" | "coding.policy" | "coding.harness";
  readonly patch: JsonValue;
  readonly patchJson: string;
  readonly rationale: string;
  readonly evidence: ReadonlyArray<string>;
};

const CANDIDATE_TARGETS: Readonly<Record<ImprovementArtifactType, CodingAutonomousImprovementCandidate["target"]>> = {
  prompt_patch: "coding.prompt",
  policy_patch: "coding.policy",
  harness_patch: "coding.harness",
};

const assertCodingImprovementPatchShape = (
  artifactType: ImprovementArtifactType,
  patch: unknown,
): void => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(`Coding ${artifactType} candidate patch must be an object`);
  }
  const record = patch as Readonly<Record<string, unknown>>;
  const allowed = artifactType === "prompt_patch"
    ? new Set(["instructions"])
    : artifactType === "harness_patch"
      ? new Set(["requiredChecks"])
      : new Set(["maxNodes", "maxParallel", "maxSupervisors", "reviewPolicy"]);
  const keys = Object.keys(record);
  if (keys.length < 1 || keys.some((key) => !allowed.has(key))) {
    throw new Error(`Coding ${artifactType} candidate contains unsupported fields`);
  }
  if (artifactType === "policy_patch") return;
  const field = artifactType === "prompt_patch" ? "instructions" : "requiredChecks";
  const values = record[field];
  if (!Array.isArray(values) || values.length < 1 || values.length > 32) {
    throw new Error(`Coding ${artifactType} candidate requires 1-32 ${field}`);
  }
  for (const value of values) boundedCandidateText(value, `Coding ${field} entry`, 2_000);
};

const boundedCandidateText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(`${label} must be non-empty, bounded text`);
  }
  return value.trim();
};

/** Reads one canonical, optional framework candidate from the accepted final report. */
export const codingAutonomousImprovementCandidate = (
  output: CodingAcceptedOutput,
): CodingAutonomousImprovementCandidate | undefined => {
  if (output.outputKey !== "final_report") return undefined;
  if (new TextEncoder().encode(output.value).byteLength > MAX_CANDIDATE_PATCH_BYTES) {
    throw new Error("Accepted Coding improvement candidate exceeds 524288 bytes");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const report = parsed as Readonly<Record<string, unknown>>;
  if (report.status !== "verified" || report.improvementCandidate === undefined) return undefined;
  const raw = report.improvementCandidate;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Accepted Coding improvementCandidate must be an object");
  }
  const candidate = raw as Readonly<Record<string, unknown>>;
  const artifactType = candidate.artifactType;
  if (artifactType !== "prompt_patch" && artifactType !== "policy_patch" && artifactType !== "harness_patch") {
    throw new Error("Accepted Coding improvementCandidate has an invalid artifactType");
  }
  const target = normalizeImprovementTarget(String(candidate.target ?? ""));
  if (target !== CANDIDATE_TARGETS[artifactType]) {
    throw new Error(`Accepted ${artifactType} candidate must target ${CANDIDATE_TARGETS[artifactType]}`);
  }
  if (candidate.patch === undefined) throw new Error("Accepted Coding improvementCandidate requires patch");
  assertCodingImprovementPatchShape(artifactType, candidate.patch);
  const patchJson = canonicalize(candidate.patch);
  if (new TextEncoder().encode(patchJson).byteLength > MAX_CANDIDATE_PATCH_BYTES) {
    throw new Error("Accepted Coding improvement patch exceeds 524288 bytes");
  }
  const evidence = candidate.evidence;
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 16) {
    throw new Error("Accepted Coding improvementCandidate requires 1-16 evidence entries");
  }
  return Object.freeze({
    artifactType,
    target: target as CodingAutonomousImprovementCandidate["target"],
    patch: candidate.patch as JsonValue,
    patchJson,
    rationale: boundedCandidateText(candidate.rationale, "Improvement rationale", 2_000),
    evidence: Object.freeze(evidence.map((entry) => boundedCandidateText(entry, "Improvement evidence", 500))),
  });
};

export type CodingAutonomousImprovementAdmission = {
  readonly proposalId: string;
  readonly artifactType: ImprovementArtifactType;
  readonly target: string;
  readonly patch: string;
  readonly source: ImprovementProposalSource;
};

/** Production admission seam from the exact accepted-output read model. */
export const admitCodingAutonomousImprovement = async (
  projection: Pick<CodingAcceptedOutputProjection, "outputs">,
  admit: (input: CodingAutonomousImprovementAdmission) => Promise<unknown>,
): Promise<boolean> => {
  const finalReports = projection.outputs.filter((output) => output.outputKey === "final_report");
  if (finalReports.length > 1) {
    throw new Error("Accepted Coding output projection has ambiguous final reports");
  }
  const finalReport = finalReports[0];
  if (!finalReport) return false;
  const candidate = codingAutonomousImprovementCandidate(finalReport);
  if (!candidate) return false;
  const proposalId = `proposal_auto_${hashCanonical({
    schemaVersion: "roster.autonomous-coding-improvement.v1",
    runId: finalReport.runId,
    artifactId: finalReport.artifactId,
    contentHash: finalReport.contentHash,
    candidate,
  }).slice(0, 28)}`;
  await admit({
    proposalId,
    artifactType: candidate.artifactType,
    target: candidate.target,
    patch: candidate.patchJson,
    source: {
      kind: "coding-certified-output",
      actorId: `coding:${finalReport.nodeId}`,
      runId: finalReport.runId,
      taskId: finalReport.taskId,
      nodeId: finalReport.nodeId,
      outcomeId: finalReport.outcomeId,
      artifactId: finalReport.artifactId,
      contentHash: finalReport.contentHash,
    },
  });
  return true;
};

const activeGenerationId = (snapshot: ActiveImprovementSnapshot): string =>
  compileRuntimeExtensionPlan(snapshot.improvements.length === 0 ? [] : [{
    id: "self-improvement-runtime",
    version: "1",
    artifactHash: snapshot.snapshotHash,
    configurationHash: snapshot.snapshotHash,
    provides: [ACTIVE_IMPROVEMENT_SERVICE],
    activate: () => undefined,
  }]).manifest.generationId;

const parseSnapshot = (value: unknown): ActiveImprovementSnapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Coding improvement runtime pin requires an object snapshot");
  }
  const candidate = value as Partial<ActiveImprovementSnapshot>;
  if (
    candidate.schemaVersion !== ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION
    || typeof candidate.snapshotHash !== "string"
    || !SHA256_PATTERN.test(candidate.snapshotHash)
    || !Array.isArray(candidate.improvements)
  ) throw new Error("Coding improvement runtime pin contains an invalid snapshot identity");
  if (candidate.improvements.length > MAX_PINNED_IMPROVEMENTS) {
    throw new Error(`Coding improvement runtime pin exceeds ${MAX_PINNED_IMPROVEMENTS} improvements`);
  }
  let priorTarget = "";
  for (const improvement of candidate.improvements) {
    if (!improvement || typeof improvement !== "object" || Array.isArray(improvement)) {
      throw new Error("Coding improvement runtime pin contains a malformed improvement");
    }
    if (
      !ID_PATTERN.test(improvement.proposalId)
      || !["prompt_patch", "policy_patch", "harness_patch"].includes(improvement.artifactType)
      || normalizeImprovementTarget(improvement.target) !== improvement.target
      || !SHA256_PATTERN.test(improvement.artifactHash)
      || !SHA256_PATTERN.test(improvement.manifestHash)
      || !Number.isSafeInteger(improvement.epoch)
      || improvement.epoch < 0
      || improvement.patch === undefined
    ) throw new Error("Coding improvement runtime pin contains an invalid improvement identity");
    if (improvement.target <= priorTarget) {
      throw new Error("Coding improvement runtime pin targets must be unique and sorted");
    }
    priorTarget = improvement.target;
  }
  const content = {
    schemaVersion: candidate.schemaVersion,
    improvements: candidate.improvements,
  };
  if (candidate.snapshotHash !== hashCanonical(content)) {
    throw new Error("Coding improvement snapshot identity does not match its exact contents");
  }
  if (canonicalize(candidate).length > MAX_PINNED_SNAPSHOT_CHARS) {
    throw new Error(`Coding improvement runtime pin exceeds ${MAX_PINNED_SNAPSHOT_CHARS} characters`);
  }
  return candidate as ActiveImprovementSnapshot;
};

export const createCodingImprovementRuntimePin = (
  snapshotValue: ActiveImprovementSnapshot,
  committedGenerationId?: string,
): CodingImprovementRuntimePin => {
  const snapshot = parseSnapshot(snapshotValue);
  const generationId = activeGenerationId(snapshot);
  if (committedGenerationId !== undefined && committedGenerationId !== generationId) {
    throw new Error("Committed improvement runtime generation does not match its exact snapshot");
  }
  return Object.freeze({
    schemaVersion: CODING_IMPROVEMENT_RUNTIME_PIN_VERSION,
    generationId,
    snapshot,
  });
};

export const emptyCodingImprovementRuntimePin = (): CodingImprovementRuntimePin => {
  const content = {
    schemaVersion: ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION,
    improvements: Object.freeze([]),
  };
  return createCodingImprovementRuntimePin(Object.freeze({
    ...content,
    snapshotHash: hashCanonical(content),
  }));
};

export const parseCodingImprovementRuntimePin = (
  value: unknown,
): CodingImprovementRuntimePin => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Coding job is missing its improvement runtime pin object");
  }
  const candidate = value as Partial<CodingImprovementRuntimePin>;
  if (
    candidate.schemaVersion !== CODING_IMPROVEMENT_RUNTIME_PIN_VERSION
    || typeof candidate.generationId !== "string"
    || !GENERATION_PATTERN.test(candidate.generationId)
    || candidate.snapshot === undefined
  ) throw new Error("Coding job contains an invalid improvement runtime pin");
  const expected = createCodingImprovementRuntimePin(candidate.snapshot);
  if (candidate.generationId !== expected.generationId) {
    throw new Error("Coding improvement runtime generation does not match its exact snapshot");
  }
  return candidate as CodingImprovementRuntimePin;
};

export const codingImprovementRuntimeIdentity = (
  pin: CodingImprovementRuntimePin,
): CodingImprovementRuntimeIdentity => Object.freeze({
  snapshotHash: pin.snapshot.snapshotHash,
  generationId: pin.generationId,
});

export type CodingImprovementProjection = {
  readonly objective: string;
  readonly maxNodes?: number;
  readonly maxParallel?: number;
  readonly maxSupervisors?: number;
  readonly reviewPolicy?: "auto" | "fast" | "reviewed";
  readonly snapshotHash?: string;
};

const asRecord = (value: JsonValue): Readonly<Record<string, JsonValue>> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;

const instructions = (value: JsonValue, label: string): ReadonlyArray<string> => {
  const record = asRecord(value);
  const candidate = record?.instructions ?? record?.requiredChecks;
  if (!Array.isArray(candidate)) return [];
  if (candidate.length > 32) throw new Error(`${label} exceeds 32 instructions`);
  return candidate.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 2_000) {
      throw new Error(`${label} contains an invalid instruction`);
    }
    return entry.trim();
  });
};

const tightenedBound = (
  patch: JsonValue | undefined,
  baseline: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number | undefined => {
  if (patch === undefined) return baseline;
  if (!Number.isSafeInteger(patch) || (patch as number) < 1 || (patch as number) > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return Math.min(baseline ?? fallback, patch as number);
};

/**
 * Projects promoted framework improvements into one immutable Coding run
 * snapshot. Generated policy can only tighten concurrency/population and can
 * only raise review rigor; it cannot expand grants, skip certification, or
 * mutate the already-admitted run after this function returns.
 */
export const applyCodingImprovements = (input: {
  readonly objective: string;
  readonly snapshot?: ActiveImprovementSnapshot;
  readonly maxNodes?: number;
  readonly maxParallel?: number;
  readonly maxSupervisors?: number;
  readonly reviewPolicy?: "auto" | "fast" | "reviewed";
}): CodingImprovementProjection => {
  const snapshot = input.snapshot;
  if (!snapshot) return { ...input };
  if (snapshot.schemaVersion !== ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION) {
    throw new Error("Coding improvement snapshot has an unsupported schemaVersion");
  }
  const expectedHash = hashCanonical({
    schemaVersion: snapshot.schemaVersion,
    improvements: snapshot.improvements,
  });
  if (snapshot.snapshotHash !== expectedHash) {
    throw new Error("Coding improvement snapshot identity does not match its exact contents");
  }
  if (snapshot.improvements.length === 0) return { ...input, snapshotHash: snapshot.snapshotHash };

  let maxNodes = input.maxNodes;
  let maxParallel = input.maxParallel;
  let maxSupervisors = input.maxSupervisors;
  let reviewPolicy = input.reviewPolicy;
  const directives: string[] = [];
  for (const improvement of snapshot.improvements) {
    if (!(improvement.target === "coding" || improvement.target.startsWith("coding."))) continue;
    if (improvement.artifactType === "prompt_patch") {
      directives.push(...instructions(improvement.patch, "Coding prompt improvement"));
      continue;
    }
    if (improvement.artifactType === "harness_patch") {
      directives.push(...instructions(improvement.patch, "Coding harness improvement")
        .map((instruction) => `Required validation evidence: ${instruction}`));
      continue;
    }
    const policy = asRecord(improvement.patch);
    if (!policy) throw new Error("Coding policy improvement must be an object");
    maxNodes = tightenedBound(policy.maxNodes, maxNodes, 6, 12, "Coding improved maxNodes");
    maxParallel = tightenedBound(policy.maxParallel, maxParallel, 4, 6, "Coding improved maxParallel");
    maxSupervisors = tightenedBound(
      policy.maxSupervisors,
      maxSupervisors,
      2,
      6,
      "Coding improved maxSupervisors",
    );
    if (policy.reviewPolicy !== undefined) {
      if (policy.reviewPolicy !== "reviewed") {
        throw new Error("Coding improvement policy may only raise reviewPolicy to reviewed");
      }
      reviewPolicy = "reviewed";
    }
  }
  const objective = directives.length === 0
    ? input.objective
    : `${input.objective}\n\nPromoted Roster improvement snapshot ${snapshot.snapshotHash}:\n${directives
      .map((directive, index) => `${index + 1}. ${directive}`)
      .join("\n")}`;
  return {
    objective,
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    ...(maxParallel !== undefined ? { maxParallel } : {}),
    ...(maxSupervisors !== undefined ? { maxSupervisors } : {}),
    ...(reviewPolicy !== undefined ? { reviewPolicy } : {}),
    snapshotHash: snapshot.snapshotHash,
  };
};

/**
 * Deterministic verifier/canary for Coding framework patches. It exercises the
 * exact projection boundary that future Coding admissions use; generated
 * candidates cannot introduce arbitrary target shapes or widen policy bounds.
 */
export const evaluateCodingImprovementArtifact = (
  artifact: ImprovementArtifactDocument,
  phase: "verification" | "canary",
): HarnessResult => {
  const started = Date.now();
  const checks: Array<{ readonly name: string; readonly ok: boolean; readonly detail: string }> = [];
  const expectedTarget = CANDIDATE_TARGETS[artifact.artifactType];
  checks.push({
    name: "candidate.target",
    ok: artifact.target === expectedTarget,
    detail: artifact.target === expectedTarget
      ? `${artifact.artifactType} targets ${expectedTarget}.`
      : `${artifact.artifactType} must target ${expectedTarget}.`,
  });
  try {
    assertCodingImprovementPatchShape(artifact.artifactType, artifact.patch);
    const improvement = {
      proposalId: "autonomous-candidate",
      artifactType: artifact.artifactType,
      target: artifact.target,
      artifactHash: hashCanonical(artifact),
      manifestHash: hashCanonical({ artifact, phase }),
      epoch: 2,
      patch: artifact.patch,
    } as const;
    const content = {
      schemaVersion: ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION,
      improvements: [improvement],
    } as const;
    const snapshot = { ...content, snapshotHash: hashCanonical(content) };
    const projected = applyCodingImprovements({
      objective: "Exercise the autonomous Coding improvement projection.",
      snapshot,
      maxNodes: 6,
      maxParallel: 4,
      maxSupervisors: 2,
      reviewPolicy: "auto",
    });
    checks.push({
      name: "candidate.projection",
      ok: true,
      detail: `Candidate projects through the admission boundary without widening authority (${projected.snapshotHash}).`,
    });
  } catch (error) {
    checks.push({
      name: "candidate.projection",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const status = checks.every((check) => check.ok) ? "passed" as const : "failed" as const;
  const report = checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`).join("\n");
  return Object.freeze({
    status,
    checks: Object.freeze(checks),
    report,
    evidenceHash: hashCanonical({ phase, artifact, status, checks, report }),
    wallTimeMs: Date.now() - started,
  });
};
