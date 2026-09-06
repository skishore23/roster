import {
  COORDINATION_PATTERNS,
  runSimulationCampaign,
  type CoordinationPattern,
} from "../src/simulations/campaign.js";

const parseArgs = (args: ReadonlyArray<string>) => {
  const values = new Map<string, string>();
  let injectFaults = false;
  const valueOptions = new Set(["--pattern", "--agents", "--parallel", "--schedules", "--seed"]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--faults") {
      if (injectFaults) throw new Error("Duplicate option --faults");
      injectFaults = true;
      continue;
    }
    if (!option || !valueOptions.has(option)) throw new Error(`Unknown simulation option ${option ?? ""}`.trim());
    if (values.has(option)) throw new Error(`Duplicate option ${option}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    values.set(option, value);
    index += 1;
  }

  const integer = (name: string, fallback: number, minimum: number, maximum: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
    return parsed;
  };
  const patternValue = values.get("--pattern") ?? "collaboration";
  const pattern = COORDINATION_PATTERNS.find((candidate) => candidate.id === patternValue)?.id;
  if (!pattern) {
    throw new Error(`--pattern must be one of ${COORDINATION_PATTERNS.map((candidate) => candidate.id).join(", ")}`);
  }
  const minimumAgents = pattern === "collaboration" ? 6 : 2;
  const agents = integer("--agents", 12, minimumAgents, 128);
  const maxParallel = integer("--parallel", 6, 1, 32);
  if (maxParallel > agents) throw new Error("--parallel must not exceed --agents");
  return {
    pattern: pattern as CoordinationPattern,
    agents,
    maxParallel,
    schedules: integer("--schedules", 6, 1, 20),
    seed: integer("--seed", 0x51f15e, 0, 0xffff_ffff),
    injectFaults,
  };
};

const run = async (): Promise<void> => {
  const report = await runSimulationCampaign(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (!report.summary.converged) process.exitCode = 1;
};

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
