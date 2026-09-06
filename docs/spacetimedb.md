# SpacetimeDB Runtime

SpacetimeDB is Roster's production control authority and realtime distribution layer. Workspaces, ordered receipt streams, branch metadata, jobs, commands, task graphs, leases, retries, budgets, accepted outcomes, data-reference mappings, Canvas projections, and replay cursors are committed transactionally in the `spacetimedb/` module.

The application has three clients of the same database:

- The browser restores its own identity, redeems a bounded workspace or run capability, and subscribes directly to caller-scoped views.
- The Node service handles native HTTP commands, creates work, and hosts external coordinators without becoming a second state authority.
- External workers subscribe to claimable work, claim with a fence, perform model/tool effects, and commit results atomically.

## System boundary

```text
Browser
  -> generated TypeScript bindings
  -> caller-scoped views and reducer calls

SpacetimeDB
  -> private durable tables
  -> transactional reducers
  -> scheduled lease/retry reducers
  -> direct row deltas and reconnect snapshots

External workers
  -> task/job subscription
  -> fenced claim and heartbeat
  -> OpenAI, rendering, tools, object storage
  -> atomic result, usage, artifact, and receipt commit
```

| Responsibility | Owner |
| --- | --- |
| Identity membership, streams, receipts, jobs, commands, task graphs, leases, budgets, and small projections | SpacetimeDB |
| Realtime row delivery, atomic initial snapshots, and reconnect hydration | SpacetimeDB TypeScript client |
| Planning, model routing, provider calls, tool execution, validation, and image rendering | External Node workers |
| Bounded cross-node findings, decisions, evidence, and artifact references | Injected durable `SharedWorkspaceLedger` storage interpreted by domain projectors |
| Large images, raw provider responses, exports, and large Yjs checkpoints | Object storage, referenced by bounded hashes and URIs |

Reducers remain short deterministic transactions. They validate caller membership, expected heads, fences, limits, and idempotency keys; update private control state and projections together; and never wait for a model or tool call.

## Shared workspace and data planes

The generic shared-workspace CRDT is not duplicated as SpacetimeDB tables,
reducers, or caller-scoped views. `SharedWorkspaceLedger` preserves concurrent
candidates and explicit semantic conflicts, while the injected durable
workspace adapter persists its bounded encoded state. Every read and publish is
task-fenced against the authoritative Spacetime task lease.

Task results that must cross execution boundaries use immutable
`DataReference`s. SpacetimeDB stores the accepted outcome and its exact
artifact-to-reference mapping as part of the task graph; the referenced bytes
live in the injected durable data-reference store.

This split keeps graph transitions, leases, retries, budgets, and accepted
references transactional in SpacetimeDB without making the control database a
second CRDT or blob store. Domain projectors and ordered receipts retain
conflict and certification semantics.

## Local setup

Install the CLI on macOS or Linux:

```bash
curl -sSf https://install.spacetimedb.com | sh
spacetime --version
```

Install both workspaces and start the local host:

```bash
npm install
npm --prefix spacetimedb install
spacetime start
```

In another terminal:

```bash
npm run spacetime:build
npm run spacetime:publish:local
npm run spacetime:generate
npm run build
npm run dev
```

The local database is `roster-local`; the standalone host listens on `http://127.0.0.1:3000` by default and the SDK upgrades to a WebSocket connection. This repository pins the CLI-compatible root client, module client, and generated bindings to `2.6.1`. Build the module before code generation and regenerate bindings after every schema, reducer, or view change. Never edit generated bindings by hand.

## Configuration

```bash
SPACETIMEDB_URI=http://127.0.0.1:3000
SPACETIMEDB_PUBLIC_URI=http://127.0.0.1:3000
SPACETIMEDB_DATABASE=roster-local
SPACETIMEDB_TOKEN=
SPACETIMEDB_TOKEN_PATH=.spacetime/canvas-service.token
SPACETIMEDB_CONNECT_TIMEOUT_MS=10000
SPACETIMEDB_CONFIRMED_READS=0
ROSTER_WORKSPACE_ID=roster/default
ROSTER_WORKSPACE_NAME="Roster local workspace"
ROSTER_VIEWER_MAX_USES=10000
ROSTER_VIEWER_TTL_SECONDS=86400
```

- `SPACETIMEDB_URI` is reachable by the Node service. `SPACETIMEDB_PUBLIC_URI` is embedded in browser boot data and must be reachable by the browser. Production requires an explicit secure public URI.
- `SPACETIMEDB_TOKEN` supplies the service identity. Never expose it to browser code, redirects, or logs.
- Without an explicit token, the first local connection token is saved at `SPACETIMEDB_TOKEN_PATH`. Preserve that protected file across restarts; production service identities belong in a secret manager.
- `SPACETIMEDB_CONFIRMED_READS=1` trades subscription latency for durability-confirmed reads.
- Roster connects during startup and fails closed if the configured database is unavailable.

## Customer-safe upgrades

`roster up` publishes the current module without `--delete-data`. Schema
evolution must therefore remain compatible with SpacetimeDB automatic
migrations: new columns are appended to the end of an existing table and carry
explicit defaults. Existing columns are never reordered, renamed, or silently
retyped. The node-continuity room-lane fields follow this rule; historical rows
receive empty lane hints, while every new delivery records its exact lane,
room, and run.

The verification stack first publishes the frozen pre-lane continuity fixture,
inserts representative rows, upgrades that database with the current module,
and checks that the rows and defaults survive. It then runs the ordinary clean
database suites. This prevents fresh-install verification from masking an
unsafe customer upgrade.

Back up the service identity secret alongside database backups. Losing that
token does not authorize a replacement process to take over the workspace;
startup fails with recovery guidance. Repository display names may change on
restart, but the workspace id and owner identity remain stable authorization
boundaries.

## Workspace authorization

All base tables are private. `ensureWorkspace` creates the owner membership. `addWorkspaceMember` grants a narrow `coordinator`, `worker`, or `viewer` role. Reducers check role authorization independently of view visibility.

Canvas server-rendered links may carry a random expiring workspace or run
capability. Coding HTML and boot JSON never do: its authenticated page session
lazy-mints an exact-run grant and rotates on every successful mint. Clients
hash the secret and call `joinWorkspace` or `joinCanvasRun`; only the returned
SpacetimeDB database identity may be stored under a URI/database-scoped key.
Capability use count, expiry, revocation, redemption, and capability-derived
run-member provenance are durable. Expiry cleanup never removes an independent
`addRunMember` or `joinCanvasWorkspaceRun` membership.

Capabilities are bearer access. Production deployments should use TLS, application login or OIDC membership exchange, short lifetimes, account quotas, revocation UX, and separate service identities. A tokenless database identity is not authorization.

## Generic streams and exact replay

`ensureEventStream` creates a root stream or branch metadata row. A branch stores `parentStreamId` and exact `forkAt`. `appendStreamReceipt` requires the current head hash, validates one bounded JSON receipt with a stable receipt ID, assigns the next sequence, and advances the stream head in the same transaction. Repeating an identical receipt is success; changing a published receipt is rejected.

Coding adds private `coding_room` directory metadata without duplicating
conversation or execution authority. `appendCodingRoomReceipt` validates the
message's conversation and repository workspace, then creates or updates the
room, appends the immutable receipt, and advances the `coding-room` stream head
in one transaction. A rejected first message leaves neither a room nor a
message receipt (and rolls back a stream created by that transaction).
`my_coding_rooms` is the caller-scoped directory projection. Platform v3 has no
legacy stream backfill reducer: rooms enter the directory only through the
canonical atomic room-and-first-message transaction. Jobs and Git branches
remain separate execution projections and are not required for a room to exist.

Caller-scoped views:

- `my_workspaces`
- `my_event_streams`
- `my_stream_receipts`
- `my_stream_branches`
- `my_coding_rooms`

Adaptive Proof, Verified Proof, Writer Roster, Proof Swarm, its child workers, Command Center, Replay, and Canvas all place the same replay control at the top of the page. Missing `at` means live head. `at=<sequence>` renders the exact durable prefix while newer rows remain in the local client cache. Start, Previous, Play/Pause, Next, Live, scrub, and speed never rerun a model.

## Roster jobs

The durable job control plane uses private `roster_job`, `roster_job_request`, `roster_job_command`, and `roster_job_event` tables. The primary reducers are:

- `enqueueRosterJob`: retry-safe enqueue, request correlation, lane priority, and singleton allow/cancel/steer/reject behavior;
- `claimNextRosterJob`: atomic selection, attempt increment, lease fence, deadline, and claim event;
- `heartbeatRosterJob`: fence- and abort-checked deadline renewal;
- `completeRosterJob` and `failRosterJob`: fence-checked terminal or bounded-retry transitions;
- `cancelRosterJob`: durable cancellation;
- `queueRosterJobCommand` and `consumeRosterJobCommands`: steer, follow-up, and abort command lanes with idempotent consumption;
- `expireRosterJobLease`: scheduled stale-lease recovery with bounded backoff.

Every state transition appends one ordered job event such as `job.enqueued`, `job.leased`, `job.heartbeat`, `job.completed`, `job.failed`, `job.canceled`, `job.lease_expired`, `queue.command`, or `queue.command.consumed`.

Direct clients subscribe to `my_roster_jobs`, `my_roster_job_commands`, and `my_roster_job_events`. Authorized mutators can also observe `my_roster_job_requests` to resolve an idempotent enqueue request to its canonical job ID. The Command Center renders these rows directly.

Workspace admission is also transactional. The private
`roster_workspace_usage` row limits one identity to eight owned workspaces,
twelve active jobs per workspace, and 250 admitted jobs per rolling 24-hour
window. Enqueue increments the active, window, and lifetime counters in the
same transaction as the job insert; terminal completion, failure,
cancellation, singleton replacement, and terminal lease expiry release active
capacity in their own transition transaction. `my_workspace_usage` exposes
only the caller's non-viewer workspace counters and current limits. These
limits contain accidental or abusive work within one database identity; they
do not replace application enrollment. A public Maincloud service still needs
OIDC or server-issued beta membership so a user cannot evade account limits by
creating a fresh anonymous database identity.

## Provider-neutral durable execution graphs

Platform v3 uses one provider-neutral `roster_execution` and
`roster_task_definition` DAG for scheduling authority. Definitions, semantic
keys, dependency edges, materialized join counters, accepted outcomes, and
expansions have separate `roster_*` tables. Domain receipt streams and
projections remain separate, but task identity, dependencies, claims, lease
fences, retry backoff, acceptance, and in-flight limits do not.

`ensureRosterExecution` creates an execution with one complete
`RunExecutionPolicy`. That policy bounds tasks, graph depth, fan-out, ready and
blocked work, in-flight leases, attempts, context bytes, wall time, tokens, and
cost. `enqueueRosterTask` admits an immutable, content-addressed
`DynamicTaskDefinition`; its run-scoped semantic key prevents the same work
from being republished under another task ID.

`expandAndDelegateRosterTask` requires the active parent fence and a stable
expansion key. In one transaction it:

1. verifies workspace membership and required worker capability;
2. rejects a terminal execution or stale parent lease;
3. validates child and continuation schemas, semantic uniqueness,
   dependencies, and acyclicity;
4. enforces total task, depth, fan-out, context, token, cost, and time bounds;
5. inserts child tasks, edges, join projections, and the expansion record;
6. moves the parent to delegated and releases its lease;
7. promotes eligible work and appends `task.graph.expanded`.

The expansion key is independent of a lease epoch. Replaying the exact committed
publication after a new fence is idempotent; changing its content is rejected.
The explicit continuation must depend on the published child work and uses an
`all-success`, `all-terminal`, `any-success`, or quorum join. An impossible join
is skipped instead of remaining blocked forever.

The caller-scoped normalized execution, task, outcome, expansion, and output
reference views are replay-complete for `SpacetimeTaskGraphControl`. The
adapter reconstructs the graph from synchronized rows instead of parsing a
JSON-heavy execution snapshot. `cancelRosterTask` provides fenced per-task cancellation;
`cancelRosterExecution` remains the separate whole-run coordinator action.

`claimRosterTask` independently checks dependency readiness, retry availability,
attempt count, worker capability, the execution deadline, budget reservation,
and `maxInflight`. Heartbeat, start, accepted outcome, and failure require the
current fence. Scheduled rows expire abandoned leases and wake retries only
when their stored fence/deadline still matches current state.

`acceptRosterTaskOutcome` is the trusted success boundary. It verifies the
outcome against the exact task, node, attempt, definition hash, input manifest,
frontier, topology, catalog, acceptance policy, artifacts, and usage before
unlocking accepted dependencies. Runtime drafts never enter the outcome table.

The caller-scoped projections are `my_roster_execution_summaries`,
`my_roster_tasks`, `my_claimable_roster_tasks`, `my_roster_task_edges`,
`my_roster_task_outcomes`, `my_roster_task_expansions`,
`my_roster_task_output_references`, `my_roster_collaboration_summaries`, and
`my_roster_worker_capabilities`. The collaboration summary exposes only
accepted proposal, response, and endorsement counts to room viewers; raw
artifact references remain restricted to non-viewer workspace roles.
Workers render or dispatch from the synchronized
TypeScript client cache rather than maintaining a second process-local
scheduler.

Parentage records delegation provenance; dependencies control readiness. The
coordinator retains the global goal, merge, certification, and stop authority.
`maxInflight` controls provider concurrency independently of logical
population.

## External worker loop

1. Subscribe to a narrow claimable job/task frontier.
2. Claim through the atomic reducer and observe the new fence.
3. Heartbeat while work is active.
4. For budgeted domains, reserve estimated model cost with a stable provider request ID.
5. Perform the external effect outside SpacetimeDB.
6. Upload large artifacts before commit and retain bounded content references/hashes.
7. Commit result, usage settlement, task completion, projection changes, and receipt with the fence.
8. Treat an identical idempotent completion as success and any stale completion as rejected.

If a worker loses the provider response after the provider accepted it, retain an uncertain reservation for reconciliation rather than silently releasing the cost. A stable task/execution identity makes recovery observable but cannot manufacture provider-side exactly-once semantics when a provider offers no idempotency key. Load-test logical population separately from actual provider concurrency.

## Direct browser subscriptions

The generated clients follow one connection lifecycle:

1. Build a fresh connection with the stored identity token.
2. Register row insert/update/delete callbacks.
3. Redeem the page capability if membership is not established.
4. Subscribe to the smallest stream/run/job-specific query set.
5. Wait for the atomic initial snapshot before announcing Live.
6. Render from `connection.db` caches and transaction deltas.
7. On disconnect, build a replacement connection, restore membership and subscriptions, and swap only after the new snapshot applies.

Connection status uses an `aria-live` region. Large worker populations are summarized instead of rendering hundreds of continuously animated cards. Browser clients never receive service tokens or worker-only lease authority.

## Native HTTP boundaries

HTTP still serves the initial HTML and JavaScript bundles, accepts user commands through standard forms or documented JSON endpoints, handles authentication/capability exchange, and may upload/download large artifacts. A successful form mutation redirects to the canonical run URL. The database subscription delivers the resulting state change.

HTTP responses are not a realtime state channel and the application server does not re-serialize a full page snapshot for each receipt. This keeps one authorization model, one reconnect path, and one ordered replay frontier.

## Canvas-specific projections

Canvas adds run-filtered projections for its visual domain:

- `my_canvas_run_ui`
- `my_scene_plan` and `my_scene_plan_parts`
- `my_canvas_agents` and `my_canvas_task_statuses`
- `my_scene_objects`
- `my_scene_reviews`
- `my_canvas_activity`
- `my_canvas_replay_steps`

The browser receives sanitized active scene objects and exact replay steps. Worker/operator projections retain full tasks, receipt payloads, patches, leases, identities, and budget data. The coordinator reconstructs the Yjs frontier from accepted durable patches after process loss. It first publishes a fenced `AcceptedTaskOutcome`; `finalizeCanvasRun` can then close the domain run only after every Roster task is terminal and the accepted scene frontier matches the projected Canvas result.

## Scale and production guardrails

- Keep every string, JSON body, receipt, patch, task expansion, retry count, lease duration, capability, and budget bounded.
- Keep `maxInflight` well below logical workspace-node population and provider account limits.
- Use caller/run-scoped subscriptions and indexed filters; Coding uses bounded
  server-side timeline/task windows and loads older timeline ranges only on demand.
- Put rendered media, raw model archives, exports, and large checkpoints in object storage.
- Use idempotency keys for enqueue, expansion, provider calls, artifacts, and completion.
- Prove one winner under claim races and reject stale heartbeat/completion after lease takeover.
- Test reconnect snapshots, duplicate delivery, budget exhaustion, worker death around external effects, and cross-workspace authorization.
- Aggregate large teams in the UI and virtualize long histories.
- Publish schema changes to staging and regenerate all TypeScript bindings in the same change.
- Prefer Maincloud when managed replication, backups, scaling, and operational visibility are required.

Run `npm run test:soak` against a configured deployment for sustained event,
reconnect, and worker-takeover SLO evidence. A production run uses
`npm run test:soak:production` with `ROSTER_SOAK_PROVIDER_COMMAND_JSON` set to a
bounded argv probe for the deployed model provider; the resulting JSON evidence
includes p50/p95/max latency and exact recovery/fence checks.
Set `ROSTER_SOAK_WORKSPACE_ID` to reuse a caller-owned verification workspace;
otherwise `ROSTER_WORKSPACE_ID` is reused when present and an isolated workspace
is created as a fallback.

## Validation

```bash
npm run spacetime:build
npm run spacetime:generate
npm run build
node --import tsx --test --test-concurrency=1 \
  tests/smoke/spacetimedb-control.test.ts \
  tests/smoke/spacetimedb-job-queue-contract.test.ts \
  tests/smoke/spacetimedb-coding-recovery.test.ts \
  tests/smoke/spacetimedb-task-graph-contract.test.ts \
  tests/smoke/proof-writer-spacetimedb-cutover.test.ts \
  tests/smoke/axiom-simple-cutover-contract.test.ts \
  tests/smoke/monitor-spacetimedb-cutover.test.ts \
  tests/smoke/replay-spacetimedb-cutover.test.ts \
  tests/smoke/canvas-cutover-contract.test.ts
```

For an end-to-end local check, publish the module, start Roster, open several agent pages, and confirm each reaches Live, applies transaction deltas, reconnects to the same atomic frontier, and replays exact sequences from the top control.

Official references: [installation](https://spacetimedb.com/install), [TypeScript client](https://spacetimedb.com/docs/clients/typescript/), [subscriptions](https://spacetimedb.com/docs/clients/subscriptions/), [views](https://spacetimedb.com/docs/functions/views/), [authentication](https://spacetimedb.com/docs/core-concepts/authentication/), [reducers](https://spacetimedb.com/docs/functions/reducers/), [scheduled tables](https://spacetimedb.com/docs/tables/schedule-tables/), and [Maincloud deployment](https://spacetimedb.com/docs/how-to/deploy/maincloud/).
