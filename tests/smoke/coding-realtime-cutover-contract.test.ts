import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  projectCodingDurableTimelineRows,
  type CodingSocialRow,
  upsertCodingSocialRows,
} from "../../src/browser/coding-social-transcript.js";
import { codingAcceptedContinuationFixture } from "../helpers/coding-accepted-continuation-fixture.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (relativePath: string): Promise<string> =>
  fs.readFile(path.join(ROOT, relativePath), "utf8");

test("Coding streams authored room updates without turning runtime telemetry into speech", async () => {
  const [agent, server, view, client, progress] = await Promise.all([
    read("src/agents/coding.agent.ts"),
    read("src/server.ts"),
    read("src/views/coding.ts"),
    read("src/browser/coding-client.ts"),
    read("src/browser/coding-progress-updates.ts"),
  ]);
  const productSource = `${server}\n${view}\n${client}`;

  assert.doesNotMatch(productSource, /\/coding\/status(?:\?|\b)/);
  assert.doesNotMatch(productSource, /\/coding\/attention(?:\?|\b)/);
  assert.doesNotMatch(client, /\bXMLHttpRequest\b|\bEventSource\b|\bsetInterval\s*\(/);
  assert.match(client, /new URL\("\/coding\/runtime-logs", location\.origin\)/);
  assert.match(client, /fetch\(endpoint,[\s\S]{0,180}application\/x-ndjson/);
  assert.match(client, /response\.body\.getReader\(\)/);
  assert.match(client, /renderRuntimeLogs/);
  assert.match(client, /const renderConversationLiveActivity/);
  assert.match(client, /data-coding-live-activity/);
  assert.match(client, /codingLiveActivityPresentation/);
  assert.match(await read("src/views/coding-style.ts"), /\.coding-live-activity/);
  assert.doesNotMatch(client, /renderConversationalProgressPosts/);
  assert.doesNotMatch(client, /codingRuntimeProgressPosts/);
  assert.doesNotMatch(client, /projectCodingPeerTranscript/);
  assert.doesNotMatch(client, /data-coding-runtime-progress-post/);
  assert.match(client, /message\.type === "heartbeat"/);
  assert.match(client, /coding:runtime-heartbeat/);
  assert.match(agent, /\/coding\/room-updates/u);
  assert.match(agent, /application\/x-ndjson/u);
  assert.match(agent, /codingRoomUpdates\.subscribe/u);
  assert.match(client, /new URL\("\/coding\/room-updates", location\.origin\)/u);
  assert.match(client, /connectRoomUpdates/u);
  assert.match(client, /roomUpdateController/u);
  assert.match(client, /new AbortController\(\)/u);
  assert.match(client, /BoundedNdjsonLineDecoder/u);
  assert.match(client, /message\.type === "snapshot"/u);
  assert.match(client, /message\.type === "update" \|\| message\.type === "settled"/u);
  assert.match(client, /projectCodingSocialRows/u);
  assert.match(client, /reconcileCodingLiveSocialRows/u);
  assert.match(client, /durableSocialRowsFromDom\(\)/u);
  assert.match(client, /\[data-coding-social-row\]\[data-durability="durable"\]/u);
  assert.match(client, /\[data-row-id=/u);
  assert.match(progress, /commandKind/u);
  assert.match(progress, /rawLogRef/u);
  assert.doesNotMatch(progress, /readonly body\b|\bbody:/u);
  for (const scriptedCopy of [
    "Started the assigned repository step.",
    "Running the relevant repository checks.",
    "Inspecting current worktree changes.",
    "Tracing the relevant repository references.",
    "Running a bounded repository command.",
    "Continuing with a compacted live response.",
  ]) {
    assert.doesNotMatch(`${client}\n${progress}`, new RegExp(
      scriptedCopy.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      "u",
    ));
  }
  assert.doesNotMatch(client, /fetch\([^)]*(?:coding\/status|coding\/attention)/);
  assert.doesNotMatch(
    view,
    /setInterval\([\s\S]{0,240}(?:attention|\/coding\/status)/,
    "Coding must not disguise polling behind a timer",
  );
  assert.match(view, /const codingRunLiveClockScript/);
  assert.match(view, /setInterval\(update,1000\)/);
  assert.match(view, /Live · worker active now/);
  assert.match(view, /coding:runtime-heartbeat/);
  assert.match(view, /data-coding-room-transcript/);
  assert.match(view, /data-coding-social-row/);
  assert.match(view, /projectCodingSocialRows/);
});

test("Coding realtime client builds as a first-class asset and reconnects by generation", async () => {
  const [client, buildScript, packageSource, view, enhancements] = await Promise.all([
    read("src/browser/coding-client.ts"),
    read("scripts/build-coding-client.mjs"),
    read("package.json"),
    read("src/views/coding.ts"),
    read("src/browser/coding-enhancements.ts"),
  ]);

  assert.match(packageSource, /"build:coding-client"/);
  assert.match(packageSource, /npm run build:coding-client/);
  assert.match(buildScript, /coding-client\.ts/);
  assert.match(buildScript, /public\/assets\/coding-client\.js/);
  assert.match(view, /\/assets\/coding-client\.js/);

  assert.match(client, /onApplied/);
  assert.match(client, /generation/i);
  assert.match(client, /identity.*token|token.*identity/is);
  assert.match(client, /disconnect|onDisconnect/);
  assert.match(client, /reconnect|connect\(/i);
  assert.match(client, /hasAppliedSubscription/);
  assert.match(client, /const latestActiveRunActivityAt/);
  assert.match(client, /progressRow\.dataset\.lastActivityAt/);
  assert.match(client, /progress\.dataset\.connectionLabel = label/);
  assert.match(client, /reconnectNoticeTimer/);
  assert.match(client, /setLiveState\("paused", "Updates paused"/);
  assert.doesNotMatch(client, /setLiveState\("reconnecting", "Reconnecting"/);
  assert.match(client, /cursor/i);
  assert.match(client, /selection|selectionStart/i);
  assert.match(client, /scroll/i);
  assert.match(client, /focus|activeElement/i);
  assert.match(client, /const renderCoordination/);
  assert.match(client, /renderCoordination\(\)/);
  assert.match(client, /let renderFrame = 0/);
  assert.match(client, /const scheduleRender = \(\): void =>/);
  assert.match(client, /renderFrame = window\.requestAnimationFrame/);
  assert.match(client, /const scheduleRuntimeLogRender = \(\): void =>/);
  assert.match(client, /runtimeLogRenderFrame = window\.requestAnimationFrame/);
  assert.match(client, /runtimeLogs\.set\(runtimeEntry\.sequence, runtimeEntry\);\s*scheduleRuntimeLogRender\(\)/);
  assert.equal((client.match(/scheduleRender\(\);/g) ?? []).length, 5);
  assert.doesNotMatch(client, /if \(applied\) render\(\)/);
  assert.match(client, /list\.dataset\.renderKey !== renderKey/);
  assert.match(client, /body\.dataset\.renderKey !== renderKey/);
  assert.match(client, /item\.nextElementSibling !== statusAnchor/);
  assert.match(client, /const renderLiveDag/);
  assert.match(client, /normalizeResolutionReviewerLabels/);
  assert.match(client, /Resolution Reviewer/);
  assert.doesNotMatch(client, /renderConversationalProgressPosts/);
  assert.doesNotMatch(client, /progressLabels/);
  assert.doesNotMatch(client, /Live agent progress; accepted results remain in the run record/);
  assert.doesNotMatch(client, /Live update · task receipts remain authoritative/);
  assert.match(client, /renderLiveDag\(visibleRunTasks\)/);
  assert.match(client, /visibleRunTasks = runTasks\.filter\(isCodingUserVisibleTask\)/);
  assert.match(client, /observe\(db\.myCodingRunTaskEdgesWindow, taskEdges\)/);
  assert.match(client, /replace\(db\.myCodingRunTaskEdgesWindow, taskEdges\)/);
  assert.match(client, /const loadOlderTimelinePage/);
  assert.match(client, /selectCodingRoomTimelinePage\(\{[\s\S]{0,180}beforeSeq: oldest/u);
  assert.match(client, /return left\.stage - right\.stage/);
  assert.match(client, /connectRuntimeLogs\(\)/);
  assert.match(client, /const removeConversationStatusSnapshots/);
  assert.match(client, /const renderRealtimeConversationMessages/);
  assert.doesNotMatch(client, /const renderRealtimeFinalOutcome/);
  assert.match(client, /message\.tags\.includes\("turn:final-result"\)/);
  assert.doesNotMatch(client, /internalInvestigationTurns/);
  assert.doesNotMatch(client, /"turn:investigation-report"/);
  assert.match(client, /"turn:investigation-synthesis"/);
  assert.match(client, /realtimeConversationMessage/);
  assert.doesNotMatch(client, /data-coding-realtime-message/);
  assert.match(client, /projectCodingDurableTimelineRows/);
  assert.match(client, /article\.dataset\.codingSocialRow = ""/);
  assert.match(client, /article\.dataset\.sourceKind = row\.sourceKind/);
  assert.match(client, /article\.dataset\.authorNodeId = row\.author\.nodeId/);
  assert.match(client, /article\.dataset\.taskId = row\.taskId \?\? ""/);
  assert.match(client, /candidate\.intentId === message\.intentId \|\| candidate\.intentId === message\.messageId/);
  assert.match(client, /Delivered to the working team/);
  assert.match(client, /Message queued for the team/);
  assert.match(client, /Run ended before this message was delivered/);
  assert.match(client, /const currentStatusAnchor/);
  assert.match(client, /else feed\.insertBefore\(item, currentStatusAnchor\(\)\)/);
  assert.match(client, /snapshot\.remove\(\)/);
  assert.match(view, /data-row-id="\$\{esc\(row\.rowId\)\}"/);
  assert.match(view, /data-source-kind="\$\{esc\(row\.sourceKind\)\}"/);
  assert.match(view, /const statusAnchor=\(\)=>/);
  assert.doesNotMatch(view, /keepCurrentStatusAtTail/);
  assert.match(view, /const elapsedLabel=\(elapsedMs\)=>/);
  assert.match(view, /runtimeSignalAt/);
  assert.doesNotMatch(view, /watching for the next durable update/);
  assert.doesNotMatch(view, /last durable update/);
  assert.match(client, /restoredScrollTop/);
  assert.match(client, /anchorOffsetBefore: saved\.anchorOffset/);
  assert.match(client, /anchorOffsetAfter/);
  assert.match(client, /data-coding-team-snapshot/);
  assert.match(client, /data-coding-attention-copy/);
  assert.match(client, /choose Retry Run below to start a fresh bounded attempt, or reply here/);
  assert.match(client, /renderMessageAddress\(address, \["You"\]\)/);
  assert.doesNotMatch(client, /address\.textContent = "to @/);
  assert.match(client, /participantTrigger\(\{[\s\S]{0,100}nodeId: "coordinator"/);
  assert.match(client, /participantProfileFormDirty/);
  assert.match(client, /const renderProfileContinuity/);
  assert.match(client, /data-profile-continuity/);
  assert.match(client, /Inbox contents and private memory remain private|Not saved yet/);
  assert.match(client, /participantProfileForm\?\.addEventListener\("input"/);
  assert.match(client, /participantRuntimeForm\?\.addEventListener\("change"/);
  assert.doesNotMatch(client, /workspaceSettingsFromReceipt|StreamReceiptRow|bodyJson/);
  assert.match(client, /updateParticipantExecutionTriggers/);
  assert.match(client, /trigger\.hidden = false/);
  assert.match(client, /form\.action = `\/coding\/runs\/\$\{encodeURIComponent\(activeRunId\)\}\/retry`/);
  assert.match(client, /data-coding-coordination-count/);
  assert.match(client, /data-coding-coordination-primary/);
  assert.match(client, /latestBindingFor/);
  assert.match(client, /\["Agent", runtime\]/);
  assert.match(client, /\["Model", model\]/);
  assert.match(client, /dataset\.codingAgent = runtime/);
  assert.match(client, /dataset\.codingModel = model/);
  assert.match(client, /Agent: \$\{identity\.runtime\} · Model: \$\{identity\.model\}/);
  assert.match(client, /usesPrimaryCodingAgent/);
  assert.match(client, /const capabilityLabel/);
  assert.match(client, /`\$\{milestone\} contribution accepted`/);
  assert.match(client, /data-coordination-select-node/);
  assert.match(enhancements, /const currentToken =/);
  assert.match(enhancements, /const insertMention =/);
  assert.match(enhancements, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(enhancements, /event\.key === "Enter" \|\| event\.key === "Tab"/);
  assert.match(await read("src/views/coding-style.ts"), /coding-mention-option\[hidden\]\{display:none\}/);
  assert.doesNotMatch(view, /const mentionContext=|const insertMention=/);
  assert.match(view, /const inlineTags=/);
});

type RealtimeSocialRow = CodingSocialRow & {
  readonly sequence?: number;
  readonly intent?: "progress" | "acknowledgement" | "question";
  readonly settled?: boolean;
};

const realtimeRow = (input: Partial<RealtimeSocialRow> & Pick<RealtimeSocialRow, "rowId">): RealtimeSocialRow => ({
  rowId: input.rowId,
  sourceId: input.sourceId ?? input.rowId,
  sourceKind: input.sourceKind ?? "live-update",
  author: input.author ?? {
    nodeId: "workspace.implementation",
    displayName: "Kai",
    role: "Implementation Engineer",
    avatarLabel: "K",
    human: false,
  },
  recipients: input.recipients ?? [],
  body: input.body ?? "Working on the bounded room stream.",
  at: input.at ?? "2026-08-26T20:00:00.000Z",
  state: input.state ?? "live",
  durability: input.durability ?? "ephemeral",
  cluster: input.cluster ?? "start",
  taskId: input.taskId ?? "implement",
  updateId: input.updateId ?? input.rowId,
  sequence: input.sequence ?? 1,
  intent: input.intent ?? "progress",
  settled: input.settled ?? false,
});

test("social row upserts replace by stable identity and reject stale delivery", () => {
  const first = realtimeRow({ rowId: "update-working", sequence: 1, body: "First authored update." });
  const replacement = realtimeRow({ rowId: "update-working", sequence: 2, body: "Replacement authored update." });
  const stale = realtimeRow({ rowId: "update-working", sequence: 1, body: "Stale authored update." });

  const replaced = upsertCodingSocialRows([first], [replacement]);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.body, "Replacement authored update.");
  assert.equal(upsertCodingSocialRows(replaced, [stale])[0]?.body, "Replacement authored update.");
});

test("social row upserts fail closed on equal-version conflicts independent of arrival order", () => {
  const first = realtimeRow({ rowId: "update-conflict", sequence: 2, body: "First body." });
  const conflict = realtimeRow({ rowId: "update-conflict", sequence: 2, body: "Conflicting body." });
  assert.deepEqual(upsertCodingSocialRows([first], [conflict]), []);
  assert.deepEqual(upsertCodingSocialRows([conflict], [first]), []);
});

test("social row upserts retain questions and let accepted work supersede settled progress", () => {
  const settledProgress = realtimeRow({
    rowId: "update-progress",
    taskId: "implement",
    sequence: 2,
    settled: true,
  });
  const settledQuestion = realtimeRow({
    rowId: "update-question",
    taskId: "implement",
    sequence: 3,
    intent: "question",
    settled: true,
    body: "Should this remain visible after settlement?",
  });
  const accepted = realtimeRow({
    rowId: "accepted-implementation",
    sourceKind: "accepted-summary",
    state: "accepted",
    durability: "durable",
    taskId: "implement",
    updateId: undefined,
    sequence: undefined,
    intent: undefined,
    settled: undefined,
    body: "The authored implementation summary is accepted.",
  });

  const rows = upsertCodingSocialRows([settledProgress, settledQuestion], [accepted]);
  assert.deepEqual(rows.map((row) => row.rowId), ["accepted-implementation", "update-question"]);
});

test("social row upserts keep distinct node and task working rows separate", () => {
  const implementation = realtimeRow({ rowId: "update-implementation", taskId: "implement" });
  const review = realtimeRow({
    rowId: "update-review",
    taskId: "review",
    author: {
      nodeId: "workspace.quality",
      displayName: "Mira",
      role: "Quality Reviewer",
      avatarLabel: "M",
      human: false,
    },
  });

  const rows = upsertCodingSocialRows([], [implementation, review]);
  assert.deepEqual(rows.map((row) => [row.author.nodeId, row.taskId]), [
    ["workspace.implementation", "implement"],
    ["workspace.quality", "review"],
  ]);
});

test("production continuation, review, certification, and final timeline turns reconcile as stable accepted social rows", async () => {
  const fixture = await codingAcceptedContinuationFixture();
  const tasks = fixture.snapshot.tasks.map((task) => ({
    taskId: task.definition.taskId,
    nodeId: task.definition.nodeId,
    state: task.status === "accepted" || task.status === "skipped"
      ? "accepted" as const
      : task.status === "failed" || task.status === "canceled"
        ? "failed" as const
        : task.status === "running" || task.status === "leased"
          ? "running" as const
          : "pending" as const,
  }));
  const edges = fixture.snapshot.tasks.flatMap((task) => task.definition.dependencies.map((dependency) => ({
    taskId: task.definition.taskId,
    prerequisiteTaskId: dependency.taskId,
  })));
  tasks.push({ taskId: "social-delivery:coding-finalize", nodeId: "human.operator", state: "pending" });
  edges.push({ taskId: "social-delivery:coding-finalize", prerequisiteTaskId: "coding-finalize" });
  const names = new Map([
    ["workspace.implementation", ["Kai", "Implementation Engineer"]],
    ["workspace.security", ["Sana", "Security Reviewer"]],
    ["workspace.data", ["Drew", "Data Reviewer"]],
    ["workspace.quality", ["Mira", "Quality Reviewer"]],
    ["coordinator", ["Roster", "System Facilitator"]],
    ["human.operator", ["You", "Workspace participant"]],
  ] as const);
  const participants = [...names].map(([nodeId, [displayName, role]]) => ({
    nodeId,
    displayName,
    role,
    avatarLabel: displayName[0]!,
    human: nodeId === "human.operator",
  }));
  const selectedTaskIds = new Set([
    "continue_implementation",
    "review-implementation",
    "certify-quality",
    "coding-finalize",
  ]);
  const messages = fixture.acceptedTurns
    .filter((turn) => selectedTaskIds.has(turn.taskId))
    .map((turn, index) => ({
      sourceId: `coding_peer_${turn.artifactId}`,
      artifactId: turn.artifactId,
      outputReference: turn.artifactId,
      sourceSequence: String(index + 1),
      at: new Date(index + 1).toISOString(),
      taskId: turn.taskId,
      authorNodeId: turn.nodeId,
      recipientNodeIds: [] as string[],
      body: turn.body,
      sourceKind: "accepted-summary" as const,
    }));
  const input = { participants, tasks, edges, messages };
  const first = projectCodingDurableTimelineRows(input);
  const replayed = projectCodingDurableTimelineRows({ ...input, messages: [...messages].reverse() });

  assert.deepEqual(first.map((row) => [row.sourceKind, row.author.nodeId, row.taskId]), [
    ["accepted-summary", "workspace.implementation", "continue_implementation"],
    ["accepted-summary", "workspace.quality", "review-implementation"],
    ["accepted-summary", "workspace.quality", "certify-quality"],
    ["accepted-summary", "coordinator", "coding-finalize"],
  ]);
  assert.deepEqual(first.map((row) => row.rowId).sort(), replayed.map((row) => row.rowId).sort());
  assert.equal(new Set(upsertCodingSocialRows(first, replayed).map((row) => row.rowId)).size, 4);
  assert.deepEqual(first.at(-1)?.recipients.map((recipient) => recipient.nodeId), ["human.operator"]);
});

test("Coding subscriptions are caller-scoped to one room and active execution", async () => {
  const client = await read("src/browser/coding-client.ts");

  for (const query of [
    "SELECT * FROM my_coding_rooms_window WHERE id = ${room}",
    "SELECT * FROM my_coding_room_nodes_window WHERE room_id = ${room}",
    "SELECT * FROM my_coding_participant_profiles_window WHERE workspace_id = ${sqlLiteral(boot.workspaceId)}",
    "SELECT * FROM my_coding_room_timeline_window WHERE room_id = ${room} AND selection_id = ${selection}",
    "SELECT * FROM my_coding_room_timeline_page WHERE room_id = ${room} AND selection_id = ${selection}",
    "SELECT * FROM my_coding_control_intent_deliveries_window WHERE room_id = ${room}",
    "SELECT * FROM my_coding_context_frontiers_window WHERE room_id = ${room}",
    "SELECT * FROM my_coding_active_runtime_bindings_window WHERE room_id = ${room}",
    "SELECT * FROM my_coding_execution_summaries_window WHERE run_id = ${run}",
    "SELECT * FROM my_coding_run_tasks_window WHERE run_id = ${run}",
    "SELECT * FROM my_coding_run_task_edges_window WHERE run_id = ${run}",
    "SELECT * FROM my_coding_run_task_output_references_window WHERE run_id = ${run}",
    "SELECT * FROM my_coding_collaboration_summaries_window WHERE run_id = ${run}",
  ]) assert.ok(client.includes(query), `missing scoped subscription query: ${query}`);
  for (const privateView of [
    "my_roster_rooms",
    "my_roster_room_nodes",
    "my_roster_participant_profiles",
    "my_roster_runtime_bindings",
    "my_roster_task_outcomes",
    "my_roster_task_context_manifests",
  ]) assert.ok(!client.includes(`SELECT * FROM ${privateView}`), `raw view leaked into browser subscription: ${privateView}`);
  assert.match(client, /joinCanvasRun\(\{\s*runId: activeRunId/u);
  assert.match(client, /selectionId: timelineSelectionId/u);
  assert.match(client, /predecessorSelectionId: ""/u);
  assert.doesNotMatch(client, /joinWorkspace\(/u);
  assert.doesNotMatch(client, /runtimeJson|sessionId|sandboxId/u);
  assert.doesNotMatch(client, /`SELECT \* FROM my_roster_tasks WHERE run_id = \$\{run\}`/);
  assert.doesNotMatch(client, /`SELECT \* FROM my_roster_task_outcomes/);
  assert.doesNotMatch(client, /`SELECT \* FROM my_roster_task_expansions/);

  assert.doesNotMatch(client, /my_stream_receipts/);
  assert.match(client, /const schedulePreflightReconciliation/);
  assert.match(client, /preflightReconcileAttempt >= 20/);
  assert.match(client, /\/api\/v2\/coding\/runs\/\$\{encodeURIComponent\(boot\.conversationId\)\}/);
  assert.match(client, /\["completed", "failed", "canceled"\]\.includes\(status\)/);
  assert.match(client, /location\.reload\(\)/);
  assert.match(client, /progress: execution \? presentation\.progress : "Stopped before the first step"/);

  assert.match(client, /installTableCallbacks\(db, connectionGeneration\)/);
  assert.match(client, /hydrate\(db\)/);
  assert.match(client, /\.onApplied\(\(\) =>/);
  assert.match(client, /table\.onInsert/);
  assert.match(client, /table\.onUpdate/);
  assert.match(client, /table\.onDelete/);
});

test("Coding public timeline is hard capped and older pages use exact cursor authority", async () => {
  const [client, moduleSource, pagination] = await Promise.all([
    read("src/browser/coding-client.ts"),
    read("spacetimedb/src/index.ts"),
    read("spacetimedb/src/coding-timeline-pagination.ts"),
  ]);
  const publicTimeline = moduleSource.slice(
    moduleSource.indexOf("export const myCodingRoomTimeline ="),
    moduleSource.indexOf("export const myCodingControlIntentDeliveriesWindow"),
  );
  assert.match(publicTimeline, /CODING_TIMELINE_PUBLIC_ROWS/u);
  assert.match(publicTimeline, /boundedCodingTimelineRows\(rows, CODING_TIMELINE_PUBLIC_ROWS\)/u);
  assert.match(pagination, /\.slice\(0, positiveLimit\(maxRows\)\)/u);
  assert.match(moduleSource, /export const selectCodingRoomTimelinePage/u);
  assert.match(moduleSource, /selectionId: t\.string\(\)/u);
  assert.match(moduleSource, /predecessorSelectionId: t\.string\(\)/u);
  assert.match(moduleSource, /MAX_CODING_TIMELINE_SELECTIONS_PER_IDENTITY/u);
  assert.match(moduleSource, /coding_room_timeline_selection_expiration/u);
  assert.match(moduleSource, /requestId: t\.string\(\)\.index\("btree"\)/u);
  assert.match(moduleSource, /deleteCodingRoomTimelineSelectionExpirations/u);
  assert.match(moduleSource, /codingRoomTimelineSelectionExpiration\.requestId\.filter\(requestId\)/u);
  assert.match(moduleSource, /ttlSeconds: t\.u64\(\)/u);
  assert.match(moduleSource, /name: "my_coding_room_timeline_page"/u);
  const pageView = moduleSource.slice(
    moduleSource.indexOf("export const myCodingRoomTimelinePage ="),
    moduleSource.indexOf("export const myCodingControlIntentDeliveriesWindow"),
  );
  assert.match(pageView, /codingRoomTimelinePageRequest\.member\.filter\(ctx\.sender\)/u);
  assert.match(pageView, /runMember\.id\.find\(membershipKey\(request\.runId, ctx\.sender\)\)/u);
  assert.match(pageView, /codingTimelinePage\([\s\S]*runId: request\.runId,[\s\S]*roomId: request\.roomId,[\s\S]*beforeSeq: request\.beforeSeq,[\s\S]*maxRows: CODING_TIMELINE_PAGE_ROWS/u);
  assert.match(pagination, /row\.runId === input\.runId[\s\S]*row\.roomId === input\.roomId[\s\S]*row\.seq < input\.beforeSeq/u);
  assert.match(client, /selectCodingRoomTimelinePage\(\{[\s\S]{0,180}beforeSeq: oldest/u);
  assert.match(client, /SELECT \* FROM my_coding_room_timeline_page WHERE room_id = \$\{room\} AND selection_id = \$\{selection\}/u);
  assert.doesNotMatch(client, /seq >= \$\{lower\.toString\(\)\} AND seq < \$\{oldest\.toString\(\)\}/u);
});

test("Coding viewer mint and DTO views fail closed to one authenticated run", async () => {
  const [agent, webAccess, client, realtimeCli, moduleSource] = await Promise.all([
    read("src/agents/coding.agent.ts"),
    read("src/adapters/spacetimedb-web-access.ts"),
    read("src/browser/coding-client.ts"),
    read("src/cli/coding-realtime.ts"),
    read("spacetimedb/src/index.ts"),
  ]);
  assert.match(agent, /CODING_PAGE_SESSION_COOKIE = "roster_coding_page"/u);
  assert.match(agent, /HttpOnly; SameSite=Strict/u);
  assert.match(agent, /workspaceId !== session\.workspaceId[\s\S]*conversationId !== session\.conversationId[\s\S]*requestedJobId !== session\.jobId[\s\S]*executionId !== session\.executionId/u);
  assert.match(agent, /Cache-Control", "no-store"/u);
  assert.match(webAccess, /createViewerCapability\(\{\s*runId/u);
  const exactMint = webAccess.slice(webAccess.indexOf("async createViewerSession"));
  assert.doesNotMatch(exactMint, /createWorkspaceViewerCapability/u);
  const viewerMint = moduleSource.slice(
    moduleSource.indexOf("export const createViewerCapability"),
    moduleSource.indexOf("export const revokeViewerCapability"),
  );
  assert.match(viewerMint, /canvasRun\.id\.find\(runId\)/u);
  assert.match(viewerMint, /ensureRosterRunCoordinatorMembership\(ctx, execution\)/u);
  assert.doesNotMatch(viewerMint, /requireRun\(ctx, runId\);\s*requireMembership/u);
  const initialization = moduleSource.slice(
    moduleSource.indexOf("export const initializeRosterExecution"),
    moduleSource.indexOf("export const upsertRosterParticipantProfile"),
  );
  assert.match(initialization, /ensureRosterRunCoordinatorMembership\(ctx, requireRosterExecution\(ctx, runId\)\)/u);
  assert.match(client, /joinCanvasRun\(\{\s*runId: activeRunId/u);
  assert.match(realtimeCli, /joinCanvasRun\(\{\s*runId: session\.executionId/u);
  assert.match(realtimeCli, /const timelineSelectionId = `cli-\$\{randomUUID\(\)\}`/u);
  assert.doesNotMatch(realtimeCli, /timelineSelectionId[^\n]*selectedGeneration/u);
  assert.match(realtimeCli, /selectionId: timelineSelectionId,\s*predecessorSelectionId: ""/u);
  assert.doesNotMatch(`${client}\n${realtimeCli}`, /joinWorkspace\(/u);

  for (const viewName of [
    "my_coding_rooms_window",
    "my_coding_room_nodes_window",
    "my_coding_participant_profiles_window",
    "my_coding_room_timeline",
    "my_coding_room_timeline_page",
    "my_coding_room_timeline_window",
    "my_coding_control_intent_deliveries_window",
    "my_coding_context_frontiers_window",
    "my_coding_execution_summaries_window",
    "my_coding_run_tasks_window",
    "my_coding_run_task_edges_window",
    "my_coding_run_task_output_references_window",
    "my_coding_collaboration_summaries_window",
    "my_coding_active_runtime_bindings_window",
  ]) {
    const start = moduleSource.indexOf(`name: "${viewName}"`);
    assert.notEqual(start, -1, `missing exact Coding DTO view ${viewName}`);
    const nextView = moduleSource.indexOf("export const ", start + 20);
    const block = moduleSource.slice(start, nextView < 0 ? undefined : nextView);
    assert.match(
      block,
      /runMember\.(?:member\.filter\(ctx\.sender\)|id\.find\(membershipKey\()/u,
      `${viewName} must authorize exact run membership`,
    );
  }
  const runtimeProjection = moduleSource.match(/const codingActiveRuntimeBindingProjection[\s\S]*?\}\);/u)?.[0] ?? "";
  assert.doesNotMatch(runtimeProjection, /runtimeJson|sessionId|sandboxId|placement/u);
  const outputProjection = moduleSource.match(/const codingTaskOutputReferenceProjection[\s\S]*?\}\);/u)?.[0] ?? "";
  assert.doesNotMatch(outputProjection, /referenceJson/u);
});

test("Coding realtime owns terminal and app cleanup through one idempotent lifecycle", async () => {
  const [client, stream] = await Promise.all([
    read("src/browser/coding-client.ts"),
    read("src/browser/coding-room-stream.ts"),
  ]);
  assert.match(client, /shouldOpenCodingRoomStream/);
  assert.match(client, /routeCodingRoomStreamAdmission/);
  assert.match(client, /const shutdownRoomUpdateStream/);
  assert.match(client, /const disposeCodingClient = createIdempotentDisposer/);
  assert.match(client, /roomUpdateReader/);
  assert.match(client, /runtimeLogReader/);
  assert.match(client, /cancelStreamReader[\s\S]{0,500}reader\.releaseLock\(\)/u);
  assert.match(client, /disposeCodingClient\(\)/);
  assert.match(client, /shutdownRoomUpdateStream\("terminal"\)/);
  assert.doesNotMatch(client, /beforeunload[\s\S]{0,800}disposed = true/u);
  const runtimeSection = client.slice(
    client.indexOf("const connectRuntimeLogs"),
    client.indexOf("const markRoomUpdateLabelsPaused"),
  );
  const roomSection = client.slice(
    client.indexOf("const connectRoomUpdates"),
    client.indexOf("const hydrateInitialRoomUpdates"),
  );
  const roomReconnectScheduler = client.slice(
    client.indexOf("const scheduleRoomUpdateReconnect"),
    client.indexOf("const connectRoomUpdates"),
  );
  assert.match(runtimeSection, /isCurrentRuntimeLogStream/);
  assert.match(runtimeSection, /!disposed\s*&& !controller\.signal\.aborted\s*&& streamGeneration === runtimeLogGeneration/u);
  assert.match(runtimeSection, /await awaitCurrentCodingStreamResponse\(fetch\(/);
  assert.match(runtimeSection, /acceptCurrentCodingStreamResponse/);
  assert.match(runtimeSection, /\}\), isCurrentRuntimeLogStream\);\s*const response = acceptCurrentCodingStreamResponse\(guardedResponse, isCurrentRuntimeLogStream\);\s*if \(!response\) return;\s*if \(!response\.ok/u);
  assert.match(runtimeSection, /await readCurrentCodingStreamChunk\(reader/);
  assert.match(runtimeSection, /acceptCurrentCodingStreamChunk/);
  assert.match(runtimeSection, /readCurrentCodingStreamChunk\(reader, isCurrentRuntimeLogStream\);\s*const chunk = acceptCurrentCodingStreamChunk\(guardedChunk, reader, isCurrentRuntimeLogStream\);\s*if \(!chunk\) return;\s*if \(chunk\.done\)/u);
  assert.match(roomSection, /isCurrentRoomUpdateStream/);
  assert.match(roomSection, /!disposed\s*&& !controller\.signal\.aborted\s*&& streamGeneration === roomUpdateGeneration/u);
  assert.match(roomSection, /await awaitCurrentCodingStreamResponse\(fetch\(/);
  assert.match(roomSection, /acceptCurrentCodingStreamResponse/);
  assert.match(roomSection, /\}\), isCurrentRoomUpdateStream\);\s*const response = acceptCurrentCodingStreamResponse\(guardedResponse, isCurrentRoomUpdateStream\);\s*if \(!response\) return;[\s\S]{0,300}routeCodingRoomStreamAdmission/u);
  assert.match(roomSection, /await readCurrentCodingStreamChunk\(reader/);
  assert.match(roomSection, /acceptCurrentCodingStreamChunk/);
  assert.match(roomSection, /readCurrentCodingStreamChunk\(reader, isCurrentRoomUpdateStream\);\s*const chunk = acceptCurrentCodingStreamChunk\(guardedChunk, reader, isCurrentRoomUpdateStream\);\s*if \(!chunk\) return;\s*if \(chunk\.done\)/u);
  assert.match(roomSection, /decoder\.finish\(applyLine\);[\s\S]{0,400}codingRoomStreamEofTransition\([\s\S]{0,160}shutdownRoomUpdateStream\(transition\);[\s\S]{0,100}transition === "paused"[\s\S]{0,100}scheduleRoomUpdateReconnect\(\)/u);
  assert.match(roomReconnectScheduler, /disposed\s*\|\|\s*roomUpdateReconnectTimer\s*\|\|\s*roomUpdateController/u,
    "clean EOF cannot allocate duplicate reconnect timers or overlap an active generation");
  assert.match(stream, /const response = await pendingResponse;[\s\S]{0,100}if \(isCurrent\(\)\)/u);
  assert.match(stream, /const chunk = await reader\.read\(\);[\s\S]{0,100}if \(isCurrent\(\)\)/u);
  assert.match(stream, /status === 400 \|\| status === 401 \|\| status === 404 \|\| status === 410/u);
});

test("active-room follow-ups expand at a safe boundary in fast and reviewed runs", async () => {
  const [domain, server] = await Promise.all([
    read("src/domains/coding.ts"),
    read("src/server.ts"),
  ]);

  assert.match(domain, /const fastFollowUpCycle/);
  assert.match(domain, /mode === "fast"[\s\S]{0,800}fastFollowUpCycle/);
  assert.match(domain, /await consumeRoomControlIntents\([\s\S]{0,180}pendingIntents/);
  assert.doesNotMatch(domain, /Fast Coding finalization is blocked by a pending durable room follow-up/);
  assert.match(server, /commitGitRunBranch[\s\S]{0,2500}advanceGitRoomBranch[\s\S]{0,2500}finalizeRosterExecution/);
  assert.match(server, /outcome: "completed"/);
  assert.match(server, /outcome: "failed"/);
});

test("Coding realtime projects one SpacetimeDB execution state with accepted collaboration counts", async () => {
  const [client, presentation, view, moduleSource] = await Promise.all([
    read("src/browser/coding-client.ts"),
    read("src/browser/coding-presentation.ts"),
    read("src/views/coding.ts"),
    read("spacetimedb/src/index.ts"),
  ]);
  assert.match(client, /myCodingRunTaskOutputReferencesWindow/);
  assert.match(client, /myCodingCollaborationSummariesWindow/);
  assert.match(client, /collaborationSummary\.proposalCount/);
  assert.match(client, /collaborationSummary\.responseCount/);
  assert.match(client, /collaborationSummary\.endorsementCount/);
  assert.match(client, /entry\.outputKeys/);
  assert.match(client, /if \(outputKeys\.size > 0\)/);
  assert.match(client, /collaboration_proposal_/);
  assert.match(client, /collaboration_response_/);
  assert.match(client, /collaboration_endorsement_/);
  assert.match(client, /\[data-coding-endorsement-count\]/);
  assert.match(moduleSource, /CODING_TIMELINE_WINDOW_ROWS = 256/);
  assert.match(moduleSource, /CODING_TASK_WINDOW_ROWS = 512/);
  assert.match(moduleSource, /name: "my_coding_room_timeline_window"/);
  assert.match(moduleSource, /name: "my_coding_run_tasks_window"/);
  assert.match(moduleSource, /name: "my_coding_active_runtime_bindings_window"/);
  assert.match(moduleSource, /const codingActiveRuntimeBindingProjection[\s\S]*runtimeKind: t\.string\(\)[\s\S]*model: t\.string\(\)[\s\S]*reasoningEffort: t\.string\(\)/u);
  assert.doesNotMatch(
    moduleSource.match(/const codingActiveRuntimeBindingProjection[\s\S]*?\}\);/u)?.[0] ?? "",
    /runtimeJson|sessionId|sandboxId/u,
  );
  assert.match(moduleSource, /objective: sanitized \? "" : task\.objective/);
  assert.doesNotMatch(client, /frontierJson|alreadyCertified/);
  assert.match(client, /codingRunPresentation\([\s\S]{0,300}displayName: nodes\.get\(task\.nodeId\)\?\.name/);
  assert.match(client, /const delivery = boot\.delivery/);
  assert.match(client, /const activeDeliveryDisposition/);
  assert.match(client, /boot\.delivery\?\.status === "kept-branch"/);
  assert.match(client, /label: "Closed · branch kept"/);
  assert.match(client, /\.coding-run-delivery-actions/);
  assert.match(client, /const certifiedDeliveryNeedsAttention/);
  assert.match(client, /the change is certified, but the merge needs attention/);
  assert.match(client, /presentation\.needsAttention && !certifiedDeliveryNeedsAttention\(\)/);
  assert.match(client, /label: "Ready to merge"/);
  assert.match(client, /label: "Finalizing delivery"/);
  assert.match(client, /label: "Merged"/);
  assert.match(client, /SpacetimeDB is the wake-up signal/);
  assert.match(client, /location\.reload\(\)/);
  assert.doesNotMatch(client, /replaceText\("\[data-attention-count\]"/);
  assert.match(client, /replaceAllText\("\[data-run-presentation-label\]"/);
  assert.match(client, /replaceAllText\("\[data-run-presentation-summary\]"/);
  assert.match(client, /replaceAllText\("\[data-run-presentation-progress\]"/);
  assert.match(presentation, /failureStatuses = new Set\(\["failed", "budget_exhausted"\]\)/);
  assert.match(presentation, /run\.state === "needs-attention" \|\| run\.state === "stopped"/);
  assert.match(client, /room\.activeRunId !== activeRunId[\s\S]{0,900}connect\(\)/);
  assert.match(view, /data-run-presentation-label/);
  assert.match(view, /data-run-presentation-summary/);
  assert.match(view, /data-run-presentation-progress/);
  assert.match(view, /data-run-presence/);
  assert.match(view, /committedUsageNote: Boolean\(codingCommittedUsageNote\(options\.state, options\.job\)\)/);
  assert.match(view, /status: codingRunDeliveryState\(options\.state, options\.job\)/);
  assert.match(view, /data-coding-proposal-count/);
  assert.match(view, /data-coding-response-count/);
  assert.match(view, /data-coding-endorsement-count/);
  assert.match(moduleSource, /outputKeys: \[\.\.\.new Set\(/);
  assert.match(moduleSource, /name: "my_roster_collaboration_summaries"/);
});
