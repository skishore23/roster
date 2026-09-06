import { createHash } from "node:crypto";

export const NODE_ROOM_UPDATE_SCHEMA = "roster.node-room-update.v1" as const;
export const NODE_ROOM_UPDATE_TEXT_LIMIT = 420;
export const NODE_ROOM_UPDATE_RECIPIENT_LIMIT = 6;
export const NODE_ROOM_UPDATE_TASK_LIMIT = 3;

export type NodeRoomUpdateIntent = "progress" | "acknowledgement" | "question";

export interface NodeRoomUpdateInput {
  updateKey: string;
  text: string;
  intent: NodeRoomUpdateIntent;
  recipientNodeIds: string[];
}

export interface NodeRoomUpdateContext {
  runId: string;
  taskId: string;
  executionId: string;
  nodeId: string;
  at?: string;
}

export interface NodeRoomUpdate {
  schema: typeof NODE_ROOM_UPDATE_SCHEMA;
  updateId: string;
  runId: string;
  taskId: string;
  executionId: string;
  nodeId: string;
  updateKey: string;
  text: string;
  intent: NodeRoomUpdateIntent;
  recipientNodeIds: readonly string[];
  sequence: number;
  at: string;
  settled: boolean;
}

export type NodeRoomUpdateStoreEvent = {
  type: "update" | "settled";
  update: NodeRoomUpdate;
};

export class NodeRoomUpdateValidationError extends Error {}

export type NodeRoomUpdateStoreOptions = {
  readonly maxRuns?: number;
  readonly maxUpdatesPerRun?: number;
  readonly now?: () => string;
};

type NodeRoomUpdateListener = (event: NodeRoomUpdateStoreEvent) => void;
type RunRoomUpdates = {
  readonly updates: Map<string, NodeRoomUpdate>;
  nextSequence: number;
};

const UPDATE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const INTENTS = new Set<NodeRoomUpdateIntent>(["progress", "acknowledgement", "question"]);

const validationError = (message: string): NodeRoomUpdateValidationError =>
  new NodeRoomUpdateValidationError(message);

const requireIdentity = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string.`);
  }
  return value;
};

const normalizeInput = (input: NodeRoomUpdateInput): NodeRoomUpdateInput => {
  if (!UPDATE_KEY_PATTERN.test(input.updateKey)) {
    throw validationError("updateKey must match /^[a-z][a-z0-9-]{0,47}$/u.");
  }
  const text = input.text.trim();
  if (text.length === 0 || text.length > NODE_ROOM_UPDATE_TEXT_LIMIT) {
    throw validationError(`text must contain between 1 and ${NODE_ROOM_UPDATE_TEXT_LIMIT} characters.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    throw validationError("text must not contain control characters other than newline and tab.");
  }
  if (!INTENTS.has(input.intent)) {
    throw validationError("intent must be progress, acknowledgement, or question.");
  }
  const recipientNodeIds = input.recipientNodeIds.map((recipientNodeId) => {
    if (typeof recipientNodeId !== "string" || recipientNodeId.trim().length === 0) {
      throw validationError("recipientNodeIds must contain non-empty strings.");
    }
    return recipientNodeId.trim();
  });
  const normalizedRecipients = [...new Set(recipientNodeIds)].sort();
  if (normalizedRecipients.length > NODE_ROOM_UPDATE_RECIPIENT_LIMIT) {
    throw validationError(`recipientNodeIds must contain at most ${NODE_ROOM_UPDATE_RECIPIENT_LIMIT} recipients.`);
  }

  return {
    updateKey: input.updateKey,
    text,
    intent: input.intent,
    recipientNodeIds: normalizedRecipients,
  };
};

const updateIdFor = (context: NodeRoomUpdateContext, updateKey: string): string =>
  createHash("sha256")
    .update(JSON.stringify([NODE_ROOM_UPDATE_SCHEMA, context.runId, context.taskId, context.nodeId, updateKey]), "utf8")
    .digest("hex");

const copyUpdate = (update: NodeRoomUpdate): NodeRoomUpdate => Object.freeze({
  ...update,
  recipientNodeIds: Object.freeze([...update.recipientNodeIds]),
});

/**
 * Bounded process-local presentation updates. This store is intentionally not
 * a receipt, task inbox, or task-acceptance authority.
 */
export class NodeRoomUpdateStore {
  readonly #updatesByRun = new Map<string, RunRoomUpdates>();
  readonly #updateKeysByRunTask = new Map<string, Map<string, Set<string>>>();
  readonly #listenersByRun = new Map<string, Set<NodeRoomUpdateListener>>();
  readonly #maxRuns: number;
  readonly #maxUpdatesPerRun: number;
  readonly #now: () => string;

  constructor(options: NodeRoomUpdateStoreOptions = {}) {
    this.#maxRuns = Math.max(1, options.maxRuns ?? 32);
    this.#maxUpdatesPerRun = Math.max(1, options.maxUpdatesPerRun ?? 500);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  post(context: NodeRoomUpdateContext, input: NodeRoomUpdateInput): NodeRoomUpdate {
    const runId = requireIdentity(context.runId, "runId");
    const taskId = requireIdentity(context.taskId, "taskId");
    const executionId = requireIdentity(context.executionId, "executionId");
    const nodeId = requireIdentity(context.nodeId, "nodeId");
    const at = context.at === undefined ? this.#now() : requireIdentity(context.at, "at");
    const normalized = normalizeInput(input);
    const updateId = updateIdFor(context, normalized.updateKey);
    const run = this.#runUpdatesFor(runId);
    const existing = run.updates.get(updateId);
    let taskKeys = this.#taskKeysFor(runId, taskId);

    if (!existing && !taskKeys.has(normalized.updateKey) && taskKeys.size >= NODE_ROOM_UPDATE_TASK_LIMIT) {
      throw validationError(`task may contain at most ${NODE_ROOM_UPDATE_TASK_LIMIT} distinct update keys.`);
    }
    if (!existing && run.updates.size >= this.#maxUpdatesPerRun) {
      this.#removeOldestUpdate(runId, run);
      taskKeys = this.#taskKeysFor(runId, taskId);
    }

    taskKeys.add(normalized.updateKey);
    const update = copyUpdate({
      schema: NODE_ROOM_UPDATE_SCHEMA,
      updateId,
      runId,
      taskId,
      executionId,
      nodeId,
      ...normalized,
      sequence: run.nextSequence,
      at,
      settled: existing?.settled ?? false,
    });
    run.nextSequence += 1;
    run.updates.set(updateId, update);
    this.#emit(runId, { type: "update", update });
    return copyUpdate(update);
  }

  list(runId: string): readonly NodeRoomUpdate[] {
    const run = this.#updatesByRun.get(runId);
    if (!run) {
      return Object.freeze([]);
    }
    return Object.freeze([...run.updates.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map(copyUpdate));
  }

  settleTask(runId: string, taskId: string): void {
    const run = this.#updatesByRun.get(runId);
    if (!run) {
      return;
    }
    for (const [updateId, existing] of run.updates) {
      if (existing.taskId !== taskId || existing.settled) {
        continue;
      }
      const update = copyUpdate({ ...existing, settled: true });
      run.updates.set(updateId, update);
      this.#emit(runId, { type: "settled", update });
    }
  }

  subscribe(runId: string, listener: NodeRoomUpdateListener): () => void {
    let listeners = this.#listenersByRun.get(runId);
    if (!listeners) {
      listeners = new Set();
      this.#listenersByRun.set(runId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.#listenersByRun.delete(runId);
        this.#trimInactiveRuns();
      }
    };
  }

  clear(runId?: string): void {
    if (runId) {
      this.#updatesByRun.delete(runId);
      this.#updateKeysByRunTask.delete(runId);
      return;
    }
    this.#updatesByRun.clear();
    this.#updateKeysByRunTask.clear();
  }

  #runUpdatesFor(runId: string): RunRoomUpdates {
    let run = this.#updatesByRun.get(runId);
    if (!run) {
      run = { updates: new Map(), nextSequence: 1 };
      this.#updatesByRun.set(runId, run);
      this.#trimInactiveRuns();
    }
    return run;
  }

  #trimInactiveRuns(): void {
    const inactiveRunIds = [...this.#updatesByRun.keys()]
      .filter((runId) => !this.#listenersByRun.has(runId));
    while (inactiveRunIds.length > this.#maxRuns) {
      const oldestRunId = inactiveRunIds.shift();
      if (!oldestRunId) break;
      this.#updatesByRun.delete(oldestRunId);
      this.#updateKeysByRunTask.delete(oldestRunId);
    }
  }

  #removeOldestUpdate(runId: string, run: RunRoomUpdates): void {
    const oldest = [...run.updates.values()].sort((left, right) =>
      (left.sequence - right.sequence) || left.updateId.localeCompare(right.updateId))[0];
    if (!oldest) return;
    run.updates.delete(oldest.updateId);
    const taskKeysByTask = this.#updateKeysByRunTask.get(runId);
    const taskKeys = taskKeysByTask?.get(oldest.taskId);
    taskKeys?.delete(oldest.updateKey);
    if (taskKeys?.size === 0) taskKeysByTask?.delete(oldest.taskId);
    if (taskKeysByTask?.size === 0) this.#updateKeysByRunTask.delete(runId);
  }

  #taskKeysFor(runId: string, taskId: string): Set<string> {
    let tasks = this.#updateKeysByRunTask.get(runId);
    if (!tasks) {
      tasks = new Map();
      this.#updateKeysByRunTask.set(runId, tasks);
    }
    let keys = tasks.get(taskId);
    if (!keys) {
      keys = new Set();
      tasks.set(taskId, keys);
    }
    return keys;
  }

  #emit(runId: string, event: NodeRoomUpdateStoreEvent): void {
    for (const listener of this.#listenersByRun.get(runId) ?? []) {
      listener(Object.freeze({ type: event.type, update: copyUpdate(event.update) }));
    }
  }
}
