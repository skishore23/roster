import type { NodeExecutionLogEvent } from "./node-runtime.js";

const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

export type StoredNodeRuntimeLog = NodeExecutionLogEvent & {
  readonly sequence: number;
  readonly at: number;
  readonly truncated: boolean;
};

export type NodeRuntimeLogReader = {
  readonly list: (runId: string, options?: {
    readonly nodeId?: string;
    readonly limit?: number;
  }) => ReadonlyArray<StoredNodeRuntimeLog>;
};

export type NodeRuntimeLogSource = NodeRuntimeLogReader & {
  /** Process-local observation only; durable task state remains receipt-owned. */
  readonly subscribe: (
    runId: string,
    listener: (entry: StoredNodeRuntimeLog) => void,
  ) => () => void;
};

export type NodeRuntimeLogStoreOptions = {
  readonly maxRuns?: number;
  readonly maxEntriesPerRun?: number;
  readonly maxBytesPerRun?: number;
  readonly maxEntryBytes?: number;
  readonly now?: () => number;
};

export type NodeRuntimeLogPendingBufferOptions = {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
};

type RunLogs = {
  readonly entries: StoredNodeRuntimeLog[];
  nextSequence: number;
  bytes: number;
};

const utf8Prefix = (value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } => {
  const source = Buffer.from(value);
  if (source.byteLength <= maxBytes) return { text: value, truncated: false };
  return { text: source.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, ""), truncated: true };
};

const runtimeLogStreamBytes = (entry: StoredNodeRuntimeLog): number =>
  Buffer.byteLength(`${JSON.stringify({ type: "log", entry })}\n`);

/**
 * Per-client runtime-log backpressure boundary. A blocked writer retains the
 * newest deterministic sequence suffix and can never accumulate more than the
 * configured entry or encoded-byte budget.
 */
export class NodeRuntimeLogPendingBuffer {
  private readonly entries: StoredNodeRuntimeLog[] = [];
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(options: NodeRuntimeLogPendingBufferOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 128);
    this.maxBytes = Math.max(1, options.maxBytes ?? 256 * 1_024);
  }

  get size(): number {
    return this.entries.length;
  }

  get byteLength(): number {
    return this.bytes;
  }

  push(entry: StoredNodeRuntimeLog): void {
    const existingIndex = this.entries.findIndex((candidate) =>
      candidate.sequence === entry.sequence);
    if (existingIndex >= 0) {
      const [existing] = this.entries.splice(existingIndex, 1);
      if (existing) this.bytes -= runtimeLogStreamBytes(existing);
    }
    const entryBytes = runtimeLogStreamBytes(entry);
    if (entryBytes > this.maxBytes) return;
    this.entries.push({ ...entry });
    this.entries.sort((left, right) => left.sequence - right.sequence);
    this.bytes += entryBytes;
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.bytes -= runtimeLogStreamBytes(removed);
    }
  }

  shift(): StoredNodeRuntimeLog | undefined {
    const entry = this.entries.shift();
    if (entry) this.bytes -= runtimeLogStreamBytes(entry);
    return entry ? { ...entry } : undefined;
  }

  clear(): void {
    this.entries.length = 0;
    this.bytes = 0;
  }
}

/** Bounded process-local diagnostics for the live Coding inspector. */
export class NodeRuntimeLogStore implements NodeRuntimeLogSource {
  private readonly runs = new Map<string, RunLogs>();
  private readonly subscribers = new Map<string, Set<(entry: StoredNodeRuntimeLog) => void>>();
  private readonly maxRuns: number;
  private readonly maxEntriesPerRun: number;
  private readonly maxBytesPerRun: number;
  private readonly maxEntryBytes: number;
  private readonly now: () => number;

  constructor(options: NodeRuntimeLogStoreOptions = {}) {
    this.maxRuns = Math.max(1, options.maxRuns ?? 32);
    this.maxEntriesPerRun = Math.max(1, options.maxEntriesPerRun ?? 500);
    this.maxBytesPerRun = Math.max(1_024, options.maxBytesPerRun ?? 512 * 1_024);
    this.maxEntryBytes = Math.max(128, Math.min(options.maxEntryBytes ?? 8 * 1_024, this.maxBytesPerRun));
    this.now = options.now ?? Date.now;
  }

  append(input: NodeExecutionLogEvent): void {
    const sanitized = input.text.replace(ANSI_ESCAPE, "").replace(UNSAFE_CONTROL, "");
    if (!sanitized) return;
    const bounded = utf8Prefix(sanitized, this.maxEntryBytes);
    let run = this.runs.get(input.runId);
    if (!run) {
      while (this.runs.size >= this.maxRuns) {
        const oldest = this.runs.keys().next().value as string | undefined;
        if (!oldest) break;
        this.runs.delete(oldest);
      }
      run = { entries: [], nextSequence: 1, bytes: 0 };
      this.runs.set(input.runId, run);
    }
    const entry: StoredNodeRuntimeLog = {
      ...input,
      text: bounded.text,
      sequence: run.nextSequence,
      at: this.now(),
      truncated: bounded.truncated,
    };
    run.nextSequence += 1;
    run.entries.push(entry);
    run.bytes += Buffer.byteLength(entry.text);
    while (run.entries.length > this.maxEntriesPerRun || run.bytes > this.maxBytesPerRun) {
      const removed = run.entries.shift();
      if (!removed) break;
      run.bytes -= Buffer.byteLength(removed.text);
    }
    for (const listener of this.subscribers.get(input.runId) ?? []) {
      try {
        listener({ ...entry });
      } catch {
        // Diagnostic observers must never fail the runtime that produced a log.
      }
    }
  }

  list(runId: string, options: { readonly nodeId?: string; readonly limit?: number } = {}): ReadonlyArray<StoredNodeRuntimeLog> {
    const entries = this.runs.get(runId)?.entries ?? [];
    const filtered = options.nodeId ? entries.filter((entry) => entry.nodeId === options.nodeId) : entries;
    const limit = Math.max(1, Math.min(options.limit ?? this.maxEntriesPerRun, this.maxEntriesPerRun));
    return filtered.slice(-limit).map((entry) => ({ ...entry }));
  }

  subscribe(runId: string, listener: (entry: StoredNodeRuntimeLog) => void): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set<(entry: StoredNodeRuntimeLog) => void>();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(runId);
    };
  }

  clear(runId?: string): void {
    if (runId) this.runs.delete(runId);
    else this.runs.clear();
  }
}
