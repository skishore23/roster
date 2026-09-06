import {
  activateRuntimeComponent,
  RuntimeEffectCleanupError,
  type ActivatedRuntimeComponent,
  type RuntimeEffectScope,
  type RuntimeEffectScopeLimits,
} from "./runtime-effect-scope.js";

export type RuntimeBindingEpochIdentity = {
  readonly nodeId: string;
  readonly epoch: number;
};

export type RuntimeBindingLifecycleLimits = {
  readonly maxAttemptLeases: number;
  readonly drainTimeoutMs: number;
  readonly effectScope?: Partial<RuntimeEffectScopeLimits>;
};

export const DEFAULT_RUNTIME_BINDING_LIFECYCLE_LIMITS: RuntimeBindingLifecycleLimits =
  Object.freeze({
    maxAttemptLeases: 128,
    drainTimeoutMs: 5_000,
  });

export const MAX_RUNTIME_BINDING_ATTEMPT_LEASES = 4_096;
export const MAX_RUNTIME_BINDING_DRAIN_TIMEOUT_MS = 300_000;

export class RuntimeBindingDrainTimeoutError extends Error {
  declare readonly code: "ROSTER_RUNTIME_BINDING_DRAIN_TIMEOUT";
  declare readonly nodeId: string;
  declare readonly epoch: number;
  declare readonly drainTimeoutMs: number;
  declare readonly attemptIds: ReadonlyArray<string>;

  constructor(input: {
    readonly identity: RuntimeBindingEpochIdentity;
    readonly drainTimeoutMs: number;
    readonly attemptIds: ReadonlyArray<string>;
  }) {
    const attemptIds = Object.freeze([...input.attemptIds].sort());
    super(
      `Runtime binding ${input.identity.nodeId}@${input.identity.epoch} did not drain `
      + `within drainTimeoutMs=${input.drainTimeoutMs}; aborting ${attemptIds.length} attempt(s)`,
    );
    this.name = "RuntimeBindingDrainTimeoutError";
    defineMetadata(this, {
      code: "ROSTER_RUNTIME_BINDING_DRAIN_TIMEOUT",
      nodeId: input.identity.nodeId,
      epoch: input.identity.epoch,
      drainTimeoutMs: input.drainTimeoutMs,
      attemptIds,
    });
  }
}

export class RuntimeBindingPublishRollbackError extends AggregateError {
  declare readonly code: "ROSTER_RUNTIME_BINDING_PUBLISH_AND_ROLLBACK_FAILED";
  declare readonly identity: RuntimeBindingEpochIdentity;
  declare readonly publishError: unknown;
  declare readonly cleanupError: RuntimeEffectCleanupError;

  constructor(input: {
    readonly identity: RuntimeBindingEpochIdentity;
    readonly publishError: unknown;
    readonly cleanupError: RuntimeEffectCleanupError;
  }) {
    super(
      [input.publishError, input.cleanupError],
      `Runtime binding ${input.identity.nodeId}@${input.identity.epoch} publish and rollback both failed`,
      { cause: input.publishError },
    );
    this.name = "RuntimeBindingPublishRollbackError";
    defineMetadata(this, {
      code: "ROSTER_RUNTIME_BINDING_PUBLISH_AND_ROLLBACK_FAILED",
      identity: input.identity,
      publishError: input.publishError,
      cleanupError: input.cleanupError,
    });
  }
}

export type RuntimeBindingLifecycleDiagnostic =
  | {
      readonly kind: "drain-timeout";
      readonly identity: RuntimeBindingEpochIdentity;
      readonly error: RuntimeBindingDrainTimeoutError;
    }
  | {
      readonly kind: "cleanup-failed";
      readonly identity: RuntimeBindingEpochIdentity;
      readonly error: RuntimeEffectCleanupError;
    };

export type RuntimeBindingEpochTransition = {
  readonly identity: RuntimeBindingEpochIdentity;
  readonly previousEpoch?: number;
  readonly diagnostics: ReadonlyArray<RuntimeBindingLifecycleDiagnostic>;
};

export type RuntimeBindingAttemptLease<Runtime> = {
  readonly attemptId: string;
  readonly nodeId: string;
  readonly epoch: number;
  readonly runtime: Runtime;
  /** Aborted when the caller aborts or the retired epoch exceeds its drain bound. */
  readonly signal: AbortSignal;
  readonly release: () => void;
  readonly toJSON: () => never;
};

type AttemptRecord = {
  readonly attemptId: string;
  readonly controller: AbortController;
  readonly detachCallerSignal: () => void;
  released: boolean;
};

type EpochState<Runtime> = {
  readonly identity: RuntimeBindingEpochIdentity;
  readonly activation: ActivatedRuntimeComponent<Runtime>;
  readonly attempts: Map<string, AttemptRecord>;
  readonly drainWaiters: Set<() => void>;
  status: "current" | "draining" | "closed";
};

const MAX_ID_LENGTH = 512;

const boundedId = (value: string, label: string): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  if (normalized !== value) throw new Error(`${label} must not contain surrounding whitespace`);
  if (normalized.length > MAX_ID_LENGTH) {
    throw new Error(`${label} must not exceed ${MAX_ID_LENGTH} characters`);
  }
  return normalized;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
};

const defineMetadata = (
  target: object,
  metadata: Readonly<Record<string, unknown>>,
): void => {
  Object.defineProperties(target, Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    }]),
  ));
};

const snapshotIdentity = (nodeId: string, epoch: number): RuntimeBindingEpochIdentity =>
  Object.freeze({
    nodeId: boundedId(nodeId, "Runtime binding node id"),
    epoch: positiveInteger(epoch, "Runtime binding epoch"),
  });

const normalizedLimits = (
  limits: Partial<RuntimeBindingLifecycleLimits> | undefined,
): RuntimeBindingLifecycleLimits => {
  const maxAttemptLeases = limits?.maxAttemptLeases
    ?? DEFAULT_RUNTIME_BINDING_LIFECYCLE_LIMITS.maxAttemptLeases;
  const drainTimeoutMs = limits?.drainTimeoutMs
    ?? DEFAULT_RUNTIME_BINDING_LIFECYCLE_LIMITS.drainTimeoutMs;
  if (
    !Number.isSafeInteger(maxAttemptLeases)
    || maxAttemptLeases < 1
    || maxAttemptLeases > MAX_RUNTIME_BINDING_ATTEMPT_LEASES
  ) {
    throw new Error(
      `Runtime binding maxAttemptLeases must be between 1 and ${MAX_RUNTIME_BINDING_ATTEMPT_LEASES}`,
    );
  }
  if (
    !Number.isSafeInteger(drainTimeoutMs)
    || drainTimeoutMs < 1
    || drainTimeoutMs > MAX_RUNTIME_BINDING_DRAIN_TIMEOUT_MS
  ) {
    throw new Error(
      `Runtime binding drainTimeoutMs must be between 1 and ${MAX_RUNTIME_BINDING_DRAIN_TIMEOUT_MS}`,
    );
  }
  return Object.freeze({
    maxAttemptLeases,
    drainTimeoutMs,
    ...(limits?.effectScope
      ? { effectScope: Object.freeze({ ...limits.effectScope }) }
      : {}),
  });
};

const abortReason = (signal: AbortSignal, fallback: string): Error =>
  signal.reason instanceof Error ? signal.reason : new Error(fallback);

const freezeDiagnostic = (
  diagnostic: RuntimeBindingLifecycleDiagnostic,
): RuntimeBindingLifecycleDiagnostic => Object.freeze(diagnostic);

/**
 * Process-local lifecycle for replaceable execution placement. Durable binding
 * publication remains exclusively owned by the supplied publish callback.
 */
export class RuntimeBindingEpochLifecycleManager<Runtime> {
  readonly #nodeId: string;
  readonly #limits: RuntimeBindingLifecycleLimits;
  #current: EpochState<Runtime> | undefined;
  #lastPublishedEpoch = 0;
  #transitioning = false;
  #closed = false;
  #closePromise: Promise<ReadonlyArray<RuntimeBindingLifecycleDiagnostic>> | undefined;

  constructor(input: {
    readonly nodeId: string;
    readonly limits?: Partial<RuntimeBindingLifecycleLimits>;
  }) {
    this.#nodeId = boundedId(input.nodeId, "Runtime binding lifecycle node id");
    this.#limits = normalizedLimits(input.limits);
  }

  get nodeId(): string {
    return this.#nodeId;
  }

  get current(): RuntimeBindingEpochIdentity | undefined {
    return this.#current?.identity;
  }

  acquire(input: {
    readonly attemptId: string;
    readonly signal?: AbortSignal;
  }): RuntimeBindingAttemptLease<Runtime> {
    if (this.#closed) throw new Error(`Runtime binding lifecycle for ${this.#nodeId} is closed`);
    const state = this.#current;
    if (!state || state.status !== "current") {
      throw new Error(`Runtime binding lifecycle for ${this.#nodeId} has no current epoch`);
    }
    const attemptId = boundedId(input.attemptId, "Runtime binding attempt id");
    if (state.attempts.has(attemptId)) {
      throw new Error(
        `Runtime binding ${this.#nodeId}@${state.identity.epoch} already leased attempt ${attemptId}`,
      );
    }
    if (state.attempts.size >= this.#limits.maxAttemptLeases) {
      throw new Error(
        `Runtime binding ${this.#nodeId}@${state.identity.epoch} exceeded `
        + `maxAttemptLeases=${this.#limits.maxAttemptLeases}`,
      );
    }
    if (input.signal?.aborted) {
      throw abortReason(input.signal, `Runtime binding attempt ${attemptId} was aborted before acquisition`);
    }

    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(abortReason(
      input.signal!,
      `Runtime binding attempt ${attemptId} was aborted`,
    ));
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const record: AttemptRecord = {
      attemptId,
      controller,
      detachCallerSignal: () => input.signal?.removeEventListener("abort", abortFromCaller),
      released: false,
    };
    state.attempts.set(attemptId, record);

    const release = (): void => this.#releaseAttempt(state, record);
    return Object.freeze({
      attemptId,
      nodeId: this.#nodeId,
      epoch: state.identity.epoch,
      runtime: state.activation.value,
      signal: controller.signal,
      release,
      toJSON: () => {
        throw new Error("RuntimeBindingAttemptLease is process-local and cannot be serialized");
      },
    });
  }

  async replace(input: {
    readonly epoch: number;
    readonly activate: (
      scope: RuntimeEffectScope,
      identity: RuntimeBindingEpochIdentity,
    ) => Runtime | Promise<Runtime>;
    readonly validateReady: (
      runtime: Runtime,
      identity: RuntimeBindingEpochIdentity,
    ) => void | Promise<void>;
    /** The only durable mutation in this lifecycle; it must publish the exact identity. */
    readonly publish: (identity: RuntimeBindingEpochIdentity) => void | Promise<void>;
  }): Promise<RuntimeBindingEpochTransition> {
    if (this.#closed) throw new Error(`Runtime binding lifecycle for ${this.#nodeId} is closed`);
    if (this.#transitioning) {
      throw new Error(`Runtime binding lifecycle for ${this.#nodeId} already has a transition in progress`);
    }
    const identity = snapshotIdentity(this.#nodeId, input.epoch);
    if (identity.epoch <= this.#lastPublishedEpoch) {
      throw new Error(
        `Runtime binding epoch ${identity.epoch} must be greater than published epoch ${this.#lastPublishedEpoch}`,
      );
    }
    this.#transitioning = true;
    try {
      // Activation and readiness remain private. The candidate cannot be
      // acquired until the durable publication callback succeeds.
      const activation = await activateRuntimeComponent({
        owner: { kind: "runtime-binding", nodeId: this.#nodeId, epoch: identity.epoch },
        ...(this.#limits.effectScope ? { limits: this.#limits.effectScope } : {}),
        activate: async (scope) => {
          const runtime = await input.activate(scope, identity);
          await input.validateReady(runtime, identity);
          return runtime;
        },
      });

      try {
        await input.publish(identity);
      } catch (publishError) {
        try {
          await activation.close();
        } catch (cleanupError) {
          if (!(cleanupError instanceof RuntimeEffectCleanupError)) throw cleanupError;
          throw new RuntimeBindingPublishRollbackError({
            identity,
            publishError,
            cleanupError,
          });
        }
        throw publishError;
      }

      const previous = this.#current;
      const candidate: EpochState<Runtime> = {
        identity,
        activation,
        attempts: new Map(),
        drainWaiters: new Set(),
        status: "current",
      };
      // This synchronous state change is the process-local acquisition commit.
      // No acquisition can observe an intermediate state in this JS turn.
      if (previous) previous.status = "draining";
      this.#current = candidate;
      this.#lastPublishedEpoch = identity.epoch;

      const diagnostics = previous
        ? await this.#drainAndClose(previous)
        : [];
      return Object.freeze({
        identity,
        ...(previous ? { previousEpoch: previous.identity.epoch } : {}),
        diagnostics: Object.freeze(diagnostics),
      });
    } finally {
      this.#transitioning = false;
    }
  }

  close(): Promise<ReadonlyArray<RuntimeBindingLifecycleDiagnostic>> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#transitioning) {
      return Promise.reject(new Error(
        `Runtime binding lifecycle for ${this.#nodeId} cannot close during an epoch transition`,
      ));
    }
    this.#closed = true;
    const current = this.#current;
    this.#current = undefined;
    if (current) current.status = "draining";
    this.#closePromise = current
      ? this.#drainAndClose(current).then((diagnostics) => Object.freeze(diagnostics))
      : Promise.resolve(Object.freeze([]));
    return this.#closePromise;
  }

  toJSON(): never {
    throw new Error("RuntimeBindingEpochLifecycleManager is process-local and cannot be serialized");
  }

  #releaseAttempt(state: EpochState<Runtime>, record: AttemptRecord): void {
    if (record.released) return;
    record.released = true;
    record.detachCallerSignal();
    state.attempts.delete(record.attemptId);
    if (state.attempts.size === 0) {
      for (const resolve of state.drainWaiters) resolve();
      state.drainWaiters.clear();
    }
  }

  async #drainAndClose(
    state: EpochState<Runtime>,
  ): Promise<RuntimeBindingLifecycleDiagnostic[]> {
    const diagnostics: RuntimeBindingLifecycleDiagnostic[] = [];
    if (state.attempts.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = new Promise<"drained">((resolve) => {
        state.drainWaiters.add(() => resolve("drained"));
      });
      const outcome = await Promise.race([
        drained,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.#limits.drainTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      state.drainWaiters.clear();
      if (outcome === "timeout") {
        const attemptIds = [...state.attempts.keys()].sort();
        const error = new RuntimeBindingDrainTimeoutError({
          identity: state.identity,
          drainTimeoutMs: this.#limits.drainTimeoutMs,
          attemptIds,
        });
        diagnostics.push(freezeDiagnostic({
          kind: "drain-timeout",
          identity: state.identity,
          error,
        }));
        for (const record of [...state.attempts.values()]) {
          record.controller.abort(error);
          this.#releaseAttempt(state, record);
        }
      }
    }

    try {
      await state.activation.close();
    } catch (error) {
      if (!(error instanceof RuntimeEffectCleanupError)) throw error;
      diagnostics.push(freezeDiagnostic({
        kind: "cleanup-failed",
        identity: state.identity,
        error,
      }));
    } finally {
      state.status = "closed";
    }
    return diagnostics;
  }
}
