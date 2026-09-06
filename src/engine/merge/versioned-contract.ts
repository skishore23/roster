import { createHash } from "node:crypto";

export type BinaryMergeTree = string | [BinaryMergeTree, BinaryMergeTree];

export type VersionedMergeStep = {
  readonly mergeId: string;
  readonly bracket: string;
  readonly inputRefs: ReadonlyArray<string>;
  readonly inputLabels: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
  readonly boundaryHash: string;
};

export type VersionedMergePlan = {
  readonly planVersion: string;
  readonly round: number;
  readonly bracket: string;
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly steps: ReadonlyArray<VersionedMergeStep>;
};

export type VersionedMergeProposal = {
  readonly mergeId: string;
  readonly planVersion: string;
  readonly inputVersions: ReadonlyArray<string>;
  readonly outputHash: string;
  readonly boundaryHash: string;
};

export type ResolvedMergeOutput = {
  readonly mergeId: string;
  readonly planVersion: string;
  readonly inputVersions: ReadonlyArray<string>;
  readonly outputHash: string;
  readonly boundaryHash: string;
};

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const treeString = (tree: BinaryMergeTree): string =>
  typeof tree === "string" ? tree : `(${treeString(tree[0])} o ${treeString(tree[1])})`;

const leaves = (tree: BinaryMergeTree, out: string[] = []): string[] => {
  if (typeof tree === "string") {
    out.push(tree);
    return out;
  }
  leaves(tree[0], out);
  leaves(tree[1], out);
  return out;
};

export const mergeBoundaryHash = (
  planVersion: string,
  mergeId: string,
  inputRefs: ReadonlyArray<string>
): string => hash(`${planVersion}|${mergeId}|${inputRefs.join("|")}`);

export const buildVersionedMergePlan = (opts: {
  readonly runId: string;
  readonly round: number;
  readonly bracket: string;
  readonly tree: BinaryMergeTree;
  readonly maxDepth: number;
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly leafLabel?: (leaf: string) => string;
}): VersionedMergePlan => {
  const depth = Number.isFinite(opts.maxDepth) ? Math.max(1, Math.floor(opts.maxDepth)) : 1;
  const sourceEntries = Object.entries(opts.sourceVersions).sort(([left], [right]) => left.localeCompare(right));
  const planVersion = hash(JSON.stringify([
    opts.runId,
    opts.round,
    treeString(opts.tree),
    depth,
    sourceEntries,
  ])).slice(0, 16);
  const steps: VersionedMergeStep[] = [];

  const appendStep = (
    node: [BinaryMergeTree, BinaryMergeTree],
    inputRefs: ReadonlyArray<string>,
    inputLabels: ReadonlyArray<string>
  ): string => {
    const mergeId = `merge-r${opts.round}-${steps.length + 1}`;
    steps.push({
      mergeId,
      bracket: treeString(node),
      inputRefs,
      inputLabels,
      dependsOn: inputRefs.filter((ref) => ref.startsWith("merge-")),
      boundaryHash: mergeBoundaryHash(planVersion, mergeId, inputRefs),
    });
    return mergeId;
  };

  const walk = (node: BinaryMergeTree, remainingDepth: number): { ref: string; label: string } => {
    if (typeof node === "string") {
      return { ref: `pod:${node}`, label: opts.leafLabel?.(node) ?? node };
    }
    if (remainingDepth <= 1) {
      const nodeLeaves = leaves(node);
      const refs = nodeLeaves.map((leaf) => `pod:${leaf}`);
      const labels = nodeLeaves.map((leaf) => opts.leafLabel?.(leaf) ?? leaf);
      const ref = appendStep(node, refs, labels);
      return { ref, label: `Merge ${steps.length}` };
    }
    const left = walk(node[0], remainingDepth - 1);
    const right = walk(node[1], remainingDepth - 1);
    const ref = appendStep(node, [left.ref, right.ref], [left.label, right.label]);
    return { ref, label: `Merge ${steps.length}` };
  };

  walk(opts.tree, depth);
  return {
    planVersion,
    round: opts.round,
    bracket: opts.bracket,
    sourceVersions: { ...opts.sourceVersions },
    steps,
  };
};
