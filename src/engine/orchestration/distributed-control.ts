import { z } from "zod";

import { hashCanonical } from "../../core/canonical.js";
import {
  createSharedArtifactUpdate,
  SharedArtifactLedger,
  type ArtifactConflict,
  type ArtifactProjector,
  type SharedArtifactUpdate,
} from "../artifact/shared-crdt.js";

const boundedId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/);
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const evidenceRefs = z.array(boundedId).max(24).default([]);

const distributedTaskSchema = z.object({
  taskId: boundedId,
  role: boundedId,
  capability: boundedText(120),
  kind: z.enum(["research", "alternative", "paint", "detail", "critique", "repair", "compose", "verify", "custom"]),
  objective: boundedText(1_600),
  parentTaskId: boundedId.optional(),
  dependencies: z.array(boundedId).max(16).default([]),
  estimatedCostMicros: z.number().int().min(0).max(20_000_000).default(0),
}).strict();

export const distributedControlActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("spawn_tasks"),
    tasks: z.array(distributedTaskSchema).min(1).max(12),
    joinStrategy: z.enum(["all", "first-success", "best-score", "consensus"]),
  }).strict(),
  z.object({ type: z.literal("retire_node"), nodeId: boundedId, reason: boundedText(500) }).strict(),
  z.object({
    type: z.literal("transfer_budget"),
    fromNodeId: boundedId,
    toNodeId: boundedId,
    amountMicros: z.number().int().min(1).max(20_000_000),
    reason: boundedText(500),
  }).strict(),
  z.object({
    type: z.literal("set_join_strategy"),
    strategy: z.enum(["all", "first-success", "best-score", "consensus"]),
    reason: boundedText(500),
  }).strict(),
  z.object({
    type: z.literal("certify_frontier"),
    projectionHash: z.string().regex(/^[0-9a-f]{64}$/),
    conflictCount: z.number().int().min(0).max(10_000),
    reason: boundedText(500),
  }).strict(),
]);

export type DistributedControlAction = z.infer<typeof distributedControlActionSchema>;

export const distributedControlProposalSchema = z.object({
  kind: z.literal("proposal"),
  proposalId: boundedId,
  authorNodeId: boundedId,
  authorRole: boundedId,
  rationale: boundedText(1_200),
  action: distributedControlActionSchema,
  evidenceRefs,
}).strict();

export const distributedControlEndorsementSchema = z.object({
  kind: z.literal("endorsement"),
  proposalId: boundedId,
  nodeId: boundedId,
  nodeRole: boundedId,
  verdict: z.enum(["endorse", "object", "abstain"]),
  reason: boundedText(800),
  evidenceRefs,
}).strict();

export const distributedControlWithdrawalSchema = z.object({
  kind: z.literal("withdrawal"),
  proposalId: boundedId,
  nodeId: boundedId,
  reason: boundedText(500),
}).strict();

export const distributedControlPayloadSchema = z.discriminatedUnion("kind", [
  distributedControlProposalSchema,
  distributedControlEndorsementSchema,
  distributedControlWithdrawalSchema,
]);

export type DistributedControlProposal = z.infer<typeof distributedControlProposalSchema>;
export type DistributedControlEndorsement = z.infer<typeof distributedControlEndorsementSchema>;
export type DistributedControlPayload = z.infer<typeof distributedControlPayloadSchema>;

export type DistributedControlEvent =
  | {
      readonly type: "control.update.published";
      readonly runId: string;
      readonly artifactId: string;
      readonly updateId: string;
      readonly nodeId: string;
      readonly taskId: string;
      readonly frontierVersion: string;
      readonly topologyVersion: string;
      readonly payload: DistributedControlPayload;
      readonly crdtUpdateBase64: string;
    }
  | {
      readonly type: "control.frontier.projected";
      readonly runId: string;
      readonly artifactId: string;
      readonly frontierVersion: string;
      readonly topologyVersion: string;
      readonly versionHash: string;
      readonly acceptedProposalIds: ReadonlyArray<string>;
      readonly conflictCount: number;
      readonly proposalStatuses: ReadonlyArray<{
        readonly proposalId: string;
        readonly status: DistributedProposalStatus;
        readonly reason: string;
      }>;
    }
  | {
      readonly type: "control.frontier.certified";
      readonly runId: string;
      readonly artifactId: string;
      readonly frontierVersion: string;
      readonly topologyVersion: string;
      readonly certificationId: string;
      readonly versionHash: string;
      readonly acceptedProposalIds: ReadonlyArray<string>;
    };

export type DistributedControlPolicy = {
  readonly exploratoryEndorsements: number;
  readonly protectedEndorsements: number;
  readonly objectionThreshold: number;
  readonly requireDistinctRoles: boolean;
  readonly maxTasksPerProposal: number;
  readonly maxEstimatedCostMicros: number;
};

export const DEFAULT_DISTRIBUTED_CONTROL_POLICY: DistributedControlPolicy = Object.freeze({
  exploratoryEndorsements: 1,
  protectedEndorsements: 2,
  objectionThreshold: 2,
  requireDistinctRoles: true,
  maxTasksPerProposal: 8,
  maxEstimatedCostMicros: 8_000_000,
});

export type DistributedProposalStatus = "pending" | "accepted" | "objected" | "conflicted" | "withdrawn" | "duplicate" | "invalid";

export type DistributedProposalProjection = {
  readonly proposal: DistributedControlProposal;
  readonly status: DistributedProposalStatus;
  readonly endorsements: ReadonlyArray<DistributedControlEndorsement>;
  readonly reason: string;
  readonly updateId: string;
};

export type DistributedControlProjection = {
  readonly proposals: ReadonlyArray<DistributedProposalProjection>;
  readonly acceptedActions: ReadonlyArray<{ readonly proposalId: string; readonly action: DistributedControlAction }>;
};

const proposalIdentityInput = (input: Omit<DistributedControlProposal, "proposalId" | "kind">) => ({
  authorNodeId: input.authorNodeId,
  authorRole: input.authorRole,
  rationale: input.rationale,
  action: input.action,
  evidenceRefs: [...input.evidenceRefs].sort(),
});

export const createDistributedControlProposal = (
  input: Omit<DistributedControlProposal, "proposalId" | "kind">,
): DistributedControlProposal => distributedControlProposalSchema.parse({
  kind: "proposal",
  ...input,
  proposalId: `proposal_${hashCanonical(proposalIdentityInput(input)).slice(0, 28)}`,
});

export const createDistributedControlUpdate = (input: {
  readonly artifactId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly frontierVersion: string;
  readonly topologyVersion: string;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly payload: DistributedControlPayload;
}): SharedArtifactUpdate<DistributedControlPayload> => createSharedArtifactUpdate({
  artifactId: input.artifactId,
  artifactKind: "distributed-control",
  schemaVersion: "distributed-control/v2",
  frontierVersion: input.frontierVersion,
  topologyVersion: input.topologyVersion,
  runId: input.runId,
  taskId: input.taskId,
  nodeId: input.nodeId,
  inputVersions: input.inputVersions,
  payload: distributedControlPayloadSchema.parse(input.payload),
});

const resourcesFor = (action: DistributedControlAction): ReadonlyArray<string> => {
  switch (action.type) {
    case "spawn_tasks": return action.tasks.map((task) => `task:${task.taskId}`);
    case "retire_node": return [`node:${action.nodeId}`];
    case "transfer_budget": return [`budget:${action.fromNodeId}`];
    case "set_join_strategy": return ["topology:join-strategy"];
    case "certify_frontier": return ["frontier:certification"];
  }
};

const protectedAction = (action: DistributedControlAction): boolean =>
  action.type === "retire_node"
  || action.type === "transfer_budget"
  || action.type === "set_join_strategy"
  || action.type === "certify_frontier";

export const createDistributedControlProjector = (options: {
  readonly nodeRoles: Readonly<Record<string, string>>;
  readonly policy?: Partial<DistributedControlPolicy>;
  readonly canPropose?: (nodeId: string, action: DistributedControlAction) => boolean;
}): ArtifactProjector<DistributedControlPayload, DistributedControlProjection> => {
  const policy = { ...DEFAULT_DISTRIBUTED_CONTROL_POLICY, ...options.policy };
  return (updates, frontier) => {
    const invalidUpdateIds: string[] = [];
    const staleUpdateIds: string[] = [];
    const proposalUpdates = new Map<string, { proposal: DistributedControlProposal; updateId: string }>();
    const endorsements = new Map<string, Array<{ endorsement: DistributedControlEndorsement; updateId: string }>>();
    const withdrawals = new Map<string, Set<string>>();
    for (const update of updates) {
      if (update.frontierVersion !== frontier.frontierVersion || update.topologyVersion !== frontier.topologyVersion) {
        staleUpdateIds.push(update.updateId);
        continue;
      }
      const parsed = distributedControlPayloadSchema.safeParse(update.payload);
      if (!parsed.success || update.nodeId !== (parsed.data.kind === "proposal" ? parsed.data.authorNodeId : parsed.data.nodeId)) {
        invalidUpdateIds.push(update.updateId);
        continue;
      }
      const payload = parsed.data;
      if (payload.kind === "proposal") {
        const expected = createDistributedControlProposal({
          authorNodeId: payload.authorNodeId,
          authorRole: payload.authorRole,
          rationale: payload.rationale,
          action: payload.action,
          evidenceRefs: payload.evidenceRefs,
        });
        const taskCost = payload.action.type === "spawn_tasks"
          ? payload.action.tasks.reduce((sum, task) => sum + task.estimatedCostMicros, 0)
          : 0;
        const invalid = expected.proposalId !== payload.proposalId
          || options.nodeRoles[payload.authorNodeId] !== payload.authorRole
          || (options.canPropose && !options.canPropose(payload.authorNodeId, payload.action))
          || (payload.action.type === "spawn_tasks" && payload.action.tasks.length > policy.maxTasksPerProposal)
          || taskCost > policy.maxEstimatedCostMicros
          || (payload.action.type === "certify_frontier" && payload.action.conflictCount !== 0);
        if (invalid) invalidUpdateIds.push(update.updateId);
        else proposalUpdates.set(payload.proposalId, { proposal: payload, updateId: update.updateId });
      } else if (payload.kind === "endorsement") {
        if (options.nodeRoles[payload.nodeId] !== payload.nodeRole) invalidUpdateIds.push(update.updateId);
        else endorsements.set(payload.proposalId, [
          ...(endorsements.get(payload.proposalId) ?? []),
          { endorsement: payload, updateId: update.updateId },
        ]);
      } else {
        withdrawals.set(payload.proposalId, new Set([...(withdrawals.get(payload.proposalId) ?? []), payload.nodeId]));
      }
    }

    const working: DistributedProposalProjection[] = [];
    const endorsementUpdateIds = new Map<string, ReadonlyMap<string, string>>();
    for (const { proposal, updateId } of proposalUpdates.values()) {
      const votesByNode = new Map<string, Array<{ endorsement: DistributedControlEndorsement; updateId: string }>>();
      for (const vote of endorsements.get(proposal.proposalId) ?? []) {
        if (vote.endorsement.nodeId === proposal.authorNodeId) continue;
        votesByNode.set(vote.endorsement.nodeId, [...(votesByNode.get(vote.endorsement.nodeId) ?? []), vote]);
      }
      const votes: DistributedControlEndorsement[] = [];
      const voteUpdateIds = new Map<string, string>();
      for (const [nodeId, nodeVotes] of votesByNode) {
        const verdicts = new Set(nodeVotes.map((vote) => vote.endorsement.verdict));
        if (verdicts.size > 1) {
          invalidUpdateIds.push(...nodeVotes.map((vote) => vote.updateId));
          continue;
        }
        const canonical = [...nodeVotes].sort((left, right) => left.updateId.localeCompare(right.updateId))[0]!;
        votes.push(canonical.endorsement);
        voteUpdateIds.set(nodeId, canonical.updateId);
      }
      votes.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
      endorsementUpdateIds.set(proposal.proposalId, voteUpdateIds);
      const endorsing = votes.filter((vote) => vote.verdict === "endorse");
      const objections = votes.filter((vote) => vote.verdict === "object");
      const required = protectedAction(proposal.action) ? policy.protectedEndorsements : policy.exploratoryEndorsements;
      const roles = new Set(endorsing.map((vote) => vote.nodeRole));
      const withdrawn = withdrawals.get(proposal.proposalId)?.has(proposal.authorNodeId) ?? false;
      const eligible = !withdrawn
        && objections.length < policy.objectionThreshold
        && endorsing.length >= required
        && (!policy.requireDistinctRoles || roles.size >= Math.min(required, 2));
      const status: DistributedProposalStatus = withdrawn
        ? "withdrawn"
        : objections.length >= policy.objectionThreshold
          ? "objected"
          : eligible ? "accepted" : "pending";
      working.push({
        proposal,
        status,
        endorsements: votes,
        reason: withdrawn
          ? "withdrawn by author"
          : objections.length >= policy.objectionThreshold
            ? `${objections.length}/${policy.objectionThreshold} objections reached the rejection threshold`
            : eligible ? "endorsement policy satisfied" : `${endorsing.length}/${required} endorsements`,
        updateId,
      });
    }

    const eligibleByResource = new Map<string, DistributedProposalProjection[]>();
    for (const projected of working.filter((item) => item.status === "accepted")) {
      for (const resource of resourcesFor(projected.proposal.action)) {
        eligibleByResource.set(resource, [...(eligibleByResource.get(resource) ?? []), projected]);
      }
    }
    const conflicts: ArtifactConflict[] = [];
    const conflictedIds = new Set<string>();
    const duplicateIds = new Set<string>();
    for (const [resource, candidates] of eligibleByResource) {
      const byAction = new Map<string, DistributedProposalProjection[]>();
      for (const candidate of candidates) {
        const actionHash = hashCanonical(candidate.proposal.action);
        byAction.set(actionHash, [...(byAction.get(actionHash) ?? []), candidate]);
      }
      for (const duplicates of byAction.values()) {
        for (const duplicate of duplicates.sort((left, right) => left.proposal.proposalId.localeCompare(right.proposal.proposalId)).slice(1)) {
          duplicateIds.add(duplicate.proposal.proposalId);
        }
      }
      const canonical = [...byAction.values()].map((group) => group.sort((left, right) => left.proposal.proposalId.localeCompare(right.proposal.proposalId))[0]!);
      if (canonical.length > 1) {
        canonical.forEach((candidate) => conflictedIds.add(candidate.proposal.proposalId));
        conflicts.push({
          conflictId: `control_conflict_${hashCanonical({ resource, proposals: canonical.map((candidate) => candidate.proposal.proposalId).sort() }).slice(0, 24)}`,
          kind: "distributed-control",
          subjectId: resource,
          candidateUpdateIds: canonical.map((candidate) => candidate.updateId).sort(),
          candidateHashes: canonical.map((candidate) => hashCanonical(candidate.proposal.action)).sort(),
        });
      }
    }
    const proposals = working.map((projected): DistributedProposalProjection => conflictedIds.has(projected.proposal.proposalId)
      ? { ...projected, status: "conflicted", reason: "competing accepted proposal targets the same resource" }
      : duplicateIds.has(projected.proposal.proposalId)
        ? { ...projected, status: "duplicate", reason: "equivalent accepted proposal already exists" }
        : projected).sort((left, right) => left.proposal.proposalId.localeCompare(right.proposal.proposalId));
    const accepted = proposals.filter((proposal) => proposal.status === "accepted");
    return {
      value: {
        proposals,
        acceptedActions: accepted.map((proposal) => ({ proposalId: proposal.proposal.proposalId, action: proposal.proposal.action })),
      },
      acceptedUpdateIds: accepted.flatMap((proposal) => [proposal.updateId, ...proposal.endorsements.map((vote) => {
        return endorsementUpdateIds.get(proposal.proposal.proposalId)?.get(vote.nodeId);
      }).filter((id): id is string => Boolean(id))]).sort(),
      conflicts,
      invalidUpdateIds: invalidUpdateIds.sort(),
      staleUpdateIds: staleUpdateIds.sort(),
    };
  };
};

export class DistributedControlLedger extends SharedArtifactLedger<DistributedControlPayload> {
  constructor(update?: Uint8Array) {
    super({ update, mapName: "distributed-control-updates", guid: "roster:distributed-control" });
  }
}
