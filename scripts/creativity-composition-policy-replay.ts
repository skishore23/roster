#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  replayCreativityCompositionPolicy,
  type CreativityCompositionReplayPair,
} from "../src/evals/creativity-composition-policy.js";
import type { CreativityBenchmarkCase } from "../src/evals/creativity-benchmark.js";

type FrozenStudy = {
  readonly cases: ReadonlyArray<CreativityBenchmarkCase>;
  readonly pairs: ReadonlyArray<CreativityCompositionReplayPair>;
};

const inputPath = path.resolve(
  process.argv[2] ?? "artifacts/evals/creativity-comprehensive-2026-07-29.json",
);
const outputPath = path.resolve(
  process.argv[3] ?? "artifacts/evals/creativity-composition-policy-replay-2026-07-29.json",
);
const study = JSON.parse(await fs.readFile(inputPath, "utf8")) as FrozenStudy;
const replay = replayCreativityCompositionPolicy(study);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(replay, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  inputPath,
  outputPath,
  evaluatedPairs: replay.evaluatedPairs,
  acceptedTreatmentPairs: replay.acceptedTreatmentPairs,
  baselineFallbackPairs: replay.baselineFallbackPairs,
  noQualifiedOutputPairs: replay.noQualifiedOutputPairs,
  preventedQualityRegressions: replay.preventedQualityRegressions,
  preventedConstraintRegressions: replay.preventedConstraintRegressions,
  quality: replay.selectedPolicyQualityEffect,
  originality: replay.selectedPolicyOriginalityEffect,
}, null, 2));
