# Model-Authored Slack-Like Coding Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a multi-node Coding run into a full-width Slack-like room with genuine model-authored progress, handoffs, acknowledgements, review feedback, and one final answer.

**Architecture:** Add a bounded provider-neutral `coding::room.post-update` function whose author is fenced to the active `WorkspaceNode` and whose recipients are validated from the durable task graph. Store these authored updates only as process-local presentation state, then merge them with durable conversation messages and accepted model summaries in one pure social-row projector used by server rendering and realtime reconciliation. Runtime logs remain telemetry in Workbench and are never paraphrased into agent speech.

**Tech Stack:** TypeScript, Roster v2 workspace-node contracts, function directory and node function plane, server-rendered HTML, browser streaming fetch, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-natural-agent-chat-and-build-consistency-design.md`

## Global Constraints

- `WorkspaceNode` remains the canonical logical participant; do not add agent-named aliases or Coding dual-read paths.
- Every line shown under a named node is authored by that node's model through `coding::room.post-update` or an accepted model output summary.
- Roster may emit deterministic text only as a neutrally authored system activity row.
- Never expose private inbox bodies, hidden reasoning, raw tool output, runtime credentials, leases, receipts, commands, or topology internals in chat.
- The room-update function ID is exactly `coding::room.post-update` and its required scope is exactly `room:update`.
- Room-update text is 1-420 Unicode characters after trimming; recipients are unique, sorted node IDs and capped at six.
- Each task may create at most three distinct update keys; one live progress row per node/task replaces in place, while questions remain until answered or task settlement.
- Accepted summaries, not ephemeral updates, remain the durable semantic record and acceptance authority.
- Recipient authorization derives from durable task dependencies plus the human room participant; never infer authority from the UI.
- Preserve semantic conflicts and deterministic ordering; never accept or order contributions by arrival time alone.
- The Coding conversation uses available width with a readable maximum line length inside each message, not a narrow centered feed.
- Keep Roster's current dark-green visual identity.
- Update `docs/workspace-nodes.md` if implementation changes the public node conversation projection boundary.
- Preserve unrelated worktree changes and run `npm run verify` before handoff.

---

## File Map

- `src/engine/runtime/node-room-updates.ts`: bounded process-local update types, normalization, replacement, subscription, and task settlement.
- `src/domains/coding-room-updates.ts`: Coding task-graph recipient policy and room-update function constants.
- `src/domains/coding-workers.ts`: function descriptor and fenced provider binding.
- `src/domains/coding.ts`: task prompts, exact function grants, lifecycle wiring, and saved-node reviewed-team preflight.
- `src/agents/coding.agent.ts`: shared room-update store and authorized streaming route.
- `src/server.ts`: passes the shared store into each fenced Coding run.
- `src/browser/coding-social-transcript.ts`: pure public social-row projection and stable reconciliation IDs.
- `src/browser/coding-client.ts`: realtime authored update streaming, row replacement, scroll anchoring, and removal of scripted status speech.
- `src/browser/coding-progress-updates.ts`: retained only for Workbench telemetry; it no longer creates conversational copy.
- `src/browser/coding-peer-transcript.ts`: delegates accepted peer-message projection to the social projector.
- `src/views/coding.ts`: full-width Slack-like message rows, clustering, labels, and accessible live state.
- `tests/smoke/node-room-updates.test.ts`: store bounds, replacement, settlement, and retry behavior.
- `tests/smoke/coding-workers.test.ts`: function registration, fenced identity, graph recipients, and grants.
- `tests/smoke/coding-agent.test.ts`: natural objective instructions and authored-summary audience contracts.
- `tests/smoke/coding-social-transcript.test.ts`: durable/ephemeral projection, handoff, deduplication, and ordering.
- `tests/smoke/coding-demo.test.ts`: server-rendered conversation and no-scripted-speech contract.
- `tests/smoke/coding-realtime-cutover-contract.test.ts`: streaming-fetch and browser reconciliation contract.

### Task 1: Bounded process-local node room updates

**Files:**
- Create: `src/engine/runtime/node-room-updates.ts`
- Create: `tests/smoke/node-room-updates.test.ts`

**Interfaces:**
- Produces: `NodeRoomUpdateIntent = "progress" | "acknowledgement" | "question"`.
- Produces: `NodeRoomUpdateInput { updateKey; text; intent; recipientNodeIds }`.
- Produces: `NodeRoomUpdateContext { runId; taskId; executionId; nodeId; at? }`.
- Produces: `NodeRoomUpdate { schema; updateId; runId; taskId; executionId; nodeId; updateKey; text; intent; recipientNodeIds; sequence; at; settled }`.
- Produces: `NodeRoomUpdateStoreEvent = { type: "update" | "settled"; update: NodeRoomUpdate }`.
- Produces: `NodeRoomUpdateStore.post(context, input)`, `.list(runId)`, `.settleTask(runId, taskId)`, and `.subscribe(runId, listener)`.

- [ ] **Step 1: Write failing normalization, replacement, and limit tests**

Create tests with a fixed clock and assert exact behavior:

```ts
const store = new NodeRoomUpdateStore({ now: () => "2026-08-26T20:00:00.000Z" });
const context = {
  runId: "run-1",
  taskId: "task-1",
  executionId: "execution-1",
  nodeId: "kai",
};

const first = store.post(context, {
  updateKey: "working",
  text: "  I’m tracing the streaming path now.  ",
  intent: "progress",
  recipientNodeIds: ["mira", "mira"],
});
const replacement = store.post(context, {
  updateKey: "working",
  text: "The stream is isolated; I’m validating reconnect behavior.",
  intent: "progress",
  recipientNodeIds: ["mira"],
});

assert.equal(first.updateId, replacement.updateId);
assert.equal(store.list("run-1").length, 1);
assert.equal(store.list("run-1")[0]?.text, replacement.text);
assert.deepEqual(store.list("run-1")[0]?.recipientNodeIds, ["mira"]);
```

Add cases proving an empty message, 421-character message, seventh recipient, fourth distinct update key, invalid key, invalid intent, and context with an empty identity all throw `NodeRoomUpdateValidationError`. Prove retrying the same key does not consume another slot, subscribers receive only their run, and `settleTask()` marks progress/acknowledgement settled while leaving a question visible and settled.

- [ ] **Step 2: Run the tests and verify the module is missing**

Run: `node --import tsx --test tests/smoke/node-room-updates.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the store and validation**

Use these exact public definitions:

```ts
export const NODE_ROOM_UPDATE_SCHEMA = "roster.node-room-update.v1" as const;
export const NODE_ROOM_UPDATE_TEXT_LIMIT = 420;
export const NODE_ROOM_UPDATE_RECIPIENT_LIMIT = 6;
export const NODE_ROOM_UPDATE_TASK_LIMIT = 3;

export type NodeRoomUpdateIntent = "progress" | "acknowledgement" | "question";

export interface NodeRoomUpdateInput {
  updateKey: string;
  text: string;
  intent: NodeRoomUpdateIntent;
  recipientNodeIds: string[];
}

export interface NodeRoomUpdateContext {
  runId: string;
  taskId: string;
  executionId: string;
  nodeId: string;
  at?: string;
}

export interface NodeRoomUpdate {
  schema: typeof NODE_ROOM_UPDATE_SCHEMA;
  updateId: string;
  runId: string;
  taskId: string;
  executionId: string;
  nodeId: string;
  updateKey: string;
  text: string;
  intent: NodeRoomUpdateIntent;
  recipientNodeIds: readonly string[];
  sequence: number;
  at: string;
  settled: boolean;
}

export type NodeRoomUpdateStoreEvent = {
  type: "update" | "settled";
  update: NodeRoomUpdate;
};

export class NodeRoomUpdateValidationError extends Error {}
```

Normalize `updateKey` with `/^[a-z][a-z0-9-]{0,47}$/u`, trim text, reject control characters except newline and tab, trim/deduplicate/sort recipients, and derive `updateId` as SHA-256 of schema, run ID, task ID, node ID, and update key. Replacement keeps the update ID but receives a monotonically increasing sequence and current timestamp.

Use `Map<runId, Map<updateId, NodeRoomUpdate>>` plus a per-task `Set<updateKey>`. Return frozen copies and never expose the internal arrays. `post` emits an `update` event and `settleTask` emits one `settled` event per changed update. `subscribe` returns an unsubscribe function and immediately emits no historical values; history is fetched with `list`.

- [ ] **Step 4: Run the store tests**

Run: `node --import tsx --test tests/smoke/node-room-updates.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/runtime/node-room-updates.ts tests/smoke/node-room-updates.test.ts
git commit -m "feat: add bounded node room updates"
```

### Task 2: Fenced provider-neutral room-update function

**Files:**
- Create: `src/domains/coding-room-updates.ts`
- Modify: `src/domains/coding-workers.ts`
- Modify: `src/domains/coding.ts`
- Modify: `tests/smoke/coding-workers.test.ts`

**Interfaces:**
- Consumes: `NodeRoomUpdateStore.post()` from Task 1.
- Produces: `CODING_ROOM_POST_UPDATE_FUNCTION_ID = "coding::room.post-update"`.
- Produces: `CODING_ROOM_UPDATE_SCOPE = "room:update"`.
- Produces: `codingRoomUpdateRecipientPolicy(tasks, taskId, humanNodeId): CodingRoomUpdateRecipientPolicy` with separate upstream, downstream, and human recipients.
- Produces: `bindCodingWorkerFunctionProviders({ roomUpdates, ... })` binding which authors from `FunctionProviderControl.nodeId` and metadata run/task/execution IDs.

- [ ] **Step 1: Write failing descriptor and authorization tests**

Extend `coding-workers.test.ts` to locate the descriptor and assert:

```ts
assert.equal(descriptor.id, "coding::room.post-update");
assert.deepEqual(descriptor.effects, ["write"]);
assert.deepEqual(descriptor.requiredScopes, ["room:update"]);
assert.equal(descriptor.idempotency, "supported");
```

Invoke the bound provider with control `{ nodeId: "kai", metadata: { roster_run_id: "run-1", roster_task_id: "build-1", roster_execution_id: "execution-1" } }` and input which omits any author field. Assert the stored author is `kai`. Assert input containing `nodeId`, an unauthorized recipient, missing task metadata, or control for a different bound task is rejected.

Construct task edges `plan -> build -> review`. Assert `codingRoomUpdateRecipientPolicy(tasks, "review", "human")` returns `{ upstreamNodeIds: ["builder-node"], downstreamNodeIds: [], humanNodeId: "human" }`. Assert the build policy returns its planner upstream, reviewer downstream, and the same human node ID. Invoke the provider with `intent: "acknowledgement"` and prove it rejects the reviewer but accepts the planner or human; prove progress and question intents accept any member of the full policy.

- [ ] **Step 2: Run the focused test and verify the function is absent**

Run: `node --import tsx --test tests/smoke/coding-workers.test.ts`

Expected: FAIL because `coding::room.post-update` is not registered.

- [ ] **Step 3: Implement the graph-derived recipient policy**

In `src/domains/coding-room-updates.ts`, export the constants and a pure recipient-policy function. Locate the task by ID, collect assigned node IDs from direct dependencies as `upstreamNodeIds`, collect direct dependents as `downstreamNodeIds`, remove the current task's node, sort and freeze both arrays, and retain the supplied saved human node ID separately. Throw when task IDs or assignments are missing rather than guessing from display names.

Also export:

```ts
export interface CodingRoomUpdateProviderOptions {
  roomUpdates: NodeRoomUpdateStore;
  recipientPolicyForTask: (taskId: string) => CodingRoomUpdateRecipientPolicy;
}

export interface CodingRoomUpdateRecipientPolicy {
  upstreamNodeIds: readonly string[];
  downstreamNodeIds: readonly string[];
  humanNodeId: string;
}
```

- [ ] **Step 4: Register and bind the function without author input**

Add this descriptor to `createCodingWorkerFunctionDescriptors()`:

```ts
{
  id: CODING_ROOM_POST_UPDATE_FUNCTION_ID,
  version: "1.0.0",
  capability: "room",
  description: "Post one concise model-authored update to the current Coding room.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["updateKey", "text", "intent", "recipientNodeIds"],
    properties: {
      updateKey: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" },
      text: { type: "string", minLength: 1, maxLength: 420 },
      intent: { enum: ["progress", "acknowledgement", "question"] },
      recipientNodeIds: {
        type: "array",
        maxItems: 6,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["updateId", "state"],
    properties: {
      updateId: { type: "string" },
      state: { const: "visible" },
    },
  },
  effects: ["write"],
  requiredScopes: [CODING_ROOM_UPDATE_SCOPE],
  idempotency: "supported",
  defaultTimeoutMs: 5_000,
}
```

Extend `bindCodingWorkerFunctionProviders` with optional `roomUpdateProvider?: CodingRoomUpdateProviderOptions`. When present, add the provider; when absent, preserve current non-room callers. The provider must reject extra input keys through schema validation, extract the fenced task ID first, and call `recipientPolicyForTask(taskId)` so parallel tasks sharing the provider cannot inherit another task's recipients. For `acknowledgement`, recipients must be a non-empty subset of `upstreamNodeIds` plus the human node; for `progress` and `question`, recipients must be a subset of upstream, downstream, and the human node. Construct `NodeRoomUpdateContext` exclusively from `control.nodeId` plus `roster_run_id`, `roster_task_id`, and `roster_execution_id` metadata, call the store, and return `{ updateId, state: "visible" }`.

- [ ] **Step 5: Grant the function narrowly to model-backed Coding nodes**

In `defineCodingAgentPlatform`, include the room-update function and `room:update` scope for non-coordinator, non-validator model nodes. For investigation tasks, allow `write` in `allowedEffects` but grant no other write-effect function IDs; this preserves their read-only repository authority while permitting process-local room presentation. Keep validation nodes and deterministic coordinators without the function.

Add tests which inspect grants for investigation, implementation, validation, and coordinator nodes and prove the investigation grant contains the room function but excludes memory proposal and workspace mutation functions.

- [ ] **Step 6: Run worker tests**

Run: `node --import tsx --test tests/smoke/coding-workers.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domains/coding-room-updates.ts src/domains/coding-workers.ts src/domains/coding.ts tests/smoke/coding-workers.test.ts
git commit -m "feat: give coding nodes a fenced room update function"
```

### Task 3: Natural model-authored task summaries and acknowledgements

**Files:**
- Modify: `src/domains/coding.ts`
- Create: `tests/smoke/coding-agent.test.ts`

**Interfaces:**
- Consumes: exact room-update function ID from Task 2.
- Produces: every model-backed task objective contains bounded room behavior and an accepted-summary audience.
- Preserves: existing result JSON contracts and output keys; no additional model call is introduced.

- [ ] **Step 1: Write failing objective contract tests**

Build representative investigation, synthesis, implementation, review, remediation, and certification plans with the existing test fixtures. For every model-backed task assert its objective contains `coding::room.post-update`, `maximum of three`, and `Do not include raw commands, logs, hidden reasoning, or JSON in room text`.

For a direct dependency, assert the downstream objective names the upstream node ID and requires one acknowledgement before substantive work. Assert each non-final task asks the existing `summary` field to be a direct first-person message to its downstream node IDs. Assert final synthesis/certification addresses the human once and does not request a second chatter call.

- [ ] **Step 2: Run the objective tests and verify current prompts fail**

Run: `node --import tsx --test tests/smoke/coding-agent.test.ts`

Expected: FAIL because implementation and review objectives do not consistently define natural room behavior.

- [ ] **Step 3: Add one shared room-instruction builder**

Inside `src/domains/coding.ts`, add a private pure helper:

```ts
function codingRoomInstructions(input: {
  upstreamNodeIds: readonly string[];
  downstreamNodeIds: readonly string[];
  finalAudience: "human" | "nodes";
}): string
```

It must return instructions with these exact semantic requirements:

```text
Use coding::room.post-update for concise room communication, with a maximum of three calls for this task.
If upstream node IDs are listed, post one acknowledgement to them before substantive work.
Use progress only for a meaningful change in understanding; use question only when an answer can change the work.
Do not include raw commands, logs, hidden reasoning, tool transcripts, JSON, or fabricated results in room text.
Write the result summary as a natural direct first-person message to the listed downstream participants; the summary is shown verbatim in the room.
```

Append actual sorted upstream/downstream node IDs on separate lines. For a human final audience, replace the last instruction with `Write the result summary as one direct answer to the human; it is shown once in the room.`

- [ ] **Step 4: Apply the helper to every model-backed Coding task**

Apply the shared instructions when building investigation, synthesis, implementation, reviewed proposal, review, remediation, and certification objectives. Keep the current output schemas and summary fields unchanged. Do not create deterministic acknowledgement strings, progress templates, or agent quotations in TypeScript.

- [ ] **Step 5: Run prompt and domain tests**

Run: `node --import tsx --test tests/smoke/coding-agent.test.ts tests/smoke/coding-workers.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domains/coding.ts tests/smoke/coding-agent.test.ts
git commit -m "feat: prompt coding nodes for natural room messages"
```

### Task 4: Reviewed-team preflight before enqueue

**Files:**
- Modify: `src/domains/coding.ts`
- Modify: `src/agents/coding.agent.ts`
- Modify: `tests/smoke/roster-definition.test.ts`
- Modify: `tests/smoke/coding-demo.test.ts`

**Interfaces:**
- Produces: `resolveCodingReviewedSelection(input): { selectedNodeIds: readonly string[]; reviewerNodeId?: string }`.
- Consumes: saved `WorkspaceNode` capabilities and metadata, accepted review mode, selected primary node ID, and current selected node IDs.
- Preserves: `deriveCodingNodeDemands()` as the fail-closed run-boundary check; it does not invent or materialize an unapproved node.

- [ ] **Step 1: Write failing deterministic selection tests**

In `roster-definition.test.ts`, create a saved human, primary implementation node, two review-capable nodes, and one non-review worker. Call `resolveCodingReviewedSelection()` with reviewed mode and only the primary selected. Assert the result contains the primary and the lexicographically first eligible reviewer, records that reviewer ID, excludes the human/non-review worker, and is identical when the input node array is reversed.

Add cases proving fast mode does not add a reviewer, an already selected valid reviewer is preserved, the primary can never be selected as its own reviewer, and reviewed mode throws `CodingReviewedSelectionUnavailableError` when no saved node has `review` capability or supervisor role.

- [ ] **Step 2: Run the domain test and verify the resolver is absent**

Run: `node --import tsx --test tests/smoke/roster-definition.test.ts`

Expected: FAIL because `resolveCodingReviewedSelection` is not exported.

- [ ] **Step 3: Implement saved-node-only reviewed selection**

Add these exports to `src/domains/coding.ts`:

```ts
export class CodingReviewedSelectionUnavailableError extends Error {}

export function resolveCodingReviewedSelection(input: {
  nodes: readonly WorkspaceNode[];
  selectedNodeIds: readonly string[];
  primaryNodeId: string;
  reviewMode: CodingReviewMode;
}): { selectedNodeIds: readonly string[]; reviewerNodeId?: string }
```

Validate that the primary exists, is non-human, and is selected. In fast mode return the deduplicated selected IDs in their existing order. In reviewed mode, retain the first already selected eligible reviewer; otherwise choose from saved non-human nodes other than the primary where `capabilities.includes("review") || metadata.role === "supervisor"`, sorted by node ID. Append exactly one reviewer. If none exists, throw the named error with user-safe text explaining that a saved review-capable workspace node is required.

- [ ] **Step 4: Apply preflight to new messages and retry**

In `src/agents/coding.agent.ts`, replace the current one-off reviewed reviewer search after planning with `resolveCodingReviewedSelection()`. Apply the same resolver before enqueueing `Retry Run` from a preserved failed payload so an older route with only a primary node cannot restart into the same failure.

If selection is unavailable, emit a `needs_clarification` route before creating a queue job. Its question must ask the human to enable or select a saved review-capable workspace node; it must not enqueue a run that will immediately stop. Keep the error as neutral Roster UI copy, not dialogue attributed to a model node.

- [ ] **Step 5: Add route and retry regression tests**

In `coding-demo.test.ts`, post a reviewed objective whose planner selects only the primary while the saved profile contains a reviewer. Assert the 202 response and queued payload contain both node IDs. Create an old failed reviewed job whose payload contains only the primary, call Retry Run, and assert the fresh job contains the resolved reviewer.

Add a profile with no eligible reviewer and assert the request returns a clarification route, creates no queue job, and never contains `Stopped before the first step` or `Reviewed coding execution requires an explicitly selected review-capable workspace node`.

- [ ] **Step 6: Run the reviewed preflight tests**

Run: `node --import tsx --test tests/smoke/roster-definition.test.ts tests/smoke/coding-demo.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domains/coding.ts src/agents/coding.agent.ts tests/smoke/roster-definition.test.ts tests/smoke/coding-demo.test.ts
git commit -m "fix: preflight reviewed coding team selection"
```

### Task 5: Wire update storage into Coding runs and an authorized streaming feed

**Files:**
- Modify: `src/agents/coding.agent.ts`
- Modify: `src/domains/coding.ts`
- Modify: `src/server.ts`
- Modify: `src/simulations/coding-collaboration.ts`
- Modify: `tests/smoke/coding-demo.test.ts`
- Modify: `tests/smoke/coding-realtime-cutover-contract.test.ts`

**Interfaces:**
- Consumes: `NodeRoomUpdateStore` and provider options from Tasks 1-2.
- Produces: singleton `codingRoomUpdates` scoped to the local Coding runtime process.
- Produces: authenticated `GET /coding/room-updates?run=run-123&conversation=conversation-123&job=job-123&workspace=workspace_0123456789abcdefabcd` NDJSON stream, where the real identifiers come from authorized page state.
- Produces: NDJSON records `snapshot`, `update`, `settled`, and `heartbeat`, with JSON bodies containing only public `NodeRoomUpdate` fields.
- Produces: current authorized run updates in the server-rendered Coding page model for refresh/reload continuity within the same process.

- [ ] **Step 1: Add failing route and privacy contract tests**

Extend the existing Coding demo server fixture. Start two runs in different workspaces, add one update to each, request the endpoint as the first workspace, and assert its snapshot includes only its own run. Render the active room and assert its page model contains only that run's update. Assert a missing or foreign run returns 404 using the repository's existing not-found response. Assert the serialized event does not contain function control metadata, runtime environment values, inbox bodies, prompts, tool input, or credentials.

In the cutover contract test, read `src/agents/coding.agent.ts` and assert the endpoint, `application/x-ndjson`, and `codingRoomUpdates.subscribe` exist.

- [ ] **Step 2: Run the route tests and verify 404**

Run: `node --import tsx --test tests/smoke/coding-demo.test.ts tests/smoke/coding-realtime-cutover-contract.test.ts`

Expected: FAIL because `/coding/room-updates` is not routed.

- [ ] **Step 3: Create and pass the shared store**

Instantiate and export one `NodeRoomUpdateStore` in `src/agents/coding.agent.ts` next to the existing process-local runtime log store. Add required `roomUpdates: NodeRoomUpdateStore` to `RunCodingAgentOptions`. In `src/server.ts`, import that shared store and pass it into `runCodingAgent`. Give `src/simulations/coding-collaboration.ts` its own local store when it calls `runCodingAgent`. Provide the store to `bindCodingWorkerFunctionProviders` with recipients computed from the current durable task graph.

Add optional `roomUpdates?: NodeRoomUpdateStore` to `CodingRouteDeps` for test injection. The production factory passes the exported singleton; route tests pass an isolated store.

On accepted or terminal task settlement, call `settleTask(runId, taskId)`. Do not write updates into receipts, accepted artifacts, inbox contents, or the shared-workspace CRDT.

- [ ] **Step 4: Implement the authorized streaming route**

In `src/agents/coding.agent.ts`, validate `run`, `conversation`, `job`, and `workspace` through the same `findCodingJob` and `codingJobExecutionId` checks used by `/coding/runtime-logs`. Return the initial sorted `list(runId)` as one NDJSON `snapshot` record, subscribe for updates, send a JSON heartbeat on the existing 15-second interval, and unsubscribe on abort/connection close.

When constructing the active Coding page model, call the injected store's `list(runId)` only after the same job/workspace authorization succeeds and pass those bounded rows to `codingPage`. Do not serialize updates for inactive or foreign runs.

Serialize only:

```ts
{
  schema, updateId, runId, taskId, executionId, nodeId,
  updateKey, text, intent, recipientNodeIds, sequence, at, settled,
}
```

- [ ] **Step 5: Run route and domain tests**

Run: `node --import tsx --test tests/smoke/node-room-updates.test.ts tests/smoke/coding-workers.test.ts tests/smoke/coding-demo.test.ts tests/smoke/coding-realtime-cutover-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/coding.agent.ts src/domains/coding.ts src/server.ts src/simulations/coding-collaboration.ts tests/smoke/coding-demo.test.ts tests/smoke/coding-realtime-cutover-contract.test.ts
git commit -m "feat: stream model-authored coding room updates"
```

### Task 6: Pure Slack-like social transcript projector

**Files:**
- Create: `src/browser/coding-social-transcript.ts`
- Modify: `src/browser/coding-peer-transcript.ts`
- Create: `tests/smoke/coding-social-transcript.test.ts`
- Modify: `tests/smoke/coding-peer-transcript.test.ts`

**Interfaces:**
- Consumes: public conversation routes/messages, public node identities, accepted task artifacts/summaries, task dependency edges, public timeline events, and `NodeRoomUpdate[]`.
- Produces: bounded adapter inputs `CodingSocialMessageInput`, `CodingSocialAcceptedSummaryInput`, `CodingSocialTaskInput`, `CodingSocialTaskEdgeInput`, and `CodingSocialSystemActivityInput`; callers parse domain/database rows into these public DTOs before projection.
- Produces: `projectCodingSocialRows(input): CodingSocialRow[]`.
- Produces: `CodingSocialRow { rowId; sourceId; sourceKind; author; recipients; body; at; state; durability; cluster; taskId?; updateId? }`.
- Produces: `sourceKind = "message" | "live-update" | "accepted-summary" | "system-activity"` and `durability = "durable" | "ephemeral"`.

- [ ] **Step 1: Write failing projection tests**

Create fixtures for a human message, Kai implementation summary accepted toward Mira's review task, Mira live acknowledgement, Mira accepted review feedback toward Kai, a missing-summary task, an investigation summary toward a synthesizer, and one final answer.

Assert:

```ts
assert.deepEqual(
  rows.map((row) => [row.sourceKind, row.author.nodeId, row.recipients.map((recipient) => recipient.nodeId)]),
  [
    ["message", "human", ["kai"]],
    ["accepted-summary", "kai", ["mira"]],
    ["live-update", "mira", ["kai"]],
    ["accepted-summary", "mira", ["kai"]],
    ["system-activity", "roster", ["synthesizer"]],
    ["accepted-summary", "investigator", ["synthesizer"]],
    ["accepted-summary", "synthesizer", ["human"]],
  ],
);
```

Assert bodies for named nodes equal the fixture's authored message or accepted summary byte-for-byte after outer trim. Assert the missing-summary system row is authored by `roster`, contains no `I`, `I'm`, `I've`, or node quotation, and only states task delivery metadata. Assert reordered inputs yield the same row IDs/order, repeated updates replace the same live row, questions remain, and an accepted summary supersedes a settled live update from the same task.

Add two progress updates with distinct update keys for the same node/task and assert only the highest-sequence progress row remains. Add a failed downstream task and assert the accepted upstream handoff remains followed by exactly one neutral Roster attention row addressed to the human and upstream node.

- [ ] **Step 2: Run the projector tests and verify the module is missing**

Run: `node --import tsx --test tests/smoke/coding-social-transcript.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement typed stable rows**

Define exact public types:

```ts
export interface CodingSocialProjectionInput {
  participants: readonly CodingSocialParticipant[];
  messages: readonly CodingSocialMessageInput[];
  acceptedSummaries: readonly CodingSocialAcceptedSummaryInput[];
  tasks: readonly CodingSocialTaskInput[];
  edges: readonly CodingSocialTaskEdgeInput[];
  systemActivities: readonly CodingSocialSystemActivityInput[];
  roomUpdates: readonly NodeRoomUpdate[];
}

export interface CodingSocialMessageInput {
  sourceId: string;
  sourceSequence: string;
  at: string;
  authorNodeId: string;
  recipientNodeIds: readonly string[];
  body: string;
}

export interface CodingSocialAcceptedSummaryInput {
  artifactId: string;
  outputReference: string;
  sourceSequence: string;
  at: string;
  taskId: string;
  authorNodeId: string;
  body?: string;
}

export interface CodingSocialTaskInput {
  taskId: string;
  nodeId: string;
  state: "pending" | "running" | "accepted" | "failed";
}

export interface CodingSocialTaskEdgeInput {
  taskId: string;
  prerequisiteTaskId: string;
}

export interface CodingSocialSystemActivityInput {
  sourceId: string;
  sourceSequence: string;
  at: string;
  taskId: string;
  recipientNodeIds: readonly string[];
  kind: "claim" | "handoff" | "attention";
}

export type CodingSocialSourceKind =
  | "message"
  | "live-update"
  | "accepted-summary"
  | "system-activity";

export interface CodingSocialParticipant {
  nodeId: string;
  displayName: string;
  role: string;
  avatarLabel: string;
  human: boolean;
}

export interface CodingSocialRow {
  rowId: string;
  sourceId: string;
  sourceKind: CodingSocialSourceKind;
  author: CodingSocialParticipant;
  recipients: CodingSocialParticipant[];
  body: string;
  at: string;
  state: "sent" | "live" | "accepted" | "attention";
  durability: "durable" | "ephemeral";
  cluster: "start" | "continuation";
  taskId?: string;
  updateId?: string;
}
```

Use the browser-safe `hashCanonical` from `src/core/canonical.ts` for durable summary row IDs from accepted artifact ID, output reference, author node ID, sorted recipient IDs, and body. Use the store's update ID for ephemeral rows. Determine recipients only from durable message routes or direct task dependencies. Parse decimal `sourceSequence` values with `BigInt`, sort primarily by sequence, then ISO timestamp, then stable row ID. Before sorting, retain only the highest-sequence `progress` or `acknowledgement` update for each node/task while preserving every question. Mark continuation only when adjacent rows share author and recipients and neither is a handoff boundary.

For a valid accepted summary, preserve authored body text and author identity. For missing/invalid summaries emit one neutral Roster row such as `Accepted work from Kai was delivered to Mira.`; this row is system metadata, never attributed to Kai. Render the final answer once by suppressing any other row with the same accepted output reference.

- [ ] **Step 4: Make the peer transcript use the shared projection rules**

Refactor `coding-peer-transcript.ts` to map proposal, response, resolution, and endorsement fixtures through the accepted-summary branch of `projectCodingSocialRows`. Preserve its existing exported API so callers do not break, but delete any independent recipient/order/deduplication logic now owned by the social projector.

- [ ] **Step 5: Run projector tests**

Run: `node --import tsx --test tests/smoke/coding-social-transcript.test.ts tests/smoke/coding-peer-transcript.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser/coding-social-transcript.ts src/browser/coding-peer-transcript.ts tests/smoke/coding-social-transcript.test.ts tests/smoke/coding-peer-transcript.test.ts
git commit -m "feat: project coding work as social room messages"
```

### Task 7: Full-width Slack-like server rendering

**Files:**
- Modify: `src/views/coding.ts`
- Modify: `tests/smoke/coding-demo.test.ts`
- Modify: `docs/workspace-nodes.md`

**Interfaces:**
- Consumes: `CodingSocialRow[]` from Task 6.
- Produces: DOM row selector `[data-coding-social-row]` with `data-row-id`, `data-source-kind`, `data-author-node-id`, `data-task-id`, and optional `data-update-id`.
- Produces: room container selector `[data-coding-room-transcript]` and full-width layout with responsive gutters.

- [ ] **Step 1: Write failing conversation rendering tests**

Extend `coding-demo.test.ts` to render the fixture transcript and assert each named message has an avatar, display name, role, timestamp, recipient mention, exact authored body, and `Details` disclosure. Assert accepted proposal/review summaries are not rendered with `artifact-card` chrome in the main room. Assert the final answer occurs once.

Add negative assertions against the current scripted phrases:

```ts
for (const scriptedCopy of [
  "Started the assigned repository step.",
  "Running relevant repository checks.",
  "Inspecting the repository and will return an evidence-backed answer.",
  "steps are in progress now",
]) {
  assert.doesNotMatch(html, new RegExp(scriptedCopy.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
}
```

Assert the main transcript does not use the old narrow max-width declaration and has responsive horizontal padding no larger than 32px on desktop and 16px on narrow viewports.

- [ ] **Step 2: Run the view tests and verify current markup fails**

Run: `node --import tsx --test tests/smoke/coding-demo.test.ts`

Expected: FAIL because accepted contributions still render as cards and the room remains narrowly centered.

- [ ] **Step 3: Render all social rows with one Slack-like anatomy**

Replace the independent snapshot/peer/progress rendering branches in the main conversation with one renderer over `projectCodingSocialRows()`. The row anatomy is:

```html
<article data-coding-social-row data-row-id="…">
  <div class="coding-message-avatar" aria-hidden="true">K</div>
  <div class="coding-message-content">
    <header>
      <strong>Kai</strong><span>Implementation Engineer</span><time>21:46</time>
      <span class="coding-live-label">Live</span>
    </header>
    <div class="coding-message-recipients">to <span>@Mira</span></div>
    <p class="coding-message-body">Model-authored text remains verbatim here.</p>
    <details><summary>Details</summary>…public provenance only…</details>
  </div>
</article>
```

Escape every authored field. Render links/Markdown only through the existing safe message formatter. Show source and durability in Details without raw input/output. A continuation row visually suppresses the duplicate avatar while retaining accessible author text.

- [ ] **Step 4: Make the room wide without making prose unreadable**

Set the transcript and composer to `width: 100%` and remove the narrow centered feed max-width. Use `padding-inline: clamp(16px, 2vw, 32px)`. Let message content occupy the available row, but constrain `.coding-message-body` to `max-width: 90ch`; structured code/evidence details may use full row width. Keep the participant header and working strip aligned to the same gutters.

At widths below 720px, collapse the avatar column to 32px, stack role/time beneath the name, and keep the composer fixed to the viewport bottom without covering the last message. Add `scroll-padding-bottom` equal to composer height.

- [ ] **Step 5: Add accessible live and reduced-motion styling**

Give live rows `aria-live="polite"` and a textual `Live` label. Animate only the presence dot. Under `@media (prefers-reduced-motion: reduce)`, remove the animation while leaving the label. Use existing focus tokens for Details, mentions, and actions.

- [ ] **Step 6: Document the public projection boundary**

Update `docs/workspace-nodes.md` to state that Coding room rows may project model-authored process-local room updates and accepted summaries, while private continuity inbox bodies, scratch reasoning, raw runtime logs, and function payloads remain excluded. State that the update author's node ID is derived from the fenced execution rather than model input.

- [ ] **Step 7: Run view and projector tests**

Run: `node --import tsx --test tests/smoke/coding-social-transcript.test.ts tests/smoke/coding-demo.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/views/coding.ts tests/smoke/coding-demo.test.ts docs/workspace-nodes.md
git commit -m "refactor: render coding work as a full-width room"
```

### Task 8: Realtime authored message reconciliation

**Files:**
- Modify: `src/browser/coding-client.ts`
- Modify: `src/browser/coding-progress-updates.ts`
- Modify: `tests/smoke/coding-realtime-cutover-contract.test.ts`
- Modify: `tests/smoke/coding-demo.test.ts`

**Interfaces:**
- Consumes: the authorized `/coding/room-updates` NDJSON stream from Task 5 and server-rendered social-row DOM from Task 7.
- Produces: one abortable NDJSON fetch stream per active run, stable row upsert by `data-row-id`, and connection state `live | paused`.
- Preserves: runtime log feed for Workbench telemetry only.

- [ ] **Step 1: Write failing client contract tests**

In `coding-realtime-cutover-contract.test.ts`, inspect the browser source and assert it fetches `/coding/room-updates`, parses bounded NDJSON records for `snapshot`, `update`, and `settled`, and queries rows by stable `data-row-id`. Assert `renderConversationalProgressPosts` and every scripted sentence from Task 7 are absent.

Add pure exported helper tests for:

```ts
upsertCodingSocialRows(existingRows, incomingRows)
```

Prove a repeated update replaces the same row, a higher sequence wins, a question remains when settled, an accepted summary removes the corresponding settled live progress row, and two different node/task pairs remain separate.

- [ ] **Step 2: Run the client tests and verify current runtime paraphrases fail**

Run: `node --import tsx --test tests/smoke/coding-realtime-cutover-contract.test.ts tests/smoke/coding-demo.test.ts`

Expected: FAIL because runtime logs still generate conversational agent posts.

- [ ] **Step 3: Remove scripted agent speech from runtime progress**

Delete `renderConversationalProgressPosts` and its invocation from `coding-client.ts`. Refactor `coding-progress-updates.ts` so it exports structured telemetry for Workbench only: command kind, task/node IDs, timestamp, and raw-log reference. Remove every function that turns command names or lifecycle state into first-person or natural-language node copy.

Do not remove runtime logs themselves; Workbench still needs them.

- [ ] **Step 4: Subscribe and reconcile authored updates**

Open one abortable streaming `fetch` using the active run, conversation, job, and workspace IDs already present in page data. Reuse the existing bounded line decoder used by runtime logs. Parse each record as bounded public data and discard malformed schema, unknown node, wrong run, overlong text, invalid intent, or more than six recipients. Pass valid rows through the shared social projector and upsert by stable row ID.

For progress and acknowledgement, replace the row in place. Keep question rows after settlement with a quiet `Waiting`/`Settled` metadata label that is not node-authored body text. When a durable accepted row for the task appears during normal page refresh/reconciliation, remove the settled ephemeral progress row but retain unanswered questions.

- [ ] **Step 5: Preserve human reading position**

Before an upsert, detect whether the transcript is within 80px of the bottom. Auto-scroll only in that case. Otherwise preserve scroll position and show the existing new-message control with the count of unseen social rows. Updating an existing row must not increment the count.

On streaming fetch error, mark existing live labels `Paused` and reconnect with the current bounded backoff helper. Do not convert connection state into speech attributed to a node.

- [ ] **Step 6: Run browser contract tests and build**

Run: `node --import tsx --test tests/smoke/coding-realtime-cutover-contract.test.ts tests/smoke/coding-demo.test.ts && npm run build:coding-client`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/browser/coding-client.ts src/browser/coding-progress-updates.ts tests/smoke/coding-realtime-cutover-contract.test.ts tests/smoke/coding-demo.test.ts
git commit -m "refactor: show only authored realtime node messages"
```

### Task 9: End-to-end multi-node room acceptance

**Files:**
- None; this task verifies the committed implementation. Any failure returns to the owning task's explicit regression-test and commit cycle.

**Interfaces:**
- Consumes: Tasks 1-8 and the completed build-consistency plan.
- Produces: a verified native and web room in which real configured LLM nodes converse during a bounded run.

- [ ] **Step 1: Run the complete focused suite**

Run:

```bash
node --import tsx --test \
  tests/smoke/node-room-updates.test.ts \
  tests/smoke/coding-workers.test.ts \
  tests/smoke/coding-agent.test.ts \
  tests/smoke/coding-social-transcript.test.ts \
  tests/smoke/coding-peer-transcript.test.ts \
  tests/smoke/coding-demo.test.ts \
  tests/smoke/coding-realtime-cutover-contract.test.ts
```

Expected: PASS.

- [ ] **Step 2: Prove no TypeScript-authored node dialogue remains**

Run:

```bash
rg -n "Started the assigned repository step|Running relevant repository checks|inspecting the repository and will return|steps are in progress now|I.m ready to implement after you confirm" src tests
```

Expected: no matches outside negative test assertions and historical design documentation.

- [ ] **Step 3: Run repository verification**

Run: `npm run verify`

Expected: PASS with no type, lint, unit, smoke, or generated-resource failures.

- [ ] **Step 4: Launch the web and native builds**

Run `npm run coding:web` in one terminal and `npm run desktop:dev` in another. Confirm the Coding build fingerprint is identical as required by `2026-08-26-coding-build-consistency.md`.

Expected: both surfaces open the same current full-width room, not the older centered/card-heavy layout.

- [ ] **Step 5: Run one real bounded multi-node objective**

In a repository room with at least an implementation node and a review-capable node selected, send:

```text
Inspect the current Coding room streaming path, make one small test-backed improvement to reconnect behavior, and have a separate reviewer verify it.
```

Observe the room until completion. The acceptance trace must contain:

1. the human objective once;
2. at least one model-authored live progress row whose body is not a runtime-log paraphrase;
3. one accepted upstream summary addressed to its actual downstream node;
4. one downstream model-authored acknowledgement;
5. model-authored review feedback or endorsement;
6. one final answer to the human;
7. no duplicated rows after reload and reconnect;
8. private inbox bodies, raw commands, reasoning, and credentials absent from Details and page source.

- [ ] **Step 6: Verify fallback behavior**

Run the existing fixture which omits an accepted summary and the fixture in which a model makes no room-update call.

Expected: Roster shows only a neutral system delivery/claim row; it does not fabricate words under a node's name.

- [ ] **Step 7: Confirm the verified tree is clean**

Run: `git status --short`

Expected: no output. If acceptance exposed a defect, return to the task that owns the failing behavior, add a regression assertion to that task's test file, repeat its test cycle, and use that task's explicit commit command before rerunning this acceptance task.
