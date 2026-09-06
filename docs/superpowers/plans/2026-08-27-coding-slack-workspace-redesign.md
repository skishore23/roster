# Coding Slack Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the framed Coding dashboard with a full-window Slack-like repository workspace whose real node messages, live updates, handoffs, Workbench, onboarding, errors, and review flow feel like one polished product.

**Architecture:** Keep the current server-rendered routes, durable `WorkspaceNode` identities, social-row projector, realtime streams, and build fingerprint as authority. Extract the final Coding visual contract into a focused style module, simplify `coding.ts` into a 240px rail plus full-width conversation plus 336px drawer, and let browser code mutate only presentation state and bounded realtime islands.

**Tech Stack:** TypeScript, server-rendered HTML, scoped CSS, browser DOM APIs, Node test runner, esbuild, Tauri/Vite, SpacetimeDB projections.

**Spec:** `docs/superpowers/specs/2026-08-27-coding-slack-workspace-redesign.md`

## Global Constraints

- Preserve the canonical `WorkspaceNode` identity and the v2 node-only orchestration contract.
- Do not derive identity, delivery, task acceptance, artifact acceptance, or topology authority from DOM state.
- Keep Roster's dark green identity; reserve bright green for primary action, selection, presence, progress, and successful state.
- Use a 240px desktop rail, a 56px room header, a 336px desktop Workbench drawer, a 32px message avatar, and 14px message copy.
- At 900–1179px Workbench is an overlay; below 900px both rail and Workbench are mutually exclusive overlays; below 640px touch targets are at least 44px.
- Do not place Coding inside a rounded outer shell or page-level gutter.
- Do not hardcode first-person agent introductions, acknowledgements, progress, review, or final responses.
- Model-authored live rows stay ephemeral; accepted summaries and durable messages remain authoritative and replayable.
- Keep exactly one conversation timeline and one composer per room.
- Desktop and web must expose the same Coding build fingerprint.
- Preserve unrelated worktree changes and finish with `npm run verify`.

## File Map

- Create `src/views/coding-workspace-style.ts`: final frame, rail, conversation, message, Workbench, composer, and responsive CSS contract.
- Create `tests/smoke/coding-workspace-style.test.ts`: focused layout-token and anti-regression assertions independent of the large route fixture.
- Modify `src/views/coding.ts`: shell composition, rail/header/empty room, social message markup, Workbench panels, composer, recovery rows, and review styling hookup.
- Modify `src/browser/coding-client.ts`: live-row reconciliation, scroll anchoring, composer draft, and responsive overlay state.
- Modify `src/browser/coding-social-transcript.ts`: only if a missing presentation field is proven by a failing social-row test; do not change durable authority.
- Modify `tests/smoke/coding-demo.test.ts`: rendered Coding contracts and real authored conversation fixtures.
- Modify `tests/smoke/coding-social-transcript.test.ts`: authored-vs-system provenance, handoff, acknowledgement, and deduplication.
- Modify `tests/deterministic/coding-scroll-anchor.test.ts`: live-edge and new-message behavior.
- Modify `apps/desktop/index.html`: onboarding shell and bounded runtime-error panel.
- Modify `apps/desktop/src/styles.css`: full-height non-overlapping onboarding and error treatment.
- Modify `apps/desktop/src/main.ts`: runtime error presentation, retry, and copy-details behavior.
- Modify `apps/desktop/tests/config.test.mjs`: onboarding, no-fake-chat, and recovery contracts.
- Modify `tests/smoke/coding-build-consistency.test.ts`: final desktop/web fingerprint guard.

---

### Task 1: Establish One Full-Window Visual Contract

**Files:**
- Create: `src/views/coding-workspace-style.ts`
- Create: `tests/smoke/coding-workspace-style.test.ts`
- Modify: `src/views/coding.ts:3377-3603`
- Modify: `src/views/coding.ts:4702-4755`
- Modify: `tests/smoke/coding-demo.test.ts:500-520`
- Modify: `tests/smoke/coding-demo.test.ts:3280-3325`

**Interfaces:**
- Consumes: theme variables from `agentWorkspaceThemeTokens` and the existing Coding class/data attributes.
- Produces: `codingSlackWorkspaceCss: string`, the only final layout override appended by `codingShell`.

- [ ] **Step 1: Write the failing style-module test**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { codingSlackWorkspaceCss } from "../../src/views/coding-workspace-style.ts";

test("Coding uses one full-window Slack workspace contract", () => {
  assert.match(codingSlackWorkspaceCss, /--coding-rail-width:240px/);
  assert.match(codingSlackWorkspaceCss, /--coding-workbench-width:336px/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page \.coding-workbench\{[^}]*height:100dvh[^}]*padding:0/);
  assert.match(codingSlackWorkspaceCss, /grid-template-columns:var\(--coding-rail-width\) minmax\(0,1fr\)/);
  assert.match(codingSlackWorkspaceCss, /\.coding-page \.coding-conversation\{[^}]*border-radius:0/);
  assert.doesNotMatch(codingSlackWorkspaceCss, /padding:8px 8px 8px 0/);
  assert.doesNotMatch(codingSlackWorkspaceCss, /--workspace-rail-width:274px/);
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-workspace-style.test.ts
```

Expected: FAIL because `src/views/coding-workspace-style.ts` does not exist.

- [ ] **Step 3: Create the style module with the exact frame geometry**

```ts
export const codingSlackWorkspaceCss = `
:root{--coding-rail-width:240px;--coding-workbench-width:336px;--coding-room-header-height:56px}
.coding-page.agent-app{height:100dvh;display:block;overflow:hidden;background:var(--surface-sidebar)}
.coding-page>.agent-top-nav{display:none}
.coding-page .agent-main{width:100%;height:100dvh;min-height:0;padding:0;background:var(--surface-sidebar)}
.coding-page .coding-workbench{height:100dvh;min-height:0;display:grid;grid-template-columns:var(--coding-rail-width) minmax(0,1fr);padding:0;background:var(--surface-sidebar)}
.coding-page .coding-project-rail{min-width:0;border-right:1px solid var(--border-subtle);background:var(--surface-sidebar)}
.coding-page .coding-conversation{min-width:0;height:100%;display:grid;grid-template-columns:minmax(0,1fr) var(--coding-workbench-width);grid-template-rows:minmax(0,1fr) auto;overflow:hidden;border:0;border-radius:0;background:var(--surface-canvas);box-shadow:none}
:root[data-coding-context-cast="closed"] .coding-page .coding-conversation{grid-template-columns:minmax(0,1fr) 0}
.coding-page .coding-conversation-scroll{min-width:0;min-height:0;grid-column:1;grid-row:1;overflow:auto;overscroll-behavior:contain}
.coding-page .coding-composer-wrap{min-width:0;grid-column:1;grid-row:2}
.coding-page .coding-context-cast[data-layout="rail"]{width:var(--coding-workbench-width);grid-column:2;grid-row:1/-1}
@media(max-width:1179px){.coding-page .coding-context-cast[data-layout="rail"]{position:absolute;z-index:40;inset:0 0 0 auto;width:min(var(--coding-workbench-width),calc(100vw - 32px));box-shadow:var(--shadow-overlay)}}
@media(max-width:899px){:root{--coding-rail-width:0px}.coding-page .coding-workbench{grid-template-columns:minmax(0,1fr)}.coding-page .coding-project-rail{position:absolute;z-index:50;inset:0 auto 0 0;width:min(240px,calc(100vw - 48px))}}
@media(prefers-reduced-motion:reduce){.coding-page *{scroll-behavior:auto!important;animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}
`;
```

- [ ] **Step 4: Replace the competing final overrides in `coding.ts`**

Add the import:

```ts
import { codingSlackWorkspaceCss } from "./coding-workspace-style.js";
```

Delete `codingDesktopShellCss` and `codingSocialRoomCss`. Replace their final interpolations with:

```ts
${codingWorkspaceCss}
${codingSlackWorkspaceCss}
${codingBrandThemeCss}
```

Replace assertions for the 274px rail, 8px page padding, rounded conversation, and 920px stacked Workbench with assertions for `codingSlackWorkspaceCss` and the new data layout.

- [ ] **Step 5: Run the focused shell tests**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/smoke/coding-workspace-style.test.ts \
  tests/smoke/coding-demo.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the frame contract**

```bash
git add src/views/coding-workspace-style.ts src/views/coding.ts tests/smoke/coding-workspace-style.test.ts tests/smoke/coding-demo.test.ts
git commit -m "refactor(coding): establish full-window workspace frame"
```

### Task 2: Make the Rail, Header, and Empty Room Feel Like Slack

**Files:**
- Modify: `src/views/coding.ts:740-960`
- Modify: `src/views/coding.ts:2349-2420`
- Modify: `src/views/coding.ts:2694-2725`
- Modify: `src/views/coding.ts:4640-4665`
- Modify: `src/views/coding-workspace-style.ts`
- Modify: `tests/smoke/coding-demo.test.ts:330-410`
- Modify: `tests/smoke/coding-demo.test.ts:7450-7480`

**Interfaces:**
- Consumes: `codingProjectRailHtml`, `codingRoomProjection`, `projectRoomRoster`, and current room/run projections.
- Produces: `data-layout="slack-workspace"`, compact selected-room rows, one 56px room header, and `data-room-empty` with real prompt submission.

- [ ] **Step 1: Add failing semantic and anti-dashboard assertions**

```ts
assert.match(shell, /data-workspace-shell[^>]*data-layout="slack-workspace"/);
assert.match(shell, /data-slot="workspace-rail"[^>]*aria-label="Repository rooms and team"/);
assert.match(shell, /data-slot="room-header"/);
assert.match(shell, /data-room-empty/);
assert.match(shell, /data-room-suggestion="understand"/);
assert.equal((shell.match(/data-slot="room-header"/g) ?? []).length, 1);
assert.doesNotMatch(shell, /class="coding-titlebar-breadcrumb"/);
assert.doesNotMatch(shell, /coding-starter-actions[^>]*>[\s\S]*grid-template-columns:repeat\(2/);
```

- [ ] **Step 2: Run the route test and verify the new layout and empty-state assertions fail**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts
```

Expected: FAIL on `slack-workspace`, empty-room markup, or duplicate breadcrumb removal.

- [ ] **Step 3: Simplify the top-level shell and rail markup**

Change the shell opening to:

```ts
<section class="coding-workbench" aria-label="Coding workspace"
  data-workspace-shell data-layout="slack-workspace" data-slot="workspace-shell">
```

Render repository identity only in `codingProjectRailHtml`. Remove the workspace `toolbar` construction, pass `chromeHtml: ""` to `agentShellFrameHtml`, and place the existing command trigger inside the room header action group so the top-level navigation no longer creates a second breadcrumb row.

Give room rows one state label:

```ts
const roomSummary = attention
  ? attention.kind === "merge-ready" ? "Complete" : "Waiting for you"
  : continuity?.lane.active
    ? "Working"
    : run && ["queued", "leased", "running"].includes(run.status)
      ? "Working"
      : run?.status === "completed"
        ? "Complete"
        : room.state === "waiting"
          ? "Waiting for you"
          : room.messageCount > 0
            ? `${room.messageCount} messages`
            : "New room";
```

- [ ] **Step 4: Render the empty room as a compact welcome row**

When `codingSocialProjection(options).length === 0`, prepend this list item inside the existing transcript:

```ts
const empty = rows.length === 0 ? `<li class="coding-room-empty" data-room-empty>
  <span class="coding-room-empty-mark" aria-hidden="true">R</span>
  <div><h3>Start in #${esc(roomName)}</h3><p>Ask the repository team a question or describe the outcome you want.</p>
  <div aria-label="Suggested prompts">
    <button type="button" data-room-suggestion="understand">Understand this repository</button>
    <button type="button" data-room-suggestion="plan">Plan a change</button>
    <button type="button" data-room-suggestion="fix">Fix a problem</button>
  </div></div>
</li>` : "";
```

The suggestion buttons fill the existing composer and submit through the normal user-message path; they do not render agent responses.

- [ ] **Step 5: Add compact rail/header/empty CSS**

Append these contracts to `codingSlackWorkspaceCss`:

```css
.coding-page .coding-workspace-switcher>summary{min-height:48px;padding:6px 12px}
.coding-page .coding-new-room,.coding-page .coding-project-runs a{min-height:34px;border-radius:7px}
.coding-page .coding-room{position:sticky;z-index:20;top:0;min-height:var(--coding-room-header-height);display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;padding:0 20px;border-bottom:1px solid var(--border-subtle);background:color-mix(in srgb,var(--surface-canvas) 94%,transparent);backdrop-filter:blur(16px)}
.coding-page .coding-room-branch,.coding-page .coding-room-kind,.coding-page .coding-room-orb{display:none}
.coding-page .coding-room-empty{display:grid;grid-template-columns:32px minmax(0,1fr);gap:12px;padding:24px 20px;list-style:none}
.coding-page .coding-room-empty h3{margin:0;font-size:16px}.coding-page .coding-room-empty p{margin:4px 0 12px;color:var(--text-secondary);font-size:13px}
.coding-page .coding-room-empty [aria-label="Suggested prompts"]{display:flex;gap:8px;flex-wrap:wrap}
```

- [ ] **Step 6: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-workspace-style.test.ts tests/smoke/coding-demo.test.ts
git add src/views/coding.ts src/views/coding-workspace-style.ts tests/smoke/coding-demo.test.ts
git commit -m "refactor(coding): simplify rooms and empty state"
```

### Task 3: Render Real Node Work as Dense Natural Conversation

**Files:**
- Modify: `src/views/coding.ts:2632-2725`
- Modify: `src/views/coding-workspace-style.ts`
- Modify: `src/browser/coding-client.ts:1942-2285`
- Modify: `tests/smoke/coding-social-transcript.test.ts`
- Modify: `tests/smoke/coding-demo.test.ts:6660-6740`
- Modify: `tests/smoke/coding-demo.test.ts:7000-7070`

**Interfaces:**
- Consumes: `CodingSocialRow`, `projectCodingSocialRows`, `upsertCodingSocialRows`, and bounded `NodeRoomUpdate` records.
- Produces: one `data-message-group` per chronological group, authored node handoffs/replies, neutral system rows, and in-place live message replacement.

- [ ] **Step 1: Add failing provenance and message-anatomy assertions**

```ts
const authored = projectCodingSocialRows(fixture());
assert.equal(authored.find((row) => row.sourceKind === "accepted-summary")?.author.nodeId, "kai");
assert.equal(authored.find((row) => row.intent === "acknowledgement")?.author.nodeId, "mira");
assert.equal(authored.find((row) => row.sourceKind === "system-activity")?.author.nodeId, "roster");

assert.match(html, /data-coding-social-row[^>]*data-message-group="start"/);
assert.match(html, /data-coding-social-row[^>]*data-message-group="continuation"/);
assert.match(html, /data-source-kind="live-update"[^>]*aria-live="polite"/);
assert.doesNotMatch(html, /I’m joining as|I’m ready to implement|Started the assigned repository step/);
```

- [ ] **Step 2: Run the social and route tests**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/smoke/coding-social-transcript.test.ts \
  tests/smoke/coding-demo.test.ts
```

Expected: FAIL because message grouping is not exposed by `data-message-group` and old presentation copy may still be asserted.

- [ ] **Step 3: Make `codingSocialRowHtml` expose one Slack-like row contract**

Use the existing `row.cluster` and provenance fields directly:

```ts
<article class="coding-social-row${continuation ? " coding-social-row-continuation" : ""}"
  data-coding-social-row
  data-message-group="${row.cluster}"
  data-source-kind="${esc(row.sourceKind)}"
  data-author-node-id="${esc(row.author.nodeId)}"
  data-durability="${esc(row.durability)}"
  data-state="${esc(row.state)}">
```

Show role and time only on a group start; keep an accessible author label on continuations. Render addressed recipients on the same metadata line. Keep `Details` keyboard-reachable but reveal it visually only on row hover/focus.

- [ ] **Step 4: Keep live text inside the same logical row**

In `codingSocialRowElement`, set the same grouping and state attributes as server rendering and update the existing row selected by `data-row-id` rather than appending when `upsertCodingSocialRows` returns the same logical node/task row:

```ts
element.dataset.messageGroup = row.cluster;
element.dataset.sourceKind = row.sourceKind;
element.dataset.authorNodeId = row.author.nodeId;
element.dataset.durability = row.durability;
element.dataset.state = row.state;
if (row.state === "live") {
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "true");
}
```

Do not convert runtime logs or task labels into message text.

- [ ] **Step 5: Replace card styling with row density**

Append this exact geometry:

```css
.coding-page [data-coding-room-transcript]{width:100%;max-width:none;margin:0;padding:12px 0 24px;list-style:none}
.coding-page .coding-social-row{width:100%;display:grid;grid-template-columns:32px minmax(0,1fr);gap:10px;padding:5px 20px}
.coding-page .coding-social-row:hover,.coding-page .coding-social-row:focus-within{background:var(--surface-hover)}
.coding-page .coding-social-row .coding-message-avatar{width:32px;height:32px;border-radius:7px}
.coding-page .coding-social-row-continuation{padding-top:2px}.coding-page .coding-social-row-continuation .coding-message-avatar{visibility:hidden}
.coding-page .coding-message-meta{min-height:18px;display:flex;align-items:baseline;gap:6px}
.coding-page .coding-message-meta strong{font-size:13px}.coding-page .coding-message-meta>span,.coding-page .coding-message-meta time{font-size:11px}
.coding-page .coding-social-row .coding-message-body{max-width:880px;margin-top:2px;font-size:14px;line-height:1.45}
.coding-page .coding-message-evidence>summary{opacity:0}.coding-page .coding-social-row:hover .coding-message-evidence>summary,.coding-page .coding-social-row:focus-within .coding-message-evidence>summary{opacity:1}
```

- [ ] **Step 6: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-social-transcript.test.ts tests/smoke/coding-demo.test.ts
git add src/views/coding.ts src/views/coding-workspace-style.ts src/browser/coding-client.ts tests/smoke/coding-social-transcript.test.ts tests/smoke/coding-demo.test.ts
git commit -m "refactor(coding): present node work as natural chat"
```

### Task 4: Collapse Operational Detail into a Four-Tab Workbench Drawer

**Files:**
- Modify: `src/views/coding.ts:3046-3105`
- Modify: `src/views/coding.ts:4170-4450`
- Modify: `src/views/coding-workspace-style.ts`
- Modify: `tests/smoke/coding-demo.test.ts:360-390`
- Modify: `tests/smoke/coding-demo.test.ts:3300-3320`

**Interfaces:**
- Consumes: existing plan, Git handoff, artifacts, live team, frontier, and execution-detail projections.
- Produces: Work, Files, Team, Details tabs; URL values `work|files|team|details`; desktop non-modal drawer and responsive modal overlay.

- [ ] **Step 1: Write failing four-tab assertions**

```ts
assert.deepEqual(
  [...html.matchAll(/data-coding-workbench-tab="([^"]+)"/g)].map((match) => match[1]),
  ["work", "files", "team", "details"],
);
for (const panel of ["work", "files", "team", "details"]) {
  assert.match(html, new RegExp(`data-workbench-panel="${panel}"`));
}
assert.doesNotMatch(html, /data-coding-workbench-tab="changes"/);
assert.doesNotMatch(html, /data-coding-workbench-tab="artifacts"/);
```

- [ ] **Step 2: Run the route test and verify the current five-tab contract fails**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts
```

- [ ] **Step 3: Recompose the existing content into four panels**

Use these exact panel responsibilities:

```ts
const workPanel = `${codingCoordinationDockHtml(options)}`;
const filesPanel = `${codingGitHandoffHtml(options)}${artifacts}`;
const teamPanel = `${liveRunHtml(options)}${codingTeamActivityHtml()}<ul class="coding-realtime-cast" data-realtime-cast data-slot="cast-list" aria-label="Room cast"></ul>`;
const detailsPanel = `${frontier}${operations}`;
```

Change `defaultTab` to `"files"` for ready/blocked delivery, `"work"` for an active task graph, and `"team"` otherwise. Change keyboard shortcuts to Alt+1 through Alt+4.

Render one overlay dismiss control after Workbench for responsive use:

```html
<button class="coding-overlay-scrim" type="button" aria-label="Close Workbench" data-coding-overlay-scrim hidden></button>
```

- [ ] **Step 4: Update the Workbench state machine**

Replace the tab list in the inline client with:

```js
const workbenchTabs=['work','files','team','details'];
```

At desktop widths, opening Workbench does not trap focus. Under `matchMedia('(max-width: 1179px)')`, opening adds `data-overlay-open="workbench"`, focuses the close button, closes on Escape, and restores the toggle. Under 900px, opening Workbench first closes the workspace rail.

- [ ] **Step 5: Add continuous drawer styling and overlays**

```css
.coding-page .coding-context-cast[data-layout="rail"]{height:100%;overflow:hidden;border-left:1px solid var(--border-subtle);background:var(--surface-sidebar)}
.coding-page .coding-room-context-head{height:56px;padding:0 12px;border-bottom:1px solid var(--border-subtle)}
.coding-page .coding-workbench-tabs{height:40px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--border-subtle)}
.coding-page .coding-workbench-tab{min-width:0;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent}
.coding-page .coding-workbench-tab[aria-selected="true"]{border-bottom-color:var(--accent);background:var(--surface-hover)}
.coding-page .coding-workbench-panel{height:calc(100% - 96px);overflow:auto;padding:12px}
.coding-page .coding-workbench-panel>*{border-radius:0;box-shadow:none}
.coding-page [data-coding-overlay-scrim]{position:absolute;z-index:35;inset:0;background:rgba(0,0,0,.48)}
```

- [ ] **Step 6: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-workspace-style.test.ts tests/smoke/coding-demo.test.ts
git add src/views/coding.ts src/views/coding-workspace-style.ts tests/smoke/coding-demo.test.ts
git commit -m "refactor(coding): make Workbench a supporting drawer"
```

### Task 5: Make the Composer and Live Edge Feel Continuous

**Files:**
- Modify: `src/views/coding.ts:3211-3300`
- Modify: `src/views/coding.ts:4000-4100`
- Modify: `src/browser/coding-client.ts:1031-1165`
- Modify: `src/browser/coding-client.ts:2190-2285`
- Modify: `src/views/coding-workspace-style.ts`
- Modify: `tests/deterministic/coding-scroll-anchor.test.ts`
- Modify: `tests/smoke/coding-demo.test.ts:7450-7480`

**Interfaces:**
- Consumes: existing form fields, attachments, mentions, review policy, `restoredScrollTop`, and `upsertCodingSocialRows`.
- Produces: one sticky 76px+ composer, durable draft preservation, non-jumping live updates, and a `New messages` live-edge control.

- [ ] **Step 1: Add failing composer and scroll assertions**

```ts
assert.equal((shell.match(/data-slot="workspace-composer"/g) ?? []).length, 1);
assert.equal((shell.match(/data-coding-composer-input/g) ?? []).length, 1);
assert.match(shell, /data-coding-composer-draft/);
assert.match(shell, /data-coding-new-messages/);
assert.match(shell, /Add context while the team works/);
assert.doesNotMatch(shell, /\.coding-composer-help\{display:none\}/);
```

Add a scroll-anchor case asserting that an incoming row while `distanceFromBottom > threshold` preserves the current top and increments the unread count instead of following the end.

- [ ] **Step 2: Run the focused tests**

```bash
node --import tsx --test --test-concurrency=1 tests/deterministic/coding-scroll-anchor.test.ts tests/smoke/coding-demo.test.ts
```

Expected: FAIL on draft markup or the new away-from-bottom assertion.

- [ ] **Step 3: Add stable draft identity and keep messaging enabled during work**

Add the conversation-specific draft key to the form:

```ts
data-coding-composer-draft="${esc(options.runId ?? options.workspaceId ?? "repository")}" 
```

Keep the textarea enabled for active work, keep the active placeholder `Add context while the team works…`, and keep tools secondary. Store draft text under `roster.coding.draft.v1:<identity>` on input, clear it only after a successful send, and restore it after Workbench toggles, reconnects, and review return.

- [ ] **Step 4: Preserve live-edge position**

Preserve the current 80px live-edge and visible-row anchor sequence while adding draft behavior:

```ts
const bottomDistance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
const followEnd = bottomDistance <= 80;
const viewportTop = scroller.getBoundingClientRect().top;
const anchor = followEnd ? undefined : [...feed.children]
  .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement)
  .find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop + 1);
const anchorOffset = anchor?.getBoundingClientRect().top;
if (followEnd) scroller.scrollTop = scroller.scrollHeight;
else if (anchor?.isConnected && anchorOffset !== undefined) {
  scroller.scrollTop += anchor.getBoundingClientRect().top - anchorOffset;
}
updateNewSocialMessageCount(newRows, followEnd);
```

The `New messages` button scrolls to the end, resets its count, and returns focus to the timeline without moving focus into a new message.

- [ ] **Step 5: Apply full-width compact composer CSS**

```css
.coding-page .coding-composer-wrap{width:100%;padding:8px 20px max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--border-subtle);background:var(--surface-canvas)}
.coding-page .coding-composer-grid{width:100%;max-width:none;margin:0}
.coding-page .coding-composer{min-height:76px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:10px;background:var(--surface-raised);box-shadow:none}
.coding-page .coding-composer textarea{min-height:34px;max-height:180px;padding:4px 2px;font-size:14px;line-height:1.45}
.coding-page .coding-composer-help{display:flex;margin:5px 2px 0;font-size:11px}
.coding-page .coding-new-messages{position:absolute;z-index:25;right:20px;bottom:104px}
@media(max-width:639px){.coding-page .coding-composer-wrap{padding-inline:12px}.coding-page .coding-composer :is(button,summary){min-height:44px}}
```

- [ ] **Step 6: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/deterministic/coding-scroll-anchor.test.ts tests/smoke/coding-demo.test.ts
git add src/views/coding.ts src/views/coding-workspace-style.ts src/browser/coding-client.ts tests/deterministic/coding-scroll-anchor.test.ts tests/smoke/coding-demo.test.ts
git commit -m "refactor(coding): connect composer to the live conversation"
```

### Task 6: Turn Failures and Missing Capabilities into Recoverable UI

**Files:**
- Modify: `src/views/coding.ts:1632-1865`
- Modify: `src/views/coding-workspace-style.ts`
- Modify: `tests/smoke/coding-demo.test.ts`
- Modify: `apps/desktop/index.html`
- Modify: `apps/desktop/src/main.ts:30-360`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/tests/config.test.mjs`

**Interfaces:**
- Consumes: `CodingConversationRoute.tags`, `CodingHumanAction`, bounded native startup error text, and the existing retry route.
- Produces: Team-targeted capability recovery, compact inline run recovery, and a desktop startup error panel with retry and collapsed diagnostics.

- [ ] **Step 1: Add failing capability and startup-error assertions**

```ts
assert.match(reviewUnavailableHtml, /data-state="requested"/);
assert.match(reviewUnavailableHtml, /data-coding-workbench-shortcut="team"/);
assert.doesNotMatch(reviewUnavailableHtml, /Stopped before the first step[\s\S]*Retry Run/);

assert.match(onboardingHtml, /data-runtime-error[^>]*hidden/);
assert.match(onboardingHtml, /data-retry-runtime/);
assert.match(onboardingHtml, /data-copy-runtime-error/);
assert.match(onboardingHtml, /<details[^>]*data-runtime-diagnostics/);
```

- [ ] **Step 2: Run the route and desktop tests**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts
npm --prefix apps/desktop test
```

Expected: FAIL on the Team shortcut and desktop runtime-error panel.

- [ ] **Step 3: Make reviewer-unavailable clarification point to Team**

Extend the clarification variant:

```ts
| {
    readonly kind: "clarification";
    readonly rationale: string;
    readonly questions: CodingConversationRoute["questions"];
    readonly target?: "team";
  }
```

Project the typed target from the existing route tag:

```ts
return {
  kind: "clarification",
  rationale: "Roster needs a bounded product decision before work can start.",
  questions: latestRoute.questions,
  ...(latestRoute.tags.includes("risk:reviewer-unavailable") ? { target: "team" as const } : {}),
};
```

Render `Open Team` with `data-coding-workbench-shortcut="team"` before the Reply action when `target === "team"`.

- [ ] **Step 4: Add a bounded desktop error surface**

Add this beside the existing status region:

```html
<section class="runtime-error-panel" data-runtime-error hidden aria-labelledby="runtime-error-title">
  <header><span><small>Local runtime</small><strong id="runtime-error-title">Roster couldn’t open this workspace.</strong></span></header>
  <p data-runtime-error-summary>Check the local service and try again.</p>
  <div><button type="button" data-retry-runtime>Retry</button><button type="button" data-copy-runtime-error>Copy details</button></div>
  <details data-runtime-diagnostics><summary>Diagnostics</summary><pre data-runtime-error-details></pre></details>
</section>
```

In `main.ts`, `showRuntimeError(error)` puts only the generic explanation in the visible summary and the bounded `errorMessage(error)` in the `<pre>`. Retry calls `launchRosterRuntime`; Copy details writes that bounded text and announces `Diagnostics copied.` through the existing live status.

- [ ] **Step 5: Style errors as inline recovery, not chat**

```css
.runtime-error-panel{margin-top:12px;padding:14px;border:1px solid #6f3932;border-radius:10px;background:#211513}
.runtime-error-panel[hidden]{display:none}.runtime-error-panel p{color:#d9b2aa}
.runtime-error-panel>div{display:flex;gap:8px}.runtime-error-panel button{min-height:40px}
.runtime-error-panel details{margin-top:10px}.runtime-error-panel pre{max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.coding-page .coding-human-action{margin:8px 20px;padding:10px 12px;border-radius:8px}
```

- [ ] **Step 6: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts
npm --prefix apps/desktop test
git add src/views/coding.ts src/views/coding-workspace-style.ts apps/desktop/index.html apps/desktop/src/main.ts apps/desktop/src/styles.css tests/smoke/coding-demo.test.ts apps/desktop/tests/config.test.mjs
git commit -m "fix(coding): make workspace failures recoverable"
```

### Task 7: Replace the Overlapping Onboarding Mockup with the Real Product Language

**Files:**
- Modify: `apps/desktop/index.html`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/tests/config.test.mjs:275-305`

**Interfaces:**
- Consumes: existing repository picker, runtime discovery, launch hooks, and saved setup.
- Produces: one non-overlapping onboarding grid using the same rail/conversation/Workbench hierarchy without fake attributed chat.

- [ ] **Step 1: Replace the old preview test with no-fake-chat and geometry assertions**

```js
assert.match(source, /data-workspace-preview/);
assert.match(source, /data-preview-room-rail/);
assert.match(source, /data-preview-message-skeleton/);
assert.doesNotMatch(source, /data-preview-node-message/);
assert.doesNotMatch(source, /I mapped the main execution path|I’m ready to implement/);
assert.match(styles, /\.onboarding-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*520px\) minmax\(420px,\s*1fr\)/su);
assert.match(styles, /@media\s*\(max-width:\s*980px\)[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
assert.doesNotMatch(styles, /position:\s*(?:absolute|fixed)[^}]*\.workspace-preview/su);
```

- [ ] **Step 2: Run desktop tests and verify the fake preview assertions fail**

```bash
npm --prefix apps/desktop test
```

- [ ] **Step 3: Replace attributed preview messages with neutral structure**

Use two skeleton rows and one neutral activity line:

```html
<div class="preview-thread" aria-label="Conversation preview">
  <div class="preview-message-skeleton" data-preview-message-skeleton aria-hidden="true"><span></span><i></i><b></b></div>
  <p class="preview-activity"><i aria-hidden="true"></i>Live repository work appears here</p>
  <div class="preview-message-skeleton" data-preview-message-skeleton aria-hidden="true"><span></span><i></i><b></b></div>
</div>
```

The preview demonstrates placement only. Detected runtime names may populate the onboarding roster after discovery, but no text is attributed to them.

- [ ] **Step 4: Apply a bounded two-column layout with a single-column fallback**

```css
.shell{width:100%;min-height:100dvh;padding:24px clamp(20px,4vw,64px)}
.onboarding{width:min(1440px,100%);margin:0 auto}
.onboarding-layout{display:grid;grid-template-columns:minmax(0,520px) minmax(420px,1fr);gap:32px;align-items:start}
.setup-column,.workspace-preview{min-width:0}.workspace-preview{position:sticky;top:24px;max-height:calc(100dvh - 48px);overflow:hidden}
@media(max-width:980px){.onboarding-layout{grid-template-columns:minmax(0,1fr)}.workspace-preview{position:static;max-height:none}}
```

Keep the workspace preview fully inside its grid column. Remove negative offsets, transforms that cross the column boundary, and fixed widths larger than the column.

- [ ] **Step 5: Run desktop tests and build**

```bash
npm --prefix apps/desktop test
npm --prefix apps/desktop run build:web
```

- [ ] **Step 6: Commit onboarding**

```bash
git add apps/desktop/index.html apps/desktop/src/styles.css apps/desktop/src/main.ts apps/desktop/tests/config.test.mjs
git commit -m "refactor(desktop): align onboarding with the Coding workspace"
```

### Task 8: Bring Review into the Same Visual Family

**Files:**
- Modify: `src/views/coding.ts:3605-3805`
- Modify: `tests/smoke/coding-demo.test.ts:6280-6380`

**Interfaces:**
- Consumes: parsed diff files, validation state, delivery authority, and integration form.
- Produces: full-window review with a compact 56px toolbar, efficient file rail, readable diff, and one authorized primary action.

- [ ] **Step 1: Add failing review hierarchy assertions**

```ts
assert.match(review, /data-layout="coding-review"/);
assert.match(review, /data-review-primary-action/);
assert.match(review, /aria-label="Changed files"/);
assert.match(review, /data-review-summary/);
assert.match(review, /font-size:12px;line-height:1\.55/);
assert.doesNotMatch(review, /border-radius:var\(--radius-overlay\)[^}]*coding-review-page/);
```

- [ ] **Step 2: Run the review fixture**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts
```

- [ ] **Step 3: Refactor review chrome without changing authority**

Set the root to:

```html
<div class="coding-review-page" data-layout="coding-review" data-slot="agent-shell" data-ui-family="roster-agent">
```

Keep Back, title, delivery state, validation summary, file filter, wrap/changes-only controls, Details, and the existing integration form. Add `data-review-primary-action` only to the already-authorized integration form/button. Do not manufacture a merge action when delivery authority is absent.

- [ ] **Step 4: Use the same density and flat frame**

```css
.coding-review-page{height:100dvh;display:grid;grid-template-rows:56px 44px minmax(0,1fr);border-radius:0;background:var(--surface-canvas)}
.coding-review-toolbar{height:56px;padding:0 16px}.coding-review-context{height:44px;padding:0 16px}
.coding-review-workspace{grid-template-columns:240px minmax(0,1fr)}
.coding-review-code{font-size:12px;line-height:1.55}
.coding-review-file-rail a{min-height:36px;padding:7px 10px}
@media(max-width:639px){.coding-review-workspace{grid-template-columns:minmax(0,1fr)}.coding-review-file-rail{display:none}}
```

- [ ] **Step 5: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts
git add src/views/coding.ts tests/smoke/coding-demo.test.ts
git commit -m "refactor(coding): unify review with the room experience"
```

### Task 9: Prove the Real Multi-Node Experience and One Observable Build

**Files:**
- Modify: `tests/smoke/coding-build-consistency.test.ts`
- Modify: `tests/smoke/coding-demo.test.ts`
- Modify: `docs/workspace-nodes.md` only when implementation changes the documented public social-row projection boundary.

**Interfaces:**
- Consumes: the completed shell, real group routing, model-authored room updates, durable accepted summaries, staged desktop runtime, and Coding build manifest.
- Produces: one verified desktop/web revision and captured visual acceptance evidence for every required state.

- [ ] **Step 1: Add final build and authored-chat assertions**

```ts
const html = codingShell(codingShellOptions());
const fingerprint = readCodingBuildManifest().fingerprint;
assert.match(html, new RegExp(`<meta name="roster-coding-build" content="${fingerprint}">`, "u"));
assert.match(await readFile(new URL("../../apps/desktop/scripts/stage-sidecar.mjs", import.meta.url), "utf8"), /coding-build\.json/);
```

In the existing multi-node `coding-demo` fixture, assert the authored room separately:

```ts
assert.match(parallelHtml, /data-source-kind="live-update"[^>]*data-author-node-id="workspace\./);
assert.match(parallelHtml, /data-source-kind="accepted-summary"[^>]*data-author-node-id="workspace\./);
assert.match(parallelHtml, /class="coding-message-recipient">@/);
assert.doesNotMatch(parallelHtml, /data-source-kind="system-activity"[^>]*>[^<]*I(?:’|'| a)m\b/u);
```

- [ ] **Step 2: Run all focused tests and builds**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/smoke/coding-workspace-style.test.ts \
  tests/smoke/coding-social-transcript.test.ts \
  tests/smoke/coding-build-consistency.test.ts \
  tests/smoke/coding-demo.test.ts \
  tests/deterministic/coding-scroll-anchor.test.ts \
  tests/deterministic/coding-progress-updates.test.ts
npm --prefix apps/desktop test
npm --prefix apps/desktop run build:web
npm run build:coding-client
```

Expected: every command PASS.

- [ ] **Step 3: Start the current desktop/web build and verify the fingerprint**

```bash
npm run desktop:dev:local
```

Open the Coding URL reported by the runtime. Confirm the `roster-coding-build` meta value equals `public/assets/coding-build.json` and the desktop staged manifest. A mismatch is a failing acceptance condition, not a visual warning to ignore.

- [ ] **Step 4: Run a real multi-node conversation**

Send these user messages through the normal composer, not test-only fixtures:

```text
Introduce the repository team one by one. Each teammate should answer for themselves.
```

```text
Inspect the architecture in parallel, hand the findings to a reviewer, and summarize the agreed execution path.
```

Verify that participant replies, live updates, addressed handoffs, acknowledgement, review feedback, and final answer come from real model-authored or accepted rows. Verify there is no hardcoded introduction or fallback first-person speech.

- [ ] **Step 5: Capture the visual acceptance matrix**

Using the live browser, inspect and capture:

```text
1440×900  onboarding, empty room, active chat, Workbench Work/Files/Team/Details, complete room, review
1180×800  chat with Workbench open and closed
900×760   overlay Workbench and preserved conversation
390×844   rail drawer, Workbench drawer, composer, long message, error recovery
```

For every capture, reject page-level horizontal scroll, clipped controls, a rounded outer application card, duplicate headers, fake attributed chat, empty side gutters, inaccessible focus, composer overlap, and unsolicited scroll jumps.

- [ ] **Step 6: Run repository verification**

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 7: Audit and commit final acceptance fixes**

```bash
git diff --check
git status --short
git diff --stat
```

Commit only verified final adjustments:

```bash
git add src tests apps/desktop docs/workspace-nodes.md
git commit -m "test(coding): verify Slack workspace experience"
```
