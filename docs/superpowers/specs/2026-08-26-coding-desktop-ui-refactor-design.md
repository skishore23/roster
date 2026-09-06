# Coding Desktop UI Refactor

Date: 2026-08-26
Status: Approved for planning

## Objective

Refactor the complete Coding desktop product into a polished, conversation-first workspace. The interface should make a human feel as though they are working with a small, visible team inside focused repository rooms. Roster's durable nodes, inbox delivery, receipts, artifacts, runtime bindings, and review authority remain unchanged.

The experience keeps Roster's dark green identity, but uses quieter neutral surfaces, more generous spacing, and green only for meaningful presence, progress, and primary actions.

## Scope

The refactor covers:

- desktop onboarding and repository selection;
- workspace and room navigation;
- the room header and participant presence;
- the conversation timeline;
- node handoffs, progress, and attention states;
- the message composer, mentions, images, and run options;
- inline artifacts, outcomes, and review entry points;
- the Workbench context drawer;
- the dedicated code-review experience;
- empty, loading, disconnected, waiting, failed, and completed states;
- keyboard, screen-reader, narrow-window, and reduced-motion behavior;
- focused presentation tests and end-to-end visual verification.

The refactor does not change orchestration schemas, node identity, inbox semantics, room persistence, receipt authority, artifact acceptance, runtime placement, Git integration, or API contracts.

## Product Model

Conversation is the default product surface. Operational machinery is available but secondary.

```text
Workspace
├── Room rail: repositories, rooms, team presence
├── Conversation: people, nodes, progress, artifacts, decisions
└── Workbench: plan, changes, evidence, topology, runtime details
```

A human sends one message in a room. Roster routes it through the existing durable conversation and node inbox contracts. The UI then projects the accepted state as a small number of legible conversational events. Node-to-node delivery appears as an explicit handoff between named participants, while raw tool activity and receipt detail remain collapsed in Workbench.

## Information Architecture

### Application frame

The Coding desktop product uses a full-height shell with three stable regions:

1. A 248-pixel room rail for workspace identity, room search, recent rooms, and the saved team.
2. A flexible conversation region with a readable content measure and a bottom composer.
3. A 360-pixel Workbench drawer that is closed by default and opens without replacing the conversation.

The top product chrome becomes minimal. Repository switching and settings live in the rail; room state and participants live in the room header. Global navigation that is not part of the packaged Coding product remains absent.

On narrow windows, the rail becomes a modal sheet and Workbench becomes an overlay drawer. The conversation and composer always retain the full primary viewport.

### Room rail

The rail presents one clear hierarchy:

- current repository workspace;
- create-room action;
- room search;
- rooms ordered by attention and recency;
- saved team, collapsed by default when space is constrained;
- settings and connection state at the bottom.

Each room row shows a title and one human-readable state such as `Working`, `Waiting for you`, `Complete`, or `3 messages`. Runtime names, internal IDs, and task counts do not compete with the room title.

### Room header

The header shows the room title, a short topic when useful, one status indicator, overlapping participant avatars, and a Workbench toggle. Branch identity is displayed as subdued metadata. The header remains compact and sticky.

### Conversation

The timeline uses four presentation primitives:

- `HumanMessage` for the operator's messages;
- `NodeMessage` for authored node responses and handoffs;
- `ActivityEvent` for routing, work start, progress, waiting, and completion;
- `ArtifactCard` for reports, patches, charts, validation, and accepted outcomes.

Messages use recognizable avatars, names, roles, timestamps, readable 14-pixel body copy, and restrained containers. Consecutive messages from the same participant cluster visually. Mentions, replies, and reactions remain available without dominating the message.

Activity is summarized instead of streamed as internal noise. A running job occupies one compact live row with a spinner, a plain-language status, progress, and an expand action. Failures and human decisions receive stronger but non-alarming attention styling. Node-to-node work is described as a handoff between named participants rather than as a task-graph mutation.

Artifact cards carry a title, short conclusion, provenance, state, and one primary action. The final accepted outcome is visually prominent but remains part of the conversation. Large reports and code diffs open their dedicated surfaces.

### Composer

The composer is the primary action and stays anchored beneath the conversation. It contains one expanding message field, image attachment, `@node` mentions, compact run-policy controls, and one clear send action.

Advanced controls remain collapsed behind a tools button. Enter sends, Shift+Enter creates a line break, Escape closes transient menus, and the composer restores focus after sending. Disabled and offline states explain why sending is unavailable.

### Workbench

Workbench is closed by default. It contains the existing authoritative projections in this order:

1. current plan and progress;
2. changed files and review entry point;
3. accepted artifacts and evidence;
4. team activity and inbox summaries;
5. runtime, receipt, topology, and history disclosures.

Opening or closing Workbench changes presentation only. It cannot accept output, consume inbox items, claim work, or mutate topology.

### Review surface

The review screen keeps the conversation's visual language while optimizing for code. It has a compact return path, delivery state, file rail, readable diff, validation summary, and a single integration action when authorized. Operational metadata moves into a details disclosure. The review remains a separate route so large diffs do not crowd the room.

### Onboarding

Onboarding becomes a short product setup rather than a marketing page. It explains the three actions required to begin: choose a repository, verify the detected team, and open the first room. The existing dark green identity remains, with a real workspace preview and a single dominant call to action.

## Component Boundaries

Shared structural primitives belong in `src/views/agent-shell.ts`. Coding-specific composition and content belong in `src/views/coding.ts`. Client behavior that cannot be expressed with native HTML belongs in `src/browser/coding-client.ts`.

The refactor should extract small render helpers where the current Coding view mixes unrelated concerns. Each helper receives a bounded immutable projection and returns markup for one surface. CSS remains token-driven and scoped under the Roster agent family and Coding page roots.

No component may derive orchestration authority from visual state. Existing server projections remain the source for room, run, node, artifact, and delivery status.

## State And Data Flow

1. Existing server routes assemble the workspace, room, conversation, run, continuity, and artifact projections.
2. Render helpers map those projections into the four conversation primitives and the Workbench panels.
3. The existing client hydrates interactions, subscribes to durable updates, and updates bounded presentation islands.
4. Room links, review links, forms, and progressive enhancement continue to work without relying on client-only state.
5. Browser storage may remember purely presentational preferences such as a closed Workbench, but never authoritative room or execution state.

## Error And Edge States

- An empty workspace explains how to create the first room and focuses the composer.
- A disconnected client keeps existing content visible and labels updates as paused.
- A waiting room places the requested human decision adjacent to the relevant message and in the room row.
- A failed run retains accepted artifacts, names the failed step, and exposes recovery actions without blaming the human.
- A long conversation maintains scroll anchoring and offers a new-message affordance when the user has scrolled upward.
- A large team collapses avatars into a bounded count while preserving an accessible roster.
- Long repository paths, room titles, branch names, and node names truncate visually but remain available to assistive technology or tooltips.

## Accessibility And Motion

- All interactive targets meet a 40-pixel minimum on desktop and 44 pixels for coarse pointers.
- Focus order follows rail, room header, conversation, composer, then Workbench.
- Status changes use bounded `aria-live` regions and do not reread the whole timeline.
- Color is never the only status signal.
- Drawers trap and restore focus where modal; desktop non-modal Workbench does not.
- Motion is limited to state transitions and disabled under reduced-motion preferences.
- Typography and contrast meet WCAG AA targets.

## Testing And Verification

The implementation will add or update focused tests for:

- the stable rail, conversation, context, feed, and composer slots;
- the four conversation presentation primitives;
- default-closed Workbench and accessible toggles;
- room attention, node handoff, progress, artifact, failure, and completion states;
- mention, attachment, send, keyboard, scroll-anchor, and reconnect behavior;
- responsive shell and review-screen landmarks;
- onboarding copy and primary setup action;
- preservation of one composer and one durable conversation per room.

Validation proceeds from targeted view and browser tests to the repository's required `npm run verify`. The final review also includes browser inspection at desktop and narrow widths, checking the complete path from onboarding through an active room, an artifact, Workbench, and code review.

## Acceptance Criteria

- A new user can choose a repository and start the first room without encountering orchestration terminology.
- The center conversation is visually dominant at every supported width.
- A human can identify who is working, what changed, whether action is required, and where the result lives without opening Workbench.
- Node-to-node handoffs are understandable as ordinary team communication.
- Detailed receipts, runtime state, topology, and evidence remain fully inspectable on demand.
- Existing node, inbox, room, artifact, review, and integration contracts remain unchanged.
- Focused tests and `npm run verify` pass.
