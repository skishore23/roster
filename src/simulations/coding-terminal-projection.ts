import {
  RecordingEntropySource,
  ReplayingEntropySource,
  type EntropySource,
} from "determined";

import { hashCanonical } from "../core/canonical.js";
import {
  codingDeliveryState,
  codingTerminalOutcome,
  type CodingDeliveryJob,
  type CodingDeliveryState,
  type CodingTerminalOutcome,
} from "../domains/coding-terminal.js";

export type CodingTerminalProjectionInvariant = {
  readonly id: string;
  readonly passed: boolean;
  readonly evidence: string;
};

export type CodingTerminalProjectionSimulationReport = {
  readonly input: CodingTerminalProjectionSimulationInput;
  readonly caseCount: number;
  readonly scheduleCount: number;
  readonly scheduleVariants: number;
  readonly entropyDraws: number;
  readonly injectedFaults: number;
  readonly modeledFaultCases: number;
  readonly prefixObservations: number;
  readonly projectionRestarts: number;
  readonly sameVersionConflicts: number;
  readonly exhaustiveCombinations: number;
  readonly exactReplays: number;
  readonly digest: string;
  readonly invariants: ReadonlyArray<CodingTerminalProjectionInvariant>;
  readonly passed: boolean;
};

export type CodingTerminalProjectionSimulationInput = {
  readonly schedules: number;
  readonly seed: number;
  readonly injectFaults: boolean;
};

type ProjectionCase = {
  readonly id: string;
  readonly graphComplete: boolean;
  readonly graphFailed: boolean;
  readonly certified: boolean;
  readonly readOnlyComplete?: boolean;
  readonly job?: CodingDeliveryJob;
  readonly expectedState: CodingTerminalOutcome["state"];
  readonly expectedLabel: string;
  readonly expectedDelivery: CodingDeliveryState;
  readonly terminal: boolean;
  readonly injectedFault?: boolean;
};

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const active = (status: CodingDeliveryJob["status"]): CodingDeliveryJob => ({ status });

const cases: ReadonlyArray<ProjectionCase> = [
  {
    id: "active-certified-boundary",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("running"), leaseUntil: 10_000 },
    expectedState: "working",
    expectedLabel: "Finalizing delivery",
    expectedDelivery: "working",
    terminal: false,
  },
  {
    id: "expired-running-certified-boundary",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("running"), leaseUntil: 0 },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "expired-leased-certified-boundary",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("leased"), leaseUntil: 0 },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-no-changes",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("completed"), noChanges: true },
    expectedState: "completed",
    expectedLabel: "Completed",
    expectedDelivery: "no-changes",
    terminal: true,
  },
  {
    id: "completed-integrated",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("completed"), commit, integration: { integrated: true, canIntegrate: false } },
    expectedState: "completed",
    expectedLabel: "Merged",
    expectedDelivery: "integrated",
    terminal: true,
  },
  {
    id: "completed-kept-branch",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: {
      ...active("completed"),
      commit,
      deliveryDisposition: {
        action: "keep-branch",
        commit,
      },
    },
    expectedState: "completed",
    expectedLabel: "Closed · branch kept",
    expectedDelivery: "kept-branch",
    terminal: true,
  },
  {
    id: "completed-ready-to-merge",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("completed"), commit, integration: { integrated: false, canIntegrate: true } },
    expectedState: "waiting",
    expectedLabel: "Ready to merge",
    expectedDelivery: "ready",
    terminal: true,
  },
  {
    id: "failed-certified-handoff",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("failed"), commit },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "canceled-certified-handoff",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("canceled"), commit },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-missing-handoff",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("completed"), commit },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "unavailable",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-ambiguous-handoff",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: {
      ...active("completed"),
      commit,
      integration: { integrated: false, canIntegrate: false },
    },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "unavailable",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-missing-job-projection",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "unavailable",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-read-only-report-without-job",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    readOnlyComplete: true,
    expectedState: "completed",
    expectedLabel: "Completed",
    expectedDelivery: "no-changes",
    terminal: true,
  },
  {
    id: "failed-before-certification",
    graphComplete: false,
    graphFailed: true,
    certified: false,
    job: active("failed"),
    expectedState: "failed",
    expectedLabel: "Failed",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "canceled-before-certification",
    graphComplete: false,
    graphFailed: true,
    certified: false,
    job: active("canceled"),
    expectedState: "failed",
    expectedLabel: "Failed",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "failed-with-stale-no-change-success",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("failed"), noChanges: true },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "failed-with-stale-integrated-success",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("failed"), commit, integration: { integrated: true, canIntegrate: false } },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "canceled-with-stale-ready-success",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("canceled"), commit, integration: { integrated: false, canIntegrate: true } },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-conflicting-no-change-and-commit",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("completed"), noChanges: true, commit, integration: { integrated: false, canIntegrate: true } },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "unavailable",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-integrated-without-commit",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("completed"), integration: { integrated: true, canIntegrate: false } },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "unavailable",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-contradictory-integration-flags",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("completed"), commit, integration: { integrated: true, canIntegrate: true } },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "unavailable",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "completed-mismatched-kept-branch-commit",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("completed"), commit, deliveryDisposition: { action: "keep-branch", commit: otherCommit } },
    expectedState: "failed",
    expectedLabel: "Needs attention",
    expectedDelivery: "unavailable",
    terminal: true,
    injectedFault: true,
  },
  {
    id: "active-job-ignores-stale-success",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("running"), commit, integration: { integrated: true, canIntegrate: false } },
    expectedState: "working",
    expectedLabel: "Finalizing delivery",
    expectedDelivery: "working",
    terminal: false,
  },
  {
    id: "failed-rescan-ignores-stale-success",
    graphComplete: true,
    graphFailed: false,
    certified: true,
    job: { ...active("failed"), runKind: "workspace-rescan", noChanges: true },
    expectedState: "failed",
    expectedLabel: "Failed",
    expectedDelivery: "blocked",
    terminal: true,
    injectedFault: true,
  },
];

type ProjectionEvidence =
  | { readonly kind: "graph"; readonly version: number; readonly complete: boolean; readonly failed: boolean }
  | { readonly kind: "certification"; readonly version: number; readonly certified: boolean; readonly readOnlyComplete: boolean }
  | { readonly kind: "job"; readonly version: number; readonly job?: CodingDeliveryJob };

type ProjectionInput = Omit<Parameters<typeof codingTerminalOutcome>[0], "now" | "evidenceConflict">;

type ProjectionAccumulator = {
  readonly input: ProjectionInput;
  readonly versions: Readonly<Record<ProjectionEvidence["kind"], number>>;
  readonly fingerprints: Readonly<Partial<Record<ProjectionEvidence["kind"], string>>>;
  readonly conflicts: Readonly<Record<ProjectionEvidence["kind"], boolean>>;
};

const initialAccumulator = (): ProjectionAccumulator => ({
  input: { graphComplete: false, graphFailed: false, certified: false },
  versions: { graph: -1, certification: -1, job: -1 },
  fingerprints: {},
  conflicts: { graph: false, certification: false, job: false },
});

const reduceEvidence = (
  projection: ProjectionAccumulator,
  entry: ProjectionEvidence,
): ProjectionAccumulator => {
  if (entry.version < projection.versions[entry.kind]) return projection;
  const fingerprint = hashCanonical(entry);
  if (entry.version === projection.versions[entry.kind]) {
    if (projection.fingerprints[entry.kind] === fingerprint) return projection;
    return {
      ...projection,
      conflicts: { ...projection.conflicts, [entry.kind]: true },
    };
  }
  const versions = { ...projection.versions, [entry.kind]: entry.version };
  const fingerprints = { ...projection.fingerprints, [entry.kind]: fingerprint };
  const conflicts = { ...projection.conflicts, [entry.kind]: false };
  if (entry.kind === "graph") {
    return {
      input: { ...projection.input, graphComplete: entry.complete, graphFailed: entry.failed },
      versions,
      fingerprints,
      conflicts,
    };
  }
  if (entry.kind === "certification") {
    return {
      input: {
        ...projection.input,
        certified: entry.certified,
        readOnlyComplete: entry.readOnlyComplete,
      },
      versions,
      fingerprints,
      conflicts,
    };
  }
  return {
    input: { ...projection.input, job: entry.job },
    versions,
    fingerprints,
    conflicts,
  };
};

const currentEvidence = (candidate: ProjectionCase): ReadonlyArray<ProjectionEvidence> => [
    { kind: "graph", version: 3, complete: candidate.graphComplete, failed: candidate.graphFailed },
    {
      kind: "certification",
      version: 3,
      certified: candidate.certified,
      readOnlyComplete: Boolean(candidate.readOnlyComplete),
    },
    { kind: "job", version: 3, job: candidate.job },
];

const staleEvidence: ReadonlyArray<ProjectionEvidence> = [
    { kind: "graph", version: 1, complete: false, failed: false },
    { kind: "certification", version: 1, certified: false, readOnlyComplete: false },
    { kind: "job", version: 1, job: { ...active("running"), leaseUntil: 2 } },
];

const conflictingEvidence = (
  kind: ProjectionEvidence["kind"],
): readonly [ProjectionEvidence, ProjectionEvidence] => {
  if (kind === "graph") {
    return [
      { kind, version: 2, complete: false, failed: false },
      { kind, version: 2, complete: true, failed: true },
    ];
  }
  if (kind === "certification") {
    return [
      { kind, version: 2, certified: false, readOnlyComplete: false },
      { kind, version: 2, certified: true, readOnlyComplete: false },
    ];
  }
  return [
    { kind, version: 2, job: { ...active("running"), leaseUntil: 2 } },
    { kind, version: 2, job: { ...active("leased"), leaseUntil: 2 } },
  ];
};

class SeededEntropySource implements EntropySource {
  private state: number;

  constructor(seed: number) {
    const unsigned = seed >>> 0;
    const mixed = (Math.imul(unsigned ^ (unsigned >>> 16), 0x85ebca6b) + 0x9e3779b9) >>> 0;
    this.state = mixed === 0 ? 0x6d2b79f5 : mixed;
  }

  random(_reason: string): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

const entropyInteger = (entropy: EntropySource, reason: string, maximum: number): number =>
  Math.floor(entropy.random(reason) * maximum);

const shuffle = <T>(values: ReadonlyArray<T>, entropy: EntropySource, reason: string): T[] => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = entropyInteger(entropy, `${reason}:${index}`, index + 1);
    [result[index], result[selected]] = [result[selected] as T, result[index] as T];
  }
  return result;
};

type ScheduleRun = {
  readonly rows: ReadonlyArray<{
    readonly caseId: string;
    readonly state?: CodingTerminalOutcome["state"];
    readonly label?: string;
    readonly delivery?: CodingDeliveryState;
    readonly expectedState: CodingTerminalOutcome["state"];
    readonly expectedLabel: string;
    readonly expectedDelivery: CodingDeliveryState;
    readonly terminal: boolean;
    readonly modeledFault: boolean;
  }>;
  readonly trace: ReadonlyArray<unknown>;
  readonly injectedFaults: number;
  readonly prefixObservations: number;
  readonly projectionRestarts: number;
  readonly sameVersionConflicts: number;
  readonly conflictsVisible: boolean;
  readonly prefixSuccessesAuthorized: boolean;
  readonly expiredLeasesNeverFinalize: boolean;
};

const runEntropySchedule = (
  entropy: EntropySource,
  injectFaults: boolean,
  scheduleIndex: number,
): ScheduleRun => {
  const rows: ScheduleRun["rows"][number][] = [];
  const trace: unknown[] = [];
  let injectedFaults = 0;
  let prefixObservations = 0;
  let projectionRestarts = 0;
  let sameVersionConflicts = 0;
  let conflictsVisible = true;
  let prefixSuccessesAuthorized = true;
  let expiredLeasesNeverFinalize = true;

  for (const candidate of cases) {
    const current = shuffle(currentEvidence(candidate), entropy, `terminal:${scheduleIndex}:${candidate.id}:current`);
    const delivered: ProjectionEvidence[] = [];
    const restartCandidates = new Set<number>();
    if (injectFaults) {
      const staleStart = entropyInteger(entropy, `terminal:${scheduleIndex}:${candidate.id}:stale`, staleEvidence.length);
      const selectedStale = [
        staleEvidence[staleStart],
        ...staleEvidence.filter((_entry, index) => index !== staleStart
          && entropy.random(`terminal:${scheduleIndex}:${candidate.id}:stale:${index}`) < 0.5),
      ].filter((entry): entry is ProjectionEvidence => Boolean(entry));
      const conflictKind = (["graph", "certification", "job"] as const)[
        entropyInteger(entropy, `terminal:${scheduleIndex}:${candidate.id}:conflict-kind`, 3)
      ] ?? "job";
      const conflict = conflictingEvidence(conflictKind);
      const duplicateIndex = entropyInteger(
        entropy,
        `terminal:${scheduleIndex}:${candidate.id}:duplicate-kind`,
        current.length,
      );
      delivered.push(...shuffle(selectedStale, entropy, `terminal:${scheduleIndex}:${candidate.id}:fault-prefix`));
      delivered.push(...conflict);
      delivered.push(...current.flatMap((entry, index) => index === duplicateIndex ? [entry, entry] : [entry]));
      const restartCount = 1 + entropyInteger(
        entropy,
        `terminal:${scheduleIndex}:${candidate.id}:restart-count`,
        2,
      );
      for (let attempt = 0; restartCandidates.size < restartCount; attempt += 1) {
        restartCandidates.add(1 + entropyInteger(
          entropy,
          `terminal:${scheduleIndex}:${candidate.id}:restart:${attempt}`,
          delivered.length,
        ));
      }
      injectedFaults += selectedStale.length + 1 + 1 + restartCandidates.size;
    } else {
      delivered.push(...current);
    }

    let projection = initialAccumulator();
    let now = 0;
    for (let index = 0; index < delivered.length; index += 1) {
      now += 1 + entropyInteger(entropy, `terminal:${scheduleIndex}:${candidate.id}:delay:${index}`, 4);
      const previouslyConflicted = Object.values(projection.conflicts).some(Boolean);
      projection = reduceEvidence(projection, delivered[index] as ProjectionEvidence);
      if (restartCandidates.has(index + 1)) {
        projection = JSON.parse(JSON.stringify(projection)) as ProjectionAccumulator;
        projectionRestarts += 1;
      }
      const evidenceConflict = Object.values(projection.conflicts).some(Boolean);
      const outcome = codingTerminalOutcome({ ...projection.input, now, evidenceConflict });
      prefixObservations += 1;
      if (evidenceConflict) {
        if (!previouslyConflicted) sameVersionConflicts += 1;
        conflictsVisible &&= outcome?.state === "failed"
          && outcome.label === "Needs attention"
          && outcome.delivery === "unavailable";
      }
      const successful = outcome?.state === "completed" || outcome?.state === "waiting";
      if (successful) {
        const currentJobAuthorizes = projection.versions.job === 3
          && projection.input.job?.status === "completed";
        const currentReadOnlyAuthorizes = projection.versions.graph === 3
          && projection.versions.certification === 3
          && projection.input.graphComplete
          && projection.input.readOnlyComplete === true;
        prefixSuccessesAuthorized &&= currentJobAuthorizes || currentReadOnlyAuthorizes;
      }
      if (outcome?.label === "Finalizing delivery"
        && projection.input.job?.leaseUntil !== undefined
        && projection.input.job.leaseUntil <= now) {
        expiredLeasesNeverFinalize = false;
      }
      trace.push({
        caseId: candidate.id,
        index,
        now,
        kind: delivered[index]?.kind,
        version: delivered[index]?.version,
        fingerprint: hashCanonical(delivered[index]),
        restarted: restartCandidates.has(index + 1),
        conflict: evidenceConflict,
        outcome,
      });
    }
    const outcome = codingTerminalOutcome({ ...projection.input, now });
    rows.push({
      caseId: candidate.id,
      state: outcome?.state,
      label: outcome?.label,
      delivery: outcome?.delivery,
      expectedState: candidate.expectedState,
      expectedLabel: candidate.expectedLabel,
      expectedDelivery: candidate.expectedDelivery,
      terminal: candidate.terminal,
      modeledFault: Boolean(candidate.injectedFault),
    });
  }
  return {
    rows,
    trace,
    injectedFaults,
    prefixObservations,
    projectionRestarts,
    sameVersionConflicts,
    conflictsVisible,
    prefixSuccessesAuthorized,
    expiredLeasesNeverFinalize,
  };
};

const exhaustiveStatuses: ReadonlyArray<CodingDeliveryJob["status"]> = [
  "queued", "leased", "running", "completed", "failed", "canceled",
];
const exhaustiveMetadata: ReadonlyArray<{
  readonly id: string;
  readonly value: Omit<CodingDeliveryJob, "status">;
  readonly contradictory?: boolean;
}> = [
  { id: "empty", value: {} },
  { id: "no-changes", value: { noChanges: true } },
  { id: "commit-only", value: { commit } },
  { id: "ready", value: { commit, integration: { integrated: false, canIntegrate: true } } },
  { id: "integrated", value: { commit, integration: { integrated: true, canIntegrate: false } } },
  { id: "blocked", value: { commit, integration: { integrated: false, canIntegrate: false, reason: "target moved" } } },
  { id: "kept", value: { commit, deliveryDisposition: { action: "keep-branch", commit } } },
  { id: "no-change-plus-ready", value: { noChanges: true, commit, integration: { integrated: false, canIntegrate: true } }, contradictory: true },
  { id: "integrated-without-commit", value: { integration: { integrated: true, canIntegrate: false } }, contradictory: true },
  { id: "dual-integration", value: { commit, integration: { integrated: true, canIntegrate: true } }, contradictory: true },
  { id: "mismatched-disposition", value: { commit, deliveryDisposition: { action: "keep-branch", commit: otherCommit } }, contradictory: true },
];
const exhaustiveGraphStates = [
  { graphComplete: false, graphFailed: false },
  { graphComplete: true, graphFailed: false },
  { graphComplete: false, graphFailed: true },
  { graphComplete: true, graphFailed: true },
] as const;

export const runCodingTerminalProjectionSimulation = (
  rawInput: Partial<CodingTerminalProjectionSimulationInput> = {},
): CodingTerminalProjectionSimulationReport => {
  const input: CodingTerminalProjectionSimulationInput = {
    schedules: Math.max(1, Math.min(64, Math.floor(rawInput.schedules ?? 12))),
    seed: Math.max(0, Math.min(0xffff_ffff, Math.floor(rawInput.seed ?? 0x7e2d_91c3))) >>> 0,
    injectFaults: rawInput.injectFaults ?? true,
  };
  const scheduleRuns: ScheduleRun[] = [];
  const scheduleDigests = new Set<string>();
  let entropyDraws = 0;
  let exactReplays = 0;
  for (let scheduleIndex = 0; scheduleIndex < input.schedules; scheduleIndex += 1) {
    const seed = (input.seed + Math.imul(scheduleIndex, 0x9e37_79b1)) >>> 0;
    const recording = new RecordingEntropySource(new SeededEntropySource(seed));
    const first = runEntropySchedule(recording, input.injectFaults, scheduleIndex);
    const records = recording.getRecords();
    const replaySource = new ReplayingEntropySource(records);
    let replayDraws = 0;
    const replayEntropy: EntropySource = {
      random: (reason) => {
        replayDraws += 1;
        return replaySource.random(reason);
      },
    };
    const replay = runEntropySchedule(replayEntropy, input.injectFaults, scheduleIndex);
    if (replayDraws === records.length && hashCanonical(first) === hashCanonical(replay)) exactReplays += 1;
    entropyDraws += records.length;
    scheduleRuns.push(first);
    scheduleDigests.add(hashCanonical(first.trace));
  }

  const observations = scheduleRuns.flatMap((run) => run.rows);
  const exactExpected = observations.every((observation) =>
    observation.state === observation.expectedState
    && observation.label === observation.expectedLabel
    && observation.delivery === observation.expectedDelivery);
  const terminalNeverLooksActive = observations.every((observation) => !observation.terminal
    || (observation.state !== "working" && observation.label !== "Finalizing delivery"));
  const faultsStayVisible = observations.every((observation) => !observation.modeledFault
    || observation.state === "failed");
  const finalizingIsBounded = observations.every((observation) => observation.label !== "Finalizing delivery"
    || !observation.terminal);
  const prefixSuccessesAuthorized = scheduleRuns.every((run) => run.prefixSuccessesAuthorized);
  const conflictsStayVisibleAcrossPrefixes = scheduleRuns.every((run) => run.conflictsVisible);
  const expiredLeasesNeverFinalize = scheduleRuns.every((run) => run.expiredLeasesNeverFinalize);
  const exhaustive = exhaustiveStatuses.flatMap((status) => exhaustiveMetadata.flatMap((metadata) =>
    exhaustiveGraphStates.flatMap((graph) => [false, true].map((certified) => {
      const job: CodingDeliveryJob = { status, ...metadata.value };
      return {
        status,
        metadataId: metadata.id,
        contradictory: Boolean(metadata.contradictory),
        certified,
        graph,
        delivery: codingDeliveryState(job),
        outcome: codingTerminalOutcome({ ...graph, certified, job }),
      };
    }))));
  const failureAlwaysWins = exhaustive.every((row) => !["failed", "canceled"].includes(row.status)
    || (row.delivery === "blocked" && row.outcome?.state === "failed"));
  const activeMetadataCannotSettle = exhaustive.every((row) => !["queued", "leased", "running"].includes(row.status)
    || row.delivery === "working");
  const conflictsStayVisible = exhaustive.every((row) => row.status !== "completed" || !row.contradictory
    || row.delivery === "unavailable");
  const exhaustiveTerminalNeverFinalizes = exhaustive.every((row) => !["completed", "failed", "canceled"].includes(row.status)
    || row.outcome?.label !== "Finalizing delivery");
  const invariants: ReadonlyArray<CodingTerminalProjectionInvariant> = [
    {
      id: "terminal-outcome-exact",
      passed: exactExpected,
      evidence: `${observations.length} projections matched their expected state, label, and delivery outcome`,
    },
    {
      id: "terminal-never-active",
      passed: terminalNeverLooksActive,
      evidence: `${cases.filter((candidate) => candidate.terminal).length} terminal cases never presented as live work`,
    },
    {
      id: "projection-fault-visible",
      passed: faultsStayVisible,
      evidence: `${cases.filter((candidate) => candidate.injectedFault).length} modeled terminal faults projected Needs attention or Failed`,
    },
    {
      id: "finalizing-bounded-to-active-job",
      passed: finalizingIsBounded,
      evidence: "Finalizing delivery appears only while the queue job is still active at the certified boundary",
    },
    {
      id: "entropy-replay-exact",
      passed: exactReplays === input.schedules,
      evidence: `${exactReplays} of ${input.schedules} entropy schedules replayed with identical draws, prefixes, restarts, and outcomes`,
    },
    {
      id: "prefix-success-requires-current-authority",
      passed: prefixSuccessesAuthorized,
      evidence: "Every intermediate success was authorized by current settled-job or read-only evidence",
    },
    {
      id: "same-version-conflict-visible",
      passed: conflictsStayVisibleAcrossPrefixes,
      evidence: input.injectFaults
        ? "Every unresolved equal-version disagreement projected Needs attention until superseded"
        : "Conflict injection disabled for this campaign",
    },
    {
      id: "active-lease-timeout-bounded",
      passed: expiredLeasesNeverFinalize,
      evidence: "Leased and running jobs stopped projecting Finalizing delivery at their virtual lease deadline",
    },
    {
      id: "queue-failure-precedes-stale-success",
      passed: failureAlwaysWins,
      evidence: "Failed and canceled queue states stayed failed across every metadata, graph, and certification combination",
    },
    {
      id: "active-job-cannot-be-settled-by-stale-metadata",
      passed: activeMetadataCannotSettle,
      evidence: "Queued, leased, and running jobs stayed active across every injected delivery metadata combination",
    },
    {
      id: "semantic-delivery-conflicts-remain-visible",
      passed: conflictsStayVisible,
      evidence: "Contradictory no-change, integration, and branch-disposition claims projected as unavailable",
    },
    {
      id: "exhaustive-terminal-never-finalizes",
      passed: exhaustiveTerminalNeverFinalizes,
      evidence: `${exhaustive.length} exhaustive state combinations kept terminal jobs out of Finalizing delivery`,
    },
  ];
  const passed = invariants.every((invariant) => invariant.passed);
  if (!passed) {
    throw new Error(`Coding terminal projection simulation failed: ${invariants
      .filter((invariant) => !invariant.passed)
      .map((invariant) => invariant.id)
      .join(", ")}`);
  }
  return {
    input,
    caseCount: cases.length,
    scheduleCount: input.schedules,
    scheduleVariants: scheduleDigests.size,
    entropyDraws,
    injectedFaults: scheduleRuns.reduce((total, run) => total + run.injectedFaults, 0),
    modeledFaultCases: cases.filter((candidate) => candidate.injectedFault).length,
    prefixObservations: scheduleRuns.reduce((total, run) => total + run.prefixObservations, 0),
    projectionRestarts: scheduleRuns.reduce((total, run) => total + run.projectionRestarts, 0),
    sameVersionConflicts: scheduleRuns.reduce((total, run) => total + run.sameVersionConflicts, 0),
    exhaustiveCombinations: exhaustive.length,
    exactReplays,
    digest: hashCanonical({ input, observations, schedules: [...scheduleDigests].sort() }),
    invariants,
    passed,
  };
};
