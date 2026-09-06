import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CREATIVITY_BENCHMARK_SCHEMA_VERSION,
  CREATIVITY_PROMPT_PROTOCOLS,
  assessCreativityJudgeReliability,
  buildCreativityPrompt,
  estimateCreativityPairedEffect,
  getCreativityBenchmarkCase,
  normalizeCreativityTrial,
  scoreCreativityTrial,
  summarizeCreativityConditions,
  type CreativityTrialRecord,
} from "../../src/evals/creativity-benchmark.ts";

const demoRecords = async (): Promise<ReadonlyArray<CreativityTrialRecord>> =>
  JSON.parse(await readFile("fixtures/evals/creativity-demo.json", "utf8")) as ReadonlyArray<CreativityTrialRecord>;

test("creativity benchmark keeps quality, novelty, diversity, and collaboration inspectable", async () => {
  const records = await demoRecords();
  const benchmark = getCreativityBenchmarkCase("offline-neighborhood-cooling");
  assert.ok(benchmark);
  const scores = records.map((record) => scoreCreativityTrial(record, benchmark));
  const solo = scores.find((score) => score.condition === "solo-neutral");
  const team = scores.find((score) => score.condition === "team-independent-challenge");
  assert.ok(solo);
  assert.ok(team);

  assert.equal(solo.collaboration.contributingNodes, 1);
  assert.equal(solo.collaboration.crossNodeSynthesis, false);
  assert.equal(team.collaboration.contributingNodes, 4);
  assert.equal(team.collaboration.selectedNodes, 4);
  assert.equal(team.collaboration.modelFingerprints, 3);
  assert.equal(team.collaboration.crossNodeSynthesis, true);
  assert.equal(team.diversity.mechanismCount, 8);
  assert.equal(team.diversity.mechanismCoverage, 1);
  assert.ok(team.diversity.explorationSpread > solo.diversity.explorationSpread);
  assert.ok((team.novelty.judgedOriginality ?? 0) > (solo.novelty.judgedOriginality ?? 0));

  const summaries = summarizeCreativityConditions(scores);
  assert.deepEqual(summaries.map((summary) => summary.condition), [
    "solo-neutral",
    "team-independent-challenge",
  ]);
  assert.equal(summaries[1]?.meanTokens, 4_300);
  assert.equal(summaries[1]?.meanCostUsd, 0.31);
});

test("creativity trial scoring is invariant to contribution and judge delivery order", async () => {
  const records = await demoRecords();
  const source = records[1];
  const benchmark = getCreativityBenchmarkCase("offline-neighborhood-cooling");
  assert.ok(source);
  assert.ok(benchmark);
  const forward = scoreCreativityTrial(source, benchmark);
  const reordered = scoreCreativityTrial({
    ...source,
    contributions: [...source.contributions].reverse(),
    judgments: [...source.judgments].reverse(),
  }, benchmark);
  assert.deepEqual(reordered, forward);
});

test("creativity prompts encode independence as a context policy, not a persona claim", () => {
  const benchmark = getCreativityBenchmarkCase("museum-after-closing");
  assert.ok(benchmark);
  const independent = CREATIVITY_PROMPT_PROTOCOLS["team-independent-first"];
  assert.equal(independent.phases[0]?.contextPolicy, "task-only");
  assert.equal(independent.phases[1]?.contextPolicy, "shared-all");

  const prompt = buildCreativityPrompt(benchmark, "team-independent-challenge", "challenge");
  assert.match(prompt, /Do not rank or summarize/);
  assert.match(prompt, /Context policy: shared-prior/);
  assert.match(prompt, /museum exhibit/);
  assert.match(prompt, /Hard constraints:/);
});

test("creativity trials reject forged provenance and malformed accounting", async () => {
  const [source] = await demoRecords();
  assert.ok(source);

  assert.throws(() => normalizeCreativityTrial({
    ...source,
    finalArtifact: {
      ...source.finalArtifact,
      selectedContributionIds: ["unknown-contribution"],
    },
  }), /unknown contribution/);

  assert.throws(() => normalizeCreativityTrial({
    ...source,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 99,
    },
  }), /must equal/);

  assert.throws(() => normalizeCreativityTrial({
    ...source,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      partial: true,
    },
  }), /cannot be partial/);

  assert.throws(() => normalizeCreativityTrial({
    ...source,
    schemaVersion: "roster.creativity-trial.v0" as typeof CREATIVITY_BENCHMARK_SCHEMA_VERSION,
  }), /Unsupported creativity trial schema/);
});

test("paired creativity effects preserve matching and report deterministic uncertainty", () => {
  const effect = estimateCreativityPairedEffect(
    [70, 65, 80, 55],
    [78, 64, 89, 61],
    { bootstrapIterations: 2_000, randomSeed: 42 },
  );
  const repeated = estimateCreativityPairedEffect(
    [70, 65, 80, 55],
    [78, 64, 89, 61],
    { bootstrapIterations: 2_000, randomSeed: 42 },
  );

  assert.deepEqual(effect, repeated);
  assert.equal(effect.pairs, 4);
  assert.equal(effect.meanDifference, 5.5);
  assert.deepEqual([effect.wins, effect.ties, effect.losses], [3, 0, 1]);
  assert.equal(effect.winRateExcludingTies, 0.75);
  assert.ok(effect.bootstrapConfidenceInterval[0] < effect.meanDifference);
  assert.ok(effect.bootstrapConfidenceInterval[1] > effect.meanDifference);
  assert.ok((effect.standardizedMeanDifference ?? 0) > 0);

  assert.throws(
    () => estimateCreativityPairedEffect([1], [1, 2]),
    /equally sized/,
  );
});

test("position-balanced judge reliability rejects order-sensitive families", () => {
  const reliability = assessCreativityJudgeReliability([
    { judgeFamily: "stable-treatment", order: "baseline-first", preference: "treatment" },
    { judgeFamily: "stable-treatment", order: "treatment-first", preference: "treatment" },
    { judgeFamily: "always-first", order: "baseline-first", preference: "baseline" },
    { judgeFamily: "always-first", order: "treatment-first", preference: "treatment" },
    { judgeFamily: "incomplete", order: "baseline-first", preference: "tie" },
  ]);

  assert.deepEqual(reliability, {
    judgeFamilies: 3,
    completeFamilies: 2,
    stableFamilies: 1,
    unstableFamilies: 1,
    stablePreferences: { baseline: 0, treatment: 1, tie: 0 },
    reliablePreference: "treatment",
  });

  assert.throws(() => assessCreativityJudgeReliability([
    { judgeFamily: "duplicate", order: "baseline-first", preference: "baseline" },
    { judgeFamily: "duplicate", order: "baseline-first", preference: "treatment" },
  ]), /Duplicate baseline-first/);
});
