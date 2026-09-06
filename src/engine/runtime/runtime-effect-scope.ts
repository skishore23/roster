/**
 * Process-local ownership for ephemeral runtime effects. These descriptors are
 * diagnostics only: they are not receipts, runtime bindings, task authority,
 * or values that may cross a node execution envelope.
 */
export type RuntimeEffectActivationOwner = {
  readonly kind: "activation";
  readonly activationId: string;
};

export type RuntimeEffectTaskAttemptOwner = {
  readonly kind: "task-attempt";
  readonly executionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly fence: number;
};

export type RuntimeEffectBindingOwner = {
  readonly kind: "runtime-binding";
  readonly nodeId: string;
  readonly epoch: number;
};

export type RuntimeEffectProcessOwner = {
  readonly kind: "process";
  readonly processId: string;
};

export type RuntimeEffectOwner =
  | RuntimeEffectActivationOwner
  | RuntimeEffectTaskAttemptOwner
  | RuntimeEffectBindingOwner
  | RuntimeEffectProcessOwner;

export type RuntimeEffectDisposer = () => void | Promise<void>;

/** Narrow registration authority supplied to one runtime operation. */
export type RuntimeEffectRegistrar = Pick<RuntimeEffectScope, "defer">;

export type RuntimeEffectScopeLimits = {
  readonly maxDisposers: number;
  readonly cleanupTimeoutMs: number;
};

export const DEFAULT_RUNTIME_EFFECT_SCOPE_LIMITS: RuntimeEffectScopeLimits =
  Object.freeze({
    maxDisposers: 128,
    cleanupTimeoutMs: 5_000,
  });

export const MAX_RUNTIME_EFFECT_DISPOSERS = 4_096;
export const MAX_RUNTIME_EFFECT_CLEANUP_TIMEOUT_MS = 300_000;

export type RuntimeEffectCleanupFailure =
  | {
      readonly kind: "disposer";
      readonly ordinal: number;
      readonly label?: string;
      readonly error: unknown;
    }
  | {
      readonly kind: "deadline";
      readonly ordinal: number;
      readonly label?: string;
      readonly error: RuntimeEffectCleanupDeadlineError;
    };

type RuntimeEffectRecord = {
  readonly ordinal: number;
  readonly label?: string;
  readonly dispose: RuntimeEffectDisposer;
};

const MAX_OWNER_ID_LENGTH = 512;
const MAX_EFFECT_LABEL_LENGTH = 160;

const boundedId = (value: string, label: string): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank`);
  if (normalized !== value) throw new Error(`${label} must not contain surrounding whitespace`);
  if (normalized.length > MAX_OWNER_ID_LENGTH) {
    throw new Error(`${label} must not exceed ${MAX_OWNER_ID_LENGTH} characters`);
  }
  return normalized;
};

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
};

const nonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
};

const snapshotOwner = (owner: RuntimeEffectOwner): RuntimeEffectOwner => {
  if (!owner || typeof owner !== "object") {
    throw new Error("Runtime effect owner must be an object");
  }
  switch (owner.kind) {
    case "activation":
      return Object.freeze({
        kind: owner.kind,
        activationId: boundedId(owner.activationId, "Runtime effect activation id"),
      });
    case "task-attempt":
      return Object.freeze({
        kind: owner.kind,
        executionId: boundedId(owner.executionId, "Runtime effect execution id"),
        runId: boundedId(owner.runId, "Runtime effect run id"),
        taskId: boundedId(owner.taskId, "Runtime effect task id"),
        attempt: positiveInteger(owner.attempt, "Runtime effect attempt"),
        fence: nonNegativeInteger(owner.fence, "Runtime effect fence"),
      });
    case "runtime-binding":
      return Object.freeze({
        kind: owner.kind,
        nodeId: boundedId(owner.nodeId, "Runtime effect node id"),
        epoch: positiveInteger(owner.epoch, "Runtime effect binding epoch"),
      });
    case "process":
      return Object.freeze({
        kind: owner.kind,
        processId: boundedId(owner.processId, "Runtime effect process id"),
      });
    default: {
      const unsupported: never = owner;
      throw new Error(`Unsupported runtime effect owner ${(unsupported as { kind?: unknown }).kind}`);
    }
  }
};

const normalizedLimits = (
  limits: Partial<RuntimeEffectScopeLimits> | undefined,
): RuntimeEffectScopeLimits => {
  const maxDisposers = limits?.maxDisposers
    ?? DEFAULT_RUNTIME_EFFECT_SCOPE_LIMITS.maxDisposers;
  const cleanupTimeoutMs = limits?.cleanupTimeoutMs
    ?? DEFAULT_RUNTIME_EFFECT_SCOPE_LIMITS.cleanupTimeoutMs;
  if (
    !Number.isSafeInteger(maxDisposers)
    || maxDisposers < 1
    || maxDisposers > MAX_RUNTIME_EFFECT_DISPOSERS
  ) {
    throw new Error(
      `Runtime effect maxDisposers must be between 1 and ${MAX_RUNTIME_EFFECT_DISPOSERS}`,
    );
  }
  if (
    !Number.isSafeInteger(cleanupTimeoutMs)
    || cleanupTimeoutMs < 1
    || cleanupTimeoutMs > MAX_RUNTIME_EFFECT_CLEANUP_TIMEOUT_MS
  ) {
    throw new Error(
      `Runtime effect cleanupTimeoutMs must be between 1 and ${MAX_RUNTIME_EFFECT_CLEANUP_TIMEOUT_MS}`,
    );
  }
  return Object.freeze({ maxDisposers, cleanupTimeoutMs });
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

export class RuntimeEffectCleanupDeadlineError extends Error {
  declare readonly code: "ROSTER_RUNTIME_EFFECT_CLEANUP_DEADLINE";
  declare readonly owner: RuntimeEffectOwner;
  declare readonly cleanupTimeoutMs: number;
  declare readonly remainingDisposers: number;

  constructor(input: {
    readonly owner: RuntimeEffectOwner;
    readonly cleanupTimeoutMs: number;
    readonly remainingDisposers: number;
  }) {
    super(
      `Runtime effect cleanup for ${input.owner.kind} owner exceeded `
      + `cleanupTimeoutMs=${input.cleanupTimeoutMs} with `
      + `${input.remainingDisposers} disposer(s) remaining`,
    );
    this.name = "RuntimeEffectCleanupDeadlineError";
    defineMetadata(this, {
      code: "ROSTER_RUNTIME_EFFECT_CLEANUP_DEADLINE",
      owner: input.owner,
      cleanupTimeoutMs: input.cleanupTimeoutMs,
      remainingDisposers: input.remainingDisposers,
    });
  }
}

export class RuntimeEffectCleanupError extends AggregateError {
  declare readonly code: "ROSTER_RUNTIME_EFFECT_CLEANUP_FAILED";
  declare readonly owner: RuntimeEffectOwner;
  declare readonly failures: ReadonlyArray<RuntimeEffectCleanupFailure>;

  constructor(
    owner: RuntimeEffectOwner,
    failures: ReadonlyArray<RuntimeEffectCleanupFailure>,
  ) {
    const frozenFailures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    super(
      frozenFailures.map((failure) => failure.error),
      `Runtime effect cleanup for ${owner.kind} owner failed in ${failures.length} place(s)`,
    );
    this.name = "RuntimeEffectCleanupError";
    defineMetadata(this, {
      code: "ROSTER_RUNTIME_EFFECT_CLEANUP_FAILED",
      owner,
      failures: frozenFailures,
    });
  }
}

export type RuntimeEffectOperationPhase = "activation" | "execution";

export class RuntimeEffectOperationError extends AggregateError {
  declare readonly code: "ROSTER_RUNTIME_EFFECT_OPERATION_AND_CLEANUP_FAILED";
  declare readonly phase: RuntimeEffectOperationPhase;
  declare readonly owner: RuntimeEffectOwner;
  declare readonly primaryError: unknown;
  declare readonly cleanupError: RuntimeEffectCleanupError;

  constructor(input: {
    readonly phase: RuntimeEffectOperationPhase;
    readonly owner: RuntimeEffectOwner;
    readonly primaryError: unknown;
    readonly cleanupError: RuntimeEffectCleanupError;
  }) {
    super(
      [input.primaryError, input.cleanupError],
      `Runtime effect ${input.phase} and cleanup both failed`,
      { cause: input.primaryError },
    );
    this.name = "RuntimeEffectOperationError";
    defineMetadata(this, {
      code: "ROSTER_RUNTIME_EFFECT_OPERATION_AND_CLEANUP_FAILED",
      phase: input.phase,
      owner: input.owner,
      primaryError: input.primaryError,
      cleanupError: input.cleanupError,
    });
  }
}

export type RuntimeEffectScopeState = "open" | "closing" | "closed";

/**
 * A bounded stack for ephemeral process-local runtime effects. The scope has no
 * authority to compensate receipts, accepted artifacts, shared-workspace
 * entries, Git state, or external emissions.
 */
export class RuntimeEffectScope {
  readonly #owner: RuntimeEffectOwner;
  readonly #limits: RuntimeEffectScopeLimits;
  readonly #effects: RuntimeEffectRecord[] = [];
  #state: RuntimeEffectScopeState = "open";
  #closePromise: Promise<void> | undefined;
  #nextOrdinal = 1;

  constructor(input: {
    readonly owner: RuntimeEffectOwner;
    readonly limits?: Partial<RuntimeEffectScopeLimits>;
  }) {
    this.#owner = snapshotOwner(input.owner);
    this.#limits = normalizedLimits(input.limits);
  }

  get owner(): RuntimeEffectOwner {
    return this.#owner;
  }

  get limits(): RuntimeEffectScopeLimits {
    return this.#limits;
  }

  get state(): RuntimeEffectScopeState {
    return this.#state;
  }

  get size(): number {
    return this.#effects.length;
  }

  defer(dispose: RuntimeEffectDisposer, label?: string): void {
    if (this.#state !== "open") {
      throw new Error(`Cannot defer a runtime effect after scope entered ${this.#state} state`);
    }
    if (typeof dispose !== "function") {
      throw new Error("Runtime effect disposer must be a function");
    }
    if (this.#effects.length >= this.#limits.maxDisposers) {
      throw new Error(
        `Runtime effect scope exceeded maxDisposers=${this.#limits.maxDisposers}`,
      );
    }
    const normalizedLabel = label === undefined ? undefined : boundedId(
      label,
      "Runtime effect label",
    );
    if (normalizedLabel && normalizedLabel.length > MAX_EFFECT_LABEL_LENGTH) {
      throw new Error(`Runtime effect label must not exceed ${MAX_EFFECT_LABEL_LENGTH} characters`);
    }
    this.#effects.push({
      ordinal: this.#nextOrdinal,
      ...(normalizedLabel ? { label: normalizedLabel } : {}),
      dispose,
    });
    this.#nextOrdinal += 1;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = "closing";
    this.#closePromise = this.#closeEffects();
    return this.#closePromise;
  }

  toJSON(): never {
    throw new Error("RuntimeEffectScope is process-local and cannot be serialized");
  }

  async #closeEffects(): Promise<void> {
    const deadline = performance.now() + this.#limits.cleanupTimeoutMs;
    const failures: RuntimeEffectCleanupFailure[] = [];
    try {
      while (this.#effects.length > 0) {
        const effect = this.#effects.pop()!;
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          const remainingDisposers = this.#effects.length + 1;
          const error = new RuntimeEffectCleanupDeadlineError({
            owner: this.#owner,
            cleanupTimeoutMs: this.#limits.cleanupTimeoutMs,
            remainingDisposers,
          });
          failures.push(Object.freeze({
            kind: "deadline",
            ordinal: effect.ordinal,
            ...(effect.label ? { label: effect.label } : {}),
            error,
          }));
          this.#effects.length = 0;
          break;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const disposal = Promise.resolve().then(effect.dispose);
        const outcome = await Promise.race([
          disposal.then(
            () => ({ status: "completed" as const }),
            (error: unknown) => ({ status: "failed" as const, error }),
          ),
          new Promise<{ readonly status: "deadline" }>((resolve) => {
            timer = setTimeout(() => resolve({ status: "deadline" }), remainingMs);
          }),
        ]);
        if (timer) clearTimeout(timer);

        if (outcome.status === "failed") {
          failures.push(Object.freeze({
            kind: "disposer",
            ordinal: effect.ordinal,
            ...(effect.label ? { label: effect.label } : {}),
            error: outcome.error,
          }));
          continue;
        }
        if (outcome.status === "deadline") {
          const remainingDisposers = this.#effects.length + 1;
          const error = new RuntimeEffectCleanupDeadlineError({
            owner: this.#owner,
            cleanupTimeoutMs: this.#limits.cleanupTimeoutMs,
            remainingDisposers,
          });
          failures.push(Object.freeze({
            kind: "deadline",
            ordinal: effect.ordinal,
            ...(effect.label ? { label: effect.label } : {}),
            error,
          }));
          // Preserve awaited LIFO semantics: lower stack entries cannot safely
          // start while this disposer remains unsettled.
          this.#effects.length = 0;
          break;
        }
      }
    } finally {
      this.#effects.length = 0;
      this.#state = "closed";
    }
    if (failures.length > 0) {
      throw new RuntimeEffectCleanupError(this.#owner, failures);
    }
  }
}

export type ActivatedRuntimeComponent<Value> = {
  readonly value: Value;
  readonly scope: RuntimeEffectScope;
  readonly close: () => Promise<void>;
  readonly toJSON: () => never;
};

/**
 * Activates a process-local component and rolls back every successfully
 * registered effect if activation does not complete. Successful activation
 * transfers explicit close ownership to the returned handle.
 */
export const activateRuntimeComponent = async <Value>(input: {
  readonly owner: RuntimeEffectOwner;
  readonly limits?: Partial<RuntimeEffectScopeLimits>;
  readonly activate: (scope: RuntimeEffectScope) => Value | Promise<Value>;
}): Promise<ActivatedRuntimeComponent<Value>> => {
  const scope = new RuntimeEffectScope({
    owner: input.owner,
    ...(input.limits ? { limits: input.limits } : {}),
  });
  let value: Value;
  try {
    value = await input.activate(scope);
  } catch (primaryError) {
    try {
      await scope.close();
    } catch (cleanupError) {
      if (!(cleanupError instanceof RuntimeEffectCleanupError)) throw cleanupError;
      throw new RuntimeEffectOperationError({
        phase: "activation",
        owner: scope.owner,
        primaryError,
        cleanupError,
      });
    }
    throw primaryError;
  }

  const handle: ActivatedRuntimeComponent<Value> = {
    value,
    scope,
    close: () => scope.close(),
    toJSON: () => {
      throw new Error("ActivatedRuntimeComponent is process-local and cannot be serialized");
    },
  };
  return Object.freeze(handle);
};

/**
 * Runs one bounded operation with attempt-owned ephemeral effects. The scope
 * closes after success, failure, or cancellation; durable task state remains
 * outside this process-local boundary.
 */
export const runWithRuntimeEffectScope = async <Value>(input: {
  readonly owner: RuntimeEffectOwner;
  readonly limits?: Partial<RuntimeEffectScopeLimits>;
  readonly run: (scope: RuntimeEffectScope) => Value | Promise<Value>;
}): Promise<Value> => {
  const scope = new RuntimeEffectScope({
    owner: input.owner,
    ...(input.limits ? { limits: input.limits } : {}),
  });
  let value: Value;
  try {
    value = await input.run(scope);
  } catch (primaryError) {
    try {
      await scope.close();
    } catch (cleanupError) {
      if (!(cleanupError instanceof RuntimeEffectCleanupError)) throw cleanupError;
      throw new RuntimeEffectOperationError({
        phase: "execution",
        owner: scope.owner,
        primaryError,
        cleanupError,
      });
    }
    throw primaryError;
  }
  await scope.close();
  return value;
};
