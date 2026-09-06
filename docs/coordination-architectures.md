# Coordination Architecture Extensions

Roster defines coordination once in `src/engine/orchestration/architecture-catalog.ts`. An architecture extension describes execution mechanics; its agent examples add domain artifacts, tools, prompts, and acceptance rules.

This keeps two concerns separate:

- The shared kernel owns durable tasks, leases, retries, CRDT publication, projection, certification, and replay.
- Architecture extensions describe topology, population, and composition. Their architecture adapter implements the coordination pattern; a separate node runtime adapter executes each participant's inner loop.

## Built-in architectures

| Architecture | Coordination adapter | Examples |
| --- | --- | --- |
| `tool-loop` | `agent-loop` | General Agent and Lean Worker primitives |
| `adaptive-graph` | `adaptive-phase-loop` | Adaptive Proof, Verified Proof |
| `parallel-fanout` | `fanout-fanin` | Proof Swarm |
| `staged-dag` | `task-dag` | Writer Roster |
| `visual-dag` | `distributed-control` | Canvas Roster |

Verified Proof intentionally reuses `adaptive-graph`; its `formal-evidence-required` extension changes acceptance rather than inventing another orchestration engine.

## Extension contract

Use `defineCoordinationArchitectureExtension` to declare one architecture and its examples, then compose extensions with `createCoordinationArchitectureRegistry`.

```ts
const extension = defineCoordinationArchitectureExtension({
  architecture: {
    id: "staged-dag",
    name: "Staged Dependency DAG",
    runtimeAdapter: "task-dag", // coordination adapter, not node runtime
    topology: "planned",
    artifactProtocol: "shared-crdt",
    // population, composition, acceptance, and UI copy
  },
  agents: [
    {
      agentId: "writer",
      architectureId: "staged-dag",
      category: "example",
      // route, command, artifact, acceptance, and extension metadata
    },
  ],
});
```

The registry rejects duplicate architecture IDs, duplicate agent IDs, examples without routes, and agents attached to the wrong extension. Dispatch, display metadata, sidebar navigation, and the Command Center architecture catalog all read this registry.

## Adding another example

Add an example to an existing extension when it changes only the domain, prompts, tools, projector, or acceptance policy. Add an architecture only when execution topology or composition mechanics are genuinely new.

Every production example should provide:

1. An architecture ID and coordination adapter.
2. A bounded population policy.
3. A CRDT artifact and domain projector.
4. An explicit acceptance extension.
5. A route and replayable UI projection.
6. Deterministic schedule and failure coverage.

The Command Center renders these definitions under the **Architectures** tab, presenting each application as an example of a reusable coordination type.

## Choosing an example

| Example | Route | Population and composition | Acceptance |
| --- | --- | --- | --- |
| Adaptive Proof | `/theorem` | Capability demand can spawn or retire specialists and rebracket the proof frontier | Evidence gaps and conflicts must clear |
| Verified Proof | `/axiom` | Adaptive proof team delegates formal obligations to Lean/AXLE workers | Final composition requires successful formal evidence |
| Proof Swarm | `/axiom-simple` | Independent strategies race, rank, repair, and join deterministically | The selected proof must pass the final verifier |
| Writer Roster | `/writer` | Research, structure, drafting, critique, revision, and composition follow artifact dependencies | Final document is composed from exact accepted stage outputs |
| Canvas Roster | `/canvas` | Model-planned artists own scene patches while peers propose and review frontier changes | Independent validation must certify the exact scene frontier |

`Lean Worker` and `General Agent` are reusable worker primitives, not complete
coordination examples. Operational surfaces are separate: Command Center
dispatches and inspects work, Simulation Lab searches schedules and faults, and
Replay examines durable receipt history.

Add an example when a domain makes an existing coordination behavior easier to
understand. Add an architecture only when topology or composition mechanics are
genuinely new. A stricter evidence rule normally belongs in an acceptance
extension, as Verified Proof demonstrates, rather than in another scheduler.
