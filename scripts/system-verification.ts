import {
  campaignVerificationEnvironment,
  createKernelRobustnessScenario,
  runSystemVerification,
} from "../src/simulations/system-verification.js";
import type { CoordinationPattern } from "../src/simulations/campaign.js";
import { createCodingRuntimeDiscoveryRegistry } from "../src/engine/runtime/coding-runtime-discovery.js";
import {
  commandRuntimeVerificationEnvironment,
  codingJobVerificationEnvironment,
  createCodingJobRobustnessScenario,
  createDesktopRobustnessScenario,
  createLiveRuntimeCanaryScenario,
  createRuntimeRobustnessScenario,
  createPersistenceRobustnessScenario,
  createRepositoryRobustnessScenario,
  createWorkspaceRobustnessScenario,
  desktopSidecarVerificationEnvironment,
  liveRuntimeVerificationEnvironment,
  sharedWorkspaceVerificationEnvironment,
  spacetimePersistenceVerificationEnvironment,
  gitRepositoryVerificationEnvironment,
} from "../src/simulations/production-boundary-verification.js";

const patterns: ReadonlyArray<CoordinationPattern> = [
  "collaboration",
  "adaptive",
  "fanout",
  "hierarchy",
  "pipeline",
];

const evidence = [];
const liveRuntimeFailures: Array<{
  readonly runtimeKind: string;
  readonly error: string;
}> = [];
for (const pattern of patterns) {
  const scenario = createKernelRobustnessScenario({
    pattern,
    workerNodes: 12,
    maxParallel: 6,
    schedules: 6,
    injectTaskFailure: true,
  });
  evidence.push(await runSystemVerification(scenario, campaignVerificationEnvironment));
}
evidence.push(await runSystemVerification(
  createRuntimeRobustnessScenario(),
  commandRuntimeVerificationEnvironment,
));
evidence.push(await runSystemVerification(
  createWorkspaceRobustnessScenario(),
  sharedWorkspaceVerificationEnvironment,
));
evidence.push(await runSystemVerification(
  createRepositoryRobustnessScenario(),
  gitRepositoryVerificationEnvironment,
));
evidence.push(await runSystemVerification(
  createCodingJobRobustnessScenario(),
  codingJobVerificationEnvironment,
));
if (process.env.SPACETIMEDB_URI && process.env.SPACETIMEDB_DATABASE) {
  evidence.push(await runSystemVerification(
    createPersistenceRobustnessScenario(),
    spacetimePersistenceVerificationEnvironment,
  ));
  evidence.push(await runSystemVerification(
    createDesktopRobustnessScenario(),
    desktopSidecarVerificationEnvironment,
  ));
}
if (process.env.ROSTER_LIVE_RUNTIME_CANARY === "1") {
  const requestedKind = process.env.ROSTER_LIVE_RUNTIME_KIND?.trim() || "codex-cli";
  const supportedKinds = [
    "codex-cli",
    "claude-code",
    "pi-agent",
    "hermes-agent",
  ] as const;
  const selectedRequestedKind = supportedKinds.find((kind) => kind === requestedKind);
  if (
    requestedKind !== "all"
    && !selectedRequestedKind
  ) {
    throw new Error(
      "ROSTER_LIVE_RUNTIME_KIND must be all, codex-cli, claude-code, pi-agent, or hermes-agent",
    );
  }
  const discovered = await createCodingRuntimeDiscoveryRegistry().discover();
  const maxTotalTokens = process.env.ROSTER_LIVE_RUNTIME_MAX_TOKENS
    ? Number(process.env.ROSTER_LIVE_RUNTIME_MAX_TOKENS)
    : undefined;
  const requestedKinds: ReadonlyArray<(typeof supportedKinds)[number]> = requestedKind === "all"
    ? supportedKinds
    : [selectedRequestedKind!];
  for (const runtimeKind of requestedKinds) {
    const selected = discovered.find((runtime) => runtime.descriptor.id === runtimeKind);
    if (!selected?.ready || !selected.executablePath) {
      throw new Error(`Live runtime canary requires a ready ${runtimeKind} installation`);
    }
    const overridePrefix = `ROSTER_LIVE_RUNTIME_${runtimeKind.replaceAll("-", "_").toUpperCase()}`;
    const provider = process.env[`${overridePrefix}_PROVIDER`]?.trim();
    const model = process.env[`${overridePrefix}_MODEL`]?.trim();
    try {
      evidence.push(await runSystemVerification(
        createLiveRuntimeCanaryScenario({
          runtimeKind,
          command: [
            selected.executablePath,
            ...selected.descriptor.command.slice(1),
          ],
          ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        }),
        liveRuntimeVerificationEnvironment,
      ));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      liveRuntimeFailures.push({
        runtimeKind,
        error: detail.length > 2_000 ? `${detail.slice(0, 2_000)}…` : detail,
      });
    }
  }
}

const summary = {
  schemaVersion: "roster.system-verification-summary.v1",
  passed: liveRuntimeFailures.length === 0 && evidence.every((item) => item.passed),
  coveredLayers: [...new Set(evidence.map((item) => item.scenario.layer))].sort(),
  missingLayers: [
    "kernel",
    "runtime",
    "workspace",
    "persistence",
    "repository",
    "coding",
    "continuity",
    "desktop",
    "live-runtime",
  ].filter((layer) => !evidence.some((item) => item.scenario.layer === layer)),
  scenarios: [
    ...evidence.map((item) => ({
      scenarioId: item.scenario.id,
      environmentId: item.observation.environmentId,
      evidenceId: item.evidenceId,
      passed: item.passed,
      failedInvariants: item.invariants
        .filter((invariant) => !invariant.passed)
        .map((invariant) => invariant.id),
      ...(item.observation.liveRuntime
        ? { liveRuntime: item.observation.liveRuntime }
        : {}),
    })),
    ...liveRuntimeFailures.map((failure) => ({
      scenarioId: `live-runtime-${failure.runtimeKind}`,
      environmentId: "live-runtime-protocol-boundary",
      passed: false,
      failedInvariants: ["live-runtime-execution"],
      error: failure.error,
    })),
  ],
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;
