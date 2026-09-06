---
name: roster-workspace-nodes
description: Build, refactor, or review Roster workspace members and nodes, agent attachments, runtime-placement policies, shared-workspace CRDT entries, node runtime adapters, runtime bindings, dynamic topology, trusted output acceptance, and example integrations. Use when changing member/node models, orchestration planners or phase executors, Roster-native/Codex/Claude/Pi/Hermes/command/A2A/custom execution, node-to-sandbox placement, shared findings or decisions, or the Theorem math, Writer, and Canvas coordination examples.
---

# Roster Workspace Nodes

Treat Roster as the durable coordination authority for logical nodes. Keep node
identity independent from the process, session, worker lease, or sandbox that
currently executes it.

## Start Here

Read these files before changing behavior:

1. `docs/workspace-nodes.md` for the product boundary.
2. `src/engine/orchestration/types.ts` for node and binding contracts.
3. `src/engine/workspace/node.ts` for normalization and projection.
4. The nearest example domain and smoke test for the behavior being changed.

Read `src/engine/workspace/shared-workspace.ts` for blackboard changes and
`src/engine/runtime/node-runtime.ts` for execution changes.

## Preserve the Boundaries

- A workspace node owns durable identity, capabilities, topology position, and
  provenance.
- A runtime binding records replaceable execution placement for one monotonic
  epoch.
- A runtime adapter owns the inner loop only. It must not own task scheduling,
  topology mutation, artifact acceptance, budgets, or certification.
- A task is one bounded unit of work. A node may execute many tasks.
- A sandbox is replaceable compute. Never make it orchestration state.
- SpacetimeDB receipts and reducers remain the durable authority.

Use current Roster member/node terminology in new contracts. Do not document
pre-Roster agent-named receipt types, payload fields, aliases, or registry
methods as preserved surfaces. When receipt names change, update the reducers
and projections in the same refactor and document only the resulting Roster
contract.

## Treat the Roster Refactor as Breaking

Roster does not read, write, or dual-publish pre-Roster `guild.*` schemas or
legacy agent-named orchestration payloads. Do not add compatibility aliases for
Guild package names, environment variables, commands, API discriminators,
execution envelopes, persisted projections, or orchestration type names.
An intentional future migration must be explicit and versioned; until then,
only `roster.*` protocols and Roster-era receipts are supported.

## Choose the Correct Shared-State Mechanism

Use ordered receipts for leases, claims, budgets, membership, commands, and
other centrally serialized transitions.

Use `SharedWorkspaceLedger` for independently authored bounded entries that may
arrive out of order:

- `append` for findings, messages, evidence, and artifact references;
- `exclusive` for decisions where competing content must become an explicit
  conflict.

Use Git commits, branches, patches, or external artifact references for source
trees and large files. Do not turn the Yjs blackboard into a shared POSIX
filesystem or let CRDT arrival order choose a semantic winner.

## Add or Change a Node Runtime

1. Use `defineRosterMember` with `attachCodex`, `attachClaude`, `attachPi`,
   `attachHermes`, `attachCommand`, `attachA2A`, or `attachCustomRuntime` when
   the transport already exists.
2. Add a runtime kind only when its lifecycle or transport is genuinely new.
3. Implement `NodeRuntimeAdapter` and register it in `NodeRuntimeRegistry`.
4. Execute the supplied callback inside the adapter; leave Roster task receipts
   and timeouts around the adapter boundary.
5. Record placement changes with the current Roster runtime-binding receipt and
   an increasing epoch.
6. Preserve the logical node ID when replacing a process, sandbox, or session.
7. Add a focused test proving the dynamic planner dispatches through the new
   adapter.

`attachCommand` is only for a program that reads one
`roster.node-execution.v1` envelope from stdin and writes one versioned result
to stdout. `attachCustomRuntime` still requires a registered adapter for its
runtime kind. Keep credentials in adapter construction state, never in an
attachment, runtime profile, binding, receipt, or model-visible envelope.

## Add Runtime Placement

Use `defineRuntimePlacementPolicy` when the same logical member may execute
through different agents by capability, role, access level, workspace, or
operator preference. `DefinedRoster.placeRuntime` resolves one named
`NodeRuntimeProfile`; `attachRuntimePlacement` applies the result without
changing member identity. Use `createRuntimePlacementBinding` to persist the
resolved runtime and `runtimePlacementProvenance` to project its roster ID,
roster version, policy version, profile ID, and reason.

- Treat `NodeRuntimeProfile.available` as an enqueue/UI hint, never replay
  authority.
- Resolve and snapshot placement before execution; a queued or replayed run must
  not re-resolve a changed policy.
- Enforce `none`, `read-only`, and `workspace-write` access at placement.
- Keep the placement profile ID separate from `WorkspaceNodeRuntime.profile`,
  which remains provider-native configuration.
- Persist the `createRuntimePlacementBinding` result in the current Roster
  runtime-binding receipt with a monotonic epoch.

## Accept External Output Safely

Runtime adapters return drafts. When a domain must normalize, stamp, merge, or
otherwise admit a draft into authoritative state, put that work in the
task-level `acceptOutput` hook. Roster calls it for both native and external
execution before publishing task outputs.

`acceptOutput` must be bounded and idempotent. It may enforce domain ownership
and emit authoritative receipts, but it must not let the adapter choose task
acceptance, conflict resolution, budgets, or certification. In Canvas, validate
the assigned run, member, task, and part; normalize and verify server-owned patch
identity (or stamp an explicitly unstamped draft before admission); then update
the Yjs ledger and emit `scene.patch.applied`.

## Update an Existing Example

- Theorem math domain: preserve demand-driven member join/departure and
  topology rebracketing.
- Writer: model research, drafting, critique, and composition as typed node
  outputs over exact inputs.
- Canvas: preserve independently owned scene patches, validation reports, peer
  proposals, the trusted `acceptOutput` boundary, and conflict-free
  certification.

Prefer `roster-native` runtime profiles for existing in-process examples. Add an
external runtime by changing the adapter and binding, not by duplicating the
workflow.

## Validate

Run focused tests first:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/smoke/roster-definition.test.ts \
  tests/smoke/workspace-nodes.test.ts
```

For orchestration, runtime, CRDT, or receipt changes, finish with:

```bash
npm run verify
```

Require tests for runtime rebinding, delivery-order convergence, stale frontier
rejection, explicit exclusive conflicts, bounded graph growth, and exact replay
when the change touches those behaviors.
