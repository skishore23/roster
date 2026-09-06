import { hashCanonical } from "../core/canonical.js";
import type { NodeExecutionUsage } from "../engine/orchestration/types.js";

export const CREATIVITY_BENCHMARK_SCHEMA_VERSION = "roster.creativity-trial.v1";
export const CREATIVITY_BENCHMARK_SUITE_VERSION = "roster-creativity-starter.v1";

export const CREATIVITY_CONDITIONS = [
  "solo-neutral",
  "solo-divergent",
  "team-shared-first",
  "team-independent-first",
  "team-independent-challenge",
] as const;

export type CreativityCondition = typeof CREATIVITY_CONDITIONS[number];
export type CreativityDomain =
  | "divergent-thinking"
  | "creative-writing"
  | "product-ideation"
  | "scientific-ideation"
  | "creative-problem-solving";

export type CreativityBenchmarkCase = {
  readonly id: string;
  readonly title: string;
  readonly domain: CreativityDomain;
  readonly prompt: string;
  readonly constraints: ReadonlyArray<string>;
  /**
   * Frozen examples or known common answers used only for copying/novelty
   * diagnostics. They are not shown to generators.
   */
  readonly referenceCorpus?: ReadonlyArray<string>;
};

export type CreativityContribution = {
  readonly contributionId: string;
  readonly nodeId: string;
  readonly round: number;
  readonly text: string;
  /**
   * Short, evaluator-visible mechanism labels. These make conceptual breadth
   * inspectable without pretending lexical distance is semantic creativity.
   */
  readonly mechanismTags: ReadonlyArray<string>;
  readonly parentContributionIds?: ReadonlyArray<string>;
};

export type CreativityArtifact = {
  readonly text: string;
  readonly selectedContributionIds: ReadonlyArray<string>;
  readonly mechanismTags: ReadonlyArray<string>;
};

export type CreativityJudgment = {
  readonly judgeId: string;
  readonly judgeFamily: string;
  readonly blinded: boolean;
  readonly scores: {
    readonly originality: number;
    readonly usefulness: number;
    readonly coherence: number;
    readonly constraintSatisfaction: number;
  };
  readonly constraintPass: boolean;
};

export type CreativityTrialRecord = {
  readonly schemaVersion: typeof CREATIVITY_BENCHMARK_SCHEMA_VERSION;
  readonly suiteVersion: string;
  readonly caseId: string;
  readonly condition: CreativityCondition;
  readonly seed: number;
  readonly modelFingerprint: string;
  readonly nodeModelFingerprints?: Readonly<Record<string, string>>;
  readonly promptFingerprint: string;
  readonly contributions: ReadonlyArray<CreativityContribution>;
  readonly finalArtifact: CreativityArtifact;
  readonly judgments: ReadonlyArray<CreativityJudgment>;
  readonly usage?: NodeExecutionUsage;
};

export type CreativityTrialScore = {
  readonly trialId: string;
  readonly caseId: string;
  readonly condition: CreativityCondition;
  readonly seed: number;
  readonly quality: {
    readonly usefulness: number | undefined;
    readonly coherence: number | undefined;
    readonly constraintSatisfaction: number | undefined;
    readonly constraintPassRate: number | undefined;
  };
  readonly novelty: {
    readonly judgedOriginality: number | undefined;
    readonly referenceDistance: number | undefined;
  };
  readonly diversity: {
    readonly explorationSpread: number;
    readonly lexicalVariety: number;
    readonly mechanismCount: number;
    readonly mechanismCoverage: number;
  };
  readonly collaboration: {
    readonly contributingNodes: number;
    readonly selectedNodes: number;
    readonly modelFingerprints: number;
    readonly sourceCoverage: number;
    readonly selectedContributionRate: number;
    readonly crossNodeSynthesis: boolean;
    readonly firstContributionAnchoring: number;
  };
  readonly judgeCoverage: {
    readonly judgments: number;
    readonly blinded: number;
    readonly independentFamilies: number;
  };
  readonly usage?: NodeExecutionUsage;
};

export type CreativityConditionSummary = {
  readonly condition: CreativityCondition;
  readonly trials: number;
  readonly cases: number;
  readonly quality: number | undefined;
  readonly novelty: number | undefined;
  readonly explorationSpread: number;
  readonly mechanismCoverage: number;
  readonly crossNodeSynthesisRate: number;
  readonly meanTokens: number | undefined;
  readonly meanCostUsd: number | undefined;
};

export type CreativityPairedEffect = {
  readonly pairs: number;
  readonly meanBaseline: number;
  readonly meanTreatment: number;
  readonly meanDifference: number;
  readonly medianDifference: number;
  readonly confidenceLevel: 0.95;
  readonly bootstrapConfidenceInterval: readonly [number, number];
  readonly standardizedMeanDifference: number | undefined;
  readonly wins: number;
  readonly ties: number;
  readonly losses: number;
  readonly winRateExcludingTies: number | undefined;
  readonly signFlipPValue: number;
};

export type CreativityPairwisePreference = "baseline" | "treatment" | "tie";

export type CreativityPositionBalancedJudgment = {
  readonly judgeFamily: string;
  readonly order: "baseline-first" | "treatment-first";
  readonly preference: CreativityPairwisePreference;
};

export type CreativityJudgeReliability = {
  readonly judgeFamilies: number;
  readonly completeFamilies: number;
  readonly stableFamilies: number;
  readonly unstableFamilies: number;
  readonly stablePreferences: Readonly<{
    baseline: number;
    treatment: number;
    tie: number;
  }>;
  readonly reliablePreference: CreativityPairwisePreference | undefined;
};

export type CreativityPromptPhase = {
  readonly phase: "explore" | "challenge" | "compose";
  readonly contextPolicy: "task-only" | "shared-prior" | "shared-all";
  readonly instruction: string;
};

export type CreativityPromptProtocol = {
  readonly condition: CreativityCondition;
  readonly phases: ReadonlyArray<CreativityPromptPhase>;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONTRIBUTIONS = 64;
const MAX_TEXT_LENGTH = 24_000;
const MAX_TAGS = 32;
const MAX_JUDGMENTS = 8;

const conditionSet = new Set<string>(CREATIVITY_CONDITIONS);

const assertId = (value: string, label: string): void => {
  if (!ID_PATTERN.test(value)) throw new Error(`${label} is not a bounded identifier`);
};

const assertBoundedText = (value: string, label: string): void => {
  if (!value.trim()) throw new Error(`${label} must not be blank`);
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`${label} exceeds ${MAX_TEXT_LENGTH} characters`);
};

const assertScore = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be between 0 and 100`);
  }
};

const normalizeUsage = (usage: NodeExecutionUsage): NodeExecutionUsage => {
  if (usage.partial) {
    throw new Error("Accepted creativity usage cannot be partial");
  }
  for (const [name, value] of Object.entries(usage)) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`usage.${name} must be a non-negative finite number`);
    }
  }
  if (usage.cachedInputTokens !== undefined
    && usage.inputTokens !== undefined
    && usage.cachedInputTokens > usage.inputTokens) {
    throw new Error("usage.cachedInputTokens cannot exceed usage.inputTokens");
  }
  if (usage.cacheWriteTokens !== undefined
    && usage.inputTokens !== undefined
    && usage.cacheWriteTokens > usage.inputTokens) {
    throw new Error("usage.cacheWriteTokens cannot exceed usage.inputTokens");
  }
  if (usage.totalTokens !== undefined
    && usage.inputTokens !== undefined
    && usage.outputTokens !== undefined
    && usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new Error("usage.totalTokens must equal inputTokens plus outputTokens");
  }
  return Object.freeze({ ...usage });
};

const uniqueStrings = (values: ReadonlyArray<string>, label: string): ReadonlyArray<string> => {
  if (values.length > MAX_TAGS) throw new Error(`${label} exceeds ${MAX_TAGS} entries`);
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value || value.length > 80)) {
    throw new Error(`${label} contains a blank or oversized value`);
  }
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`);
  return Object.freeze([...normalized].sort());
};

export const normalizeCreativityTrial = (record: CreativityTrialRecord): CreativityTrialRecord => {
  if (record.schemaVersion !== CREATIVITY_BENCHMARK_SCHEMA_VERSION) {
    throw new Error(`Unsupported creativity trial schema ${record.schemaVersion}`);
  }
  assertId(record.suiteVersion, "suiteVersion");
  assertId(record.caseId, "caseId");
  if (!conditionSet.has(record.condition)) throw new Error(`Unknown creativity condition ${record.condition}`);
  if (!Number.isSafeInteger(record.seed) || record.seed < 0) throw new Error("seed must be a non-negative integer");
  assertBoundedText(record.modelFingerprint, "modelFingerprint");
  assertBoundedText(record.promptFingerprint, "promptFingerprint");
  if (record.contributions.length === 0 || record.contributions.length > MAX_CONTRIBUTIONS) {
    throw new Error(`contributions must contain 1-${MAX_CONTRIBUTIONS} entries`);
  }

  const contributionIds = new Set<string>();
  const contributions = record.contributions.map((contribution) => {
    assertId(contribution.contributionId, "contributionId");
    assertId(contribution.nodeId, "nodeId");
    if (contributionIds.has(contribution.contributionId)) {
      throw new Error(`Duplicate contribution ${contribution.contributionId}`);
    }
    contributionIds.add(contribution.contributionId);
    if (!Number.isSafeInteger(contribution.round) || contribution.round < 1 || contribution.round > 16) {
      throw new Error(`Contribution ${contribution.contributionId} has an invalid round`);
    }
    assertBoundedText(contribution.text, `Contribution ${contribution.contributionId} text`);
    return Object.freeze({
      ...contribution,
      text: contribution.text.trim(),
      mechanismTags: uniqueStrings(contribution.mechanismTags, `${contribution.contributionId} mechanismTags`),
      ...(contribution.parentContributionIds ? {
        parentContributionIds: uniqueStrings(
          contribution.parentContributionIds,
          `${contribution.contributionId} parentContributionIds`,
        ),
      } : {}),
    });
  }).sort((left, right) => left.round - right.round
    || left.contributionId.localeCompare(right.contributionId));
  const contributingNodeIds = new Set(contributions.map((contribution) => contribution.nodeId));
  const nodeModelFingerprints = record.nodeModelFingerprints
    ? Object.freeze(Object.fromEntries(Object.entries(record.nodeModelFingerprints).map(([nodeId, fingerprint]) => {
        assertId(nodeId, "nodeModelFingerprints nodeId");
        if (!contributingNodeIds.has(nodeId)) {
          throw new Error(`nodeModelFingerprints names non-contributing node ${nodeId}`);
        }
        assertBoundedText(fingerprint, `nodeModelFingerprints.${nodeId}`);
        return [nodeId, fingerprint.trim()];
      })))
    : undefined;
  if (nodeModelFingerprints) {
    const missingNodes = [...contributingNodeIds].filter((nodeId) => !nodeModelFingerprints[nodeId]);
    if (missingNodes.length > 0) {
      throw new Error(`nodeModelFingerprints omits contributing nodes: ${missingNodes.sort().join(", ")}`);
    }
  }

  for (const contribution of contributions) {
    for (const parentId of contribution.parentContributionIds ?? []) {
      if (!contributionIds.has(parentId)) {
        throw new Error(`Contribution ${contribution.contributionId} names unknown parent ${parentId}`);
      }
      if (parentId === contribution.contributionId) {
        throw new Error(`Contribution ${contribution.contributionId} cannot parent itself`);
      }
    }
  }

  assertBoundedText(record.finalArtifact.text, "finalArtifact.text");
  const selectedContributionIds = uniqueStrings(
    record.finalArtifact.selectedContributionIds,
    "finalArtifact.selectedContributionIds",
  );
  if (selectedContributionIds.some((id) => !contributionIds.has(id))) {
    throw new Error("finalArtifact selects an unknown contribution");
  }

  if (record.judgments.length > MAX_JUDGMENTS) {
    throw new Error(`judgments exceeds ${MAX_JUDGMENTS} entries`);
  }
  const judgmentIds = new Set<string>();
  const judgments = record.judgments.map((judgment) => {
    assertId(judgment.judgeId, "judgeId");
    assertId(judgment.judgeFamily, "judgeFamily");
    if (judgmentIds.has(judgment.judgeId)) throw new Error(`Duplicate judgment ${judgment.judgeId}`);
    judgmentIds.add(judgment.judgeId);
    assertScore(judgment.scores.originality, `${judgment.judgeId}.originality`);
    assertScore(judgment.scores.usefulness, `${judgment.judgeId}.usefulness`);
    assertScore(judgment.scores.coherence, `${judgment.judgeId}.coherence`);
    assertScore(judgment.scores.constraintSatisfaction, `${judgment.judgeId}.constraintSatisfaction`);
    return Object.freeze({ ...judgment, scores: Object.freeze({ ...judgment.scores }) });
  }).sort((left, right) => left.judgeId.localeCompare(right.judgeId));

  return Object.freeze({
    ...record,
    contributions: Object.freeze(contributions),
    finalArtifact: Object.freeze({
      text: record.finalArtifact.text.trim(),
      selectedContributionIds,
      mechanismTags: uniqueStrings(record.finalArtifact.mechanismTags, "finalArtifact.mechanismTags"),
    }),
    judgments: Object.freeze(judgments),
    ...(nodeModelFingerprints ? { nodeModelFingerprints } : {}),
    ...(record.usage ? { usage: normalizeUsage(record.usage) } : {}),
  });
};

const tokens = (text: string): ReadonlyArray<string> =>
  text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];

const tokenSet = (text: string): ReadonlySet<string> => new Set(tokens(text));

const jaccardSimilarity = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
};

const lexicalDistance = (left: string, right: string): number =>
  1 - jaccardSimilarity(tokenSet(left), tokenSet(right));

const mean = (values: ReadonlyArray<number>): number | undefined =>
  values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : undefined;

const meanOrZero = (values: ReadonlyArray<number>): number => mean(values) ?? 0;

const pairwiseDistance = (values: ReadonlyArray<string>): number => {
  const distances: number[] = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      distances.push(lexicalDistance(values[left]!, values[right]!));
    }
  }
  return meanOrZero(distances);
};

const averageJudgment = (
  judgments: ReadonlyArray<CreativityJudgment>,
  dimension: keyof CreativityJudgment["scores"],
): number | undefined => mean(judgments.map((judgment) => judgment.scores[dimension]));

export const scoreCreativityTrial = (
  input: CreativityTrialRecord,
  benchmark: CreativityBenchmarkCase,
): CreativityTrialScore => {
  const record = normalizeCreativityTrial(input);
  if (record.caseId !== benchmark.id) {
    throw new Error(`Trial case ${record.caseId} does not match benchmark ${benchmark.id}`);
  }
  const contributionById = new Map(record.contributions.map((contribution) => [
    contribution.contributionId,
    contribution,
  ]));
  const contributingNodes = new Set(record.contributions.map((contribution) => contribution.nodeId));
  const selected = record.finalArtifact.selectedContributionIds
    .map((id) => contributionById.get(id))
    .filter((contribution): contribution is CreativityContribution => Boolean(contribution));
  const selectedNodes = new Set(selected.map((contribution) => contribution.nodeId));
  const exploredMechanisms = new Set(record.contributions.flatMap((contribution) => contribution.mechanismTags));
  const retainedMechanisms = new Set(record.finalArtifact.mechanismTags.filter((tag) => exploredMechanisms.has(tag)));
  const allTokens = tokens(record.finalArtifact.text);
  const first = record.contributions[0]!;
  const later = record.contributions.slice(1);
  const referenceDistances = (benchmark.referenceCorpus ?? []).map((reference) =>
    lexicalDistance(record.finalArtifact.text, reference)
  );

  return Object.freeze({
    trialId: `creativity_trial_${hashCanonical(record).slice(0, 28)}`,
    caseId: record.caseId,
    condition: record.condition,
    seed: record.seed,
    quality: Object.freeze({
      usefulness: averageJudgment(record.judgments, "usefulness"),
      coherence: averageJudgment(record.judgments, "coherence"),
      constraintSatisfaction: averageJudgment(record.judgments, "constraintSatisfaction"),
      constraintPassRate: mean(record.judgments.map((judgment) => judgment.constraintPass ? 1 : 0)),
    }),
    novelty: Object.freeze({
      judgedOriginality: averageJudgment(record.judgments, "originality"),
      referenceDistance: referenceDistances.length > 0 ? Math.min(...referenceDistances) : undefined,
    }),
    diversity: Object.freeze({
      explorationSpread: pairwiseDistance(record.contributions.map((contribution) => contribution.text)),
      lexicalVariety: allTokens.length > 0 ? new Set(allTokens).size / allTokens.length : 0,
      mechanismCount: exploredMechanisms.size,
      mechanismCoverage: exploredMechanisms.size > 0 ? retainedMechanisms.size / exploredMechanisms.size : 0,
    }),
    collaboration: Object.freeze({
      contributingNodes: contributingNodes.size,
      selectedNodes: selectedNodes.size,
      modelFingerprints: new Set(
        Object.values(record.nodeModelFingerprints ?? { default: record.modelFingerprint }),
      ).size,
      sourceCoverage: contributingNodes.size > 0 ? selectedNodes.size / contributingNodes.size : 0,
      selectedContributionRate: record.contributions.length > 0
        ? selected.length / record.contributions.length
        : 0,
      crossNodeSynthesis: selectedNodes.size > 1,
      firstContributionAnchoring: later.length > 0
        ? meanOrZero(later.map((contribution) => 1 - lexicalDistance(first.text, contribution.text)))
        : 0,
    }),
    judgeCoverage: Object.freeze({
      judgments: record.judgments.length,
      blinded: record.judgments.filter((judgment) => judgment.blinded).length,
      independentFamilies: new Set(record.judgments.map((judgment) => judgment.judgeFamily)).size,
    }),
    ...(record.usage ? { usage: record.usage } : {}),
  });
};

const meanDefined = (values: ReadonlyArray<number | undefined>): number | undefined =>
  mean(values.filter((value): value is number => value !== undefined));

const createPrng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const quantile = (values: ReadonlyArray<number>, probability: number): number => {
  if (values.length === 0) throw new Error("quantile requires at least one value");
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
};

const sampleStandardDeviation = (values: ReadonlyArray<number>): number | undefined => {
  if (values.length < 2) return undefined;
  const average = meanOrZero(values);
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(variance);
};

const signFlipPValue = (
  differences: ReadonlyArray<number>,
  random: () => number,
  iterations: number,
): number => {
  const observed = Math.abs(meanOrZero(differences));
  if (observed === 0) return 1;
  const permutations = differences.length <= 20 ? 2 ** differences.length : iterations;
  let asOrMoreExtreme = 0;
  for (let permutation = 0; permutation < permutations; permutation += 1) {
    const flipped = differences.map((difference, index) => {
      const positive = differences.length <= 20
        ? (permutation & (2 ** index)) !== 0
        : random() >= 0.5;
      return positive ? difference : -difference;
    });
    if (Math.abs(meanOrZero(flipped)) + Number.EPSILON >= observed) asOrMoreExtreme += 1;
  }
  return differences.length <= 20
    ? asOrMoreExtreme / permutations
    : (asOrMoreExtreme + 1) / (permutations + 1);
};

/**
 * Summarize matched baseline/treatment observations without collapsing
 * creativity dimensions. The bootstrap resamples pairs, while the permutation
 * test flips the direction of each within-pair difference under the null.
 */
export const estimateCreativityPairedEffect = (
  baseline: ReadonlyArray<number>,
  treatment: ReadonlyArray<number>,
  options: Readonly<{
    bootstrapIterations?: number;
    permutationIterations?: number;
    randomSeed?: number;
    tieTolerance?: number;
  }> = {},
): CreativityPairedEffect => {
  if (baseline.length === 0 || baseline.length !== treatment.length) {
    throw new Error("Paired effects require equally sized, non-empty observations");
  }
  if ([...baseline, ...treatment].some((value) => !Number.isFinite(value))) {
    throw new Error("Paired effects require finite observations");
  }
  const bootstrapIterations = options.bootstrapIterations ?? 10_000;
  const permutationIterations = options.permutationIterations ?? 100_000;
  if (!Number.isSafeInteger(bootstrapIterations) || bootstrapIterations < 1_000) {
    throw new Error("bootstrapIterations must be an integer of at least 1000");
  }
  if (!Number.isSafeInteger(permutationIterations) || permutationIterations < 1_000) {
    throw new Error("permutationIterations must be an integer of at least 1000");
  }
  const random = createPrng(options.randomSeed ?? 0xC0FFEE);
  const differences = treatment.map((value, index) => value - baseline[index]!);
  const bootstrapMeans = Array.from({ length: bootstrapIterations }, () => {
    const sample = Array.from({ length: differences.length }, () =>
      differences[Math.floor(random() * differences.length)]!
    );
    return meanOrZero(sample);
  });
  const tieTolerance = options.tieTolerance ?? 1e-9;
  const wins = differences.filter((difference) => difference > tieTolerance).length;
  const losses = differences.filter((difference) => difference < -tieTolerance).length;
  const ties = differences.length - wins - losses;
  const deviation = sampleStandardDeviation(differences);

  return Object.freeze({
    pairs: differences.length,
    meanBaseline: meanOrZero(baseline),
    meanTreatment: meanOrZero(treatment),
    meanDifference: meanOrZero(differences),
    medianDifference: quantile(differences, 0.5),
    confidenceLevel: 0.95,
    bootstrapConfidenceInterval: Object.freeze([
      quantile(bootstrapMeans, 0.025),
      quantile(bootstrapMeans, 0.975),
    ]) as readonly [number, number],
    standardizedMeanDifference: deviation && deviation > 0
      ? meanOrZero(differences) / deviation
      : undefined,
    wins,
    ties,
    losses,
    winRateExcludingTies: wins + losses > 0 ? wins / (wins + losses) : undefined,
    signFlipPValue: signFlipPValue(differences, random, permutationIterations),
  });
};

/**
 * A judge family is usable only when it expresses the same underlying
 * preference with the baseline first and with the treatment first.
 */
export const assessCreativityJudgeReliability = (
  judgments: ReadonlyArray<CreativityPositionBalancedJudgment>,
): CreativityJudgeReliability => {
  const families = new Map<string, Map<CreativityPositionBalancedJudgment["order"], CreativityPairwisePreference>>();
  for (const judgment of judgments) {
    assertId(judgment.judgeFamily, "judgeFamily");
    const orders = families.get(judgment.judgeFamily) ?? new Map();
    if (orders.has(judgment.order)) {
      throw new Error(`Duplicate ${judgment.order} judgment for ${judgment.judgeFamily}`);
    }
    orders.set(judgment.order, judgment.preference);
    families.set(judgment.judgeFamily, orders);
  }
  const complete = [...families.values()].filter((orders) => orders.size === 2);
  const stable = complete
    .map((orders) => {
      const first = orders.get("baseline-first");
      const second = orders.get("treatment-first");
      return first === second ? first : undefined;
    })
    .filter((preference): preference is CreativityPairwisePreference => preference !== undefined);
  const stablePreferences = Object.freeze({
    baseline: stable.filter((preference) => preference === "baseline").length,
    treatment: stable.filter((preference) => preference === "treatment").length,
    tie: stable.filter((preference) => preference === "tie").length,
  });
  const decisive = (["baseline", "treatment", "tie"] as const)
    .filter((preference) => stablePreferences[preference] > stable.length / 2);

  return Object.freeze({
    judgeFamilies: families.size,
    completeFamilies: complete.length,
    stableFamilies: stable.length,
    unstableFamilies: complete.length - stable.length,
    stablePreferences,
    reliablePreference: decisive.length === 1 ? decisive[0] : undefined,
  });
};

export const summarizeCreativityConditions = (
  scores: ReadonlyArray<CreativityTrialScore>,
): ReadonlyArray<CreativityConditionSummary> => CREATIVITY_CONDITIONS
  .map((condition) => {
    const matching = scores.filter((score) => score.condition === condition);
    if (matching.length === 0) return undefined;
    return Object.freeze({
      condition,
      trials: matching.length,
      cases: new Set(matching.map((score) => score.caseId)).size,
      quality: meanDefined(matching.flatMap((score) => [
        score.quality.usefulness,
        score.quality.coherence,
        score.quality.constraintSatisfaction,
      ])),
      novelty: meanDefined(matching.map((score) => score.novelty.judgedOriginality)),
      explorationSpread: meanOrZero(matching.map((score) => score.diversity.explorationSpread)),
      mechanismCoverage: meanOrZero(matching.map((score) => score.diversity.mechanismCoverage)),
      crossNodeSynthesisRate: meanOrZero(matching.map((score) =>
        score.collaboration.crossNodeSynthesis ? 1 : 0
      )),
      meanTokens: meanDefined(matching.map((score) => score.usage?.totalTokens)),
      meanCostUsd: meanDefined(matching.map((score) => score.usage?.costUsd)),
    });
  })
  .filter((summary): summary is CreativityConditionSummary => Boolean(summary));

const commonCompositionInstruction = [
  "Compose one final artifact that satisfies every hard constraint.",
  "Select ideas because they improve the result, not because most contributors repeated them.",
  "Name the contribution IDs you retained and preserve distinct mechanisms when they are compatible.",
  "Do not claim novelty merely because wording changed.",
].join(" ");

export const CREATIVITY_PROMPT_PROTOCOLS: Readonly<Record<CreativityCondition, CreativityPromptProtocol>> = {
  "solo-neutral": {
    condition: "solo-neutral",
    phases: [{
      phase: "compose",
      contextPolicy: "task-only",
      instruction: "Produce the strongest complete response to the task and its constraints.",
    }],
  },
  "solo-divergent": {
    condition: "solo-divergent",
    phases: [
      {
        phase: "explore",
        contextPolicy: "task-only",
        instruction: [
          "Generate at least four materially different candidates before choosing.",
          "Each candidate must use a different causal mechanism, perspective, structure, or constraint tradeoff.",
          "Label the mechanism; paraphrases and cosmetic variations do not count.",
        ].join(" "),
      },
      {
        phase: "compose",
        contextPolicy: "shared-prior",
        instruction: commonCompositionInstruction,
      },
    ],
  },
  "team-shared-first": {
    condition: "team-shared-first",
    phases: [
      {
        phase: "explore",
        contextPolicy: "shared-all",
        instruction: "Read the current shared ideas, then add the strongest improvement or alternative you can.",
      },
      {
        phase: "compose",
        contextPolicy: "shared-all",
        instruction: commonCompositionInstruction,
      },
    ],
  },
  "team-independent-first": {
    condition: "team-independent-first",
    phases: [
      {
        phase: "explore",
        contextPolicy: "task-only",
        instruction: [
          "Work independently without seeing peer proposals.",
          "Generate at least three candidates from distinct mechanism families.",
          "State the mechanism and the constraint tradeoff for each candidate.",
        ].join(" "),
      },
      {
        phase: "compose",
        contextPolicy: "shared-all",
        instruction: commonCompositionInstruction,
      },
    ],
  },
  "team-independent-challenge": {
    condition: "team-independent-challenge",
    phases: [
      {
        phase: "explore",
        contextPolicy: "task-only",
        instruction: [
          "Work independently without seeing peer proposals.",
          "Generate at least three candidates from distinct mechanism families.",
          "State the mechanism and the constraint tradeoff for each candidate.",
        ].join(" "),
      },
      {
        phase: "challenge",
        contextPolicy: "shared-prior",
        instruction: [
          "Do not rank or summarize the existing proposals.",
          "Create one counterproposal by inversion, analogy from a distant domain, constraint removal, or mechanism combination.",
          "Identify which existing assumption it challenges.",
        ].join(" "),
      },
      {
        phase: "compose",
        contextPolicy: "shared-all",
        instruction: commonCompositionInstruction,
      },
    ],
  },
} as const;

export const buildCreativityPrompt = (
  benchmark: CreativityBenchmarkCase,
  condition: CreativityCondition,
  phase: CreativityPromptPhase["phase"],
): string => {
  const protocol = CREATIVITY_PROMPT_PROTOCOLS[condition];
  const phaseSpec = protocol.phases.find((candidate) => candidate.phase === phase);
  if (!phaseSpec) throw new Error(`Condition ${condition} has no ${phase} phase`);
  return [
    `Task: ${benchmark.prompt}`,
    "Hard constraints:",
    ...benchmark.constraints.map((constraint) => `- ${constraint}`),
    "",
    `Experiment condition: ${condition}`,
    `Context policy: ${phaseSpec.contextPolicy}`,
    phaseSpec.instruction,
  ].join("\n");
};

export const CREATIVITY_STARTER_CASES: ReadonlyArray<CreativityBenchmarkCase> = [
  {
    id: "offline-neighborhood-cooling",
    title: "Offline neighborhood heat response",
    domain: "product-ideation",
    prompt: "Design a neighborhood-scale way to keep isolated residents safer during a three-day heat emergency.",
    constraints: [
      "It must still function when cellular data and mains power are unavailable.",
      "It may assume only ordinary household objects plus a $500 shared budget.",
      "It must protect privacy and avoid publishing residents' medical status.",
      "The final response must include an operating mechanism and one failure-mode mitigation.",
    ],
    referenceCorpus: [
      "Open a public cooling center and call vulnerable residents.",
      "Distribute bottled water and battery-powered fans door to door.",
    ],
  },
  {
    id: "museum-after-closing",
    title: "Museum after closing",
    domain: "creative-writing",
    prompt: "Write a short story in which a museum exhibit changes only after the last visitor leaves.",
    constraints: [
      "Use fewer than 900 words.",
      "Do not explain the change as a dream, hallucination, or computer simulation.",
      "The security guard must make a consequential choice.",
      "End with a concrete sensory image rather than an abstract moral.",
    ],
  },
  {
    id: "broken-bridge-signal",
    title: "Signal across a broken bridge",
    domain: "creative-problem-solving",
    prompt: "A hiking group is split across a damaged bridge at dusk and neither side can cross. Devise ways to communicate an evacuation plan.",
    constraints: [
      "There is no phone or radio service.",
      "Available objects are two flashlights, a foil blanket, rope, chalk, and water bottles.",
      "At least one proposal must work without line of sight.",
      "The final plan must include a method for detecting a misunderstood message.",
    ],
    referenceCorpus: [
      "Use flashlight flashes as Morse code.",
      "Write a message on the ground with chalk.",
    ],
  },
] as const;

export const getCreativityBenchmarkCase = (id: string): CreativityBenchmarkCase | undefined =>
  CREATIVITY_STARTER_CASES.find((benchmark) => benchmark.id === id);
