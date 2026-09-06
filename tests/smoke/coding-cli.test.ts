import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";

import {
  CODING_CLI_API_SCHEMA,
  CodingCliClient,
  CodingCliRequestError,
  codingCliPhase,
  type CodingCliRunSnapshot,
} from "../../src/cli/coding-client.ts";
import { launchCodingTui } from "../../src/cli/coding-tui.ts";
import { executeCodingCommand } from "../../src/cli/coding-command.ts";
import { ensureCodingServer } from "../../src/cli/coding-bootstrap.ts";
import {
  codingRealtimeQueries,
  subscribeCodingRealtime,
  type CodingRealtimeLiveConnection,
  type CodingRealtimeTransportFactory,
} from "../../src/cli/coding-realtime.ts";

type CapturedRequest = {
  readonly url: URL;
  readonly init: RequestInit;
};

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

const runProjection = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  schema: CODING_CLI_API_SCHEMA,
  run: {
    id: "conversation/logical-17",
    executionId: "execution-attempt-42",
    repositoryRoot: "/workspace/repository",
    objective: "Preserve every identity boundary",
    branch: "roster/execution-attempt-42",
    commit: "0123456789abcdef",
  },
  conversation: {
    id: "conversation/logical-17",
    disposition: "ready",
    pendingQuestions: [],
    messages: [{
      messageId: "message-3",
      text: "Implementation is ready for review.",
      createdAt: 30,
      author: { id: "node-reviewer", name: "Reviewer", kind: "agent" },
    }],
  },
  job: {
    id: "job-attempt-9",
    status: "completed",
    terminal: true,
    branch: "roster/execution-attempt-42",
    commit: "0123456789abcdef",
    workerRuntime: "codex-cli",
    workerModel: "gpt-5.6-codex",
    integration: { integrated: false, canIntegrate: true },
  },
  tasks: {
    "task-implementation": {
      taskId: "task-implementation",
      nodeId: "node-implementer",
      capability: "implement",
      status: "accepted",
      dependencies: [],
    },
  },
  nodes: {
    "node-implementer": {
      id: "node-implementer",
      name: "Implementer",
      status: "active",
      metadata: { specialty: "implementation" },
      runtime: { kind: "codex-cli", metadata: { model: "gpt-5.6-codex" } },
    },
  },
  acceptedOutputCount: 1,
  receiptCount: 23,
  ...overrides,
});

const requestBody = (request: CapturedRequest): unknown =>
  request.init.body ? JSON.parse(String(request.init.body)) as unknown : undefined;

test("coding CLI client uses bearer auth, exact v2 routes, and explicit job selectors", async () => {
  const requests: CapturedRequest[] = [];
  const requestFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({ url, init });

    if (url.pathname === "/api/v2/coding/workspace") {
      return json({
        workspaceId: "workspace-exact",
        workspace: { scanned: true, repositoryRoot: "/workspace/repository", name: "Roster" },
      });
    }
    if (url.pathname === "/api/v2/coding/rooms") {
      return json({ rooms: [
        { roomId: "room-old", conversationId: "conversation-old", title: "Old", state: "open", messageCount: 1, createdAt: 1, updatedAt: 10 },
        { roomId: "room-new", conversationId: "conversation-new", title: "New", state: "open", messageCount: 2, createdAt: 2, updatedAt: 20 },
      ] });
    }
    if (url.pathname === "/api/v2/coding/runs/conversation%2Flogical-17" && (init.method ?? "GET") === "GET") {
      return json(runProjection());
    }
    if (url.pathname === "/api/v2/coding/diff") {
      return json({ summary: "1 file changed", files: [{ status: "M", path: "src/index.ts" }], additions: 4, deletions: 1 });
    }
    if (url.pathname.endsWith("/collaboration.md")) {
      return new Response("# Collaboration record\n", { headers: { "Content-Type": "text/markdown" } });
    }
    return json({ ok: true });
  };
  const client = new CodingCliClient({
    baseUrl: "https://roster.example.test/base/",
    token: "token-without-identity-conflation",
    fetch: requestFetch,
  });

  const workspace = await client.workspace("workspace-exact");
  const rooms = await client.rooms("workspace-exact");
  const snapshot = await client.run("conversation/logical-17", "job-attempt-9");
  await client.create({
    objective: "Implement the bounded change",
    workspaceId: "workspace-exact",
    reviewPolicy: "reviewed",
    workerRuntime: "codex-cli",
  });
  await client.message({
    runId: "conversation/logical-17",
    message: "Please keep working.",
    workspaceId: "workspace-exact",
    reviewPolicy: "fast",
  });
  const diff = await client.diff("conversation/logical-17", "job-attempt-9");
  await client.integrate("conversation/logical-17", "job-attempt-9");
  await client.abort("conversation/logical-17", { jobId: "job-attempt-9", reason: "Operator stopped it" });
  await client.retry("conversation/logical-17", "job-attempt-9");
  await client.close("conversation/logical-17", "job-attempt-9");
  const collaboration = await client.collaborationRecord("conversation/logical-17", "job-attempt-9");

  assert.deepEqual(workspace, {
    workspaceId: "workspace-exact",
    scanned: true,
    repositoryRoot: "/workspace/repository",
    name: "Roster",
  });
  assert.deepEqual(rooms.map((room) => room.conversationId), ["conversation-new", "conversation-old"]);
  assert.equal(diff.files[0]?.path, "src/index.ts");
  assert.equal(collaboration, "# Collaboration record\n");

  assert.equal(snapshot.schema, CODING_CLI_API_SCHEMA);
  assert.equal(snapshot.conversation.id, "conversation/logical-17");
  assert.equal(snapshot.run.id, "conversation/logical-17");
  assert.equal(snapshot.run.executionId, "execution-attempt-42");
  assert.equal(snapshot.job?.id, "job-attempt-9");
  assert.equal(snapshot.tasks[0]?.taskId, "task-implementation");
  assert.equal(snapshot.tasks[0]?.nodeId, "node-implementer");
  assert.equal(snapshot.nodes[0]?.id, "node-implementer");
  assert.equal(snapshot.nodes[0]?.runtime, "codex-cli");
  assert.equal(snapshot.nodes[0]?.model, "gpt-5.6-codex");
  assert.notEqual(snapshot.run.executionId, snapshot.job?.id);
  assert.notEqual(snapshot.tasks[0]?.taskId, snapshot.tasks[0]?.nodeId);

  for (const request of requests) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("authorization"), "Bearer token-without-identity-conflation");
  }

  const routes = requests.map(({ url, init }) => `${init.method ?? "GET"} ${url.pathname}${url.search}`);
  assert.deepEqual(routes, [
    "GET /api/v2/coding/workspace?workspace=workspace-exact",
    "GET /api/v2/coding/rooms?workspace=workspace-exact",
    "GET /api/v2/coding/runs/conversation%2Flogical-17?job=job-attempt-9",
    "POST /api/v2/coding/runs",
    "POST /api/v2/coding/runs/conversation%2Flogical-17/messages",
    "GET /api/v2/coding/diff?runId=conversation%2Flogical-17&job=job-attempt-9",
    "POST /api/v2/coding/runs/conversation%2Flogical-17/integrate",
    "POST /api/v2/coding/runs/conversation%2Flogical-17/abort",
    "POST /api/v2/coding/runs/conversation%2Flogical-17/retry",
    "POST /api/v2/coding/runs/conversation%2Flogical-17/close",
    "GET /api/v2/coding/runs/conversation%2Flogical-17/collaboration.md?job=job-attempt-9",
  ]);

  assert.deepEqual(requestBody(requests[3]!), {
    objective: "Implement the bounded change",
    workspaceId: "workspace-exact",
    reviewPolicy: "reviewed",
    workerRuntime: "codex-cli",
    source: { kind: "api", provider: "roster-cli" },
  });
  assert.deepEqual(requestBody(requests[4]!), {
    message: "Please keep working.",
    workspaceId: "workspace-exact",
    reviewPolicy: "fast",
    source: { kind: "api", provider: "roster-cli" },
  });
  assert.deepEqual(requestBody(requests[6]!), { jobId: "job-attempt-9" });
  assert.deepEqual(requestBody(requests[7]!), { jobId: "job-attempt-9", reason: "Operator stopped it" });
  assert.deepEqual(requestBody(requests[8]!), { jobId: "job-attempt-9" });
  assert.deepEqual(requestBody(requests[9]!), { jobId: "job-attempt-9" });
});

test("coding CLI client surfaces structured HTTP failures and rejects unsafe origins", async () => {
  const client = new CodingCliClient({
    baseUrl: "https://roster.example.test",
    fetch: async () => json({ error: "authorization denied", code: "forbidden" }, 403),
  });
  await assert.rejects(
    client.workspace(),
    (error: unknown) => {
      assert.ok(error instanceof CodingCliRequestError);
      assert.equal(error.status, 403);
      assert.equal(error.message, "authorization denied");
      assert.deepEqual(error.details, { error: "authorization denied", code: "forbidden" });
      return true;
    },
  );
  assert.throws(
    () => new CodingCliClient({ baseUrl: "https://operator:secret@roster.example.test" }),
    /must not contain credentials/,
  );
  assert.throws(
    () => new CodingCliClient({ baseUrl: "http://roster.example.test" }),
    /requires https for non-loopback/,
  );
  assert.throws(
    () => new CodingCliClient({ baseUrl: "http://127.0.0.1:8787", requestTimeoutMs: 999 }),
    /request timeout/,
  );
  const mismatched = new CodingCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetch: async () => json(runProjection({
      run: { ...runProjection().run, id: "conversation/different" },
    })),
  });
  await assert.rejects(mismatched.run("conversation/logical-17", "job-attempt-9"), /different conversation/);

  const unavailable = new CodingCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(
    unavailable.workspace(),
    (error: unknown) => {
      assert.ok(error instanceof CodingCliRequestError);
      assert.equal(error.status, 0);
      assert.match(error.message, /Could not reach Roster at http:\/\/127\.0\.0\.1:8787/);
      assert.doesNotMatch(error.message, /fetch failed/);
      return true;
    },
  );

  const unauthorized = new CodingCliClient({
    baseUrl: "http://127.0.0.1:8787",
    token: "configured-but-wrong",
    fetch: async () => json({ error: "Unauthorized" }, 401),
  });
  await assert.rejects(unauthorized.workspace(), /unset it when the local server was started without API authentication/);
});

test("coding CLI mints an exact short-lived realtime session and uses bounded caller-scoped queries", async () => {
  const requests: CapturedRequest[] = [];
  const client = new CodingCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetch: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({ url, init });
      if (url.pathname.startsWith("/api/v2/coding/runs/")) return json({
        schema: CODING_CLI_API_SCHEMA,
        realtimeWorkspaceId: "workspace-control-plane",
        codingWorkspaceId: `workspace_${"a".repeat(20)}`,
        run: {
          id: "conversation/logical-17",
          executionId: "execution-attempt-42",
          repositoryRoot: "/workspace",
        },
        conversation: {
          id: "conversation/logical-17",
          messages: [],
          pendingQuestions: [],
          disposition: "planned",
        },
        job: { id: "job-attempt-9", status: "running" },
        tasks: {},
        nodes: {},
        acceptedOutputCount: 0,
        receiptCount: 0,
      });
      return json({
        schema: CODING_CLI_API_SCHEMA,
        ok: true,
        sessionId: "viewer-session-7",
        workspaceId: `workspace_${"a".repeat(20)}`,
        controlWorkspaceId: "workspace-control-plane",
        roomId: "room-execution-42",
        conversationId: "conversation/logical-17",
        executionId: "execution-attempt-42",
        jobId: "job-attempt-9",
        uri: "http://127.0.0.1:3000",
        database: "roster-test",
        confirmedReads: true,
        capabilitySecret: "ephemeral-secret-not-a-process-boot-secret",
        expiresAt: Date.now() + 60_000,
      });
    },
  });
  const session = await client.realtimeSession("conversation/logical-17", "job-attempt-9");
  assert.equal(session.roomId, "room-execution-42");
  assert.equal(session.executionId, "execution-attempt-42");
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.url.pathname, "/api/v2/coding/realtime-sessions");
  assert.deepEqual(requestBody(requests[1]!), {
    workspaceId: `workspace_${"a".repeat(20)}`,
    conversationId: "conversation/logical-17",
    jobId: "job-attempt-9",
    executionId: "execution-attempt-42",
  });
  const queries = codingRealtimeQueries(session, "cli-selection-1");
  assert.ok(queries.every((query) => query.startsWith("SELECT * FROM my_")));
  assert.ok(queries.some((query) => query.includes("my_coding_execution_summaries_window")
    && query.includes("execution-attempt-42")));
  assert.ok(queries.some((query) => query.includes("my_coding_room_timeline_window")
    && query.includes("room-execution-42")
    && query.includes("cli-selection-1")));
  assert.ok(!queries.some((query) => query.includes("my_stream_receipts")));
  assert.ok(!queries.some((query) => query.includes("my_roster_runtime_bindings")));
  assert.ok(!queries.some((query) => query === "SELECT * FROM my_roster_jobs"));
});

test("coding CLI renews exact realtime access across two expiries and observes later deltas without polling", async (t) => {
  let now = 20_000;
  let timerId = 0;
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  const tableCallbacks: Array<() => void> = [];
  const redeemed: string[] = [];
  const selectedHeads: Array<Readonly<{
    runId: string;
    roomId: string;
    beforeSeq: bigint;
    selectionId: string;
    predecessorSelectionId: string;
    ttlSeconds: bigint;
  }>> = [];
  const subscribedQueries: Array<ReadonlyArray<string>> = [];
  const disconnected: number[] = [];
  let sessionGeneration = 0;
  let projectionGeneration = 0;
  let activeSubscriptions = 0;

  const table = {
    onInsert: (callback: () => void) => { tableCallbacks.push(callback); },
    onUpdate: (callback: () => void) => { tableCallbacks.push(callback); },
    onDelete: (callback: () => void) => { tableCallbacks.push(callback); },
  };
  const database = {
    myCodingRoomsWindow: table,
    myCodingRoomNodesWindow: table,
    myCodingRoomTimelineWindow: table,
    myCodingControlIntentDeliveriesWindow: table,
    myCodingContextFrontiersWindow: table,
    myCodingExecutionSummariesWindow: table,
    myCodingRunTasksWindow: table,
    myCodingRunTaskEdgesWindow: table,
    myCodingRunTaskOutputReferencesWindow: table,
    myCodingCollaborationSummariesWindow: table,
    myCodingActiveRuntimeBindingsWindow: table,
  };
  const connectionFactory: CodingRealtimeTransportFactory = (input) => {
    const connectionId = sessionGeneration;
    let onApplied: (() => void) | undefined;
    let onSubscriptionError: ((error: { readonly event?: { readonly message?: string } }) => void) | undefined;
    const subscription = {
      active: true,
      isActive: () => subscription.active,
      unsubscribe: () => {
        if (subscription.active) activeSubscriptions -= 1;
        subscription.active = false;
      },
    };
    const builder = {
      onApplied: (callback: () => void) => { onApplied = callback; return builder; },
      onError: (callback: (error: { readonly event?: { readonly message?: string } }) => void) => {
        onSubscriptionError = callback;
        return builder;
      },
      subscribe: (queries: ReadonlyArray<string>) => {
        void onSubscriptionError;
        subscribedQueries.push([...queries]);
        activeSubscriptions += 1;
        queueMicrotask(() => onApplied?.());
        return subscription;
      },
    };
    const next = {
      reducers: {
        joinCanvasRun: async (selector: { readonly runId: string; readonly capabilityHash: string }) => {
          assert.equal(selector.runId, "execution-attempt-42");
          redeemed.push(selector.capabilityHash);
        },
        selectCodingRoomTimelinePage: async (selector: {
          readonly runId: string;
          readonly roomId: string;
          readonly beforeSeq: bigint;
          readonly selectionId: string;
          readonly predecessorSelectionId: string;
          readonly ttlSeconds: bigint;
        }) => { selectedHeads.push(selector); },
      },
      db: database,
      subscriptionBuilder: () => builder,
      disconnect: () => { disconnected.push(connectionId); },
    } as unknown as CodingRealtimeLiveConnection;
    queueMicrotask(() => input.onConnect(next, `identity-token-${connectionId}`));
    return { disconnect: () => next.disconnect() };
  };
  const snapshot = (generation: number): CodingCliRunSnapshot => ({
    schema: CODING_CLI_API_SCHEMA,
    realtimeWorkspaceId: "workspace-control-plane",
    codingWorkspaceId: `workspace_${"a".repeat(20)}`,
    run: {
      id: "conversation/logical-17",
      executionId: "execution-attempt-42",
      repositoryRoot: "/workspace/repository",
    },
    conversation: {
      id: "conversation/logical-17",
      messages: [{
        messageId: "accepted-row-stable",
        text: `accepted update ${generation}`,
        createdAt: generation,
        author: { id: "node-reviewer", name: "Reviewer", kind: "agent" },
      }],
      pendingQuestions: [],
      disposition: "planned",
    },
    job: {
      id: "job-attempt-9",
      status: generation >= 4 ? "completed" : "running",
      terminal: generation >= 4,
    },
    tasks: [],
    nodes: [],
    acceptedOutputCount: 1,
    receiptCount: generation,
  });
  const client = {
    realtimeSession: async (): Promise<import("../../src/cli/coding-client.ts").CodingCliRealtimeSession> => {
      sessionGeneration += 1;
      return {
        sessionId: `session-${sessionGeneration}`,
        workspaceId: `workspace_${"a".repeat(20)}`,
        roomId: "room-execution-42",
        conversationId: "conversation/logical-17",
        executionId: "execution-attempt-42",
        jobId: "job-attempt-9",
        uri: "http://127.0.0.1:3000",
        database: "roster-test",
        confirmedReads: true,
        capabilitySecret: `grant-${sessionGeneration}`,
        expiresAt: now + 100,
      };
    },
    run: async (): Promise<CodingCliRunSnapshot> => snapshot(++projectionGeneration),
  };
  const snapshots: CodingCliRunSnapshot[] = [];
  const attachment = subscribeCodingRealtime({
    client,
    conversationId: "conversation/logical-17",
    jobId: "job-attempt-9",
    onSnapshot: (value) => { snapshots.push(value); },
    connectionFactory,
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = ++timerId;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (id) => { timers.delete(id as number); },
    renewalLeadMs: 30,
    coalesceMs: 10,
  });
  t.after(() => attachment.close());
  const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const runLongestTimer = async (): Promise<void> => {
    await settle();
    const selected = [...timers.entries()].sort((left, right) => right[1].delayMs - left[1].delayMs)[0];
    assert.ok(selected, "a pre-expiry renewal timer must be armed");
    timers.delete(selected[0]);
    now += selected[1].delayMs;
    selected[1].callback();
    await settle();
  };

  await settle();
  await runLongestTimer();
  await runLongestTimer();
  assert.equal(sessionGeneration, 3);
  assert.equal(redeemed.length, 3);
  assert.equal(selectedHeads.length, 3);
  assert.ok(selectedHeads.every((selector) => selector.runId === "execution-attempt-42"
    && selector.roomId === "room-execution-42"
    && selector.beforeSeq === 0n
    && selector.ttlSeconds === 3_600n));
  assert.equal(new Set(selectedHeads.map((selector) => selector.selectionId)).size, 1,
    "one CLI watcher refreshes a stable selected timeline across transport generations");
  assert.ok(selectedHeads.every((selector) => selector.predecessorSelectionId === ""),
    "a stable watcher selection needs no generation-specific predecessor chain");
  for (let index = 0; index < subscribedQueries.length; index += 1) {
    const selectionId = selectedHeads[index]?.selectionId;
    assert.ok(selectionId);
    assert.ok(subscribedQueries[index]?.some((query) =>
      query.includes("my_coding_room_timeline_window")
      && query.includes(`selection_id = '${selectionId}'`)));
  }
  assert.equal(subscribedQueries.length, 3);
  assert.equal(activeSubscriptions, 1, "each renewal disposes the previous subscription generation");
  assert.ok(disconnected.length >= 2);
  assert.deepEqual(snapshots.map((value) => value.conversation.messages[0]?.messageId), [
    "accepted-row-stable",
    "accepted-row-stable",
    "accepted-row-stable",
  ]);

  tableCallbacks.at(-1)?.();
  await settle();
  const coalesced = [...timers.entries()].find(([, timer]) => timer.delayMs === 10);
  assert.ok(coalesced, "a table delta schedules one coalesced HTTP projection refresh");
  timers.delete(coalesced[0]);
  coalesced[1].callback();
  await settle();
  assert.equal(snapshots.at(-1)?.receiptCount, 4, "a post-expiry table delta is observed without polling");

  await attachment.done;
  assert.equal(activeSubscriptions, 0);
  assert.equal(timers.size, 0, "terminal state clears renewal, refresh, and reconnect timers");
});

test("coding CLI reuses one watcher selection across failures and a stale delayed admission", async () => {
  type AttemptOutcome = "session-fail" | "connect-fail" | "join-fail" | "select-fail"
    | "delayed-success" | "success";
  const outcomes: AttemptOutcome[] = [
    "session-fail",
    "connect-fail",
    "join-fail",
    "select-fail",
    "delayed-success",
    "success",
    "success",
  ];
  let outcomeIndex = 0;
  let timerId = 0;
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  const outcomeBySession = new Map<string, AttemptOutcome>();
  const activeSelections = new Set<string>();
  const activeExpirations = new Set<string>();
  const successfulSelections: string[] = [];
  const selectionAttempts: Array<{
    readonly outcome: AttemptOutcome;
    readonly selectionId: string;
    readonly predecessorSelectionId: string;
  }> = [];
  let maxActiveSelections = 0;
  let currentDisconnect: (() => void) | undefined;
  let resolveDelayedAdmission: (() => void) | undefined;
  let activeSubscriptions = 0;

  const table = {
    onInsert: (_callback: () => void) => {},
    onUpdate: (_callback: () => void) => {},
    onDelete: (_callback: () => void) => {},
  };
  const database = {
    myCodingRoomsWindow: table,
    myCodingRoomNodesWindow: table,
    myCodingRoomTimelineWindow: table,
    myCodingControlIntentDeliveriesWindow: table,
    myCodingContextFrontiersWindow: table,
    myCodingExecutionSummariesWindow: table,
    myCodingRunTasksWindow: table,
    myCodingRunTaskEdgesWindow: table,
    myCodingRunTaskOutputReferencesWindow: table,
    myCodingCollaborationSummariesWindow: table,
    myCodingActiveRuntimeBindingsWindow: table,
  };
  const connectionFactory: CodingRealtimeTransportFactory = (input) => {
    const outcome = outcomeBySession.get(input.session.sessionId);
    assert.ok(outcome);
    let onApplied: (() => void) | undefined;
    const subscription = {
      active: true,
      isActive: () => subscription.active,
      unsubscribe: () => {
        if (subscription.active) activeSubscriptions -= 1;
        subscription.active = false;
      },
    };
    const builder = {
      onApplied: (callback: () => void) => { onApplied = callback; return builder; },
      onError: (_callback: (error: { readonly event?: { readonly message?: string } }) => void) => builder,
      subscribe: (_queries: ReadonlyArray<string>) => {
        activeSubscriptions += 1;
        queueMicrotask(() => onApplied?.());
        return subscription;
      },
    };
    const next = {
      reducers: {
        joinCanvasRun: async () => {
          if (outcome === "join-fail") throw new Error("injected join failure");
        },
        selectCodingRoomTimelinePage: async (selector: {
          readonly runId: string;
          readonly roomId: string;
          readonly beforeSeq: bigint;
          readonly selectionId: string;
          readonly predecessorSelectionId: string;
          readonly ttlSeconds: bigint;
        }) => {
          selectionAttempts.push({
            outcome,
            selectionId: selector.selectionId,
            predecessorSelectionId: selector.predecessorSelectionId,
          });
          if (outcome === "select-fail") throw new Error("injected selection failure");
          if (selector.predecessorSelectionId) {
            activeSelections.delete(selector.predecessorSelectionId);
            activeExpirations.delete(selector.predecessorSelectionId);
          }
          activeSelections.add(selector.selectionId);
          activeExpirations.add(selector.selectionId);
          successfulSelections.push(selector.selectionId);
          maxActiveSelections = Math.max(maxActiveSelections, activeSelections.size);
          if (outcome === "delayed-success") {
            await new Promise<void>((resolve) => { resolveDelayedAdmission = resolve; });
          }
        },
      },
      db: database,
      subscriptionBuilder: () => builder,
      disconnect: () => {},
    } as unknown as CodingRealtimeLiveConnection;
    currentDisconnect = () => input.onDisconnect(new Error("advance injected generation"));
    queueMicrotask(() => {
      if (outcome === "connect-fail") input.onConnectError(new Error("injected connect failure"));
      else input.onConnect(next, `identity-token-${input.session.sessionId}`);
    });
    return { disconnect: () => next.disconnect() };
  };
  const client = {
    realtimeSession: async (): Promise<import("../../src/cli/coding-client.ts").CodingCliRealtimeSession> => {
      const outcome = outcomes[outcomeIndex++];
      assert.ok(outcome, "the CLI must not create an unbounded extra generation");
      if (outcome === "session-fail") throw new Error("injected session failure");
      const sessionId = `session-${outcomeIndex}`;
      outcomeBySession.set(sessionId, outcome);
      return {
        sessionId,
        workspaceId: `workspace_${"a".repeat(20)}`,
        roomId: "room-execution-42",
        conversationId: "conversation/logical-17",
        executionId: "execution-attempt-42",
        jobId: "job-attempt-9",
        uri: "http://127.0.0.1:3000",
        database: "roster-test",
        confirmedReads: true,
        capabilitySecret: `grant-${outcomeIndex}`,
        expiresAt: 1_000_000,
      };
    },
    run: async (): Promise<CodingCliRunSnapshot> => ({
      schema: CODING_CLI_API_SCHEMA,
      realtimeWorkspaceId: "workspace-control-plane",
      codingWorkspaceId: `workspace_${"a".repeat(20)}`,
      run: {
        id: "conversation/logical-17",
        executionId: "execution-attempt-42",
        repositoryRoot: "/workspace/repository",
      },
      conversation: {
        id: "conversation/logical-17",
        messages: [],
        pendingQuestions: [],
        disposition: "planned",
      },
      job: { id: "job-attempt-9", status: "running", terminal: false },
      tasks: [],
      nodes: [],
      acceptedOutputCount: 0,
      receiptCount: 0,
    }),
  };
  const attachment = subscribeCodingRealtime({
    client,
    conversationId: "conversation/logical-17",
    jobId: "job-attempt-9",
    onSnapshot: () => {},
    connectionFactory,
    now: () => 10_000,
    setTimer: (callback, delayMs) => {
      const id = ++timerId;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (id) => { timers.delete(id as number); },
    renewalLeadMs: 30,
  });
  const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const runReconnectTimer = async (): Promise<void> => {
    await settle();
    const selected = [...timers.entries()].sort((left, right) => left[1].delayMs - right[1].delayMs)[0];
    assert.ok(selected, "a failed generation must schedule one bounded reconnect");
    timers.delete(selected[0]);
    selected[1].callback();
    await settle();
  };

  try {
    await settle();
    await runReconnectTimer();
    await runReconnectTimer();
    await runReconnectTimer();
    await runReconnectTimer();
    assert.ok(resolveDelayedAdmission, "the fifth generation reaches a committed admission with a delayed ack");
    assert.ok(currentDisconnect);
    currentDisconnect();
    await runReconnectTimer();
    resolveDelayedAdmission();
    await settle();
    assert.ok(currentDisconnect);
    currentDisconnect();
    await runReconnectTimer();
    assert.equal(outcomeIndex, outcomes.length);
    assert.equal(successfulSelections.length, 3);
    assert.equal(new Set(selectionAttempts.map((attempt) => attempt.selectionId)).size, 1,
      "a delayed stale ack and repeated recovery always refresh the same watcher selection");
    assert.ok(selectionAttempts.every((attempt) => attempt.predecessorSelectionId === ""));
    assert.deepEqual([...activeSelections], [successfulSelections[0]]);
    assert.deepEqual([...activeExpirations], [successfulSelections[0]]);
    assert.equal(maxActiveSelections, 1, "failed or stale generations never grow the server selection set");
    assert.equal(activeSubscriptions, 1);
  } finally {
    attachment.close();
  }
  await attachment.done;
  assert.equal(activeSubscriptions, 0);
  assert.equal(timers.size, 0, "closing the CLI clears renewal and reconnect timers after injected failures");
  assert.equal(activeSelections.size, 1, "without a delete reducer, one watcher row remains for bounded expiry");
  assert.equal(activeExpirations.size, 1, "the stopped watcher retains only its single bounded expiry");
});

test("same-identity coding CLI watchers own distinct lifetime selections", async () => {
  const selectedIds: string[] = [];
  let sessionSequence = 0;
  let activeSubscriptions = 0;
  const table = {
    onInsert: (_callback: () => void) => {},
    onUpdate: (_callback: () => void) => {},
    onDelete: (_callback: () => void) => {},
  };
  const database = {
    myCodingRoomsWindow: table,
    myCodingRoomNodesWindow: table,
    myCodingRoomTimelineWindow: table,
    myCodingControlIntentDeliveriesWindow: table,
    myCodingContextFrontiersWindow: table,
    myCodingExecutionSummariesWindow: table,
    myCodingRunTasksWindow: table,
    myCodingRunTaskEdgesWindow: table,
    myCodingRunTaskOutputReferencesWindow: table,
    myCodingCollaborationSummariesWindow: table,
    myCodingActiveRuntimeBindingsWindow: table,
  };
  const connectionFactory: CodingRealtimeTransportFactory = (input) => {
    let onApplied: (() => void) | undefined;
    const subscription = {
      active: true,
      isActive: () => subscription.active,
      unsubscribe: () => {
        if (subscription.active) activeSubscriptions -= 1;
        subscription.active = false;
      },
    };
    const builder = {
      onApplied: (callback: () => void) => { onApplied = callback; return builder; },
      onError: (_callback: (error: { readonly event?: { readonly message?: string } }) => void) => builder,
      subscribe: (_queries: ReadonlyArray<string>) => {
        activeSubscriptions += 1;
        queueMicrotask(() => onApplied?.());
        return subscription;
      },
    };
    const next = {
      reducers: {
        joinCanvasRun: async () => {},
        selectCodingRoomTimelinePage: async (selector: {
          readonly selectionId: string;
        }) => { selectedIds.push(selector.selectionId); },
      },
      db: database,
      subscriptionBuilder: () => builder,
      disconnect: () => {},
    } as unknown as CodingRealtimeLiveConnection;
    queueMicrotask(() => input.onConnect(next, "shared-identity-token"));
    return { disconnect: () => next.disconnect() };
  };
  const client = {
    realtimeSession: async (): Promise<import("../../src/cli/coding-client.ts").CodingCliRealtimeSession> => ({
      sessionId: `session-${++sessionSequence}`,
      workspaceId: `workspace_${"a".repeat(20)}`,
      roomId: "room-execution-42",
      conversationId: "conversation/logical-17",
      executionId: "execution-attempt-42",
      jobId: "job-attempt-9",
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
      capabilitySecret: `grant-${sessionSequence}`,
      expiresAt: Date.now() + 60_000,
    }),
    run: async (): Promise<CodingCliRunSnapshot> => ({
      schema: CODING_CLI_API_SCHEMA,
      realtimeWorkspaceId: "workspace-control-plane",
      codingWorkspaceId: `workspace_${"a".repeat(20)}`,
      run: {
        id: "conversation/logical-17",
        executionId: "execution-attempt-42",
        repositoryRoot: "/workspace/repository",
      },
      conversation: {
        id: "conversation/logical-17",
        messages: [],
        pendingQuestions: [],
        disposition: "planned",
      },
      job: { id: "job-attempt-9", status: "running", terminal: false },
      tasks: [],
      nodes: [],
      acceptedOutputCount: 0,
      receiptCount: 0,
    }),
  };
  const watchers = [0, 1].map(() => subscribeCodingRealtime({
    client,
    conversationId: "conversation/logical-17",
    jobId: "job-attempt-9",
    onSnapshot: () => {},
    connectionFactory,
  }));
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selectedIds.length, 2);
    assert.equal(new Set(selectedIds).size, 2,
      "two watchers sharing one transport identity retain independent lifetime selections");
    assert.ok(selectedIds.every((selectionId) => /^cli-[0-9a-f-]{36}$/u.test(selectionId)));
    assert.equal(activeSubscriptions, 2);
  } finally {
    for (const watcher of watchers) watcher.close();
  }
  await Promise.all(watchers.map((watcher) => watcher.done));
  assert.equal(activeSubscriptions, 0);
  assert.equal(new Set(selectedIds).size, 2, "watcher identities remain distinct through disposal");
});

test("interactive Coding onboards an unscanned workspace before opening the TUI", async () => {
  const requests: CapturedRequest[] = [];
  let workspaceReads = 0;
  const client = new CodingCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetch: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({ url, init });
      if (url.pathname === "/api/v2/coding/workspace/scan") {
        return json({ ok: true, workspace: { scanned: true } }, 201);
      }
      workspaceReads += 1;
      return json({
        workspaceId: "workspace-onboarding",
        workspace: {
          scanned: workspaceReads > 1,
          repositoryRoot: "/workspace/repository",
          ...(workspaceReads > 1 ? { name: "Roster" } : {}),
        },
      });
    },
  });
  const output: string[] = [];
  let confirmed = 0;
  let launched: Readonly<Record<string, unknown>> | undefined;
  await executeCodingCommand([], {}, {
    client,
    io: {
      stdin: Object.assign(new (await import("node:stream")).Readable({ read() { this.push(null); } }), { isTTY: true }),
      stdout: {
        isTTY: true,
        columns: 120,
        rows: 40,
        write: (text: string | Uint8Array) => { output.push(String(text)); return true; },
      },
      stderr: { write: () => true },
    },
    confirm: async () => { confirmed += 1; return true; },
    launchTui: async (input) => { launched = input; },
  });

  assert.equal(confirmed, 1);
  assert.equal(launched?.workspaceId, "workspace-onboarding");
  assert.match(output.join(""), /onboarding is required/i);
  assert.match(output.join(""), /Workspace team is ready/);
  assert.deepEqual(requests.map((request) => `${request.init.method ?? "GET"} ${request.url.pathname}`), [
    "GET /api/v2/coding/workspace",
    "POST /api/v2/coding/workspace/scan",
    "GET /api/v2/coding/workspace",
  ]);
});

test("Coding local bootstrap attaches to a ready server or owns and cleans up its child stack", async () => {
  let existingFetches = 0;
  const existing = await ensureCodingServer({
    origin: "http://127.0.0.1:8787",
    fetch: async () => { existingFetches += 1; return new Response("ready"); },
    command: { executable: "must-not-run", args: [] },
  });
  assert.equal(existing.owned, false);
  assert.equal(existingFetches, 1);
  await existing.close();

  let readinessChecks = 0;
  const statuses: string[] = [];
  const owned = await ensureCodingServer({
    origin: "http://127.0.0.1:8787",
    command: {
      executable: process.execPath,
      args: ["-e", "process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)"],
    },
    fetch: async () => {
      readinessChecks += 1;
      return new Response(readinessChecks >= 2 ? "ready" : "starting", { status: readinessChecks >= 2 ? 200 : 503 });
    },
    pollIntervalMs: 25,
    startupTimeoutMs: 5_000,
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(owned.owned, true);
  assert.ok(readinessChecks >= 2);
  assert.match(statuses.join(" "), /Starting the local Roster/);
  assert.match(statuses.join(" "), /Roster is ready/);
  await owned.close();

  const remote = await ensureCodingServer({
    origin: "https://roster.example.test",
    fetch: async () => new Response("ready"),
  });
  assert.equal(remote.owned, false, "a ready remote server is attached but never supervised locally");
  await assert.rejects(
    ensureCodingServer({
      origin: "https://roster.example.test",
      fetch: async () => new Response("stopped", { status: 503 }),
    }),
    /automatic startup is available only for loopback HTTP/,
  );
  await assert.rejects(
    ensureCodingServer({
      origin: "http://127.0.0.1:8787",
      env: { ...process.env, ROSTER_CODING_AUTOSTART: "0" },
      fetch: async () => new Response("stopped", { status: 503 }),
    }),
    /start it with `roster up`/,
  );
});

test("Coding local bootstrap preserves an identity-owned database and selects a fresh local control plane", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "roster-coding-bootstrap-"));
  const marker = path.join(cwd, "ready");
  const statuses: string[] = [];
  try {
    const stack = await ensureCodingServer({
      origin: "http://127.0.0.1:8787",
      cwd,
      env: {
        ...process.env,
        SPACETIMEDB_DATABASE: "",
        SPACETIMEDB_TOKEN: "",
        SPACETIMEDB_TOKEN_PATH: "",
        CODING_TEST_READY_MARKER: marker,
      },
      command: {
        executable: process.execPath,
        args: [
          "-e",
          "if(!process.env.SPACETIMEDB_DATABASE){console.error('not authorized to perform action on database previous: update database');process.exit(1)}require('node:fs').writeFileSync(process.env.CODING_TEST_READY_MARKER,'ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)",
        ],
      },
      fetch: async () => access(marker).then(
        () => new Response("ready"),
        () => new Response("starting", { status: 503 }),
      ),
      pollIntervalMs: 25,
      startupTimeoutMs: 5_000,
      onStatus: (status) => statuses.push(status),
    });
    try {
      assert.equal(stack.owned, true);
      assert.match(statuses.join(" "), /previous local database belongs to another SpacetimeDB identity/i);
      assert.match(statuses.join(" "), /will be preserved/i);
      const selection = JSON.parse(await readFile(path.join(cwd, ".spacetime", "coding-local.json"), "utf8")) as {
        readonly schema?: string;
        readonly database?: string;
        readonly tokenPath?: string;
      };
      assert.equal(selection.schema, "roster.coding-local.v1");
      assert.match(selection.database ?? "", /^roster-local-[a-f0-9]{12}$/u);
      assert.equal(selection.tokenPath, `.spacetime/${selection.database}.token`);
    } finally {
      await stack.close();
    }

    await rm(marker, { force: true });
    const reusedStatuses: string[] = [];
    const reused = await ensureCodingServer({
      origin: "http://127.0.0.1:8787",
      cwd,
      env: {
        ...process.env,
        SPACETIMEDB_DATABASE: "",
        SPACETIMEDB_TOKEN: "",
        SPACETIMEDB_TOKEN_PATH: "",
        CODING_TEST_READY_MARKER: marker,
      },
      command: {
        executable: process.execPath,
        args: [
          "-e",
          "if(!process.env.SPACETIMEDB_DATABASE){console.error('not authorized to perform action on database previous: update database');process.exit(1)}require('node:fs').writeFileSync(process.env.CODING_TEST_READY_MARKER,'ready');process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)",
        ],
      },
      fetch: async () => access(marker).then(
        () => new Response("ready"),
        () => new Response("starting", { status: 503 }),
      ),
      pollIntervalMs: 25,
      startupTimeoutMs: 5_000,
      onStatus: (status) => reusedStatuses.push(status),
    });
    try {
      assert.equal(reused.owned, true);
      assert.doesNotMatch(reusedStatuses.join(" "), /belongs to another SpacetimeDB identity/i);
    } finally {
      await reused.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("coding CLI phases prioritize operator attention, failure, review, and completion", () => {
  const snapshot = runProjection() as unknown as CodingCliRunSnapshot;
  assert.equal(codingCliPhase(undefined), "idle");
  assert.equal(codingCliPhase(snapshot), "review");
  assert.equal(codingCliPhase({
    ...snapshot,
    conversation: { ...snapshot.conversation, pendingQuestions: ["Choose a migration policy"] },
  }), "attention");
  assert.equal(codingCliPhase({ ...snapshot, job: { ...snapshot.job!, terminal: false, status: "running" } }), "working");
  assert.equal(codingCliPhase({ ...snapshot, job: { ...snapshot.job!, status: "failed", error: "verification failed" } }), "failed");
  assert.equal(codingCliPhase({
    ...snapshot,
    job: { ...snapshot.job!, integration: { integrated: true, canIntegrate: false } },
  }), "done");
});

const optionalModule = async (relativePath: string): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const url = new URL(relativePath, import.meta.url);
  try {
    await access(url);
  } catch {
    return undefined;
  }
  return await import(url.href) as Readonly<Record<string, unknown>>;
};

test("coding command exposes an injectable command runner for pure JSON and non-TTY operation", async (t) => {
  const module = await optionalModule("../../src/cli/coding-command.ts");
  if (!module) {
    t.skip("src/cli/coding-command.ts has not landed yet");
    return;
  }
  const runner = module.runCodingCommand ?? module.executeCodingCommand;
  assert.equal(typeof runner, "function", "export runCodingCommand(args, context) or executeCodingCommand(args, context)");

  type CommandRunner = (
    args: ReadonlyArray<string>,
    flags: Readonly<Record<string, string | boolean>>,
    context: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  let requestCount = 0;
  const client = new CodingCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetch: async () => {
      requestCount += 1;
      return json(runProjection());
    },
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runCommand = runner as CommandRunner;
  const io = {
    stdin: Object.assign(new (await import("node:stream")).Readable({ read() { this.push(null); } }), { isTTY: false }),
    stdout: {
      isTTY: false,
      columns: 80,
      rows: 24,
      write: (text: string | Uint8Array) => { stdout.push(String(text)); return true; },
    },
    stderr: {
      write: (text: string | Uint8Array) => { stderr.push(String(text)); return true; },
    },
  };
  await runCommand(["status", "conversation/logical-17"], {
    job: "job-attempt-9",
    json: true,
  }, {
    client,
    io,
  });

  assert.equal(stderr.join(""), "");
  const serialized = stdout.join("");
  assert.doesNotMatch(serialized, /\u001b\[/u);
  const envelope = JSON.parse(serialized) as { readonly schema?: string; readonly result?: CodingCliRunSnapshot };
  assert.equal(envelope.schema, "roster.coding-cli.v1");
  const result = envelope.result!;
  assert.equal(result.conversation.id, "conversation/logical-17");
  assert.equal(result.run.executionId, "execution-attempt-42");
  assert.equal(result.job?.id, "job-attempt-9");
  assert.equal(requestCount, 1);

  stdout.length = 0;
  stderr.length = 0;
  await assert.rejects(runCommand([], {}, { client, io }), /TTY|--json/iu);
  assert.equal(stdout.join(""), "");
  assert.equal(stderr.join(""), "");
  assert.equal(requestCount, 1, "non-TTY rejection happens before an API request");
});

test("coding TUI exposes a pure adaptive renderer with exact identity in every width class", async (t) => {
  const module = await optionalModule("../../src/cli/coding-tui.ts");
  if (!module) {
    t.skip("src/cli/coding-tui.ts has not landed yet");
    return;
  }
  const render = module.renderCodingTui ?? module.renderCodingTuiFrame;
  assert.equal(typeof render, "function", "export renderCodingTui(snapshot, options) or renderCodingTuiFrame(snapshot, options)");
  const layout = module.codingTuiLayout ?? module.codingTuiLayoutForWidth;
  assert.equal(typeof layout, "function", "export codingTuiLayout(columns) or codingTuiLayoutForWidth(columns)");

  type Renderer = (
    snapshot: CodingCliRunSnapshot,
    options: { readonly columns: number; readonly rows: number; readonly color: boolean },
  ) => string;
  type LayoutSelector = (columns: number) => "wide" | "medium" | "narrow" | "compact";
  const snapshot: CodingCliRunSnapshot = {
    schema: CODING_CLI_API_SCHEMA,
    run: {
      id: "conversation/logical-17",
      executionId: "execution-attempt-42",
      repositoryRoot: "/workspace/repository",
      objective: "Preserve every identity boundary",
      branch: "roster/execution-attempt-42",
      commit: "0123456789abcdef",
    },
    conversation: {
      id: "conversation/logical-17",
      disposition: "ready",
      pendingQuestions: [],
      messages: [],
    },
    job: {
      id: "job-attempt-9",
      status: "completed",
      terminal: true,
      commit: "0123456789abcdef",
      integration: { integrated: false, canIntegrate: true },
    },
    tasks: [{
      taskId: "task-implementation",
      nodeId: "node-implementer",
      capability: "implement",
      status: "accepted",
      dependencies: [],
    }],
    nodes: [{ id: "node-implementer", name: "Implementer", status: "active", runtime: "codex-cli" }],
    acceptedOutputCount: 1,
    receiptCount: 23,
  };
  const renderFrame = render as Renderer;
  const selectLayout = layout as LayoutSelector;
  const cases = [
    { columns: 132, expected: "wide" },
    { columns: 100, expected: "medium" },
    { columns: 70, expected: "narrow" },
    { columns: 40, expected: "compact" },
  ] as const;

  for (const entry of cases) {
    assert.equal(selectLayout(entry.columns), entry.expected);
    const frame = renderFrame(snapshot, { columns: entry.columns, rows: 32, color: false });
    assert.equal(typeof frame, "string");
    assert.doesNotMatch(frame, /\u001b\[/u);
    assert.ok(frame.split("\n").every((line) => line.length <= entry.columns), `line exceeds ${entry.columns} columns`);
    assert.match(frame, /conversation\/logical-17/u);
    assert.match(frame, /execution-attempt-42/u);
    assert.match(frame, /job-attempt-9/u);
    assert.match(frame, /node-implementer/u);
    assert.match(frame, /task-implementation/u);
  }
});

test("coding TUI restores its terminal on Ctrl-C without issuing a durable abort", async () => {
  class RecordingTerminal implements Terminal {
    readonly columns = 100;
    readonly rows = 30;
    readonly kittyProtocolActive = false;
    stopped = 0;
    drained = 0;
    writes: string[] = [];

    start(onInput: (data: string) => void): void {
      setTimeout(() => onInput("\u0003"), 0);
    }
    stop(): void { this.stopped += 1; }
    async drainInput(): Promise<void> { this.drained += 1; }
    write(data: string): void { this.writes.push(data); }
    moveBy(): void {}
    hideCursor(): void {}
    showCursor(): void {}
    clearLine(): void {}
    clearFromCursor(): void {}
    clearScreen(): void {}
    setTitle(): void {}
    setProgress(): void {}
  }

  const requests: string[] = [];
  const client = new CodingCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push(url.pathname);
      return json({ rooms: [] });
    },
  });
  const terminal = new RecordingTerminal();
  const result = await launchCodingTui({ client, terminal, intervalMs: 250 });

  assert.equal(result.reason, "detached");
  assert.ok(terminal.stopped >= 1);
  assert.equal(terminal.drained, 1);
  assert.equal(requests.some((pathname) => pathname.endsWith("/abort")), false);
});

test("coding command requires explicit confirmation and never accepts token flags", async () => {
  const requests: CapturedRequest[] = [];
  const client = new CodingCliClient({
    baseUrl: "http://127.0.0.1:8787",
    fetch: async (input, init = {}) => {
      requests.push({ url: new URL(input instanceof Request ? input.url : input.toString()), init });
      return json({ ok: true, integration: { integrated: true } });
    },
  });
  const sink = { write: () => true };
  const io = {
    stdin: Object.assign(new (await import("node:stream")).Readable({ read() { this.push(null); } }), { isTTY: false }),
    stdout: Object.assign(sink, { isTTY: false, columns: 80, rows: 24 }),
    stderr: sink,
  };

  await assert.rejects(
    executeCodingCommand(["merge", "conversation/logical-17"], { job: "job-attempt-9" }, { client, io }),
    /--yes/,
  );
  await assert.rejects(
    executeCodingCommand(["rooms"], { token: "must-not-enter-process-arguments" }, { client, io }),
    /ROSTER_API_TOKEN/,
  );
  await assert.rejects(
    executeCodingCommand(["rooms"], { jsno: true }, { client, io }),
    /Unknown flag --jsno/,
  );
  assert.equal(requests.length, 0);

  await executeCodingCommand(
    ["merge", "conversation/logical-17"],
    { job: "job-attempt-9", yes: true },
    { client, io },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url.pathname, "/api/v2/coding/runs/conversation%2Flogical-17/integrate");
  assert.deepEqual(requestBody(requests[0]!), { jobId: "job-attempt-9" });
});
