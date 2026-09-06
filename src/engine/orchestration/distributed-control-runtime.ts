import type {
  DistributedControlAction,
  DistributedControlProjection,
} from "./distributed-control.js";

export type DistributedControlEffects = {
  readonly spawnTasks: (
    proposalId: string,
    action: Extract<DistributedControlAction, { readonly type: "spawn_tasks" }>,
  ) => Promise<void>;
  readonly retireNode: (
    proposalId: string,
    action: Extract<DistributedControlAction, { readonly type: "retire_node" }>,
  ) => Promise<void>;
  readonly transferBudget: (
    proposalId: string,
    action: Extract<DistributedControlAction, { readonly type: "transfer_budget" }>,
  ) => Promise<void>;
  readonly setJoinStrategy: (
    proposalId: string,
    action: Extract<DistributedControlAction, { readonly type: "set_join_strategy" }>,
  ) => Promise<void>;
  readonly certifyFrontier: (
    proposalId: string,
    action: Extract<DistributedControlAction, { readonly type: "certify_frontier" }>,
  ) => Promise<void>;
};

export type DistributedControlRuntimeState = {
  readonly appliedProposalIds: ReadonlyArray<string>;
};

/**
 * Materialize only actions that the CRDT projector has accepted. This runtime
 * never chooses an action or resolves a semantic disagreement; it provides
 * idempotent effects for the distributed control protocol.
 */
export const reconcileDistributedControl = async (input: {
  readonly projection: DistributedControlProjection;
  /**
   * A projector-derived, durably recorded certification. The runtime may
   * service consensus, but it may never turn an uncertified local view into
   * external side effects.
   */
  readonly certifiedVersionHash: string;
  readonly projectionVersionHash: string;
  readonly conflictCount: number;
  readonly state?: DistributedControlRuntimeState;
  readonly effects: DistributedControlEffects;
}): Promise<DistributedControlRuntimeState> => {
  if (input.conflictCount !== 0) throw new Error("Cannot service a conflicted distributed-control frontier");
  if (!input.certifiedVersionHash || input.certifiedVersionHash !== input.projectionVersionHash) {
    throw new Error("Cannot service an uncertified distributed-control frontier");
  }
  if (input.projection.acceptedActions.length === 0) {
    throw new Error("Cannot service a distributed-control frontier without an accepted action");
  }
  const applied = new Set(input.state?.appliedProposalIds ?? []);
  for (const accepted of input.projection.acceptedActions) {
    if (applied.has(accepted.proposalId)) continue;
    switch (accepted.action.type) {
      case "spawn_tasks": await input.effects.spawnTasks(accepted.proposalId, accepted.action); break;
      case "retire_node": await input.effects.retireNode(accepted.proposalId, accepted.action); break;
      case "transfer_budget": await input.effects.transferBudget(accepted.proposalId, accepted.action); break;
      case "set_join_strategy": await input.effects.setJoinStrategy(accepted.proposalId, accepted.action); break;
      case "certify_frontier": await input.effects.certifyFrontier(accepted.proposalId, accepted.action); break;
    }
    applied.add(accepted.proposalId);
  }
  return { appliedProposalIds: [...applied].sort() };
};
