import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "../../src/core/canonical.ts";
import {
  applyCodingImprovements,
  codingAutonomousImprovementCandidate,
  codingImprovementRuntimeIdentity,
  createCodingImprovementRuntimePin,
  evaluateCodingImprovementArtifact,
  parseCodingImprovementRuntimePin,
} from "../../src/domains/coding-improvements.ts";
import { codingAcceptedOutputProjectionKey } from "../../src/domains/coding-accepted-outputs.ts";
import {
  ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION,
  type ActiveImprovement,
} from "../../src/engine/runtime/self-improvement-framework.ts";

const snapshot = (improvements: ReadonlyArray<ActiveImprovement>) => {
  const content = { schemaVersion: ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION, improvements };
  return { ...content, snapshotHash: hashCanonical(content) };
};

test("Coding pins promoted prompt, policy, and harness improvements while only attenuating policy", () => {
  const result = applyCodingImprovements({
    objective: "Fix the failing parser.",
    maxNodes: 8,
    maxParallel: 5,
    maxSupervisors: 3,
    reviewPolicy: "fast",
    snapshot: snapshot([
      {
        proposalId: "prompt",
        artifactType: "prompt_patch",
        target: "coding.prompt",
        artifactHash: "prompt-hash",
        manifestHash: "prompt-manifest",
        epoch: 2,
        patch: { instructions: ["Preserve parser error offsets."] },
      },
      {
        proposalId: "policy",
        artifactType: "policy_patch",
        target: "coding.policy",
        artifactHash: "policy-hash",
        manifestHash: "policy-manifest",
        epoch: 3,
        patch: { maxNodes: 4, maxParallel: 2, maxSupervisors: 2, reviewPolicy: "reviewed" },
      },
      {
        proposalId: "harness",
        artifactType: "harness_patch",
        target: "coding.harness",
        artifactHash: "harness-hash",
        manifestHash: "harness-manifest",
        epoch: 4,
        patch: { requiredChecks: ["Run the parser regression fixture."] },
      },
    ]),
  });
  assert.equal(result.maxNodes, 4);
  assert.equal(result.maxParallel, 2);
  assert.equal(result.maxSupervisors, 2);
  assert.equal(result.reviewPolicy, "reviewed");
  assert.match(result.objective, /Preserve parser error offsets/);
  assert.match(result.objective, /Required validation evidence: Run the parser regression fixture/);
});

test("Coding rejects a promoted policy that attempts to reduce review rigor", () => {
  assert.throws(() => applyCodingImprovements({
    objective: "Change code.",
    snapshot: snapshot([{
      proposalId: "unsafe-policy",
      artifactType: "policy_patch",
      target: "coding.policy",
      artifactHash: "policy-hash",
      manifestHash: "policy-manifest",
      epoch: 2,
      patch: { reviewPolicy: "fast" },
    }]),
  }), /only raise reviewPolicy/);
});

test("Coding improvement runtime pins correlate an exact snapshot with its host generation", () => {
  const active = snapshot([{
    proposalId: "policy-proposal",
    artifactType: "policy_patch",
    target: "coding.policy",
    artifactHash: hashCanonical("policy-artifact"),
    manifestHash: hashCanonical("policy-manifest"),
    epoch: 2,
    patch: { maxParallel: 2, reviewPolicy: "reviewed" },
  }]);
  const pin = createCodingImprovementRuntimePin(active);
  assert.deepEqual(parseCodingImprovementRuntimePin(JSON.parse(JSON.stringify(pin))), pin);
  assert.deepEqual(codingImprovementRuntimeIdentity(pin), {
    snapshotHash: active.snapshotHash,
    generationId: pin.generationId,
  });
  assert.match(pin.generationId, /^runtime_generation_[a-f0-9]{28}$/);
  assert.throws(() => createCodingImprovementRuntimePin(
    active,
    "runtime_generation_0000000000000000000000000000",
  ), /Committed improvement runtime generation/);

  assert.throws(() => parseCodingImprovementRuntimePin({
    ...pin,
    generationId: "runtime_generation_0000000000000000000000000000",
  }), /generation does not match/);
  assert.throws(() => parseCodingImprovementRuntimePin({
    ...pin,
    snapshot: { ...pin.snapshot, snapshotHash: hashCanonical("changed") },
  }), /snapshot identity/);
});

test("Coding admits one canonical autonomous candidate only from a verified final report", () => {
  const output = {
    runId: "run-1",
    taskId: "final",
    nodeId: "node-author",
    outcomeId: "outcome-1",
    artifactId: "artifact-1",
    projectionKey: codingAcceptedOutputProjectionKey("final_report", "final"),
    outputKey: "final_report",
    kind: "json",
    contentHash: "a".repeat(64),
    mediaType: "application/json",
    byteLength: 1,
    value: JSON.stringify({
      status: "verified",
      improvementCandidate: {
        artifactType: "prompt_patch",
        target: "coding.prompt",
        patch: { instructions: ["Preserve exact parser offsets."] },
        rationale: "The same omission appeared in two parser tasks.",
        evidence: ["tests/parser-offset.test.ts failed before the focused fix"],
      },
    }),
  } as const;
  const candidate = codingAutonomousImprovementCandidate(output);
  assert.equal(candidate?.target, "coding.prompt");
  assert.equal(candidate?.patchJson, '{"instructions":["Preserve exact parser offsets."]}');
  assert.equal(codingAutonomousImprovementCandidate({ ...output, outputKey: "implementation_report" }), undefined);
  assert.equal(codingAutonomousImprovementCandidate({
    ...output,
    value: JSON.stringify({ status: "verified" }),
  }), undefined);
  assert.throws(() => codingAutonomousImprovementCandidate({
    ...output,
    value: JSON.stringify({
      status: "verified",
      improvementCandidate: {
        artifactType: "policy_patch",
        target: "coding.prompt",
        patch: { maxParallel: 2 },
        rationale: "Mismatch",
        evidence: ["evidence"],
      },
    }),
  }), /must target coding.policy/);
});

test("the autonomous Coding evaluator rejects policy widening and passes bounded canaries", () => {
  const passed = evaluateCodingImprovementArtifact({
    schemaVersion: "roster.improvement-artifact.v1",
    artifactType: "policy_patch",
    target: "coding.policy",
    patch: { maxParallel: 2, reviewPolicy: "reviewed" },
  }, "verification");
  assert.equal(passed.status, "passed");
  const failed = evaluateCodingImprovementArtifact({
    schemaVersion: "roster.improvement-artifact.v1",
    artifactType: "policy_patch",
    target: "coding.policy",
    patch: { reviewPolicy: "fast" },
  }, "canary");
  assert.equal(failed.status, "failed");
  assert.match(failed.report, /only raise reviewPolicy/);
});
