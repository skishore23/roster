export type CompositionTree = string | [CompositionTree, CompositionTree];

export type TamariDirection = "up" | "down";

export type TamariNeighbor = {
  readonly tree: CompositionTree;
  readonly direction: TamariDirection;
  readonly path: ReadonlyArray<"left" | "right">;
};

export type TopologySelection = {
  readonly tree: CompositionTree;
  readonly bracket: string;
  readonly previousBracket: string;
  readonly direction: TamariDirection | "stable";
  readonly score: number;
  readonly gain: number;
  readonly reason: string;
};

export const compositionBracket = (tree: CompositionTree): string =>
  typeof tree === "string"
    ? tree
    : `(${compositionBracket(tree[0])} o ${compositionBracket(tree[1])})`;

export const compositionLeaves = (tree: CompositionTree, out: string[] = []): string[] => {
  if (typeof tree === "string") {
    out.push(tree);
    return out;
  }
  compositionLeaves(tree[0], out);
  compositionLeaves(tree[1], out);
  return out;
};

export const balancedCompositionTree = (leaves: ReadonlyArray<string>): CompositionTree => {
  if (leaves.length === 0) throw new Error("Composition topology requires at least one leaf");
  if (new Set(leaves).size !== leaves.length) throw new Error("Composition topology leaves must be unique");
  const build = (start: number, end: number): CompositionTree => {
    if (end - start === 1) return leaves[start] ?? "";
    const middle = start + Math.ceil((end - start) / 2);
    return [build(start, middle), build(middle, end)];
  };
  return build(0, leaves.length);
};

export const leftCombCompositionTree = (leaves: ReadonlyArray<string>): CompositionTree => {
  if (leaves.length === 0) throw new Error("Composition topology requires at least one leaf");
  if (new Set(leaves).size !== leaves.length) throw new Error("Composition topology leaves must be unique");
  return leaves.slice(1).reduce<CompositionTree>(
    (tree, leaf) => [tree, leaf],
    leaves[0] ?? ""
  );
};

export const parseCompositionBracket = (value: string): CompositionTree | undefined => {
  let index = 0;
  const skipSpace = () => {
    while (/\s/.test(value[index] ?? "")) index += 1;
  };
  const parseNode = (): CompositionTree | undefined => {
    skipSpace();
    if (value[index] === "(") {
      index += 1;
      const left = parseNode();
      if (!left) return undefined;
      skipSpace();
      if (value[index] !== "o") return undefined;
      index += 1;
      const right = parseNode();
      if (!right) return undefined;
      skipSpace();
      if (value[index] !== ")") return undefined;
      index += 1;
      return [left, right];
    }
    const start = index;
    while (index < value.length && !/[\s()]/.test(value[index] ?? "")) index += 1;
    const leaf = value.slice(start, index);
    return leaf && leaf !== "o" ? leaf : undefined;
  };
  const tree = parseNode();
  skipSpace();
  return tree && index === value.length ? tree : undefined;
};

export const topologyForLeaves = (
  leaves: ReadonlyArray<string>,
  requestedBracket?: string
): CompositionTree => {
  const requested = requestedBracket ? parseCompositionBracket(requestedBracket) : undefined;
  if (requested) {
    const requestedLeaves = compositionLeaves(requested);
    if (requestedLeaves.length === leaves.length && requestedLeaves.every((leaf, index) => leaf === leaves[index])) {
      return requested;
    }
  }
  return balancedCompositionTree(leaves);
};

const replaceAt = (
  tree: CompositionTree,
  path: ReadonlyArray<"left" | "right">,
  replacement: CompositionTree
): CompositionTree => {
  if (path.length === 0) return replacement;
  if (typeof tree === "string") throw new Error("Tamari rotation path does not address an internal node");
  const [head, ...tail] = path;
  return head === "left"
    ? [replaceAt(tree[0], tail, replacement), tree[1]]
    : [tree[0], replaceAt(tree[1], tail, replacement)];
};

const rotationsAt = (
  root: CompositionTree,
  node: CompositionTree,
  path: ReadonlyArray<"left" | "right">,
  out: TamariNeighbor[]
): void => {
  if (typeof node === "string") return;
  if (typeof node[0] !== "string") {
    const [a, b] = node[0];
    out.push({ tree: replaceAt(root, path, [a, [b, node[1]]]), direction: "up", path });
  }
  if (typeof node[1] !== "string") {
    const [b, c] = node[1];
    out.push({ tree: replaceAt(root, path, [[node[0], b], c]), direction: "down", path });
  }
  rotationsAt(root, node[0], [...path, "left"], out);
  rotationsAt(root, node[1], [...path, "right"], out);
};

export const tamariNeighbors = (
  tree: CompositionTree,
  direction: TamariDirection | "both" = "both"
): ReadonlyArray<TamariNeighbor> => {
  const candidates: TamariNeighbor[] = [];
  rotationsAt(tree, tree, [], candidates);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (direction !== "both" && candidate.direction !== direction) return false;
    const bracket = compositionBracket(candidate.tree);
    if (seen.has(bracket)) return false;
    seen.add(bracket);
    return true;
  });
};

export const graftCompositionLeaf = (
  tree: CompositionTree,
  anchor: string,
  leaf: string,
  side: "before" | "after" = "after"
): CompositionTree => {
  if (compositionLeaves(tree).includes(leaf)) throw new Error(`Composition leaf ${leaf} already exists`);
  if (typeof tree === "string") {
    if (tree !== anchor) throw new Error(`Composition anchor ${anchor} does not exist`);
    return side === "before" ? [leaf, tree] : [tree, leaf];
  }
  if (compositionLeaves(tree[0], []).includes(anchor)) {
    return [graftCompositionLeaf(tree[0], anchor, leaf, side), tree[1]];
  }
  if (compositionLeaves(tree[1], []).includes(anchor)) {
    return [tree[0], graftCompositionLeaf(tree[1], anchor, leaf, side)];
  }
  throw new Error(`Composition anchor ${anchor} does not exist`);
};

export const contractCompositionLeaf = (
  tree: CompositionTree,
  leaf: string
): CompositionTree | undefined => {
  if (typeof tree === "string") return tree === leaf ? undefined : tree;
  const left = contractCompositionLeaf(tree[0], leaf);
  const right = contractCompositionLeaf(tree[1], leaf);
  if (!left) return right;
  if (!right) return left;
  return [left, right];
};

export const isCompositionGraft = (
  previous: CompositionTree,
  next: CompositionTree
): boolean => {
  const previousLeaves = compositionLeaves(previous);
  const nextLeaves = compositionLeaves(next);
  if (nextLeaves.length !== previousLeaves.length + 1) return false;
  const previousSet = new Set(previousLeaves);
  const added = nextLeaves.filter((leaf) => !previousSet.has(leaf));
  if (added.length !== 1 || !previousLeaves.every((leaf) => nextLeaves.includes(leaf))) return false;
  const newLeaf = added[0];
  if (!newLeaf) return false;
  const nextBracket = compositionBracket(next);
  return previousLeaves.some((anchor) =>
    compositionBracket(graftCompositionLeaf(previous, anchor, newLeaf, "before")) === nextBracket
    || compositionBracket(graftCompositionLeaf(previous, anchor, newLeaf, "after")) === nextBracket
  );
};

export const isCompositionContraction = (
  previous: CompositionTree,
  next: CompositionTree
): boolean => {
  const previousLeaves = compositionLeaves(previous);
  const nextLeaves = compositionLeaves(next);
  if (nextLeaves.length !== previousLeaves.length - 1) return false;
  const nextSet = new Set(nextLeaves);
  const removed = previousLeaves.filter((leaf) => !nextSet.has(leaf));
  if (removed.length !== 1 || !nextLeaves.every((leaf) => previousLeaves.includes(leaf))) return false;
  const contracted = contractCompositionLeaf(previous, removed[0] ?? "");
  return contracted !== undefined && compositionBracket(contracted) === compositionBracket(next);
};

export const topologyPairKey = (left: string, right: string): string =>
  left < right ? `${left}|${right}` : `${right}|${left}`;

export const scoreCompositionTopology = (
  tree: CompositionTree,
  affinities: ReadonlyMap<string, number>,
  parallelWeight = 0.25
): number => {
  const fold = (
    node: CompositionTree,
    depth: number
  ): { readonly leaves: ReadonlyArray<string>; readonly causal: number; readonly parallel: number } => {
    if (typeof node === "string") return { leaves: [node], causal: 0, parallel: 0 };
    const left = fold(node[0], depth + 1);
    const right = fold(node[1], depth + 1);
    let crossCausal = 0;
    for (const leftLeaf of left.leaves) {
      for (const rightLeaf of right.leaves) {
        crossCausal += (affinities.get(topologyPairKey(leftLeaf, rightLeaf)) ?? 0) * (depth + 1);
      }
    }
    const leaves = [...left.leaves, ...right.leaves];
    const balance = Math.min(left.leaves.length, right.leaves.length)
      / Math.max(left.leaves.length, right.leaves.length);
    return {
      leaves,
      causal: left.causal + right.causal + crossCausal,
      parallel: left.parallel + right.parallel + (leaves.length >= 4 ? balance : 0),
    };
  };
  const score = fold(tree, 0);
  return score.causal + score.parallel * parallelWeight;
};

export const selectTamariRotation = (input: {
  readonly tree: CompositionTree;
  readonly affinities: ReadonlyMap<string, number>;
  readonly minGain?: number;
  readonly parallelWeight?: number;
  readonly direction?: TamariDirection | "both";
}): TopologySelection => {
  const previousBracket = compositionBracket(input.tree);
  const currentScore = scoreCompositionTopology(input.tree, input.affinities, input.parallelWeight);
  const neighbors = tamariNeighbors(input.tree, input.direction ?? "both");
  let best: TamariNeighbor | undefined;
  let bestScore = currentScore;
  for (const candidate of neighbors) {
    const score = scoreCompositionTopology(candidate.tree, input.affinities, input.parallelWeight);
    if (score > bestScore || (score === bestScore && best && compositionBracket(candidate.tree) < compositionBracket(best.tree))) {
      best = candidate;
      bestScore = score;
    }
  }
  const gain = bestScore - currentScore;
  const minGain = Math.max(0, input.minGain ?? 0);
  if (!best || gain <= minGain) {
    return {
      tree: input.tree,
      bracket: previousBracket,
      previousBracket,
      direction: "stable",
      score: currentScore,
      gain: 0,
      reason: neighbors.length === 0 ? "topology has no associator rotation" : "no local rotation exceeded hysteresis",
    };
  }
  return {
    tree: best.tree,
    bracket: compositionBracket(best.tree),
    previousBracket,
    direction: best.direction,
    score: bestScore,
    gain,
    reason: `${best.direction} associator at ${best.path.join(".") || "root"} improved coordination score`,
  };
};
