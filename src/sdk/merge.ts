import type { MergePolicy } from "../core/agent-contracts.js";

export type {
  MergeCandidate,
  MergeDecision,
  MergePolicy,
  MergeScoreVector,
} from "../core/agent-contracts.js";

export const merge = <Ctx, Evidence>(policy: MergePolicy<Ctx, Evidence>): MergePolicy<Ctx, Evidence> => policy;
export const rebracket = merge;
