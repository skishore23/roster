// ============================================================================
// Theorem Roster rebracketing evidence policy
// ============================================================================

import type { Chain } from "../core/types.js";
import type { TheoremEvent } from "../modules/theorem.js";

const roundFromClaimId = (claimId: string | undefined): number | undefined => {
  if (!claimId) return undefined;
  const match = claimId.match(/_r(\d+)(?:_|$)/i);
  if (!match) return undefined;
  const round = Number.parseInt(match[1], 10);
  return Number.isFinite(round) ? round : undefined;
};

export type RoundRebracketEvidence = {
  readonly round: number;
  readonly attemptCount: number;
  readonly critiqueCount: number;
  readonly patchCount: number;
  readonly disagreement: number;
  readonly critiqueDensity: number;
  readonly patchCoverage: number;
  readonly unresolvedPressure: number;
  readonly score: number;
  readonly shouldRebracket: boolean;
  readonly note: string;
};

export const evaluateRoundRebracketEvidence = (
  chain: Chain<TheoremEvent>,
  round: number,
  branchThreshold: number
): RoundRebracketEvidence => {
  const attempts = new Set<string>();
  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type !== "attempt.proposed") continue;
    if (roundFromClaimId(event.claimId) !== round) continue;
    attempts.add(event.claimId);
  }

  const critiqueByTarget = new Map<string, number>();
  const patchByTarget = new Map<string, number>();
  let critiqueCount = 0;
  let patchCount = 0;

  for (const receipt of chain) {
    const event = receipt.body;
    if (event.type === "critique.raised" && attempts.has(event.targetClaimId)) {
      critiqueCount += 1;
      critiqueByTarget.set(event.targetClaimId, (critiqueByTarget.get(event.targetClaimId) ?? 0) + 1);
      continue;
    }
    if (event.type === "patch.applied" && attempts.has(event.targetClaimId)) {
      patchCount += 1;
      patchByTarget.set(event.targetClaimId, (patchByTarget.get(event.targetClaimId) ?? 0) + 1);
    }
  }

  const attemptCount = attempts.size;
  const denom = Math.max(1, attemptCount);
  const criticizedTargets = critiqueByTarget.size;
  const patchedTargets = patchByTarget.size;
  const disagreement = criticizedTargets / denom;
  const critiqueDensity = critiqueCount / denom;
  const patchCoverage = criticizedTargets > 0 ? patchedTargets / criticizedTargets : 1;
  const unresolvedPressure = Math.max(0, critiqueCount - patchCount) / denom;

  const score = critiqueDensity + disagreement + unresolvedPressure + (1 - patchCoverage);
  const threshold = Math.max(1, branchThreshold);
  const shouldRebracket = score >= threshold && attemptCount > 0;
  const note = `round r${round}: score=${score.toFixed(2)} (density=${critiqueDensity.toFixed(2)}, disagreement=${disagreement.toFixed(2)}, unresolved=${unresolvedPressure.toFixed(2)}, patchCoverage=${patchCoverage.toFixed(2)}) threshold=${threshold}`;

  return {
    round,
    attemptCount,
    critiqueCount,
    patchCount,
    disagreement,
    critiqueDensity,
    patchCoverage,
    unresolvedPressure,
    score,
    shouldRebracket,
    note,
  };
};
