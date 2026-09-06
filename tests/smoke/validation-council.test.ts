import assert from "node:assert/strict";
import test from "node:test";

import {
  createValidationCouncilProjector,
  createValidationReportUpdate,
  projectValidationCouncil,
  ValidationCouncilLedger,
  type ValidationReport,
} from "../../src/engine/orchestration/validation-council.ts";
import { mergeSharedArtifactUpdates } from "../../src/engine/artifact/shared-crdt.ts";

const report = (input: Partial<ValidationReport> & Pick<ValidationReport, "validatorId" | "validatorRole">): ValidationReport => ({
  reportId: `report-${input.validatorId}`,
  validatorKind: "model",
  frontierVersion: "frontier-1",
  artifactHash: "artifact-1",
  verdict: "pass",
  scores: {},
  findings: [],
  evidenceRefs: ["artifact-1"],
  summary: "passed",
  ...input,
});

const policy = {
  requiredRoles: ["semantic", "composition", "consistency"],
  minimumPassingReports: 3,
  scoreFloors: { promptMatch: 70, coherence: 65 },
  polishOnActionableMinor: true,
} as const;

test("validation council cannot certify when an independent specialty is missing", () => {
  const projection = projectValidationCouncil({
    frontierVersion: "frontier-1",
    artifactHash: "artifact-1",
    reports: [
      report({ validatorId: "semantic-agent", validatorRole: "semantic" }),
      report({ validatorId: "composition-agent", validatorRole: "composition" }),
    ],
    policy,
  });
  assert.equal(projection.decision, "inconclusive");
  assert.deepEqual(projection.missingRoles, ["consistency"]);
});

test("validation council turns actionable minor consistency findings into a polish frontier", () => {
  const projection = projectValidationCouncil({
    frontierVersion: "frontier-1",
    artifactHash: "artifact-1",
    reports: [
      report({ validatorId: "semantic-agent", validatorRole: "semantic", scores: { promptMatch: 88 } }),
      report({ validatorId: "composition-agent", validatorRole: "composition", scores: { coherence: 82 } }),
      report({
        validatorId: "consistency-agent",
        validatorRole: "consistency",
        findings: [{
          dimension: "consistency",
          severity: "minor",
          subjectId: "collar",
          problem: "The collar edges disagree at the center seam.",
          repairInstruction: "Align the two collar edges to one shared center point.",
        }],
      }),
    ],
    policy,
  });
  assert.equal(projection.decision, "polish");
  assert.match(projection.reason, /consistency or polish/i);
});

test("validation council certifies only the exact complete conflict-free report set", () => {
  const reports = [
    report({ validatorId: "semantic-agent", validatorRole: "semantic", scores: { promptMatch: 91 } }),
    report({ validatorId: "composition-agent", validatorRole: "composition", scores: { coherence: 84 } }),
    report({ validatorId: "consistency-agent", validatorRole: "consistency" }),
  ];
  const first = projectValidationCouncil({ frontierVersion: "frontier-1", artifactHash: "artifact-1", reports, policy });
  const second = projectValidationCouncil({ frontierVersion: "frontier-1", artifactHash: "artifact-1", reports: [...reports].reverse(), policy });
  assert.equal(first.decision, "certify");
  assert.equal(first.councilHash, second.councilHash);
});

test("validation reports converge through Yjs regardless of delivery order", () => {
  const reports = [
    report({ validatorId: "semantic-agent", validatorRole: "semantic", scores: { promptMatch: 91 } }),
    report({ validatorId: "composition-agent", validatorRole: "composition", scores: { coherence: 84 } }),
    report({ validatorId: "consistency-agent", validatorRole: "consistency" }),
  ];
  const encoded = reports.map((item) => {
    const ledger = new ValidationCouncilLedger();
    try {
      return ledger.add(createValidationReportUpdate({
        artifactId: "validation-artifact",
        runId: "run-1",
        taskId: `validate-${item.validatorRole}`,
        frontierVersion: "frontier-1",
        topologyVersion: "topology-1",
        report: item,
      }));
    } finally {
      ledger.destroy();
    }
  });
  const left = new ValidationCouncilLedger(mergeSharedArtifactUpdates(...encoded));
  const right = new ValidationCouncilLedger(mergeSharedArtifactUpdates(...[...encoded].reverse()));
  try {
    const projector = createValidationCouncilProjector({ artifactHash: "artifact-1", policy });
    const frontier = { frontierVersion: "frontier-1", topologyVersion: "topology-1" };
    const first = left.project("validation-artifact", frontier, projector);
    const second = right.project("validation-artifact", frontier, projector);
    assert.equal(first.value.decision, "certify");
    assert.equal(first.versionHash, second.versionHash);
  } finally {
    left.destroy();
    right.destroy();
  }
});

test("conflicting reports from one validator remain explicit and cannot certify", () => {
  const ledger = new ValidationCouncilLedger();
  try {
    for (const verdict of ["pass", "repair"] as const) {
      const item = report({
        reportId: `consistency-${verdict}`,
        validatorId: "consistency-agent",
        validatorRole: "consistency",
        verdict,
        summary: `validator said ${verdict}`,
      });
      ledger.add(createValidationReportUpdate({
        artifactId: "validation-artifact",
        runId: "run-1",
        taskId: `validate-${verdict}`,
        frontierVersion: "frontier-1",
        topologyVersion: "topology-1",
        report: item,
      }));
    }
    const projected = ledger.project(
      "validation-artifact",
      { frontierVersion: "frontier-1", topologyVersion: "topology-1" },
      createValidationCouncilProjector({ artifactHash: "artifact-1", policy }),
    );
    assert.equal(projected.value.decision, "inconclusive");
    assert.equal(projected.conflicts.length, 1);
  } finally {
    ledger.destroy();
  }
});
