import assert from "node:assert/strict";
import test from "node:test";

import {
  RosterFunctionDirectory,
  type RosterFunctionDescriptor,
} from "../../src/engine/functions/function-directory.ts";
import {
  ROSTER_TRIGGER_DEFINITION_VERSION,
  RosterTriggerRouter,
} from "../../src/engine/triggers/trigger-router.ts";

const FUNCTION: RosterFunctionDescriptor = {
  id: "index::refresh",
  version: "1",
  capability: "index",
  description: "Refresh one bounded index partition.",
  inputSchema: {
    type: "object",
    required: ["partition"],
    additionalProperties: false,
    properties: { partition: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    required: ["refreshed"],
    additionalProperties: false,
    properties: { refreshed: { type: "boolean" } },
  },
  effects: ["write"],
  requiredScopes: ["index:write"],
};

const NODE = {
  id: "indexer",
  name: "Indexer",
  capabilities: ["index"],
  runtime: { kind: "roster-native" as const },
};

test("trigger router discovers a reactive edge, authorizes it, and deduplicates delivery", async () => {
  let calls = 0;
  const directory = new RosterFunctionDirectory([FUNCTION]);
  directory.bindProvider({
    providerId: "index-worker",
    functionId: FUNCTION.id,
    epoch: 2,
    heartbeat: { observedAt: 100, ttlMs: 1_000 },
    invoke: async (value) => {
      calls += 1;
      assert.deepEqual(value, { partition: "docs" });
      return { refreshed: true };
    },
  });
  const router = new RosterTriggerRouter({ directory });
  router.register({
    schemaVersion: ROSTER_TRIGGER_DEFINITION_VERSION,
    triggerId: "refresh-on-document",
    version: "1",
    source: { kind: "state", key: "document.updated" },
    target: {
      functionId: FUNCTION.id,
      functionVersion: FUNCTION.version,
      action: { kind: "await" },
    },
    inputMode: "event",
    enabled: true,
  });

  const event = {
    eventId: "event-1",
    source: { kind: "state" as const, key: "document.updated" },
    value: { partition: "docs" },
    occurredAt: 110,
  };
  const access = {
    functionGrants: [FUNCTION.id],
    scopes: ["index:write"],
    allowedEffects: ["write"] as const,
  };
  const first = await router.route({ node: NODE, event, access });
  const replay = await router.route({ node: NODE, event, access });

  assert.equal(calls, 1);
  assert.deepEqual(replay, first);
  assert.equal(first[0]?.functionId, FUNCTION.id);
  assert.equal(first[0]?.providerId, "index-worker");
  assert.equal(first[0]?.status, "completed");
  assert.equal(router.catalog().triggers[0]?.triggerId, "refresh-on-document");
});

test("trigger registration pins the target function version", () => {
  const directory = new RosterFunctionDirectory([FUNCTION]);
  const router = new RosterTriggerRouter({ directory });
  assert.throws(() => router.register({
    schemaVersion: ROSTER_TRIGGER_DEFINITION_VERSION,
    triggerId: "stale-trigger",
    version: "1",
    source: { kind: "queue", key: "index-jobs" },
    target: {
      functionId: FUNCTION.id,
      functionVersion: "0",
      action: { kind: "enqueue" },
    },
    inputMode: "event",
    enabled: true,
  }), /requires unavailable index::refresh@0/);
});
