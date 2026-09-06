import type { RuntimeExtensionDefinition } from "./runtime-extension.js";
import type {
  RuntimeExtensionHost,
  RuntimeExtensionReconciliationResult,
} from "./runtime-extension-host.js";

const MAX_DEBOUNCE_MS = 60_000;
const MAX_PENDING_CANDIDATES = 256;

export interface RuntimeExtensionReloadScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type RuntimeExtensionReloadStatus =
  | "applied"
  | "unchanged"
  | "superseded"
  | "failed"
  | "closed";

export type RuntimeExtensionReloadOutcome = {
  readonly requestId: string;
  readonly status: RuntimeExtensionReloadStatus;
  readonly generationId: string;
  readonly supersededBy?: string;
  readonly reconciliation?: RuntimeExtensionReconciliationResult;
  readonly error?: unknown;
};

export type RuntimeExtensionReloadOptions = {
  readonly debounceMs?: number;
  readonly maxPendingCandidates?: number;
  readonly scheduler?: RuntimeExtensionReloadScheduler;
  readonly onOutcome?: (
    outcome: RuntimeExtensionReloadOutcome,
  ) => void | Promise<void>;
};

type PendingCandidate = {
  readonly requestId: string;
  readonly definitions: ReadonlyArray<RuntimeExtensionDefinition>;
  readonly resolve: (outcome: RuntimeExtensionReloadOutcome) => void;
};

const systemScheduler: RuntimeExtensionReloadScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const boundedInteger = (
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const immutableCandidate = (
  definitions: ReadonlyArray<RuntimeExtensionDefinition>,
): ReadonlyArray<RuntimeExtensionDefinition> => Object.freeze(definitions.map((definition) => {
  const id = definition.id;
  const version = definition.version;
  const artifactHash = definition.artifactHash;
  const configurationHash = definition.configurationHash;
  const requires = definition.requires?.map((service) => Object.freeze({
    id: service.id,
    version: service.version,
  }));
  const provides = definition.provides?.map((service) => Object.freeze({
    id: service.id,
    version: service.version,
  }));
  const activate = definition.activate;
  return Object.freeze({
    id,
    version,
    ...(artifactHash !== undefined ? { artifactHash } : {}),
    ...(configurationHash !== undefined ? { configurationHash } : {}),
    ...(requires ? { requires: Object.freeze(requires) } : {}),
    ...(provides ? { provides: Object.freeze(provides) } : {}),
    activate,
  });
}));

/**
 * Optional development adapter for source-agnostic runtime extension reloads.
 * It owns no file watcher and mutates no node, task, receipt, or durable state.
 * Production callers should submit controlled desired manifests through their
 * deployment authority instead of treating local source events as authority.
 */
export class RuntimeExtensionReloadAdapter {
  readonly #host: RuntimeExtensionHost;
  readonly #debounceMs: number;
  readonly #maxPendingCandidates: number;
  readonly #scheduler: RuntimeExtensionReloadScheduler;
  readonly #onOutcome?: RuntimeExtensionReloadOptions["onOutcome"];
  readonly #pending: PendingCandidate[] = [];
  readonly #observerTasks = new Set<Promise<void>>();
  #requestSequence = 0;
  #timer: unknown;
  #running: Promise<void> | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(host: RuntimeExtensionHost, options: RuntimeExtensionReloadOptions = {}) {
    this.#host = host;
    this.#debounceMs = boundedInteger(
      options.debounceMs ?? 100,
      "Runtime extension reload debounceMs",
      1,
      MAX_DEBOUNCE_MS,
    );
    this.#maxPendingCandidates = boundedInteger(
      options.maxPendingCandidates ?? 16,
      "Runtime extension reload maxPendingCandidates",
      1,
      MAX_PENDING_CANDIDATES,
    );
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#onOutcome = options.onOutcome;
  }

  submit(
    definitions: ReadonlyArray<RuntimeExtensionDefinition>,
  ): Promise<RuntimeExtensionReloadOutcome> {
    const requestId = this.#nextRequestId();
    if (this.#closed) {
      const outcome = this.#outcome(requestId, "closed");
      this.#observe(outcome);
      return Promise.resolve(outcome);
    }

    let snapshot: ReadonlyArray<RuntimeExtensionDefinition>;
    try {
      snapshot = immutableCandidate(definitions);
    } catch (error) {
      const outcome = this.#outcome(requestId, "failed", { error });
      this.#observe(outcome);
      return Promise.resolve(outcome);
    }

    return new Promise<RuntimeExtensionReloadOutcome>((resolve) => {
      const candidate = Object.freeze({ requestId, definitions: snapshot, resolve });
      this.#pending.push(candidate);
      if (this.#pending.length > this.#maxPendingCandidates) {
        const superseded = this.#pending.shift()!;
        this.#settle(superseded, this.#outcome(superseded.requestId, "superseded", {
          supersededBy: requestId,
        }));
      }
      this.#schedule();
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const pending = this.#pending.splice(0);
    for (const candidate of pending) {
      this.#settle(candidate, this.#outcome(candidate.requestId, "closed"));
    }
    await this.#running;
    await Promise.allSettled([...this.#observerTasks]);
  }

  #schedule(): void {
    if (
      this.#closed
      || this.#running
      || this.#timer !== undefined
      || this.#pending.length === 0
    ) {
      return;
    }
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = undefined;
      this.#startLatest();
    }, this.#debounceMs);
  }

  #startLatest(): void {
    if (this.#closed || this.#running || this.#pending.length === 0) return;
    const candidates = this.#pending.splice(0);
    const selected = candidates.pop()!;
    for (const candidate of candidates) {
      this.#settle(candidate, this.#outcome(candidate.requestId, "superseded", {
        supersededBy: selected.requestId,
      }));
    }
    this.#running = this.#apply(selected).finally(() => {
      this.#running = undefined;
      this.#schedule();
    });
  }

  async #apply(candidate: PendingCandidate): Promise<void> {
    try {
      const reconciliation = await this.#host.reconcile(candidate.definitions);
      const status = reconciliation.changed ? "applied" : "unchanged";
      this.#settle(candidate, this.#outcome(candidate.requestId, status, { reconciliation }));
    } catch (error) {
      this.#settle(candidate, this.#outcome(candidate.requestId, "failed", { error }));
    }
  }

  #nextRequestId(): string {
    if (this.#requestSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Runtime extension reload request sequence is exhausted");
    }
    this.#requestSequence += 1;
    return `runtime_reload_${this.#requestSequence}`;
  }

  #outcome(
    requestId: string,
    status: RuntimeExtensionReloadStatus,
    detail: Pick<
      RuntimeExtensionReloadOutcome,
      "supersededBy" | "reconciliation" | "error"
    > = {},
  ): RuntimeExtensionReloadOutcome {
    return Object.freeze({
      requestId,
      status,
      generationId: this.#host.generation().generationId,
      ...(detail.supersededBy ? { supersededBy: detail.supersededBy } : {}),
      ...(detail.reconciliation ? { reconciliation: detail.reconciliation } : {}),
      ...(detail.error !== undefined ? { error: detail.error } : {}),
    });
  }

  #settle(candidate: PendingCandidate, outcome: RuntimeExtensionReloadOutcome): void {
    candidate.resolve(outcome);
    this.#observe(outcome);
  }

  #observe(outcome: RuntimeExtensionReloadOutcome): void {
    if (!this.#onOutcome) return;
    let task: Promise<void>;
    try {
      task = Promise.resolve(this.#onOutcome(outcome)).then(() => undefined, () => undefined);
    } catch {
      return;
    }
    this.#observerTasks.add(task);
    void task.finally(() => this.#observerTasks.delete(task));
  }
}
