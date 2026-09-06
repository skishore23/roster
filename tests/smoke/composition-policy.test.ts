import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../../src/core/canonical.ts";
import {
  compositionModeForIntent,
  decideCompositionPolicy,
  type CompositionPolicyCandidate,
  verifyCompositionPolicyDecision,
} from "../../src/engine/orchestration/composition-policy.ts";
import {
  certifyComposition,
  createCompositionProposal,
} from "../../src/engine/orchestration/composition.ts";
import { createDomainRegistry } from "../../src/engine/orchestration/domain.ts";
import type { DomainPack } from "../../src/engine/orchestration/types.ts";

const candidate = (
  candidateId: string,
  options: Partial<CompositionPolicyCandidate> = {},
): CompositionPolicyCandidate => ({
  candidateId,
  nodeId: `${candidateId}-node`,
  role: candidateId === "baseline" ? "baseline" : "node",
  artifactRef: `artifact:${candidateId}`,
  artifactHash: sha256(candidateId),
  qualityScore: 90,
  originalityScore: 70,
  constraintStatus: "pass",
  evidence: [{
    id: `evidence-${candidateId}`,
    kind: "constraints",
    verdict: "pass",
  }],
  mechanismIds: [`mechanism-${candidateId}`],
  ...options,
});

test("composition intent selects an explicit policy instead of inferring from prompt text", () => {
  assert.equal(compositionModeForIntent("ideation"), "portfolio");
  assert.equal(compositionModeForIntent("convergent"), "validated-selection");
  assert.equal(compositionModeForIntent("synthesis"), "coverage-synthesis");
});

test("ideation preserves a bounded distinct portfolio and rejects unsafe challengers", () => {
  const decision = decideCompositionPolicy({
    intent: "ideation",
    baselineCandidateId: "baseline",
    requiredEvidenceKinds: ["constraints"],
    candidates: [
      candidate("baseline", { qualityScore: 90 }),
      candidate("thermal", { qualityScore: 91, mechanismIds: ["passive-cooling"] }),
      candidate("routing", { qualityScore: 90, mechanismIds: ["mutual-aid-routing"] }),
      candidate("thermal-copy", { qualityScore: 92, mechanismIds: ["passive-cooling"] }),
      candidate("challenger", {
        role: "challenger",
        qualityScore: 99,
        constraintStatus: "fail",
        evidence: [{ id: "unsafe", kind: "constraints", verdict: "fail" }],
      }),
    ],
    policy: { maxPortfolioSize: 2 },
  });

  assert.equal(decision.mode, "portfolio");
  assert.equal(decision.disposition, "portfolio-accepted");
  assert.deepEqual(decision.selectedCandidateIds, ["routing", "thermal-copy"]);
  assert.deepEqual(decision.retainedMechanismIds, ["mutual-aid-routing", "passive-cooling"]);
  const challenger = decision.evaluations.find((item) => item.candidateId === "challenger");
  assert.equal(challenger?.status, "rejected");
  assert.deepEqual(
    challenger?.reasons.map((reason) => reason.code),
    ["constraint-failed", "failed-evidence"],
  );
  assert.equal(
    decision.evaluations.find((item) => item.candidateId === "thermal")?.reasons[0]?.code,
    "duplicate-mechanism-portfolio",
  );
});

test("convergent selection is order-invariant and falls back on quality regression", () => {
  const candidates = [
    candidate("baseline", { qualityScore: 90 }),
    candidate("weak-team", { qualityScore: 88.9 }),
    candidate("invalid-team", {
      qualityScore: 100,
      evidence: [{ id: "check", kind: "constraints", verdict: "inconclusive" }],
    }),
  ];
  const forward = decideCompositionPolicy({
    intent: "convergent",
    baselineCandidateId: "baseline",
    requiredEvidenceKinds: ["constraints"],
    candidates,
  });
  const reversed = decideCompositionPolicy({
    intent: "convergent",
    baselineCandidateId: "baseline",
    requiredEvidenceKinds: ["constraints"],
    candidates: [...candidates].reverse(),
  });

  assert.deepEqual(reversed, forward);
  assert.equal(forward.disposition, "baseline-fallback");
  assert.deepEqual(forward.selectedCandidateIds, ["baseline"]);
  assert.equal(
    forward.evaluations.find((item) => item.candidateId === "weak-team")?.reasons[0]?.code,
    "quality-regression",
  );
  assert.equal(
    forward.evaluations.find((item) => item.candidateId === "invalid-team")?.reasons[0]?.code,
    "failed-evidence",
  );
});

test("convergent selection accepts the best validated non-inferior candidate", () => {
  const decision = decideCompositionPolicy({
    intent: "convergent",
    baselineCandidateId: "baseline",
    requiredEvidenceKinds: ["constraints"],
    candidates: [
      candidate("baseline", { qualityScore: 90 }),
      candidate("alpha", { qualityScore: 91, originalityScore: 72 }),
      candidate("beta", { qualityScore: 91, originalityScore: 75 }),
    ],
  });

  assert.equal(decision.disposition, "team-accepted");
  assert.deepEqual(decision.selectedCandidateIds, ["beta"]);
  assert.equal(
    decision.evaluations.find((item) => item.candidateId === "alpha")?.reasons[0]?.code,
    "lower-ranked",
  );
});

test("synthesis requires plural sources, declared coverage, and mechanism retention", () => {
  const requiredSourceNodeIds = ["explorer-a", "explorer-b", "challenger"];
  const requiredMechanismIds = ["heat-transfer", "privacy-route", "failure-check"];
  const strong = candidate("strong-synthesis", {
    role: "synthesis",
    nodeId: "composer",
    qualityScore: 90,
    sourceCandidateIds: ["proposal-a", "proposal-b", "proposal-c"],
    mechanismIds: ["heat-transfer", "privacy-route"],
  });
  const weak = candidate("single-source-synthesis", {
    role: "synthesis",
    nodeId: "composer",
    qualityScore: 99,
    sourceCandidateIds: ["proposal-a"],
    mechanismIds: ["heat-transfer"],
  });
  const forged = candidate("forged-synthesis", {
    role: "synthesis",
    nodeId: "composer",
    qualityScore: 100,
    sourceCandidateIds: ["proposal-a", "proposal-b", "proposal-c"],
    mechanismIds: ["heat-transfer", "invented-mechanism"],
  });
  const decision = decideCompositionPolicy({
    intent: "synthesis",
    baselineCandidateId: "baseline",
    requiredEvidenceKinds: ["constraints"],
    requiredSourceNodeIds,
    requiredMechanismIds,
    candidates: [
      candidate("baseline", { qualityScore: 90 }),
      candidate("proposal-a", { nodeId: "explorer-a", mechanismIds: ["heat-transfer"] }),
      candidate("proposal-b", { nodeId: "explorer-b", mechanismIds: ["privacy-route"] }),
      candidate("proposal-c", {
        nodeId: "challenger",
        role: "challenger",
        mechanismIds: ["failure-check"],
      }),
      weak,
      forged,
      strong,
    ],
  });

  assert.equal(decision.disposition, "team-accepted");
  assert.deepEqual(decision.selectedCandidateIds, ["strong-synthesis"]);
  assert.equal(decision.sourceCoverage, 1);
  assert.equal(decision.mechanismRetention, 2 / 3);
  assert.deepEqual(
    decision.evaluations
      .find((item) => item.candidateId === "single-source-synthesis")
      ?.reasons.map((reason) => reason.code),
    [
      "insufficient-source-plurality",
      "insufficient-source-coverage",
      "insufficient-mechanism-retention",
    ],
  );
  assert.equal(
    decision.evaluations.find((item) => item.candidateId === "proposal-a")?.reasons[0]?.code,
    "source-only",
  );
  assert.equal(
    decision.evaluations.find((item) => item.candidateId === "forged-synthesis")?.reasons[0]?.code,
    "unproven-mechanism",
  );
});

test("synthesis falls back rather than accepting a shallow single-source rewrite", () => {
  const decision = decideCompositionPolicy({
    intent: "synthesis",
    baselineCandidateId: "baseline",
    requiredEvidenceKinds: ["constraints"],
    requiredSourceNodeIds: ["explorer-a", "explorer-b", "challenger"],
    requiredMechanismIds: ["a", "b", "c", "d"],
    candidates: [
      candidate("baseline", { qualityScore: 90 }),
      candidate("proposal-a", { nodeId: "explorer-a", mechanismIds: ["a", "b"] }),
      candidate("shallow", {
        role: "synthesis",
        nodeId: "composer",
        qualityScore: 95,
        sourceCandidateIds: ["proposal-a", "proposal-copy"],
        mechanismIds: ["a", "b"],
      }),
    ],
  });

  assert.equal(decision.disposition, "baseline-fallback");
  assert.deepEqual(decision.selectedCandidateIds, ["baseline"]);
  assert.deepEqual(
    decision.evaluations
      .find((item) => item.candidateId === "shallow")
      ?.reasons.map((reason) => reason.code),
    [
      "unknown-source-candidate",
      "insufficient-source-plurality",
      "insufficient-source-coverage",
    ],
  );
});

test("composition fails closed when both collaboration and baseline are invalid", () => {
  const decision = decideCompositionPolicy({
    intent: "convergent",
    baselineCandidateId: "baseline",
    requiredEvidenceKinds: ["constraints"],
    candidates: [
      candidate("baseline", { constraintStatus: "inconclusive" }),
      candidate("team", { constraintStatus: "fail" }),
    ],
  });

  assert.equal(decision.disposition, "no-qualified-output");
  assert.deepEqual(decision.selectedCandidateIds, []);
});

test("composition rejects ambiguous or unbounded frontiers", () => {
  assert.throws(() => decideCompositionPolicy({
    intent: "ideation",
    baselineCandidateId: "baseline",
    candidates: [candidate("baseline"), candidate("baseline")],
  }), /candidate IDs must be unique/);
  assert.throws(() => decideCompositionPolicy({
    intent: "ideation",
    baselineCandidateId: "baseline",
    candidates: Array.from({ length: 33 }, (_, index) =>
      candidate(index === 0 ? "baseline" : `candidate-${String(index)}`)),
  }), /1 through 32/);
});

test("certification rejects an unselected candidate and records the accepted policy decision", () => {
  const pack: DomainPack = {
    id: "composition-policy-test",
    version: "1",
    policyVersion: "composition-policy-test-v1",
    coordinatorId: "composer",
    capabilities: [{ id: "compose", description: "Compose a result." }],
    nodes: [{
      id: "composer",
      name: "Composer",
      capabilities: ["compose"],
      runtime: { kind: "roster-native", profile: "composer" },
    }],
    limits: { maxNodes: 2, maxTasks: 4, maxParallel: 1, maxDepth: 2 },
  };
  const decision = decideCompositionPolicy({
    intent: "convergent",
    baselineCandidateId: "baseline",
    requiredEvidenceKinds: ["constraints"],
    candidates: [
      candidate("baseline", { qualityScore: 90 }),
      candidate("team", { qualityScore: 92, artifactHash: sha256("Validated output") }),
    ],
  });
  assert.equal(verifyCompositionPolicyDecision(decision), true);
  const contract = {
    compositionId: "final",
    planVersion: "plan-v1",
    boundaryHash: "boundary",
    inputVersions: { brief: "brief-v1" },
    requiredEvidenceKinds: ["constraints"],
  };
  const proposal = createCompositionProposal({
    compositionId: "final",
    planVersion: "plan-v1",
    nodeId: "composer",
    capability: "compose",
    boundaryHash: "boundary",
    inputVersions: { brief: "brief-v1" },
    content: "Validated output",
    evidence: [{ id: "constraints", kind: "constraints", verdict: "pass" }],
  });
  const registry = createDomainRegistry(pack);
  const rejected = certifyComposition({
    registry,
    contract,
    proposal,
    selection: { decision, candidateId: "baseline" },
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "policy_rejected");

  const accepted = certifyComposition({
    registry,
    contract,
    proposal,
    selection: { decision, candidateId: "team" },
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.certification.compositionPolicyDecisionId, decision.decisionId);
    assert.equal(accepted.certification.compositionPolicyCandidateId, "team");
  }

  const mismatchedProposal = createCompositionProposal({
    compositionId: "final",
    planVersion: "plan-v1",
    nodeId: "composer",
    capability: "compose",
    boundaryHash: "boundary",
    inputVersions: { brief: "brief-v1" },
    content: "Different output",
    evidence: [{ id: "constraints", kind: "constraints", verdict: "pass" }],
  });
  const mismatched = certifyComposition({
    registry,
    contract,
    proposal: mismatchedProposal,
    selection: { decision, candidateId: "team" },
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.equal(mismatched.reason, "policy_rejected");

  const corrupted = certifyComposition({
    registry,
    contract,
    proposal,
    selection: {
      decision: { ...decision, rationale: "mutated after decision" },
      candidateId: "team",
    },
  });
  assert.equal(corrupted.ok, false);
  if (!corrupted.ok) assert.match(corrupted.detail, /integrity validation/);
});
