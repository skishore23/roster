import { materializeNodeDemand, type NodeDemand } from "../engine/orchestration/adaptive.js";
import { createDomainRegistry } from "../engine/orchestration/domain.js";
import type { DomainPack, DomainRegistry, WorkspaceNode } from "../engine/orchestration/types.js";
import { rosterNativeRuntime } from "../engine/workspace/node.js";

export const THEOREM_DOMAIN_ID = "theorem";

export type TheoremNodeRole =
  | "orchestrator"
  | "explorer"
  | "lemma"
  | "critic"
  | "verifier"
  | "synthesizer";

export type TheoremNodeSpec = WorkspaceNode & {
  readonly role: TheoremNodeRole;
  readonly podId: string;
  readonly promptKey: string;
  readonly focus?: string;
};

const EXPLORER_FOCUSES = [
  "Construct a direct proof and identify the shortest valid route.",
  "Search for useful lemmas, decompositions, and equivalent formulations.",
  "Stress-test boundary cases and try contradiction or counterexample-driven reasoning.",
  "Look for an invariant, monotonic quantity, or preserved structure.",
  "Try induction and isolate the strongest induction hypothesis needed.",
  "Translate the problem into an algebraic or combinatorial representation.",
  "Seek a constructive witness or explicit algorithm.",
  "Look for symmetry, normalization, and without-loss-of-generality reductions.",
  "Try an extremal argument using a minimal or maximal counterexample.",
  "Separate necessary conditions from sufficient conditions.",
  "Search for a geometric, probabilistic, or counting interpretation.",
  "Plan a formalization-friendly proof with small verifiable steps.",
  "Find analogous known results and adapt their proof structure.",
  "Attack the hardest unresolved subclaim independently.",
  "Synthesize a fallback route that avoids assumptions used by other explorers.",
] as const;

export type TheoremNodeDemand = NodeDemand & {
  readonly role: Exclude<TheoremNodeRole, "orchestrator">;
  readonly promptKey: string;
};

export const THEOREM_CAPABILITIES = [
  { id: "coordinate", description: "Decompose goals, allocate work, reflect, and revise the execution plan." },
  { id: "solve", description: "Develop an independent candidate solution for a bounded goal." },
  { id: "extract", description: "Extract reusable intermediate claims and obligations." },
  { id: "criticize", description: "Find unsupported assumptions, contradictions, and missing cases." },
  { id: "repair", description: "Repair a specific rejected or incomplete candidate." },
  { id: "verify", description: "Evaluate a candidate against the domain evidence policy." },
  { id: "compose", description: "Compose versioned artifacts without silently resolving conflicts." },
  { id: "finalize", description: "Produce a final result from certified artifacts." },
] as const;

const focusCandidates = (problem: string): ReadonlyArray<{ readonly focus: string; readonly relevant: boolean }> => {
  const text = problem.toLowerCase();
  return [
    { focus: EXPLORER_FOCUSES[0], relevant: true },
    { focus: EXPLORER_FOCUSES[1], relevant: true },
    { focus: EXPLORER_FOCUSES[2], relevant: /find all|counterexample|contradiction|false|necessary|sufficient/.test(text) },
    { focus: EXPLORER_FOCUSES[3], relevant: /process|invariant|terminat|sequence|iteration|preserv/.test(text) },
    { focus: EXPLORER_FOCUSES[4], relevant: /induct|natural|integer|recursive|sequence|\bn\b/.test(text) },
    { focus: EXPLORER_FOCUSES[5], relevant: /algebra|equation|inequality|polynomial|function|group|ring/.test(text) },
    { focus: EXPLORER_FOCUSES[6], relevant: /construct|exists|witness|algorithm|find/.test(text) },
    { focus: EXPLORER_FOCUSES[7], relevant: /symmetr|commut|without loss|wlog|permutation/.test(text) },
    { focus: EXPLORER_FOCUSES[8], relevant: /extrem|minimal|maximal|bound|finite/.test(text) },
    { focus: EXPLORER_FOCUSES[10], relevant: /probab|count|combin|geometr|graph/.test(text) },
    { focus: EXPLORER_FOCUSES[11], relevant: /lean|mathlib|formaliz|proof assistant/.test(text) },
    { focus: EXPLORER_FOCUSES[13], relevant: problem.length > 480 || (problem.match(/[.;:]/g)?.length ?? 0) >= 5 },
  ];
};

const requestedExplorerCount = (problem: string): number | undefined => {
  const words: Readonly<Record<string, number>> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    twenty: 20,
  };
  const match = problem.toLowerCase().match(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\s+(?:independent\s+)?(?:explorers?|agents?|proof\s+routes?|strategies?)\b/
  );
  if (!match?.[1]) return undefined;
  const parsed = /^\d+$/.test(match[1]) ? Number.parseInt(match[1], 10) : words[match[1]];
  return parsed && parsed > 0 ? parsed : undefined;
};

export const deriveTheoremNodeDemands = (
  problem: string,
  maxParallel: number
): ReadonlyArray<TheoremNodeDemand> => {
  const candidates = focusCandidates(problem);
  const specializedSignals = candidates.slice(2).filter((candidate) => candidate.relevant).length;
  const punctuationSignals = problem.match(/[.;:]/g)?.length ?? 0;
  const complexity = specializedSignals + Math.floor(problem.length / 320) + Math.floor(punctuationSignals / 4);
  const inferredCount = complexity === 0 ? 1 : 2 + Math.ceil(complexity / 2);
  const focusLimit = Math.max(1, Math.min(
    Math.floor(maxParallel),
    requestedExplorerCount(problem) ?? inferredCount
  ));
  const relevant = candidates.filter((candidate) => candidate.relevant);
  const fallback = candidates.filter((candidate) => !candidate.relevant);
  const focuses = [...relevant, ...fallback]
    .map((candidate) => candidate.focus)
    .filter((focus, index, all) => all.indexOf(focus) === index)
    .slice(0, focusLimit);
  const explorers: TheoremNodeDemand[] = focuses.map((focus, index) => ({
    capability: "solve",
    objective: `Develop an independent proof route: ${focus}`,
    name: `Explorer ${index + 1}`,
    role: "explorer",
    promptKey: `explorer_${(["a", "b", "c"] as const)[index % 3]}`,
    promptProfile: `explorer_${(["a", "b", "c"] as const)[index % 3]}`,
    group: "Independent proof routes",
    focus,
    metadata: { role: "explorer" },
  }));
  return [
    ...explorers,
    {
      capability: "extract",
      objective: "Extract reusable lemmas when the current frontier needs decomposition.",
      name: "Lemma Analyst",
      role: "lemma",
      promptKey: "lemma_miner",
      promptProfile: "lemma_miner",
      group: "Review and synthesis",
      metadata: { role: "lemma" },
    },
    {
      capability: "criticize",
      objective: "Challenge assumptions and identify gaps in active proof routes.",
      name: "Skeptic",
      role: "critic",
      promptKey: "skeptic",
      promptProfile: "skeptic",
      group: "Review and synthesis",
      metadata: { role: "critic" },
    },
    {
      capability: "repair",
      additionalCapabilities: ["verify"],
      objective: "Repair rejected routes and verify evidence obligations.",
      name: "Verifier",
      role: "verifier",
      promptKey: "verifier",
      promptProfile: "verifier",
      group: "Review and synthesis",
      metadata: { role: "verifier" },
    },
    {
      capability: "compose",
      additionalCapabilities: ["finalize"],
      objective: "Compose certified artifacts and produce the final proof.",
      name: "Synthesizer",
      role: "synthesizer",
      promptKey: "synthesizer",
      promptProfile: "synthesizer",
      group: "Review and synthesis",
      metadata: { role: "synthesizer" },
    },
  ];
};

export const materializeTheoremNode = (input: {
  readonly runId: string;
  readonly reflectionId: string;
  readonly index: number;
  readonly demand: TheoremNodeDemand;
}): TheoremNodeSpec => {
  const created = materializeNodeDemand({
    ...input,
    coordinatorId: "orchestrator",
  });
  const podId = input.demand.role === "explorer" ? created.id : "review";
  return {
    ...created,
    role: input.demand.role,
    podId,
    promptKey: input.demand.promptKey,
    focus: input.demand.focus,
    metadata: {
      ...(created.metadata ?? {}),
      role: input.demand.role,
      podId,
    },
  };
};

export const defineTheoremRoster = (
  maxParallel: number,
  maxNodes = 128
): { readonly pack: DomainPack; readonly registry: DomainRegistry } => {
  const registry = createDomainRegistry({
    id: THEOREM_DOMAIN_ID,
    version: "3.0",
    policyVersion: "theorem-adaptive-v3",
    coordinatorId: "orchestrator",
    capabilities: THEOREM_CAPABILITIES,
    nodes: [{
      id: "orchestrator",
      name: "Orchestrator",
      capabilities: ["coordinate", "finalize"],
      promptProfile: "orchestrator",
      runtime: rosterNativeRuntime("theorem.orchestrator"),
      metadata: { role: "orchestrator", group: "Coordination" },
    }],
    limits: {
      maxNodes: Math.max(2, Math.floor(maxNodes)),
      maxTasks: 10_000,
      maxParallel: Math.max(1, Math.floor(maxParallel)),
      maxDepth: 16,
    },
  });
  return { pack: registry.pack, registry };
};

export const theoremAdaptiveDomain = (
  maxParallel: number,
  maxNodes = 128
): { readonly pack: DomainPack; readonly registry: DomainRegistry } => {
  return defineTheoremRoster(maxParallel, maxNodes);
};
