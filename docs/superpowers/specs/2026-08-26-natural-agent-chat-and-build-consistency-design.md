# Natural Agent Chat And Build Consistency

Date: 2026-08-26
Status: Approved for implementation

## Objective

Finish the conversation-first Coding experience described in
`2026-08-26-coding-desktop-ui-refactor-design.md`. A repository room should
feel like a small group chat in which the human and named workspace nodes talk
to one another while work is happening. Desktop and web must also expose the
same current Coding build so an older staged sidecar or browser asset cannot be
mistaken for the latest interface.

The change preserves Roster's existing node identity, room lanes, inbox
delivery, task graph, artifact acceptance, runtime binding, receipts, Git
frontiers, and certification authority. It does not expose private inbox
payloads, raw model reasoning, or tool transcripts.

## Current Gap

Roster already has durable node inboxes, addressed peer turns, accepted
collaboration artifacts, task dependencies, room timeline handoffs, and
process-local runtime progress. The current Coding projection presents only a
subset of those signals as chat:

- mutable task snapshots are intentionally removed from the main timeline;
- handoff and claim rows live in the optional Team activity panel;
- accepted proposal and response artifacts appear only in plans that create
  those artifact kinds;
- investigation artifacts are withheld from chat to avoid duplicating the
  final answer;
- live runtime milestones appear as isolated progress posts, but the receiving
  node does not visibly acknowledge the handoff;
- the desktop Coding server runs from a staged production resource tree while
  its onboarding shell runs from Vite, so edits made after staging require a
  restart;
- web development can serve a newly rendered page beside an older prebuilt
  browser asset unless the asset build is refreshed.

The result is technically accurate but socially incomplete: people see agents
working, yet do not consistently see the team exchange ownership.

## Product Principles

1. **Meaningful speech, not telemetry.** Chat contains decisions, concise
   progress, handoffs, acknowledgements, questions, review feedback, and final
   outcomes. Commands, raw logs, leases, receipts, and topology remain in
   Workbench.
2. **The named speaker authors every message.** Text presented under Kai,
   Mira, or any other node must be emitted by that node's model through a
   bounded room-update call or accepted task output. Roster never writes
   first-person copy on a node's behalf. Deterministic lifecycle copy is
   allowed only as a neutrally authored system activity event.
3. **One visible working message per node.** Live progress updates in place
   instead of adding a new bubble for every tool event.
4. **Addressed ownership.** A handoff names its sender and recipient. The
   recipient acknowledges when its durable task is claimed.
5. **Stable replay.** Durable conversation rows have content-derived IDs and
   render in the same order after reload. Ephemeral progress is visibly live
   and never becomes acceptance authority.
6. **One observable build.** HTML, browser assets, and the desktop staged
   runtime carry the same build fingerprint.

## Conversation Model

The room uses five visible conversational moments.

### Human and authored node messages

Existing durable conversation messages remain ordinary chat. Direct mentions,
replies, images, and delivery state retain their current contracts.

### Live working message

Each active model-backed node receives one provider-neutral,
Roster-controlled `room.post-update` function. The model may use it for a
concise progress message, handoff acknowledgement, or question while its task
is running. The call accepts bounded authored text, an intent, and recipient
node IDs; Roster supplies the author from the fenced execution and never lets
the model choose or impersonate that identity.

The update is process-local presentation input, not an accepted task result or
orchestration receipt. Each task may emit at most three updates, and only one
live row per node/task remains visible; a later update replaces that row unless
the earlier update was a question. The row is marked `Live` and retains its
runtime timestamp. Raw runtime logs are never rewritten into agent speech.

### Accepted handoff

When an upstream task is accepted and has a downstream dependency, the room
shows a durable handoff from the upstream node to the downstream node. The
message body is the accepted model-authored semantic summary. Delivery state is
separate UI metadata and is never appended as words attributed to the node. For
example:

> Kai → @Mira: “The streaming path now keeps one active message per node and
> deduplicates accepted turns. The focused conversation tests pass; it’s ready
> for review.”

Every model-backed task that can feed another node is prompted to write its
existing accepted `summary` as a natural direct message to the named downstream
participant. The summary is model-authored in the same task call that produces
the work; no second chatter call is added. If an accepted output has no valid
authored summary, Roster shows a neutral system handoff event and does not
fabricate an agent message.

### Handoff acknowledgement

When the downstream model begins work after receiving accepted dependencies,
its task instructions require one `room.post-update` acknowledgement to the
upstream participants before substantive work. The acknowledgement text comes
from that model. For example:

> Mira → @Kai: “Got it. I’m reviewing the accepted implementation and its
> tests now.”

The function validates that every recipient is an upstream graph participant
or the human, caps the text, and tags the update as an acknowledgement. If the
model fails to emit one, Roster may show only a neutral system claim event; it
must not fill in the missing words.

### Review, question, and resolution

Accepted peer proposals, responses, objections, endorsements, investigation
findings handed to a synthesizer, and resolutions render as lightweight node
messages rather than dashboard-like artifact cards. The concise authored
summary stays in the message body; structured evidence and runtime identity
remain behind Details or in Workbench. The final user-facing answer is still
rendered once.

## Projection Architecture

Introduce one browser-safe pure projection for social Coding rows. It consumes
only bounded public projections and authored presentation updates:

- durable conversation messages and routes;
- accepted artifact summaries and output references;
- task rows and dependency edges;
- room timeline claim, handoff, review, and attention rows;
- public node identities and roles;
- process-local, model-authored room updates.

The projector returns typed rows with stable IDs, chronology, author,
recipients, presentation kind, text, provenance, and durability. Server
rendering and realtime reconciliation use the same row identity and
deduplication rules. Realtime updates may add or replace live rows; durable
rows supersede matching live rows when their accepted source appears.

The projector does not consume private continuity inbox bodies, model scratch
state, hidden reasoning, raw tool output, or runtime credentials. It never
turns task state or command names into first-person speech. It cannot accept
artifacts, claim tasks, consume deliveries, or alter topology.

## Ordering And Bounds

- Durable source sequence is the primary order.
- A handoff follows the accepted upstream contribution.
- Its acknowledgement follows the downstream claim.
- Ties use stable content-derived row IDs, never arrival order.
- At most three room-update calls are accepted per task and at most one
  replaceable live progress row is shown per active node/task.
- Repeated authored progress replaces the existing live row; authored
  questions remain visible until answered or the task settles.
- Recipients are unique and capped at six.
- Summaries remain bounded to the existing conversation limits.
- The visible room keeps its current bounded history and new-message behavior.
- Reloading or reconnecting cannot duplicate a handoff, acknowledgement, or
  accepted peer turn.

## Visual Treatment

All social rows use the same Slack-like message anatomy: avatar, display name,
role, optional timestamp/state, addressed recipients, and readable body copy.
Handoffs and acknowledgements receive quiet labels rather than card chrome.
Consecutive rows from the same author may cluster, while a recipient change or
handoff boundary starts a new cluster.

A node's live row uses a subtle animated presence dot and `aria-live="polite"`.
Accepted rows are static. Reduced-motion mode removes the animation without
removing the `Live` label. Details distinguish model-authored live updates,
model-authored accepted summaries, and neutral Roster lifecycle events.

## Build Consistency

The Coding client build hashes the relevant Coding browser sources and shared
UI inputs before bundling, writes that deterministic value to
`public/assets/coding-build.json`, and injects the same value into the browser
bundle. The server reads the manifest, renders its fingerprint into the page,
and appends it to Coding asset URLs. The browser compares its injected value
with the page value during startup.

If the values differ, the room keeps its content visible but shows a clear
“New Roster build available — Reload” notice and does not silently claim that
the stale asset is current. Development responses remain non-cacheable.

Desktop staging copies the manifest with the production resource tree and
verifies that the staged HTML server and browser assets share the fingerprint.
The native runtime reports the fingerprint in its startup diagnostics. The web
development command builds the Coding assets before starting and watches the
server source; the documented launch path makes asset rebuilding explicit.

Desktop and web may use different local ports or databases, but the visible
fingerprint proves whether they render the same UI revision. A compact build
value is available in the command/about surface and page metadata without
adding noise to the room header.

## Failure And Recovery

- Missing model-authored summaries fall back to a neutral Roster handoff event,
  never agent-attributed wording.
- Malformed or unrelated artifacts are excluded rather than rendered as chat.
- A failed downstream task keeps the accepted upstream handoff and adds one
  addressed attention message; it does not rewrite history.
- A disconnected realtime client preserves durable rows and labels live
  progress as paused.
- A stale build shows the reload notice; it does not discard draft composer
  text.
- If desktop staging detects mismatched fingerprints, startup fails before
  opening the room and names the remediation without exposing local secrets.

## Implementation Boundaries

Expected touch points are:

- a bounded provider-neutral room-update function and process-local update
  store, with author and recipient authority supplied by the active task fence;
- a shared browser-safe Coding social-row projector;
- `src/views/coding.ts` for server rendering and message presentation;
- `src/browser/coding-client.ts` and the existing progress/peer transcript
  modules for realtime reconciliation;
- Coding build scripts and server asset URLs for the build fingerprint;
- desktop staging checks and startup diagnostics;
- focused smoke, browser projection, and desktop staging tests;
- `docs/workspace-nodes.md` only if the public node conversation projection
  boundary changes during implementation.

No new orchestration receipt vocabulary is planned. Live room updates are
ephemeral observations; accepted summaries remain durable artifacts under the
existing contracts. If implementation reveals that current public projections
cannot prove a required handoff, the work must stop and revise this design
rather than deriving authority from UI state.

## Testing

Test-driven implementation will cover:

- an accepted upstream task producing exactly one addressed handoff;
- a downstream model-authored room update producing exactly one
  acknowledgement with fenced author identity;
- a missing room update producing no fabricated node message;
- room-update recipient validation, per-task call limits, and retry-safe
  deduplication;
- fan-in and fan-out recipient selection with deterministic ordering;
- accepted summaries becoming natural chat while structured evidence remains
  inspectable;
- investigation handoffs appearing without duplicating the final answer;
- one replacing model-authored live progress row per node/task;
- durable rows superseding their matching live rows;
- reconnect, reload, and reordered delivery producing no duplicates;
- malformed artifacts and private data never appearing in chat;
- raw logs and deterministic task copy never appearing as node-authored chat;
- accessible live labels, recipient mentions, and reduced motion;
- identical build fingerprints in HTML, browser assets, and staged desktop
  resources;
- an explicit stale-build reload notice on mismatch;
- the web and desktop launch paths serving the same committed fingerprint.

After targeted tests, the implementation must pass `npm run verify`. Final
acceptance includes launching both the native desktop app and the web Coding
surface, starting a multi-node run, and observing live progress, an addressed
handoff, a receiving-node acknowledgement, review feedback, and one final
answer in the room.

## Acceptance Criteria

- A multi-node Coding run visibly behaves like a group conversation.
- The human sees concise realtime progress while nodes are working.
- Every accepted dependency handoff names its sender and intended recipient.
- The receiving node visibly acknowledges ownership with its own model-authored
  text when it starts; no acknowledgement is hardcoded by Roster.
- Agent-authored findings and review feedback appear naturally without
  exposing internal reasoning or raw telemetry.
- Reload and reconnect replay the same conversation without duplicates.
- Desktop and web display the same build fingerprint and cannot silently mix
  old HTML with newer or older browser assets.
- The latest committed build launches successfully in both environments.
- Targeted tests and `npm run verify` pass.
