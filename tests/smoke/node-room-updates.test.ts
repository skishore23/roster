import assert from "node:assert/strict";
import test from "node:test";

import {
  NODE_ROOM_UPDATE_RECIPIENT_LIMIT,
  NODE_ROOM_UPDATE_TASK_LIMIT,
  NODE_ROOM_UPDATE_TEXT_LIMIT,
  NODE_ROOM_UPDATE_SCHEMA,
  NodeRoomUpdateStore,
  NodeRoomUpdateValidationError,
} from "../../src/engine/runtime/node-room-updates.ts";

const FIXED_TIME = "2026-08-26T20:00:00.000Z";
const context = {
  runId: "run-1",
  taskId: "task-1",
  executionId: "execution-1",
  nodeId: "kai",
};

const createStore = () => new NodeRoomUpdateStore({ now: () => FIXED_TIME });

const progress = (updateKey: string, text = "Tracing the streaming path.") => ({
  updateKey,
  text,
  intent: "progress" as const,
  recipientNodeIds: ["mira"],
});

test("normalizes and replaces a node room update without consuming another task slot", () => {
  const store = createStore();
  const first = store.post(context, {
    updateKey: "working",
    text: "  I’m tracing the streaming path now.  ",
    intent: "progress",
    recipientNodeIds: ["  zara ", "mira", " zara", "mira "],
  });
  const replacement = store.post(context, {
    updateKey: "working",
    text: "The stream is isolated; I’m validating reconnect behavior.",
    intent: "progress",
    recipientNodeIds: ["mira"],
  });

  assert.equal(first.schema, NODE_ROOM_UPDATE_SCHEMA);
  assert.equal(first.updateId, replacement.updateId);
  assert.equal(first.sequence, 1);
  assert.equal(replacement.sequence, 2);
  assert.equal(replacement.at, FIXED_TIME);
  assert.equal(store.list("run-1").length, 1);
  assert.equal(store.list("run-1")[0]?.text, replacement.text);
  assert.deepEqual(first.recipientNodeIds, ["mira", "zara"]);
  assert.deepEqual(store.list("run-1")[0]?.recipientNodeIds, ["mira"]);
  assert.equal(Object.isFrozen(store.list("run-1")[0]), true);
  assert.equal(Object.isFrozen(store.list("run-1")[0]?.recipientNodeIds), true);

  store.post(context, progress("next"));
  store.post(context, progress("last"));
  assert.equal(store.list("run-1").length, NODE_ROOM_UPDATE_TASK_LIMIT);
});

test("rejects invalid node room updates and contexts", () => {
  const cases: Array<() => void> = [
    () => createStore().post(context, progress("working", "   ")),
    () => createStore().post(context, progress("working", "x".repeat(NODE_ROOM_UPDATE_TEXT_LIMIT + 1))),
    () => createStore().post(context, {
      ...progress("working"),
      recipientNodeIds: Array.from({ length: NODE_ROOM_UPDATE_RECIPIENT_LIMIT + 1 }, (_, index) => `node-${index}`),
    }),
    () => {
      const store = createStore();
      store.post(context, progress("first"));
      store.post(context, progress("second"));
      store.post(context, progress("third"));
      store.post(context, progress("fourth"));
    },
    () => createStore().post(context, progress("Invalid key")),
    () => createStore().post(context, { ...progress("working"), intent: "notice" as never }),
    () => createStore().post({ ...context, nodeId: " " }, progress("working")),
    () => createStore().post(context, progress("working", "contains\u0000control")),
  ];

  for (const submit of cases) {
    assert.throws(submit, NodeRoomUpdateValidationError);
  }
});

test("sends only run-scoped live updates to subscribers", () => {
  const store = createStore();
  store.post(context, progress("before-listen"));
  const received: string[] = [];
  const unsubscribe = store.subscribe("run-1", (event) => {
    received.push(`${event.type}:${event.update.runId}:${event.update.updateKey}`);
  });

  assert.deepEqual(received, []);
  store.post(context, progress("working"));
  store.post({ ...context, runId: "run-2" }, progress("other"));
  unsubscribe();
  store.post(context, progress("later"));

  assert.deepEqual(received, ["update:run-1:working"]);
});

test("sequences each run independently without exposing foreign activity", () => {
  const store = createStore();
  const ownFirst = store.post(context, progress("first"));
  const foreign = store.post({ ...context, runId: "run-foreign" }, progress("foreign"));
  const ownSecond = store.post({ ...context, taskId: "task-2" }, progress("second"));

  assert.equal(ownFirst.sequence, 1);
  assert.equal(foreign.sequence, 1);
  assert.equal(ownSecond.sequence, 2);
  assert.deepEqual(store.list("run-1").map((update) => update.sequence), [1, 2]);
});

test("bounds retained runs and updates and clears their sequence state", () => {
  const store = new NodeRoomUpdateStore({
    maxRuns: 2,
    maxUpdatesPerRun: 2,
    now: () => FIXED_TIME,
  });
  store.post(context, progress("run-one"));
  store.post({ ...context, runId: "run-2" }, progress("run-two"));
  store.post({ ...context, runId: "run-3" }, progress("run-three"));

  assert.deepEqual(store.list("run-1"), []);
  store.post({ ...context, runId: "run-2", taskId: "task-2" }, progress("second"));
  store.post({ ...context, runId: "run-2", taskId: "task-3" }, progress("third"));
  assert.deepEqual(store.list("run-2").map((update) => update.updateKey), ["second", "third"]);
  assert.deepEqual(store.list("run-2").map((update) => update.sequence), [2, 3]);

  store.clear("run-2");
  assert.deepEqual(store.list("run-2"), []);
  assert.equal(store.post({ ...context, runId: "run-2" }, progress("after-clear")).sequence, 1);
  store.clear();
  assert.deepEqual(store.list("run-2"), []);
  assert.deepEqual(store.list("run-3"), []);
});

test("pins subscribed run history until unsubscribe makes it evictable", () => {
  const store = new NodeRoomUpdateStore({
    maxRuns: 1,
    now: () => FIXED_TIME,
  });
  const first = store.post(context, progress("first"));
  const received: number[] = [];
  const unsubscribe = store.subscribe("run-1", (event) => {
    received.push(event.update.sequence);
  });

  store.post({ ...context, runId: "run-2" }, progress("foreign"));
  const second = store.post({ ...context, taskId: "task-2" }, progress("second"));

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(store.list("run-1").map((update) => update.sequence), [1, 2]);
  assert.deepEqual(store.list("run-2").map((update) => update.sequence), [1]);
  assert.deepEqual(received, [2]);

  unsubscribe();
  assert.deepEqual(store.list("run-1"), []);
  assert.deepEqual(store.list("run-2").map((update) => update.sequence), [1]);
  store.post({ ...context, runId: "run-3" }, progress("later"));
  assert.deepEqual(store.list("run-2"), []);
  assert.deepEqual(store.list("run-3").map((update) => update.sequence), [1]);
});

test("settles progress and acknowledgement but leaves questions visible", () => {
  const store = createStore();
  const received: Array<{ type: string; updateKey: string }> = [];
  store.subscribe("run-1", (event) => {
    received.push({ type: event.type, updateKey: event.update.updateKey });
  });
  store.post(context, progress("working"));
  store.post(context, {
    updateKey: "received",
    text: "I have the handoff.",
    intent: "acknowledgement",
    recipientNodeIds: [],
  });
  store.post(context, {
    updateKey: "decision-needed",
    text: "Should I reconnect now?",
    intent: "question",
    recipientNodeIds: ["mira"],
  });

  store.settleTask("run-1", "task-1");

  assert.deepEqual(store.list("run-1").map((update) => ({
    updateKey: update.updateKey,
    settled: update.settled,
  })), [
    { updateKey: "working", settled: true },
    { updateKey: "received", settled: true },
    { updateKey: "decision-needed", settled: true },
  ]);
  assert.deepEqual(received, [
    { type: "update", updateKey: "working" },
    { type: "update", updateKey: "received" },
    { type: "update", updateKey: "decision-needed" },
    { type: "settled", updateKey: "working" },
    { type: "settled", updateKey: "received" },
    { type: "settled", updateKey: "decision-needed" },
  ]);
});
