---
name: roster-coordination
description: Interpret a repository-room conversation and propose the smallest bounded Roster execution without taking scheduling or acceptance authority.
---

# Roster coordination

Use this skill only for the tool-free coordination turn that precedes repository
work. Read the complete chronological transcript, the saved roster, repository
facts, product context, and any unresolved collaboration context supplied by
Roster.

## Classify the turn

- Use `informational` for ordinary conversation and questions fully answered by
  the supplied bounded context, such as the current branch or a social reply.
  Answer directly and set `primaryNodeId` and `coordination` to `null`. Normally
  select no nodes. When the human explicitly asks several or all saved agents
  to answer individually in the room, select those exact saved non-human node
  IDs in the requested speaking order; Roster will give each selected
  participant one bounded, sequential reply, and add the explicit
  `routing:participants` tag. Do not select nodes merely to describe,
  summarize, or mention the team.
- Use `investigating` for any read-only repository question that requires
  opening files, searching code, tracing behavior, comparing responsibilities,
  collecting evidence, or otherwise learning facts not already present in the
  supplied context. Select the smallest relevant saved roster, choose one
  repository-capable primary, and set `answer` to `null`. Prefer starting a
  bounded investigation over hedging, guessing, merely proposing coordination,
  or saying that inspection would be required. Detailed architecture,
  implementation explanations, audits, and "find out" requests belong here.
- Use `operational` when the human asks to control the host checkout, running
  process, local server, development build, browser, page refresh, or another
  environment action rather than change tracked repository content. This is a
  direct answer route: select no nodes and set `primaryNodeId` and
  `coordination` to `null`. Honor only host actions explicitly listed as
  available in `runtimeContext.executionAuthority`; when authority is `none`,
  say plainly that this room cannot perform the action and give the smallest
  accurate next step. Never claim the operation ran.
- Use `needs_clarification` only when an actionable repository mutation is
  missing a fact, choice, or authority that would materially change execution.
  Select the saved human participant, select no executable primary, and set
  `primaryNodeId`, `coordination`, and `answer` to `null`.
- Use `ready` for an explicit, bounded repository mutation.
- Use `escalated` for an actionable mutation that crosses multiple saved
  responsibilities, carries meaningful security/data/runtime/release risk, or
  requires the saved dependency closure.
- Use `declined` when the request is unsafe or outside repository-work scope.
  Select no nodes and set `coordination` to `null`.

A short confirmation such as “do it” or “can you do that” inherits the action
from the preceding chronological answer. If that answer proposed pulling the
current checkout, restarting a local process, rebuilding a development server,
or refreshing a browser, keep the follow-up `operational`; do not reinterpret
it as a source-code mutation. If the preceding turn proposed repository
inspection or specialist research, use `investigating` and start it. Mentioning
UI, runtime, build, deployment, or data in an explanation is not itself
cross-boundary repository work. Use `ready` or `escalated` only when the
requested effect is a change to tracked repository content.

## Select the roster

For `ready`, `investigating`, and `escalated`:

1. Choose exactly one saved non-human `primaryNodeId`. For `ready` and
   `escalated`, that node owns mutation and must advertise `implement`. For
   `investigating`, choose the saved specialist best placed to synthesize the
   answer; it needs repository capability but receives no mutation authority.
2. Include that ID in `selectedNodeIds`.
3. Choose only saved nodes whose responsibility, specialization, skills, tools,
   or dependencies are relevant to this exact objective.
4. Honor explicit mentions when safe.
5. Never invent a node ID.

Choose `reviewMode: fast` only for a narrow, low-risk text-only change that
needs no independent reviewer. Otherwise choose `reviewed` and include at least
one distinct saved review-capable node.

Choose `validationScope: repository-wide` for cross-boundary, security,
authorization, data/schema, runtime, dependency, build, release, migration, or
similarly high-impact work. Repository-wide validation requires reviewed mode.
Use `focused` only when the selected surface and expected validation are
genuinely local.

Use `escalated` with `reviewed` and `repository-wide`.

For `informational` and `operational`, include a concise direct `answer`. An
informational multi-participant answer may use it as a short host introduction,
but it must not claim that a participant replied before that reply exists. For
`ready`, `investigating`, and `escalated`, set `answer` to `null`. The
structured route is a coordination decision, not a user-facing completion
message.

## Authority boundary

Return only the requested structured coordination decision. Do not edit files,
invoke tools, create tasks, start a run, create a branch, assign a runtime,
resolve conflicts, accept artifacts, certify work, or claim completion. Roster
validates the proposal and retains all orchestration authority.
