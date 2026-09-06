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

test("SpacetimeDB owns private workspace node continuity authority", async () => {
  const source = await read("spacetimedb/src/index.ts");
  for (const tableName of [
    "roster_workspace_node",
    "roster_node_continuity",
    "roster_node_inbox_item",
    "roster_node_wake",
    "roster_node_commitment",
    "roster_node_continuity_event",
    "roster_node_wake_schedule",
  ]) {
    const declaration = section(source, `name: "${tableName}"`, "},");
    assert.doesNotMatch(declaration, /public:\s*true/, `${tableName} must remain private`);
  }
  assert.match(source, /scheduled:[^\n]+dispatchRosterNodeWake/);
});

test("delivery and wake request share one reducer transaction and dispatch through the generic job queue", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const jobFailure = section(
    source,
    "const failRosterNodeWakeForJob",
    "export const completeRosterJob",
  );
  assert.match(jobFailure, /status: "failed"/);
  assert.match(jobFailure, /continueRosterNodeWakeInternal/);
  const delivery = section(
    source,
    "export const deliverRosterNodeInbox",
    "export const requestRosterNodeWake",
  );
  assert.match(delivery, /ctx\.db\.rosterNodeInboxItem\.insert/);
  assert.match(delivery, /requestRosterNodeWakeInternal/);
  assert.match(delivery, /requestWake/);

  const dispatch = section(
    source,
    "export const dispatchRosterNodeWake",
    "export const admitRosterNodeWake",
  );
  assert.match(dispatch, /enqueueRosterNodeWakeJob/);
  assert.match(source, /agentId:\s*policy\.wakeAgentId/);
  assert.match(source, /sessionKey = `node-continuity:/);
});

test("node wake admission and completion are fenced by generic job authority", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const admission = section(
    source,
    "export const admitRosterNodeWake",
    "export const completeRosterNodeWake",
  );
  assert.match(admission, /requireActiveRosterJobLease/);
  assert.match(admission, /activeWakeId !== wake\.id/);

  const completion = section(
    source,
    "export const completeRosterNodeWake",
    "export const failRosterNodeWake",
  );
  assert.match(completion, /job\.status !== "completed"/);
  assert.match(completion, /consumedDeliveryIdsJson/);
  assert.match(completion, /!bound\.has\(deliveryId\)/);
  assert.match(completion, /continueRosterNodeWakeInternal/);
  const failure = section(
    source,
    "export const failRosterNodeWake",
    "export const resolveFailedRosterNodeWake",
  );
  assert.match(failure, /status: "failed"/);
  assert.match(failure, /continueRosterNodeWakeInternal/);
  const jobCompletion = section(
    source,
    "export const completeRosterJob",
    "export const failRosterJob",
  );
  assert.match(jobCompletion, /completeRosterNodeWakeForJob/);
  const resolution = section(
    source,
    "export const resolveFailedRosterNodeWake",
    "export const suspendRosterNodeContinuity",
  );
  assert.match(resolution, /wake\.status !== "failed"/);
  assert.match(resolution, /failed node wake resolution requires its terminal failed job/);
  assert.match(resolution, /continuity\.lastWakeId !== wake\.id/);
  assert.match(resolution, /item\.status !== "failed"/);
  assert.match(resolution, /item\.wakeId !== wake\.id/);
  assert.match(resolution, /status: "consumed"/);
  assert.match(resolution, /type: "node\.wake\.resolved"/);
});

test("wake manifests isolate one bounded room lane and busy delivery stays durable", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const request = section(source, "const requestRosterNodeWakeInternal", "/** Register or revise");
  assert.match(request, /item\.laneId === head\.laneId/);
  assert.match(request, /slice\(0, policy\.maxInboxItemsPerWake\)/);
  assert.match(request, /laneId: head\.laneId/);
  assert.match(request, /budgetResetAtMs/);
  assert.match(request, /continuity\.wakeWindowStartedAtMs \+ BigInt\(policy\.wakeWindowMs\)/);
  assert.doesNotMatch(request, /exhausted its wake budget/);
  const delivery = section(source, "export const deliverRosterNodeInbox", "export const requestRosterNodeWake");
  assert.match(delivery, /!continuity\.activeWakeId/);
  assert.match(delivery, /ctx\.db\.rosterNodeInboxItem\.insert/);
  assert.doesNotMatch(delivery, /wakesInWindow < policy\.maxWakesPerWindow/);
});

test("room-lane columns remain append-only and defaulted for customer upgrades", async () => {
  const source = await read("spacetimedb/src/index.ts");
  const inbox = section(source, "const rosterNodeInboxItem", "/** One bounded episodic");
  const wake = section(source, "const rosterNodeWake", "/** Typed durable commitments");
  for (const declaration of [inbox, wake]) {
    assert.match(declaration, /createdAt:[\s\S]*laneId:\s*t\.string\(\)\.default\(""\)\.index\("btree"\)/);
    assert.match(declaration, /laneId:[\s\S]*roomId:\s*t\.string\(\)\.default\(""\)/);
    assert.match(declaration, /roomId:[\s\S]*runId:\s*t\.string\(\)\.default\(""\)/);
  }
});

test("continuity detail uses caller-scoped projections instead of public authority tables", async () => {
  const source = await read("spacetimedb/src/index.ts");
  for (const view of [
    "myRosterWorkspaceNodes",
    "myRosterNodeContinuities",
    "myRosterNodeInboxItems",
    "myRosterNodeWakes",
    "myRosterNodeCommitments",
    "myRosterNodeContinuityEvents",
  ]) assert.match(source, new RegExp(`export const ${view} = spacetimedb\\.view`));
  assert.match(source, /ctx\.db\.rosterWorkspaceMember\.member\.filter\(ctx\.sender\)/);
});
