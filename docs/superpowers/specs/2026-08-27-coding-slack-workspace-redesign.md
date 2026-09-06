# Coding Slack Workspace Redesign

Date: 2026-08-27
Status: Approved for planning

## Decision Summary

Refactor the complete Coding desktop product into a Slack-like team workspace:
a compact room rail, an edge-to-edge conversation surface, and a collapsible
Workbench drawer. Preserve Roster's dark green identity. Treat Switch as the
behavioral reference for named agents participating inside an ordinary team
chat, not as a visual console to copy.

This specification sharpens and supersedes the visual layout portions of
`2026-08-26-coding-desktop-ui-refactor-design.md`. The authored-chat, durable
handoff, streaming, and build-consistency requirements in
`2026-08-26-natural-agent-chat-and-build-consistency-design.md` remain in
force.

The approved decisions are:

- conversation is the primary surface;
- the desktop default is a three-region Slack-style workspace;
- Workbench is a collapsible right-side drawer, not a centered overlay or a
  replacement page;
- the conversation and composer use the available center width instead of a
  narrow centered card;
- agent speech and progress are produced from real model or durable runtime
  events and are never hardcoded as first-person conversation;
- the redesign covers onboarding, rooms, active work, failures, completed
  work, and review—not only an empty-room screenshot.

## Problem Statement

The current Coding surface has some correct ingredients but the wrong visual
composition. The repository rail, room header, conversation, run controls, and
composer read as separate dashboard panels. A rounded outer frame creates a
second application boundary inside the desktop window. Large blank areas and
oversized cards make sparse rooms look unfinished. Operational status competes
with human conversation, and Workbench feels like a separate destination
instead of supporting context.

The result is neither the density of Slack nor the social clarity demonstrated
by Switch's Slack integration. It exposes a coordination system rather than
making the human feel present in a room with named teammates.

## Experience Goal

Opening Coding should feel like opening a familiar team messenger attached to
one repository. The user should immediately understand:

1. which repository and room are active;
2. who is in the room;
3. what the team has said and what it is doing now;
4. whether the user needs to respond;
5. where to inspect plans, files, evidence, and review details.

The normal path is conversation first. Workbench is available in one click and
does not obscure or replace the room at desktop widths.

## Product Principles

### Chat is the product

The timeline is the dominant canvas. Plans, tasks, receipts, branches, runtime
bindings, logs, and artifacts are supporting information. Their concise
meaning appears in chat; their full structure belongs in Workbench or Review.

### Participants, not processes

The room uses the durable `WorkspaceNode` identity for avatars, names, roles,
mentions, author labels, and handoffs. Runtime provider, process, lease,
worktree, model, and sandbox information remain secondary metadata.

### Authored speech is honest

Text shown under a participant's identity must originate from that
participant's model-authored room update, durable message, or accepted output.
Roster may render neutral system events, but it must not invent first-person
agent chatter, acknowledgements, or status sentences.

### Calm density

Slack-like means compact hierarchy and predictable placement, not visual
clutter. Rows use whitespace and typography more than borders. Green indicates
presence, progress, selection, or the primary action; it does not tint every
surface.

### Full width, readable text

The shell and timeline occupy the available viewport. The conversation is not
placed inside a centered maximum-width card. Individual long-form message
bodies retain a readable line length, while row backgrounds, attachments,
artifacts, and the composer can use the full center column.

## Desktop Information Architecture

At widths of 1180 pixels and above, Coding uses a full-height application grid:

```text
┌───────────────┬──────────────────────────────────┬──────────────────┐
│ Workspace rail│ Room header                      │ Workbench drawer │
│ 240 px        ├──────────────────────────────────┤ 336 px, optional │
│               │ Conversation                     │                  │
│               │                                  │                  │
│               ├──────────────────────────────────┤                  │
│               │ Composer                         │                  │
└───────────────┴──────────────────────────────────┴──────────────────┘
```

The application fills `100dvh`. There is no rounded outer shell, centered app
card, or page-level gutter. Only the borders between rail, conversation, and
Workbench define the layout.

### Workspace rail

The rail is 240 pixels by default and may be resized only in a future feature.
It contains:

- a 48-pixel repository switcher row;
- a compact search/command trigger;
- one clear `New room` action;
- rooms grouped by active, waiting, and recent state;
- a collapsible roster of saved participants;
- `Needs attention` and project scope entries;
- connection state and settings at the bottom.

Room rows are 32–36 pixels high. The selected room uses a quiet filled surface
and a slim accent indicator. Each row has one primary label and at most one
secondary signal such as unread count, `Working`, or `Waiting for you`.
Internal run IDs, branch paths, and file counts do not appear in the primary
room list.

### Room header

The room header is a single 56-pixel sticky row. It contains:

- room name and one plain-language status;
- optional short topic or branch metadata, truncated safely;
- participant avatar stack and accessible count;
- search and Workbench controls.

The header does not repeat repository identity already visible in the rail. It
does not use a second breadcrumb bar. Opening Workbench changes the toggle's
pressed state and updates the URL presentation state without changing room
authority.

### Conversation column

The center column is a vertical flex layout: header, scrollable timeline, and
sticky composer. The timeline fills all remaining height and scrolls
independently. Message rows span the center column; their text block uses a
readable maximum measure of approximately 880 pixels while attachments and
work summaries may extend farther.

The timeline uses 20–24 pixels of horizontal inset on desktop and 12–16 pixels
on narrow windows. It does not reserve equal blank gutters on both sides and
does not vertically center active conversation content.

### Workbench drawer

Workbench is 336 pixels wide by default, adjustable within 320–380 pixels if a
future resize affordance is added. It is closed by default for new rooms and
remembers only a local presentation preference. It contains four tabs:

1. **Work** — plan, current step, progress, retries, and required decisions;
2. **Files** — changed files, artifacts, evidence, and Review entry point;
3. **Team** — participants, current ownership, inbox delivery summaries, and
   handoff history;
4. **Details** — branch, runtime, receipts, topology, diagnostics, and build
   fingerprint.

Workbench uses a continuous panel, not nested card stacks. Sections use compact
headings, dividers, and disclosures. Opening it never consumes a delivery,
claims a task, accepts an artifact, or changes orchestration state.

## Conversation Design

### Message anatomy

Every participant message uses the same structure:

- 32-pixel avatar;
- display name, optional role, and timestamp on one header line;
- addressed recipients when the message is a direct handoff or reply;
- 14-pixel message body with approximately 1.45 line height;
- optional compact attachment, artifact, or action row;
- secondary actions revealed on hover and keyboard focus.

Messages are not independent bordered cards. A subtle hover background spans
the row. Consecutive messages from the same author within a short interval may
collapse the repeated avatar and author header. A recipient change, handoff,
question, or status transition starts a new visible group.

Human messages use the same anatomy as node messages. They may receive a quiet
self-authored tint, but they are not large chat bubbles aligned to a different
edge.

### System activity

Neutral lifecycle events render as compact timeline dividers or rows with an
icon, short statement, and timestamp. Examples include a branch being created,
a run starting, a durable handoff being delivered, or a build reconnecting.
They do not impersonate Roster or another node in conversational prose.

Low-value telemetry such as every tool invocation, lease renewal, receipt, or
token update stays out of the timeline. It remains inspectable in Workbench.

### Agent-to-agent conversation

A handoff appears as an authored message from the sending node addressed to the
receiving node. The accepted semantic summary is the message body. When the
receiving node starts, its model-authored acknowledgement appears as that
node's next live message. Review feedback and resolutions follow the same
pattern.

If authored content is unavailable, the UI renders a neutral system event. It
must never fabricate natural-language acknowledgement or introduce a team
member with deterministic first-person copy.

### Live work and streaming

Each active node has at most one replaceable live message per task. Partial
model output updates inside that row instead of adding a new bubble for every
chunk. The row displays:

- the participant identity;
- a small `Live` indicator and activity dot;
- the latest bounded authored text;
- an optional compact action such as `View work` or `Answer`.

Durable accepted output supersedes its corresponding ephemeral row without
duplicating the message. If the user has scrolled upward, incoming updates do
not steal scroll position; a `New messages` affordance returns to the live
edge. Reduced-motion mode removes pulsing or animated dots.

### Work summaries in chat

Starting a multi-node run creates one compact system row and then the actual
participant messages. A compact inline work summary may show overall state and
progress, but it is never a large dashboard banner. Expanding or selecting it
opens Workbench on the Work tab.

Completion appears as an authored final response followed by a concise outcome
row containing validation state and the primary next action. Large plans,
reports, and diffs do not expand inline by default.

### Empty room

An empty room shows a compact welcome block anchored near the start of the
timeline, not a full-page marketing layout. It includes:

- the room name and a one-sentence explanation;
- visible participants;
- three small prompt suggestions such as Understand, Plan, and Fix;
- focus on the composer.

Suggested prompts are ordinary buttons or pills, not a two-column grid of
large cards. Sending one creates a real user message through the normal
conversation path.

## Composer

The composer is sticky at the bottom of the center column with 16–20 pixels of
outer inset. It spans the usable conversation width and starts at roughly 76
pixels tall. It contains:

- one auto-growing textarea;
- attachment and tool actions grouped at the lower left;
- routing or selected-recipient context shown as a compact chip only when
  relevant;
- one clear send button at the lower right;
- keyboard help that does not compete with the input.

Enter sends and Shift+Enter inserts a line break. While a request is running,
the user may add context; the composer must not imply that only one turn can
exist. Disabled, disconnected, or decision-required states explain the reason
in a nearby status line. Draft text survives Workbench toggles, reconnects, and
stale-build notices.

## Visual System

Roster keeps its dark green identity with the following hierarchy:

- near-black neutral canvas for the conversation;
- slightly warmer/darker rail;
- one raised neutral for hover, selected rows, composer, and disclosures;
- bright green reserved for primary actions, active presence, selection, and
  successful state;
- amber for waiting or attention;
- red for failed or destructive state;
- muted blue only where an informational distinction is needed.

The visual system uses an 8-pixel spacing rhythm, compact 6–10 pixel control
radii, and 10–12 pixel overlay radii. The full application frame has no radius.
Borders are reserved for region boundaries, inputs, and meaningful containment;
ordinary messages rely on spacing.

Typography uses the platform UI font for product copy and monospace only for
paths, branches, commands, IDs, and code. Primary room text is 14 pixels;
headers are 13–16 pixels depending on hierarchy; tertiary operational metadata
does not fall below a legible 11 pixels.

All interactive controls use real semantic elements, visible focus treatment,
tooltips or labels for icon-only actions, and bounded transitions that honor
reduced-motion preferences. Long paths, names, models, and branch labels use
safe truncation without expanding the layout.

## Responsive Behavior

### 900–1179 pixels

The rail remains visible at 220–240 pixels. Workbench becomes an overlay drawer
over the right side of the conversation with a scrim, focus containment, Escape
to close, and focus restoration to its toggle.

### Below 900 pixels

The rail becomes a drawer opened from the room header. Workbench remains an
independent overlay. Only one overlay may be open at a time. The conversation
and composer use the full viewport width.

### Below 640 pixels

Header actions collapse to icon controls with accessible labels. Participant
avatars reduce to a bounded stack. Composer controls wrap without covering the
send button. Touch targets are at least 44 pixels where coarse input is likely.

## Loading, Failure, And Recovery

- Loading uses skeleton rows shaped like real messages rather than a blank
  dashboard.
- Disconnection preserves the timeline and draft, labels live updates as
  paused, and offers a bounded reconnect action.
- Startup and SpacetimeDB failures render a short human explanation with Retry,
  Diagnostics, and Copy details actions; raw stack traces remain collapsed.
- A run that cannot select a capable node names the missing capability and
  opens Team in Workbench so the user can resolve it. It does not emit a fake
  conversational response.
- A failed task leaves accepted messages and artifacts in place and appends one
  concise attention event with Retry and Narrow request actions.
- A stale build shows one unobtrusive reload banner while preserving the draft.
- Empty, loading, waiting, failed, complete, and merged states retain the same
  shell so the product never appears to switch between UI generations.

## Onboarding And Review

### Onboarding

Onboarding uses the same full-height product shell and visual tokens as the
room. Repository selection, detected team confirmation, and first-room creation
form a short sequential setup. A workspace preview may be shown, but it cannot
overlap setup controls or become a floating application mockup that covers the
page.

### Review

Review remains a dedicated route for large diffs. It uses the same compact app
chrome, rail tone, typography, and controls. The main region is an efficient
file rail plus diff viewer, with validation and integration actions in a stable
toolbar. Returning to chat preserves the room scroll position and draft.

## Architecture And Data Flow

The redesign is a projection refactor, not an orchestration rewrite.

1. Existing room, node, conversation, task, artifact, review, and delivery
   projections remain authoritative.
2. A browser-safe social-row projector maps durable messages, accepted authored
   summaries, neutral lifecycle events, and bounded live room updates into one
   ordered conversation model.
3. Server rendering and realtime reconciliation use the same row identity,
   grouping, chronology, and deduplication rules.
4. The client updates bounded islands for new rows, live row replacement,
   participant presence, room state, unread state, and Workbench panels.
5. Presentation state such as an open Workbench tab may live in the URL or
   local browser preference. It never becomes execution authority.

Expected implementation boundaries are:

- `src/views/agent-shell.ts` for shared application-frame primitives;
- `src/views/coding.ts` for Coding composition and bounded server renderers;
- `src/browser/coding-client.ts` and the existing social/progress projectors
  for reconciliation and interaction;
- theme tokens and scoped Coding CSS for the visual system;
- desktop staging and asset fingerprint paths for one observable build;
- focused view, projection, client, staging, and accessibility tests.

If a required conversation cannot be proven from public authored projections,
implementation must preserve a neutral event or revise the data contract. It
must not derive identity, delivery, or acceptance authority from DOM state.

## Verification Strategy

Implementation is verified in layers:

1. focused pure tests for social-row ordering, grouping, live replacement,
   deduplication, and authored-vs-system provenance;
2. view tests for semantic landmarks, one composer, one conversation, drawer
   state, empty states, errors, and review links;
3. client tests for streaming replacement, scroll anchoring, drafts, keyboard
   interactions, overlays, and URL state;
4. desktop and web build-fingerprint tests proving both serve the same UI;
5. browser inspection at wide desktop, compact desktop, tablet, and narrow
   mobile widths;
6. an actual multi-node run showing live authored progress, a durable handoff,
   receiving-node acknowledgement, review feedback, failure recovery, and one
   final answer;
7. repository-wide `npm run verify`.

Visual QA must capture and compare at least:

- onboarding before repository selection;
- empty room;
- natural human/node conversation;
- active multi-node run with streaming messages;
- Workbench open on every tab;
- waiting-for-user and failed states;
- completed run with review entry point;
- diff review;
- 1440×900, 1180×800, 900×760, and 390×844 viewports.

## Acceptance Criteria

- Coding fills the desktop window without a centered outer card or unused
  page-level gutters.
- At normal desktop width, the rail is compact, conversation is dominant, and
  Workbench opens as a right drawer without replacing chat.
- The empty room looks intentional and useful rather than unfinished.
- Messages have recognizable Slack-like density, grouping, hierarchy, and
  participant identity.
- A multi-node run reads as a chronological conversation among named nodes,
  including live model-authored progress and explicit addressed handoffs.
- No hardcoded first-person agent message, acknowledgement, introduction, or
  progress response is presented as model-authored speech.
- Detailed work remains inspectable without flooding the conversation.
- Composer, room position, and drafts survive Workbench toggles, reconnects,
  and review navigation.
- Desktop and web cannot silently serve different Coding builds.
- Keyboard, screen-reader, focus, reduced-motion, overflow, and responsive
  behavior meet the stated requirements.
- The visual QA matrix passes and `npm run verify` succeeds.

