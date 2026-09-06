import { materializeNodeDemand, type NodeDemand } from "../engine/orchestration/adaptive.js";
import { createDomainRegistry } from "../engine/orchestration/domain.js";
import type { DomainPack, DomainRegistry, WorkspaceNode } from "../engine/orchestration/types.js";
import { rosterNativeRuntime } from "../engine/workspace/node.js";

export type WriterNodeRole =
  | "researcher"
  | "architect"
  | "drafter"
  | "critic.logic"
  | "critic.style"
  | "editor"
  | "synthesizer";

export type WriterNodeDemand = NodeDemand & {
  readonly role: WriterNodeRole;
  readonly promptKey: string;
};

export type WriterNodeSpec = WorkspaceNode & {
  readonly role: WriterNodeRole;
  readonly promptKey: string;
  readonly focus?: string;
};

const WRITER_CAPABILITIES = [
  { id: "coordinate", description: "Plan writing work, reflect, and allocate bounded tasks." },
  { id: "research", description: "Collect a distinct body of relevant source material and ideas." },
  { id: "structure", description: "Turn research into a coherent document structure." },
  { id: "draft", description: "Create a draft from an accepted structure and source material." },
  { id: "criticize.logic", description: "Review factual, logical, and structural coherence." },
  { id: "criticize.style", description: "Review language, tone, and readability." },
  { id: "edit", description: "Reconcile critiques into a revised artifact." },
  { id: "compose", description: "Produce a final artifact from verified revisions." },
] as const;

export const defineWriterRoster = (
  maxParallel: number,
  maxNodes = 128
): { readonly pack: DomainPack; readonly registry: DomainRegistry } => {
  const registry = createDomainRegistry({
      id: "writer",
      version: "2.0",
      policyVersion: "writer-adaptive-v1",
      coordinatorId: "orchestrator",
      capabilities: WRITER_CAPABILITIES,
      nodes: [{
        id: "orchestrator",
        name: "Orchestrator",
        capabilities: ["coordinate"],
        promptProfile: "orchestrator",
        runtime: rosterNativeRuntime("writer.orchestrator"),
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

export const writerAdaptiveDomain = (
  maxParallel: number,
  maxNodes = 128
): { readonly pack: DomainPack; readonly registry: DomainRegistry } => {
  return defineWriterRoster(maxParallel, maxNodes);
};

export const deriveWriterNodeDemands = (
  problem: string,
  maxParallel: number
): ReadonlyArray<WriterNodeDemand> => {
  const text = problem.toLowerCase();
  const researchLenses = [
    { focus: "evidence", objective: "Collect the strongest evidence and factual support.", relevant: true },
    { focus: "counterpoint", objective: "Find counterarguments, risks, and alternative interpretations.", relevant: true },
    { focus: "examples", objective: "Develop concrete examples and implementation details.", relevant: problem.length > 160 || /example|technical|implementation|case study/.test(text) },
    { focus: "audience", objective: "Model audience questions, context, and decision needs.", relevant: /audience|executive|customer|proposal|brief|explain/.test(text) },
    { focus: "sources", objective: "Identify claims that need primary-source validation.", relevant: /research|report|analysis|current|latest|source/.test(text) },
  ].filter((lens) => lens.relevant).slice(0, Math.max(2, Math.floor(maxParallel)));
  const researchers: WriterNodeDemand[] = researchLenses.map((lens, index) => ({
    capability: "research",
    objective: lens.objective,
    name: `Researcher ${index + 1}`,
    role: "researcher",
    promptKey: "researcher_a",
    promptProfile: (["researcher_a", "researcher_b", "researcher_c"] as const)[index % 3],
    group: "Research",
    focus: lens.focus,
    metadata: { role: "researcher", focus: lens.focus },
  }));
  return [
    ...researchers,
    { capability: "structure", objective: "Compose research into a coherent outline.", name: "Architect", role: "architect", promptKey: "architect", promptProfile: "architect", group: "Draft", metadata: { role: "architect" } },
    { capability: "draft", objective: "Create a complete draft from the outline and research.", name: "Drafter", role: "drafter", promptKey: "drafter", promptProfile: "drafter", group: "Draft", metadata: { role: "drafter" } },
    { capability: "criticize.logic", objective: "Find factual, logical, and structural defects.", name: "Logic Critic", role: "critic.logic", promptKey: "critic_logic", promptProfile: "critic_logic", group: "Review", metadata: { role: "critic.logic" } },
    { capability: "criticize.style", objective: "Find tone, clarity, and readability defects.", name: "Style Critic", role: "critic.style", promptKey: "critic_style", promptProfile: "critic_style", group: "Review", metadata: { role: "critic.style" } },
    { capability: "edit", objective: "Reconcile independent critiques into a revision.", name: "Editor", role: "editor", promptKey: "editor", promptProfile: "editor", group: "Review", metadata: { role: "editor" } },
    { capability: "compose", objective: "Compose the final document from verified revisions.", name: "Synthesizer", role: "synthesizer", promptKey: "synthesizer", promptProfile: "synthesizer", group: "Composition", metadata: { role: "synthesizer" } },
  ];
};

export const materializeWriterNode = (input: {
  readonly runId: string;
  readonly reflectionId: string;
  readonly index: number;
  readonly demand: WriterNodeDemand;
}): WriterNodeSpec => {
  const created = materializeNodeDemand({ ...input, coordinatorId: "orchestrator" });
  return {
    ...created,
    role: input.demand.role,
    promptKey: input.demand.promptKey,
    focus: input.demand.focus,
    metadata: { ...(created.metadata ?? {}), role: input.demand.role },
  };
};
