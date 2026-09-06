import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const source = (file: string): Promise<string> =>
  fs.readFile(path.join(ROOT, file), "utf8");

test("Canvas production paths use SpacetimeDB without state polling or event streams", async () => {
  const [route, runtime, browser, workflow] = await Promise.all([
    source("src/agents/canvas.agent.ts"),
    source("src/adapters/spacetimedb-canvas-runtime.ts"),
    source("src/browser/canvas-client.ts"),
    source("src/agents/canvas.ts"),
  ]);

  assert.match(route, /createSpacetimeCanvasRuntime/);
  assert.match(route, /createCanvasRun/);
  assert.match(route, /createViewerCapability/);
  assert.match(route, /claimRosterTask/);
  assert.match(route, /heartbeatRosterTask/);
  assert.match(route, /acceptRosterTaskOutcome/);
  assert.match(route, /finalizeCanvasRun/);
  assert.match(route, /#\$\{fragment\.toString\(\)\}/);
  assert.match(runtime, /projectCanvasEvent/);
  assert.match(runtime, /coordinatorFence/);
  assert.match(runtime, /task\.graph\.projected/);
  assert.doesNotMatch(runtime, /plan\.(?:created|started|completed|failed|rejected)/);
  assert.doesNotMatch(runtime, /task\.(?:delegated|started|completed|failed)/);
  assert.match(workflow, /timeoutMs: CANVAS_DELIBERATION_TIMEOUT_MS/);
  assert.match(workflow, /export const CANVAS_DELIBERATION_TIMEOUT_MS = 0/);

  for (const productionPath of [route, runtime, browser]) {
    assert.doesNotMatch(productionPath, /\/canvas\/(?:state|stream)\b/);
    assert.doesNotMatch(productionPath, /\bEventSource\b/);
  }
});

test("Canvas browser joins by capability and subscribes directly to safe run views", async () => {
  const browser = await source("src/browser/canvas-client.ts");

  assert.match(browser, /from "\.\.\/spacetimedb-bindings\/index\.js"/);
  assert.match(browser, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(browser, /history\.replaceState/);
  assert.match(browser, /fetch\("\/canvas\/run-token"/);
  assert.match(browser, /HTMLFormElement\.prototype\.submit\.call\(form\)/);
  assert.match(browser, /reducers\.joinCanvasRun\(\{ runId, capabilityHash \}\)/);
  assert.match(browser, /reducers\.joinWorkspace\(\{ workspaceId: boot\.realtime\.workspaceId, capabilityHash: workspaceCapabilityHash \}\)/);
  assert.match(browser, /reducers\.joinCanvasWorkspaceRun\(\{ workspaceId: boot\.realtime\.workspaceId, runId \}\)/);
  assert.match(browser, /tables\.myCanvasFleetRuns\.where\(\(row\) => row\.workspaceId\.eq/);
  assert.match(browser, /id="canvas-run-list"|"canvas-run-list"/);
  assert.match(browser, /subscriptionBuilder\(\)/);
  assert.match(browser, /\.onApplied\(/);
  assert.match(browser, /\.onInsert\(/);
  assert.match(browser, /\.onUpdate\(/);
  assert.match(browser, /\.onDelete\(/);

  for (const safeView of [
    "myCanvasRunUi",
    "myScenePlan",
    "myCanvasAgents",
    "myCanvasTaskStatuses",
    "mySceneObjects",
    "mySceneReviews",
    "myCanvasActivity",
    "myCanvasReplaySteps",
  ]) {
    assert.match(browser, new RegExp(`tables\\.${safeView}\\.where\\(`), `missing run query for ${safeView}`);
  }

  for (const operatorView of ["myCanvasRuns", "myRunMembers", "myRosterTasks", "myReceipts", "myScenePatches"]) {
    assert.doesNotMatch(browser, new RegExp(`tables\\.${operatorView}\\b`), `browser must not query ${operatorView}`);
  }

  assert.match(browser, /if \(step\.supersedesPatchId\) active\.delete\(step\.supersedesPatchId\)/);
  assert.match(browser, /active\.add\(step\.patchId\)/);
  assert.match(browser, /replayCursorSeq === null \? row\.active : replayPatches\.has\(row\.patchId\)/);
  assert.match(browser, /setInterval\(\(\) => \{\s*renderLiveness\(\);\s*renderStudioFloor\(\);/);
  assert.match(browser, /No durable agent update for/);
  assert.match(browser, /model call may be in flight/);
  assert.match(browser, /latestActivityByAgent/);
  assert.match(browser, /displayAgentStatus/);
  assert.match(browser, /terminalRunStatuses\.has\(run\.status\)\s*\?\s*run\.status\s*:\s*run\.uiStatus/);
  assert.match(browser, /This durable run was canceled\. Start a new brief to continue\./);
  assert.match(browser, /"Retry as New Run"/);
  assert.match(browser, /const active = terminal \? 0/);
  assert.match(browser, /data-replay-state", "replay"/);
  assert.match(browser, /existing\.style\.display = "none"/);
  assert.match(browser, /node\.style\.removeProperty\("display"\)/);
  assert.match(browser, /const ensureGradient =/);
  assert.match(browser, /kind !== "linear-gradient" && kind !== "radial-gradient"/);
  assert.match(browser, /stops\.length < 2 \|\| stops\.length > 4/);
  assert.match(browser, /node\.setAttribute\("fill", `url\(#\$\{id\}\)`\)/);
  assert.match(browser, /"polyline"/);
  assert.doesNotMatch(browser, /innerHTML\s*=/, "Canvas paint resources must be constructed through typed DOM APIs");
  assert.doesNotMatch(browser, /createdAt\s*<=\s*.*updatedAt/, "Canvas replay must use exact receipt sequence, not timestamp heuristics");
});

test("SpacetimeDB module keeps viewer projections separate from operator data", async () => {
  const moduleSource = await source("spacetimedb/src/index.ts");

  for (const publicView of [
    "my_canvas_run_ui",
    "my_scene_plan",
    "my_scene_plan_parts",
    "my_canvas_agents",
    "my_canvas_task_statuses",
    "my_scene_objects",
    "my_scene_reviews",
    "my_canvas_activity",
    "my_canvas_replay_steps",
  ]) {
    assert.match(moduleSource, new RegExp(`name: ["']${publicView}["']`), `missing safe view ${publicView}`);
  }

  assert.match(moduleSource, /membership\.role === "viewer"\) continue/);
  assert.match(moduleSource, /viewer \? "\{\}" : agent\.metadataJson/);
  assert.match(moduleSource, /viewer \? "" : object\.taskId/);
  assert.match(moduleSource, /export const joinCanvasRun/);
  assert.match(moduleSource, /export const joinCanvasWorkspaceRun/);
  assert.match(moduleSource, /requireWorkspaceMembership\(ctx, workspaceId, \["owner", "coordinator", "worker", "viewer"\]\)/);
  assert.match(moduleSource, /Canvas run \$\{runId\} does not belong to workspace \$\{workspaceId\}/);
  assert.match(moduleSource, /export const projectCanvasEvent/);
  assert.match(
    moduleSource,
    /requireActiveRosterTaskLease\(\s*ctx,\s*runId,\s*coordinatorTaskId,\s*args\.coordinatorFence\s*\)/,
  );
  assert.match(moduleSource, /args\.expectedPrev\.length > 256 \|\| args\.expectedPrev === "\*"/);
  assert.match(moduleSource, /eventHash must be a lowercase SHA-256 hex digest/);
  assert.match(moduleSource, /const isDelegatedFinishingRepair = projectedAgent\.role === "composer"/);
  assert.match(moduleSource, /projectedTask\.capability === "compose\.final"/);
  assert.match(moduleSource, /const isFencedFinishingRepairTask = \/\^repair/);
  assert.match(moduleSource, /projectedTask\.agentId !== agentId/);
  assert.match(moduleSource, /if \(assignedPartId !== partId && !isDelegatedFinishingRepair\)/);
  assert.doesNotMatch(moduleSource, /recoverCanvasCoordinatorTask/);
  const heartbeatReducer = moduleSource.slice(
    moduleSource.indexOf("export const heartbeatRosterTask"),
    moduleSource.indexOf("export const startRosterTask")
  );
  assert.match(heartbeatReducer, /requireActiveRosterTaskLease/);
  assert.match(heartbeatReducer, /rosterTaskLeaseExpiry\.insert/);
  assert.doesNotMatch(heartbeatReducer, /canvasTaskStatus|canvasAgent|canvasRunDetail/);

  const replayProjection = moduleSource.slice(
    moduleSource.indexOf('const canvasReplayStepProjection = t.row("CanvasReplayStepProjection"'),
    moduleSource.indexOf("type CanvasReplayFields")
  );
  assert.match(replayProjection, /seq: t\.u64\(\)/);
  assert.match(replayProjection, /patchId: t\.string\(\)/);
  assert.match(replayProjection, /supersedesPatchId: t\.string\(\)/);
  assert.match(replayProjection, /partId: t\.string\(\)/);
  assert.match(replayProjection, /status: t\.string\(\)/);
  assert.match(replayProjection, /objectCount: t\.u32\(\)/);
  assert.doesNotMatch(replayProjection, /payloadJson|actor|taskKey|contentRef|modelReservation/);
  assert.match(moduleSource, /const fields = canvasReplayFields\(event\.kind, event\.payloadJson\)/);
  assert.match(moduleSource, /if \(!CANVAS_REPLAY_KINDS\.has\(event\.kind\)\) continue/);
  const replayKinds = moduleSource.match(/const CANVAS_REPLAY_KINDS = new Set\(\[[\s\S]*?\]\);/)?.[0] ?? "";
  assert.ok(replayKinds, "missing bounded Canvas replay-kind allowlist");
  assert.doesNotMatch(replayKinds, /viewer|capability|membership|reservation/);
});

test("generated Canvas replay binding contains only the safe browser contract", async () => {
  const binding = await source("src/spacetimedb-bindings/my_canvas_replay_steps_table.ts");

  for (const field of [
    "seq",
    "kind",
    "agentId",
    "label",
    "patchId",
    "supersedesPatchId",
    "partId",
    "status",
    "objectCount",
    "createdAt",
  ]) {
    assert.match(binding, new RegExp(`\\b${field}:`), `missing replay field ${field}`);
  }
  assert.doesNotMatch(binding, /payloadJson|actor|taskKey|contentRef|modelReservation/);
});
