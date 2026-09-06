import { hashCanonical } from "../../core/canonical.js";
import type { HarnessResult } from "./improvement-harness.js";
import {
  assertImprovementTargetBaseline,
  type ImprovementArtifactDocument,
  SelfImprovementFramework,
} from "./self-improvement-framework.js";
import type {
  ImprovementArtifactType,
  ImprovementProposalSource,
  ProposalRecord,
  SelfImprovementEvent,
  SelfImprovementState,
} from "../../modules/self-improvement.js";
import { projectRuntimeExtensionRollout } from "./runtime-extension-rollout.js";

const POLICY_VERSION = "roster.autonomous-self-improvement.v1";

const AUTHORITIES = Object.freeze({
  verifier: "roster.policy.improvement-verifier",
  canary: "roster.policy.improvement-canary",
  promoter: "roster.policy.improvement-promoter",
  rejector: "roster.policy.improvement-rejector",
  rollback: "roster.policy.improvement-rollback",
});

type EvaluationPhase = "verification" | "canary";

export type AutonomousImprovementEvaluation = (
  artifact: ImprovementArtifactDocument,
  phase: EvaluationPhase,
) => Promise<HarnessResult>;

export type AutonomousSelfImprovementResult = {
  readonly proposalId: string;
  readonly status: ProposalRecord["status"];
  readonly generationId?: string;
};

const authorizationHash = (
  role: keyof typeof AUTHORITIES,
  proposal: ProposalRecord,
  evidenceHash: string,
): string => hashCanonical({
  schemaVersion: POLICY_VERSION,
  role,
  authorityId: AUTHORITIES[role],
  proposalId: proposal.id,
  artifactHash: proposal.artifact.contentHash,
  evidenceHash,
});

const head = (proposal: ProposalRecord): string => proposal.rolloutHistory.at(-1)!.recordId;

export class AutonomousSelfImprovementController {
  readonly #framework: SelfImprovementFramework;
  readonly #state: () => Promise<SelfImprovementState>;
  readonly #emit: (event: SelfImprovementEvent) => Promise<void>;
  readonly #emitTransition: (
    event: Extract<SelfImprovementEvent, { readonly type: "proposal.transitioned" }>,
    expectedRecordId: string,
    validate?: (state: SelfImprovementState, proposal: ProposalRecord) => void,
  ) => Promise<void>;
  readonly #evaluate: AutonomousImprovementEvaluation;
  readonly #rollbackFailureThreshold: number;

  constructor(input: {
    readonly framework: SelfImprovementFramework;
    readonly state: () => Promise<SelfImprovementState>;
    readonly emit: (event: SelfImprovementEvent) => Promise<void>;
    readonly emitTransition: (
      event: Extract<SelfImprovementEvent, { readonly type: "proposal.transitioned" }>,
      expectedRecordId: string,
      validate?: (state: SelfImprovementState, proposal: ProposalRecord) => void,
    ) => Promise<void>;
    readonly evaluate: AutonomousImprovementEvaluation;
    readonly rollbackFailureThreshold?: number;
  }) {
    this.#framework = input.framework;
    this.#state = input.state;
    this.#emit = input.emit;
    this.#emitTransition = input.emitTransition;
    this.#evaluate = input.evaluate;
    this.#rollbackFailureThreshold = input.rollbackFailureThreshold ?? 2;
    if (!Number.isSafeInteger(this.#rollbackFailureThreshold) || this.#rollbackFailureThreshold < 1) {
      throw new Error("Autonomous improvement rollback threshold must be a positive safe integer");
    }
  }

  async admit(input: {
    readonly proposalId: string;
    readonly artifactType: ImprovementArtifactType;
    readonly target: string;
    readonly patch: string;
    readonly source: ImprovementProposalSource;
  }): Promise<AutonomousSelfImprovementResult> {
    const state = await this.#state();
    if (!state.proposals[input.proposalId]) {
      await this.#emit(await this.#framework.createProposalEvent({ ...input, state }));
    }
    return this.advance(input.proposalId);
  }

  async resumeAll(): Promise<ReadonlyArray<AutonomousSelfImprovementResult>> {
    const state = await this.#state();
    const resumable = Object.values(state.proposals)
      .filter((proposal) => ["proposed", "verified", "warming", "canary"].includes(proposal.status))
      .sort((left, right) => left.id.localeCompare(right.id));
    const results: AutonomousSelfImprovementResult[] = [];
    for (const proposal of resumable) results.push(await this.advance(proposal.id));
    return Object.freeze(results);
  }

  async advance(proposalId: string): Promise<AutonomousSelfImprovementResult> {
    for (let transition = 0; transition < 6; transition += 1) {
      const state = await this.#state();
      const proposal = state.proposals[proposalId];
      if (!proposal) throw new Error(`Autonomous improvement proposal ${proposalId} does not exist`);
      if (proposal.status === "rejected" || proposal.status === "promoted" || proposal.status === "rollback-forward") {
        return { proposalId, status: proposal.status, ...(proposal.generationId ? { generationId: proposal.generationId } : {}) };
      }

      if (proposal.status === "proposed") {
        const artifact = await this.#framework.artifact(proposal);
        const evaluation = await this.#evaluate(artifact, "verification");
        const expectedRecordId = head(proposal);
        await this.#emitTransition(this.#framework.verificationEvent({
          proposal,
          expectedRecordId,
          validatorId: AUTHORITIES.verifier,
          authorizationHash: authorizationHash("verifier", proposal, evaluation.evidenceHash),
          authorityKind: "deterministic-policy",
          status: evaluation.status,
          report: evaluation.report,
          evidenceHash: evaluation.evidenceHash,
        }), expectedRecordId);
        continue;
      }

      if (proposal.status === "verified") {
        const expectedRecordId = head(proposal);
        await this.#emitTransition(
          await this.#framework.warmingEvent(proposal, expectedRecordId),
          expectedRecordId,
        );
        continue;
      }

      if (proposal.status === "warming") {
        const artifact = await this.#framework.artifact(proposal);
        const evaluation = await this.#evaluate(artifact, "canary");
        const expectedRecordId = head(proposal);
        const canary = this.#framework.canaryEvent({
          proposal,
          expectedRecordId,
          canaryBy: AUTHORITIES.canary,
          authorizationHash: authorizationHash("canary", proposal, evaluation.evidenceHash),
          authorityKind: "deterministic-policy",
          evidence: [{
            canaryId: `canary_${evaluation.evidenceHash.slice(0, 28)}`,
            outcomeHash: evaluation.evidenceHash,
            verdict: evaluation.status,
            tasks: 1,
            tokens: 0,
            costMicros: 0,
            wallTimeMs: evaluation.wallTimeMs,
          }],
        });
        await this.#emitTransition(canary, expectedRecordId);
        if (evaluation.status === "failed") {
          const current = (await this.#state()).proposals[proposalId]!;
          const currentHead = head(current);
          await this.#emitTransition(this.#framework.rejectionEvent({
            proposal: current,
            expectedRecordId: currentHead,
            rejectedBy: AUTHORITIES.rejector,
            authorizationHash: authorizationHash("rejector", current, evaluation.evidenceHash),
            authorityKind: "deterministic-policy",
            reason: "autonomous canary failed",
            evidenceHash: evaluation.evidenceHash,
          }), currentHead);
        }
        continue;
      }

      if (proposal.status === "canary") {
        const rollout = projectRuntimeExtensionRollout(proposal.rolloutHistory);
        const evidenceHash = hashCanonical({
          schemaVersion: POLICY_VERSION,
          proposalId,
          canaryEvidence: rollout.canaryEvidence,
        });
        try {
          assertImprovementTargetBaseline(state, proposal);
        } catch (error) {
          const expectedRecordId = head(proposal);
          await this.#emitTransition(this.#framework.rejectionEvent({
            proposal,
            expectedRecordId,
            rejectedBy: AUTHORITIES.rejector,
            authorizationHash: authorizationHash("rejector", proposal, evidenceHash),
            authorityKind: "deterministic-policy",
            reason: error instanceof Error ? error.message : "autonomous target baseline changed",
            evidenceHash,
          }), expectedRecordId);
          continue;
        }
        const expectedRecordId = head(proposal);
        const promoted = await this.#framework.promotionEvent({
          state,
          proposal,
          expectedRecordId,
          promoterId: AUTHORITIES.promoter,
          authorizationHash: authorizationHash("promoter", proposal, evidenceHash),
          authorityKind: "deterministic-policy",
          evidenceHash,
        });
        await this.#emitTransition(promoted, expectedRecordId, assertImprovementTargetBaseline);
        await this.#framework.reconcile(await this.#state());
      }
    }
    throw new Error(`Autonomous improvement ${proposalId} exceeded its bounded transition count`);
  }

  async observe(input: {
    readonly proposalId: string;
    readonly runId: string;
    readonly verdict: "passed" | "failed";
    readonly evidenceHash: string;
    readonly observedAt: number;
  }): Promise<AutonomousSelfImprovementResult | undefined> {
    let state = await this.#state();
    let proposal = state.proposals[input.proposalId];
    if (!proposal || proposal.status !== "promoted") return undefined;
    const observationId = `improvement_observation_${hashCanonical({
      schemaVersion: POLICY_VERSION,
      proposalId: input.proposalId,
      runId: input.runId,
      verdict: input.verdict,
      evidenceHash: input.evidenceHash,
    }).slice(0, 28)}`;
    if (!proposal.observations.some((observation) => observation.observationId === observationId)) {
      await this.#emit({
        type: "deployment.observed",
        proposalId: input.proposalId,
        observation: Object.freeze({ observationId, ...input }),
      });
    }
    state = await this.#state();
    proposal = state.proposals[input.proposalId];
    if (!proposal || proposal.status !== "promoted") return undefined;
    const failures = proposal.observations.filter((observation) => observation.verdict === "failed");
    if (failures.length < this.#rollbackFailureThreshold) {
      return { proposalId: proposal.id, status: proposal.status, ...(proposal.generationId ? { generationId: proposal.generationId } : {}) };
    }
    const rollbackEvidence = hashCanonical({
      schemaVersion: POLICY_VERSION,
      proposalId: proposal.id,
      threshold: this.#rollbackFailureThreshold,
      failures: failures.map(({ observationId, evidenceHash }) => ({ observationId, evidenceHash })),
    });
    const expectedRecordId = head(proposal);
    const rollback = await this.#framework.rollbackEvent({
      state,
      proposal,
      expectedRecordId,
      authorityId: AUTHORITIES.rollback,
      authorizationHash: authorizationHash("rollback", proposal, rollbackEvidence),
      authorityKind: "deterministic-policy",
      reason: `${failures.length} admitted Coding runs failed while pinned to this improvement`,
      evidenceHash: rollbackEvidence,
    });
    await this.#emitTransition(rollback, expectedRecordId);
    await this.#framework.reconcile(await this.#state());
    const current = (await this.#state()).proposals[proposal.id]!;
    return { proposalId: current.id, status: current.status, ...(current.generationId ? { generationId: current.generationId } : {}) };
  }
}
