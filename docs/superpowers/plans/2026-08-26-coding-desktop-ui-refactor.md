# Coding Desktop UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a polished, dark-green, conversation-first Coding desktop product from onboarding through room work, artifacts, Workbench, and code review.

**Architecture:** Preserve the server-rendered Coding routes and durable node, inbox, room, artifact, receipt, and Git contracts. Refactor the shared shell and Coding markup into explicit presentation primitives, keep the conversation primary, and use the browser client only for progressive enhancement.

**Tech Stack:** TypeScript, server-rendered HTML, scoped CSS, DOM APIs, Node test runner, Tauri/Vite, SpacetimeDB projections.

**Spec:** `docs/superpowers/specs/2026-08-26-coding-desktop-ui-refactor-design.md`

## Global Constraints

- Preserve `WorkspaceNode` identity and the v2 node-only orchestration contract.
- Do not change inbox delivery, room persistence, receipt authority, artifact acceptance, runtime placement, Git integration, or API contracts.
- Keep Roster's dark green identity; reserve green for presence, progress, and primary actions.
- Conversation remains dominant; Workbench is closed by default.
- Keep exactly one durable conversation and one composer per room.
- Preserve unrelated uncommitted work in every touched file.
- Finish with focused browser inspection and `npm run verify`.

## File Map

- `src/views/agent-shell.ts`: shared shell, composer slots, visual tokens, responsive regions.
- `src/views/coding.ts`: room rail/header, messages, activity, artifacts, Workbench, review.
- `src/browser/coding-client.ts`: drawer, composer, focus, scroll, and live-update behavior.
- `apps/desktop/index.html`, `apps/desktop/src/styles.css`: onboarding.
- `tests/smoke/agent-shell.test.ts`, `tests/smoke/coding-demo.test.ts`, `tests/smoke/coding-improvements.test.ts`: rendered contracts.
- `tests/deterministic/coding-progress-updates.test.ts`, `tests/deterministic/coding-scroll-anchor.test.ts`: live behavior.
- `apps/desktop/tests/config.test.mjs`: desktop onboarding contract.

---

### Task 1: Lock the conversation-first shell contract

**Files:**
- Modify: `tests/smoke/agent-shell.test.ts`
- Modify: `src/views/agent-shell.ts`

**Interfaces:**
- Consumes: `agentWorkspaceShellHtml`, `agentComposerHtml`, `agentShellChromeCss`.
- Produces: stable rail, conversation, feed, composer, and default-closed context regions.

- [ ] **Step 1: Add failing hierarchy assertions**

```ts
assert.match(html, /data-workspace-shell[^>]*data-context-open="false"/);
assert.match(html, /data-workspace-region="conversation"[^>]*aria-label="Room conversation"/);
assert.match(html, /data-slot="conversation-feed"/);
assert.match(html, /data-slot="composer-dock"/);
assert.match(html, /data-workspace-region="context"[^>]*hidden/);
assert.equal((html.match(/data-slot="workspace-composer"/g) ?? []).length, 1);
```

- [ ] **Step 2: Run the failing test**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/agent-shell.test.ts
```

Expected: the new conversation label or hidden-context assertion fails.

- [ ] **Step 3: Refactor the shell**

Make `agentWorkspaceShellHtml` emit rail, conversation, and context in that order. Add the `Room conversation` label. Keep context in the DOM but hidden by default. Update `agentShellChromeCss` to use a 248px rail, flexible conversation, independently scrolling feed, docked composer, and overlay rail/context below 820px.

- [ ] **Step 4: Run the test and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/agent-shell.test.ts
git add src/views/agent-shell.ts tests/smoke/agent-shell.test.ts
git commit -m "refactor: make conversation the primary workspace surface"
```

### Task 2: Rebuild the room rail and header

**Files:**
- Modify: `tests/smoke/coding-demo.test.ts`
- Modify: `tests/smoke/coding-improvements.test.ts`
- Modify: `src/views/coding.ts`

**Interfaces:**
- Consumes: `codingProjectRailHtml`, `codingRoomHtml`, room and continuity projections.
- Produces: a calm repository rail and compact sticky room header.

- [ ] **Step 1: Add failing semantic assertions**

```ts
assert.match(html, /data-slot="workspace-rail"[^>]*aria-label="Repository rooms and team"/);
assert.match(html, /data-slot="room-header"/);
assert.match(html, /data-slot="room-participants"/);
assert.match(html, /data-coding-context-toggle[^>]*aria-expanded="false"/);
```

- [ ] **Step 2: Run the failing tests**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts tests/smoke/coding-improvements.test.ts
```

- [ ] **Step 3: Simplify the rail and header**

Keep repository switcher, new-room action, search, rooms, saved team, settings, and connection status. Restrict room summaries to `Working`, `Waiting for you`, `Complete`, or a message count with relative time. Put runtime/model detail in participant settings. In `codingRoomHtml`, render title, optional topic, state, participants, subdued branch metadata, and one Workbench toggle.

- [ ] **Step 4: Apply the visual hierarchy**

Use a deep green-black rail, charcoal-green conversation canvas, restrained green selection, translucent sticky header, 12–14px supporting copy, and a 20px room title. Remove 7–9px primary copy from the rail and header.

- [ ] **Step 5: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts tests/smoke/coding-improvements.test.ts
git add src/views/coding.ts tests/smoke/coding-demo.test.ts tests/smoke/coding-improvements.test.ts
git commit -m "refactor: simplify coding rooms and navigation"
```

### Task 3: Present work as a team conversation

**Files:**
- Modify: `tests/smoke/coding-demo.test.ts`
- Modify: `tests/deterministic/coding-progress-updates.test.ts`
- Modify: `src/views/coding.ts`

**Interfaces:**
- Consumes: `CodingChatMessage`, `codingMessageRowsHtml`, `codingRunProgress`, generative artifact cards.
- Produces: `human-message`, `node-message`, `activity-event`, and `artifact-card` presentation primitives.

- [ ] **Step 1: Add failing primitive tests**

```ts
assert.match(html, /data-conversation-kind="human-message"/);
assert.match(html, /data-conversation-kind="node-message"/);
assert.match(html, /data-conversation-kind="activity-event"/);
assert.match(html, /data-conversation-kind="artifact-card"/);
assert.match(html, /data-message-cluster=/);
assert.match(waitingHtml, /data-room-state="waiting"[\s\S]*Waiting for you/);
assert.match(failedHtml, /data-conversation-kind="activity-event"[\s\S]*Retry Run/);
assert.match(completedHtml, /data-conversation-kind="artifact-card"/);
```

- [ ] **Step 2: Run the failing tests**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts tests/deterministic/coding-progress-updates.test.ts
```

- [ ] **Step 3: Classify the existing projections**

In `codingMessageRowsHtml`, mark user turns as `human-message`, authored agent/system turns as `node-message`, Roster progress as `activity-event`, and generative/final output wrappers as `artifact-card`. Compute a stable adjacent-author cluster key without changing message IDs or order. Preserve recipient mentions so node-to-node work reads as a handoff.

- [ ] **Step 4: Collapse live work into one activity row**

Expose one status sentence, progress headline, live indicator, decision/retry controls, and Workbench link. Keep task/node detail in Workbench. Preserve existing `aria-live`, retry, merge, and close forms.

- [ ] **Step 5: Polish message and artifact CSS**

Use 14px body copy, 1.55 line height, 36px avatars, 12px metadata, 14–18px vertical rhythm, restrained human/node surfaces, compact activity styling, and prominent accepted-artifact cards. Bound attached images without cropping.

- [ ] **Step 6: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts tests/deterministic/coding-progress-updates.test.ts
git add src/views/coding.ts tests/smoke/coding-demo.test.ts tests/deterministic/coding-progress-updates.test.ts
git commit -m "refactor: present coding work as a team conversation"
```

### Task 4: Streamline composer and scrolling

**Files:**
- Modify: `tests/smoke/agent-shell.test.ts`
- Modify: `tests/deterministic/coding-scroll-anchor.test.ts`
- Modify: `src/views/agent-shell.ts`
- Modify: `src/views/coding.ts`
- Modify: `src/browser/coding-client.ts`

**Interfaces:**
- Consumes: `agentComposerHtml`, existing form fields, mention and attachment pipelines, `restoredScrollTop`.
- Produces: expanding message field, progressive tools, Enter/Shift+Enter, focus restoration, and new-message affordance.

- [ ] **Step 1: Add failing composer assertions**

```ts
assert.equal((html.match(/data-slot="workspace-composer"/g) ?? []).length, 1);
assert.equal((html.match(/<textarea/g) ?? []).length, 1);
assert.match(html, /data-composer-advanced[^>]*hidden/);
assert.match(html, /Enter to send · Shift\+Enter for a new line/);
```

- [ ] **Step 2: Run the failing tests**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/agent-shell.test.ts tests/deterministic/coding-scroll-anchor.test.ts
```

- [ ] **Step 3: Refactor composer markup**

Keep route and field names. Show textarea and send continuously. Put attachment, mention, review policy, validation, runtime, and model controls behind an accessible tools toggle; keep selected mentions and attachments visible.

- [ ] **Step 4: Refine client behavior**

Preserve IME-safe Enter-to-send and Shift+Enter newline behavior. Restore textarea focus after enhanced submission. Close transient menus on Escape. Preserve scroll anchor when away from the bottom and show a `New messages` button instead of jumping. Keep snapshot restoration across realtime island replacement.

- [ ] **Step 5: Run tests and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/agent-shell.test.ts tests/deterministic/coding-scroll-anchor.test.ts
git add src/views/agent-shell.ts src/views/coding.ts src/browser/coding-client.ts tests/smoke/agent-shell.test.ts tests/deterministic/coding-scroll-anchor.test.ts
git commit -m "refactor: streamline the coding room composer"
```

### Task 5: Recompose Workbench with progressive disclosure

**Files:**
- Modify: `tests/smoke/coding-improvements.test.ts`
- Modify: `src/views/coding.ts`
- Modify: `src/browser/coding-client.ts`

**Interfaces:**
- Consumes: `codingContextCastHtml` and existing authoritative projections.
- Produces: closed-by-default Plan, Changes, Artifacts, Team, and Details panels.

- [ ] **Step 1: Add failing Workbench tests**

```ts
assert.match(html, /id="coding-context-cast"[^>]*hidden/);
assert.match(html, /data-workbench-panel="plan"/);
assert.match(html, /data-workbench-panel="changes"/);
assert.match(html, /data-workbench-panel="artifacts"/);
assert.match(html, /data-workbench-panel="team"/);
assert.match(html, /data-workbench-panel="details"/);
```

- [ ] **Step 2: Run the failing test**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-improvements.test.ts
```

- [ ] **Step 3: Recompose and wire Workbench**

Order existing content as Plan, Changes, Artifacts, Team, Details. Put runtimes, receipts, topology, token usage, and history inside native disclosures. Synchronize `aria-expanded`; on narrow screens focus the close button, close on Escape, and restore trigger focus. Keep desktop Workbench non-modal.

- [ ] **Step 4: Run the test and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-improvements.test.ts
git add src/views/coding.ts src/browser/coding-client.ts tests/smoke/coding-improvements.test.ts
git commit -m "refactor: move coding operations into Workbench"
```

### Task 6: Polish code review and delivery

**Files:**
- Modify: `tests/smoke/coding-demo.test.ts`
- Modify: `src/views/coding.ts`

**Interfaces:**
- Consumes: `codingReviewShell`, changed files, validation, integration authority.
- Produces: conversation-family review chrome with one primary delivery action.

- [ ] **Step 1: Add failing review assertions**

```ts
assert.match(review, /data-ui-family="roster-agent"/);
assert.match(review, /aria-label="Changed files"/);
assert.match(review, /data-review-summary/);
assert.match(review, /data-review-details/);
assert.match(review, /data-review-primary-action/);
```

- [ ] **Step 2: Run the failing test**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts
```

- [ ] **Step 3: Refactor `codingReviewShell`**

Keep the route, parser, file anchors, validation evidence, and integration form. Show back control, title, delivery state, validation summary, and one authorized primary action. Move commit IDs, task counts, runtime data, and provenance into Details. Increase diff copy to at least 12px and 1.55 line height.

- [ ] **Step 4: Run the test and commit**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/coding-demo.test.ts
git add src/views/coding.ts tests/smoke/coding-demo.test.ts
git commit -m "refactor: polish coding review and delivery"
```

### Task 7: Refactor desktop onboarding around the first room

**Files:**
- Modify: `apps/desktop/index.html`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/tests/config.test.mjs`

**Interfaces:**
- Consumes: existing Tauri picker and bootstrap hooks.
- Produces: concise repository setup with one primary action and room preview.

- [ ] **Step 1: Add failing onboarding tests**

```js
assert.match(html, /Choose a repository/);
assert.match(html, /Meet your repository team/);
assert.match(html, /Open your first room/);
assert.match(html, /data-onboarding-primary/);
assert.match(html, /data-workspace-preview/);
assert.equal((html.match(/data-onboarding-primary/g) ?? []).length, 1);
```

- [ ] **Step 2: Run the failing test**

```bash
npm --prefix apps/desktop test
```

- [ ] **Step 3: Simplify onboarding**

Keep all Tauri hooks, repository controls, runtime readiness, status regions, and security copy. Use three steps: choose repository, meet the detected team, open the first room. Provide one dominant action. Make the preview show room rail, two named node messages, one activity event, and the composer.

- [ ] **Step 4: Apply onboarding polish**

Use the dark green identity, centered setup column, one raised preview, 14–16px explanatory copy, 40px controls, and responsive stacking below 820px.

- [ ] **Step 5: Test, build, and commit**

```bash
npm --prefix apps/desktop test
npm --prefix apps/desktop run build:web
git add apps/desktop/index.html apps/desktop/src/styles.css apps/desktop/tests/config.test.mjs
git commit -m "refactor: focus desktop onboarding on the first room"
```

### Task 8: Verify accessibility, responsiveness, and the complete flow

**Files:**
- Modify: `src/views/agent-shell.ts`
- Modify: `src/views/coding.ts`
- Modify: `src/browser/coding-client.ts`
- Modify: `tests/smoke/agent-shell.test.ts`
- Modify: `tests/smoke/coding-demo.test.ts`
- Modify: `tests/smoke/coding-improvements.test.ts`
- Modify: `docs/workspace-nodes.md` only if the documented shared-shell contract changes.

**Interfaces:**
- Consumes: all completed UI slices.
- Produces: verified desktop and narrow-window product with no contract regressions.

- [ ] **Step 1: Add final static accessibility assertions**

```ts
assert.match(html, /aria-label="Room conversation"/);
assert.match(html, /aria-live="polite"/);
assert.match(css, /prefers-reduced-motion:reduce/);
assert.match(css, /@media\(pointer:coarse\)/);
assert.match(css, /@media\(max-width:820px\)/);
assert.match(emptyHtml, /data-room-empty[\s\S]*Start a conversation/);
assert.match(disconnectedHtml, /data-coding-live-status[^>]*data-state="paused"/);
```

- [ ] **Step 2: Run focused UI verification**

```bash
node --import tsx --test --test-concurrency=1 tests/smoke/agent-shell.test.ts tests/smoke/coding-demo.test.ts tests/smoke/coding-improvements.test.ts tests/smoke/coding-presentation.test.ts tests/deterministic/coding-progress-updates.test.ts tests/deterministic/coding-scroll-anchor.test.ts
npm --prefix apps/desktop test
npm --prefix apps/desktop run build:web
npm run build
```

Expected: all commands PASS.

- [ ] **Step 3: Inspect the product visually**

Start the existing local server with `npm run serve:local` after the repository's SpacetimeDB development service is available. Inspect with the browser at 1440×900, 1024×768, and 390×844. Verify onboarding, empty room, active multi-node room, waiting decision, accepted artifact, Workbench open/closed, composer menus, and review. Confirm no clipped controls, page-level horizontal scroll, unreadably small copy, focus loss, or unsolicited scroll jumps.

- [ ] **Step 4: Run required repository verification**

```bash
npm run verify
```

Expected: PASS. If an external prerequisite is unavailable, retain its exact failure and run all available local verification stages.

- [ ] **Step 5: Audit scope and commit final fixes**

```bash
git diff --check
git status --short
git diff --stat
```

Confirm unrelated work remains intact, then commit only final UI/test adjustments with `git commit -m "test: verify coding desktop UI refactor"`.
