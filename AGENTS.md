# Roster Repository Guidance

Use the repository skill at
`.agents/skills/roster-workspace-nodes/SKILL.md` whenever work touches workspace
nodes, orchestration, runtimes, shared artifacts, topology, or the Theorem,
Writer, and Canvas examples.

## Architecture

- Treat `WorkspaceNode` as the canonical logical participant.
- Author orchestration against the v2 node contract: `DomainPack.nodes`,
  `OrchestrationState.nodes`, `maxNodes`, `NodeDemand` /
  `materializeNodeDemand`, `node.spawned`, `node.retired`, and `nodeId` across
  plans, tasks, artifacts, and composition.
- Keep the domain registry node-only: `node`, `nodesFor`,
  `assertNodeAssignment`, and `extendNodes`. Do not add agent-named aliases,
  compatibility fallbacks, or Coding dual-read paths.
- Keep node identity separate from runtime binding, worker lease, process,
  session, worktree, and sandbox placement.
- Runtime adapters own inner-loop execution only. Roster owns topology, tasks,
  receipts, budgets, shared frontiers, conflicts, and certification.
- Use receipts for ordered control state, the shared-workspace CRDT for
  independently authored bounded entries, and Git/object storage for source
  trees and large artifacts.
- Preserve semantic conflicts; never use arrival order as acceptance.

## Working Practice

- Read the nearest domain, reducer, runtime, view, and smoke test before edits.
- Preserve unrelated worktree changes.
- Add provider-neutral abstractions before provider-specific adapters.
- Keep task expansion, concurrency, retries, runtime epochs, and cost bounded.
- Update `docs/workspace-nodes.md` when changing a public node boundary.

## Validation

Use targeted tests while iterating. Before handoff, run:

```bash
npm run verify
```
