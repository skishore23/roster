# Roster HTTP and Realtime API

Base URL: `http://localhost:8787` (or `PORT`).

## Boundary

Roster uses HTTP for initial page shells, static browser bundles, native form commands, documented JSON control commands, and large artifact transfer. Production state is committed to SpacetimeDB. Agent pages receive subsequent receipt, task, job, branch, replay, and domain-projection changes through the generated TypeScript client.

Common conventions:

- JSON commands use `Content-Type: application/json`.
- Native form commands use `Content-Type: application/x-www-form-urlencoded` and normally return `303` to a canonical page URL.
- Page routes return `text/html; charset=utf-8`. A domain may include a
  short-lived capability only where that route documents one. Coding page
  HTML and boot JSON never contain a database capability or private job/task
  payload.
- Coding browsers restore only their database identity locally, lazily mint an
  exact run grant through the authenticated page session, redeem it, subscribe
  to narrow caller-scoped views, and wait for the initial snapshot before
  announcing Live.
- Missing `at` follows the live head. `at=<sequence>` selects an exact durable receipt prefix.
- Error payloads are plain text unless a route explicitly documents JSON.
- During graceful shutdown, read-only requests remain available while leased
  jobs drain. Mutating requests receive `503` with `Retry-After`, and the HTTP
  listener is released only after the draining process has finished serving its
  process-local diagnostics.

The HTTP response acknowledges a command; the matching database transaction delta is the authoritative UI update.

Core orchestration payloads use the breaking platform-v3 node and task
contracts: `WorkspaceNode`, `DynamicTaskDefinition`, `AcceptedTaskOutcome`,
`RunExecutionPolicy`, and `nodeId` across tasks, artifacts, and composition.
The registry exposes `node`, `nodesFor`, `assertNodeAssignment`, and
`extendNodes` without agent-named aliases. Standalone application route IDs and
`agents/...` stream names remain application identifiers; they are not
orchestration participant fields.

## Direct SpacetimeDB surface

Generated clients use these shared caller-scoped views:

- streams and replay: `my_workspaces`, `my_event_streams`, `my_stream_receipts`, `my_stream_branches`;
- jobs: `my_roster_jobs`, `my_roster_job_commands`, `my_roster_job_events`, and authorized `my_roster_job_requests`;
- task graphs: `my_roster_execution_summaries`, `my_roster_tasks`, `my_claimable_roster_tasks`, `my_roster_task_edges`, `my_roster_task_outcomes`, `my_roster_task_expansions`, `my_roster_task_output_references`, `my_roster_collaboration_summaries`, and `my_roster_worker_capabilities`;
- Canvas: `my_canvas_run_ui`, `my_scene_plan`, `my_scene_plan_parts`, `my_canvas_agents`, `my_canvas_task_statuses`, `my_scene_objects`, `my_scene_reviews`, `my_canvas_activity`, `my_canvas_replay_steps`.

The job reducer lifecycle is `enqueueRosterJob` → `claimNextRosterJob` → `heartbeatRosterJob` → `completeRosterJob` or `failRosterJob`. `queueRosterJobCommand` and `consumeRosterJobCommands` carry steer, follow-up, and abort input. `expireRosterJobLease` recovers abandoned work. Ordered job events include `job.enqueued`, `job.leased`, `job.heartbeat`, `job.completed`, `job.failed`, `job.canceled`, `job.lease_expired`, `queue.command`, and `queue.command.consumed`.

Roster tasks use `ensureRosterExecution`, `setRosterWorkerCapabilities`,
`enqueueRosterTask`, `expandAndDelegateRosterTask`, `claimRosterTask`,
`heartbeatRosterTask`, `startRosterTask`, `acceptRosterTaskOutcome`,
`failRosterTask`, and `cancelRosterExecution`. Expansion requires the active
parent fence and atomically releases the parent lease after publishing bounded
children plus an explicit continuation. Total tasks, depth, fan-out,
dependencies, capabilities, retries, in-flight work, context, time, tokens, and
cost remain policy-bounded.

See [spacetimedb.md](./spacetimedb.md) for authorization, reducer invariants, worker protocol, and scale guidance.

## Server and assets

### GET /healthz

Reports process liveness, drain state, and uptime.

### GET /readyz

Returns `200` while the connected Roster server is accepting work and `503`
while it is draining. Neither health endpoint returns credentials or database
identity tokens.

### GET /api/v2/room-os/health

Returns the public Room OS readiness contract as JSON. It requires no
`Authorization` header, sets `Cache-Control: no-store`, and responds with
exactly:

```json
{"schema":"roster.room-os-health.v1","apiVersion":"v2","ok":true,"durableStore":"spacetime"}
```

### GET /

Redirects to `/monitor`.

```bash
curl -I http://localhost:8787/
```

### GET /assets/canvas-client.js

Returns the built Canvas browser client and generated database bindings with `Cache-Control: no-cache`. Returns `404` when the bundle is not built.

### GET /assets/coding-client.js

Returns the Coding Room OS direct-subscription client and generated database
bindings with `Cache-Control: no-cache`. Returns `404` when the bundle is not
built.

### GET /assets/coding-enhancements.js

Returns the lightweight Coding composer enhancement for typed teammate mentions
and lazy Mermaid detection. It loads the Mermaid renderer only when a conversation
contains a Mermaid code block. Returns `404` when the bundle is not built.

### GET /assets/coding-mermaid-renderer.js

Returns the strict, self-hosted Mermaid renderer used by Coding conversation
messages. Rendering is bounded and preserves the source as a native disclosure.
Returns `404` when the bundle is not built.

### GET /assets/roster-client.js

Returns the shared direct-subscription client used by Adaptive Proof, Verified Proof, Writer Roster, Proof Swarm, and child-worker pages. Returns `404` when the bundle is not built.

### GET /assets/roster-shell.js

Returns the dependency-free room shell enhancement used for participant-state orbs. The client respects reduced motion, pauses offscreen canvases, and returns `404` when the bundle is not built.

### GET /assets/replay-client.js

Returns the Replay browser client with generated bindings and exact-sequence controls. Returns `404` when the bundle is not built.

## Agent pages

Every agent page places the same Start, Previous, Play/Pause, Next, Live, scrub, speed, and status control above its workspace tabs. Page-specific query parameters remain stable when replay changes `at`.

### GET /theorem

Renders Adaptive Proof.

- Query: `stream` (default `agents/theorem`), optional `run`, `branch`, `at`, and `tab`.
- A missing run selects the latest run. `run=new` renders an empty start state.
- The boot contract subscribes to the index, selected run, and selected branch streams.

### POST /theorem/run

Starts, resumes, appends to, or forks an Adaptive Proof run.

- Query: `stream`, optional `run`, `branch`, and `at`.
- Form: `problem`, `append`, `rounds`, `depth`, `memory`, `branch`, `concurrency`.
- Success: `303` to the selected run/job URL.
- Errors: `400` when no problem can be resolved.

```bash
curl -i -X POST 'http://localhost:8787/theorem/run?stream=agents%2Ftheorem' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'problem=Prove+that+zero+is+an+additive+identity&concurrency=auto'
```

### GET /axiom

Renders Verified Proof. Query and replay behavior match `/theorem`, while the workflow requires formal evidence before certification.

### POST /axiom/run

Starts, resumes, appends to, or forks a Verified Proof run.

- Query and form: the same shape as `POST /theorem/run`.
- Success: `303` to the selected run/job URL.
- Errors: `400` when no problem can be resolved.

### GET /writer

Renders Writer Roster.

- Query: `stream` (default `agents/writer`), optional `run`, `branch`, `at`, and `tab`.
- The page subscribes directly to its index, selected run, and branch streams.

### POST /writer/run

Starts, resumes, appends to, or forks a Writer Roster run.

- Query: `stream`, optional `run`, `branch`, and `at`.
- Form: `problem`, `append`, `parallel`.
- Success: `303` to the selected run/job URL.
- Errors: `400` when no problem can be resolved.

### GET /axiom-simple

Renders Proof Swarm.

- Query: `stream` (default `agents/axiom-simple`), optional `run`, `at`, and `tab`.
- The page subscribes to parent run receipts, durable branches, and worker status projections.

### POST /axiom-simple/run

Starts a Proof Swarm run.

- Query: `stream`.
- Form: `problem` (required), optional `workerCount`, `repairMode`.
- Success: `303` to `/axiom-simple?stream=…&run=…&job=…`.
- Errors: `400 problem required`.

### GET /axiom-simple/worker

Renders one formal child worker with independent replay.

- Query: `stream` (default `agents/axiom`), `run` (required), optional `at` and `tab`.
- Errors: `400 run required`.

## Canvas Roster

### GET /canvas

Renders the collaborative vector studio shell and run-scoped database boot configuration.

- Query: `stream` (default `agents/canvas`), optional `run` and `at`.
- Selecting a non-terminal durable run may resume its coordinator through the fenced dispatch frontier.

### GET /canvas/run-token

Returns a fresh signed Canvas run-form token as `{ "csrfToken": "..." }` with
`Cache-Control: no-store`. The same-origin Canvas client refreshes this token
immediately before submission so an open form remains usable after a local
server restart or token timeout.

### POST /canvas/run

Creates a durable Canvas run and bounded viewer capability, then launches its artist workflow.

- Query: `stream` (default `agents/canvas`).
- Form: `prompt` (trimmed, 3–1000 characters), `parallel` (3–8 painters, default 5).
- Success: `303` to `/canvas?stream=…&run=…#access=…`.
- Errors: `400` for invalid input, `503` when the database control plane is unavailable.

The fragment contains the raw run capability. The browser consumes and removes it before calling `joinCanvasRun`; the application request does not receive the fragment.

```bash
curl -i -X POST 'http://localhost:8787/canvas/run?stream=agents%2Fcanvas' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'prompt=A+glass+observatory+floating+above+a+storm&parallel=6'
```

## Command Center

### GET /monitor

Renders Command Center.

- Query: `stream` (default `agents/agent`), optional `run`, `job`, `at`, and `tab`.
- Subscriptions include selected stream receipts, current Roster jobs, ordered job events, commands, and task summaries.

### POST /monitor/run

Starts a general or first-party coordination run through the durable Roster job reducer.

- Query: `stream`.
- Form: `problem` (required), optional `agentId`, `maxIterations`, `maxToolOutputChars`, `memoryScope`, `workspace`, `leanEnvironment`, `leanTimeoutSeconds`, `autoRepair`, and `localValidationMode`.
- Success: `303` to the target agent page or `/monitor`, including `stream`, `run`, and `job`.
- Errors: `400 problem required`.

### POST /monitor/job/:id/steer

Queues a durable steer command.

- Query: optional `stream`, `run` for redirect context.
- Form: `problem` and/or `config` (a JSON object string).
- Success: `303`; requests with `X-Requested-With: fetch` receive `202` text.
- Errors: `400` for empty/invalid input, `404` for missing or terminal job.

### POST /monitor/job/:id/follow-up

Queues a durable follow-up command.

- Form: `note` (required).
- Success: `303`, or `202` text for the first-party enhanced request.
- Errors: `400 note required`, `404` for missing or terminal job.

### POST /monitor/job/:id/abort

Queues a durable abort command.

- Form: optional `reason`.
- Success: `303`, or `202` text for the first-party enhanced request.
- Errors: `404` for missing or terminal job.

## Replay and inspection

### GET /replay

Renders the stream catalog, exact receipt replay, branch timeline, and inspector analysis.

- Query: `stream`, `order` (`asc|desc`), `limit` (`50|200|1000`), `depth` (`1|2|3`), `at`, and `tab`.
- The browser subscribes directly to the caller-visible stream catalog, selected receipt stream, branches, and deterministic inspector analysis stream.

```bash
curl -sS 'http://localhost:8787/replay?stream=agents%2Ftheorem&at=20'
```

### POST /replay/inspect

Queues the bounded inspector team against an exact durable stream frontier.

- Form: `stream` (required), optional `order`, `limit`, `depth`, `at`, `question`.
- Success: `303` back to the selected replay URL.
- Errors: `400` invalid/missing stream, `404` stream not found, `503` database web access unavailable.
- Side effect: creates one bounded inspector job per role. Each role publishes to the deterministic analysis stream for the selected source.

```bash
curl -i -X POST http://localhost:8787/replay/inspect \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'stream=agents%2Ftheorem&question=Summarize+failures&order=desc&limit=200&depth=2&at=20'
```

## Simulations

Simulation Lab is a deterministic, side-effect-free coordination test. It is not a second production state store.

### GET /simulations

Runs the default Coding collaboration campaign and returns the complete Simulation Lab page.

### POST /simulations/run

Runs one deterministic campaign.

- Form: `pattern=collaboration|adaptive|fanout|hierarchy|pipeline`, `agents=2..128`, `maxParallel=1..32`, `schedules=1..20`, `seed=1..4294967295`, optional `injectFaults=1`.
- With `Accept: application/json`, success is `{ "ok": true, "campaignId": "…", "html": "…" }`.
- Without that accept header, success is a complete HTML page.
- Invalid enhanced input returns `400` JSON `{ "ok": false, "error": "…" }`; invalid plain input returns `400` text.

## Coding conversation API

The Coding API uses schema `roster.coding.v2`. When `ROSTER_API_TOKEN` is set,
all `/api/v2/coding/*` requests require `Authorization: Bearer <token>`.

### POST /api/v2/coding/runs

Starts or continues a provider-neutral coding conversation. The required
`objective` becomes a durable user message. Optional fields are
`conversationId`, `reviewPolicy`, `workerRuntime`, `tags`, `mentions`,
`replyTo`, and `source`.

`workerRuntime` is an explicit per-execution override and accepts
`claude-code`, `codex-cli`, `pi-agent`, or `hermes-agent`. For each newly created execution,
Roster first routes the conversation to a stable saved primary node, then
resolves the effective runtime in this order: a valid explicit API override,
that node's saved Codex CLI or Pi Code mutation preference, the workspace
fallback, then `pi-agent`. Codex and Pi use the model saved with the selected
node preference. The resolved choice is normalized into a versioned
`workerExecution` job snapshot, which is the sole durable source for its
runtime, model, Pi provider, and extension-package projection. Job readers do
not fall back to mirrored top-level `workerRuntime` or `workerModel` fields.
Queued and existing executions do not change when workspace settings or server
environment variables change. Review bindings remain independently read-only
and policy-controlled. Claude runtime overrides do not project a workspace
model. An explicitly invalid runtime is rejected rather than treated as absent.

The structured coordinator returns one disposition:

- `ready` or `escalated`: `202`, with a queued `job` and local run branch name;
- `informational`: `200`, with `job: null` and a direct `route.answer` derived
  from bounded read-only repository context; no branch or worker is created;
- `needs_clarification` or `declined`: `200`, with `job: null`, the durable
  route, and any questions. No branch, worker lease, or mutation job exists.

Distinct accepted conversations for the same repository are queued without
canceling one another. Roster may lease work concurrently at the fleet level,
but mutation execution is serialized by repository before dependency setup and
Git checkout mutation. A leased mutation that loses its worker while still
waiting for repository admission receives one automatic recovery attempt. The
worker permits that retry only when the durable execution projection contains
no plan, task, runtime binding, artifact, or frontier evidence. Once execution
has begun, lease loss fails closed and requires the explicit retry endpoint so
Roster cannot silently duplicate model spend or partially applied edits.

An invalid planner draft receives one bounded correction attempt. Provider
authentication, authorization, quota, rate-limit, and terminal availability
failures are not repeated. They return a structured retryable `503` with
`code: "conversation_runtime_unavailable"` and a durable non-executable
recovery route; exhausted contract correction uses `code:
"planner_unavailable"`.

Clarification and authorization routes include the saved `human.operator`
participant when human judgment is required. That participant can author a
reply or decision but is never accepted as an executable `primaryNodeId`.

`source.kind` may be `ui`, `api`, `pr-comment`, `review-comment`, or `agent`.
Adapters may also supply `provider`, `repository`, `externalId`, `revision`,
and `url`. Repeating the same external message is idempotent; an edited
revision produces a new content-derived message identity. External comments
are routing inputs, not orchestration authority.

### GET /api/v2/coding/rooms

Returns the durable repository conversation directory for `?workspace=<id>`,
or the selected workspace when omitted. Each entry includes the stable room and
conversation IDs, receipt stream, first-message title, state, message count,
and timestamps. The result includes informational, clarification, declined,
and planner-recovery conversations even when no execution job or Git branch
exists. Platform v3 does not scan or promote legacy receipt streams.

### POST /api/v2/coding/realtime-sessions

Creates a short-lived caller-scoped SpacetimeDB viewer session for the exact
repository `workspaceId`, `conversationId`, `jobId`, and `executionId` in the
JSON body; all four selectors are mandatory. The repository workspace owns the
saved Coding room and team. `controlWorkspaceId`, returned by the server, names
the separate shared control/event workspace and is never accepted as a
repository-workspace substitute. The server verifies that the exact job belongs
to the conversation and repository workspace and admitted the exact execution,
then resolves the room; clients cannot select an arbitrary room or run.

The response includes both workspace IDs, `roomId`, `conversationId`, `jobId`,
`executionId`, connection metadata, a bounded expiry, and a low-use
`capabilitySecret`. It is `Cache-Control: private, no-store` and requires the
same operator authentication as other Coding v2 routes when
`ROSTER_API_TOKEN` is enabled. Coding page HTML and boot JSON contain no grant:
the browser instead calls the same lazy mint path with an HttpOnly page session
bound to the authenticated operator authority and the exact four selectors.
That cookie is issued only by an authenticated page request when token auth is
enabled. Every successful mint atomically rotates that page session and returns
the replacement as `HttpOnly`, `SameSite=Strict`, and `private, no-store`; the
predecessor cannot mint again. Local loopback deployments retain the existing
local-trust policy when token auth is disabled; request headers such as
`Origin` are request checks, not operator authority.

Clients hash the capability, redeem it with `joinCanvasRun` for the exact
`executionId`, install row callbacks before subscribing, and wait for
`onApplied`. The redemption grants only the bounded `my_coding_*` room/run
DTOs; it does not grant raw workspace views. Redeemed access expires at the
grant deadline and explicit revocation removes capability-derived access. It
does not remove membership independently delegated by `addRunMember` or earned
through `joinCanvasWorkspaceRun`; that provenance is stored separately. The
browser and CLI remint before expiry, redeem an overlapping exact-run grant,
and fence the old transport generation. Page-session rotation keeps a
long-lived browser renewable without putting either secret in boot JSON or
storage. Run A never authorizes queries for run B. HTTP remains the mutation
and aggregate boundary; idle status polling is not part of this contract.

### POST /api/v2/coding/runs/:runId/messages

Appends a message to an existing conversation. If the coordinator is awaiting
clarification, the accumulated transcript is replanned and an actionable answer
enqueues exactly one job. If a job is active, the message is persisted and
queued as durable steering. A terminal execution may continue only when human
evidence is still required: either the validated collaboration resolution is
`ambiguous`, or a previously consumed control message reached a task that did
not complete. The reply is tagged as resolution or delivery-recovery context
and may enqueue a continuation of the same durable conversation with a fresh
execution ID, receipt stream, lease, worktree, and branch; it never revives the
old execution. Other terminal executions return `409`.

For a validated peer ambiguity, the accepted human answer is combined with the
resolver's exact prior decisions and unresolved subjects into a complete,
human-authored `collaboration_resolution` input. That fresh execution starts at
implementation and does not repeat proposal, response, or temporary-resolver
tasks. Review, remediation, repository validation, certification, runtime
fencing, and Git frontier checks are unchanged.

### GET /api/v2/coding/runs/:runId

Returns the job, tasks, named nodes, runtime/model bindings, branch/commit,
frontier, bounded receipts, and the conversation projection. Conversation data
includes `messages`, `routes`, `pendingQuestions`, `disposition`, `tags`, and
`selectedNodeIds`. The `collaboration` projection includes the current peer
phase, proposal, response, and conflict counts, temporary topology, per-node
collaboration roles, the bounded validated resolution summary and unresolved
subjects with candidate positions, and `durableStore: "spacetimedb"`. Peer-authored proposal,
response, resolution, and endorsement bodies remain available through bounded artifact receipts; raw
process logs are not durable collaboration evidence.

The route parameter is the logical conversation ID. `run.executionId`
identifies the selected job's isolated execution. Supplying `?job=<job-id>`
always projects that job's execution stream, patch, collaboration frontier, and
plan state; it never combines a prior job with the newest continuation. If an
exact job selector does not belong to this conversation, the endpoint returns
`404` instead of silently falling back to another execution.

### POST /api/v2/coding/runs/:runId/retry

Retries an exact failed or canceled job selected by JSON `jobId`. Success
returns a fresh job under the same logical conversation with a new execution
ID, receipt stream, lease, branch, and worktree. The new job records
`retryOfJobId`; repeating the same request returns the already-created retry.
Completed or active jobs return `409`.

### POST /api/v2/coding/runs/:runId/integrate

Locally merges an exact completed and certified job selected by JSON `jobId`.
The operation is the guarded, idempotent fast-forward to the recorded clean
baseline branch. A dirty checkout, moved target, missing certification, or
mismatched commit returns `409`. It never pushes a remote or manufactures a
merge commit.

### POST /api/v2/coding/runs/:runId/close

Closes an exact completed and certified job selected by JSON `jobId` while
retaining its run branch and certified commit. The operation appends an
idempotent delivery-disposition artifact to the execution stream; it does not
merge, delete, rebase, or push anything. A missing branch, missing
certification, or already-merged result returns `409`.

### GET /api/v2/coding/runs/:runId/collaboration.md

Downloads a deterministic Markdown projection for a completed coding job. This
endpoint remains under the normal `/api/v2/coding/*` bearer policy. The optional
singular `job` query selects job provenance; when omitted, Roster uses the newest
matching job with a stable job-ID tie-breaker. Empty, invalid, or repeated job
selectors and invalid run identifiers return `400`, a missing run or selected
job returns `404`, queued, running, failed, or canceled jobs return `409`, and
durable replay-store unavailability returns `503`.

The successful response is `text/markdown; charset=utf-8` with an attachment
`Content-Disposition`, `Cache-Control: no-store`, and
`X-Content-Type-Options: nosniff`. Its bytes are identical to the browser
download route below when both requests observe the same selected job and
durable replay head. The record identifies that basis by job ID and observed
receipt count. The fixed section order is objective, peer contributions,
selected nodes, tasks, recorded conflicts and resolution, certification,
current-head integration, Git handoff, and selected-job result. Contributions
use semantic phase order—proposal, response, resolution, endorsement—then
recorded plan order and locale-independent stable identifiers. Tasks use plan
order, selected nodes use stored selection order, and effective replayed
runtime bindings take precedence over declared node runtimes.

The loader captures the receipt chain once and derives state from that exact
prefix. Job ID, objective, status, branch, commit, and result come from the
selected queue job. Peer work, tasks, bindings, recorded resolution,
certification receipts, and structured integration state come from the current
durable replay head observed at request time. Later receipts, including
integration receipts, may therefore produce a newer deterministic record for
the same run and job. This endpoint does not provide an archival completion
snapshot or an `at`-frontier query.

The renderer allowlists structured replay fields and applies deterministic
credential-pattern redaction, Markdown/HTML escaping, per-field and collection
limits, per-section byte limits, and an 80 KiB total UTF-8 limit. Visible
`[Truncated deterministically]` markers identify bounded content. It excludes
raw logs, patch or file contents, environment data, arbitrary runtime metadata,
unrecognized artifact or event bodies, CRDT payloads, raw result reports, and
credential-shaped secrets. Allowlisted objective, evidence, validation, path,
command, or route-reference text may appear after escaping and redaction.
Certification is separate from completion: only replayed endorsements and
certified-frontier receipts are evidence; certification-task status is labeled
as context. The record never infers certification from a completed plan, job,
commit, or task name. The conflict section describes only the validated recorded
resolution and does not substitute for the authoritative shared-workspace
conflict set.

### GET /coding/runs/:runId/collaboration.md

Provides the same completed-job Markdown renderer as a normal browser attachment
route outside the Coding API bearer namespace, following the same local operator
UI-route access policy as `/coding` and the review page. It is not an API
authentication bypass or an external API proxy. It accepts the same optional
singular `job` query and uses the same validation, eligibility, replay-head,
headers, ordering, redaction, and bounds. The completed Git handoff links to
this route with the exact selected job ID; later durable receipts may still
produce a newer current-head projection.

### GET /coding/runs/:runId/review

Renders the bounded stored Git patch as a file-by-file review page with
certification, task completion, commit, and branch-handoff status. This browser
route is read-only and accepts an optional `job` query parameter.
An exact selector that is missing or belongs to another conversation returns
`404`.

### GET /coding/attention

Returns the bounded local-operator attention projection used by the Coding
project rail and desktop-notification poller. Items include exact workspace,
conversation, and job selectors for human input, failed runs, blocked merges,
and certified commits ready to merge. The response is derived from durable jobs
and integration state and uses `Cache-Control: no-store`.

`POST /coding/runs/:runId/retry`, `POST /coding/runs/:runId/integrate`, and
`POST /coding/runs/:runId/close` are the corresponding native-form actions;
each redirects to the exact resulting execution on success. Close keeps the
certified branch while removing the run from the attention projection.

### GET /api/v2/coding/diff

Returns the bounded checkout diff projection. Pass `runId` to return the stored
patch for one coding run instead of the current checkout. A `job` selector
requires `runId` and must identify a job in that conversation; invalid selectors
return `400` and missing or mismatched selectors return `404`.

### GET /api/v2/coding/workspace

Returns the saved repository review and named specialist roster.

`POST /api/v2/coding/workspace/settings` saves a future mutation preference
without using the browser UI. It requires `application/json` with
`workspaceId`, `nodeId`, `workerRuntime` (`codex-cli` or `pi-agent`),
`codexModel`, and `piModel`. The node must belong to the saved workspace team.
The response returns the versioned settings and selected model; existing
queued executions retain their immutable runtime snapshot.

`POST /api/v2/coding/workspace/scan` performs the first bounded scan. Roster
selects the allowlisted roster deterministically, then Pi uses the curated AFT
extension through a read-only AST/search/LSP tool allowlist to discover each
specialist's structural evidence, skills, and dependencies. Pi cannot add
unvalidated node IDs or mutate the repository during onboarding. A detected
execution profile also makes its command-authoring evidence files immutable
constraints for ordinary coding runs. Dependency, script, lockfile, and
toolchain changes require a separately reviewed and onboarded profile rather
than executing a host gate derived from manifests changed by that same run.
Run projections expose the bounded `validationReport` (status, selected checks,
summary, aggregate exit-code evidence, and frontier hash) when repository-wide
validation ran. A failed job remains authoritative even when the worker's
separate implementation report says that its patch was locally verified.

Repositories whose verification requires local configuration can opt in to a
host-only validation environment. Set `ROSTER_CODING_VALIDATION_ENV_FILE` to an
absolute dotenv path and `ROSTER_CODING_VALIDATION_ENV_KEYS` to a comma-separated
allowlist of at most 32 exact keys. Both settings are required together. Roster
reads only the selected values, rejects process-loader and path-control keys,
then removes the selectors from the server environment before materializing
model runtimes. The selected values are supplied only to the non-model host
validation worker; they are not persisted in jobs, receipts, reports, or model
execution envelopes.

`POST /api/v2/coding/workspace/rescans` queues a subsequent team rescan as a
tracked, read-only management run. It requires `application/json`, accepts an
optional bounded `objective`, `workspaceId`, and stable `requestId`, and returns
`202` with `Location`, the run/job identity, `runKind: workspace-rescan`, and
explicit read-only/non-integratable capabilities. `Location` and
`statusLocation` identify the JSON run resource; `browserDestination` identifies
the operator page. The queued job snapshots its non-secret Pi provider, model,
and AFT extension configuration before execution. A distinct request while the
workspace already has an active rescan returns `409` with that active run. The
existing `/workspace/scan` response remains the synchronous `201` workspace
contract for first-time onboarding; an already-scanned workspace receives `409`
and must use the tracked endpoint.

## Job JSON API

These endpoints are useful for scripts and operators. Browser realtime should use the Roster job views described above.

### POST /agents/:id/jobs

Atomically enqueues work for a registered agent.

Request body:

```json
{
  "jobId": "optional-stable-id",
  "lane": "collect",
  "sessionKey": "optional-session",
  "singletonMode": "allow",
  "maxAttempts": 2,
  "payload": {
    "kind": "agent.run",
    "stream": "agents/agent",
    "problem": "Investigate the failure"
  }
}
```

- `lane`: `collect`, `steer`, or `follow_up`.
- `singletonMode`: `allow`, `cancel`, `steer`, or `reject`. `reject` leaves the
  active job unchanged and refuses a distinct concurrent enqueue.
- `maxAttempts`: 1–8.
- Inspector jobs require `payload.source.name` to be an existing durable stream; the server normalizes their output to the deterministic analysis stream.
- Success: `202 { "ok": true, "job": … }`.
- Errors: `400` malformed body/source, `404` inspector source stream not found.

### POST /jobs/:id/steer

Queues a steer command.

- JSON: command payload directly, or `{ "payload": { … }, "by": "operator" }`.
- Success: `202` with the durable command.
- Errors: `404 job not found`.

### POST /jobs/:id/follow-up

Queues a follow-up command. Request and response match the steer endpoint.

### POST /jobs/:id/abort

Queues an abort command.

- JSON: optional `reason`, `by`.
- Success: `202` with the durable command.
- Errors: `404 job not found`.

### GET /jobs/:id

Returns the current durable job projection. Returns `404` when the job does not exist.

### GET /jobs/:id/wait

Keeps one bounded long-poll request open until the job becomes terminal or the timeout expires.

- Query: `timeoutMs` clamped to `0..120000`, default `15000`.
- Success: `200` current job projection.
- Errors: `404 job not found`.

New realtime clients should subscribe to the exact job and its ordered events rather than issue repeated wait requests.

### GET /jobs

Returns `{ "jobs": [...] }` from the durable queue projection.

- Query: optional `status=queued|leased|running|completed|failed|canceled`, `limit=1..500` (default 50).

## Memory JSON API

Memory entries and their receipts use the configured SpacetimeDB workspace.

### POST /memory/:scope/read

- JSON: optional `limit`.
- Success: `200 { "entries": [...] }`.

### GET /memory/scopes

Returns `{ "scopes": [...] }` for durable memory scopes registered by accepted
entries or pending proposals.

### POST /memory/:scope/search

- JSON: `query`, optional `limit`.
- Success: `200 { "entries": [...] }`.

### POST /memory/:scope/open

- JSON: non-empty `ids` array, bounded to 200 exact memory entry IDs.
- Success: `200 { "entries": [...] }`.
- Errors: `400 ids required`.

### POST /memory/:scope/summarize

- JSON: optional `query`, `limit`, `maxChars`.
- Success: `200` summary result.

### POST /memory/:scope/commit

This is a trusted operator/import boundary, not an agent memory tool.

- Header: `X-Roster-Memory-Authority: commit`.
- JSON: `text` (required), optional string-array `tags`, object `meta`.
- Success: `201 { "entry": … }`.
- Errors: `400 text required`, `403 trusted memory commit authority required`.

### POST /memory/:scope/proposals

Creates a content-addressed pending memory proposal. Repeating identical
content, normalized tags, author, metadata, and source references returns the
same proposal.

- JSON: `text`, `proposedBy`, optional `tags`, `meta`, and
  `sourceReferences[{sourceId,contentHash,kind?}]`.
- Success: `202 { "proposal": … }`.
- Errors: `400 text required|proposedBy required`.

### GET /memory/:scope/proposals

- Query: optional `status=pending|accepted|rejected`, `limit=1..500`.
- Success: `200 { "proposals": [...] }`.

### POST /memory/:scope/proposals/:proposalId/accept

- Header: `X-Roster-Memory-Authority: decide`.
- JSON: `decidedBy`.
- Success: `200 { "entry": … }`. The accepted entry retains proposal and source
  provenance.
- Errors: `400 decidedBy required`, `403 memory decision authority required`.

### POST /memory/:scope/proposals/:proposalId/reject

- Header: `X-Roster-Memory-Authority: decide`.
- JSON: `decidedBy`, `reason`.
- Success: `200 { "proposal": … }`.
- Errors: `400 decidedBy required|reason required`,
  `403 memory decision authority required`.

### POST /memory/:scope/diff

- JSON: `fromTs` (required number), optional `toTs`.
- Success: `200 { "entries": [...] }`.
- Errors: `400 fromTs required`.

## Improvement JSON API

Self-improvement is autonomous by default. A verified Coding final report may
include one bounded `improvementCandidate`; Roster admits its exact accepted
artifact provenance, then separate deterministic-policy authorities verify,
canary, promote, monitor, and roll it back. Two failed admitted Coding runs
pinned to the promoted generation trigger rollback-forward. The proposal and
every transition remain available through the read APIs and the Monitor
**Inspect** audit.

Improvement routes remain an administrative JSON boundary for immutable,
receipted runtime-extension candidates and emergency intervention.
Configure trusted JSON-argv validation commands with
`IMPROVEMENT_VALIDATE_COMMAND_JSON` and
`IMPROVEMENT_HARNESS_COMMAND_JSON`. Lockfile-backed dependencies are
materialized inside each isolated worktree by default; set
`IMPROVEMENT_PREPARE_DEPENDENCIES=0` only when the trusted validation command
is deliberately dependency-free. Configure the verifier, canary operator,
promoter, and rollback secrets as an actor-to-token object in
`IMPROVEMENT_AUTHORITY_TOKENS_JSON`; raw tokens are checked at the HTTP
boundary and never enter receipts.

### POST /improvement/proposals

- JSON: `artifactType=prompt_patch|policy_patch|harness_patch`, bounded relative or logical `target`, JSON merge-patch string `patch`, `createdBy`, optional `proposalId`.
- Success: `201 { "ok": true, "proposalId": "…", "recordId": "…" }`. Use
  `recordId` as `expectedRecordId` for the next transition.
- Errors: `400` invalid type, target, JSON patch, source, or size.

### POST /improvement/:id/validate

- JSON: `validatedBy`, `authorizationToken`, `expectedRecordId`.
- Applies the candidate to an isolated committed-baseline Git worktree, runs
  the trusted bounded no-shell command, and records its evidence hash.
- Success: `200` with status, report, checks, evidence hash, and the next
  `recordId`. Failure is a terminal rejected rollout record.
- Errors: `400` missing expected record, `403` denied authority, `404` missing
  proposal, `409` stale record, wrong state, or author self-verification.

### POST /improvement/:id/approve

- JSON: `canaryBy`, `authorizationToken`, `expectedRecordId`.
- Requires configured canary authority independent from both proposal author
  and verifier, warms the verified candidate, and runs a second isolated bounded
  canary.
- Success: `200` with passed canary evidence and the next `recordId`; a failed
  canary returns `409` and remains recorded.
- Errors: `400` missing actor or expected record, `403` denied authority, `404`
  missing proposal, `409` stale record, dependent authority, or a candidate that
  has not been independently verified.

### POST /improvement/:id/apply

- JSON: `appliedBy`, `authorizationToken`, `expectedRecordId`.
- Success: `200` promoted status with runtime `generationId` and active
  `snapshotHash` and next `recordId` after atomic extension-host reconciliation.
- Errors: `400` missing expected record, `403` denied authority, `404` missing
  proposal, `409` for a stale rollout head or target baseline, unless canary
  passed, or if promoter is the author, verifier, or canary authority. Promotion compares the
  proposal's captured baseline to the active target deployment; a different
  proposal cannot win by arrival order.

### POST /improvement/:id/revert

- JSON: `revertedBy`, `authorizationToken`, `reason`, `expectedRecordId`.
- Success: `200` `rollback-forward` status with the higher runtime generation
  and next `recordId`.
- Errors: `400` missing expected record, `403` denied authority, `404` missing
  proposal, `409` for a stale rollout head, unless promoted, or if the rollback
  actor participated in any earlier rollout gate.

### GET /improvement/runtime

Returns the exact active improvement snapshot and process-local `generationId`
pinned together by future Coding admissions.

### GET /improvement/:id

Returns one durable proposal or `404`.

### GET /improvement

Returns `{ "proposals": [...] }`, newest update first.
