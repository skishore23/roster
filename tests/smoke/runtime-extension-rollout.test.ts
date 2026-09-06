import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeEmissionClassification } from "../../src/engine/runtime/runtime-emission.ts";
import {
  createRuntimeExtensionRolloutProposal,
  projectRuntimeExtensionRollout,
  promoteRuntimeExtensionRollout,
  recordRuntimeExtensionCanary,
  rejectRuntimeExtensionRollout,
  rollbackRuntimeExtensionRolloutForward,
  verifyRuntimeExtensionRollout,
  warmRuntimeExtensionRollout,
  type RuntimeExtensionCanaryEvidence,
  type RuntimeExtensionRolloutAuthority,
  type RuntimeExtensionRolloutBudget,
  type RuntimeExtensionRolloutProposal,
  type RuntimeExtensionRolloutRecord,
} from "../../src/engine/runtime/runtime-extension-rollout.ts";

const OPERATOR: RuntimeExtensionRolloutAuthority = {
  authorityId: "operator-1",
  kind: "human",
  authorizationHash: "operator-approval-sha256",
};

const VERIFIER: RuntimeExtensionRolloutAuthority = {
  authorityId: "verification-policy",
  kind: "deterministic-policy",
  authorizationHash: "verification-policy-sha256",
};

const CANARY_OPERATOR: RuntimeExtensionRolloutAuthority = {
  authorityId: "canary-operator",
  kind: "human",
  authorizationHash: "canary-operator-sha256",
};

const ROLLBACK_OPERATOR: RuntimeExtensionRolloutAuthority = {
  authorityId: "rollback-operator",
  kind: "human",
  authorizationHash: "rollback-operator-sha256",
};

const budget = (overrides: Partial<RuntimeExtensionRolloutBudget> = {}): RuntimeExtensionRolloutBudget => ({
  maxCanaryRuns: 4,
  maxTasks: 8,
  maxTokens: 20_000,
  maxCostMicros: 2_000_000,
  maxWallTimeMs: 60_000,
  ...overrides,
});

const proposalInput = (
  overrides: Partial<RuntimeExtensionRolloutProposal> = {},
): RuntimeExtensionRolloutProposal => ({
  extensionId: "runtime.search",
  artifactHash: "artifact-candidate-sha256",
  manifestHash: "manifest-candidate-sha256",
  proposerId: "extension-author",
  baselineEpoch: 7,
  targetEpoch: 8,
  lastKnownGoodArtifactHash: "artifact-stable-sha256",
  lastKnownGoodManifestHash: "manifest-stable-sha256",
  baselineAuthority: {
    functionGrants: ["repository.read", "repository.search"],
    scopes: ["repository:read"],
    allowedEffects: ["read"],
    workspaceOperations: ["read"],
    allowGraphExpansion: false,
  },
  candidateAuthority: {
    functionGrants: ["repository.search"],
    scopes: ["repository:read"],
    allowedEffects: ["read"],
    workspaceOperations: ["read"],
    allowGraphExpansion: false,
  },
  baselineBudget: budget(),
  candidateBudget: budget({ maxCanaryRuns: 2, maxTasks: 4, maxTokens: 10_000 }),
  emission: createRuntimeEmissionClassification({ kind: "no-emission" }),
  ...overrides,
});

const canaryEvidence = (
  overrides: Partial<RuntimeExtensionCanaryEvidence> = {},
): RuntimeExtensionCanaryEvidence => ({
  canaryId: "canary-1",
  outcomeHash: "canary-outcome-sha256",
  verdict: "passed",
  tasks: 2,
  tokens: 2_000,
  costMicros: 200_000,
  wallTimeMs: 5_000,
  ...overrides,
});

const reachCanary = (
  proposal = createRuntimeExtensionRolloutProposal(proposalInput()),
  evidence: ReadonlyArray<RuntimeExtensionCanaryEvidence> = [canaryEvidence()],
): RuntimeExtensionRolloutRecord[] => {
  const history = [proposal];
  history.push(verifyRuntimeExtensionRollout(history, {
    authority: VERIFIER,
    evidenceHash: "verification-evidence-sha256",
  }));
  history.push(warmRuntimeExtensionRollout(history, {
    evidenceHash: "warming-evidence-sha256",
  }));
  history.push(recordRuntimeExtensionCanary(history, { authority: CANARY_OPERATOR, evidence }));
  return history;
};

test("governed rollout promotes an exact candidate and replays deterministically", () => {
  const history = reachCanary();
  history.push(promoteRuntimeExtensionRollout(history, {
    authority: OPERATOR,
    evidenceHash: "promotion-evidence-sha256",
  }));

  const projection = projectRuntimeExtensionRollout(history);
  assert.equal(projection.status, "promoted");
  assert.equal(projection.currentEpoch, 8);
  assert.equal(projection.currentArtifactHash, "artifact-candidate-sha256");
  assert.equal(projection.currentManifestHash, "manifest-candidate-sha256");
  assert.equal(projection.promotionAuthority?.authorityId, OPERATOR.authorityId);
  assert.equal(projection.canaryAuthority?.authorityId, CANARY_OPERATOR.authorityId);
  assert.equal(projection.recordIds.length, 5);

  const reorderedWithDuplicate = [
    history[4]!,
    history[2]!,
    history[0]!,
    history[3]!,
    history[1]!,
    history[3]!,
  ];
  assert.deepEqual(projectRuntimeExtensionRollout(reorderedWithDuplicate), projection);
  assert.deepEqual(
    createRuntimeExtensionRolloutProposal(proposalInput()),
    createRuntimeExtensionRolloutProposal(proposalInput()),
  );
});

test("promotion requires independent authority and never accepts self-promotion", () => {
  const history = reachCanary();
  assert.throws(() => promoteRuntimeExtensionRollout(history, {
    authority: {
      authorityId: "extension-author",
      kind: "human",
      authorizationHash: "self-approval-sha256",
    },
    evidenceHash: "promotion-evidence-sha256",
  }), /requires independent authority and forbids self-promotion/);

  const extensionSelf = reachCanary(createRuntimeExtensionRolloutProposal(proposalInput({
    proposerId: "another-author",
  })));
  assert.throws(() => promoteRuntimeExtensionRollout(extensionSelf, {
    authority: {
      authorityId: "runtime.search",
      kind: "deterministic-policy",
      authorizationHash: "extension-self-approval-sha256",
    },
    evidenceHash: "promotion-evidence-sha256",
  }), /requires independent authority and forbids self-promotion/);

  assert.throws(() => promoteRuntimeExtensionRollout(history, {
    authority: VERIFIER,
    evidenceHash: "promotion-evidence-sha256",
  }), /must be independent from verification authority/);
  assert.throws(() => promoteRuntimeExtensionRollout(history, {
    authority: CANARY_OPERATOR,
    evidenceHash: "promotion-evidence-sha256",
  }), /must be independent from canary authority/);

  const extensionVerification = [createRuntimeExtensionRolloutProposal(proposalInput({
    proposerId: "another-author",
  }))];
  assert.throws(() => verifyRuntimeExtensionRollout(extensionVerification, {
    authority: {
      authorityId: "runtime.search",
      kind: "deterministic-policy",
      authorizationHash: "extension-self-verification-sha256",
    },
    evidenceHash: "verification-evidence-sha256",
  }), /requires independent authority and forbids self-promotion/);
});

test("proposal rejects authority widening, budget widening, and nonrepeatable canaries", () => {
  assert.throws(() => createRuntimeExtensionRolloutProposal(proposalInput({
    candidateAuthority: {
      ...proposalInput().candidateAuthority,
      allowedEffects: ["read", "external"],
    },
  })), /widens allowed effects/);
  assert.throws(() => createRuntimeExtensionRolloutProposal(proposalInput({
    candidateBudget: budget({ maxTokens: 20_001 }),
  })), /widens budget maxTokens/);
  assert.throws(() => createRuntimeExtensionRolloutProposal(proposalInput({
    emission: createRuntimeEmissionClassification({ kind: "immediate-nonrepeatable" }),
  })), /prohibit immediate-nonrepeatable emissions/);
});

test("canary evidence is bounded and failed evidence cannot be promoted", () => {
  const proposal = createRuntimeExtensionRolloutProposal(proposalInput());
  const beforeCanary = reachCanary(proposal).slice(0, 3);
  assert.throws(() => recordRuntimeExtensionCanary(beforeCanary, {
    authority: CANARY_OPERATOR,
    evidence: [
      canaryEvidence({ canaryId: "canary-1" }),
      canaryEvidence({ canaryId: "canary-2" }),
      canaryEvidence({ canaryId: "canary-3" }),
    ],
  }), /exceeds its bounded run count/);
  assert.throws(() => recordRuntimeExtensionCanary(beforeCanary, {
    authority: CANARY_OPERATOR,
    evidence: [canaryEvidence({ tokens: 10_001 })],
  }), /exceeds its candidate budget/);

  const failedHistory = reachCanary(proposal, [canaryEvidence({ verdict: "failed" })]);
  assert.throws(() => promoteRuntimeExtensionRollout(failedHistory, {
    authority: OPERATOR,
    evidenceHash: "promotion-evidence-sha256",
  }), /cannot promote failed canary evidence/);
});

test("rollback is a forward higher-epoch deployment and retains promoted history", () => {
  const history = reachCanary();
  history.push(promoteRuntimeExtensionRollout(history, {
    authority: OPERATOR,
    evidenceHash: "promotion-evidence-sha256",
  }));
  assert.throws(() => rollbackRuntimeExtensionRolloutForward(history, {
    authority: ROLLBACK_OPERATOR,
    epoch: 8,
    reason: "Canary regression appeared after promotion.",
    evidenceHash: "rollback-evidence-sha256",
  }), /must use a higher epoch/);
  assert.throws(() => rollbackRuntimeExtensionRolloutForward(history, {
    authority: OPERATOR,
    epoch: 9,
    reason: "Promotion authority cannot approve its own rollback.",
    evidenceHash: "dependent-rollback-evidence-sha256",
  }), /independent from prior rollout authorities/);

  history.push(rollbackRuntimeExtensionRolloutForward(history, {
    authority: ROLLBACK_OPERATOR,
    epoch: 9,
    reason: "Canary regression appeared after promotion.",
    evidenceHash: "rollback-evidence-sha256",
  }));
  const projection = projectRuntimeExtensionRollout(history);
  assert.equal(projection.status, "rollback-forward");
  assert.equal(projection.currentEpoch, 9);
  assert.equal(projection.currentArtifactHash, "artifact-stable-sha256");
  assert.equal(projection.currentManifestHash, "manifest-stable-sha256");
  assert.equal(projection.recordIds.length, 6);
  assert.equal(history.some(({ body }) => body.type === "promoted"), true);
  assert.equal(history.some(({ body }) => body.type === "rollback-forward"), true);
});

test("rejection is terminal forward evidence", () => {
  const proposal = createRuntimeExtensionRolloutProposal(proposalInput());
  const history = [proposal];
  history.push(rejectRuntimeExtensionRollout(history, {
    authority: OPERATOR,
    reason: "Verification evidence was insufficient.",
    evidenceHash: "rejection-evidence-sha256",
  }));
  const projection = projectRuntimeExtensionRollout(history);
  assert.equal(projection.status, "rejected");
  assert.equal(projection.currentArtifactHash, "artifact-stable-sha256");
  assert.equal(projection.recordIds.length, 2);
  assert.throws(() => verifyRuntimeExtensionRollout(history, {
    authority: VERIFIER,
    evidenceHash: "late-verification-sha256",
  }), /can verify only a proposed candidate/);
});
