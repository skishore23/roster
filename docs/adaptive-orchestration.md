# Adaptive Orchestration

Roster separates three questions that are often collapsed into one "multi-agent" setting:

1. **Population:** which capabilities are currently needed, and which workspace nodes should exist?
2. **Execution:** which ready tasks may run concurrently against one immutable frontier?
3. **Composition:** in what order should independent artifacts be merged and certified?

The answers are derived during a run. A domain pack supplies capabilities and demand policy, but it does not supply a fixed team size or a fixed binary merge tree.

## Two-Tier Model

The architecture is inspired by a 2-category, without claiming that arbitrary model outputs form a lawful mathematical 2-category.

- Objects correspond to versioned artifact frontiers.
- 1-morphisms correspond to capability-bound tasks that transform declared inputs into immutable outputs.
- 2-morphisms correspond to explicit comparisons between paths: critique, repair, reconciliation, evidence, and certification.
- Binary composition trees describe the operational order in which independent artifacts are combined.

The useful consequence is separation of execution from reflection. Workers produce first-order artifacts. Reflection observes receipts about those artifacts and emits second-order coordination decisions. Those decisions never rewrite history; they append a new receipt.

## Population Is Demand-Driven

A run begins with a coordinator node and a set of unmet capability demands:

```ts
type NodeDemand = {
  capability: string;
  objective: string;
  name?: string;
  nameSource?: "planner" | "profile";
  focus?: string;
  parentId?: string;
  metadata?: Record<string, JsonValue>;
};
```

`materializeNodeDemand` deterministically derives a workspace-node identity
from the run, reflection, demand, and demand index. The optional human-readable
name is deliberately excluded from that identity: renaming a persona does not
create another node. If a planner or profile omits the name, Roster generates a
readable role-based name deterministically. Replaying the same receipts
therefore creates the same population and presentation.

For reusable applications, `defineRosterPlatform` is the public boundary around
this machinery. `createRosterRootTask` seeds one canonical mutable DAG; a
deterministic or model-backed coordinator may publish bounded children plus an
explicit continuation through `roster::expand`. Roster checks node
authorization, population, task count, depth, semantic uniqueness,
dependencies, joins, and concurrency at every graph mutation. Theorem, Writer,
and Canvas create their registries through this platform boundary.

Population changes are explicit:

- `node.spawned` adds a capability-bound node;
- `node.retired` removes a redundant node from the active population;
- the coordinator cannot be retired;
- capability authorization and resource ceilings are checked by the reducer.

`maxNodes` and `maxParallel` are safety ceilings, not requested roster sizes.
The theorem pack starts from objective-derived minimum demand; its pre-round
coordinator can request additional independent focuses, each recorded as a
reflection, spawn, branch, and topology graft. A failed explorer is receipted,
retired, and contracted while the phase continues when at least one independent
route survives. Deployments set the population ceiling with `ROSTER_MAX_NODES`,
the automatic concurrency cap with `ROSTER_DEFAULT_MAX_PARALLEL`, and the
absolute per-run concurrency ceiling with `ROSTER_MAX_PARALLEL`. The theorem
and writer forms leave the cap on `Auto` unless an operator supplies a
run-specific override.

Population and task count are different. A node identity represents a durable capability and provenance boundary; a task represents one bounded unit of work. One node may execute several tasks over time, while hundreds of logical nodes can remain mostly inactive behind a much smaller `maxInflight` ceiling. Runtime bindings and sandboxes are replaceable placement details rather than population identity.

## Delegation Is Bounded Discovery

A worker may discover that its objective contains independent subproblems and
publish child tasks plus an explicit continuation with
`expandAndDelegateRosterTask`. The operation is allowed only while the parent
lease and fence are active. It carries a stable expansion key so retrying the
same decision cannot duplicate children.

SpacetimeDB validates the total task count, delegation depth, per-parent
fan-out, dependency existence and acyclicity, worker capabilities, attempt
budget, and current in-flight ceiling. The parent/child edge records who
delegated the work; explicit dependency edges determine when each child becomes
claimable. The same transaction releases the parent lease so the continuation
can eventually compose accepted child outcomes without a parent-slot deadlock.

The coordinator keeps the only authority to reinterpret the global goal, approve a new frontier, certify composition, or stop. Workers may spill useful work within the policy; they may not silently expand the policy itself. This is the practical balance between autonomous discovery and a controllable production system.

## Composition Topology

For an ordered frontier of `n` leaves, a fully parenthesized binary tree is a vertex of the associahedron `K_n`. A local associator

```text
((a o b) o c)  ->  (a o (b o c))
```

is an oriented edge in the Tamari lattice. Roster records that edge as `topology.selected` with operation `rotate`. The reducer proves that:

- leaf identity and order are unchanged;
- the new tree is exactly one local rotation away;
- the direction is recorded;
- the event extends the currently active topology.

Roster does not enumerate all Catalan-many trees. It scores only local neighbors, applies hysteresis, and takes at most one rotation at a reflection point. This avoids a combinatorial search while allowing repeated reflections to move through the lattice.

Population change is not a Tamari rotation. Spawning moves from `K_n` to `K_(n+1)` by grafting one new leaf. Retirement moves to `K_(n-1)` by contracting one leaf. The reducer requires exact local graft and contraction operations, so an event cannot hide an unrelated reorder or rebracketing.

## Coordination Score

The local topology policy combines two signals:

- **causal affinity:** artifacts with critique, repair, or evidence relationships should meet lower in the tree;
- **parallel potential:** balanced independent subtrees expose useful merge concurrency.

For a tree `T`, the causal component is:

```text
score(T) = sum affinity(i, j) * (depth(lca_T(i, j)) + 1)
```

The implementation computes this with one tree fold per candidate. At a frontier of `n` leaves there are `O(n)` local rotations and each candidate score is `O(n^2)`, giving `O(n^3)` worst-case local selection instead of enumerating the `Catalan(n-1)` global space.

This score chooses an operational composition order. It does not prove that two model-generated compositions are semantically equal.

## Reflection Loop

At each safe frontier barrier, the coordinator records an observation:

- active, pending, running, and failed work;
- unresolved evidence gaps and merge conflicts;
- stagnation rounds and confidence;
- whether the domain acceptance policy is satisfied.

`reflectOnOrchestration` produces one receipted decision containing any of:

- `spawn`: materialize an unmet capability demand;
- `retire`: contract redundant work after consolidation;
- `rebracket`: apply one local associator with positive gain;
- `replan`: replace a failed or incomplete frontier;
- `continue`: preserve the current organization;
- `stop`: terminate only when goal and evidence policy are satisfied.

The observation, policy version, actions, and reason are hashed into the reflection identity. Duplicate delivery is idempotent and reflection iterations must be consecutive.

Reflection changes future coordination, not prior facts. This is the operational basis for course correction: the system can inspect its own failures, gaps, conflicts, and topology, then alter population, plan, or merge order without mutating the receipt chain.

## Coherence And Certification

Mac Lane coherence motivates using local associators instead of arbitrary tree rewrites. Roster still treats semantic coherence as an obligation:

- a topology receipt proves only that the structural move is legal;
- immutable input versions define the exact merge boundary;
- domain evidence evaluates the proposed semantic composition;
- `composition.certified` is the acceptance boundary;
- divergent proposals remain visible conflicts.

This distinction matters for non-deterministic agents. Structural equivalence of bracketings does not imply equality of generated text, proofs, plans, or tool effects.

## Learning Boundary

Run-local reflection is active adaptation. Cross-run learning is intentionally separate. A policy update should be proposed from historical receipts, evaluated in deterministic simulations and domain benchmarks, versioned, and then approved or promoted. Allowing a run to silently rewrite its own policy would make replay and certification meaningless.

## Simulation Contract

`tests/smoke/adaptive-orchestration-simulation.test.ts` exercises variable populations, concurrent schedules, injected worker failures, retry, local rotation, graft, contraction, duplicate receipt delivery, and entropy-exact replay. The broader kernel campaign exercises 64-node DAG execution and composition conflicts.

These tests establish deterministic coordination and replay properties. They do not establish that an external language model will produce a correct answer; domain evaluation and evidence policies remain necessary.
