import { hashCanonical } from "../../core/canonical.js";

export const COMPOSITION_POLICY_VERSION = "roster.composition-policy.v1" as const;

export type CompositionTaskIntent = "ideation" | "convergent" | "synthesis";
export type CompositionMode = "portfolio" | "validated-selection" | "coverage-synthesis";
export type CompositionCandidateRole = "baseline" | "node" | "challenger" | "synthesis";
export type CompositionConstraintStatus = "pass" | "fail" | "inconclusive";
export type CompositionPolicyEvidence = {
  readonly id: string;
  readonly kind: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly artifactHash?: string;
};

/**
 * Candidate content stays outside the policy boundary. Roster compares bounded
 * metadata and immutable artifact references instead of copying artifacts into
 * another model context.
 */
export type CompositionPolicyCandidate = {
  readonly candidateId: string;
  readonly nodeId: string;
  readonly role: CompositionCandidateRole;
  readonly artifactRef: string;
  readonly artifactHash: string;
  readonly qualityScore: number;
  readonly originalityScore?: number;
  readonly constraintStatus: CompositionConstraintStatus;
  readonly evidence: ReadonlyArray<CompositionPolicyEvidence>;
  readonly sourceCandidateIds?: ReadonlyArray<string>;
  readonly mechanismIds?: ReadonlyArray<string>;
};

export type ValidatedCompositionPolicy = {
  readonly version: string;
  readonly maxCandidates: number;
  readonly maxPortfolioSize: number;
  readonly qualityNonInferiorityTolerance: number;
  readonly minimumSynthesisSourceCoverage: number;
  readonly minimumMechanismRetention: number;
};

export type CompositionPolicyInput = {
  readonly intent: CompositionTaskIntent;
  readonly baselineCandidateId: string;
  readonly candidates: ReadonlyArray<CompositionPolicyCandidate>;
  readonly requiredEvidenceKinds?: ReadonlyArray<string>;
  /**
   * Declared synthesis targets. They are part of the task contract; the policy
   * never lets a composer choose its own denominator after seeing proposals.
   */
  readonly requiredSourceNodeIds?: ReadonlyArray<string>;
  readonly requiredMechanismIds?: ReadonlyArray<string>;
  readonly policy?: Partial<ValidatedCompositionPolicy>;
};

export type CompositionCandidateReasonCode =
  | "invalid-score"
  | "constraint-failed"
  | "constraint-inconclusive"
  | "missing-evidence"
  | "failed-evidence"
  | "quality-regression"
  | "source-only"
  | "unknown-source-candidate"
  | "unproven-mechanism"
  | "insufficient-source-plurality"
  | "insufficient-source-coverage"
  | "insufficient-mechanism-retention"
  | "duplicate-mechanism-portfolio"
  | "lower-ranked"
  | "baseline-reserved";

export type CompositionCandidateReason = {
  readonly code: CompositionCandidateReasonCode;
  readonly detail: string;
};

export type CompositionCandidateEvaluation = {
  readonly candidateId: string;
  readonly status: "selected" | "rejected" | "not-selected";
  readonly reasons: ReadonlyArray<CompositionCandidateReason>;
};

export type CompositionPolicyDisposition =
  | "portfolio-accepted"
  | "team-accepted"
  | "baseline-fallback"
  | "no-qualified-output";

export type CompositionPolicyDecision = {
  readonly decisionId: string;
  readonly policyVersion: string;
  readonly intent: CompositionTaskIntent;
  readonly mode: CompositionMode;
  readonly disposition: CompositionPolicyDisposition;
  readonly selectedCandidateIds: ReadonlyArray<string>;
  readonly selectedCandidates: ReadonlyArray<{
    readonly candidateId: string;
    readonly artifactRef: string;
    readonly artifactHash: string;
  }>;
  readonly retainedMechanismIds: ReadonlyArray<string>;
  readonly sourceCoverage: number;
  readonly mechanismRetention: number;
  readonly evaluations: ReadonlyArray<CompositionCandidateEvaluation>;
  readonly rationale: string;
};

type CompositionPolicyDecisionBody = Omit<CompositionPolicyDecision, "decisionId">;

export const DEFAULT_VALIDATED_COMPOSITION_POLICY: ValidatedCompositionPolicy = Object.freeze({
  version: COMPOSITION_POLICY_VERSION,
  maxCandidates: 32,
  maxPortfolioSize: 4,
  qualityNonInferiorityTolerance: 1,
  minimumSynthesisSourceCoverage: 0.75,
  minimumMechanismRetention: 0.5,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_POLICY_CANDIDATES = 64;
const MAX_POLICY_LIST_ITEMS = 128;
const MAX_EVIDENCE_PER_CANDIDATE = 64;
const CANDIDATE_ROLES: ReadonlyArray<CompositionCandidateRole> = [
  "baseline",
  "node",
  "challenger",
  "synthesis",
];
const CONSTRAINT_STATUSES: ReadonlyArray<CompositionConstraintStatus> = [
  "pass",
  "fail",
  "inconclusive",
];

const assertId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized) || normalized.length > 240) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return normalized;
};

const sortedUniqueIds = (
  values: ReadonlyArray<string> | undefined,
  label: string,
): ReadonlyArray<string> => {
  const normalized = (values ?? []).map((value) => assertId(value, label));
  if (normalized.length > MAX_POLICY_LIST_ITEMS) {
    throw new Error(`${label} exceeds ${MAX_POLICY_LIST_ITEMS} entries`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must not contain duplicate identifiers`);
  }
  return [...normalized].sort();
};

const assertInteger = (value: number, label: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
};

const assertFraction = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number from 0 through 1`);
  }
  return value;
};

const resolvePolicy = (
  override: Partial<ValidatedCompositionPolicy> | undefined,
): ValidatedCompositionPolicy => {
  const policy = { ...DEFAULT_VALIDATED_COMPOSITION_POLICY, ...override };
  const version = assertId(policy.version, "Composition policy version");
  const maxCandidates = assertInteger(
    policy.maxCandidates,
    "Composition maxCandidates",
    1,
    MAX_POLICY_CANDIDATES,
  );
  const maxPortfolioSize = assertInteger(
    policy.maxPortfolioSize,
    "Composition maxPortfolioSize",
    1,
    maxCandidates,
  );
  if (
    !Number.isFinite(policy.qualityNonInferiorityTolerance)
    || policy.qualityNonInferiorityTolerance < 0
  ) {
    throw new Error("Composition qualityNonInferiorityTolerance must be a non-negative finite number");
  }
  return Object.freeze({
    version,
    maxCandidates,
    maxPortfolioSize,
    qualityNonInferiorityTolerance: policy.qualityNonInferiorityTolerance,
    minimumSynthesisSourceCoverage: assertFraction(
      policy.minimumSynthesisSourceCoverage,
      "Composition minimumSynthesisSourceCoverage",
    ),
    minimumMechanismRetention: assertFraction(
      policy.minimumMechanismRetention,
      "Composition minimumMechanismRetention",
    ),
  });
};

export const compositionModeForIntent = (intent: CompositionTaskIntent): CompositionMode => {
  switch (intent) {
    case "ideation": return "portfolio";
    case "convergent": return "validated-selection";
    case "synthesis": return "coverage-synthesis";
  }
};

const coverage = (
  retained: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): number => {
  if (required.length === 0) return 0;
  const retainedSet = new Set(retained);
  return required.filter((id) => retainedSet.has(id)).length / required.length;
};

const compositionPolicyDecisionId = (body: CompositionPolicyDecisionBody): string =>
  `composition-decision-${hashCanonical(body).slice(0, 24)}`;

export const verifyCompositionPolicyDecision = (
  decision: CompositionPolicyDecision,
): boolean => {
  const {
    decisionId,
    ...body
  } = decision;
  if (decision.selectedCandidateIds.length !== decision.selectedCandidates.length) return false;
  if (
    decision.selectedCandidates.some((candidate, index) =>
      candidate.candidateId !== decision.selectedCandidateIds[index])
  ) return false;
  return decisionId === compositionPolicyDecisionId(body);
};

const compareCandidates = (
  left: CompositionPolicyCandidate,
  right: CompositionPolicyCandidate,
): number =>
  right.qualityScore - left.qualityScore
  || (right.originalityScore ?? Number.NEGATIVE_INFINITY)
    - (left.originalityScore ?? Number.NEGATIVE_INFINITY)
  || left.candidateId.localeCompare(right.candidateId);

const validationReasons = (
  candidate: CompositionPolicyCandidate,
  requiredEvidenceKinds: ReadonlyArray<string>,
): ReadonlyArray<CompositionCandidateReason> => {
  const reasons: CompositionCandidateReason[] = [];
  if (
    !Number.isFinite(candidate.qualityScore)
    || (candidate.originalityScore !== undefined && !Number.isFinite(candidate.originalityScore))
  ) {
    reasons.push({ code: "invalid-score", detail: "Candidate scores must be finite" });
  }
  if (candidate.constraintStatus === "fail") {
    reasons.push({ code: "constraint-failed", detail: "Candidate failed its constraint gate" });
  } else if (candidate.constraintStatus === "inconclusive") {
    reasons.push({
      code: "constraint-inconclusive",
      detail: "Candidate constraint status is inconclusive",
    });
  }
  for (const kind of requiredEvidenceKinds) {
    const evidence = candidate.evidence.filter((item) => item.kind === kind);
    if (evidence.length === 0) {
      reasons.push({ code: "missing-evidence", detail: `${kind} evidence is required` });
    } else if (evidence.some((item) => item.verdict === "fail")) {
      reasons.push({ code: "failed-evidence", detail: `${kind} evidence includes a failure` });
    } else if (!evidence.some((item) => item.verdict === "pass")) {
      reasons.push({ code: "failed-evidence", detail: `${kind} evidence did not pass` });
    }
  }
  return reasons;
};

const normalizedCandidate = (
  candidate: CompositionPolicyCandidate,
): CompositionPolicyCandidate => {
  if (candidate.evidence.length > MAX_EVIDENCE_PER_CANDIDATE) {
    throw new Error(`Candidate ${candidate.candidateId} exceeds ${MAX_EVIDENCE_PER_CANDIDATE} evidence items`);
  }
  if (!/^[a-f0-9]{64}$/u.test(candidate.artifactHash)) {
    throw new Error(`Candidate ${candidate.candidateId} artifactHash must be a lowercase SHA-256 digest`);
  }
  if (!CANDIDATE_ROLES.includes(candidate.role)) {
    throw new Error(`Candidate ${candidate.candidateId} has an invalid role`);
  }
  if (!CONSTRAINT_STATUSES.includes(candidate.constraintStatus)) {
    throw new Error(`Candidate ${candidate.candidateId} has an invalid constraint status`);
  }
  const evidence = candidate.evidence.map((item) => {
    if (!["pass", "fail", "inconclusive"].includes(item.verdict)) {
      throw new Error(`Candidate ${candidate.candidateId} has an invalid evidence verdict`);
    }
    if (item.artifactHash !== undefined && !/^[a-f0-9]{64}$/u.test(item.artifactHash)) {
      throw new Error(`Candidate ${candidate.candidateId} has an invalid evidence artifact hash`);
    }
    return Object.freeze({
      ...item,
      id: assertId(item.id, "Composition evidence ID"),
      kind: assertId(item.kind, "Composition evidence kind"),
    });
  });
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) {
    throw new Error(`Candidate ${candidate.candidateId} evidence IDs must be unique`);
  }
  return Object.freeze({
    ...candidate,
    candidateId: assertId(candidate.candidateId, "Composition candidate ID"),
    nodeId: assertId(candidate.nodeId, "Composition candidate node ID"),
    artifactRef: assertId(candidate.artifactRef, "Composition candidate artifact reference"),
    evidence: Object.freeze(evidence.sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))),
    sourceCandidateIds: Object.freeze(sortedUniqueIds(
      candidate.sourceCandidateIds,
      "Composition source candidate ID",
    )),
    mechanismIds: Object.freeze(sortedUniqueIds(
      candidate.mechanismIds,
      "Composition mechanism ID",
    )),
  });
};

type WorkingEvaluation = {
  readonly candidate: CompositionPolicyCandidate;
  readonly reasons: CompositionCandidateReason[];
};

const rejectQualityRegression = (
  evaluations: ReadonlyArray<WorkingEvaluation>,
  baseline: WorkingEvaluation,
  tolerance: number,
): void => {
  if (baseline.reasons.length > 0 || !Number.isFinite(baseline.candidate.qualityScore)) return;
  const floor = baseline.candidate.qualityScore - tolerance;
  for (const evaluation of evaluations) {
    if (
      evaluation.candidate.candidateId !== baseline.candidate.candidateId
      && Number.isFinite(evaluation.candidate.qualityScore)
      && evaluation.candidate.qualityScore < floor
    ) {
      evaluation.reasons.push({
        code: "quality-regression",
        detail: `Quality ${String(evaluation.candidate.qualityScore)} is below non-inferiority floor ${String(floor)}`,
      });
    }
  }
};

const choosePortfolio = (
  candidates: ReadonlyArray<WorkingEvaluation>,
  maxPortfolioSize: number,
): ReadonlyArray<WorkingEvaluation> => {
  const selected: WorkingEvaluation[] = [];
  const mechanismSignatures = new Set<string>();
  for (const evaluation of candidates
    .filter((item) => item.candidate.role !== "baseline" && item.reasons.length === 0)
    .sort((left, right) => compareCandidates(left.candidate, right.candidate))) {
    const signature = (evaluation.candidate.mechanismIds ?? []).join("|");
    if (mechanismSignatures.has(signature)) {
      evaluation.reasons.push({
        code: "duplicate-mechanism-portfolio",
        detail: "A higher-ranked portfolio candidate exposes the same mechanism set",
      });
      continue;
    }
    if (selected.length >= maxPortfolioSize) {
      evaluation.reasons.push({
        code: "lower-ranked",
        detail: `Portfolio is bounded to ${String(maxPortfolioSize)} candidates`,
      });
      continue;
    }
    mechanismSignatures.add(signature);
    selected.push(evaluation);
  }
  return selected;
};

const chooseHighestRanked = (
  candidates: ReadonlyArray<WorkingEvaluation>,
): ReadonlyArray<WorkingEvaluation> => {
  const eligible = candidates
    .filter((item) => item.candidate.role !== "baseline" && item.reasons.length === 0)
    .sort((left, right) => compareCandidates(left.candidate, right.candidate));
  for (const evaluation of eligible.slice(1)) {
    evaluation.reasons.push({
      code: "lower-ranked",
      detail: `Candidate ${eligible[0]!.candidate.candidateId} ranked higher`,
    });
  }
  return eligible.slice(0, 1);
};

const chooseSynthesis = (
  candidates: ReadonlyArray<WorkingEvaluation>,
  candidateById: ReadonlyMap<string, CompositionPolicyCandidate>,
  requiredSourceNodeIds: ReadonlyArray<string>,
  requiredMechanismIds: ReadonlyArray<string>,
  policy: ValidatedCompositionPolicy,
): ReadonlyArray<WorkingEvaluation> => {
  for (const evaluation of candidates) {
    if (evaluation.candidate.role === "baseline") continue;
    if (evaluation.candidate.role !== "synthesis") {
      evaluation.reasons.push({
        code: "source-only",
        detail: "Coverage synthesis accepts composed candidates; this contribution remains source material",
      });
      continue;
    }
    const sourceCandidateIds = evaluation.candidate.sourceCandidateIds ?? [];
    const sources = sourceCandidateIds
      .map((candidateId) => candidateById.get(candidateId))
      .filter((candidate): candidate is CompositionPolicyCandidate =>
        candidate !== undefined && candidate.role !== "baseline" && candidate.role !== "synthesis");
    if (sources.length !== sourceCandidateIds.length) {
      evaluation.reasons.push({
        code: "unknown-source-candidate",
        detail: "Synthesis references an unknown, baseline, or composed source candidate",
      });
    }
    const sourceNodeIds = [...new Set(sources.map((source) => source.nodeId))].sort();
    if (new Set(sourceCandidateIds).size < 2 || sourceNodeIds.length < 2) {
      evaluation.reasons.push({
        code: "insufficient-source-plurality",
        detail: "Synthesis must retain at least two candidate and node sources",
      });
    }
    const sourceCoverage = coverage(sourceNodeIds, requiredSourceNodeIds);
    if (
      requiredSourceNodeIds.length === 0
      || sourceCoverage < policy.minimumSynthesisSourceCoverage
    ) {
      evaluation.reasons.push({
        code: "insufficient-source-coverage",
        detail: `Source coverage ${sourceCoverage.toFixed(3)} is below ${policy.minimumSynthesisSourceCoverage.toFixed(3)}`,
      });
    }
    const mechanismRetention = coverage(
      evaluation.candidate.mechanismIds ?? [],
      requiredMechanismIds,
    );
    const sourceMechanisms = new Set(sources.flatMap((source) => source.mechanismIds ?? []));
    if ((evaluation.candidate.mechanismIds ?? []).some((id) => !sourceMechanisms.has(id))) {
      evaluation.reasons.push({
        code: "unproven-mechanism",
        detail: "Synthesis claims a mechanism that is absent from its referenced source candidates",
      });
    }
    if (
      requiredMechanismIds.length === 0
      || mechanismRetention < policy.minimumMechanismRetention
    ) {
      evaluation.reasons.push({
        code: "insufficient-mechanism-retention",
        detail: `Mechanism retention ${mechanismRetention.toFixed(3)} is below ${policy.minimumMechanismRetention.toFixed(3)}`,
      });
    }
  }
  return chooseHighestRanked(candidates);
};

/**
 * Deterministically validates and chooses a composition frontier. Candidate
 * arrival order cannot affect the result; ties resolve by immutable candidate
 * ID. Invalid collaboration falls back to an independently validated baseline.
 */
export const decideCompositionPolicy = (
  input: CompositionPolicyInput,
): CompositionPolicyDecision => {
  if (!["ideation", "convergent", "synthesis"].includes(input.intent)) {
    throw new Error("Composition intent is invalid");
  }
  const policy = resolvePolicy(input.policy);
  if (input.candidates.length === 0 || input.candidates.length > policy.maxCandidates) {
    throw new Error(`Composition candidates must contain 1 through ${String(policy.maxCandidates)} entries`);
  }
  const candidates = input.candidates.map(normalizedCandidate)
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    throw new Error("Composition candidate IDs must be unique");
  }
  const candidateById = new Map(candidates.map((candidate) => [
    candidate.candidateId,
    candidate,
  ]));
  const baselineCandidateId = assertId(input.baselineCandidateId, "Baseline candidate ID");
  const baselineCandidate = candidates.find((candidate) =>
    candidate.candidateId === baselineCandidateId);
  if (!baselineCandidate) throw new Error(`Unknown baseline candidate ${baselineCandidateId}`);
  if (baselineCandidate.role !== "baseline") {
    throw new Error(`Baseline candidate ${baselineCandidateId} must have role baseline`);
  }
  const requiredEvidenceKinds = sortedUniqueIds(
    input.requiredEvidenceKinds,
    "Required composition evidence kind",
  );
  const requiredSourceNodeIds = sortedUniqueIds(
    input.requiredSourceNodeIds,
    "Required composition source node ID",
  );
  const requiredMechanismIds = sortedUniqueIds(
    input.requiredMechanismIds,
    "Required composition mechanism ID",
  );
  const evaluations: WorkingEvaluation[] = candidates.map((candidate) => ({
    candidate,
    reasons: [...validationReasons(candidate, requiredEvidenceKinds)],
  }));
  const baseline = evaluations.find((evaluation) =>
    evaluation.candidate.candidateId === baselineCandidateId)!;
  rejectQualityRegression(evaluations, baseline, policy.qualityNonInferiorityTolerance);

  const mode = compositionModeForIntent(input.intent);
  let selected = mode === "portfolio"
    ? choosePortfolio(evaluations, policy.maxPortfolioSize)
    : mode === "validated-selection"
      ? chooseHighestRanked(evaluations)
      : chooseSynthesis(
        evaluations,
        candidateById,
        requiredSourceNodeIds,
        requiredMechanismIds,
        policy,
      );

  let disposition: CompositionPolicyDisposition;
  let rationale: string;
  if (selected.length > 0) {
    disposition = mode === "portfolio" ? "portfolio-accepted" : "team-accepted";
    rationale = mode === "portfolio"
      ? "Accepted a bounded, mechanism-distinct portfolio of validated candidates"
      : mode === "validated-selection"
        ? "Accepted the highest-ranked validated non-inferior candidate"
        : "Accepted a validated synthesis with sufficient source and mechanism coverage";
  } else if (baseline.reasons.length === 0) {
    selected = [baseline];
    disposition = "baseline-fallback";
    rationale = "Collaboration did not clear the declared gates; retained the validated baseline";
  } else {
    disposition = "no-qualified-output";
    rationale = "Neither collaboration nor the baseline cleared the declared gates";
  }

  const selectedIds = new Set(selected.map((evaluation) => evaluation.candidate.candidateId));
  const candidateEvaluations: ReadonlyArray<CompositionCandidateEvaluation> = Object.freeze(
    evaluations.map((evaluation): CompositionCandidateEvaluation => {
      if (selectedIds.has(evaluation.candidate.candidateId)) {
        return Object.freeze({
          candidateId: evaluation.candidate.candidateId,
          status: "selected",
          reasons: Object.freeze([]),
        });
      }
      if (evaluation.reasons.length > 0) {
        return Object.freeze({
          candidateId: evaluation.candidate.candidateId,
          status: "rejected",
          reasons: Object.freeze([...evaluation.reasons]),
        });
      }
      return Object.freeze({
        candidateId: evaluation.candidate.candidateId,
        status: "not-selected",
        reasons: Object.freeze([{
          code: "baseline-reserved" as const,
          detail: "Validated baseline was reserved for fallback",
        }]),
      });
    }),
  );
  const selectedCandidates = selected.map((evaluation) => evaluation.candidate);
  const selectedCandidateReferences = Object.freeze(
    selectedCandidates
      .map((candidate) => Object.freeze({
        candidateId: candidate.candidateId,
        artifactRef: candidate.artifactRef,
        artifactHash: candidate.artifactHash,
      }))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  );
  const retainedMechanismIds = Object.freeze([...new Set(selectedCandidates.flatMap((candidate) =>
    candidate.mechanismIds ?? []))].sort());
  const retainedSourceNodeIds = [...new Set(selectedCandidates.flatMap((candidate) =>
    candidate.role === "synthesis"
      ? (candidate.sourceCandidateIds ?? [])
        .map((candidateId) => candidateById.get(candidateId))
        .filter((source): source is CompositionPolicyCandidate => source !== undefined)
        .map((source) => source.nodeId)
      : candidate.role === "baseline" ? [] : [candidate.nodeId]))].sort();
  const sourceCoverage = coverage(retainedSourceNodeIds, requiredSourceNodeIds);
  const mechanismRetention = coverage(retainedMechanismIds, requiredMechanismIds);
  const decisionBody: CompositionPolicyDecisionBody = {
    policyVersion: policy.version,
    intent: input.intent,
    mode,
    disposition,
    selectedCandidateIds: Object.freeze([...selectedIds].sort()),
    selectedCandidates: selectedCandidateReferences,
    retainedMechanismIds,
    sourceCoverage,
    mechanismRetention,
    evaluations: candidateEvaluations,
    rationale,
  };
  return Object.freeze({
    decisionId: compositionPolicyDecisionId(decisionBody),
    ...decisionBody,
  });
};
