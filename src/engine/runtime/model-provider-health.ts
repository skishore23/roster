import {
  classifyModelFailure,
  type ModelFailureClass,
} from "./model-escalation.js";

export type ModelProviderHealthState = "available" | "cooldown" | "blocked";

export type ModelProviderHealthSnapshot = {
  readonly providerId: string;
  readonly state: ModelProviderHealthState;
  readonly failureClass?: ModelFailureClass;
  readonly retryable: boolean;
  readonly note?: string;
  readonly unavailableUntil?: number;
};

type ProviderFailure = ModelProviderHealthSnapshot & {
  readonly state: "cooldown" | "blocked";
  readonly failureClass: ModelFailureClass;
};

const hardFailures = new Set<ModelFailureClass>([
  "authentication",
  "authorization",
  "budget",
]);

const providerNote = (failureClass: ModelFailureClass): string => {
  if (failureClass === "authentication" || failureClass === "authorization") {
    return "Model provider authentication is unavailable. Update the server-side credentials and restart Roster.";
  }
  if (failureClass === "budget") {
    return "Model provider quota or billing is unavailable. Update the account limit and restart Roster.";
  }
  if (failureClass === "rate-limit") {
    return "The model provider is temporarily rate-limiting new work.";
  }
  return "The model provider is temporarily unavailable.";
};

const normalizeProviderId = (providerId: string): string => {
  const normalized = providerId.trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,63}$/.test(normalized)) {
    throw new Error(`Invalid model provider id ${providerId}`);
  }
  return normalized;
};

export class ModelProviderUnavailableError extends Error {
  readonly failureClass: ModelFailureClass;
  readonly retryable: boolean;

  constructor(snapshot: ModelProviderHealthSnapshot) {
    super(snapshot.note ?? "Model provider is unavailable");
    this.name = "ModelProviderUnavailableError";
    this.failureClass = snapshot.failureClass ?? "provider";
    this.retryable = snapshot.retryable;
  }
}

/**
 * Process-local provider availability is an admission and placement hint only.
 * Durable attempts retain their snapshotted runtime binding and never consult
 * this registry during replay.
 */
export class ModelProviderHealthRegistry {
  private readonly failures = new Map<string, ProviderFailure>();

  constructor(
    private readonly rateLimitCooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(rateLimitCooldownMs) || rateLimitCooldownMs < 1_000 || rateLimitCooldownMs > 600_000) {
      throw new Error("Model provider cooldown must be between 1 and 600 seconds");
    }
  }

  snapshot(providerId: string): ModelProviderHealthSnapshot {
    const id = normalizeProviderId(providerId);
    const failure = this.failures.get(id);
    if (!failure) return { providerId: id, state: "available", retryable: true };
    if (
      failure.state === "cooldown"
      && failure.unavailableUntil !== undefined
      && failure.unavailableUntil <= this.now()
    ) {
      this.failures.delete(id);
      return { providerId: id, state: "available", retryable: true };
    }
    return failure;
  }

  assertAvailable(providerId: string): void {
    const snapshot = this.snapshot(providerId);
    if (snapshot.state !== "available") throw new ModelProviderUnavailableError(snapshot);
  }

  recordFailure(providerId: string, error: unknown): ModelProviderHealthSnapshot {
    const id = normalizeProviderId(providerId);
    const failureClass = classifyModelFailure(error);
    if (hardFailures.has(failureClass)) {
      const blocked: ProviderFailure = Object.freeze({
        providerId: id,
        state: "blocked",
        failureClass,
        retryable: false,
        note: providerNote(failureClass),
      });
      this.failures.set(id, blocked);
      return blocked;
    }
    if (failureClass === "rate-limit") {
      const cooldown: ProviderFailure = Object.freeze({
        providerId: id,
        state: "cooldown",
        failureClass,
        retryable: true,
        note: providerNote(failureClass),
        unavailableUntil: this.now() + this.rateLimitCooldownMs,
      });
      this.failures.set(id, cooldown);
      return cooldown;
    }
    return this.snapshot(id);
  }

  recordSuccess(providerId: string): void {
    const id = normalizeProviderId(providerId);
    if (this.failures.get(id)?.state === "cooldown") this.failures.delete(id);
  }

  reset(providerId: string): void {
    this.failures.delete(normalizeProviderId(providerId));
  }

  async execute<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    this.assertAvailable(providerId);
    try {
      const result = await operation();
      this.recordSuccess(providerId);
      return result;
    } catch (error) {
      this.recordFailure(providerId, error);
      throw error;
    }
  }
}
