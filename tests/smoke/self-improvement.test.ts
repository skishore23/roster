import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileSystemDataReferenceStore } from "../../src/engine/dataflow/filesystem-data-reference-store.ts";
import { SelfImprovementFramework } from "../../src/engine/runtime/self-improvement-framework.ts";
import { AutonomousSelfImprovementController } from "../../src/engine/runtime/autonomous-self-improvement.ts";
import {
  initial,
  reduce,
  type SelfImprovementEvent,
  type SelfImprovementState,
} from "../../src/modules/self-improvement.ts";

test("self-improvement runs an immutable verified/canary/promote/rollback-forward lifecycle", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roster-self-improvement-"));
  const framework = new SelfImprovementFramework({
    artifacts: createFileSystemDataReferenceStore({ directory, namespace: "self-improvement-test" }),
  });
  let state: SelfImprovementState = initial;
  let timestamp = 0;
  const apply = (event: SelfImprovementEvent): void => {
    state = reduce(state, event, ++timestamp);
  };
  try {
    apply(await framework.createProposalEvent({
      state,
      proposalId: "proposal-1",
      artifactType: "policy_patch",
      target: "coding.policy",
      patch: JSON.stringify({ maxParallel: 2, reviewPolicy: "reviewed" }),
      source: { kind: "operator", actorId: "researcher" },
    }));
    let proposal = state.proposals["proposal-1"]!;
    const proposedRecordId = proposal.rolloutHistory.at(-1)!.recordId;
    apply(framework.verificationEvent({
      proposal,
      expectedRecordId: proposedRecordId,
      validatorId: "verifier",
      authorizationHash: "auth-verifier",
      status: "passed",
      report: "isolated verification passed",
      evidenceHash: "verification-evidence",
    }));
    proposal = state.proposals["proposal-1"]!;
    await assert.rejects(
      framework.warmingEvent(proposal, proposedRecordId),
      /rollout head is stale/,
    );
    apply(await framework.warmingEvent(proposal, proposal.rolloutHistory.at(-1)!.recordId));
    proposal = state.proposals["proposal-1"]!;
    assert.throws(() => framework.canaryEvent({
      proposal,
      expectedRecordId: proposal.rolloutHistory.at(-1)!.recordId,
      canaryBy: "verifier",
      authorizationHash: "auth-verifier",
      evidence: [{
        canaryId: "dependent-canary",
        outcomeHash: "dependent-canary-outcome",
        verdict: "passed",
        tasks: 1,
        tokens: 0,
        costMicros: 0,
        wallTimeMs: 10,
      }],
    }), /canary authority must be independent from verification authority/);
    apply(framework.canaryEvent({
      proposal,
      expectedRecordId: proposal.rolloutHistory.at(-1)!.recordId,
      canaryBy: "canary-operator",
      authorizationHash: "auth-canary",
      evidence: [{
        canaryId: "canary-1",
        outcomeHash: "canary-outcome",
        verdict: "passed",
        tasks: 1,
        tokens: 0,
        costMicros: 0,
        wallTimeMs: 10,
      }],
    }));
    proposal = state.proposals["proposal-1"]!;
    await assert.rejects(framework.promotionEvent({
      state: {
        ...state,
        activeByTarget: {
          "coding.policy": {
            proposalId: "concurrent-proposal",
            artifact: proposal.artifact,
            manifestHash: "concurrent-manifest",
            epoch: 2,
            generationId: "concurrent-generation",
          },
        },
      },
      proposal,
      expectedRecordId: proposal.rolloutHistory.at(-1)!.recordId,
      promoterId: "promoter",
      authorizationHash: "auth-promoter",
      evidenceHash: "promotion-evidence",
    }), /target baseline is stale/);
    apply(await framework.promotionEvent({
      state,
      proposal,
      expectedRecordId: proposal.rolloutHistory.at(-1)!.recordId,
      promoterId: "promoter",
      authorizationHash: "auth-promoter",
      evidenceHash: "promotion-evidence",
    }));
    const active = await framework.reconcile(state);
    assert.equal(state.proposals["proposal-1"]?.status, "promoted");
    assert.equal(active.improvements[0]?.patch && typeof active.improvements[0].patch === "object", true);
    assert.equal(framework.snapshot().snapshotHash, active.snapshotHash);

    proposal = state.proposals["proposal-1"]!;
    apply(await framework.rollbackEvent({
      state,
      proposal,
      expectedRecordId: proposal.rolloutHistory.at(-1)!.recordId,
      authorityId: "rollback-operator",
      authorizationHash: "auth-rollback",
      reason: "canary regression",
      evidenceHash: "rollback-evidence",
    }));
    await framework.reconcile(state);
    assert.equal(state.proposals["proposal-1"]?.status, "rollback-forward");
    assert.equal(state.proposals["proposal-1"]?.rolloutHistory.length, 6);
    assert.deepEqual(state.activeByTarget, {});
    assert.deepEqual(framework.snapshot().improvements, []);
  } finally {
    await framework.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Coding accepted-output provenance cannot verify or promote its own improvement", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roster-self-improvement-auth-"));
  const framework = new SelfImprovementFramework({
    artifacts: createFileSystemDataReferenceStore({ directory, namespace: "self-improvement-auth" }),
  });
  try {
    let state = initial;
    state = reduce(state, await framework.createProposalEvent({
      state,
      proposalId: "proposal-auth",
      artifactType: "prompt_patch",
      target: "coding.prompt",
      patch: JSON.stringify({ instructions: ["Keep exact replay evidence."] }),
      source: {
        kind: "coding-certified-output",
        actorId: "coding:node-author",
        runId: "run-1",
        taskId: "task-1",
        nodeId: "node-author",
        outcomeId: "outcome-1",
        artifactId: "artifact-1",
        contentHash: "a".repeat(64),
      },
    }), 1);
    assert.equal(state.proposals["proposal-auth"]?.source.kind, "coding-certified-output");
    assert.throws(() => framework.verificationEvent({
      proposal: state.proposals["proposal-auth"]!,
      expectedRecordId: state.proposals["proposal-auth"]!.rolloutHistory.at(-1)!.recordId,
      validatorId: "coding:node-author",
      authorizationHash: "auth-author",
      status: "passed",
      report: "self review",
      evidenceHash: "evidence",
    }), /independent authority/);
  } finally {
    await framework.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("autonomous policy authorities verify, canary, promote, observe, and rollback-forward", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roster-autonomous-improvement-"));
  const framework = new SelfImprovementFramework({
    artifacts: createFileSystemDataReferenceStore({ directory, namespace: "autonomous-improvement" }),
  });
  let state: SelfImprovementState = initial;
  let timestamp = 0;
  const apply = async (event: SelfImprovementEvent): Promise<void> => {
    state = reduce(state, event, ++timestamp);
  };
  const controller = new AutonomousSelfImprovementController({
    framework,
    state: async () => state,
    emit: apply,
    emitTransition: async (event, expectedRecordId, validate) => {
      const proposal = state.proposals[event.proposalId]!;
      assert.equal(proposal.rolloutHistory.at(-1)?.recordId, expectedRecordId);
      validate?.(state, proposal);
      await apply(event);
    },
    evaluate: async (_artifact, phase) => ({
      status: "passed",
      checks: [{ name: phase, ok: true, detail: `${phase} passed` }],
      report: `${phase} passed`,
      evidenceHash: `${phase}-evidence`,
      wallTimeMs: 1,
    }),
    rollbackFailureThreshold: 2,
  });
  try {
    const promoted = await controller.admit({
      proposalId: "proposal-autonomous",
      artifactType: "prompt_patch",
      target: "coding.prompt",
      patch: JSON.stringify({ instructions: ["Preserve exact replay evidence."] }),
      source: {
        kind: "coding-certified-output",
        actorId: "coding:node-author",
        runId: "run-author",
        taskId: "task-author",
        nodeId: "node-author",
        outcomeId: "outcome-author",
        artifactId: "artifact-author",
        contentHash: "b".repeat(64),
      },
    });
    assert.equal(promoted.status, "promoted");
    const rollout = state.proposals["proposal-autonomous"]!.rolloutHistory;
    assert.deepEqual(rollout.flatMap((record) => record.body.type === "warming" ? [] : "authority" in record.body ? [record.body.authority.kind] : []), [
      "deterministic-policy",
      "deterministic-policy",
      "deterministic-policy",
    ]);
    await controller.observe({
      proposalId: "proposal-autonomous",
      runId: "run-failure-1",
      verdict: "failed",
      evidenceHash: "failure-1",
      observedAt: 10,
    });
    assert.equal(state.proposals["proposal-autonomous"]?.status, "promoted");
    await controller.observe({
      proposalId: "proposal-autonomous",
      runId: "run-failure-2",
      verdict: "failed",
      evidenceHash: "failure-2",
      observedAt: 11,
    });
    assert.equal(state.proposals["proposal-autonomous"]?.status, "rollback-forward");
    assert.equal(state.proposals["proposal-autonomous"]?.observations.length, 2);
    assert.deepEqual(state.activeByTarget, {});
  } finally {
    await framework.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
