import { hashCanonical } from "../core/canonical.js";
import {
  runSimulationCampaign,
  type CoordinationPattern,
  type SimulationCampaignReport,
} from "./campaign.js";

export const SYSTEM_VERIFICATION_SCHEMA_VERSION = "roster.system-verification.v1" as const;

export type SystemVerificationLayer =
  | "kernel"
  | "runtime"
  | "workspace"
  | "persistence"
  | "repository"
  | "coding"
  | "continuity"
  | "desktop"
  | "live-runtime";

export type SystemFaultKind =
  | "task-failure"
  | "runtime-crash"
  | "runtime-hang"
  | "transport-disconnect"
  | "receipt-duplicate"
  | "receipt-delay"
  | "database-disconnect"
  | "sidecar-restart"
  | "stale-task-context"
  | "workspace-conflict"
  | "git-frontier-move"
  | "repository-admission-restart"
  | "partial-execution-restart"
  | "runtime-policy-override"
  | "execution-profile-mutation"
  | "validation-environment-missing"
  | "cancellation"
  | "deadline-model-overlap";

export type SystemFault = {
  readonly id: string;
  readonly kind: SystemFaultKind;
  readonly target?: string;
  readonly after?: string;
  readonly maxOccurrences: number;
};

export type SystemVerificationLimits = {
  readonly maxNodes: number;
  readonly maxTasks: number;
  readonly maxParallel: number;
  readonly maxDurationMs: number;
};

export type SystemVerificationScenario = {
  readonly schemaVersion: typeof SYSTEM_VERIFICATION_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly layer: SystemVerificationLayer;
  readonly seed: number;
  readonly schedules: number;
  readonly limits: SystemVerificationLimits;
  readonly faults: ReadonlyArray<SystemFault>;
  readonly requiredInvariants: ReadonlyArray<SystemInvariantId>;
  readonly configuration:
    | {
        readonly kind: "coordination-campaign";
        readonly pattern: CoordinationPattern;
        readonly workerNodes: number;
      }
    | {
        readonly kind: "runtime-conformance";
        readonly workerNodes: 1;
      }
    | {
        readonly kind: "shared-workspace";
        readonly workerNodes: number;
      }
    | {
        readonly kind: "persistence-dynamic-dag";
        readonly workerNodes: 2;
      }
    | {
        readonly kind: "repository-git-workspace";
        readonly workerNodes: 1;
      }
    | {
        readonly kind: "coding-job-lifecycle";
        readonly workerNodes: 2;
      }
    | {
        readonly kind: "desktop-sidecar";
        readonly workerNodes: 1;
      }
    | {
        readonly kind: "live-runtime-canary";
        readonly workerNodes: 1;
        readonly runtimeKind: "codex-cli" | "claude-code" | "pi-agent" | "hermes-agent";
        readonly command: readonly [string, ...ReadonlyArray<string>];
        readonly maxTotalTokens: number;
        readonly provider?: string;
        readonly model?: string;
      };
};

export type SystemInvariantId =
  | "semantic-convergence"
  | "exact-replay"
  | "bounded-parallelism"
  | "bounded-node-population"
  | "durable-receipt-trace"
  | "fault-plan-exercised"
  | "fault-recovery"
  | "application-acceptance"
  | "stable-node-identity"
  | "monotonic-runtime-binding"
  | "runtime-envelope-contract"
  | "cancellation-contained"
  | "workspace-delivery-convergence"
  | "duplicate-delivery-idempotence"
  | "exclusive-conflict-preserved"
  | "persistence-reconnected"
  | "dynamic-graph-recovered"
  | "durable-values-recovered"
  | "durable-workspace-recovered"
  | "stale-lease-rejected"
  | "exact-reducer-replay"
  | "git-workspace-recovered"
  | "git-stale-frontier-rejected"
  | "git-cleanup-contained"
  | "git-patch-retained"
  | "coding-preexecution-retry"
  | "coding-partial-execution-resumed"
  | "coding-duplicate-execution-prevented"
  | "coding-interrupted-workspace-contained"
  | "coding-review-policy-isolated"
  | "coding-execution-profile-preserved"
  | "coding-validation-diagnostics-preserved"
  | "coding-validation-environment-isolated"
  | "continuity-deadline-independent"
  | "continuity-early-admission-independent"
  | "continuity-effect-exactly-once"
  | "continuity-stale-commitment-fenced"
  | "continuity-late-plan-rejected"
  | "continuity-node-identity-stable"
  | "desktop-initial-boot"
  | "desktop-restart-recovered"
  | "desktop-identity-preserved"
  | "desktop-process-contained"
  | "live-runtime-ready"
  | "live-runtime-response-contract"
  | "live-runtime-node-identity"
  | "live-runtime-usage-observed"
  | "live-runtime-budget-respected";

export const MANDATORY_SYSTEM_INVARIANTS: Readonly<
  Record<SystemVerificationLayer, ReadonlyArray<SystemInvariantId>>
> = {
  kernel: [
    "semantic-convergence",
    "exact-replay",
    "bounded-parallelism",
    "bounded-node-population",
    "durable-receipt-trace",
    "fault-plan-exercised",
    "fault-recovery",
    "application-acceptance",
  ],
  runtime: [
    "stable-node-identity",
    "monotonic-runtime-binding",
    "runtime-envelope-contract",
    "cancellation-contained",
    "fault-plan-exercised",
    "fault-recovery",
  ],
  workspace: [
    "workspace-delivery-convergence",
    "duplicate-delivery-idempotence",
    "exclusive-conflict-preserved",
    "fault-plan-exercised",
    "fault-recovery",
  ],
  persistence: [
    "persistence-reconnected",
    "dynamic-graph-recovered",
    "durable-values-recovered",
    "durable-workspace-recovered",
    "stale-lease-rejected",
    "exact-reducer-replay",
    "fault-plan-exercised",
    "fault-recovery",
  ],
  repository: [
    "git-workspace-recovered",
    "git-stale-frontier-rejected",
    "git-cleanup-contained",
    "git-patch-retained",
    "fault-plan-exercised",
    "fault-recovery",
  ],
  coding: [
    "coding-preexecution-retry",
    "coding-partial-execution-resumed",
    "coding-duplicate-execution-prevented",
    "coding-interrupted-workspace-contained",
    "coding-review-policy-isolated",
    "coding-execution-profile-preserved",
    "coding-validation-diagnostics-preserved",
    "coding-validation-environment-isolated",
    "fault-plan-exercised",
    "fault-recovery",
  ],
  continuity: [
    "semantic-convergence",
    "exact-replay",
    "bounded-parallelism",
    "bounded-node-population",
    "durable-receipt-trace",
    "application-acceptance",
    "continuity-deadline-independent",
    "continuity-early-admission-independent",
    "continuity-effect-exactly-once",
    "continuity-stale-commitment-fenced",
    "continuity-late-plan-rejected",
    "continuity-node-identity-stable",
    "fault-plan-exercised",
    "fault-recovery",
  ],
  desktop: [
    "desktop-initial-boot",
    "desktop-restart-recovered",
    "desktop-identity-preserved",
    "desktop-process-contained",
    "fault-plan-exercised",
    "fault-recovery",
  ],
  "live-runtime": [
    "live-runtime-ready",
    "live-runtime-response-contract",
    "live-runtime-node-identity",
    "live-runtime-usage-observed",
    "live-runtime-budget-respected",
    "fault-plan-exercised",
    "fault-recovery",
  ],
};

export type SystemVerificationObservation = {
  readonly environmentId: string;
  readonly layer: SystemVerificationLayer;
  readonly campaignId: string;
  readonly scheduleCount: number;
  readonly converged: boolean;
  readonly exactReplays: number;
  readonly peakParallel: number;
  readonly peakNodes: number;
  readonly receiptsPerRun: number;
  readonly recoveredFaults: number;
  readonly exercisedFaultIds: ReadonlyArray<string>;
  readonly completionDigests: ReadonlyArray<string>;
  readonly failedApplicationInvariants: ReadonlyArray<string>;
  readonly runtime?: {
    readonly nodeIdentityStable: boolean;
    readonly bindingEpochs: ReadonlyArray<number>;
    readonly envelopeContractValid: boolean;
    readonly cancellationContained: boolean;
  };
  readonly workspace?: {
    readonly deliveryConverged: boolean;
    readonly duplicateDeliveryStable: boolean;
    readonly exclusiveConflictCount: number;
  };
  readonly persistence?: {
    readonly reconnected: boolean;
    readonly graphRecovered: boolean;
    readonly valuesRecovered: boolean;
    readonly workspaceRecovered: boolean;
    readonly staleFenceRejected: boolean;
    readonly exactReducerReplay: boolean;
    readonly graphDigest: string;
  };
  readonly repository?: {
    readonly workspaceRecovered: boolean;
    readonly staleFrontierRejected: boolean;
    readonly cleanupContained: boolean;
    readonly patchRetained: boolean;
  };
  readonly coding?: {
    readonly preExecutionRetryAllowed: boolean;
    readonly partialExecutionResumed: boolean;
    readonly modelExecutionCounts: readonly [number, number];
    readonly interruptedWorkspaceCleaned: boolean;
    readonly interruptedPatchRetained: boolean;
    readonly reviewerPolicyIsolated: boolean;
    readonly executionProfilePreserved: boolean;
    readonly validationFailureDetailed: boolean;
    readonly validationEnvironmentIsolated: boolean;
  };
  readonly continuity?: {
    readonly deadlineIndependent: boolean;
    readonly earlyAdmissionDeadlineIndependent: boolean;
    readonly effectExactlyOnce: boolean;
    readonly staleCommitmentFenced: boolean;
    readonly latePlanRejected: boolean;
    readonly nodeIdentityStable: boolean;
  };
  readonly desktop?: {
    readonly initialBootReady: boolean;
    readonly restartReady: boolean;
    readonly identityPreserved: boolean;
    readonly priorProcessContained: boolean;
  };
  readonly liveRuntime?: {
    readonly runtimeKind: string;
    readonly ready: boolean;
    readonly responseContractValid: boolean;
    readonly nodeIdentityStable: boolean;
    readonly usageReported: boolean;
    readonly totalTokens: number;
    readonly maxTotalTokens: number;
    readonly durationMs: number;
    readonly withinLimits: boolean;
  };
};

export type SystemInvariantResult = {
  readonly id: SystemInvariantId;
  readonly passed: boolean;
  readonly evidence: string;
};

export type SystemVerificationEvidence = {
  readonly schemaVersion: typeof SYSTEM_VERIFICATION_SCHEMA_VERSION;
  readonly evidenceId: string;
  readonly scenario: SystemVerificationScenario;
  readonly observation: SystemVerificationObservation;
  readonly invariants: ReadonlyArray<SystemInvariantResult>;
  readonly passed: boolean;
};

export type SystemVerificationEnvironment = {
  readonly id: string;
  readonly layer: SystemVerificationLayer;
  readonly supportedFaults: ReadonlyArray<SystemFaultKind>;
  readonly execute: (
    scenario: SystemVerificationScenario,
  ) => Promise<SystemVerificationObservation>;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
};

const boundedId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) {
    throw new Error(`${label} must contain between 1 and 160 characters`);
  }
  return normalized;
};

const unique = <Value extends string>(values: ReadonlyArray<Value>): Value[] =>
  [...new Set(values)].sort();

export const createSystemVerificationScenario = (input: {
  readonly id: string;
  readonly version?: string;
  readonly name: string;
  readonly pattern: CoordinationPattern;
  readonly workerNodes: number;
  readonly maxTasks?: number;
  readonly maxParallel: number;
  readonly maxDurationMs?: number;
  readonly schedules: number;
  readonly seed: number;
  readonly faults?: ReadonlyArray<SystemFault>;
  readonly requiredInvariants?: ReadonlyArray<SystemInvariantId>;
}): SystemVerificationScenario => {
  const workerNodes = positiveInteger(input.workerNodes, "Verification workerNodes");
  const maxParallel = positiveInteger(input.maxParallel, "Verification maxParallel");
  if (maxParallel > workerNodes) {
    throw new Error("Verification maxParallel must not exceed workerNodes");
  }
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff) {
    throw new Error("Verification seed must be an unsigned 32-bit integer");
  }
  const faults = (input.faults ?? []).map((fault) => ({
    ...fault,
    id: boundedId(fault.id, "Verification fault id"),
    maxOccurrences: positiveInteger(fault.maxOccurrences, "Verification fault maxOccurrences"),
  }));
  if (unique(faults.map((fault) => fault.id)).length !== faults.length) {
    throw new Error("Verification fault ids must be unique");
  }
  const requiredInvariants = unique([
    ...MANDATORY_SYSTEM_INVARIANTS.kernel,
    ...(input.requiredInvariants ?? []),
  ]);
  return {
    schemaVersion: SYSTEM_VERIFICATION_SCHEMA_VERSION,
    id: boundedId(input.id, "Verification scenario id"),
    version: boundedId(input.version ?? "1", "Verification scenario version"),
    name: boundedId(input.name, "Verification scenario name"),
    layer: "kernel",
    seed: input.seed,
    schedules: positiveInteger(input.schedules, "Verification schedules"),
    limits: {
      maxNodes: workerNodes + 1,
      maxTasks: positiveInteger(input.maxTasks ?? 10_000, "Verification maxTasks"),
      maxParallel,
      maxDurationMs: positiveInteger(
        input.maxDurationMs ?? 120_000,
        "Verification maxDurationMs",
      ),
    },
    faults,
    requiredInvariants,
    configuration: {
      kind: "coordination-campaign",
      pattern: input.pattern,
      workerNodes,
    },
  };
};

export const createBoundaryVerificationScenario = (input: {
  readonly id: string;
  readonly version?: string;
  readonly name: string;
  readonly layer: Exclude<SystemVerificationLayer, "kernel">;
  readonly workerNodes: number;
  readonly maxTasks: number;
  readonly maxParallel: number;
  readonly maxDurationMs?: number;
  readonly seed: number;
  readonly faults: ReadonlyArray<SystemFault>;
  readonly configuration: Extract<
    SystemVerificationScenario["configuration"],
    {
      readonly kind:
        | "runtime-conformance"
        | "shared-workspace"
        | "persistence-dynamic-dag"
        | "repository-git-workspace"
        | "coding-job-lifecycle"
        | "desktop-sidecar"
        | "live-runtime-canary";
    }
  >;
  readonly requiredInvariants?: ReadonlyArray<SystemInvariantId>;
}): SystemVerificationScenario => {
  const workerNodes = positiveInteger(input.workerNodes, "Verification workerNodes");
  const maxParallel = positiveInteger(input.maxParallel, "Verification maxParallel");
  if (maxParallel > workerNodes) {
    throw new Error("Verification maxParallel must not exceed workerNodes");
  }
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff) {
    throw new Error("Verification seed must be an unsigned 32-bit integer");
  }
  if (input.configuration.workerNodes !== workerNodes) {
    throw new Error("Verification configuration workerNodes must match the scenario limit");
  }
  const faults = input.faults.map((fault) => ({
    ...fault,
    id: boundedId(fault.id, "Verification fault id"),
    maxOccurrences: positiveInteger(fault.maxOccurrences, "Verification fault maxOccurrences"),
  }));
  if (unique(faults.map((fault) => fault.id)).length !== faults.length) {
    throw new Error("Verification fault ids must be unique");
  }
  return {
    schemaVersion: SYSTEM_VERIFICATION_SCHEMA_VERSION,
    id: boundedId(input.id, "Verification scenario id"),
    version: boundedId(input.version ?? "1", "Verification scenario version"),
    name: boundedId(input.name, "Verification scenario name"),
    layer: input.layer,
    seed: input.seed,
    schedules: 1,
    limits: {
      maxNodes: workerNodes + 1,
      maxTasks: positiveInteger(input.maxTasks, "Verification maxTasks"),
      maxParallel,
      maxDurationMs: positiveInteger(
        input.maxDurationMs ?? 120_000,
        "Verification maxDurationMs",
      ),
    },
    faults,
    requiredInvariants: unique([
      ...MANDATORY_SYSTEM_INVARIANTS[input.layer],
      ...(input.requiredInvariants ?? []),
    ]),
    configuration: input.configuration,
  };
};

const peakNodes = (report: SimulationCampaignReport): number =>
  report.replayFrames.reduce(
    (peak, frame) => Math.max(peak, frame.activeAgents),
    report.summary.finalActiveAgents,
  );

export const campaignVerificationObservation = (
  report: SimulationCampaignReport,
  scenario: SystemVerificationScenario,
  environmentId: string,
): SystemVerificationObservation => ({
  environmentId,
  layer: "kernel",
  campaignId: report.campaignId,
  scheduleCount: report.schedules.length,
  converged: report.summary.converged,
  exactReplays: report.summary.exactReplays,
  peakParallel: report.summary.peakParallel,
  peakNodes: peakNodes(report),
  receiptsPerRun: report.summary.receiptsPerRun,
  recoveredFaults: report.summary.faultRecoveries,
  exercisedFaultIds: report.summary.faultRecoveries > 0
    ? scenario.faults.filter((fault) => fault.kind === "task-failure").map((fault) => fault.id)
    : [],
  completionDigests: unique(report.schedules.map((schedule) => schedule.completionDigest)),
  failedApplicationInvariants: report.application?.invariants
    .filter((invariant) => !invariant.passed)
    .map((invariant) => invariant.id)
    ?? [],
});

const evaluateInvariant = (
  id: SystemInvariantId,
  scenario: SystemVerificationScenario,
  observation: SystemVerificationObservation,
): SystemInvariantResult => {
  switch (id) {
    case "semantic-convergence":
      return {
        id,
        passed: observation.converged,
        evidence: observation.converged
          ? `${observation.scheduleCount} schedules reached one semantic state`
          : "searched schedules did not reach one semantic state",
      };
    case "exact-replay":
      return {
        id,
        passed: observation.exactReplays === scenario.schedules,
        evidence: `${observation.exactReplays}/${scenario.schedules} exact entropy replays`,
      };
    case "bounded-parallelism":
      return {
        id,
        passed: observation.peakParallel <= scenario.limits.maxParallel,
        evidence: `peak ${observation.peakParallel}, bound ${scenario.limits.maxParallel}`,
      };
    case "bounded-node-population":
      return {
        id,
        passed: observation.peakNodes <= scenario.limits.maxNodes,
        evidence: `peak ${observation.peakNodes}, bound ${scenario.limits.maxNodes}`,
      };
    case "durable-receipt-trace":
      return {
        id,
        passed: observation.receiptsPerRun > 0,
        evidence: `${observation.receiptsPerRun} ordered events in the representative trace`,
      };
    case "fault-plan-exercised": {
      const missing = scenario.faults
        .filter((fault) => !observation.exercisedFaultIds.includes(fault.id))
        .map((fault) => fault.id);
      return {
        id,
        passed: missing.length === 0,
        evidence: missing.length === 0
          ? `${observation.exercisedFaultIds.length} declared fault rules exercised`
          : `unexercised fault rules: ${missing.join(", ")}`,
      };
    }
    case "fault-recovery": {
      const expected = scenario.faults.reduce(
        (total, fault) => total + fault.maxOccurrences,
        0,
      );
      return {
        id,
        passed: observation.recoveredFaults === expected,
        evidence: `${observation.recoveredFaults}/${expected} declared fault occurrences recovered`,
      };
    }
    case "application-acceptance":
      return {
        id,
        passed: observation.failedApplicationInvariants.length === 0,
        evidence: observation.failedApplicationInvariants.length === 0
          ? "all domain acceptance invariants passed"
          : `failed domain invariants: ${observation.failedApplicationInvariants.join(", ")}`,
      };
    case "stable-node-identity":
      return {
        id,
        passed: observation.runtime?.nodeIdentityStable === true,
        evidence: observation.runtime?.nodeIdentityStable
          ? "logical node identity survived runtime replacement"
          : "runtime replacement changed or lost logical node identity",
      };
    case "monotonic-runtime-binding": {
      const epochs = observation.runtime?.bindingEpochs ?? [];
      const monotonic = epochs.length > 1
        && epochs.every((epoch, index) => index === 0 || epoch > epochs[index - 1]!);
      return {
        id,
        passed: monotonic,
        evidence: epochs.length ? `observed binding epochs ${epochs.join(" -> ")}` : "no binding epochs observed",
      };
    }
    case "runtime-envelope-contract":
      return {
        id,
        passed: observation.runtime?.envelopeContractValid === true,
        evidence: observation.runtime?.envelopeContractValid
          ? "external process exchanged roster.node-execution.v5"
          : "external process did not prove the execution envelope contract",
      };
    case "cancellation-contained":
      return {
        id,
        passed: observation.runtime?.cancellationContained === true,
        evidence: observation.runtime?.cancellationContained
          ? "cancelled process settled before the environment returned"
          : "cancelled process was not proven contained",
      };
    case "workspace-delivery-convergence":
      return {
        id,
        passed: observation.workspace?.deliveryConverged === true,
        evidence: observation.workspace?.deliveryConverged
          ? "forward and reverse Yjs delivery produced one projection"
          : "workspace projections diverged by delivery order",
      };
    case "duplicate-delivery-idempotence":
      return {
        id,
        passed: observation.workspace?.duplicateDeliveryStable === true,
        evidence: observation.workspace?.duplicateDeliveryStable
          ? "duplicate workspace updates left the projection unchanged"
          : "duplicate workspace delivery changed the projection",
      };
    case "exclusive-conflict-preserved": {
      const count = observation.workspace?.exclusiveConflictCount ?? 0;
      return {
        id,
        passed: count > 0,
        evidence: `${count} explicit exclusive workspace conflict(s)`,
      };
    }
    case "persistence-reconnected":
      return {
        id,
        passed: observation.persistence?.reconnected === true,
        evidence: observation.persistence?.reconnected
          ? "a new control-plane connection recovered the durable job"
          : "durable state was not recovered after reconnect",
      };
    case "dynamic-graph-recovered":
      return {
        id,
        passed: observation.persistence?.graphRecovered === true,
        evidence: observation.persistence?.graphRecovered
          ? "a fresh platform instance resumed the durable dynamic DAG exactly once"
          : "the dynamic DAG did not recover its interrupted frontier",
      };
    case "durable-values-recovered":
      return {
        id,
        passed: observation.persistence?.valuesRecovered === true,
        evidence: observation.persistence?.valuesRecovered
          ? "immutable worker values survived and fed the recovered continuation"
          : "the recovered continuation could not read its durable worker values",
      };
    case "durable-workspace-recovered":
      return {
        id,
        passed: observation.persistence?.workspaceRecovered === true,
        evidence: observation.persistence?.workspaceRecovered
          ? "the task-fenced shared-workspace CRDT survived process loss"
          : "shared agent context did not survive process loss",
      };
    case "stale-lease-rejected":
      return {
        id,
        passed: observation.persistence?.staleFenceRejected === true,
        evidence: observation.persistence?.staleFenceRejected
          ? "the accepted worker could not publish through its stale task fence"
          : "a stale task context retained shared-workspace authority",
      };
    case "exact-reducer-replay":
      return {
        id,
        passed: observation.persistence?.exactReducerReplay === true,
        evidence: observation.persistence?.exactReducerReplay
          ? `lost expansion and acceptance acknowledgements replayed exactly (${observation.persistence.graphDigest.slice(0, 12)})`
          : "replaying a committed graph reducer changed durable state",
      };
    case "git-workspace-recovered":
      return {
        id,
        passed: observation.repository?.workspaceRecovered === true,
        evidence: observation.repository?.workspaceRecovered
          ? "uncommitted run frontier survived worktree recovery"
          : "run workspace frontier did not survive recovery",
      };
    case "git-stale-frontier-rejected":
      return {
        id,
        passed: observation.repository?.staleFrontierRejected === true,
        evidence: observation.repository?.staleFrontierRejected
          ? "moved target branch rejected the certified stale frontier"
          : "a stale certified frontier retained integration authority",
      };
    case "git-cleanup-contained":
      return {
        id,
        passed: observation.repository?.cleanupContained === true,
        evidence: observation.repository?.cleanupContained
          ? "isolated worktree was removed after execution"
          : "isolated worktree remained after cleanup",
      };
    case "git-patch-retained":
      return {
        id,
        passed: observation.repository?.patchRetained === true,
        evidence: observation.repository?.patchRetained
          ? "diagnostic patch retained the recovered delta"
          : "recovered delta was missing from retained patch evidence",
      };
    case "coding-preexecution-retry":
      return {
        id,
        passed: observation.coding?.preExecutionRetryAllowed === true,
        evidence: observation.coding?.preExecutionRetryAllowed
          ? "an expired lease before orchestration execution remained safely retryable"
          : "a pre-execution lease restart did not recover",
      };
    case "coding-partial-execution-resumed":
      return {
        id,
        passed: observation.coding?.partialExecutionResumed === true,
        evidence: observation.coding?.partialExecutionResumed
          ? "the replacement lease resumed the durable task frontier"
          : "a partially executed coding attempt did not resume from durable state",
      };
    case "coding-duplicate-execution-prevented": {
      const counts = observation.coding?.modelExecutionCounts ?? [];
      const bounded = counts.length === 2 && counts.every((count) => count === 1);
      return {
        id,
        passed: bounded,
        evidence: counts.length
          ? `model executions across pre/post-execution restart schedules: ${counts.join(", ")}`
          : "coding execution counts are missing",
      };
    }
    case "coding-interrupted-workspace-contained":
      return {
        id,
        passed: observation.coding?.interruptedWorkspaceCleaned === true
          && observation.coding?.interruptedPatchRetained === true,
        evidence: observation.coding?.interruptedWorkspaceCleaned
          && observation.coding?.interruptedPatchRetained
          ? "interrupted placement was removed after retaining its diagnostic patch"
          : "interrupted coding placement or patch evidence escaped containment",
      };
    case "coding-review-policy-isolated":
      return {
        id,
        passed: observation.coding?.reviewerPolicyIsolated === true,
        evidence: observation.coding?.reviewerPolicyIsolated
          ? "worker runtime overrides did not change reviewer model policy"
          : "worker runtime policy leaked into a reviewer",
      };
    case "coding-execution-profile-preserved":
      return {
        id,
        passed: observation.coding?.executionProfilePreserved === true,
        evidence: observation.coding?.executionProfilePreserved
          ? "the compiled target retained its immutable toolchain evidence constraint"
          : "execution-profile evidence changed after plan compilation",
      };
    case "coding-validation-diagnostics-preserved":
      return {
        id,
        passed: observation.coding?.validationFailureDetailed === true,
        evidence: observation.coding?.validationFailureDetailed
          ? "the authoritative validation failure retained check and command diagnostics"
          : "validation failure evidence was flattened or lost",
      };
    case "coding-validation-environment-isolated":
      return {
        id,
        passed: observation.coding?.validationEnvironmentIsolated === true,
        evidence: observation.coding?.validationEnvironmentIsolated
          ? "missing validation configuration failed closed and selected values reached only the host command runtime"
          : "validation configuration did not fail closed or leaked into a model runtime",
      };
    case "continuity-deadline-independent":
      return {
        id,
        passed: observation.continuity?.deadlineIndependent === true,
        evidence: observation.continuity?.deadlineIndependent
          ? "the prepared deadline lane settled while a provider-backed wake remained in flight"
          : "the prepared deadline remained coupled to provider wake settlement",
      };
    case "continuity-early-admission-independent":
      return {
        id,
        passed: observation.continuity?.earlyAdmissionDeadlineIndependent === true,
        evidence: observation.continuity?.earlyAdmissionDeadlineIndependent
          ? "a wake-bound commitment admitted during the provider turn executed before that turn settled"
          : "short-deadline admission remained coupled to complete provider-turn settlement",
      };
    case "continuity-effect-exactly-once":
      return {
        id,
        passed: observation.continuity?.effectExactlyOnce === true,
        evidence: observation.continuity?.effectExactlyOnce
          ? "the claimed non-repeatable prepared effect executed exactly once"
          : "the prepared effect was skipped or repeated",
      };
    case "continuity-stale-commitment-fenced":
      return {
        id,
        passed: observation.continuity?.staleCommitmentFenced === true,
        evidence: observation.continuity?.staleCommitmentFenced
          ? "the immutable wake revision prevented a stale model result from recreating settled work"
          : "a stale model result retained commitment mutation authority",
      };
    case "continuity-late-plan-rejected":
      return {
        id,
        passed: observation.continuity?.latePlanRejected === true,
        evidence: observation.continuity?.latePlanRejected
          ? "a provider plan that settled after its deadline retained no scheduling authority"
          : "a stale provider plan could still admit already-late work",
      };
    case "continuity-node-identity-stable":
      return {
        id,
        passed: observation.continuity?.nodeIdentityStable === true,
        evidence: observation.continuity?.nodeIdentityStable
          ? "the deadline lane preserved one logical workspace-node identity"
          : "deadline execution changed or duplicated logical node identity",
      };
    case "desktop-initial-boot":
      return {
        id,
        passed: observation.desktop?.initialBootReady === true,
        evidence: observation.desktop?.initialBootReady
          ? "desktop sidecar served its Coding workspace"
          : "desktop sidecar did not become ready",
      };
    case "desktop-restart-recovered":
      return {
        id,
        passed: observation.desktop?.restartReady === true,
        evidence: observation.desktop?.restartReady
          ? "replacement sidecar served the same desktop workspace"
          : "replacement sidecar did not recover",
      };
    case "desktop-identity-preserved":
      return {
        id,
        passed: observation.desktop?.identityPreserved === true,
        evidence: observation.desktop?.identityPreserved
          ? "private desktop device identity survived restart"
          : "desktop restart changed or lost device identity",
      };
    case "desktop-process-contained":
      return {
        id,
        passed: observation.desktop?.priorProcessContained === true,
        evidence: observation.desktop?.priorProcessContained
          ? "terminated sidecar settled before replacement launch"
          : "prior sidecar was not proven contained",
      };
    case "live-runtime-ready":
      return {
        id,
        passed: observation.liveRuntime?.ready === true,
        evidence: observation.liveRuntime?.ready
          ? `${observation.liveRuntime.runtimeKind} completed a provider-backed invocation`
          : "selected live runtime did not complete an invocation",
      };
    case "live-runtime-response-contract":
      return {
        id,
        passed: observation.liveRuntime?.responseContractValid === true,
        evidence: observation.liveRuntime?.responseContractValid
          ? "provider response satisfied roster.live-runtime-canary.v1"
          : "provider response violated the canary output contract",
      };
    case "live-runtime-node-identity":
      return {
        id,
        passed: observation.liveRuntime?.nodeIdentityStable === true,
        evidence: observation.liveRuntime?.nodeIdentityStable
          ? "provider returned the exact assigned logical node identity"
          : "provider lost or changed the assigned logical node identity",
      };
    case "live-runtime-usage-observed":
      return {
        id,
        passed: observation.liveRuntime?.usageReported === true,
        evidence: observation.liveRuntime?.usageReported
          ? `${observation.liveRuntime.totalTokens} provider-reported tokens`
          : "provider did not report normalized token usage",
      };
    case "live-runtime-budget-respected":
      return {
        id,
        passed: observation.liveRuntime?.withinLimits === true,
        evidence: observation.liveRuntime
          ? `${observation.liveRuntime.totalTokens}/${observation.liveRuntime.maxTotalTokens} tokens in ${observation.liveRuntime.durationMs}ms`
          : "live runtime budget evidence is missing",
      };
  }
};

export const evaluateSystemVerification = (
  scenario: SystemVerificationScenario,
  observation: SystemVerificationObservation,
): SystemVerificationEvidence => {
  if (observation.layer !== scenario.layer) {
    throw new Error(
      `Verification environment returned ${observation.layer} evidence for ${scenario.layer} scenario`,
    );
  }
  const invariants = scenario.requiredInvariants.map((id) =>
    evaluateInvariant(id, scenario, observation));
  const passed = invariants.every((invariant) => invariant.passed);
  const content = {
    schemaVersion: SYSTEM_VERIFICATION_SCHEMA_VERSION,
    scenario,
    observation,
    invariants,
    passed,
  };
  return {
    ...content,
    evidenceId: `verification_${hashCanonical(content).slice(0, 24)}`,
  };
};

export const runSystemVerification = async (
  scenario: SystemVerificationScenario,
  environment: SystemVerificationEnvironment,
): Promise<SystemVerificationEvidence> => {
  if (environment.layer !== scenario.layer) {
    throw new Error(
      `Verification environment ${environment.id} cannot execute ${scenario.layer} scenarios`,
    );
  }
  const unsupported = unique(scenario.faults
    .map((fault) => fault.kind)
    .filter((kind) => !environment.supportedFaults.includes(kind)));
  if (unsupported.length > 0) {
    throw new Error(
      `Verification environment ${environment.id} does not support faults: ${unsupported.join(", ")}`,
    );
  }
  const startedAt = Date.now();
  const observation = await environment.execute(scenario);
  if (observation.environmentId !== environment.id) {
    throw new Error(
      `Verification environment ${environment.id} returned evidence for ${observation.environmentId}`,
    );
  }
  if (observation.scheduleCount !== scenario.schedules) {
    throw new Error(
      `Verification environment ${environment.id} observed ${observation.scheduleCount}/${scenario.schedules} schedules`,
    );
  }
  if (Date.now() - startedAt > scenario.limits.maxDurationMs) {
    throw new Error(
      `Verification scenario ${scenario.id} exceeded ${scenario.limits.maxDurationMs}ms`,
    );
  }
  return evaluateSystemVerification(scenario, observation);
};

export const campaignVerificationEnvironment: SystemVerificationEnvironment = {
  id: "roster-platform-kernel",
  layer: "kernel",
  supportedFaults: ["task-failure"],
  execute: async (scenario) => {
    if (scenario.configuration.kind !== "coordination-campaign") {
      throw new Error("Roster platform kernel requires coordination-campaign configuration");
    }
    const taskFaults = scenario.faults.filter((fault) => fault.kind === "task-failure");
    if (taskFaults.length > 1) {
      throw new Error("Roster platform kernel supports one task-failure rule per schedule");
    }
    const fault = taskFaults[0];
    if (fault && fault.maxOccurrences !== scenario.schedules) {
      throw new Error(
        "Roster platform task-failure maxOccurrences must equal the scenario schedule count",
      );
    }
    const report = await runSimulationCampaign({
      pattern: scenario.configuration.pattern,
      agents: scenario.configuration.workerNodes,
      maxParallel: scenario.limits.maxParallel,
      schedules: scenario.schedules,
      injectFaults: Boolean(fault),
      seed: scenario.seed,
    });
    return campaignVerificationObservation(report, scenario, "roster-platform-kernel");
  },
};

export const createKernelRobustnessScenario = (input: {
  readonly pattern: CoordinationPattern;
  readonly workerNodes?: number;
  readonly maxParallel?: number;
  readonly schedules?: number;
  readonly seed?: number;
  readonly injectTaskFailure?: boolean;
}): SystemVerificationScenario => {
  const schedules = input.schedules ?? 6;
  return createSystemVerificationScenario({
    id: `kernel-${input.pattern}`,
    name: `${input.pattern} coordination kernel`,
    pattern: input.pattern,
    workerNodes: input.workerNodes ?? 12,
    maxParallel: input.maxParallel ?? 6,
    schedules,
    seed: input.seed ?? 0x51f15e,
    faults: input.injectTaskFailure === false ? [] : [{
      id: "recover-task-boundary",
      kind: "task-failure",
      maxOccurrences: schedules,
    }],
  });
};
