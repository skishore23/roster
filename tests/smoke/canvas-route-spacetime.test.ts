import { createHash } from "node:crypto";

import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import type { SpacetimeControlPlane } from "../../src/adapters/spacetimedb-control.ts";
import { createCanvasRoute } from "../../src/agents/canvas.agent.ts";
import type { CanvasModel } from "../../src/agents/canvas.model.ts";
import { ModelProviderHealthRegistry } from "../../src/engine/runtime/model-provider-health.ts";

const never = async (): Promise<never> => {
  throw new Error("model execution is outside the route contract test");
};

const canvasModel: CanvasModel = {
  routing: {
    director: "director-test",
    painter: "painter-test",
    critic: "critic-test",
    finisher: "finisher-test",
    finisherEscalation: "finisher-escalation-test",
  },
  plan: never,
  paint: never,
  critique: never,
  repair: never,
};

const formRequest = async (
  app: Hono,
  headers: Readonly<Record<string, string>> = {}
): Promise<Request> => {
  const shell = await app.request("http://local/canvas");
  const body = await shell.text();
  const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf, "Canvas shell must contain a signed run token");
  return new Request("http://local/canvas/run?stream=agents%2Fcanvas", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ prompt: "A fox under the moon", parallel: "3", csrf }),
  });
};

const canvasRouteApp = (csrfSecret: string): Hono => {
  const neverReady = new Promise<void>(() => undefined);
  const saturatedControlPlane = {
    config: {
      uri: "http://127.0.0.1:3000",
      database: "roster-local",
      connectTimeoutMs: 10_000,
      confirmedReads: false,
    },
    subscribeCanvasDispatch: () => ({ ready: neverReady, close: () => undefined }),
    snapshot: () => ({
      runs: Array.from({ length: 256 }, (_, index) => ({ id: `active_${index}`, status: "running" })),
      fleetRuns: [],
    }),
  } as unknown as SpacetimeControlPlane;
  const app = new Hono();
  createCanvasRoute({
    promptHash: "prompts",
    promptPath: "prompts/canvas.prompts.json",
    canvasModel,
    apiReady: true,
    csrfSecret,
    controlPlane: saturatedControlPlane,
  }).register(app);
  return app;
};

test("Canvas refreshes stale run tokens after a local server restart", async () => {
  const oldApp = canvasRouteApp("old-canvas-route-secret-32-bytes!");
  const oldShell = await oldApp.request("http://local/canvas");
  const oldBody = await oldShell.text();
  const staleToken = oldBody.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(staleToken);

  const restartedApp = canvasRouteApp("new-canvas-route-secret-32-bytes!");
  const staleResponse = await restartedApp.request("http://local/canvas/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt: "A fox under the moon", parallel: "3", csrf: staleToken }),
  });
  assert.equal(staleResponse.status, 403);

  const tokenResponse = await restartedApp.request("http://local/canvas/run-token");
  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
  const payload = await tokenResponse.json() as { readonly csrfToken?: unknown };
  assert.equal(typeof payload.csrfToken, "string");

  const refreshedResponse = await restartedApp.request("http://local/canvas/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      prompt: "A fox under the moon",
      parallel: "3",
      csrf: payload.csrfToken as string,
    }),
  });
  assert.equal(refreshedResponse.status, 429, "the refreshed token reaches the active-run limit check");
});

test("Canvas POST fails closed without SpacetimeDB", async () => {
  const app = new Hono();
  createCanvasRoute({
    promptHash: "prompts",
    promptPath: "prompts/canvas.prompts.json",
    canvasModel,
    apiReady: true,
  }).register(app);
  const response = await app.request(await formRequest(app));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /SpacetimeDB is required/);
});

test("Canvas rejects a hard-blocked provider before creating durable work", async () => {
  let createRunCalls = 0;
  const providerHealth = new ModelProviderHealthRegistry();
  providerHealth.recordFailure("openai", {
    failureClass: "budget",
    message: "sanitized quota failure",
  });
  const fakeControl = {
    config: {
      uri: "http://127.0.0.1:3000",
      database: "roster-local",
      connectTimeoutMs: 10_000,
      confirmedReads: false,
    },
    subscribeCanvasDispatch: () => ({ ready: Promise.resolve(), close: () => undefined }),
    snapshot: () => ({ runs: [], fleetRuns: [] }),
    createCanvasRun: async () => { createRunCalls += 1; },
  } as unknown as SpacetimeControlPlane;
  const app = new Hono();
  createCanvasRoute({
    promptHash: "prompts",
    promptPath: "prompts/canvas.prompts.json",
    canvasModel,
    apiReady: true,
    controlPlane: fakeControl,
    providerHealth,
    providerId: "openai",
  }).register(app);

  const shell = await app.request("http://local/canvas");
  const shellBody = await shell.text();
  assert.match(shellBody, /quota or billing is unavailable/i);
  assert.match(shellBody, /id="canvas-submit"[^>]*disabled/);

  const response = await app.request(await formRequest(app));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /quota or billing is unavailable/i);
  assert.equal(createRunCalls, 0, "provider admission must precede durable run creation");
});

test("Canvas startup recovery preserves runs linked to another workspace", async () => {
  const foreignRun = {
    id: "canvas_foreign_workspace",
    prompt: "Do not dispatch here",
    status: "running",
    desiredAgents: 6,
  };
  let linkCalls = 0;
  let runSubscriptions = 0;
  const fakeControl = {
    config: {
      uri: "http://127.0.0.1:3000",
      database: "roster-local",
      connectTimeoutMs: 10_000,
      confirmedReads: false,
    },
    subscribeCanvasDispatch: () => ({ ready: Promise.resolve(), close: () => undefined }),
    subscribeCanvasRun: () => {
      runSubscriptions += 1;
      return { ready: Promise.resolve(), close: () => undefined };
    },
    subscribeRosterExecution: () => ({ ready: Promise.resolve(), close: () => undefined }),
    snapshot: () => ({
      runs: [foreignRun],
      fleetRuns: [{ id: foreignRun.id, workspaceId: "roster/foreign" }],
      tasks: [],
    }),
    linkCanvasRunWorkspace: async () => { linkCalls += 1; },
  } as unknown as SpacetimeControlPlane;
  const app = new Hono();
  createCanvasRoute({
    promptHash: "prompts",
    promptPath: "prompts/canvas.prompts.json",
    canvasModel,
    apiReady: true,
    controlPlane: fakeControl,
    workspaceId: "roster/local",
  }).register(app);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(linkCalls, 0, "an existing workspace link is immutable during migration");
  assert.equal(runSubscriptions, 0, "foreign runs must never enter this workspace's dispatcher");
});

test("Canvas POST creates a hashed viewer capability and keeps the raw secret in the fragment", async () => {
  let createdRun: Readonly<Record<string, unknown>> | undefined;
  let createdCapability: Readonly<Record<string, unknown>> | undefined;
  let createRunCalls = 0;
  const pendingRunSubscription = new Promise<void>(() => undefined);
  const fakeControl = {
    config: {
      uri: "http://127.0.0.1:3000",
      database: "roster-local",
      connectTimeoutMs: 10_000,
      confirmedReads: false,
    },
    subscribeCanvasDispatch: () => ({ ready: Promise.resolve(), close: () => undefined }),
    subscribeCanvasRun: () => ({ ready: pendingRunSubscription, close: () => undefined }),
    subscribeRosterExecution: () => ({ ready: pendingRunSubscription, close: () => undefined }),
    snapshot: () => ({ runs: [], fleetRuns: [] }),
    createCanvasRun: async (input: Readonly<Record<string, unknown>>) => {
      createRunCalls += 1;
      createdRun = input;
    },
    createViewerCapability: async (input: Readonly<Record<string, unknown>>) => { createdCapability = input; },
  } as unknown as SpacetimeControlPlane;
  const app = new Hono();
  createCanvasRoute({
    promptHash: "prompts",
    promptPath: "prompts/canvas.prompts.json",
    canvasModel,
    apiReady: true,
    controlPlane: fakeControl,
  }).register(app);

  const response = await app.request(await formRequest(app, {
    origin: "null",
    "sec-fetch-site": "cross-site",
  }));
  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  assert.ok(location);
  const viewerUrl = new URL(location, "http://local");
  const secret = new URLSearchParams(viewerUrl.hash.slice(1)).get("access");
  assert.ok(secret && secret.length >= 40);
  assert.equal(viewerUrl.searchParams.has("access"), false);
  assert.equal(viewerUrl.searchParams.get("run"), createdRun?.runId);
  assert.equal(createdCapability?.runId, createdRun?.runId);
  assert.equal(
    createdCapability?.capabilityHash,
    createHash("sha256").update(secret, "utf8").digest("hex")
  );
  assert.equal(JSON.stringify(createdCapability).includes(secret), false);

  const foreign = await app.request(await formRequest(app, {
    origin: "https://attacker.example",
    "sec-fetch-site": "cross-site",
  }));
  assert.equal(foreign.status, 403);
  assert.match(await foreign.text(), /Cross-site Canvas run creation is not allowed/);
  assert.equal(createRunCalls, 1, "foreign web origins must be rejected before creating work");
});

test("Canvas waits for the Roster execution projection and does not spin while its coordinator is not ready", async () => {
  const runId = "canvas_projection_wait";
  const run = {
    id: runId,
    prompt: "A fox under the moon",
    status: "running",
    desiredAgents: 6,
  };
  let resolveRosterReady!: () => void;
  const rosterReady = new Promise<void>((resolve) => {
    resolveRosterReady = resolve;
  });
  let observeClaim!: () => void;
  const claimed = new Promise<void>((resolve) => {
    observeClaim = resolve;
  });
  let claimCalls = 0;
  let canvasCloses = 0;
  let rosterCloses = 0;
  const neverReady = new Promise<void>(() => undefined);
  const fakeControl = {
    config: {
      uri: "http://127.0.0.1:3000",
      database: "roster-local",
      connectTimeoutMs: 10_000,
      confirmedReads: false,
    },
    subscribeCanvasDispatch: () => ({ ready: neverReady, close: () => undefined }),
    subscribeCanvasRun: () => ({
      ready: Promise.resolve(),
      close: () => { canvasCloses += 1; },
    }),
    subscribeRosterExecution: () => ({
      ready: rosterReady,
      close: () => { rosterCloses += 1; },
    }),
    snapshot: () => ({
      runs: [run],
      fleetRuns: [{ id: runId, workspaceId: "roster/default" }],
      tasks: [],
    }),
    enqueueRosterTask: async () => undefined,
    claimRosterTask: async () => {
      claimCalls += 1;
      observeClaim();
      throw new Error("Roster task __canvas_coordinator__ is not ready");
    },
  } as unknown as SpacetimeControlPlane;
  const app = new Hono();
  createCanvasRoute({
    promptHash: "prompts",
    promptPath: "prompts/canvas.prompts.json",
    canvasModel,
    apiReady: true,
    controlPlane: fakeControl,
    workspaceId: "roster/default",
    csrfSecret: "canvas-route-test-secret-32-bytes!",
  }).register(app);

  const response = await app.request(`http://local/canvas?run=${runId}`);
  assert.equal(response.status, 200);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(claimCalls, 0, "the coordinator cannot claim before its Roster projection is ready");

  resolveRosterReady();
  await Promise.race([
    claimed,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Canvas coordinator was not claimed")), 2_000)
    ),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(claimCalls, 1, "not-ready coordinators wait for a durable dispatch change instead of spinning");
  assert.equal(canvasCloses, 1);
  assert.equal(rosterCloses, 1);
});

test("Canvas recovery terminalizes a stale run whose durable coordinator exhausted its attempts", async () => {
  const runId = "canvas_exhausted_coordinator";
  const run = {
    id: runId,
    prompt: "A fox under the moon",
    status: "queued",
    desiredAgents: 6,
  };
  let claimCalls = 0;
  let canceledReason: string | undefined;
  let observeCancellation!: () => void;
  const canceled = new Promise<void>((resolve) => {
    observeCancellation = resolve;
  });
  const neverReady = new Promise<void>(() => undefined);
  const fakeControl = {
    config: {
      uri: "http://127.0.0.1:3000",
      database: "roster-local",
      connectTimeoutMs: 10_000,
      confirmedReads: false,
    },
    subscribeCanvasDispatch: () => ({ ready: neverReady, close: () => undefined }),
    subscribeCanvasRun: () => ({ ready: Promise.resolve(), close: () => undefined }),
    subscribeRosterExecution: () => ({ ready: Promise.resolve(), close: () => undefined }),
    snapshot: () => ({
      runs: [run],
      fleetRuns: [{ id: runId, workspaceId: "roster/default" }],
      tasks: [{
        runId,
        taskId: "__canvas_coordinator__",
        status: "failed",
        lastError: "execution projection unavailable",
      }],
    }),
    enqueueRosterTask: async () => undefined,
    claimRosterTask: async () => { claimCalls += 1; },
    cancelCanvasRun: async (_runId: string, reason: string) => {
      canceledReason = reason;
      run.status = "canceled";
      observeCancellation();
    },
  } as unknown as SpacetimeControlPlane;
  const app = new Hono();
  createCanvasRoute({
    promptHash: "prompts",
    promptPath: "prompts/canvas.prompts.json",
    canvasModel,
    apiReady: true,
    controlPlane: fakeControl,
    workspaceId: "roster/default",
    csrfSecret: "canvas-route-test-secret-32-bytes!",
  }).register(app);

  const response = await app.request(`http://local/canvas?run=${runId}`);
  assert.equal(response.status, 200);
  await Promise.race([
    canceled,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Canvas run was not terminalized")), 2_000)
    ),
  ]);

  assert.equal(claimCalls, 0);
  assert.match(canceledReason ?? "", /execution projection unavailable/);
});

test("Canvas terminal workflow failures fail the coordinator task without retrying", async () => {
  const runId = "canvas_terminal_failure";
  const run = {
    id: runId,
    prompt: "A fox under the moon",
    status: "running",
    desiredAgents: 6,
    sceneHash: "",
    objectCount: 0,
  };
  let coordinator: {
    readonly runId: string;
    readonly taskId: string;
    status: string;
    attempt: number;
    leaseFence: bigint;
    definitionHash: string;
    definitionJson: string;
  } | undefined;
  let settle!: (value: { readonly kind: "completed" | "failed"; readonly retryable?: boolean }) => void;
  const settled = new Promise<{ readonly kind: "completed" | "failed"; readonly retryable?: boolean }>((resolve) => {
    settle = resolve;
  });
  const neverReady = new Promise<void>(() => undefined);
  const executionPolicy = {
    maxTasks: 64,
    maxDepth: 4,
    maxFanout: 16,
    maxInflight: 8,
    maxReady: 64,
    maxBlocked: 64,
    maxAttempts: 8,
    maxContextBytes: 128_000_000,
    maxCostMicros: 64_000_000,
    maxTokens: 2_000_000_000,
    maxWallTimeMs: 86_400_000,
  };
  const fakeControl = {
    config: {
      uri: "http://127.0.0.1:3000",
      database: "roster-local",
      connectTimeoutMs: 10_000,
      confirmedReads: false,
    },
    subscribeCanvasDispatch: () => ({ ready: neverReady, close: () => undefined }),
    subscribeCanvasRun: () => ({ ready: Promise.resolve(), close: () => undefined }),
    subscribeRosterExecution: () => ({ ready: Promise.resolve(), close: () => undefined }),
    snapshot: () => ({
      runs: [run],
      fleetRuns: [{ id: runId, workspaceId: "roster/default" }],
      tasks: coordinator ? [coordinator] : [],
    }),
    rosterSnapshot: () => ({
      executions: [{
        runId,
        kind: "canvas",
        workspaceId: "roster/default",
        policyJson: JSON.stringify(executionPolicy),
        outcomesJson: "[]",
        expansionsJson: "[]",
        dataReferencesJson: "[]",
        spentCostMicros: 0n,
        usedTokens: 0n,
      }],
      tasks: coordinator ? [coordinator] : [],
      claimableTasks: [],
    }),
    enqueueRosterTask: async (input: {
      readonly definition: { readonly definitionHash: string };
    }) => {
      coordinator = {
        runId,
        taskId: "__canvas_coordinator__",
        status: "ready",
        attempt: 0,
        leaseFence: 0n,
        definitionHash: input.definition.definitionHash,
        definitionJson: JSON.stringify(input.definition),
      };
    },
    claimRosterTask: async () => {
      assert.ok(coordinator);
      coordinator.status = "leased";
      coordinator.attempt = 1;
      coordinator.leaseFence = 1n;
    },
    startRosterTask: async () => {
      assert.ok(coordinator);
      coordinator.status = "running";
    },
    heartbeatRosterTask: async () => undefined,
    acceptRosterTaskOutcome: async () => settle({ kind: "completed" }),
    finalizeCanvasRun: async () => undefined,
    failRosterTask: async (input: { readonly retryable: boolean }) => {
      assert.ok(coordinator);
      coordinator.status = "failed";
      settle({ kind: "failed", retryable: input.retryable });
    },
  } as unknown as SpacetimeControlPlane;
  const app = new Hono();
  createCanvasRoute({
    promptHash: "prompts",
    promptPath: "prompts/canvas.prompts.json",
    canvasModel,
    apiReady: true,
    controlPlane: fakeControl,
    workspaceId: "roster/default",
    csrfSecret: "canvas-route-test-secret-32-bytes!",
    canvasRosterRunner: async (input) => {
      assert.equal(input.executionPlane.taskGraph.durability, "durable");
      assert.equal(input.executionPlane.dataReferences.durability, "durable");
      await assert.rejects(
        input.executionPlane.taskGraph.snapshot(),
        /not been initialized/i,
        "runCanvasRoster must initialize the durable graph once with its real seed tasks",
      );
      run.status = "failed";
      return {
        runId: input.runId,
        stream: input.stream,
        runStream: input.runStream ?? `agents/canvas/runs/${input.runId}`,
        status: "failed",
        objectCount: 0,
      };
    },
  }).register(app);

  const priorConsoleError = console.error;
  console.error = () => undefined;
  try {
    const response = await app.request(`http://local/canvas?run=${runId}`);
    assert.equal(response.status, 200);
    const outcome = await Promise.race([
      settled,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Canvas coordinator did not settle")), 2_000)),
    ]);
    assert.deepEqual(outcome, { kind: "failed", retryable: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    console.error = priorConsoleError;
  }
});
