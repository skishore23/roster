# Runtime Lifecycle And Extensions

Roster applies Cordis-inspired lifecycle semantics only to ephemeral runtime
placement and runtime extensions. The task graph, receipts, execution grants,
accepted outcomes, shared-workspace CRDT, and Git/object artifacts remain
durable forward history. Closing a runtime scope never rewrites those planes.

## Authority boundary

```text
ordered Roster control
  tasks, grants, binding receipts, promotion decisions
                    |
process-local runtime lifecycle
  activation, effect scopes, provider generations, draining
                    |
replaceable resources
  processes, subscriptions, temporary paths, sandboxes, service clients
```

Runtime adapters still own only their inner loop. Lifecycle helpers cannot
schedule tasks, change topology, accept drafts, transfer budgets, resolve
conflicts, or certify artifacts.

The following values are process-local and deliberately reject or omit JSON
serialization:

- `RuntimeEffectScope` and disposer closures;
- active runtime service values and activation callbacks;
- runtime-binding attempt leases;
- provider invocation leases;
- development reload schedulers.

Only immutable identities may cross a durable boundary: module and artifact
hashes, desired generation IDs, provider IDs and epochs, runtime-binding
epochs, lifecycle transition facts, emission intents, compensation evidence,
and independent promotion decisions.

## Managed effects

`RuntimeEffectScope` owns a bounded stack of synchronous or asynchronous
disposers. It closes in strict LIFO order, exactly once, under one total cleanup
deadline. Ordinary cleanup failures are aggregated while lower effects still
close. A deadline stops lower cleanup because starting it beside an unsettled
higher disposer would violate awaited LIFO ordering.

Scopes have explicit owners: activation, task attempt, runtime-binding epoch,
or process/platform. A scope is never owned only by logical node identity. A
`WorkspaceNode` survives replacement of its process, session, sandbox, and
runtime binding.

`activateRuntimeComponent` keeps acquired effects private until activation
finishes. Activation failure closes the partial scope. Successful activation
returns explicit close ownership. `runWithRuntimeEffectScope` instead closes on
success, failure, or cancellation and is used by `NodeRuntimeRegistry` for one
task attempt.

Runtime adapters receive a host-only `effects` registrar in
`NodeRuntimeExecutionControl`. It is absent from `NodeExecutionEnvelope` and
therefore cannot be transported or granted to model code.

## Function provider generations

`RosterFunctionDirectory.bindProviderGeneration` validates a complete bounded
provider set before publishing any binding. The committed generation identity
contains only function IDs, provider IDs, and epochs; invocation closures and
service clients remain private.

```text
staged validation -> active -> withdrawing -> retired
                                      \-> cleanup-uncertain
```

Provider resolution and catalog projection select only active bindings.
Withdrawal immediately stops new acquisition, then waits for invocation leases
that already captured the exact provider epoch. Disposal runs only after those
leases settle. A timeout is reported without redirecting an invocation or
retrying a non-repeatable effect on another provider.

Platform workers, Coding worker bundles, and the memory function plane publish
their related functions as atomic generations rather than assembling manual
disposer arrays.

## Runtime extension graph

`RuntimeExtensionDefinition` declares an exact module contract:

- module ID and public version;
- optional immutable artifact and configuration hashes;
- exact-version runtime service requirements and provisions;
- one process-local activation callback.

`compileRuntimeExtensionPlan` bounds modules and edges, rejects missing exact
versions, duplicate provisions, and dependency cycles, and produces a
content-addressed deterministic activation order.

`RuntimeExtensionHost.reconcile` stages the complete desired generation in a
private view. A failed candidate rolls back its acquired effects and leaves the
old committed generation active. A successful candidate becomes visible in one
synchronous commit; replaced modules then close in reverse dependency order.
Provider identity changes reload transitive dependents.

`RuntimeServiceView` is immutable and generation-scoped. `attenuate` may remove
services but cannot add them. Every view becomes stale after a generation
commit, preventing hidden live rewiring of already-admitted work.

The host is an observed-state mechanism, not durable desired-state authority.
A production controller stores desired artifact/configuration identities as
ordered Roster control and submits their exact compiled definitions to the
host. Replay reconstructs that control projection; it never serializes or
reruns an old activation closure.

## Runtime-binding epoch handoff

`RuntimeBindingEpochLifecycleManager` manages replaceable placement for one
fixed logical `nodeId`:

1. Activate the candidate epoch privately.
2. Validate readiness.
3. Invoke the caller-owned durable publication callback.
4. Make the candidate current for future attempt acquisition.
5. Mark the previous epoch draining.
6. Wait for exact-epoch attempt leases under a bound.
7. Abort timed-out leases and close the old effect scope.

Publication failure closes the unpublished candidate and preserves the current
epoch. Cleanup failure after successful publication is forward diagnostic
evidence; it never rolls back the binding receipt. Epochs are strictly
monotonic and runtime replacement never changes node identity.

## Emissions and compensation

Runtime resource acquisition is reversible only while its process-local scope
exists. External emissions use an additive classification:

- `no-emission`;
- `deferred-until-acceptance`;
- `idempotent-with-key`;
- `immediate-nonrepeatable`;
- `compensatable`.

Classifications and emission intents are immutable and content-addressed.
Immediate non-repeatable and compensatable operations cannot be retried
automatically after execution begins. Compensation is a new, forward evidence
record naming the original intent and application-defined equivalence; it does
not erase the emission or claim exact reversal.

## Reload and rollout

`RuntimeExtensionReloadAdapter` is a development-only, source-agnostic debounce
adapter. It snapshots immutable candidates, coalesces bursts, serializes host
reconciliation, and leaves the current generation active when a candidate
fails. Core does not watch the filesystem. Production deployment submits
controlled desired manifests through ordered authority instead.

Generated or self-improving extensions must use governed rollout: immutable
artifact identity, independent verification, warming, bounded canary evidence,
trusted promotion, and forward rollback to a last-known-good artifact at a
higher epoch. A generated module cannot promote itself or broaden its grants,
effects, scopes, budgets, or lifecycle bounds.

`SelfImprovementFramework` is the production controller for that contract.
Prompt, policy, and harness candidates are JSON merge-patch documents stored in
the durable content-addressed data-reference plane; receipts contain only the
exact reference, source provenance, rollout hash chain, authority evidence
hashes, epochs, and generation identities. Validation applies the candidate to
an isolated checkout of committed `HEAD`, invokes a trusted JSON-argv command
without a shell under process-tree, time, and output bounds, and removes the
checkout afterward. The source checkout is never the validation workspace.

The server requires configured authority tokens for verification, canary,
promotion, and rollback. Only their hashes enter receipts. The proposal author
cannot verify, authorize canary, promote, or authorize rollback; the verifier
cannot authorize canary or promote; the canary authority cannot promote; and
rollback requires an authority that did not operate an earlier rollout gate. A
successful promotion reconciles one atomic `RuntimeExtensionHost` generation;
rollback publishes the exact prior artifact (or the empty baseline) at a higher
epoch and retains the candidate and all rollout evidence.

Coding can originate a proposal only by naming an accepted output on its exact
durable run frontier. That output's run, task, node, outcome, artifact, and
content identities become proposal provenance. Coding still has no validation
or promotion authority. Promoted `coding.*` snapshots are pinned before the
next Coding run is admitted: prompt and harness directives become immutable run
context, while policy may only lower population/concurrency bounds or raise
review rigor to `reviewed`. It cannot weaken certification or widen grants.

## Required verification

Lifecycle changes require tests for:

- strict LIFO, exactly-once close, partial activation rollback, and dual errors;
- no provider visibility before atomic generation commit;
- stale provider/view rejection and drain-before-dispose;
- missing dependencies, cycles, transitive reload, and reverse withdrawal;
- runtime replacement preserving `WorkspaceNode` identity;
- publication failure before commit and cleanup failure after commit;
- immediate non-repeatable retry prohibition and forward compensation;
- failed reload preserving the committed generation;
- immutable improvement artifacts, independent authorities, Coding provenance,
  isolated candidate validation, canary promotion, and rollback-forward;
- exact replay never invoking disposers, emissions, or compensation handlers.

`runRuntimeLifecycleSimulation` executes these contracts together with recorded
entropy, fault injection, semantic convergence, and exact trace replay. It is
embedded in every Simulation Lab campaign and exposed through the public SDK;
see [Simulation Lab](simulation-lab.md) for the schedule and fault matrix.
