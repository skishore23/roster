import { hashCanonical, sha256 } from "../core/canonical.js";
import {
  decideCompositionPolicy,
  type CompositionConstraintStatus,
  type CompositionCandidateReasonCode,
  type CompositionPolicyDecision,
  type ValidatedCompositionPolicy,
} from "../engine/orchestration/composition-policy.js";
import {
  estimateCreativityPairedEffect,
  scoreCreativityTrial,
  type CreativityBenchmarkCase,
  type CreativityPairedEffect,
  type CreativityTrialRecord,
} from "./creativity-benchmark.js";
import { deterministicCreativityConstraintPass } from "./creativity-constraints.js";

export type CreativityCompositionReplayPair = {
  readonly pairId: string;
  readonly caseId: string;
  readonly generator: string;
  readonly seed: number;
  readonly baseline: CreativityTrialRecord;
  readonly treatment: CreativityTrialRecord;
};

export type CreativityCompositionReplayOutcome = {
  readonly pairId: string;
  readonly caseId: string;
  readonly generator: string;
  readonly seed: number;
  readonly decision: CompositionPolicyDecision;
  readonly selectedCondition: "baseline" | "treatment" | "none";
  readonly baselineQuality: number;
  readonly treatmentQuality: number;
  readonly selectedQuality?: number;
  readonly baselineOriginality: number;
  readonly treatmentOriginality: number;
  readonly selectedOriginality?: number;
  readonly treatmentSourceCoverage: number;
  readonly treatmentMechanismRetention: number;
};

export type CreativityCompositionPolicyReplay = {
  readonly schemaVersion: "roster.creativity-composition-policy-replay.v1";
  readonly evaluatedPairs: number;
  readonly qualifiedPairs: number;
  readonly acceptedTreatmentPairs: number;
  readonly baselineFallbackPairs: number;
  readonly noQualifiedOutputPairs: number;
  readonly preventedQualityRegressions: number;
  readonly preventedConstraintRegressions: number;
  readonly treatmentRejectionCounts: Readonly<Partial<Record<CompositionCandidateReasonCode, number>>>;
  readonly originalTreatmentQualityEffect: CreativityPairedEffect;
  readonly selectedPolicyQualityEffect?: CreativityPairedEffect;
  readonly originalTreatmentOriginalityEffect: CreativityPairedEffect;
  readonly selectedPolicyOriginalityEffect?: CreativityPairedEffect;
  readonly outcomes: ReadonlyArray<CreativityCompositionReplayOutcome>;
};

const mean = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const quality = (
  record: CreativityTrialRecord,
  benchmark: CreativityBenchmarkCase,
): number => {
  const scored = scoreCreativityTrial(record, benchmark);
  const values = [
    scored.quality.usefulness,
    scored.quality.coherence,
    scored.quality.constraintSatisfaction,
  ].filter((value): value is number => value !== undefined);
  if (values.length === 0) throw new Error(`Trial ${scored.trialId} has no quality judgments`);
  return mean(values);
};

const originality = (
  record: CreativityTrialRecord,
  benchmark: CreativityBenchmarkCase,
): number => {
  const score = scoreCreativityTrial(record, benchmark).novelty.judgedOriginality;
  if (score === undefined) throw new Error(`Trial ${record.caseId} has no originality judgments`);
  return score;
};

const constraintStatus = (record: CreativityTrialRecord): CompositionConstraintStatus => {
  const deterministic = deterministicCreativityConstraintPass(
    record.caseId,
    record.finalArtifact.text,
  );
  if (deterministic !== undefined) return deterministic ? "pass" : "fail";
  if (record.judgments.length === 0) return "inconclusive";
  // The frozen study used four position-balanced model judgments rather than
  // one deterministic validator. Require a 3/4 supermajority so one unstable
  // judge cannot invalidate an otherwise accepted baseline.
  const passRate = record.judgments.filter((judgment) => judgment.constraintPass).length
    / record.judgments.length;
  return passRate >= 0.75 ? "pass" : "fail";
};

const boundedSemanticId = (prefix: string, value: string): string =>
  `${prefix}:${hashCanonical(value).slice(0, 24)}`;

const uniqueSorted = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort();

export const replayCreativityCompositionPolicy = (input: {
  readonly cases: ReadonlyArray<CreativityBenchmarkCase>;
  readonly pairs: ReadonlyArray<CreativityCompositionReplayPair>;
  readonly policy?: Partial<ValidatedCompositionPolicy>;
}): CreativityCompositionPolicyReplay => {
  if (input.pairs.length === 0) throw new Error("Creativity composition replay requires pairs");
  const caseById = new Map(input.cases.map((benchmark) => [benchmark.id, benchmark]));
  if (caseById.size !== input.cases.length) throw new Error("Creativity replay case IDs must be unique");
  const outcomes = input.pairs.map((pair): CreativityCompositionReplayOutcome => {
    const benchmark = caseById.get(pair.caseId);
    if (!benchmark) throw new Error(`Unknown creativity replay case ${pair.caseId}`);
    const baselineQuality = quality(pair.baseline, benchmark);
    const treatmentQuality = quality(pair.treatment, benchmark);
    const baselineOriginality = originality(pair.baseline, benchmark);
    const treatmentOriginality = originality(pair.treatment, benchmark);
    const treatmentContributionById = new Map(pair.treatment.contributions.map((contribution) => [
      contribution.contributionId,
      contribution,
    ]));
    const requiredSourceNodeIds = uniqueSorted(pair.treatment.contributions.map((contribution) =>
      contribution.nodeId));
    const selectedContributions = pair.treatment.finalArtifact.selectedContributionIds
      .map((id) => treatmentContributionById.get(id))
      .filter((contribution) => contribution !== undefined);
    const selectedSourceNodeIds = uniqueSorted(selectedContributions.map((contribution) =>
      contribution.nodeId));
    const requiredMechanismIds = uniqueSorted(
      pair.treatment.contributions.flatMap((contribution) => contribution.mechanismTags)
        .map((tag) => boundedSemanticId("mechanism", tag)),
    );
    const retainedMechanismIds = uniqueSorted(pair.treatment.finalArtifact.mechanismTags
      .map((tag) => boundedSemanticId("mechanism", tag)));
    const baselineStatus = constraintStatus(pair.baseline);
    const treatmentStatus = constraintStatus(pair.treatment);
    const sourceCandidates = pair.treatment.contributions.map((contribution) => ({
      candidateId: boundedSemanticId("contribution", contribution.contributionId),
      nodeId: contribution.nodeId,
      role: contribution.nodeId === "challenger" ? "challenger" as const : "node" as const,
      artifactRef: boundedSemanticId("artifact", contribution.text),
      artifactHash: sha256(contribution.text),
      qualityScore: treatmentQuality,
      originalityScore: treatmentOriginality,
      constraintStatus: "pass" as const,
      evidence: [{
        id: boundedSemanticId("evidence", `${pair.pairId}:${contribution.contributionId}`),
        kind: "constraints",
        verdict: "pass" as const,
      }],
      mechanismIds: uniqueSorted(contribution.mechanismTags
        .map((tag) => boundedSemanticId("mechanism", tag))),
    }));
    const decision = decideCompositionPolicy({
      // The frozen protocol requested one final artifact, so its composition
      // intent is synthesis even when the underlying task domain is ideation.
      intent: "synthesis",
      baselineCandidateId: "baseline",
      requiredEvidenceKinds: ["constraints"],
      requiredSourceNodeIds,
      requiredMechanismIds,
      candidates: [
        {
          candidateId: "baseline",
          nodeId: "solo",
          role: "baseline",
          artifactRef: boundedSemanticId("artifact", pair.baseline.finalArtifact.text),
          artifactHash: sha256(pair.baseline.finalArtifact.text),
          qualityScore: baselineQuality,
          originalityScore: baselineOriginality,
          constraintStatus: baselineStatus,
          evidence: [{
            id: boundedSemanticId("evidence", `${pair.pairId}:baseline`),
            kind: "constraints",
            verdict: baselineStatus,
          }],
          mechanismIds: uniqueSorted(pair.baseline.finalArtifact.mechanismTags
            .map((tag) => boundedSemanticId("mechanism", tag))),
        },
        {
          candidateId: "treatment",
          nodeId: "composer",
          role: "synthesis",
          artifactRef: boundedSemanticId("artifact", pair.treatment.finalArtifact.text),
          artifactHash: sha256(pair.treatment.finalArtifact.text),
          qualityScore: treatmentQuality,
          originalityScore: treatmentOriginality,
          constraintStatus: treatmentStatus,
          evidence: [{
            id: boundedSemanticId("evidence", `${pair.pairId}:treatment`),
            kind: "constraints",
            verdict: treatmentStatus,
          }],
          sourceCandidateIds: pair.treatment.finalArtifact.selectedContributionIds
            .map((id) => boundedSemanticId("contribution", id)),
          mechanismIds: retainedMechanismIds,
        },
        ...sourceCandidates,
      ],
      policy: input.policy,
    });
    const selectedCandidateId = decision.selectedCandidateIds[0];
    const selectedCondition = selectedCandidateId === "treatment"
      ? "treatment"
      : selectedCandidateId === "baseline"
        ? "baseline"
        : "none";
    return {
      pairId: pair.pairId,
      caseId: pair.caseId,
      generator: pair.generator,
      seed: pair.seed,
      decision,
      selectedCondition,
      baselineQuality,
      treatmentQuality,
      ...(selectedCondition === "treatment"
        ? { selectedQuality: treatmentQuality, selectedOriginality: treatmentOriginality }
        : selectedCondition === "baseline"
          ? { selectedQuality: baselineQuality, selectedOriginality: baselineOriginality }
          : {}),
      baselineOriginality,
      treatmentOriginality,
      treatmentSourceCoverage: requiredSourceNodeIds.length === 0
        ? 0
        : selectedSourceNodeIds.length / requiredSourceNodeIds.length,
      treatmentMechanismRetention: requiredMechanismIds.length === 0
        ? 0
        : retainedMechanismIds.filter((id) => requiredMechanismIds.includes(id)).length
          / requiredMechanismIds.length,
    };
  }).sort((left, right) => left.pairId.localeCompare(right.pairId));
  const qualified = outcomes.filter((outcome) => outcome.selectedQuality !== undefined);
  const originalBaselineQuality = outcomes.map((outcome) => outcome.baselineQuality);
  const originalTreatmentQuality = outcomes.map((outcome) => outcome.treatmentQuality);
  const originalBaselineOriginality = outcomes.map((outcome) => outcome.baselineOriginality);
  const originalTreatmentOriginality = outcomes.map((outcome) => outcome.treatmentOriginality);
  const selectedBaselineQuality = qualified.map((outcome) => outcome.baselineQuality);
  const selectedQuality = qualified.map((outcome) => outcome.selectedQuality!);
  const selectedBaselineOriginality = qualified.map((outcome) => outcome.baselineOriginality);
  const selectedOriginality = qualified.map((outcome) => outcome.selectedOriginality!);
  const treatmentRejectionCounts: Partial<Record<CompositionCandidateReasonCode, number>> = {};
  for (const outcome of outcomes) {
    const treatment = outcome.decision.evaluations.find((evaluation) =>
      evaluation.candidateId === "treatment");
    for (const reason of treatment?.reasons ?? []) {
      treatmentRejectionCounts[reason.code] = (treatmentRejectionCounts[reason.code] ?? 0) + 1;
    }
  }
  return Object.freeze({
    schemaVersion: "roster.creativity-composition-policy-replay.v1",
    evaluatedPairs: outcomes.length,
    qualifiedPairs: qualified.length,
    acceptedTreatmentPairs: outcomes.filter((outcome) =>
      outcome.selectedCondition === "treatment").length,
    baselineFallbackPairs: outcomes.filter((outcome) =>
      outcome.selectedCondition === "baseline").length,
    noQualifiedOutputPairs: outcomes.filter((outcome) =>
      outcome.selectedCondition === "none").length,
    preventedQualityRegressions: outcomes.filter((outcome) =>
      outcome.selectedCondition === "baseline"
      && outcome.treatmentQuality
        < outcome.baselineQuality - (input.policy?.qualityNonInferiorityTolerance ?? 1)).length,
    preventedConstraintRegressions: outcomes.filter((outcome) =>
      outcome.selectedCondition === "baseline"
      && constraintStatus(input.pairs.find((pair) => pair.pairId === outcome.pairId)!.baseline) === "pass"
      && constraintStatus(input.pairs.find((pair) => pair.pairId === outcome.pairId)!.treatment) !== "pass"
    ).length,
    treatmentRejectionCounts: Object.freeze(treatmentRejectionCounts),
    originalTreatmentQualityEffect: estimateCreativityPairedEffect(
      originalBaselineQuality,
      originalTreatmentQuality,
      { randomSeed: 20_260_729 },
    ),
    ...(qualified.length > 0 ? {
      selectedPolicyQualityEffect: estimateCreativityPairedEffect(
        selectedBaselineQuality,
        selectedQuality,
        { randomSeed: 20_260_729 },
      ),
    } : {}),
    originalTreatmentOriginalityEffect: estimateCreativityPairedEffect(
      originalBaselineOriginality,
      originalTreatmentOriginality,
      { randomSeed: 20_260_729 },
    ),
    ...(qualified.length > 0 ? {
      selectedPolicyOriginalityEffect: estimateCreativityPairedEffect(
        selectedBaselineOriginality,
        selectedOriginality,
        { randomSeed: 20_260_729 },
      ),
    } : {}),
    outcomes,
  });
};
