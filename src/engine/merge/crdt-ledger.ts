import { createHash } from "node:crypto";

import * as Y from "yjs";

import type {
  VersionedMergePlan,
  VersionedMergeProposal,
  VersionedMergeStep,
} from "./versioned-contract.js";

const PROPOSALS_MAP = "merge-proposals";

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sortedUnique = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

export type CrdtMergeProposalInput = VersionedMergeProposal & {
  readonly content: string;
  readonly inputClaimIds: ReadonlyArray<string>;
};

export type CrdtMergeProposal = CrdtMergeProposalInput & {
  readonly proposalId: string;
};

export type CrdtMergeInvalidProposal = {
  readonly proposalId: string;
  readonly mergeId: string;
  readonly reason: "boundary_conflict" | "input_conflict" | "output_conflict";
  readonly detail: string;
};

export type CrdtMergeStepProjection =
  | {
      readonly status: "pending";
      readonly step: VersionedMergeStep;
      readonly detail: string;
    }
  | {
      readonly status: "invalid";
      readonly step: VersionedMergeStep;
      readonly proposals: ReadonlyArray<CrdtMergeProposal>;
      readonly detail: string;
    }
  | {
      readonly status: "conflict";
      readonly step: VersionedMergeStep;
      readonly proposals: ReadonlyArray<CrdtMergeProposal>;
      readonly outputHashes: ReadonlyArray<string>;
      readonly detail: string;
    }
  | {
      readonly status: "accepted";
      readonly step: VersionedMergeStep;
      readonly proposal: CrdtMergeProposal;
      readonly proposalIds: ReadonlyArray<string>;
      readonly resolutionId: string;
    };

export type CrdtMergeProjection = {
  readonly planVersion: string;
  readonly steps: Readonly<Record<string, CrdtMergeStepProjection>>;
  readonly invalidProposals: ReadonlyArray<CrdtMergeInvalidProposal>;
};

const canonicalProposal = (proposal: CrdtMergeProposalInput): string => JSON.stringify([
  proposal.planVersion,
  proposal.mergeId,
  [...proposal.inputVersions],
  proposal.outputHash,
  proposal.boundaryHash,
  proposal.content,
  sortedUnique(proposal.inputClaimIds),
]);

export const mergeProposalId = (proposal: CrdtMergeProposalInput): string =>
  hash(canonicalProposal(proposal));

export const mergeResolutionId = (proposal: VersionedMergeProposal): string =>
  hash(JSON.stringify([
    proposal.planVersion,
    proposal.mergeId,
    [...proposal.inputVersions],
    proposal.outputHash,
    proposal.boundaryHash,
  ]));

export const createCrdtMergeProposal = (
  input: CrdtMergeProposalInput
): CrdtMergeProposal => {
  if (hash(input.content) !== input.outputHash) {
    throw new Error(`Merge proposal ${input.mergeId} content does not match outputHash`);
  }
  const normalized: CrdtMergeProposalInput = {
    mergeId: input.mergeId,
    planVersion: input.planVersion,
    inputVersions: [...input.inputVersions],
    outputHash: input.outputHash,
    boundaryHash: input.boundaryHash,
    content: input.content,
    inputClaimIds: sortedUnique(input.inputClaimIds),
  };
  return { ...normalized, proposalId: mergeProposalId(normalized) };
};

const proposalClientId = (proposalId: string): number => {
  const value = Number.parseInt(proposalId.slice(0, 8), 16) >>> 0;
  return value || 1;
};

export const createMergeProposalUpdate = (proposal: CrdtMergeProposal): Uint8Array => {
  if (mergeProposalId(proposal) !== proposal.proposalId) {
    throw new Error(`Merge proposal ${proposal.mergeId} has an invalid proposalId`);
  }
  const doc = new Y.Doc({ guid: `merge:${proposal.planVersion}` });
  // Each immutable proposal is a virtual Yjs client, making its update content-addressed.
  doc.clientID = proposalClientId(proposal.proposalId);
  doc.getMap<CrdtMergeProposal>(PROPOSALS_MAP).set(proposal.proposalId, {
    ...proposal,
    inputVersions: [...proposal.inputVersions],
    inputClaimIds: [...proposal.inputClaimIds],
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;

const asProposal = (key: string, value: unknown): CrdtMergeProposal | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const inputVersions = asStringArray(record.inputVersions);
  const inputClaimIds = asStringArray(record.inputClaimIds);
  if (
    typeof record.proposalId !== "string"
    || record.proposalId !== key
    || typeof record.mergeId !== "string"
    || typeof record.planVersion !== "string"
    || !inputVersions
    || typeof record.outputHash !== "string"
    || typeof record.boundaryHash !== "string"
    || typeof record.content !== "string"
    || !inputClaimIds
  ) {
    return undefined;
  }
  const proposal: CrdtMergeProposal = {
    proposalId: record.proposalId,
    mergeId: record.mergeId,
    planVersion: record.planVersion,
    inputVersions,
    outputHash: record.outputHash,
    boundaryHash: record.boundaryHash,
    content: record.content,
    inputClaimIds: sortedUnique(inputClaimIds),
  };
  return mergeProposalId(proposal) === proposal.proposalId ? proposal : undefined;
};

const expectedInputVersions = (
  plan: VersionedMergePlan,
  step: VersionedMergeStep,
  accepted: ReadonlyMap<string, CrdtMergeProposal>
): string[] | undefined => {
  const versions: string[] = [];
  for (const ref of step.inputRefs) {
    if (ref.startsWith("merge-")) {
      const dependency = accepted.get(ref);
      if (!dependency) return undefined;
      versions.push(dependency.outputHash);
      continue;
    }
    const sourceVersion = plan.sourceVersions[ref];
    if (!sourceVersion) return undefined;
    versions.push(sourceVersion);
  }
  return versions;
};

export class CrdtMergeLedger {
  private readonly doc: Y.Doc;

  constructor(update?: Uint8Array) {
    this.doc = new Y.Doc();
    this.doc.getMap<CrdtMergeProposal>(PROPOSALS_MAP);
    if (update) Y.applyUpdate(this.doc, update);
  }

  add(proposal: CrdtMergeProposal): Uint8Array {
    const update = createMergeProposalUpdate(proposal);
    this.apply(update);
    return update;
  }

  apply(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  proposals(): CrdtMergeProposal[] {
    const proposals: CrdtMergeProposal[] = [];
    for (const [key, value] of this.doc.getMap<unknown>(PROPOSALS_MAP)) {
      const proposal = asProposal(key, value);
      if (proposal) proposals.push(proposal);
    }
    return proposals.sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  }

  project(plan: VersionedMergePlan): CrdtMergeProjection {
    const proposals = this.proposals();
    const accepted = new Map<string, CrdtMergeProposal>();
    const steps: Record<string, CrdtMergeStepProjection> = {};
    const invalidProposals: CrdtMergeInvalidProposal[] = [];

    for (const step of plan.steps) {
      const candidates = proposals.filter((proposal) =>
        proposal.planVersion === plan.planVersion && proposal.mergeId === step.mergeId
      );
      if (candidates.length === 0) {
        steps[step.mergeId] = { status: "pending", step, detail: "proposal not observed" };
        continue;
      }

      const expectedVersions = expectedInputVersions(plan, step, accepted);
      if (!expectedVersions) {
        steps[step.mergeId] = {
          status: "pending",
          step,
          detail: `waiting for ${step.dependsOn.join(", ") || "source versions"}`,
        };
        continue;
      }

      const valid: CrdtMergeProposal[] = [];
      for (const proposal of candidates) {
        if (proposal.boundaryHash !== step.boundaryHash) {
          invalidProposals.push({
            proposalId: proposal.proposalId,
            mergeId: proposal.mergeId,
            reason: "boundary_conflict",
            detail: `boundary changed for ${proposal.mergeId}`,
          });
          continue;
        }
        if (hash(proposal.content) !== proposal.outputHash) {
          invalidProposals.push({
            proposalId: proposal.proposalId,
            mergeId: proposal.mergeId,
            reason: "output_conflict",
            detail: `content hash changed for ${proposal.mergeId}`,
          });
          continue;
        }
        if (!sameStrings(expectedVersions, proposal.inputVersions)) {
          invalidProposals.push({
            proposalId: proposal.proposalId,
            mergeId: proposal.mergeId,
            reason: "input_conflict",
            detail: `inputs changed for ${proposal.mergeId}`,
          });
          continue;
        }
        valid.push(proposal);
      }

      if (valid.length === 0) {
        steps[step.mergeId] = {
          status: "invalid",
          step,
          proposals: candidates,
          detail: `no valid proposal for ${step.mergeId}`,
        };
        continue;
      }

      const outputHashes = sortedUnique(valid.map((proposal) => proposal.outputHash));
      if (outputHashes.length > 1) {
        steps[step.mergeId] = {
          status: "conflict",
          step,
          proposals: valid,
          outputHashes,
          detail: `${step.mergeId} has ${outputHashes.length} concurrent semantic outputs`,
        };
        continue;
      }

      const first = valid[0];
      const proposal: CrdtMergeProposal = {
        ...first,
        inputClaimIds: sortedUnique(valid.flatMap((candidate) => candidate.inputClaimIds)),
      };
      accepted.set(step.mergeId, proposal);
      steps[step.mergeId] = {
        status: "accepted",
        step,
        proposal,
        proposalIds: valid.map((candidate) => candidate.proposalId).sort(),
        resolutionId: mergeResolutionId(proposal),
      };
    }

    return {
      planVersion: plan.planVersion,
      steps,
      invalidProposals: invalidProposals.sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
    };
  }

  destroy(): void {
    this.doc.destroy();
  }
}

export const mergeCrdtUpdates = (updates: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (updates.length === 0) {
    const ledger = new CrdtMergeLedger();
    try {
      return ledger.encode();
    } finally {
      ledger.destroy();
    }
  }
  return Y.mergeUpdates([...updates]);
};
