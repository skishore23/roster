import assert from "node:assert/strict";
import test from "node:test";

import {
  RosterFunctionDirectory,
  type RosterFunctionDescriptor,
} from "../../src/sdk/capabilities.ts";
import { defineRosterPlatform } from "../../src/sdk/orchestration.ts";
import {
  ROSTER_CAPABILITY_CATALOG_VERSION,
} from "../../src/engine/functions/function-directory.ts";

const SEARCH_FUNCTION: RosterFunctionDescriptor = {
  id: "repository::search",
  version: "1",
  capability: "inspect",
  description: "Search a repository for one bounded query.",
  inputSchema: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: { query: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["matches"],
    additionalProperties: false,
    properties: {
      matches: { type: "array", items: { type: "string" } },
    },
  },
  effects: ["read"],
  idempotency: "supported",
  defaultTimeoutMs: 1_000,
};

const WRITE_FUNCTION: RosterFunctionDescriptor = {
  id: "repository::write",
  version: "1",
  capability: "inspect",
  description: "Write one repository file.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  effects: ["write", "external"],
  requiredScopes: ["repository:write"],
};

const NODE = {
  id: "inspector",
  name: "Inspector",
  capabilities: ["inspect"],
  runtime: { kind: "roster-native" as const, profile: "function.inspector" },
};

test("Roster platforms expose versioned function contracts without changing node identity", () => {
  const platform = defineRosterPlatform({
    id: "function-roster",
    version: "1",
    policyVersion: "function-policy-v1",
    coordinatorId: "inspector",
    coordinatorCapability: "inspect",
    capabilities: [{ id: "inspect", description: "Inspect bounded inputs." }],
    functions: [SEARCH_FUNCTION],
    nodes: [NODE],
    maxNodes: 1,
    policy: {
      maxTasks: 2,
      maxDepth: 1,
      maxFanout: 2,
      maxInflight: 1,
      maxReady: 2,
      maxBlocked: 2,
      maxAttempts: 1,
      maxContextBytes: 1_000_000,
      maxCostMicros: 1_000_000,
      maxTokens: 10_000,
      maxWallTimeMs: 10_000,
    },
  });

  assert.ok(platform.definition.functions?.some((descriptor) => descriptor.id === "repository::search"));
  assert.equal(new RosterFunctionDirectory(platform.definition.functions).descriptor("repository::search").version, "1");
  assert.equal(platform.registry.node("inspector").id, "inspector");

  assert.throws(() => defineRosterPlatform({
    id: "invalid-function-roster",
    version: "1",
    policyVersion: "function-policy-v1",
    coordinatorId: "inspector",
    coordinatorCapability: "inspect",
    capabilities: [{ id: "inspect", description: "Inspect bounded inputs." }],
    functions: [{ ...SEARCH_FUNCTION, capability: "unknown" }],
    nodes: [NODE],
    maxNodes: 1,
    policy: platform.definition.policy,
  }), /references unknown capability unknown/);
});

test("catalog grants are independent of task capabilities while scopes and effects stay enforced", () => {
  const directory = new RosterFunctionDirectory([SEARCH_FUNCTION, WRITE_FUNCTION]);
  directory.bindProvider({
    providerId: "search-worker",
    functionId: SEARCH_FUNCTION.id,
    epoch: 1,
    invoke: async () => ({ matches: [] }),
  });
  directory.bindProvider({
    providerId: "write-worker",
    functionId: WRITE_FUNCTION.id,
    epoch: 1,
    invoke: async () => ({}),
  });

  assert.deepEqual(directory.searchCatalog({ node: NODE, query: "repository" }).entries.map((entry) => entry.id), []);
  assert.deepEqual(directory.searchCatalog({
    node: { ...NODE, capabilities: ["coordinate"] },
    query: "repository",
    access: { functionGrants: [SEARCH_FUNCTION.id] },
  }).entries.map((entry) => entry.id), ["repository::search"]);
  assert.deepEqual(directory.searchCatalog({
    node: NODE,
    query: "repository",
    access: {
      functionGrants: [SEARCH_FUNCTION.id, WRITE_FUNCTION.id],
      scopes: ["repository:write"],
      allowedEffects: ["read", "write", "external"],
    },
  }).entries.map((entry) => entry.id), ["repository::search", "repository::write"]);
  assert.deepEqual(directory.searchCatalog({
    node: NODE,
    query: "repository",
    access: {
      functionGrants: [WRITE_FUNCTION.id],
      scopes: ["repository:write"],
      allowedEffects: ["read"],
    },
  }).entries, []);
});

test("capability catalog searches compact authorized entries and pins live provider epochs", () => {
  const directory = new RosterFunctionDirectory([SEARCH_FUNCTION, WRITE_FUNCTION]);
  directory.bindProvider({
    providerId: "search-worker",
    functionId: SEARCH_FUNCTION.id,
    epoch: 1,
    heartbeat: { observedAt: 100, ttlMs: 20 },
    invoke: async () => ({ matches: [] }),
  });
  directory.bindProvider({
    providerId: "write-worker",
    functionId: WRITE_FUNCTION.id,
    epoch: 1,
    heartbeat: { observedAt: 100, ttlMs: 20 },
    invoke: async () => ({}),
  });

  const search = directory.searchCatalog({
    node: NODE,
    access: { functionGrants: [SEARCH_FUNCTION.id, WRITE_FUNCTION.id] },
    query: "repository",
    limit: 4,
    now: 110,
  });
  assert.equal(search.schemaVersion, ROSTER_CAPABILITY_CATALOG_VERSION);
  assert.deepEqual(search.entries.map((entry) => entry.id), [SEARCH_FUNCTION.id]);
  assert.equal("inputSchema" in (search.entries[0] ?? {}), false);
  assert.deepEqual(search.entries[0]?.providers, [{
    providerId: "search-worker",
    epoch: 1,
    observedAt: 100,
    expiresAt: 120,
  }]);

  const projection = directory.projectCatalog({
    node: NODE,
    access: { functionGrants: [SEARCH_FUNCTION.id] },
    functionIds: [SEARCH_FUNCTION.id],
    now: 110,
  });
  assert.equal(projection.tools[0]?.id, SEARCH_FUNCTION.id);
  assert.deepEqual(projection.tools[0]?.inputSchema, SEARCH_FUNCTION.inputSchema);
  assert.equal(projection.providers[SEARCH_FUNCTION.id]?.epoch, 1);
  const description = directory.describeCatalog({
    node: NODE,
    access: { functionGrants: [SEARCH_FUNCTION.id] },
    snapshot: search,
    functionId: SEARCH_FUNCTION.id,
    functionVersion: SEARCH_FUNCTION.version,
    providerId: "search-worker",
    providerEpoch: 1,
    now: 110,
  });
  assert.equal(description.searchCatalogVersion, search.catalogVersion);
  assert.equal(description.tool.id, SEARCH_FUNCTION.id);
  assert.deepEqual(description.tool.inputSchema, SEARCH_FUNCTION.inputSchema);
  assert.equal(description.provider.providerId, "search-worker");

  assert.deepEqual(directory.searchCatalog({
    node: NODE,
    access: { functionGrants: [SEARCH_FUNCTION.id] },
    query: "repository",
    now: 120,
  }).entries, []);
  assert.throws(() => directory.projectCatalog({
    node: NODE,
    access: { functionGrants: [WRITE_FUNCTION.id] },
    functionIds: [WRITE_FUNCTION.id],
    now: 110,
  }), /not available in the authorized capability catalog/);
  assert.throws(() => directory.describeCatalog({
    node: NODE,
    access: { functionGrants: [WRITE_FUNCTION.id] },
    snapshot: search,
    functionId: SEARCH_FUNCTION.id,
    functionVersion: SEARCH_FUNCTION.version,
    providerId: "search-worker",
    providerEpoch: 1,
    now: 110,
  }), /not available in the authorized capability catalog/);
});

test("capability catalog bounds provider replicas per function", () => {
  const directory = new RosterFunctionDirectory([SEARCH_FUNCTION]);
  for (let epoch = 1; epoch <= 8; epoch += 1) {
    directory.bindProvider({
      providerId: `search-replica-${epoch}`,
      functionId: SEARCH_FUNCTION.id,
      epoch,
      invoke: async () => ({ matches: [] }),
    });
  }
  const search = directory.searchCatalog({
    node: NODE,
    access: { functionGrants: [SEARCH_FUNCTION.id] },
    query: "repository",
  });
  assert.deepEqual(
    search.entries[0]?.providers.map((provider) => provider.epoch),
    [8, 7, 6, 5],
  );
});

test("provider heartbeats reject stale epochs and change authorized catalog snapshots", () => {
  const directory = new RosterFunctionDirectory([SEARCH_FUNCTION]);
  directory.bindProvider({
    providerId: "search-worker",
    functionId: SEARCH_FUNCTION.id,
    epoch: 1,
    heartbeat: { observedAt: 100, ttlMs: 20 },
    invoke: async () => ({ matches: [] }),
  });
  const before = directory.projectCatalog({
    node: NODE,
    access: { functionGrants: [SEARCH_FUNCTION.id] },
    functionIds: [SEARCH_FUNCTION.id],
    now: 110,
  });
  directory.heartbeatProvider({
    functionId: SEARCH_FUNCTION.id,
    providerId: "search-worker",
    epoch: 1,
    observedAt: 115,
    ttlMs: 30,
  });
  const after = directory.projectCatalog({
    node: NODE,
    access: { functionGrants: [SEARCH_FUNCTION.id] },
    functionIds: [SEARCH_FUNCTION.id],
    now: 116,
  });
  assert.notEqual(after.catalogVersion, before.catalogVersion);
  assert.equal(after.providers[SEARCH_FUNCTION.id]?.expiresAt, 145);

  directory.bindProvider({
    providerId: "search-worker",
    functionId: SEARCH_FUNCTION.id,
    epoch: 2,
    heartbeat: { observedAt: 120, ttlMs: 30 },
    invoke: async () => ({ matches: [] }),
  });
  assert.throws(() => directory.heartbeatProvider({
    functionId: SEARCH_FUNCTION.id,
    providerId: "search-worker",
    epoch: 1,
    observedAt: 121,
    ttlMs: 30,
  }), /does not match the live .* binding epoch/);
  assert.deepEqual(directory.providerHealth(SEARCH_FUNCTION.id, 151), [{
    functionId: SEARCH_FUNCTION.id,
    providerId: "search-worker",
    epoch: 2,
    live: false,
    observedAt: 120,
    expiresAt: 150,
  }]);
});

test("function invocation validates contracts and deterministically uses the newest provider epoch", async () => {
  const calls: string[] = [];
  const directory = new RosterFunctionDirectory([SEARCH_FUNCTION]);
  directory.bindProvider({
    providerId: "replica-a",
    functionId: SEARCH_FUNCTION.id,
    epoch: 1,
    invoke: async () => {
      calls.push("replica-a");
      return { matches: ["old"] };
    },
  });
  directory.bindProvider({
    providerId: "replica-b",
    functionId: SEARCH_FUNCTION.id,
    epoch: 2,
    invoke: async (_value, control) => {
      calls.push(`${control.action}:replica-b`);
      return { matches: ["src/index.ts"] };
    },
  });

  const result = await directory.invoke({
    node: NODE,
    functionId: SEARCH_FUNCTION.id,
    value: { query: "index" },
    access: { functionGrants: [SEARCH_FUNCTION.id] },
  });
  assert.deepEqual(result, {
    status: "completed",
    functionId: SEARCH_FUNCTION.id,
    providerId: "replica-b",
    output: { matches: ["src/index.ts"] },
  });
  assert.deepEqual(calls, ["await:replica-b"]);

  assert.throws(() => directory.bindProvider({
    providerId: "replica-b",
    functionId: SEARCH_FUNCTION.id,
    epoch: 2,
    invoke: async () => ({ matches: [] }),
  }), /binding epoch must increase/);
  await assert.rejects(() => directory.invoke({
    node: NODE,
    functionId: SEARCH_FUNCTION.id,
    value: { query: "", extra: true },
    access: { functionGrants: [SEARCH_FUNCTION.id] },
  }), /input violates its JSON Schema/);

  const invalidOutput = new RosterFunctionDirectory([SEARCH_FUNCTION]);
  invalidOutput.bindProvider({
    providerId: "invalid-worker",
    functionId: SEARCH_FUNCTION.id,
    epoch: 1,
    invoke: async () => ({ wrong: true }),
  });
  await assert.rejects(() => invalidOutput.invoke({
    node: NODE,
    functionId: SEARCH_FUNCTION.id,
    value: { query: "index" },
    access: { functionGrants: [SEARCH_FUNCTION.id] },
  }), /output violates its JSON Schema/);
});

test("function authorization denies missing scopes and effects before provider execution", async () => {
  let called = false;
  const directory = new RosterFunctionDirectory([WRITE_FUNCTION]);
  directory.bindProvider({
    providerId: "write-worker",
    functionId: WRITE_FUNCTION.id,
    epoch: 1,
    invoke: async () => {
      called = true;
      return {};
    },
  });

  await assert.rejects(() => directory.invoke({
    node: NODE,
    functionId: WRITE_FUNCTION.id,
    value: {},
    access: { functionGrants: [WRITE_FUNCTION.id] },
  }), /missing function scopes: repository:write/);
  await assert.rejects(() => directory.invoke({
    node: NODE,
    functionId: WRITE_FUNCTION.id,
    value: {},
    access: {
      functionGrants: [WRITE_FUNCTION.id],
      scopes: ["repository:write"],
    },
  }), /not authorized for function effects: write, external/);
  assert.equal(called, false);
});

test("enqueue delegates to Roster scheduling while void receives provider acknowledgement", async () => {
  const scheduled: string[] = [];
  const calls: string[] = [];
  const directory = new RosterFunctionDirectory([SEARCH_FUNCTION], {
    enqueue: async (request) => {
      scheduled.push(`${request.node.id}:${request.descriptor.id}:${request.queue}`);
      return { receiptId: "function-receipt-1" };
    },
  });
  directory.bindProvider({
    providerId: "search-worker",
    functionId: SEARCH_FUNCTION.id,
    epoch: 1,
    invoke: async (_value, control) => {
      calls.push(control.action);
      return { matches: [] };
    },
  });

  assert.deepEqual(await directory.invoke({
    node: NODE,
    functionId: SEARCH_FUNCTION.id,
    value: { query: "index" },
    action: { kind: "enqueue", queue: "research" },
    access: { functionGrants: [SEARCH_FUNCTION.id] },
  }), {
    status: "enqueued",
    functionId: SEARCH_FUNCTION.id,
    receiptId: "function-receipt-1",
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduled, ["inspector:repository::search:research"]);

  assert.deepEqual(await directory.invoke({
    node: NODE,
    functionId: SEARCH_FUNCTION.id,
    value: { query: "index" },
    action: { kind: "void" },
    access: { functionGrants: [SEARCH_FUNCTION.id] },
  }), {
    status: "accepted",
    functionId: SEARCH_FUNCTION.id,
    providerId: "search-worker",
  });
  assert.deepEqual(calls, ["void"]);
});
