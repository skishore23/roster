import { hashCanonical, sha256 } from "../../core/canonical.js";
import type { DomainRegistry } from "./types.js";
import {
  verifyCompositionPolicyDecision,
  type CompositionPolicyDecision,
} from "./composition-policy.js";

export type EvidenceVerdict = "pass" | "fail" | "inconclusive";

export type CompositionEvidence = {
  readonly id: string;
  readonly kind: string;
  readonly verdict: EvidenceVerdict;
  readonly artifactHash?: string;
};

export type CompositionContract = {
  readonly compositionId: string;
  readonly planVersion: string;
  readonly boundaryHash: string;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly requiredEvidenceKinds?: ReadonlyArray<string>;
  readonly delegationId?: string;
};

export type CompositionProposal = {
  readonly proposalId: string;
  readonly compositionId: string;
  readonly planVersion: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly delegationId?: string;
  readonly boundaryHash: string;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly outputHash: string;
  readonly content: string;
  readonly evidence: ReadonlyArray<CompositionEvidence>;
};

export type CertifiedComposition = CompositionProposal & {
  readonly certificationId: string;
  readonly policyVersion: string;
  readonly compositionPolicyDecisionId?: string;
  readonly compositionPolicyCandidateId?: string;
};

export type CompositionRejectionReason =
  | "unauthorized"
  | "unknown_composition"
  | "stale_plan"
  | "boundary_conflict"
  | "input_conflict"
  | "output_conflict"
  | "missing_evidence"
  | "failed_evidence"
  | "policy_rejected"
  | "duplicate";

export type CompositionDecision =
  | { readonly ok: true; readonly certification: CertifiedComposition }
  | { readonly ok: false; readonly reason: CompositionRejectionReason; readonly detail: string };

const sameRecord = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean => hashCanonical(left) === hashCanonical(right);

export const createCompositionProposal = (
  input: Omit<CompositionProposal, "proposalId" | "outputHash"> & { readonly outputHash?: string }
): CompositionProposal => {
  const outputHash = input.outputHash ?? sha256(input.content);
  const identity = {
    compositionId: input.compositionId,
    planVersion: input.planVersion,
    nodeId: input.nodeId,
    capability: input.capability,
    delegationId: input.delegationId,
    boundaryHash: input.boundaryHash,
    inputVersions: input.inputVersions,
    outputHash,
    evidence: input.evidence,
  };
  return {
    ...input,
    outputHash,
    proposalId: `proposal-${hashCanonical(identity).slice(0, 24)}`,
  };
};

export const certifyComposition = (opts: {
  readonly registry: DomainRegistry;
  readonly contract: CompositionContract;
  readonly proposal: CompositionProposal;
  readonly existing?: CertifiedComposition;
  readonly selection?: {
    readonly decision: CompositionPolicyDecision;
    readonly candidateId: string;
  };
}): CompositionDecision => {
  const { contract, proposal } = opts;
  try {
    opts.registry.assertNodeAssignment(proposal.nodeId, proposal.capability);
  } catch (err) {
    return {
      ok: false,
      reason: "unauthorized",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (proposal.compositionId !== contract.compositionId) {
    return { ok: false, reason: "unknown_composition", detail: `expected ${contract.compositionId}` };
  }
  if (proposal.planVersion !== contract.planVersion) {
    return { ok: false, reason: "stale_plan", detail: `expected ${contract.planVersion}` };
  }
  if (contract.delegationId && proposal.delegationId !== contract.delegationId) {
    return { ok: false, reason: "unauthorized", detail: `delegation does not authorize ${contract.compositionId}` };
  }
  if (proposal.boundaryHash !== contract.boundaryHash) {
    return { ok: false, reason: "boundary_conflict", detail: `boundary changed for ${contract.compositionId}` };
  }
  if (!sameRecord(proposal.inputVersions, contract.inputVersions)) {
    return { ok: false, reason: "input_conflict", detail: `inputs changed for ${contract.compositionId}` };
  }
  if (sha256(proposal.content) !== proposal.outputHash) {
    return { ok: false, reason: "output_conflict", detail: `content hash changed for ${contract.compositionId}` };
  }

  const required = [...new Set(contract.requiredEvidenceKinds ?? [])];
  for (const kind of required) {
    const evidence = proposal.evidence.filter((candidate) => candidate.kind === kind);
    if (evidence.length === 0) {
      return { ok: false, reason: "missing_evidence", detail: `${kind} evidence is required` };
    }
    if (!evidence.some((candidate) => candidate.verdict === "pass")) {
      return { ok: false, reason: "failed_evidence", detail: `${kind} evidence did not pass` };
    }
  }

  if (
    opts.selection
    && !verifyCompositionPolicyDecision(opts.selection.decision)
  ) {
    return {
      ok: false,
      reason: "policy_rejected",
      detail: `composition policy decision ${opts.selection.decision.decisionId} failed integrity validation`,
    };
  }
  if (
    opts.selection
    && !opts.selection.decision.selectedCandidateIds.includes(opts.selection.candidateId)
  ) {
    return {
      ok: false,
      reason: "policy_rejected",
      detail: `candidate ${opts.selection.candidateId} was not selected by ${opts.selection.decision.decisionId}`,
    };
  }
  if (opts.selection) {
    const selected = opts.selection.decision.selectedCandidates.find((candidate) =>
      candidate.candidateId === opts.selection!.candidateId);
    if (!selected || selected.artifactHash !== proposal.outputHash) {
      return {
        ok: false,
        reason: "policy_rejected",
        detail: `proposal output does not match selected candidate ${opts.selection.candidateId}`,
      };
    }
  }

  if (opts.existing) {
    const same = opts.existing.proposalId === proposal.proposalId
      && opts.existing.outputHash === proposal.outputHash;
    return same
      ? { ok: false, reason: "duplicate", detail: `${contract.compositionId} is already certified` }
      : { ok: false, reason: "output_conflict", detail: `${contract.compositionId} has a different certified output` };
  }

  const certificationId = `cert-${hashCanonical({
    proposalId: proposal.proposalId,
    policyVersion: opts.registry.pack.policyVersion,
    contract,
    compositionPolicyDecisionId: opts.selection?.decision.decisionId,
    compositionPolicyCandidateId: opts.selection?.candidateId,
  }).slice(0, 24)}`;
  return {
    ok: true,
    certification: {
      ...proposal,
      certificationId,
      policyVersion: opts.registry.pack.policyVersion,
      ...(opts.selection ? {
        compositionPolicyDecisionId: opts.selection.decision.decisionId,
        compositionPolicyCandidateId: opts.selection.candidateId,
      } : {}),
    },
  };
};
