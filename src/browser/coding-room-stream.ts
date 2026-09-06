import { hashCanonical } from "../core/canonical.js";
import type { NodeRoomUpdate, NodeRoomUpdateIntent } from "../engine/runtime/node-room-updates.js";

export const CODING_ROOM_UPDATE_LIMIT = 500;
export const CODING_RUNTIME_LOG_LIMIT = 500;
export const CODING_RUNTIME_LOG_BYTE_LIMIT = 512 * 1024;
export const NDJSON_LINE_BYTE_LIMIT = 512 * 1024;
export {
  CODING_VIEWER_GRANT_REFRESH_LEAD_MS,
  codingViewerGrantIsFresh,
  codingViewerGrantRefreshDelay,
  createCodingViewerGrantRenewal,
  type CodingViewerGrantRenewal,
} from "../core/coding-viewer-access.js";

const ROOM_UPDATE_SCHEMA = "roster.node-room-update.v1" as const;
const ROOM_UPDATE_FIELDS = new Set([
  "schema",
  "updateId",
  "runId",
  "taskId",
  "executionId",
  "nodeId",
  "updateKey",
  "text",
  "intent",
  "recipientNodeIds",
  "sequence",
  "at",
  "settled",
]);
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const UPDATE_ID_PATTERN = /^[a-f0-9]{64}$/u;
const UPDATE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const ACTIVE_JOB_STATUSES = new Set(["queued", "leased", "running"]);
const TERMINAL_EXECUTION_STATUSES = new Set([
  "completed",
  "completed_with_notes",
  "failed",
  "budget_exhausted",
  "canceled",
]);

const compareCanonicalText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const UTF8_ENCODER = new TextEncoder();
const utf8Length = (value: string): number => UTF8_ENCODER.encode(value).byteLength;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const exactFields = (value: Readonly<Record<string, unknown>>, fields: ReadonlySet<string>): boolean =>
  Object.keys(value).length === fields.size && Object.keys(value).every((key) => fields.has(key));

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) && timestamp.toISOString() === value;
};

export interface CodingRoomUpdateIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly updateKey: string;
}

/** Mirrors NodeRoomUpdateStore's SHA-256 identity array with the browser-safe canonical hash. */
export const codingRoomUpdateId = (identity: CodingRoomUpdateIdentity): string => hashCanonical([
  ROOM_UPDATE_SCHEMA,
  identity.runId,
  identity.taskId,
  identity.nodeId,
  identity.updateKey,
]);

export interface CodingRoomUpdateValidationContext {
  readonly runId: string;
  readonly participants: ReadonlyArray<{
    readonly nodeId: string;
    readonly human: boolean;
  }>;
  readonly tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly nodeId: string;
  }>;
  readonly edges: ReadonlyArray<{
    readonly taskId: string;
    readonly prerequisiteTaskId: string;
  }>;
}

const validIntent = (value: unknown): value is NodeRoomUpdateIntent =>
  value === "progress" || value === "acknowledgement" || value === "question";

const sortedUnique = (values: readonly string[]): boolean => values.every((value, index) =>
  index === 0 || compareCanonicalText(values[index - 1]!, value) < 0);

/**
 * Fails closed at the public browser boundary. Recipient authority is rebuilt
 * from the direct durable task graph; unknown recipients are never filtered.
 */
export const parseCodingRoomUpdate = (
  value: unknown,
  context: CodingRoomUpdateValidationContext,
): NodeRoomUpdate | undefined => {
  const update = record(value);
  if (!update || !exactFields(update, ROOM_UPDATE_FIELDS)) return undefined;
  const identities = [update.runId, update.taskId, update.executionId, update.nodeId];
  if (update.schema !== ROOM_UPDATE_SCHEMA
    || update.runId !== context.runId
    || identities.some((identity) => typeof identity !== "string" || !IDENTITY_PATTERN.test(identity))
    || typeof update.updateId !== "string"
    || !UPDATE_ID_PATTERN.test(update.updateId)
    || typeof update.updateKey !== "string"
    || !UPDATE_KEY_PATTERN.test(update.updateKey)
    || codingRoomUpdateId({
      runId: update.runId as string,
      taskId: update.taskId as string,
      nodeId: update.nodeId as string,
      updateKey: update.updateKey,
    }) !== update.updateId
    || typeof update.text !== "string"
    || update.text !== update.text.trim()
    || update.text.length < 1
    || update.text.length > 420
    || CONTROL_CHARACTER_PATTERN.test(update.text)
    || !validIntent(update.intent)
    || !Array.isArray(update.recipientNodeIds)
    || update.recipientNodeIds.length > 6
    || update.recipientNodeIds.some((recipient) =>
      typeof recipient !== "string" || !IDENTITY_PATTERN.test(recipient))
    || !sortedUnique(update.recipientNodeIds as string[])
    || typeof update.sequence !== "number"
    || !Number.isSafeInteger(update.sequence)
    || update.sequence < 1
    || !canonicalTimestamp(update.at)
    || typeof update.settled !== "boolean") return undefined;

  const participants = new Map<string, { readonly nodeId: string; readonly human: boolean }>();
  for (const participant of context.participants) {
    if (!IDENTITY_PATTERN.test(participant.nodeId) || participants.has(participant.nodeId)) return undefined;
    participants.set(participant.nodeId, participant);
  }
  const tasks = new Map<string, { readonly taskId: string; readonly nodeId: string }>();
  for (const task of context.tasks) {
    if (!IDENTITY_PATTERN.test(task.taskId)
      || !IDENTITY_PATTERN.test(task.nodeId)
      || tasks.has(task.taskId)) return undefined;
    tasks.set(task.taskId, task);
  }
  const task = tasks.get(update.taskId as string);
  if (!task || task.nodeId !== update.nodeId || !participants.has(task.nodeId)) return undefined;

  const upstream = new Set<string>();
  const downstream = new Set<string>();
  for (const edge of context.edges) {
    const dependent = tasks.get(edge.taskId);
    const prerequisite = tasks.get(edge.prerequisiteTaskId);
    if (!dependent || !prerequisite || dependent.taskId === prerequisite.taskId) continue;
    if (dependent.taskId === task.taskId && prerequisite.nodeId !== task.nodeId) upstream.add(prerequisite.nodeId);
    if (prerequisite.taskId === task.taskId && dependent.nodeId !== task.nodeId) downstream.add(dependent.nodeId);
  }
  const humans = [...participants.values()]
    .filter((participant) => participant.human)
    .map((participant) => participant.nodeId);
  const authorized = update.intent === "acknowledgement"
    ? new Set([...upstream, ...humans])
    : new Set([...upstream, ...downstream, ...humans]);
  const recipients = update.recipientNodeIds as string[];
  if (update.intent === "acknowledgement" && recipients.length === 0) return undefined;
  if (recipients.some((recipient) => !participants.has(recipient) || !authorized.has(recipient))) return undefined;

  return Object.freeze({
    schema: ROOM_UPDATE_SCHEMA,
    updateId: update.updateId,
    runId: update.runId as string,
    taskId: update.taskId as string,
    executionId: update.executionId as string,
    nodeId: update.nodeId as string,
    updateKey: update.updateKey,
    text: update.text,
    intent: update.intent,
    recipientNodeIds: Object.freeze([...recipients]),
    sequence: update.sequence,
    at: update.at,
    settled: update.settled,
  });
};

const compareUpdateVersion = (
  left: Pick<NodeRoomUpdate, "sequence" | "settled">,
  right: Pick<NodeRoomUpdate, "sequence" | "settled">,
): number =>
  left.sequence - right.sequence || Number(left.settled) - Number(right.settled);

const compareUpdateOrder = (left: NodeRoomUpdate, right: NodeRoomUpdate): number =>
  left.sequence - right.sequence
  || compareCanonicalText(left.at, right.at)
  || compareCanonicalText(left.updateId, right.updateId)
  || compareCanonicalText(hashCanonical(left), hashCanonical(right));

type UpdateConflict = Pick<NodeRoomUpdate, "updateId" | "sequence" | "settled" | "at"> & {
  readonly lastAt: string;
  readonly firstFingerprint: string;
  readonly lastFingerprint: string;
  readonly fingerprint: string;
};

const canonicalConflict = (left: NodeRoomUpdate, right: NodeRoomUpdate): UpdateConflict => {
  const times = [left.at, right.at].sort(compareCanonicalText);
  const fingerprints = [hashCanonical(left), hashCanonical(right)].sort(compareCanonicalText);
  return {
    updateId: left.updateId,
    sequence: left.sequence,
    settled: left.settled,
    at: times[0]!,
    lastAt: times[1]!,
    firstFingerprint: fingerprints[0]!,
    lastFingerprint: fingerprints[1]!,
    fingerprint: hashCanonical(fingerprints),
  };
};

const mergeConflict = (conflict: UpdateConflict, update: NodeRoomUpdate): UpdateConflict => {
  const updateFingerprint = hashCanonical(update);
  const firstFingerprint = compareCanonicalText(conflict.firstFingerprint, updateFingerprint) <= 0
    ? conflict.firstFingerprint
    : updateFingerprint;
  const lastFingerprint = compareCanonicalText(conflict.lastFingerprint, updateFingerprint) >= 0
    ? conflict.lastFingerprint
    : updateFingerprint;
  return {
    ...conflict,
    at: compareCanonicalText(conflict.at, update.at) <= 0 ? conflict.at : update.at,
    lastAt: compareCanonicalText(conflict.lastAt, update.at) >= 0 ? conflict.lastAt : update.at,
    firstFingerprint,
    lastFingerprint,
    fingerprint: hashCanonical([firstFingerprint, lastFingerprint]),
  };
};

const copyUpdates = (source: ReadonlyMap<string, NodeRoomUpdate>): Map<string, NodeRoomUpdate> =>
  new Map(source);

const copyConflicts = (source: ReadonlyMap<string, UpdateConflict>): Map<string, UpdateConflict> =>
  new Map(source);

/** Bounded, version-aware public presentation buffer. */
export class BoundedCodingRoomUpdateBuffer {
  readonly #limit: number;
  #updates = new Map<string, NodeRoomUpdate>();
  #conflicts = new Map<string, UpdateConflict>();
  #snapshotAccepted = false;

  constructor(limit = CODING_ROOM_UPDATE_LIMIT) {
    this.#limit = Math.max(1, Math.min(limit, CODING_ROOM_UPDATE_LIMIT));
  }

  get size(): number {
    return this.#updates.size;
  }

  get retainedSize(): number {
    return this.#updates.size + this.#conflicts.size;
  }

  get(updateId: string): NodeRoomUpdate | undefined {
    return this.#updates.get(updateId);
  }

  values(): NodeRoomUpdate[] {
    return [...this.#updates.values()].sort(compareUpdateOrder);
  }

  clear(): void {
    this.#updates.clear();
    this.#conflicts.clear();
    this.#snapshotAccepted = false;
  }

  beginStreamGeneration(): void {
    this.#snapshotAccepted = false;
  }

  apply(update: NodeRoomUpdate): boolean {
    const result = this.#applyTo(this.#updates, this.#conflicts, update);
    this.#trim(this.#updates, this.#conflicts);
    return result !== "conflict";
  }

  applyInitialSnapshot(updates: readonly NodeRoomUpdate[]): boolean {
    if (this.#snapshotAccepted || updates.length > this.#limit) return false;
    const stagedUpdates = copyUpdates(this.#updates);
    const stagedConflicts = copyConflicts(this.#conflicts);
    for (const update of updates) {
      if (this.#applyTo(stagedUpdates, stagedConflicts, update) === "conflict") return false;
    }
    this.#trim(stagedUpdates, stagedConflicts);
    this.#updates = stagedUpdates;
    this.#conflicts = stagedConflicts;
    this.#snapshotAccepted = true;
    return true;
  }

  #applyTo(
    updates: Map<string, NodeRoomUpdate>,
    conflicts: Map<string, UpdateConflict>,
    update: NodeRoomUpdate,
  ): "accepted" | "ignored" | "conflict" {
    const conflict = conflicts.get(update.updateId);
    if (conflict) {
      const conflictVersion = compareUpdateVersion(update, conflict);
      if (conflictVersion < 0) return "ignored";
      if (conflictVersion === 0) {
        conflicts.set(update.updateId, mergeConflict(conflict, update));
        return "ignored";
      }
      conflicts.delete(update.updateId);
    }
    const existing = updates.get(update.updateId);
    if (!existing) {
      updates.set(update.updateId, update);
      return "accepted";
    }
    const version = compareUpdateVersion(existing, update);
    if (version > 0) return "ignored";
    if (version < 0) {
      updates.set(update.updateId, update);
      return "accepted";
    }
    if (hashCanonical(existing) === hashCanonical(update)) return "ignored";
    updates.delete(update.updateId);
    conflicts.set(update.updateId, canonicalConflict(existing, update));
    return "conflict";
  }

  #trim(updates: Map<string, NodeRoomUpdate>, conflicts: Map<string, UpdateConflict>): void {
    while (updates.size + conflicts.size > this.#limit) {
      const oldest = [
        ...[...updates.values()].map((update) => ({
          kind: "update" as const,
          updateId: update.updateId,
          sequence: update.sequence,
          at: update.at,
          lastAt: update.at,
          fingerprint: hashCanonical(update),
        })),
        ...[...conflicts.values()].map((conflict) => ({
          kind: "conflict" as const,
          updateId: conflict.updateId,
          sequence: conflict.sequence,
          at: conflict.at,
          lastAt: conflict.lastAt,
          fingerprint: conflict.fingerprint,
        })),
      ].sort((left, right) =>
        left.sequence - right.sequence
        || compareCanonicalText(left.at, right.at)
        || compareCanonicalText(left.lastAt, right.lastAt)
        || compareCanonicalText(left.updateId, right.updateId)
        || compareCanonicalText(left.fingerprint, right.fingerprint)
        || compareCanonicalText(left.kind, right.kind))[0];
      if (!oldest) break;
      if (oldest.kind === "update") updates.delete(oldest.updateId);
      else conflicts.delete(oldest.updateId);
    }
  }
}

export class BoundedRuntimeLogBuffer<Log extends { readonly sequence: number; readonly at: number; readonly text: string }> {
  readonly #entries = new Map<number, Log>();
  #bytes = 0;

  get size(): number {
    return this.#entries.size;
  }

  set(sequence: number, entry: Log): void {
    const existing = this.#entries.get(sequence);
    if (existing) this.#bytes -= utf8Length(existing.text);
    this.#entries.set(sequence, entry);
    this.#bytes += utf8Length(entry.text);
    while (this.#entries.size > CODING_RUNTIME_LOG_LIMIT || this.#bytes > CODING_RUNTIME_LOG_BYTE_LIMIT) {
      const oldest = [...this.#entries.values()].sort((left, right) =>
        left.sequence - right.sequence
        || left.at - right.at
        || compareCanonicalText(hashCanonical(left), hashCanonical(right)))[0];
      if (!oldest) break;
      this.#entries.delete(oldest.sequence);
      this.#bytes -= utf8Length(oldest.text);
    }
  }

  values(): IterableIterator<Log> {
    return [...this.#entries.values()]
      .sort((left, right) => left.sequence - right.sequence
        || left.at - right.at
        || compareCanonicalText(hashCanonical(left), hashCanonical(right)))
      [Symbol.iterator]();
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}

/**
 * Incremental byte decoder: the retained residual is one bounded line only.
 * Large chunks containing many short lines are processed without concatenation.
 */
export class BoundedNdjsonLineDecoder {
  #residual: Uint8Array | undefined;
  #residualLength = 0;
  #bufferAllocations = 0;
  #copiedBytes = 0;

  get metrics(): Readonly<{
    bufferAllocations: number;
    bufferedBytes: number;
    copiedBytes: number;
  }> {
    return Object.freeze({
      bufferAllocations: this.#bufferAllocations,
      bufferedBytes: this.#residualLength,
      copiedBytes: this.#copiedBytes,
    });
  }

  push(chunk: Uint8Array, emit: (line: string) => void): void {
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.#emitSegment(chunk.subarray(start, index), emit);
      start = index + 1;
    }
    this.#appendResidual(chunk.subarray(start));
  }

  finish(emit: (line: string) => void): void {
    if (this.#residualLength === 0 || !this.#residual) return;
    const line = this.#decodeLine(this.#residual.subarray(0, this.#residualLength));
    this.#residualLength = 0;
    emit(line);
  }

  #emitSegment(segment: Uint8Array, emit: (line: string) => void): void {
    const byteLength = this.#residualLength + segment.byteLength;
    if (byteLength > NDJSON_LINE_BYTE_LIMIT) throw new Error("NDJSON record limit exceeded");
    if (this.#residualLength === 0) {
      emit(this.#decodeLine(segment));
      return;
    }
    this.#appendResidual(segment);
    const complete = this.#residual!.subarray(0, this.#residualLength);
    this.#residualLength = 0;
    emit(this.#decodeLine(complete));
  }

  #appendResidual(segment: Uint8Array): void {
    if (segment.byteLength === 0) return;
    const byteLength = this.#residualLength + segment.byteLength;
    if (byteLength > NDJSON_LINE_BYTE_LIMIT) throw new Error("NDJSON record limit exceeded");
    if (!this.#residual) {
      this.#residual = new Uint8Array(NDJSON_LINE_BYTE_LIMIT);
      this.#bufferAllocations += 1;
    }
    this.#residual.set(segment, this.#residualLength);
    this.#residualLength = byteLength;
    this.#copiedBytes += segment.byteLength;
  }

  #decodeLine(bytes: Uint8Array): string {
    const line = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    return new TextDecoder("utf-8", { fatal: true }).decode(line);
  }
}

export const shouldOpenCodingRoomStream = (jobStatus: string | undefined, executionStatus?: string): boolean =>
  Boolean(jobStatus && ACTIVE_JOB_STATUSES.has(jobStatus))
  && !Boolean(executionStatus && TERMINAL_EXECUTION_STATUSES.has(executionStatus));

/** A clean authorized EOF is transient while the exact job/run is still active. */
export const codingRoomStreamEofTransition = (
  jobStatus: string | undefined,
  executionStatus?: string,
): "paused" | "terminal" => shouldOpenCodingRoomStream(jobStatus, executionStatus)
  ? "paused"
  : "terminal";

export const isTerminalExactIdentityRoomResponse = (status: number): boolean =>
  status === 400 || status === 401 || status === 404 || status === 410;

/**
 * Routes HTTP admission before a stream reader exists. Exact-authority
 * rejection is terminal; only transport/server failures reach retry policy.
 */
export const routeCodingRoomStreamAdmission = (
  response: {
    readonly status: number;
    readonly ok: boolean;
    readonly hasBody: boolean;
  },
  actions: {
    readonly onTerminal: () => void;
    readonly onRetry: () => void;
  },
): boolean => {
  if (isTerminalExactIdentityRoomResponse(response.status)) {
    actions.onTerminal();
    return false;
  }
  if (!response.ok || !response.hasBody) {
    actions.onRetry();
    return false;
  }
  return true;
};

export type CodingRoomReconnectTransition =
  | "connected"
  | "disposed"
  | "paused"
  | "record"
  | "replaced"
  | "terminal";

export const codingRoomReconnectDelay = (attempt: number): number =>
  Math.min(30_000, 600 * 2 ** Math.min(6, Math.max(0, attempt - 1)));

/** Pure retry lifecycle: transient pauses preserve the failure epoch. */
export class CodingRoomReconnectBackoff {
  #attempt = 0;

  get attempt(): number {
    return this.#attempt;
  }

  nextRetry(): Readonly<{ attempt: number; delayMs: number }> {
    this.#attempt += 1;
    return Object.freeze({
      attempt: this.#attempt,
      delayMs: codingRoomReconnectDelay(this.#attempt),
    });
  }

  transition(event: CodingRoomReconnectTransition): void {
    if (event !== "paused") this.#attempt = 0;
  }
}

type CodingByteStreamReader = Pick<
  ReadableStreamDefaultReader<Uint8Array>,
  "cancel" | "read" | "releaseLock"
>;

const cancelAndReleaseCodingStreamReader = (reader: CodingByteStreamReader): void => {
  void reader.cancel()
    .catch(() => undefined)
    .then(() => {
      try {
        reader.releaseLock();
      } catch {
        // The stream consumer may already have released this reader.
      }
    });
};

/** Checks the captured generation immediately after fetch resolves. */
export const awaitCurrentCodingStreamResponse = async (
  pendingResponse: Promise<Response>,
  isCurrent: () => boolean,
): Promise<Response | undefined> => {
  const response = await pendingResponse;
  if (isCurrent()) return response;
  try {
    await response.body?.cancel();
  } catch {
    // A concurrent abort may already have canceled the response body.
  }
  return undefined;
};

/** Synchronous caller-side fence for the microtask after the guarded fetch. */
export const acceptCurrentCodingStreamResponse = (
  response: Response | undefined,
  isCurrent: () => boolean,
): Response | undefined => {
  if (!response || isCurrent()) return response;
  if (response.body) void response.body.cancel().catch(() => undefined);
  return undefined;
};

/** Checks the captured generation immediately after each reader read resolves. */
export const readCurrentCodingStreamChunk = async (
  reader: CodingByteStreamReader,
  isCurrent: () => boolean,
): Promise<ReadableStreamReadResult<Uint8Array> | undefined> => {
  const chunk = await reader.read();
  if (isCurrent()) return chunk;
  try {
    await reader.cancel();
  } catch {
    // A lifecycle shutdown may already have canceled this reader.
  }
  return undefined;
};

/** Synchronous caller-side fence for the microtask after the guarded read. */
export const acceptCurrentCodingStreamChunk = (
  chunk: ReadableStreamReadResult<Uint8Array> | undefined,
  reader: CodingByteStreamReader,
  isCurrent: () => boolean,
): ReadableStreamReadResult<Uint8Array> | undefined => {
  if (!chunk || isCurrent()) return chunk;
  cancelAndReleaseCodingStreamReader(reader);
  return undefined;
};

export const createIdempotentDisposer = (dispose: () => void): (() => void) => {
  let complete = false;
  return () => {
    if (complete) return;
    complete = true;
    dispose();
  };
};
