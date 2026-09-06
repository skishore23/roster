import type { Chain } from "../core/types.js";

/**
 * Browser-safe continuity check for a receipt projection.
 *
 * Cryptographic receipt verification stays in the trusted runtime. Browser
 * views receive caller-scoped SpacetimeDB rows and only need to detect an
 * incomplete or misordered projection before presenting it as a contiguous
 * replay chain.
 */
export const hasLinkedReceiptChain = <Body>(chain: Chain<Body>): boolean => {
  let previous: string | undefined;
  for (const receipt of chain) {
    if (receipt.prev !== previous) return false;
    previous = receipt.hash;
  }
  return true;
};
