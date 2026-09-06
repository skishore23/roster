import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (relativePath: string): Promise<string> =>
  fs.readFile(path.join(ROOT, relativePath), "utf8");

const section = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
};

test("Room OS declares private normalized control, context, reservation, and shared-workspace tables", async () => {
  const source = await read("spacetimedb/src/index.ts");
  for (const tableName of [
    "roster_room",
    "roster_room_node",
    "roster_participant_profile",
    "roster_room_timeline_entry",
    "roster_room_control_intent",
    "roster_context_frontier",
    "roster_task_context_manifest",
    "roster_runtime_binding",
    "roster_model_reservation",
    "roster_projection_outbox",
    "roster_shared_workspace_update",
    "roster_shared_workspace_checkpoint",
  ]) {
    const declaration = section(
      source,
      `name: "${tableName}"`,
      "},",
    );
    assert.doesNotMatch(declaration, /public:\s*true/, `${tableName} must not expose raw rows`);
  }
});

test("participant profiles are workspace-wide, conflict-safe, and caller-scoped", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const reducer = section(
    source,
    "export const saveRosterParticipantProfile",
    "export const ensureRosterExecution",
  );
  assert.match(reducer, /requireWorkspaceMembership\(ctx, workspaceId, \["owner", "coordinator", "viewer"\]\)/);
  assert.match(reducer, /currentRevision !== args\.expectedRevision/);
  assert.match(reducer, /ctx\.db\.rosterParticipantProfile\.(?:insert|id\.update)/);
  assert.match(source, /export const myRosterParticipantProfiles = spacetimedb\.view/);
  assert.match(source, /ctx\.db\.rosterWorkspaceMember\.member\.filter\(ctx\.sender\)/);
  assert.match(source, /ctx\.db\.rosterParticipantProfile\.workspaceId\.filter\(membership\.workspaceId\)/);
});

test("job cancel and command authority cannot be borrowed from an unrelated worker membership", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const cancel = section(
    source,
    "export const cancelRosterJob",
    "export const queueRosterJobCommand",
  );
  const command = section(
    source,
    "export const queueRosterJobCommand",
    "export const consumeRosterJobCommands",
  );

  for (const mutation of [cancel, command]) {
    assert.doesNotMatch(
      mutation,
      /requireWorkspaceMembership\([^;]+["']worker["']/s,
      "an arbitrary workspace worker must not control another worker's job",
    );
    assert.match(
      mutation,
      /requireWorkspaceMembership\([^;]+["']owner["'][^;]+["']coordinator["']|requireActiveRosterJobLease|requireRosterJobMutationAuthority/s,
      "job mutation requires owner/coordinator authority or the exact active job lease",
    );
    assert.match(mutation, /requireRosterJob|requireActiveRosterJobLease|requireRosterJobMutationAuthority/);
  }
});

test("one Spacetime reducer initializes the complete execution graph idempotently", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const initializer = section(
    source,
    "export const initializeRosterExecution",
    "export const ensureRosterExecution",
  );

  for (const input of [
    "idempotencyKey",
    "room",
    "run",
    "policy",
    "nodes",
    "runtimeBindings",
    "seedTasks",
    "contextFrontier",
  ]) assert.match(initializer, new RegExp(input));

  for (const table of [
    "rosterRoom",
    "rosterRoomNode",
    "rosterExecution",
    "rosterRuntimeBinding",
    "rosterContextFrontier",
  ]) assert.match(initializer, new RegExp(`ctx\\.db\\.${table}\\.(?:insert|update)`));
  assert.match(initializer, /insertRosterTaskDefinition/);

  assert.match(initializer, /idempotency/i);
  assert.match(initializer, /conflict|different|mismatch/i);
});

test("task start persists the exact context manifest in the same reducer transaction", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const startTask = section(
    source,
    "export const startRosterTask",
    "export const acceptRosterTaskOutcome",
  );

  assert.match(startTask, /contextManifest/i);
  assert.match(startTask, /ctx\.db\.rosterTaskContextManifest\.insert/);
  for (const field of [
    "runId",
    "taskId",
    "nodeId",
    "attempt",
    "fence",
    "frontierVersion",
    "topologyVersion",
    "catalogVersion",
    "runtimeBinding",
  ]) assert.match(startTask, new RegExp(field));
});

test("model calls are reserved before execution and uncertain reservations cannot be silently released", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const reserve = section(
    source,
    "export const reserveRosterModelCall",
    "export const settleRosterModelReservation",
  );
  const settle = section(
    source,
    "export const settleRosterModelReservation",
    "export const startRosterTask",
  );

  assert.match(reserve, /ctx\.db\.rosterModelReservation\.insert/);
  assert.match(reserve, /reserved/);
  assert.match(settle, /uncertain/);
  assert.match(settle, /settled/);
  assert.match(settle, /requireActiveRosterTaskLease|requireRosterCoordinator/);
  assert.doesNotMatch(
    settle,
    /status:\s*["']released["'][\s\S]{0,300}(?:uncertain|provider)/,
    "provider uncertainty must not become an ordinary released reservation",
  );
});

test("shared-workspace publication validates every graph fence before admitting bounded updates", async () => {
  const [moduleSource, adapterSource, serverSource] = await Promise.all([
    read("spacetimedb/src/index.ts"),
    read("src/engine/workspace/spacetimedb-shared-workspace.ts"),
    read("src/server.ts"),
  ]);
  const publish = section(
    moduleSource,
    "export const publishRosterSharedWorkspaceUpdate",
    "export const checkpointRosterSharedWorkspace",
  );

  for (const field of [
    "runId",
    "taskId",
    "nodeId",
    "fence",
    "frontierVersion",
    "topologyVersion",
    "catalogVersion",
    "runtimeBinding",
  ]) assert.match(publish, new RegExp(field));
  assert.match(publish, /max.*(?:bytes|entries)|bounded|too large/i);
  assert.match(publish, /requireActiveRosterTaskLease/);
  assert.match(publish, /ctx\.db\.rosterSharedWorkspaceUpdate\.insert/);

  assert.match(adapterSource, /SharedWorkspaceLedger/);
  assert.match(adapterSource, /publishRosterSharedWorkspaceUpdate/);
  assert.match(adapterSource, /checkpointRosterSharedWorkspace/);
  assert.match(serverSource, /Spacetime.*SharedWorkspace/i);
  assert.doesNotMatch(
    serverSource,
    /new FileSystemSharedWorkspace/,
    "production server must not use process-local filesystem workspace durability",
  );
});

test("Room OS exposes caller-scoped normalized views instead of a JSON execution snapshot", async () => {
  const source = await read("spacetimedb/src/index.ts");
  for (const [label, pattern] of [
    ["rooms", /name: ["']my_roster_rooms["']/],
    ["nodes", /name: ["']my_roster_(?:room_)?nodes["']/],
    ["timeline entries", /name: ["']my_roster_(?:room_)?timeline_entries["']/],
    ["control intents", /name: ["']my_roster_(?:room_)?control_intents["']/],
    ["context frontiers", /name: ["']my_roster_context_frontiers["']/],
    ["task context manifests", /name: ["']my_roster_task_context_manifests["']/],
    ["runtime bindings", /name: ["']my_roster_runtime_bindings["']/],
    ["model reservations", /name: ["']my_roster_model_reservations["']/],
    ["projection outbox", /name: ["']my_roster_projection_outbox["']/],
    ["workspace updates", /name: ["']my_roster_shared_workspace_updates["']/],
    ["workspace checkpoints", /name: ["']my_roster_shared_workspace_checkpoints["']/],
    ["execution summaries", /name: ["']my_roster_execution_summaries["']/],
    ["tasks", /name: ["']my_roster_tasks["']/],
    ["task edges", /name: ["']my_roster_task_edges["']/],
    ["task outcomes", /name: ["']my_roster_task_outcomes["']/],
    ["task expansions", /name: ["']my_roster_task_expansions["']/],
    ["task output references", /name: ["']my_roster_task_output_references["']/],
  ] as const) assert.match(source, pattern, `missing normalized ${label} view`);

  assert.doesNotMatch(
    source,
    /name:\s*["']roster_execution_snapshot["']/,
    "the JSON-heavy execution snapshot must be removed after normalized cutover",
  );
  assert.match(source, /const rosterRoomControlIntentProjection = t\.row/);
  const privateIntentView = source.slice(
    source.indexOf("export const myRosterControlIntents"),
    source.indexOf("export const myRosterControlIntentDeliveries"),
  );
  assert.match(privateIntentView, /t\.array\(rosterRoomControlIntent\.rowType\)/);
  assert.match(privateIntentView, /membership\.role !== "owner" && membership\.role !== "coordinator"/);
  const deliveryView = source.slice(
    source.indexOf("export const myRosterControlIntentDeliveries"),
    source.indexOf("export const myRosterContextFrontiers"),
  );
  assert.match(deliveryView, /name: "my_roster_control_intent_deliveries"/);
  assert.match(deliveryView, /t\.array\(rosterRoomControlIntentProjection\)/);
  assert.doesNotMatch(deliveryView, /payloadJson|createdBy|consumedBy/);
});

test("typed timeline and context modules preserve explicit replay data", async () => {
  const [timeline, context] = await Promise.all([
    read("src/domains/room-timeline.ts"),
    read("src/domains/room-context.ts"),
  ]);

  for (const kind of [
    "message",
    "claim",
    "artifact",
    "decision",
    "handoff",
    "review",
    "checkpoint",
    "attention",
  ]) assert.match(timeline, new RegExp(`["']${kind}["']`));
  assert.match(timeline, /ROOM_TIMELINE_ENTRY_VERSION/);
  assert.match(timeline, /createRoomTimelineEntry/);
  assert.match(timeline, /validateRoomTimelineEntry/);

  assert.match(context, /ROOM_TASK_CONTEXT_MANIFEST_VERSION/);
  assert.match(context, /createRoomTaskContextManifest/);
  assert.match(context, /validateRoomTaskContextManifest/);
  for (const field of [
    "repository",
    "branch",
    "commit",
    "worktree",
    "runId",
    "taskId",
    "nodeId",
    "attempt",
    "fence",
    "frontierVersion",
    "topologyVersion",
    "catalogVersion",
    "runtimeBinding",
    "included",
    "excluded",
  ]) assert.match(context, new RegExp(field));
});
