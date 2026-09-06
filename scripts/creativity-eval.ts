#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  CREATIVITY_CONDITIONS,
  CREATIVITY_PROMPT_PROTOCOLS,
  CREATIVITY_STARTER_CASES,
  buildCreativityPrompt,
  getCreativityBenchmarkCase,
  scoreCreativityTrial,
  summarizeCreativityConditions,
  type CreativityBenchmarkCase,
  type CreativityCondition,
  type CreativityTrialRecord,
} from "../src/evals/creativity-benchmark.js";

const DEFAULT_INPUT = "fixtures/evals/creativity-demo.json";

const parseArgs = (argv: ReadonlyArray<string>): Readonly<Record<string, string | boolean>> => {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
};

const stringFlag = (
  flags: Readonly<Record<string, string | boolean>>,
  key: string,
): string | undefined => typeof flags[key] === "string" ? flags[key] : undefined;

const usage = (): string => [
  "npm run eval:creativity",
  "npm run eval:creativity -- --input <json-or-jsonl> [--json]",
  "npm run eval:creativity -- --prompts [--case <id>] [--condition <condition>]",
  "",
  "Conditions:",
  ...CREATIVITY_CONDITIONS.map((condition) => `- ${condition}`),
  "",
  "Starter cases:",
  ...CREATIVITY_STARTER_CASES.map((benchmark) => `- ${benchmark.id}: ${benchmark.title}`),
].join("\n");

type CreativityInput = {
  readonly records: ReadonlyArray<CreativityTrialRecord>;
  readonly benchmark?: CreativityBenchmarkCase;
};

const parseInput = (content: string): CreativityInput => {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Creativity input is empty");
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as ReadonlyArray<CreativityTrialRecord>;
    if (!Array.isArray(parsed)) throw new Error("Creativity JSON input must be an array");
    return { records: parsed };
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as CreativityInput;
      if (Array.isArray(parsed.records)) return parsed;
    } catch {
      // A JSONL file also starts with "{", so fall through to per-line parsing.
    }
  }
  return {
    records: trimmed.split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as CreativityTrialRecord),
  };
};

const asCondition = (value: string | undefined): CreativityCondition | undefined => {
  if (value === undefined) return undefined;
  if (!CREATIVITY_CONDITIONS.some((condition) => condition === value)) {
    throw new Error(`Unknown creativity condition ${value}`);
  }
  return value;
};

const printPrompts = (
  caseId: string | undefined,
  requestedCondition: CreativityCondition | undefined,
): void => {
  const cases = caseId
    ? [getCreativityBenchmarkCase(caseId)].filter((item) => item !== undefined)
    : CREATIVITY_STARTER_CASES;
  if (cases.length === 0) throw new Error(`Unknown creativity case ${caseId}`);
  const conditions = requestedCondition ? [requestedCondition] : CREATIVITY_CONDITIONS;
  for (const benchmark of cases) {
    for (const condition of conditions) {
      for (const phase of CREATIVITY_PROMPT_PROTOCOLS[condition].phases) {
        console.log(`\n# ${benchmark.id} / ${condition} / ${phase.phase}`);
        console.log(buildCreativityPrompt(benchmark, condition, phase.phase));
      }
    }
  }
};

const displayNumber = (value: number | undefined): string =>
  value === undefined ? "n/a" : value.toFixed(3);

const main = async (): Promise<void> => {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  const requestedCondition = asCondition(stringFlag(flags, "condition"));
  if (flags.prompts) {
    printPrompts(stringFlag(flags, "case"), requestedCondition);
    return;
  }

  const inputPath = path.resolve(stringFlag(flags, "input") ?? DEFAULT_INPUT);
  const input = parseInput(await fs.readFile(inputPath, "utf8"));
  const filtered = input.records.filter((record) =>
    (!stringFlag(flags, "case") || record.caseId === stringFlag(flags, "case"))
    && (!requestedCondition || record.condition === requestedCondition)
  );
  if (filtered.length === 0) throw new Error("No creativity trials matched the requested filters");
  const scores = filtered.map((record) => {
    const benchmark = input.benchmark?.id === record.caseId
      ? input.benchmark
      : getCreativityBenchmarkCase(record.caseId);
    if (!benchmark) throw new Error(`Unknown creativity case ${record.caseId}`);
    return scoreCreativityTrial(record, benchmark);
  });
  const summaries = summarizeCreativityConditions(scores);

  if (flags.json) {
    console.log(JSON.stringify({ inputPath, scores, summaries }, null, 2));
    return;
  }

  console.log(`Creativity evaluation: ${scores.length} trial(s) from ${inputPath}`);
  console.log("condition                      trials quality novelty spread coverage synthesis tokens cost");
  for (const summary of summaries) {
    console.log([
      summary.condition.padEnd(30),
      String(summary.trials).padStart(6),
      displayNumber(summary.quality).padStart(7),
      displayNumber(summary.novelty).padStart(7),
      displayNumber(summary.explorationSpread).padStart(6),
      displayNumber(summary.mechanismCoverage).padStart(8),
      displayNumber(summary.crossNodeSynthesisRate).padStart(9),
      displayNumber(summary.meanTokens).padStart(6),
      displayNumber(summary.meanCostUsd).padStart(5),
    ].join(" "));
  }
  console.log("\nQuality, novelty, and diversity remain separate; this command does not emit a single creativity score.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
