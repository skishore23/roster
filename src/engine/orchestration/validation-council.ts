import { hashCanonical } from "../../core/canonical.js";
import {
  createSharedArtifactUpdate,
  SharedArtifactLedger,
  type ArtifactConflict,
  type ArtifactProjector,
  type SharedArtifactUpdate,
} from "../artifact/shared-crdt.js";

export type ValidationSeverity = "blocker" | "major" | "minor" | "note";
export type ValidationDecision = "certify" | "repair" | "polish" | "inconclusive";
export type ValidationKind = "deterministic" | "model" | "tool" | "peer";

export type ValidationFinding = {
  readonly dimension: string;
  readonly severity: ValidationSeverity;
  readonly subjectId?: string;
  readonly problem: string;
  readonly repairInstruction?: string;
};

export type ValidationReport = {
  readonly reportId: string;
  readonly validatorId: string;
  readonly validatorRole: string;
  readonly validatorKind: ValidationKind;
  readonly frontierVersion: string;
  readonly artifactHash: string;
  readonly verdict: "pass" | "repair" | "abstain";
  readonly scores: Readonly<Record<string, number>>;
  readonly findings: ReadonlyArray<ValidationFinding>;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly summary: string;
};

export type ValidationCouncilPolicy = {
  readonly requiredRoles: ReadonlyArray<string>;
  readonly minimumPassingReports: number;
  readonly scoreFloors?: Readonly<Record<string, number>>;
  readonly repairSeverities?: ReadonlyArray<ValidationSeverity>;
  readonly polishOnActionableMinor?: boolean;
};

export type ValidationCouncilProjection = {
  readonly councilHash: string;
  readonly frontierVersion: string;
  readonly artifactHash: string;
  readonly decision: ValidationDecision;
  readonly reports: ReadonlyArray<ValidationReport>;
  readonly findings: ReadonlyArray<ValidationFinding & { readonly validatorId: string }>;
  readonly missingRoles: ReadonlyArray<string>;
  readonly failedScoreDimensions: ReadonlyArray<string>;
  readonly passingReportCount: number;
  readonly reason: string;
};

const boundedScore = (score: number): boolean => Number.isFinite(score) && score >= 0 && score <= 100;

/**
 * Deterministically projects independent validation reports for one exact
 * artifact frontier. It never invents evidence, asks a judge model to choose a
 * winner, or allows one broad critic to stand in for missing specialties.
 */
export const projectValidationCouncil = (input: {
  readonly frontierVersion: string;
  readonly artifactHash: string;
  readonly reports: ReadonlyArray<ValidationReport>;
  readonly policy: ValidationCouncilPolicy;
}): ValidationCouncilProjection => {
  const reportIds = new Set<string>();
  const validatorIds = new Set<string>();
  for (const report of input.reports) {
    if (report.frontierVersion !== input.frontierVersion || report.artifactHash !== input.artifactHash) {
      throw new Error(`Validation report ${report.reportId} targets a stale artifact frontier`);
    }
    if (reportIds.has(report.reportId)) throw new Error(`Duplicate validation report ${report.reportId}`);
    if (validatorIds.has(report.validatorId)) throw new Error(`Validator ${report.validatorId} published more than one report`);
    if (Object.values(report.scores).some((score) => !boundedScore(score))) {
      throw new Error(`Validation report ${report.reportId} contains an invalid score`);
    }
    reportIds.add(report.reportId);
    validatorIds.add(report.validatorId);
  }

  const reports = [...input.reports].sort((left, right) => left.reportId.localeCompare(right.reportId));
  const roles = new Set(reports.map((report) => report.validatorRole));
  const missingRoles = [...new Set(input.policy.requiredRoles)]
    .filter((role) => !roles.has(role))
    .sort();
  const passingReportCount = reports.filter((report) => report.verdict === "pass").length;
  const repairSeverities = new Set(input.policy.repairSeverities ?? ["blocker", "major"]);
  const findings = reports.flatMap((report) => report.findings.map((finding) => ({
    ...finding,
    validatorId: report.validatorId,
  })));
  const blockingFindings = findings.filter((finding) => repairSeverities.has(finding.severity));
  const failedScoreDimensions = Object.entries(input.policy.scoreFloors ?? {})
    .filter(([dimension, floor]) => reports.some((report) => (
      report.scores[dimension] !== undefined && report.scores[dimension] < floor
    )))
    .map(([dimension]) => dimension)
    .sort();
  const explicitRepairs = reports.filter((report) => report.verdict === "repair");
  const actionableMinor = findings.some((finding) => (
    finding.severity === "minor" && Boolean(finding.repairInstruction?.trim())
  ));

  let decision: ValidationDecision;
  let reason: string;
  if (missingRoles.length > 0 || passingReportCount < input.policy.minimumPassingReports) {
    decision = "inconclusive";
    reason = missingRoles.length > 0
      ? `Missing required validator roles: ${missingRoles.join(", ")}`
      : `${passingReportCount}/${input.policy.minimumPassingReports} required reports passed`;
  } else if (blockingFindings.length > 0 || failedScoreDimensions.length > 0 || explicitRepairs.length > 0) {
    decision = "repair";
    reason = blockingFindings.length > 0
      ? `${blockingFindings.length} blocking validation finding(s)`
      : failedScoreDimensions.length > 0
        ? `Validation score floors failed: ${failedScoreDimensions.join(", ")}`
        : `${explicitRepairs.length} validator(s) requested repair`;
  } else if (input.policy.polishOnActionableMinor && actionableMinor) {
    decision = "polish";
    reason = "Actionable consistency or polish findings remain";
  } else {
    decision = "certify";
    reason = "All required independent validation roles passed this exact frontier";
  }

  const canonical = {
    frontierVersion: input.frontierVersion,
    artifactHash: input.artifactHash,
    decision,
    reportIds: reports.map((report) => report.reportId),
    missingRoles,
    failedScoreDimensions,
    passingReportCount,
  };
  return {
    councilHash: `validation_${hashCanonical(canonical).slice(0, 28)}`,
    frontierVersion: input.frontierVersion,
    artifactHash: input.artifactHash,
    decision,
    reports,
    findings,
    missingRoles,
    failedScoreDimensions,
    passingReportCount,
    reason,
  };
};

export const createValidationReportUpdate = (input: {
  readonly artifactId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly report: ValidationReport;
}): SharedArtifactUpdate<ValidationReport> => createSharedArtifactUpdate({
  artifactId: input.artifactId,
  artifactKind: "validation-council",
  schemaVersion: "validation-council/v1",
  frontierVersion: input.frontierVersion,
  topologyVersion: input.topologyVersion,
  runId: input.runId,
  taskId: input.taskId,
  nodeId: input.report.validatorId,
  inputVersions: { artifact: input.report.artifactHash },
  payload: input.report,
});

export const createValidationCouncilProjector = (input: {
  readonly artifactHash: string;
  readonly policy: ValidationCouncilPolicy;
}): ArtifactProjector<ValidationReport, ValidationCouncilProjection> => (updates, frontier) => {
  const staleUpdateIds: string[] = [];
  const invalidUpdateIds: string[] = [];
  const byValidator = new Map<string, SharedArtifactUpdate<ValidationReport>[]>();
  for (const update of updates) {
    const report = update.payload;
    if (update.frontierVersion !== frontier.frontierVersion || update.topologyVersion !== frontier.topologyVersion) {
      staleUpdateIds.push(update.updateId);
      continue;
    }
    if (update.nodeId !== report.validatorId
      || report.frontierVersion !== frontier.frontierVersion
      || report.artifactHash !== input.artifactHash) {
      invalidUpdateIds.push(update.updateId);
      continue;
    }
    byValidator.set(report.validatorId, [...(byValidator.get(report.validatorId) ?? []), update]);
  }

  const conflicts: ArtifactConflict[] = [];
  const accepted: SharedArtifactUpdate<ValidationReport>[] = [];
  for (const [validatorId, candidates] of byValidator) {
    const payloadHashes = new Set(candidates.map((candidate) => candidate.payloadHash));
    if (payloadHashes.size > 1) {
      conflicts.push({
        conflictId: `validation_conflict_${hashCanonical({ validatorId, updates: candidates.map((candidate) => candidate.updateId).sort() }).slice(0, 24)}`,
        kind: "validation-council",
        subjectId: validatorId,
        candidateUpdateIds: candidates.map((candidate) => candidate.updateId).sort(),
        candidateHashes: [...payloadHashes].sort(),
      });
      continue;
    }
    accepted.push([...candidates].sort((left, right) => left.updateId.localeCompare(right.updateId))[0]!);
  }

  const value = projectValidationCouncil({
    frontierVersion: frontier.frontierVersion,
    artifactHash: input.artifactHash,
    reports: accepted.map((update) => update.payload),
    policy: input.policy,
  });
  return {
    value: conflicts.length > 0
      ? { ...value, decision: "inconclusive", reason: `${conflicts.length} validator report conflict(s) remain` }
      : value,
    acceptedUpdateIds: accepted.map((update) => update.updateId).sort(),
    conflicts,
    invalidUpdateIds: invalidUpdateIds.sort(),
    staleUpdateIds: staleUpdateIds.sort(),
  };
};

export class ValidationCouncilLedger extends SharedArtifactLedger<ValidationReport> {
  constructor(update?: Uint8Array) {
    super({ update, mapName: "validation-council-updates", guid: "roster:validation-council" });
  }
}
