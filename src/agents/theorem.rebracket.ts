// ============================================================================
// Theorem Roster rebracketing engine
// Merge order is chosen from the Tamari lattice of binary bracketings.
// Each bracket acts like a merge "lens" over the pod tree.
// ============================================================================

import type { Chain } from "../core/types.js";
import type { TheoremEvent } from "../modules/theorem.js";
import {
  compositionBracket,
  compositionLeaves,
  parseCompositionBracket,
  topologyPairKey,
  type CompositionTree,
} from "../engine/orchestration/topology.js";

export type BracketTree = CompositionTree;

export const pairKey = topologyPairKey;

const containsLeaf = (tree: BracketTree, leaf: string): boolean => {
  if (typeof tree === "string") return tree === leaf;
  return containsLeaf(tree[0], leaf) || containsLeaf(tree[1], leaf);
};

const lcaDepth = (tree: BracketTree, a: string, b: string, depth = 0): number => {
  if (typeof tree === "string") return -1;
  const leftHasA = containsLeaf(tree[0], a);
  const leftHasB = containsLeaf(tree[0], b);
  const rightHasA = containsLeaf(tree[1], a);
  const rightHasB = containsLeaf(tree[1], b);

  if (leftHasA && leftHasB) return lcaDepth(tree[0], a, b, depth + 1);
  if (rightHasA && rightHasB) return lcaDepth(tree[1], a, b, depth + 1);
  if ((leftHasA && rightHasB) || (leftHasB && rightHasA)) return depth;
  return -1;
};

export const bracketString = (tree: BracketTree): string =>
  compositionBracket(tree);

export const treeForBracket = (bracket: string): BracketTree => {
  const tree = parseCompositionBracket(bracket);
  if (!tree) throw new Error(`Invalid composition bracket: ${bracket}`);
  return tree;
};

export const collectLeaves = (tree: BracketTree, out: string[] = []): string[] => {
  out.push(...compositionLeaves(tree));
  return out;
};

export const podProximity = (bracket: string, a: string, b: string): number => {
  if (a === b) return 4;
  const tree = treeForBracket(bracket);
  const depth = lcaDepth(tree, a, b, 0);
  return Math.max(0, depth + 1);
};

export const computeTopologyWeights = (
  chain: Chain<TheoremEvent>,
  agentToLeaf: ReadonlyMap<string, string>
): Map<string, number> => {
  const weights = new Map<string, number>();
  const claimOwner = new Map<string, string>();
  for (const receipt of chain) {
    const event = receipt.body;
    if (
      event.type === "attempt.proposed"
      || event.type === "lemma.proposed"
      || event.type === "critique.raised"
      || event.type === "patch.applied"
    ) {
      claimOwner.set(event.claimId, event.agentId);
    }
  }
  const bump = (leftAgent: string | undefined, rightAgent: string | undefined, amount: number) => {
    if (!leftAgent || !rightAgent) return;
    const left = agentToLeaf.get(leftAgent);
    const right = agentToLeaf.get(rightAgent);
    if (!left || !right || left === right) return;
    const key = pairKey(left, right);
    weights.set(key, (weights.get(key) ?? 0) + amount);
  };
  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type === "critique.raised" || event.type === "patch.applied") {
      bump(event.agentId, claimOwner.get(event.targetClaimId), 2);
    }
    if (event.type === "summary.made") {
      const leaves = [...new Set((event.uses ?? [])
        .map((claimId) => claimOwner.get(claimId))
        .map((agentId) => agentId ? agentToLeaf.get(agentId) : undefined)
        .filter((leaf): leaf is string => Boolean(leaf)))];
      for (let left = 0; left < leaves.length; left += 1) {
        for (let right = left + 1; right < leaves.length; right += 1) {
          const leftLeaf = leaves[left];
          const rightLeaf = leaves[right];
          if (!leftLeaf || !rightLeaf) continue;
          const key = pairKey(leftLeaf, rightLeaf);
          weights.set(key, (weights.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return weights;
};
