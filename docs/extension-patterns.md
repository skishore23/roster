# Extension Patterns

Roster keeps reusable coordination policies separate from domain prompts and
artifacts. Use these extensions when a workflow needs distributed decisions,
independent acceptance evidence, or bounded model recovery. They do not replace
the task scheduler, runtime binding, receipt log, or domain projector.

## Distributed decisions

Distributed control lets leased agents observe a shared frontier and publish
proposals, endorsements, objections, abstentions, or withdrawals as immutable
Yjs updates. It does not replace one harness coordinator with one model-owned
coordinator.

The projector validates capability authority, evidence, peer support, and
conflicts. An eligible proposal still has no external effect until its exact
projection is durably certified. Runtime services then apply accepted actions
through fenced SpacetimeDB reducers.

Protected actions—retirement, budget transfer, join changes, and
certification—require multiple independent roles. One critic cannot command a
repair or veto the run, and equivocation excludes that agent's votes. Competing
global proposals remain explicit until agents withdraw, counter-propose, or add
evidence.

The runtime fixes only safety invariants:

- tenant and capability authorization;
- maximum tasks, depth, fan-out, attempts, parallelism, and cost;
- lease fencing, idempotency, and immutable proposal identities;
- peer thresholds for protected actions;
- conflict-free certified projections before external effects.

It does not fix the number or order of research branches, critique loops,
repairs, or join strategies. Those may emerge from the live frontier.

Implementation: `src/engine/orchestration/distributed-control.ts` defines the
bounded action language and projector. `distributed-control-runtime.ts` applies
accepted actions exactly once without choosing them.

## Validation councils

A validation council replaces one broad final judge with independent,
capability-scoped reports over one exact artifact frontier. Useful specialties
include deterministic schema or geometry checks, tool evidence, semantic task
fidelity, cross-part coherence, and domain quality.

Each immutable report names its validator, role, kind, artifact hash, frontier,
findings, evidence, and verdict. The projector:

1. rejects stale or malformed reports;
2. requires every configured specialty;
3. preserves contradictory reports as a CRDT conflict;
4. applies domain score floors and blocking severities mechanically;
5. returns `repair`, `polish`, `certify`, or `inconclusive`;
6. hashes the accepted report set so delivery order cannot change certification.

Use independent evidence, not several copies of the same prompt and model. Hard
validators should block only facts established by their owned evidence. Soft
quality findings should usually create bounded repair work or remain explicit
completion notes when the budget is exhausted.

| Domain | Deterministic or tool evidence | Semantic or peer evidence |
| --- | --- | --- |
| Canvas | geometry, ownership, renderability, conflicts | subject fidelity, composition, consistency |
| Writer | citations, section coverage, output schema | factuality, argument coherence, editorial quality |
| Proof | parser, type checker, Lean/AXLE | strategy relevance, explanation, gap analysis |

Implementation: `src/engine/orchestration/validation-council.ts`. Canvas is the
first consumer, but the council does not depend on Canvas geometry or prompts.

## Model recovery

Central model escalation separates a domain's model ladder from the mechanics
of safely retrying external effects. A `ModelEscalationPolicy` defines one to
four named stages with model, estimated cost, and bounded attempts.

The shared executor owns correction within a stage, policy-approved promotion,
unique provider request IDs, durable budget reservation and settlement, and
retention of uncertain reservations to prevent duplicate spend. Authentication,
authorization, budget, rate-limit, timeout, and uncertain-provider failures do
not silently promote to a stronger model. Provider rate retries remain inside
the provider adapter.

```ts
const policy = defineModelEscalationPolicy({
  id: "writer.section-revision",
  stages: [
    { id: "draft", model: "economy-model", estimatedCostMicros: 100_000n, maxAttempts: 2 },
    { id: "strong", model: "strong-model", estimatedCostMicros: 300_000n, maxAttempts: 1 },
  ],
  escalateOn: ["contract"],
});
```

Domain validation stays in the executor's `normalize` boundary. The external
worker still performs the model request; SpacetimeDB remains authoritative for
the task lease and budget reservation.

Implementation: `src/engine/runtime/model-escalation.ts`. Canvas currently uses
the shared executor, and other rosters can adopt it without importing Canvas
models, prompts, or geometry.
