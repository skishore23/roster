import assert from "node:assert/strict";
import test from "node:test";

import * as codingRoomStream from "../../src/browser/coding-room-stream.js";

import {
  NodeRoomUpdateStore,
  type NodeRoomUpdate,
} from "../../src/engine/runtime/node-room-updates.js";
import {
  BoundedCodingRoomUpdateBuffer,
  BoundedNdjsonLineDecoder,
  BoundedRuntimeLogBuffer,
  CodingRoomReconnectBackoff,
  NDJSON_LINE_BYTE_LIMIT,
  acceptCurrentCodingStreamChunk,
  acceptCurrentCodingStreamResponse,
  awaitCurrentCodingStreamResponse,
  codingRoomUpdateId,
  createIdempotentDisposer,
  isTerminalExactIdentityRoomResponse,
  routeCodingRoomStreamAdmission,
  parseCodingRoomUpdate,
  readCurrentCodingStreamChunk,
  shouldOpenCodingRoomStream,
  type CodingRoomUpdateValidationContext,
} from "../../src/browser/coding-room-stream.js";

const encoder = new TextEncoder();

const deferred = <Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const validationContext: CodingRoomUpdateValidationContext = {
  runId: "run-1",
  participants: [
    { nodeId: "human", human: true },
    { nodeId: "planner", human: false },
    { nodeId: "kai", human: false },
    { nodeId: "mira", human: false },
  ],
  tasks: [
    { taskId: "plan", nodeId: "planner" },
    { taskId: "implement", nodeId: "kai" },
    { taskId: "review", nodeId: "mira" },
  ],
  edges: [
    { taskId: "implement", prerequisiteTaskId: "plan" },
    { taskId: "review", prerequisiteTaskId: "implement" },
  ],
};

test("Coding viewer grants are reusable only before their bounded refresh deadline", () => {
  const isFresh = (codingRoomStream as unknown as {
    readonly codingViewerGrantIsFresh?: (expiresAt: number, now: number, refreshLeadMs?: number) => boolean;
  }).codingViewerGrantIsFresh;
  assert.equal(typeof isFresh, "function");
  assert.equal(isFresh!(160_000, 100_000), true);
  assert.equal(isFresh!(130_000, 100_000), false);
  assert.equal(isFresh!(99_999, 100_000), false);
  assert.equal(isFresh!(160_000, 100_000, -1), false);
  assert.equal(isFresh!(Number.POSITIVE_INFINITY, 100_000), false);
});

test("Coding viewer grant renewal survives two expiries without replacing durable rows or leaking timers", async () => {
  type Grant = { readonly capabilitySecret: string; readonly expiresAt: number };
  type Renewal = {
    readonly arm: (expiresAt: number) => void;
    readonly stop: () => void;
  };
  const createRenewal = (codingRoomStream as unknown as {
    readonly createCodingViewerGrantRenewal?: (options: {
      readonly now: () => number;
      readonly setTimer: (callback: () => void, delayMs: number) => number;
      readonly clearTimer: (timer: number) => void;
      readonly mint: () => Promise<Grant>;
      readonly redeem: (grant: Grant) => Promise<void>;
      readonly onError: (error: unknown) => void;
    }) => Renewal;
  }).createCodingViewerGrantRenewal;
  assert.equal(typeof createRenewal, "function");

  let now = 10_000;
  let nextTimer = 0;
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  const redeemed: string[] = [];
  const errors: unknown[] = [];
  const stableRowIds = ["accepted-task-1", "accepted-task-2"];
  const renewal = createRenewal!({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = ++nextTimer;
      timers.set(timer, { callback, delayMs });
      return timer;
    },
    clearTimer: (timer) => { timers.delete(timer); },
    mint: async () => ({
      capabilitySecret: `grant-${redeemed.length + 1}`,
      expiresAt: now + 100,
    }),
    redeem: async (grant) => { redeemed.push(grant.capabilitySecret); },
    onError: (error) => { errors.push(error); },
  });
  renewal.arm(now + 100);

  const runRenewal = async (): Promise<void> => {
    assert.equal(timers.size, 1, "only one pre-expiry timer may be armed");
    const [timer, scheduled] = [...timers.entries()][0]!;
    timers.delete(timer);
    now += scheduled.delayMs;
    scheduled.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await runRenewal();
  await runRenewal();

  assert.deepEqual(redeemed, ["grant-1", "grant-2"]);
  assert.deepEqual(stableRowIds, ["accepted-task-1", "accepted-task-2"]);
  assert.deepEqual(errors, []);
  assert.equal(timers.size, 1);
  const [staleTimer, staleRenewal] = [...timers.entries()][0]!;
  timers.delete(staleTimer);
  now += staleRenewal.delayMs;
  staleRenewal.callback();
  renewal.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(redeemed, ["grant-1", "grant-2"], "a stopped generation cannot redeem a late mint");
  assert.equal(timers.size, 0, "stopping the room clears the renewal timer");
});

test("Coding viewer renewal rotates max-TTL grants before each shorter page authority expiry", async () => {
  type Grant = {
    readonly capabilitySecret: string;
    readonly expiresAt: number;
    readonly renewalExpiresAt: number;
  };
  type Renewal = {
    readonly arm: (expiresAt: number, renewalExpiresAt?: number) => void;
    readonly stop: () => void;
  };
  const createRenewal = (codingRoomStream as unknown as {
    readonly createCodingViewerGrantRenewal?: (options: {
      readonly now: () => number;
      readonly setTimer: (callback: () => void, delayMs: number) => number;
      readonly clearTimer: (timer: number) => void;
      readonly mint: () => Promise<Grant>;
      readonly redeem: (grant: Grant) => Promise<void>;
      readonly onError: (error: unknown) => void;
    }) => Renewal;
  }).createCodingViewerGrantRenewal;
  assert.equal(typeof createRenewal, "function");

  let now = 1_000_000;
  let token = 0;
  let nextTimer = 0;
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  const redeemed: string[] = [];
  const renewal = createRenewal!({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
    mint: async () => ({
      capabilitySecret: `rotated-${++token}`,
      expiresAt: now + 3_600_000,
      renewalExpiresAt: now + 600_000,
    }),
    redeem: async (grant) => { redeemed.push(grant.capabilitySecret); },
    onError: (error) => { throw error; },
  });
  renewal.arm(now + 3_600_000, now + 600_000);

  for (let cycle = 0; cycle < 3; cycle += 1) {
    assert.equal(timers.size, 1);
    const [id, scheduled] = [...timers.entries()][0]!;
    assert.equal(scheduled.delayMs, 570_000, "renewal keeps the bounded safety margin on the shorter page authority");
    timers.delete(id);
    now += scheduled.delayMs;
    scheduled.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(redeemed, ["rotated-1", "rotated-2", "rotated-3"]);
  renewal.stop();
  assert.equal(timers.size, 0);
});

const publicUpdate = (
  overrides: Partial<NodeRoomUpdate> = {},
): NodeRoomUpdate => {
  const identity = {
    runId: overrides.runId ?? "run-1",
    taskId: overrides.taskId ?? "implement",
    nodeId: overrides.nodeId ?? "kai",
    updateKey: overrides.updateKey ?? "working",
  };
  return {
    schema: "roster.node-room-update.v1",
    updateId: codingRoomUpdateId(identity),
    ...identity,
    executionId: "execution-1",
    text: "I’m validating the exact public stream boundary.",
    intent: "progress",
    recipientNodeIds: ["mira"],
    sequence: 1,
    at: "2026-08-26T20:00:00.000Z",
    settled: false,
    ...overrides,
  };
};

test("bounded NDJSON decoder preserves fragmented multibyte records", () => {
  const decoder = new BoundedNdjsonLineDecoder();
  const bytes = encoder.encode('{"text":"👩🏽‍💻"}\n{"ok":true}\n');
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 3) {
    decoder.push(bytes.subarray(offset, offset + 3), (line) => lines.push(line));
  }
  decoder.finish((line) => lines.push(line));
  assert.deepEqual(lines, ['{"text":"👩🏽‍💻"}', '{"ok":true}']);
});

test("bounded NDJSON decoder accepts bulk chunks without retaining the whole chunk", () => {
  const record = '{"type":"heartbeat","at":1}\n';
  const count = Math.ceil((1024 * 1024 + 1) / encoder.encode(record).byteLength);
  const bulk = encoder.encode(record.repeat(count));
  assert.ok(bulk.byteLength > 1024 * 1024);
  const decoder = new BoundedNdjsonLineDecoder();
  let seen = 0;
  decoder.push(bulk, (line) => {
    assert.equal(line, record.trim());
    seen += 1;
  });
  decoder.finish(() => { throw new Error("bulk input should end at a record boundary"); });
  assert.equal(seen, count);
});

test("bounded NDJSON decoder emits a final unterminated record and rejects an oversized residual", () => {
  const decoder = new BoundedNdjsonLineDecoder();
  const lines: string[] = [];
  decoder.push(encoder.encode('{"final":true}'), (line) => lines.push(line));
  decoder.finish((line) => lines.push(line));
  assert.deepEqual(lines, ['{"final":true}']);

  const oversized = new BoundedNdjsonLineDecoder();
  assert.throws(
    () => oversized.push(new Uint8Array(512 * 1024 + 1).fill(0x61), () => undefined),
    /record limit/u,
  );
});

test("bounded NDJSON decoder copies a near-limit one-byte stream linearly", () => {
  const decoder = new BoundedNdjsonLineDecoder();
  assert.equal(decoder.metrics.bufferAllocations, 0);
  const lineBytes = NDJSON_LINE_BYTE_LIMIT - 1;
  const byte = new Uint8Array([0x61]);
  let emittedBytes = 0;
  for (let index = 0; index < lineBytes; index += 1) {
    decoder.push(byte, () => { throw new Error("line must remain buffered"); });
  }
  decoder.push(new Uint8Array([0x0a]), (line) => { emittedBytes = encoder.encode(line).byteLength; });
  assert.equal(emittedBytes, lineBytes);
  assert.deepEqual(decoder.metrics, {
    bufferAllocations: 1,
    bufferedBytes: 0,
    copiedBytes: lineBytes,
  });
});

test("public update validation authenticates stable identity, task assignment, and recipients", () => {
  const valid = publicUpdate();
  assert.deepEqual(parseCodingRoomUpdate(valid, validationContext), valid);

  assert.equal(parseCodingRoomUpdate({ ...valid, updateId: valid.updateId.toUpperCase() }, validationContext), undefined);
  assert.equal(parseCodingRoomUpdate({ ...valid, updateId: "0".repeat(64) }, validationContext), undefined);
  assert.equal(parseCodingRoomUpdate(publicUpdate({ taskId: "missing" }), validationContext), undefined);
  assert.equal(parseCodingRoomUpdate(publicUpdate({ nodeId: "mira" }), validationContext), undefined);
  assert.equal(parseCodingRoomUpdate({ ...valid, recipientNodeIds: ["outsider"] }, validationContext), undefined);
  assert.equal(parseCodingRoomUpdate({ ...valid, recipientNodeIds: ["mira", "human"] }, validationContext), undefined);
  assert.equal(parseCodingRoomUpdate({ ...valid, recipientNodeIds: ["mira", "mira"] }, validationContext), undefined);
  assert.equal(parseCodingRoomUpdate({ ...valid, at: "2026-08-26T20:00:00Z" }, validationContext), undefined);
});

test("browser room update identity exactly matches NodeRoomUpdateStore", () => {
  const store = new NodeRoomUpdateStore({ now: () => "2026-08-26T20:00:00.000Z" });
  const stored = store.post({
    runId: "run-1",
    taskId: "implement",
    executionId: "execution-1",
    nodeId: "kai",
  }, {
    updateKey: "working",
    text: "Identity must match across the runtime and browser.",
    intent: "progress",
    recipientNodeIds: ["mira"],
  });
  assert.equal(stored.updateId, codingRoomUpdateId(stored));
});

test("public update validation applies the exact acknowledgement recipient policy", () => {
  const acknowledgement = publicUpdate({
    updateKey: "ack",
    intent: "acknowledgement",
    recipientNodeIds: ["planner"],
  });
  assert.deepEqual(parseCodingRoomUpdate(acknowledgement, validationContext), acknowledgement);
  assert.equal(parseCodingRoomUpdate({ ...acknowledgement, recipientNodeIds: [] }, validationContext), undefined);
  assert.equal(parseCodingRoomUpdate({ ...acknowledgement, recipientNodeIds: ["mira"] }, validationContext), undefined);
  const addressedHuman = publicUpdate({
    updateKey: "human-ack",
    intent: "acknowledgement",
    recipientNodeIds: ["human"],
  });
  assert.deepEqual(parseCodingRoomUpdate(addressedHuman, validationContext), addressedHuman);
});

test("room update buffer rejects equal-version conflicts and permits a higher version to recover", () => {
  const buffer = new BoundedCodingRoomUpdateBuffer();
  const first = publicUpdate();
  assert.equal(buffer.apply(first), true);
  assert.equal(buffer.apply({ ...first, text: "Conflicting same-version text." }), false);
  assert.deepEqual(buffer.values(), []);
  const recovered = { ...first, sequence: 2, text: "A higher authenticated replacement." };
  assert.equal(buffer.apply(recovered), true);
  assert.deepEqual(buffer.values(), [recovered]);
});

test("conflict tombstone eviction converges after cap pressure in both arrival orders", () => {
  const earlier = publicUpdate({
    updateId: "c".repeat(64),
    updateKey: "conflict",
    sequence: 2,
    at: "2026-08-26T20:00:00.000Z",
    text: "Earlier conflicting content.",
  });
  const later = {
    ...earlier,
    at: "2026-08-26T20:00:02.000Z",
    text: "Later conflicting content.",
  };
  const baseline = publicUpdate({
    updateId: "b".repeat(64),
    updateKey: "baseline",
    sequence: 2,
    at: "2026-08-26T20:00:01.000Z",
  });
  const pressure = publicUpdate({
    updateId: "d".repeat(64),
    updateKey: "pressure",
    sequence: 3,
    at: "2026-08-26T20:00:03.000Z",
  });
  const replay = (conflicts: readonly NodeRoomUpdate[]): readonly string[] => {
    const buffer = new BoundedCodingRoomUpdateBuffer(2);
    buffer.apply(baseline);
    for (const conflict of conflicts) buffer.apply(conflict);
    buffer.apply(pressure);
    return buffer.values().map((update) => update.updateId);
  };
  assert.deepEqual(replay([earlier, later]), replay([later, earlier]));
});

test("room update snapshots reconcile once per generation without clearing or downgrading", () => {
  const buffer = new BoundedCodingRoomUpdateBuffer();
  const current = publicUpdate({ sequence: 3, text: "Current event." });
  buffer.apply(current);
  buffer.beginStreamGeneration();
  assert.equal(buffer.applyInitialSnapshot([publicUpdate({ sequence: 2, text: "Stale snapshot." })]), true);
  assert.deepEqual(buffer.values(), [current]);
  assert.equal(buffer.applyInitialSnapshot([]), false, "only one valid initial snapshot is accepted");
  assert.deepEqual(buffer.values(), [current]);

  buffer.beginStreamGeneration();
  assert.equal(buffer.applyInitialSnapshot([{ ...current, text: "Equal-version conflict." }]), false);
  assert.deepEqual(buffer.values(), [current], "a rejected snapshot is transactional");
});

test("room update and runtime buffers evict deterministically at count and byte ceilings", () => {
  const updates = new BoundedCodingRoomUpdateBuffer();
  for (let index = 1; index <= 501; index += 1) {
    updates.apply(publicUpdate({
      updateId: index.toString(16).padStart(64, "0"),
      taskId: `task-${index}`,
      updateKey: `working-${index}`,
      sequence: index,
      at: new Date(Date.UTC(2026, 7, 26, 20, 0, 0, index)).toISOString(),
    }));
  }
  assert.equal(updates.size, 500);
  assert.equal(updates.retainedSize, 500);
  assert.equal(updates.values()[0]?.sequence, 2);

  const conflicted = publicUpdate({
    updateId: "f".repeat(64),
    taskId: "task-conflict",
    updateKey: "conflict",
    sequence: 1_000,
  });
  updates.apply(conflicted);
  updates.apply({ ...conflicted, text: "Equal-version conflict." });
  assert.equal(updates.retainedSize, 500, "updates and conflict tombstones share one bound");

  const logs = new BoundedRuntimeLogBuffer<{ sequence: number; at: number; text: string }>();
  for (let index = 1; index <= 501; index += 1) logs.set(index, { sequence: index, at: index, text: "x" });
  assert.equal(logs.size, 500);
  assert.equal([...logs.values()][0]?.sequence, 2);
  for (let index = 502; index <= 570; index += 1) {
    logs.set(index, { sequence: index, at: index, text: "x".repeat(8 * 1024) });
  }
  assert.ok([...logs.values()].reduce((bytes, entry) => bytes + encoder.encode(entry.text).byteLength, 0) <= 512 * 1024);
});

test("room stream lifecycle rejects terminal loads and live-to-terminal transitions", () => {
  assert.equal(shouldOpenCodingRoomStream("completed"), false);
  assert.equal(shouldOpenCodingRoomStream("failed"), false);
  assert.equal(shouldOpenCodingRoomStream("canceled"), false);
  assert.equal(shouldOpenCodingRoomStream("running", "running"), true);
  assert.equal(shouldOpenCodingRoomStream("running", "completed"), false);
  assert.equal(shouldOpenCodingRoomStream("running", "budget_exhausted"), false);
  assert.equal(isTerminalExactIdentityRoomResponse(400), true);
  assert.equal(isTerminalExactIdentityRoomResponse(401), true);
  assert.equal(isTerminalExactIdentityRoomResponse(404), true);
  assert.equal(isTerminalExactIdentityRoomResponse(410), true);
  assert.equal(isTerminalExactIdentityRoomResponse(503), false);
  assert.equal(isTerminalExactIdentityRoomResponse(500), false);
});

test("room stream admission never schedules a retry for rejected exact authority", () => {
  let terminalTransitions = 0;
  let scheduledRetries = 0;
  const admitted = routeCodingRoomStreamAdmission(
    { status: 401, ok: false, hasBody: true },
    {
      onTerminal: () => { terminalTransitions += 1; },
      onRetry: () => { scheduledRetries += 1; },
    },
  );
  assert.equal(admitted, false);
  assert.equal(terminalTransitions, 1);
  assert.equal(scheduledRetries, 0);

  routeCodingRoomStreamAdmission(
    { status: 503, ok: false, hasBody: true },
    {
      onTerminal: () => { terminalTransitions += 1; },
      onRetry: () => { scheduledRetries += 1; },
    },
  );
  assert.equal(terminalTransitions, 1);
  assert.equal(scheduledRetries, 1);
});

test("clean authorized room EOF reconnects only while the exact job and execution remain active", () => {
  const transition = (codingRoomStream as unknown as {
    readonly codingRoomStreamEofTransition?: (
      jobStatus: string | undefined,
      executionStatus?: string,
    ) => "paused" | "terminal";
  }).codingRoomStreamEofTransition;
  assert.equal(typeof transition, "function");
  assert.equal(transition!("running", "running"), "paused");
  assert.equal(transition!("leased"), "paused");
  assert.equal(transition!("completed", "running"), "terminal");
  assert.equal(transition!("running", "completed"), "terminal");
  assert.equal(transition!(undefined), "terminal");
});

test("room reconnect backoff escalates through pauses and resets only at safe boundaries", () => {
  const backoff = new CodingRoomReconnectBackoff();
  assert.deepEqual([
    backoff.nextRetry().delayMs,
    backoff.nextRetry().delayMs,
    backoff.nextRetry().delayMs,
  ], [600, 1_200, 2_400]);
  backoff.transition("paused");
  assert.equal(backoff.nextRetry().delayMs, 4_800);
  while (backoff.attempt < 10) backoff.nextRetry();
  assert.equal(backoff.nextRetry().delayMs, 30_000);

  for (const reset of ["connected", "record", "terminal", "replaced", "disposed"] as const) {
    backoff.nextRetry();
    backoff.transition(reset);
    assert.equal(backoff.attempt, 0, `${reset} resets the retry epoch`);
    assert.equal(backoff.nextRetry().delayMs, 600);
  }
});

test("terminal during deferred fetch and disposal during read cancel stale results", async () => {
  const capturedGeneration = 1;
  let currentGeneration = capturedGeneration;
  let disposed = false;
  const aborted = false;
  const isCurrent = (): boolean => !disposed && !aborted && capturedGeneration === currentGeneration;
  let responseCanceled = 0;
  let readerCanceled = 0;
  let mutations = 0;
  let reconnects = 0;
  const responseGate = deferred<Response>();
  const consumeResponse = async (): Promise<void> => {
    const response = await awaitCurrentCodingStreamResponse(responseGate.promise, isCurrent);
    if (!response) return;
    mutations += 1;
    reconnects += 1;
  };
  const responseRun = consumeResponse();
  currentGeneration += 1;
  responseGate.resolve(new Response(new ReadableStream({
    cancel: () => { responseCanceled += 1; },
  })));
  await responseRun;
  assert.equal(responseCanceled, 1);
  assert.equal(mutations, 0);
  assert.equal(reconnects, 0);

  currentGeneration = capturedGeneration;
  const readGate = deferred<void>();
  const reader = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      await readGate.promise;
      controller.enqueue(encoder.encode("stale\n"));
    },
    cancel: () => { readerCanceled += 1; },
  }).getReader();
  const consumeRead = async (): Promise<void> => {
    const chunk = await readCurrentCodingStreamChunk(reader, isCurrent);
    if (!chunk) return;
    mutations += 1;
    reconnects += 1;
  };
  const readRun = consumeRead();
  disposed = true;
  readGate.resolve();
  await readRun;
  assert.equal(readerCanceled, 1);
  assert.equal(mutations, 0);
  assert.equal(reconnects, 0);
  reader.releaseLock();
});

test("caller gates cancel response and chunk invalidated in the helper continuation gap", async () => {
  let current = true;
  let responseCanceled = 0;
  let readerCanceled = 0;
  let readerReleased = 0;
  let liveStates = 0;
  let readerAssignments = 0;
  let decodes = 0;
  let mutations = 0;
  let reconnects = 0;
  let freshnessChecks = 0;
  const isCurrent = (): boolean => {
    freshnessChecks += 1;
    return current;
  };
  const response = new Response(new ReadableStream({
    cancel: () => { responseCanceled += 1; },
  }));
  const consumeResponse = async (): Promise<void> => {
    const guarded = await awaitCurrentCodingStreamResponse(Promise.resolve(response), isCurrent);
    const accepted = acceptCurrentCodingStreamResponse(guarded, isCurrent);
    if (!accepted) return;
    liveStates += 1;
    readerAssignments += 1;
    reconnects += 1;
  };
  const responseRun = consumeResponse();
  queueMicrotask(() => { current = false; });
  await responseRun;
  await Promise.resolve();
  assert.equal(freshnessChecks, 2, "the helper and its caller each fence the same result");
  assert.equal(responseCanceled, 1);
  assert.equal(liveStates, 0);
  assert.equal(readerAssignments, 0);
  assert.equal(reconnects, 0);

  current = true;
  freshnessChecks = 0;
  const reader = {
    cancel: async (): Promise<void> => { readerCanceled += 1; },
    read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => ({
      done: false,
      value: encoder.encode("stale\n"),
    }),
    releaseLock: (): void => { readerReleased += 1; },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  const consumeChunk = async (): Promise<void> => {
    const guarded = await readCurrentCodingStreamChunk(reader, isCurrent);
    const accepted = acceptCurrentCodingStreamChunk(guarded, reader, isCurrent);
    if (!accepted) return;
    decodes += 1;
    mutations += 1;
    reconnects += 1;
  };
  const chunkRun = consumeChunk();
  queueMicrotask(() => { current = false; });
  await chunkRun;
  await Promise.resolve();
  assert.equal(freshnessChecks, 2, "the read helper and its caller each fence the same chunk");
  assert.equal(readerCanceled, 1);
  assert.equal(readerReleased, 1);
  assert.equal(decodes, 0);
  assert.equal(mutations, 0);
  assert.equal(reconnects, 0);
});

test("app disposer is idempotent", () => {
  const calls: string[] = [];
  const dispose = createIdempotentDisposer(() => calls.push("disposed"));
  dispose();
  dispose();
  assert.deepEqual(calls, ["disposed"]);
});
