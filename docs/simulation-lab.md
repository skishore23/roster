# Simulation Lab

Simulation Lab runs the same planning, adaptive population, topology, task,
runtime-binding, collaboration, and receipt reducers used by Roster workflows
with recorded entropy and exact replay. It does not call a language model and
does not require an API key.

Every campaign also runs `roster.runtime-lifecycle-simulation.v1` against the
real framework lifecycle APIs. This companion schedule search covers bounded
effect scopes, partial activation rollback, atomic provider generations,
invocation draining, monotonic binding handoff, extension reconciliation,
scoped service attenuation, reload containment, emission retry safety,
independent canary promotion, and rollback-forward. It records entropy and
reexecutes the complete lifecycle trace; disposer closures and external effects
remain process-local and are never replayed as durable operations.

Open `http://localhost:8787/simulations` or run:

```bash
npm run simulate:campaign -- --pattern collaboration --agents 12 --parallel 6 --schedules 10 --seed 5370206 --faults
```

Run the provider-neutral system-verification contract across every coordination
kernel with:

```bash
npm run simulate:system
```

An actual provider-backed CLI canary is deliberately opt-in:

```bash
ROSTER_LIVE_RUNTIME_CANARY=1 ROSTER_LIVE_RUNTIME_KIND=codex-cli npm run simulate:system
```

The supported canary kinds are `codex-cli`, `claude-code`, `pi-agent`, and
`hermes-agent`; use `all` to require every one in a single verification run.
`ROSTER_LIVE_RUNTIME_MAX_TOKENS` can lower or raise the default 40,000-token
evidence ceiling. The command first requires a ready discovered executable and
makes exactly one non-mutating request per selected runtime in a disposable
directory, using that CLI's least-privilege mode and a 60-second cancellation
boundary. Because a provider reports tokens only after a call, the token
ceiling is an acceptance bound rather than a preauthorization guarantee; the
invocation count and wall-clock timeout are the hard pre-call bounds.
Runtime-scoped provider and model overrides use the normalized runtime ID, for
example `ROSTER_LIVE_RUNTIME_PI_AGENT_PROVIDER=openai-codex` and
`ROSTER_LIVE_RUNTIME_PI_AGENT_MODEL=gpt-5.4-mini`. This lets a canary use a
separately authenticated provider without changing the user's normal Pi
configuration.

The provider canary proves the common execution protocol. A separate destructive
acceptance harness creates one disposable Git repository per local coding
runtime, asks the real agent to make one exact README edit through the complete
Coding DAG, and rejects extra files or unauthorized commits:

```bash
npm run accept:coding-runtimes
```

Use `ROSTER_CODING_ACCEPTANCE_RUNTIMES` with `all` or a comma-separated subset.
Pi defaults only in this disposable harness to `openai-codex/gpt-5.4-mini`;
`ROSTER_CODING_ACCEPTANCE_PI_PROVIDER` and
`ROSTER_CODING_ACCEPTANCE_PI_MODEL` override that canary placement.
`ROSTER_CODING_ACCEPTANCE_MAX_DURATION_MS` bounds each runtime independently
and defaults to four minutes.

`roster.system-verification.v1` separates the versioned scenario, execution
environment, observation, and independent invariant results. Every scenario
declares resource bounds, required invariants, and a composable fault plan.
An environment must reject unsupported fault kinds before execution and must
report which declared fault IDs it actually exercised. A skipped fault can
therefore never produce a green report.

The `roster-platform-kernel` environment supports `task-failure`. Determined
cooperatively interleaves explicit dispatcher checkpoints around graph claim,
start, handler, expansion, immutable-value publication, acceptance, and
failure. It never selects outcomes or mutates graph state itself; the single
`TaskGraphControl` remains authoritative.
`command-runtime-boundary` crosses the real command adapter and child-process
boundary to prove crash recovery, monotonic runtime rebinding, the versioned
execution envelope, stable logical node identity, and cancellation settlement.
`shared-workspace-boundary` crosses the real bounded Yjs ledger to prove
reordered and duplicate delivery convergence while preserving an exclusive
semantic conflict. `git-workspace-boundary` creates a real temporary Git
repository, recovers an uncommitted isolated worktree after a simulated runtime
loss, retains its diagnostic patch, commits the frozen frontier, removes the
worktree, and proves that a later target-branch move blocks integration.
The common contract additionally reserves runtime hang, transport disconnect,
database disconnect, sidecar restart, stale task context, and broader
cancellation scenarios. The SpacetimeDB persistence environment is enabled
inside the isolated verification stack. It loses the acknowledgement after a
dynamic child acceptance has committed, then creates a fresh connection,
task-graph adapter, platform execution, immutable-value store, and
shared-workspace instance. The recovered continuation must consume the exact
worker value and shared finding without re-running the root or worker; stale
workspace publication is rejected and replaying the lost expansion and
acceptance acknowledgements is a no-op. The desktop environment launches the same Node sidecar entry used
by the Tauri shell against a temporary Git repository and private desktop state
directory, waits for the real Coding route, terminates the process, restarts it
on a new loopback port, and requires both device-identity continuity and prior
process containment.
The optional live-runtime environment crosses the selected production CLI
adapter, requires the exact assigned logical node ID and canary nonce in a
versioned response, and fails if normalized provider usage is missing or above
the scenario ceiling. Codex CLI, Claude Code, Pi, and Hermes use this same
contract. It injects no artificial transport fault into a paid provider call.

## Campaign Controls

- `pattern`: `collaboration`, `adaptive`, `fanout`, `hierarchy`, or `pipeline`;
- `agents`: demanded worker population, from 2 through 128. The report keeps
  `requestedAgents` separate from `exercisedAgents`; Coding collaboration uses
  the production roster bound and currently selects at most six specialists;
- `maxParallel`: resource ceiling for active tasks, from 1 through 32;
- `schedules`: entropy seeds to search, from 1 through 20;
- `seed`: unsigned 32-bit base seed, from 0 through 4,294,967,295, used to reproduce the campaign;
- `injectFaults`: inject one recoverable task-boundary failure plus the bounded
  framework lifecycle and Coding terminal-projection fault matrices in each
  schedule. Fault-free runs report zero terminal fault operations.

## Coordination Models

**Coding collaboration** compiles the production Coding roster against a
synthetic repository roster. The production population bound chooses a small
peer set, saved dependency edges create routed response tasks, incompatible
exclusive proposals remain a CRDT conflict, and an ambiguous resolution is
proved unable to certify until the human participant supplies intent. The
accepted attempt advances to a conflict-free frontier, injects one task fault,
rebinds that logical node at a higher runtime epoch, retries, and requires every
review peer to endorse the same synthetic Git-frontier hash.

**Adaptive topology** materializes capability demand and runs a frontier whose
acceptance policy also requires an explicit review-evidence artifact. The
post-frontier reflection observes that artifact is genuinely absent, emits a bounded replan,
applies a positive-gain local Tamari rotation, and executes the remediation plan
through the canonical task graph. Only the resulting task output clears the
evidence gap; the campaign then consolidates redundant work, contracts one leaf,
and stops.

**Parallel fan-out** executes independent workers against one frontier and performs deterministic fan-in after the barrier.

**Verification hierarchy** partitions the worker frontier into pods of at most
four. Each pod's first worker owns one review task that consumes only that pod's
worker artifacts, and the final verification gate consumes every pod review.

**Staged pipeline** executes research, structure, critique, revision, and composition layers in order.

## Checks Per Schedule

Transition evidence is system-generated and does not constrain model output formatting.

Each schedule:

1. Materializes a deterministic dynamic population.
2. Starts one coordinating task, searches the compact live catalog, pins the
   discovered graph-control provider epoch, and atomically expands the real
   `TaskGraphControl`.
3. Applies and validates orchestration receipts.
4. Lets Determined interleave bounded graph-transition checkpoints independently
   of host event-loop timing.
5. Injects and recovers one selected failure when enabled.
6. Replays the exact recorded entropy through a second execution.
7. Replays the receipt stream through a fresh reducer.
8. Compares final semantic state across all searched schedules.

The companion runtime-lifecycle schedule additionally varies effect
registration, provider completion, extension declaration, canary evidence, and
record-delivery order. Its fault matrix proves failed activation rollback,
cleanup aggregation, bound enforcement, provider drain timeouts and cleanup
uncertainty, stale binding cancellation, failed durable publication,
dependency-cycle rejection, failed reload containment, non-repeatable retry
rejection, independent rollout authority, and rejection of generated-candidate
self-verification. Independent invariant evaluation
is mutation-tested so forged green observation fields fail the corresponding
check.

The Coding collaboration campaign additionally rehydrates the shared-workspace
ledger under two entropy-selected delivery orders, redelivers bounded duplicate
Yjs updates, replays every ordered receipt both once and twice, and checks seven
application invariants: bounded DAG growth, peer topology, human ambiguity
gating, conflict-free certification, runtime rebinding, convergent replay, and
agent-turn delivery convergence under reordered and duplicate messages. The
report exposes each seed in pasteable decimal form (with hexadecimal alongside
it), plus the exact entropy draw count and completion digest, so a failing
schedule can be reproduced directly from the UI or CLI.

It also runs a seed-driven terminal-projection campaign over every evidence
prefix, not only the final reduced state. The campaign varies graph,
certification, and queue-job delivery order; injects stale and duplicate
evidence; introduces explicit equal-version disagreements; advances a virtual
clock across active lease deadlines; and serializes/restores the projection at
entropy-selected checkpoints. A higher-version observation must supersede an
older conflict, while an unresolved same-version conflict must remain visible
as `Needs attention`. Successful prefixes require current settled-job or
read-only authority. Each recorded entropy tape is replayed exactly, and the
report exposes schedule variants, entropy draws, intermediate-prefix count,
fault operations, projection restarts, and conflicts separately.

These delivery orders, duplicates, restart checkpoints, delays, and fault
combinations are entropy-related. Lease expiry is a virtual-time state-machine
boundary rather than randomness, and semantic delivery contradictions are
acceptance conflicts rather than entropy. A projection restart is deliberately
a serialized reducer-state restart, not an operating-system crash claim; real
process, persistence, browser, and Git boundary failures remain the job of the
layered system-verification environments below.

The report separates schedule diversity from semantic convergence. Completion
and transition digests show which distinct interleavings were explored. A
converged campaign requires one final semantic-state digest and exact entropy
replay for every schedule.
The Dynamic DAG view exposes the atomic expansion and task dependencies; the
Worker mesh view exposes content-free catalog search and pinned invocation
receipts. The maximum 128-worker pipeline uses a campaign-derived bounded value
store rather than the smaller default process-local entry ceiling.

## What It Proves

The campaign tests deterministic coordination, bounded concurrency, fault
recovery, legal topology transitions, duplicate receipt delivery, Coding DAG
construction, semantic conflict preservation, human escalation, exact-frontier
consensus, and CRDT replay. It does not prove that a model-generated proof,
article, plan, or tool result is correct. Domain evidence and certification
remain the answer-quality boundary.

The system-verification wrapper independently checks semantic convergence,
exact replay count, node and parallel bounds, the existence of an ordered
trace, declared-fault exercise and recovery, and domain acceptance. Its smoke
suite mutates each observation class and requires the corresponding invariant
to fail. This validates the verifier instead of treating a reproducible but
incorrect state as sufficient evidence.

The evidence is content-addressed as `verification_<hash>`. Deterministic
environments exclude their measured wall-clock duration from the observation,
so the same scenario and semantic observation reproduce the same evidence ID.
The opt-in live-runtime observation intentionally records provider usage and
duration; it is a canary result, not deterministic replay evidence.
## Verification layers

System robustness is deliberately layered:

1. `kernel` searches deterministic orchestration interleavings.
2. `runtime` exercises process and network envelopes, cancellation, malformed
   output, and runtime rebinding.
3. `workspace` exercises bounded CRDT delivery and explicit conflicts.
4. `persistence` exercises restart recovery across the SpacetimeDB dynamic DAG,
   immutable values, task-fenced shared context, and exact reducer replay.
5. `repository` exercises isolated Git workspaces, stale frontiers, retained
   patches, certification, and cleanup.
6. `desktop` exercises the Tauri sidecar lifecycle and browser projections.
7. `continuity` overlaps exact prepared control work with an in-flight logical
   node wake and verifies revision-fenced, exactly-once settlement.
8. `live-runtime` is an optional cost-bounded protocol canary; it must not be
   required for deterministic verification.

Only evidence produced by the named environment counts for a layer. The system
command always produces kernel, command-runtime, shared-workspace, and Git
repository evidence. Inside an isolated or explicitly configured SpacetimeDB
stack it also produces persistence and desktop-sidecar evidence. The desktop
claim covers the production Node sidecar lifecycle launched by Tauri; Rust
windowing and packaged-binary behavior remain the desktop package's separate
build and smoke boundary. The command claims live-runtime coverage only when
the explicit canary flag is enabled and the provider-backed result passes its
contract and usage invariants.

## HTTP

`GET /simulations` runs and renders the default Coding collaboration campaign. `POST /simulations/run` accepts URL-encoded campaign controls through a standard HTML form:

- enhanced browsers send `Accept: application/json` and receive `{ ok, campaignId, html }`; the small first-party client swaps the report, rebinds tabs, and resets replay to the new live campaign head;
- browsers without JavaScript receive a complete Simulation Lab HTML page containing the requested campaign;
- invalid enhanced requests receive `{ ok: false, error }` with status `400`; the inline status region announces running, success, and failure states.

Simulation Lab is a deliberately side-effect-free test computation, not an
alternate production runtime. Every campaign uses the production planner,
task/output receipts, retry projection, and runtime boundary. The Coding
campaign additionally exercises the runtime-binding contract, consensus gate,
and Yjs workspace projector, but it does not create a Git branch or write
simulated rows into SpacetimeDB. A campaign trace exists only for the rendered
report and exact replay check; production runs, jobs, leases, tasks, receipts,
collaboration frontiers, and browser updates remain SpacetimeDB-owned. The page
uses a small first-party client only to submit the native command and replace
the completed report.
