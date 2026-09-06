import assert from "node:assert/strict";
import test from "node:test";

import {
  replayCreativityCompositionPolicy,
  type CreativityCompositionReplayPair,
} from "../../src/evals/creativity-composition-policy.ts";
import {
  CREATIVITY_BENCHMARK_SCHEMA_VERSION,
  type CreativityBenchmarkCase,
  type CreativityJudgment,
  type CreativityTrialRecord,
} from "../../src/evals/creativity-benchmark.ts";

const benchmark: CreativityBenchmarkCase = {
  id: "policy-case",
  title: "Policy case",
  domain: "product-ideation",
  prompt: "Create one composed result.",
  constraints: ["Remain safe."],
};

const judgments = (
  quality: number,
  originality: number,
  pass = true,
): ReadonlyArray<CreativityJudgment> => [{
  judgeId: `judge-${String(quality)}`,
  judgeFamily: "deterministic-test",
  blinded: true,
  scores: {
    originality,
    usefulness: quality,
    coherence: quality,
    constraintSatisfaction: quality,
  },
  constraintPass: pass,
}];

const trial = (input: {
  readonly condition: "solo-divergent" | "team-independent-challenge";
  readonly quality: number;
  readonly originality: number;
  readonly pass?: boolean;
  readonly selected: ReadonlyArray<string>;
  readonly mechanisms: ReadonlyArray<string>;
}): CreativityTrialRecord => ({
  schemaVersion: CREATIVITY_BENCHMARK_SCHEMA_VERSION,
  suiteVersion: "composition-policy-test-v1",
  caseId: benchmark.id,
  condition: input.condition,
  seed: 1,
  modelFingerprint: "test-model",
  promptFingerprint: "test-prompt",
  contributions: input.condition === "solo-divergent"
    ? [{
      contributionId: "solo",
      nodeId: "solo",
      round: 1,
      text: "Baseline",
      mechanismTags: ["baseline"],
    }]
    : [
      {
        contributionId: "a",
        nodeId: "node-a",
        round: 1,
        text: "A",
        mechanismTags: ["mechanism-a"],
      },
      {
        contributionId: "b",
        nodeId: "node-b",
        round: 1,
        text: "B",
        mechanismTags: ["mechanism-b"],
      },
      {
        contributionId: "c",
        nodeId: "node-c",
        round: 1,
        text: "C",
        mechanismTags: ["mechanism-c"],
      },
    ],
  finalArtifact: {
    text: input.condition === "solo-divergent" ? "Baseline" : "Treatment",
    selectedContributionIds: input.selected,
    mechanismTags: input.mechanisms,
  },
  judgments: judgments(input.quality, input.originality, input.pass),
});

test("frozen creativity replay measures accepted synthesis and policy fallback separately", () => {
  const baseline = trial({
    condition: "solo-divergent",
    quality: 90,
    originality: 70,
    selected: ["solo"],
    mechanisms: ["baseline"],
  });
  const acceptedTreatment = trial({
    condition: "team-independent-challenge",
    quality: 92,
    originality: 80,
    selected: ["a", "b", "c"],
    mechanisms: ["mechanism-a", "mechanism-b"],
  });
  const rejectedTreatment = trial({
    condition: "team-independent-challenge",
    quality: 80,
    originality: 90,
    pass: false,
    selected: ["a"],
    mechanisms: ["mechanism-a"],
  });
  const pairs: ReadonlyArray<CreativityCompositionReplayPair> = [
    {
      pairId: "accepted",
      caseId: benchmark.id,
      generator: "test",
      seed: 1,
      baseline,
      treatment: acceptedTreatment,
    },
    {
      pairId: "fallback",
      caseId: benchmark.id,
      generator: "test",
      seed: 2,
      baseline,
      treatment: rejectedTreatment,
    },
  ];
  const replay = replayCreativityCompositionPolicy({ cases: [benchmark], pairs });

  assert.equal(replay.acceptedTreatmentPairs, 1);
  assert.equal(replay.baselineFallbackPairs, 1);
  assert.equal(replay.noQualifiedOutputPairs, 0);
  assert.equal(replay.preventedQualityRegressions, 1);
  assert.equal(replay.preventedConstraintRegressions, 1);
  assert.equal(replay.selectedPolicyQualityEffect?.meanDifference, 1);
  assert.equal(replay.outcomes.find((outcome) => outcome.pairId === "accepted")?.selectedCondition, "treatment");
  assert.equal(replay.outcomes.find((outcome) => outcome.pairId === "fallback")?.selectedCondition, "baseline");
});
