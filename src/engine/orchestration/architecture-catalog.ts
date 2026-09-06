export const COORDINATION_ARCHITECTURE_IDS = [
  "tool-loop",
  "adaptive-graph",
  "parallel-fanout",
  "staged-dag",
  "visual-dag",
] as const;

export type BuiltInCoordinationArchitectureId = typeof COORDINATION_ARCHITECTURE_IDS[number];
export type CoordinationArchitectureId = BuiltInCoordinationArchitectureId | (string & {});

export const COMMAND_RUN_AGENT_IDS = [
  "agent",
  "theorem",
  "axiom-roster",
  "axiom-simple",
  "axiom",
  "writer",
] as const;

export const COMMAND_WORKER_AGENT_IDS = [
  ...COMMAND_RUN_AGENT_IDS,
  "coding-agent",
  "canvas",
  "inspector",
] as const;

export type CommandRunAgentId = typeof COMMAND_RUN_AGENT_IDS[number];

export type CoordinationArchitectureDefinition = {
  readonly id: CoordinationArchitectureId;
  readonly name: string;
  readonly summary: string;
  readonly runtimeAdapter: "agent-loop" | "adaptive-phase-loop" | "fanout-fanin" | "task-dag" | "distributed-control" | (string & {});
  readonly topology: "single" | "fixed" | "planned" | "adaptive";
  readonly population: string;
  readonly composition: string;
  readonly artifactProtocol: "shared-crdt";
  readonly acceptance: string;
  readonly suitedFor: ReadonlyArray<string>;
};

export type CoordinationExampleNavigationId = "adaptive" | "verified" | "swarm" | "writer" | "canvas" | "coding" | (string & {});

export type CoordinationExampleDefinition = {
  readonly agentId: string;
  readonly name: string;
  readonly roomName?: string;
  readonly architectureId: CoordinationArchitectureId;
  readonly category: "example" | "primitive" | "operator";
  readonly coordinationLabel: string;
  readonly description: string;
  readonly artifact: string;
  readonly acceptance: string;
  readonly extensions: ReadonlyArray<string>;
  readonly routePath?: string;
  readonly navigationId?: CoordinationExampleNavigationId;
  readonly navigationSummary?: string;
  readonly command?: {
    readonly kind: string;
    readonly defaultStream: string;
  };
};

export type CoordinationArchitectureExtension = {
  readonly architecture: CoordinationArchitectureDefinition;
  readonly agents: ReadonlyArray<CoordinationExampleDefinition>;
};

export const defineCoordinationArchitectureExtension = <T extends CoordinationArchitectureExtension>(
  extension: T,
): T => extension;

const ARCHITECTURES: ReadonlyArray<CoordinationArchitectureDefinition> = [
  {
    id: "tool-loop",
    name: "Autonomous Tool Loop",
    summary: "One agent iteratively reasons, calls tools, observes results, and stops at a bounded finalizer.",
    runtimeAdapter: "agent-loop",
    topology: "single",
    population: "One primary agent with bounded child delegation when enabled.",
    composition: "The current working artifact is revised after each observation.",
    artifactProtocol: "shared-crdt",
    acceptance: "A domain finalizer validates the terminal artifact and required tool evidence.",
    suitedFor: ["General tasks", "Formal tool work", "Receipt analysis"],
  },
  {
    id: "adaptive-graph",
    name: "Adaptive Agent Graph",
    summary: "The coordinator changes population and merge topology as evidence gaps and conflicts emerge.",
    runtimeAdapter: "adaptive-phase-loop",
    topology: "adaptive",
    population: "Capability demand can spawn, retire, graft, or rotate workers between frontiers.",
    composition: "Concurrent proposals converge through CRDT updates and a versioned topology projector.",
    artifactProtocol: "shared-crdt",
    acceptance: "The active frontier must be conflict-free and satisfy the selected evidence policy.",
    suitedFor: ["Open-ended search", "Debate and synthesis", "Formally verified reasoning"],
  },
  {
    id: "parallel-fanout",
    name: "Parallel Fan-out / Fan-in",
    summary: "Independent strategies race from one immutable input, followed by selection, repair, and verification.",
    runtimeAdapter: "fanout-fanin",
    topology: "fixed",
    population: "A bounded set of strategy workers starts concurrently.",
    composition: "A deterministic join ranks candidates and optionally delegates a focused repair.",
    artifactProtocol: "shared-crdt",
    acceptance: "A dedicated verifier accepts the selected candidate after fan-in.",
    suitedFor: ["Strategy search", "Candidate generation", "Competitive solution discovery"],
  },
  {
    id: "staged-dag",
    name: "Staged Dependency DAG",
    summary: "Capability-bound tasks follow explicit dependencies while independent stages execute concurrently.",
    runtimeAdapter: "task-dag",
    topology: "planned",
    population: "The brief and domain pack materialize the specialists required by the DAG.",
    composition: "Named task outputs feed deterministic downstream dependencies and a final composer.",
    artifactProtocol: "shared-crdt",
    acceptance: "The final artifact is certified against the exact accepted stage outputs.",
    suitedFor: ["Documents", "Research pipelines", "Structured production workflows"],
  },
  {
    id: "visual-dag",
    name: "Distributed Visual Frontier",
    summary: "Parallel artists publish owned patches, then independently propose and endorse how the shared visual frontier should evolve.",
    runtimeAdapter: "distributed-control",
    topology: "adaptive",
    population: "An Art Director creates bounded visual responsibilities for parallel specialist artists.",
    composition: "Yjs scene and control updates converge; peer-supported, conflict-free proposals create the next frontier.",
    artifactProtocol: "shared-crdt",
    acceptance: "Multiple independent roles certify a conflict-free frontier after structural and rendered-image evidence.",
    suitedFor: ["Vector illustration", "Shared canvases", "Spatial composition"],
  },
];

const EXAMPLES: ReadonlyArray<CoordinationExampleDefinition> = [
  {
    agentId: "theorem",
    name: "Adaptive Proof",
    roomName: "#adaptive-proof",
    architectureId: "adaptive-graph",
    category: "example",
    coordinationLabel: "Dynamic topology",
    description: "Spawns needed proof capabilities, retires redundant workers, rebrackets merge order, and stops only after evidence gaps resolve.",
    artifact: "Proof proposals and evidence",
    acceptance: "Conflict-free proof frontier with model verification",
    extensions: ["reflection", "spawn-retire", "tamari-rebracketing"],
    routePath: "/theorem",
    navigationId: "adaptive",
    navigationSummary: "A proof team debates and verifies",
    command: { kind: "theorem.run", defaultStream: "agents/theorem" },
  },
  {
    agentId: "axiom-roster",
    name: "Verified Proof",
    roomName: "#verified-proof",
    architectureId: "adaptive-graph",
    category: "example",
    coordinationLabel: "Evidence hierarchy",
    description: "Uses the adaptive proof graph with delegated Lean/AXLE workers and a mandatory formal-evidence acceptance extension.",
    artifact: "Proof proposals plus formal evidence",
    acceptance: "Conflict-free frontier with successful AXLE verification",
    extensions: ["reflection", "tamari-rebracketing", "formal-evidence-required"],
    routePath: "/axiom",
    navigationId: "verified",
    navigationSummary: "A proof team with formal verification",
    command: { kind: "axiom-roster.run", defaultStream: "agents/axiom-roster" },
  },
  {
    agentId: "axiom-simple",
    name: "Proof Swarm",
    roomName: "#proof-swarm",
    architectureId: "parallel-fanout",
    category: "example",
    coordinationLabel: "Parallel fan-out",
    description: "Launches independent Lean strategies, ranks candidates, repairs when useful, and verifies the selected proof with a final worker.",
    artifact: "Competing Lean proof candidates",
    acceptance: "Selected proof passes the final verification worker",
    extensions: ["strategy-ranking", "targeted-repair", "formal-verifier"],
    routePath: "/axiom-simple",
    navigationId: "swarm",
    navigationSummary: "Independent proof strategies converge",
    command: { kind: "axiom-simple.run", defaultStream: "agents/axiom-simple" },
  },
  {
    agentId: "writer",
    name: "Writer Roster",
    roomName: "#writing-room",
    architectureId: "staged-dag",
    category: "example",
    coordinationLabel: "Staged pipeline",
    description: "Turns a brief into research, structure, critique, revision, and final composition tasks with explicit dependencies.",
    artifact: "Versioned document sections and drafts",
    acceptance: "Final document certified against exact stage outputs",
    extensions: ["brief-planning", "editorial-critique", "document-composer"],
    routePath: "/writer",
    navigationId: "writer",
    navigationSummary: "Research, critique, and final draft",
    command: { kind: "writer.run", defaultStream: "agents/writer" },
  },
  {
    agentId: "coding-agent",
    name: "Coding Roster",
    roomName: "#repository-room",
    architectureId: "adaptive-graph",
    category: "example",
    coordinationLabel: "Demand-driven coding council",
    description: "Derives a bounded coding population from objective risk, spawns one mutation worker plus independent supervisors, and retires them after same-frontier consensus.",
    artifact: "Repository changes and structured implementation reports",
    acceptance: "Every required supervisor approves the exact same remediated Git diff frontier",
    extensions: ["demand-derived-population", "spawn-retire", "codex-cli", "pi-agent", "claude-code", "serialized-mutations", "frontier-consensus"],
    routePath: "/coding",
    navigationId: "coding",
    navigationSummary: "Repository peers build and review",
    command: { kind: "coding-agent.run", defaultStream: "agents/coding-agent" },
  },
  {
    agentId: "canvas",
    name: "Canvas Roster",
    roomName: "#canvas-studio",
    architectureId: "visual-dag",
    category: "example",
    coordinationLabel: "Distributed visual frontier",
    description: "Artists share a Yjs scene and independently publish proposals, endorsements, objections, repairs, and certifications over successive frontiers.",
    artifact: "Owned vector patches in a Yjs scene",
    acceptance: "Independent structural, semantic, composition, and consistency validation over the exact scene frontier",
    extensions: ["model-planned-team", "central-model-escalation", "visual-projector", "validation-council", "distributed-control", "peer-certification"],
    routePath: "/canvas",
    navigationId: "canvas",
    navigationSummary: "Artists shape one shared canvas",
  },
  {
    agentId: "agent",
    name: "General Agent",
    architectureId: "tool-loop",
    category: "primitive",
    coordinationLabel: "Single tool loop",
    description: "Runs a general-purpose tool loop with memory, bounded delegation, steering, follow-up, and replay.",
    artifact: "Task-specific working artifact",
    acceptance: "Workflow finalizer",
    extensions: ["memory", "tools", "bounded-delegation"],
    routePath: "/monitor",
    command: { kind: "agent.run", defaultStream: "agents/agent" },
  },
  {
    agentId: "axiom",
    name: "Lean Worker",
    architectureId: "tool-loop",
    category: "primitive",
    coordinationLabel: "Formal tool worker",
    description: "Generates, checks, diagnoses, and repairs Lean artifacts for proof coordination systems.",
    artifact: "Lean source and AXLE evidence",
    acceptance: "Configured local or AXLE validation",
    extensions: ["lean-tools", "candidate-tracker", "formal-finalizer"],
    command: { kind: "axiom.run", defaultStream: "agents/axiom" },
  },
  {
    agentId: "inspector",
    name: "Replay Analyst",
    architectureId: "tool-loop",
    category: "operator",
    coordinationLabel: "Receipt analysis",
    description: "Analyzes receipt streams and explains decisions, failures, conflicts, queue behavior, and replay state.",
    artifact: "Receipt analysis",
    acceptance: "Evidence-backed operational explanation",
    extensions: ["receipt-tools", "replay-reader"],
  },
];

export const createCoordinationArchitectureRegistry = (
  extensions: ReadonlyArray<CoordinationArchitectureExtension>,
) => {
  const architectures = extensions.map((extension) => extension.architecture);
  const agents = extensions.flatMap((extension) => extension.agents);
  const architectureById = new Map(architectures.map((definition) => [definition.id, definition]));
  const agentById = new Map(agents.map((definition) => [definition.agentId, definition]));

  if (architectureById.size !== architectures.length) throw new Error("Coordination architecture IDs must be unique");
  if (agentById.size !== agents.length) throw new Error("Coordination agent IDs must be unique");
  for (const extension of extensions) {
    for (const definition of extension.agents) {
      if (definition.architectureId !== extension.architecture.id) {
        throw new Error(`Agent ${definition.agentId} must use its extension architecture ${extension.architecture.id}`);
      }
      if (definition.category === "example" && (!definition.routePath || !definition.navigationId)) {
        throw new Error(`Coordination example ${definition.agentId} requires route and navigation metadata`);
      }
    }
  }

  return Object.freeze({
    architectures: (): ReadonlyArray<CoordinationArchitectureDefinition> => architectures,
    agents: (): ReadonlyArray<CoordinationExampleDefinition> => agents,
    examples: (): ReadonlyArray<CoordinationExampleDefinition> =>
      agents.filter((definition) => definition.category === "example"),
    architecture: (id: CoordinationArchitectureId): CoordinationArchitectureDefinition => {
      const definition = architectureById.get(id);
      if (!definition) throw new Error(`Unknown coordination architecture ${id}`);
      return definition;
    },
    agent: (agentId: string): CoordinationExampleDefinition | undefined => agentById.get(agentId),
    examplesFor: (id: CoordinationArchitectureId): ReadonlyArray<CoordinationExampleDefinition> =>
      agents.filter((definition) => definition.category === "example" && definition.architectureId === id),
  });
};

const BUILTIN_EXTENSIONS: ReadonlyArray<CoordinationArchitectureExtension> = ARCHITECTURES.map((architecture) =>
  defineCoordinationArchitectureExtension({
    architecture,
    agents: EXAMPLES.filter((definition) => definition.architectureId === architecture.id),
  }));

const BUILTIN_REGISTRY = createCoordinationArchitectureRegistry(BUILTIN_EXTENSIONS);

export const coordinationArchitectureExtensions = (): ReadonlyArray<CoordinationArchitectureExtension> => BUILTIN_EXTENSIONS;
export const coordinationArchitectures = BUILTIN_REGISTRY.architectures;
export const coordinationExamples = BUILTIN_REGISTRY.examples;
export const coordinationAgentDefinitions = BUILTIN_REGISTRY.agents;
export const getCoordinationArchitecture = BUILTIN_REGISTRY.architecture;
export const getCoordinationAgentDefinition = BUILTIN_REGISTRY.agent;
export const examplesForArchitecture = BUILTIN_REGISTRY.examplesFor;
export const validateCoordinationCatalog = (): void => { createCoordinationArchitectureRegistry(BUILTIN_EXTENSIONS); };
