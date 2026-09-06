import Ajv, { type ValidateFunction } from "ajv";

import { hashCanonical } from "../../core/canonical.js";
import type { JsonValue, WorkspaceNode } from "../orchestration/types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_CATALOG_QUERY_LENGTH = 500;
const MAX_CATALOG_RESULTS = 32;
const MAX_CATALOG_CAPABILITY_FILTERS = 16;
const MAX_CATALOG_ENTRY_DESCRIPTION = 500;
const MAX_CATALOG_ENTRY_PROVIDERS = 4;
const MAX_CATALOG_PROJECTION_BYTES = 1_048_576;
const MAX_FUNCTION_ID_LENGTH = 240;
const MAX_FUNCTION_DESCRIPTION_LENGTH = 2_000;
const MAX_FUNCTION_GRANTS = 128;
const MAX_PROVIDER_HEARTBEAT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PROVIDER_GENERATION_BINDINGS = 128;
const DEFAULT_PROVIDER_DRAIN_TIMEOUT_MS = 30_000;

export const ROSTER_CAPABILITY_CATALOG_VERSION = "roster.capability-catalog.v1" as const;

export type RosterFunctionEffect = "read" | "write" | "external";
export type RosterFunctionIdempotency = "required" | "supported" | "none";
export type RosterFunctionSchema = boolean | Readonly<Record<string, JsonValue>>;

/** Durable, provider-neutral description of one callable system capability. */
export type RosterFunctionDescriptor = {
  readonly id: string;
  readonly version: string;
  readonly capability: string;
  readonly description: string;
  readonly inputSchema: RosterFunctionSchema;
  readonly outputSchema: RosterFunctionSchema;
  readonly effects: ReadonlyArray<RosterFunctionEffect>;
  readonly requiredScopes?: ReadonlyArray<string>;
  readonly idempotency?: RosterFunctionIdempotency;
  readonly defaultTimeoutMs?: number;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type RosterFunctionAccess = {
  /** Exact callable-function grants, separate from task-assignment capabilities. */
  readonly functionGrants?: ReadonlyArray<string>;
  readonly scopes?: ReadonlyArray<string>;
  readonly allowedEffects?: ReadonlyArray<RosterFunctionEffect>;
};

export type RosterFunctionTool = {
  readonly id: string;
  readonly version: string;
  readonly capability: string;
  readonly description: string;
  readonly inputSchema: RosterFunctionSchema;
  readonly outputSchema: RosterFunctionSchema;
  readonly effects: ReadonlyArray<RosterFunctionEffect>;
};

export type RosterFunctionInvocationAction =
  | { readonly kind: "await" }
  | { readonly kind: "void" }
  | { readonly kind: "enqueue"; readonly queue?: string };

export type RosterFunctionProviderControl = {
  readonly nodeId: string;
  readonly functionId: string;
  readonly action: "await" | "void";
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type RosterFunctionProvider = {
  readonly providerId: string;
  readonly functionId: string;
  readonly epoch: number;
  readonly heartbeat?: RosterFunctionProviderHeartbeat;
  readonly invoke: (
    input: JsonValue,
    control: RosterFunctionProviderControl,
  ) => Promise<JsonValue>;
};

export type RosterFunctionProviderHeartbeat = {
  readonly observedAt: number;
  readonly ttlMs: number;
};

export type RosterFunctionProviderHealth = {
  readonly functionId: string;
  readonly providerId: string;
  readonly epoch: number;
  readonly live: boolean;
  readonly observedAt?: number;
  readonly expiresAt?: number;
};

export type RosterFunctionProviderLifecycleState =
  | "active"
  | "withdrawing"
  | "retired"
  | "cleanup-uncertain";

export type RosterFunctionProviderGenerationView = {
  readonly generationId: string;
  readonly generationHash: string;
  readonly state: RosterFunctionProviderLifecycleState;
  readonly bindings: ReadonlyArray<{
    readonly functionId: string;
    readonly providerId: string;
    readonly epoch: number;
  }>;
  readonly activeInvocations: number;
};

export type RosterFunctionProviderWithdrawalResult = {
  readonly generationId: string;
  readonly generationHash: string;
  readonly status: "retired" | "timed-out" | "cleanup-uncertain";
  readonly activeInvocations: number;
  readonly cleanupError?: string;
};

export type RosterFunctionProviderGenerationHandle = {
  readonly generationId: string;
  readonly generationHash: string;
  readonly view: () => RosterFunctionProviderGenerationView;
  readonly withdraw: (options?: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }) => Promise<RosterFunctionProviderWithdrawalResult>;
};

export type RosterFunctionProviderGenerationInput = {
  readonly generationId?: string;
  readonly providers: ReadonlyArray<RosterFunctionProvider>;
  /** Runs only after every invocation leased from this generation has settled. */
  readonly dispose?: () => void | Promise<void>;
};

export type RosterCapabilityCatalogProvider = {
  readonly providerId: string;
  readonly epoch: number;
  readonly observedAt?: number;
  readonly expiresAt?: number;
};

export type RosterCapabilityCatalogEntry = {
  readonly id: string;
  readonly version: string;
  readonly capability: string;
  readonly description: string;
  readonly effects: ReadonlyArray<RosterFunctionEffect>;
  readonly providers: ReadonlyArray<RosterCapabilityCatalogProvider>;
};

export type RosterCapabilityCatalogSearchResult = {
  readonly schemaVersion: typeof ROSTER_CAPABILITY_CATALOG_VERSION;
  readonly catalogVersion: string;
  readonly query: string;
  readonly entries: ReadonlyArray<RosterCapabilityCatalogEntry>;
};

export type RosterCapabilityCatalogProjection = {
  readonly schemaVersion: typeof ROSTER_CAPABILITY_CATALOG_VERSION;
  readonly catalogVersion: string;
  readonly tools: ReadonlyArray<RosterFunctionTool>;
  readonly providers: Readonly<Record<string, RosterCapabilityCatalogProvider>>;
};

export type RosterCapabilityCatalogDescription = {
  readonly schemaVersion: typeof ROSTER_CAPABILITY_CATALOG_VERSION;
  readonly searchCatalogVersion: string;
  readonly projectionCatalogVersion: string;
  readonly descriptionVersion: string;
  readonly tool: RosterFunctionTool;
  readonly provider: RosterCapabilityCatalogProvider;
};

export type RosterFunctionEnqueueRequest = {
  readonly node: WorkspaceNode;
  readonly descriptor: RosterFunctionDescriptor;
  readonly input: JsonValue;
  readonly queue?: string;
  readonly timeoutMs: number;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type RosterFunctionEnqueue = (
  request: RosterFunctionEnqueueRequest,
) => Promise<{ readonly receiptId: string }>;

export type RosterFunctionInvocationResult =
  | {
      readonly status: "completed";
      readonly functionId: string;
      readonly providerId: string;
      readonly output: JsonValue;
    }
  | {
      readonly status: "accepted";
      readonly functionId: string;
      readonly providerId: string;
    }
  | {
      readonly status: "enqueued";
      readonly functionId: string;
      readonly receiptId: string;
    };

export type RosterFunctionDirectoryOptions = {
  /** Roster owns durable scheduling; this callback bridges enqueue to that authority. */
  readonly enqueue?: RosterFunctionEnqueue;
};

export type RosterFunctionInvocationRequest = {
  readonly node: WorkspaceNode;
  readonly functionId: string;
  readonly value: JsonValue;
  readonly action?: RosterFunctionInvocationAction;
  readonly access?: RosterFunctionAccess;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  /** Pins a catalog call or pipeline step to the provider selected by its search snapshot. */
  readonly expectedProvider?: {
    readonly providerId: string;
    readonly epoch: number;
  };
  /** Injectable wall clock for deterministic heartbeat and pipeline tests. */
  readonly now?: number;
};

export type RosterFunctionInvocationTrace = {
  readonly functionId: string;
  readonly functionVersion: string;
  readonly providerId: string;
  readonly providerEpoch: number;
};

type RegisteredFunction = {
  readonly descriptor: RosterFunctionDescriptor;
  readonly validateInput: ValidateFunction;
  readonly validateOutput: ValidateFunction;
};

type BoundProvider = {
  readonly provider: RosterFunctionProvider;
  heartbeat?: RosterFunctionProviderHeartbeat;
  readonly generationId: string;
  state: Exclude<RosterFunctionProviderLifecycleState, "cleanup-uncertain">;
  activeInvocations: number;
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
};

type ProviderGenerationRecord = {
  readonly generationId: string;
  readonly generationHash: string;
  state: RosterFunctionProviderLifecycleState;
  readonly bindings: ReadonlyArray<BoundProvider>;
  readonly dispose?: () => void | Promise<void>;
  withdrawal?: Promise<RosterFunctionProviderWithdrawalResult>;
};

const cloneJson = <Value extends JsonValue>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

const cloneSchema = (schema: RosterFunctionSchema): RosterFunctionSchema =>
  typeof schema === "boolean" ? schema : cloneJson(schema);

const cloneDescriptor = (descriptor: RosterFunctionDescriptor): RosterFunctionDescriptor => ({
  ...descriptor,
  inputSchema: cloneSchema(descriptor.inputSchema),
  outputSchema: cloneSchema(descriptor.outputSchema),
  effects: [...descriptor.effects],
  ...(descriptor.requiredScopes ? { requiredScopes: [...descriptor.requiredScopes] } : {}),
  ...(descriptor.metadata ? { metadata: cloneJson(descriptor.metadata) } : {}),
});

const assertId = (kind: string, value: string): void => {
  if (!ID_PATTERN.test(value) || value.length > MAX_FUNCTION_ID_LENGTH) {
    throw new Error(`Invalid ${kind} id "${value}"`);
  }
};

const normalizedStrings = (kind: string, values: ReadonlyArray<string> = []): string[] => {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value)) throw new Error(`${kind} must not contain blank values`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${kind} must not contain duplicates`);
  return normalized;
};

const normalizedHeartbeat = (
  functionId: string,
  providerId: string,
  heartbeat: RosterFunctionProviderHeartbeat,
): RosterFunctionProviderHeartbeat => {
  if (!Number.isSafeInteger(heartbeat.observedAt) || heartbeat.observedAt < 0) {
    throw new Error(`Roster function provider ${providerId} heartbeat observedAt must be a non-negative safe integer`);
  }
  if (
    !Number.isSafeInteger(heartbeat.ttlMs)
    || heartbeat.ttlMs < 1
    || heartbeat.ttlMs > MAX_PROVIDER_HEARTBEAT_TTL_MS
  ) {
    throw new Error(
      `Roster function provider ${providerId} heartbeat ttlMs for ${functionId} must be between 1 and ${MAX_PROVIDER_HEARTBEAT_TTL_MS}`,
    );
  }
  return { observedAt: heartbeat.observedAt, ttlMs: heartbeat.ttlMs };
};

const providerIsLive = (provider: BoundProvider, now: number): boolean =>
  provider.state === "active"
  && (!provider.heartbeat || provider.heartbeat.observedAt + provider.heartbeat.ttlMs > now);

const providerHealth = (
  provider: BoundProvider,
  now: number,
): RosterFunctionProviderHealth => ({
  functionId: provider.provider.functionId,
  providerId: provider.provider.providerId,
  epoch: provider.provider.epoch,
  live: providerIsLive(provider, now),
  ...(provider.heartbeat ? {
    observedAt: provider.heartbeat.observedAt,
    expiresAt: provider.heartbeat.observedAt + provider.heartbeat.ttlMs,
  } : {}),
});

const catalogProvider = (provider: BoundProvider): RosterCapabilityCatalogProvider => ({
  providerId: provider.provider.providerId,
  epoch: provider.provider.epoch,
  ...(provider.heartbeat ? {
    observedAt: provider.heartbeat.observedAt,
    expiresAt: provider.heartbeat.observedAt + provider.heartbeat.ttlMs,
  } : {}),
});

const normalizedAccess = (access: RosterFunctionAccess): {
  readonly functionGrants: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<string>;
  readonly allowedEffects: ReadonlyArray<RosterFunctionEffect>;
} => {
  const functionGrants = normalizedStrings("Callable function grants", access.functionGrants).sort();
  if (
    functionGrants.length > MAX_FUNCTION_GRANTS
    || functionGrants.some((functionId) => !ID_PATTERN.test(functionId) || functionId.length > MAX_FUNCTION_ID_LENGTH)
  ) {
    throw new Error(`Callable function grants must contain at most ${MAX_FUNCTION_GRANTS} bounded function ids`);
  }
  return {
    functionGrants,
    scopes: [...new Set(access.scopes ?? [])].sort(),
    allowedEffects: [...new Set<RosterFunctionEffect>(access.allowedEffects ?? ["read"])].sort(),
  };
};

const schemaError = (label: string, validate: ValidateFunction): Error => {
  const detail = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ")
    ?? "is invalid";
  return new Error(`${label} violates its JSON Schema: ${detail}`);
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("Roster function invocation was aborted");

const invokeWithTimeout = async <Value>(input: {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly invoke: (signal: AbortSignal) => Promise<Value>;
}): Promise<Value> => {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(abortError(input.signal!));
  if (input.signal?.aborted) abortFromCaller();
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = input.timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`Roster function invocation timed out after ${input.timeoutMs}ms`)), input.timeoutMs)
    : undefined;
  try {
    if (controller.signal.aborted) throw abortError(controller.signal);
    return await Promise.race([
      input.invoke(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(abortError(controller.signal)), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
};

const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
};

const providerGenerationIdentity = (
  providers: ReadonlyArray<RosterFunctionProvider>,
): ReadonlyArray<{ readonly functionId: string; readonly providerId: string; readonly epoch: number }> =>
  providers.map((provider) => ({
    functionId: provider.functionId,
    providerId: provider.providerId,
    epoch: provider.epoch,
  })).sort((left, right) => left.functionId.localeCompare(right.functionId)
    || left.providerId.localeCompare(right.providerId)
    || left.epoch - right.epoch);

const providerGenerationView = (
  generation: ProviderGenerationRecord,
): RosterFunctionProviderGenerationView => Object.freeze({
  generationId: generation.generationId,
  generationHash: generation.generationHash,
  state: generation.state,
  bindings: Object.freeze(generation.bindings.map(({ provider }) => Object.freeze({
    functionId: provider.functionId,
    providerId: provider.providerId,
    epoch: provider.epoch,
  })).sort((left, right) => left.functionId.localeCompare(right.functionId)
    || left.providerId.localeCompare(right.providerId)
    || left.epoch - right.epoch)),
  activeInvocations: generation.bindings.reduce((total, binding) => total + binding.activeInvocations, 0),
});

const providerDrainTimeout = (timeoutMs: number | undefined): number => {
  const value = timeoutMs ?? DEFAULT_PROVIDER_DRAIN_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PROVIDER_HEARTBEAT_TTL_MS) {
    throw new Error(
      `Roster function provider drain timeout must be between 1 and ${MAX_PROVIDER_HEARTBEAT_TTL_MS}`,
    );
  }
  return value;
};

/**
 * Typed function contracts and live provider placement. Descriptors are stable
 * authoring data; provider bindings are replaceable runtime availability.
 */
export class RosterFunctionDirectory {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly functions = new Map<string, RegisteredFunction>();
  private readonly providers = new Map<string, Map<string, BoundProvider>>();
  private readonly generations = new Map<string, ProviderGenerationRecord>();
  private readonly enqueue?: RosterFunctionEnqueue;

  constructor(
    descriptors: ReadonlyArray<RosterFunctionDescriptor> = [],
    options: RosterFunctionDirectoryOptions = {},
  ) {
    this.enqueue = options.enqueue;
    for (const descriptor of descriptors) this.declare(descriptor);
  }

  declare(input: RosterFunctionDescriptor): RosterFunctionDescriptor {
    assertId("function", input.id);
    assertId("function capability", input.capability);
    if (!input.version.trim()) throw new Error(`Roster function ${input.id} requires a version`);
    if (!input.description.trim()) throw new Error(`Roster function ${input.id} requires a description`);
    if (input.description.trim().length > MAX_FUNCTION_DESCRIPTION_LENGTH) {
      throw new Error(
        `Roster function ${input.id} description must not exceed ${MAX_FUNCTION_DESCRIPTION_LENGTH} characters`,
      );
    }
    if (this.functions.has(input.id)) throw new Error(`Roster function ${input.id} is already declared`);
    const effects = normalizedStrings(`Roster function ${input.id} effects`, input.effects) as RosterFunctionEffect[];
    if (effects.some((effect) => effect !== "read" && effect !== "write" && effect !== "external")) {
      throw new Error(`Roster function ${input.id} has an unsupported effect`);
    }
    const requiredScopes = normalizedStrings(`Roster function ${input.id} required scopes`, input.requiredScopes);
    const defaultTimeoutMs = input.defaultTimeoutMs ?? 30_000;
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs < 0) {
      throw new Error(`Roster function ${input.id} defaultTimeoutMs must be a non-negative finite number`);
    }
    const descriptor = cloneDescriptor({
      ...input,
      version: input.version.trim(),
      description: input.description.trim(),
      effects,
      ...(requiredScopes.length ? { requiredScopes } : {}),
      defaultTimeoutMs: Math.floor(defaultTimeoutMs),
    });
    let validateInput: ValidateFunction;
    let validateOutput: ValidateFunction;
    try {
      validateInput = this.ajv.compile(descriptor.inputSchema);
      validateOutput = this.ajv.compile(descriptor.outputSchema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Roster function ${input.id} has an invalid JSON Schema: ${message}`);
    }
    this.functions.set(descriptor.id, { descriptor, validateInput, validateOutput });
    return cloneDescriptor(descriptor);
  }

  descriptor(functionId: string): RosterFunctionDescriptor {
    const registered = this.functions.get(functionId);
    if (!registered) throw new Error(`Roster function ${functionId} is not declared`);
    return cloneDescriptor(registered.descriptor);
  }

  descriptors(): ReadonlyArray<RosterFunctionDescriptor> {
    return [...this.functions.values()]
      .map(({ descriptor }) => cloneDescriptor(descriptor))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  bindProvider(provider: RosterFunctionProvider): () => void {
    const handle = this.bindProviderGeneration({ providers: [provider] });
    return () => {
      void handle.withdraw();
    };
  }

  /**
   * Atomically publishes one complete provider generation. No binding becomes
   * discoverable until every provider has been validated. Replaced generations
   * stop accepting invocations immediately and retire after their existing
   * invocation leases settle.
   */
  bindProviderGeneration(
    input: RosterFunctionProviderGenerationInput,
  ): RosterFunctionProviderGenerationHandle {
    if (input.providers.length < 1 || input.providers.length > MAX_PROVIDER_GENERATION_BINDINGS) {
      throw new Error(
        `Roster function provider generation must contain between 1 and ${MAX_PROVIDER_GENERATION_BINDINGS} bindings`,
      );
    }
    const identities = providerGenerationIdentity(input.providers);
    const uniqueBindings = new Set(identities.map((provider) =>
      `${provider.functionId}\u0000${provider.providerId}`));
    if (uniqueBindings.size !== identities.length) {
      throw new Error("Roster function provider generation must not contain duplicate bindings");
    }
    for (const provider of input.providers) {
      assertId("function provider", provider.providerId);
      if (!this.functions.has(provider.functionId)) {
        throw new Error(`Cannot bind provider ${provider.providerId} to undeclared function ${provider.functionId}`);
      }
      if (!Number.isInteger(provider.epoch) || provider.epoch < 1) {
        throw new Error(`Roster function provider ${provider.providerId} epoch must be a positive integer`);
      }
      const current = this.providers.get(provider.functionId)?.get(provider.providerId);
      if (current && current.provider.epoch >= provider.epoch) {
        throw new Error(`Roster function provider ${provider.providerId} binding epoch must increase`);
      }
      if (provider.heartbeat) {
        normalizedHeartbeat(provider.functionId, provider.providerId, provider.heartbeat);
      }
    }
    const generationHash = hashCanonical({
      schemaVersion: "roster.function-provider-generation.v1",
      bindings: identities,
    });
    const generationId = input.generationId?.trim()
      ?? `provider_generation_${generationHash.slice(0, 28)}`;
    assertId("function provider generation", generationId);
    if (this.generations.has(generationId)) {
      throw new Error(`Roster function provider generation ${generationId} is already bound`);
    }
    const replacedGenerations = new Set<ProviderGenerationRecord>();
    for (const provider of input.providers) {
      const current = this.providers.get(provider.functionId)?.get(provider.providerId);
      if (current) {
        const generation = this.generations.get(current.generationId);
        if (generation) replacedGenerations.add(generation);
      }
    }
    const bindings = input.providers.map((provider): BoundProvider => {
      const drain = deferred();
      return {
        provider,
        generationId,
        state: "active",
        activeInvocations: 0,
        drained: drain.promise,
        resolveDrained: drain.resolve,
        ...(provider.heartbeat ? {
          heartbeat: normalizedHeartbeat(provider.functionId, provider.providerId, provider.heartbeat),
        } : {}),
      };
    });
    const generation: ProviderGenerationRecord = {
      generationId,
      generationHash,
      state: "active",
      bindings,
      ...(input.dispose ? { dispose: input.dispose } : {}),
    };
    for (const binding of bindings) {
      const byProvider = this.providers.get(binding.provider.functionId) ?? new Map<string, BoundProvider>();
      byProvider.set(binding.provider.providerId, binding);
      this.providers.set(binding.provider.functionId, byProvider);
    }
    this.generations.set(generationId, generation);
    for (const replaced of replacedGenerations) void this.withdrawProviderGeneration(replaced);
    return Object.freeze({
      generationId,
      generationHash,
      view: () => providerGenerationView(generation),
      withdraw: (options) => this.withdrawProviderGeneration(generation, options),
    });
  }

  heartbeatProvider(input: {
    readonly functionId: string;
    readonly providerId: string;
    readonly epoch: number;
    readonly observedAt: number;
    readonly ttlMs: number;
  }): RosterFunctionProviderHealth {
    const current = this.providers.get(input.functionId)?.get(input.providerId);
    if (!current || current.state !== "active" || current.provider.epoch !== input.epoch) {
      throw new Error(
        `Roster function provider ${input.providerId} heartbeat does not match the live ${input.functionId} binding epoch`,
      );
    }
    const heartbeat = normalizedHeartbeat(input.functionId, input.providerId, input);
    if (current.heartbeat && heartbeat.observedAt < current.heartbeat.observedAt) {
      throw new Error(`Roster function provider ${input.providerId} heartbeat moved backwards`);
    }
    current.heartbeat = heartbeat;
    return providerHealth(current, heartbeat.observedAt);
  }

  providerBindings(functionId?: string): ReadonlyArray<{
    readonly functionId: string;
    readonly providerId: string;
    readonly epoch: number;
  }> {
    const entries = functionId
      ? [[functionId, this.providers.get(functionId)] as const]
      : [...this.providers.entries()];
    return entries.flatMap(([id, providers]) => [...(providers?.values() ?? [])]
      .filter((provider) => provider.state === "active")
      .map(({ provider }) => ({
        functionId: id,
        providerId: provider.providerId,
        epoch: provider.epoch,
      }))).sort((left, right) => left.functionId.localeCompare(right.functionId)
      || right.epoch - left.epoch
      || left.providerId.localeCompare(right.providerId));
  }

  providerGenerations(): ReadonlyArray<RosterFunctionProviderGenerationView> {
    return [...this.generations.values()]
      .map(providerGenerationView)
      .sort((left, right) => left.generationId.localeCompare(right.generationId));
  }

  providerHealth(functionId?: string, now = Date.now()): ReadonlyArray<RosterFunctionProviderHealth> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Provider health time must be a non-negative safe integer");
    const entries = functionId
      ? [[functionId, this.providers.get(functionId)] as const]
      : [...this.providers.entries()];
    return entries.flatMap(([_id, providers]) =>
      [...(providers?.values() ?? [])].map((provider) => providerHealth(provider, now)))
      .sort((left, right) => left.functionId.localeCompare(right.functionId)
        || Number(right.live) - Number(left.live)
        || right.epoch - left.epoch
        || left.providerId.localeCompare(right.providerId));
  }

  searchCatalog(input: {
    readonly node: WorkspaceNode;
    readonly access?: RosterFunctionAccess;
    readonly query?: string;
    readonly capabilities?: ReadonlyArray<string>;
    readonly limit?: number;
    readonly now?: number;
  }): RosterCapabilityCatalogSearchResult {
    const query = (input.query ?? "").trim().toLowerCase();
    if (query.length > MAX_CATALOG_QUERY_LENGTH) {
      throw new Error(`Capability catalog query must not exceed ${MAX_CATALOG_QUERY_LENGTH} characters`);
    }
    const capabilities = normalizedStrings("Capability catalog capabilities", input.capabilities).sort();
    if (
      capabilities.length > MAX_CATALOG_CAPABILITY_FILTERS
      || capabilities.some((capability) => capability.length > MAX_FUNCTION_ID_LENGTH)
    ) {
      throw new Error(
        `Capability catalog accepts at most ${MAX_CATALOG_CAPABILITY_FILTERS} bounded capability filters`,
      );
    }
    if (!query && capabilities.length === 0) {
      throw new Error("Capability catalog search requires a query or capability filter");
    }
    const limit = input.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_RESULTS) {
      throw new Error(`Capability catalog limit must be between 1 and ${MAX_CATALOG_RESULTS}`);
    }
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Capability catalog time must be a non-negative safe integer");
    const access = normalizedAccess(input.access ?? {});
    const queryTerms = query.split(/\s+/u).filter(Boolean);
    const scored = [...this.functions.values()].flatMap(({ descriptor }) => {
      if (!this.isAuthorized(descriptor, access)) return [];
      if (capabilities.length && !capabilities.includes(descriptor.capability)) return [];
      const providers = this.liveProviders(descriptor.id, now);
      if (!providers.length) return [];
      const haystack = `${descriptor.id} ${descriptor.capability} ${descriptor.description}`.toLowerCase();
      if (queryTerms.some((term) => !haystack.includes(term))) return [];
      const score = (descriptor.id.toLowerCase() === query ? 100 : 0)
        + (descriptor.capability.toLowerCase() === query ? 80 : 0)
        + (descriptor.id.toLowerCase().startsWith(query) ? 40 : 0)
        + queryTerms.reduce((total, term) => total + (descriptor.id.toLowerCase().includes(term) ? 8 : 2), 0);
      const entry: RosterCapabilityCatalogEntry = {
        id: descriptor.id,
        version: descriptor.version,
        capability: descriptor.capability,
        description: descriptor.description.slice(0, MAX_CATALOG_ENTRY_DESCRIPTION),
        effects: [...descriptor.effects],
        providers: providers.slice(0, MAX_CATALOG_ENTRY_PROVIDERS).map(catalogProvider),
      };
      return [{ score, entry }];
    }).sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
    const entries = scored.slice(0, limit).map(({ entry }) => entry);
    return {
      schemaVersion: ROSTER_CAPABILITY_CATALOG_VERSION,
      catalogVersion: hashCanonical({
        schemaVersion: ROSTER_CAPABILITY_CATALOG_VERSION,
        nodeId: input.node.id,
        access,
        query,
        capabilities,
        entries,
      }),
      query,
      entries,
    };
  }

  projectCatalog(input: {
    readonly node: WorkspaceNode;
    readonly access?: RosterFunctionAccess;
    readonly functionIds: ReadonlyArray<string>;
    readonly now?: number;
  }): RosterCapabilityCatalogProjection {
    if (input.functionIds.length < 1 || input.functionIds.length > MAX_CATALOG_RESULTS) {
      throw new Error(`Capability catalog projection must select between 1 and ${MAX_CATALOG_RESULTS} functions`);
    }
    const functionIds = normalizedStrings("Capability catalog function ids", input.functionIds).sort();
    if (functionIds.some((functionId) => functionId.length > MAX_FUNCTION_ID_LENGTH)) {
      throw new Error(`Capability catalog function ids must not exceed ${MAX_FUNCTION_ID_LENGTH} characters`);
    }
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Capability catalog time must be a non-negative safe integer");
    const access = normalizedAccess(input.access ?? {});
    const tools: RosterFunctionTool[] = [];
    const providers: Record<string, RosterCapabilityCatalogProvider> = {};
    for (const functionId of functionIds) {
      const registered = this.functions.get(functionId);
      if (!registered || !this.isAuthorized(registered.descriptor, access)) {
        throw new Error(`Roster function ${functionId} is not available in the authorized capability catalog`);
      }
      const provider = this.liveProviders(functionId, now)[0];
      if (!provider) throw new Error(`Roster function ${functionId} has no live provider`);
      tools.push({
        id: registered.descriptor.id,
        version: registered.descriptor.version,
        capability: registered.descriptor.capability,
        description: registered.descriptor.description,
        inputSchema: cloneSchema(registered.descriptor.inputSchema),
        outputSchema: cloneSchema(registered.descriptor.outputSchema),
        effects: [...registered.descriptor.effects],
      });
      providers[functionId] = catalogProvider(provider);
    }
    const projectionBytes = Buffer.byteLength(JSON.stringify({ tools, providers }), "utf8");
    if (projectionBytes > MAX_CATALOG_PROJECTION_BYTES) {
      throw new Error(`Capability catalog projection exceeds ${MAX_CATALOG_PROJECTION_BYTES} bytes`);
    }
    return {
      schemaVersion: ROSTER_CAPABILITY_CATALOG_VERSION,
      catalogVersion: hashCanonical({
        schemaVersion: ROSTER_CAPABILITY_CATALOG_VERSION,
        nodeId: input.node.id,
        access,
        tools,
        providers,
      }),
      tools,
      providers,
    };
  }

  describeCatalog(input: {
    readonly node: WorkspaceNode;
    readonly access?: RosterFunctionAccess;
    readonly snapshot: RosterCapabilityCatalogSearchResult;
    readonly functionId: string;
    readonly functionVersion: string;
    readonly providerId: string;
    readonly providerEpoch: number;
    readonly now?: number;
  }): RosterCapabilityCatalogDescription {
    const entry = input.snapshot.entries.find((candidate) =>
      candidate.id === input.functionId
      && candidate.version === input.functionVersion
      && candidate.providers.some((provider) =>
        provider.providerId === input.providerId && provider.epoch === input.providerEpoch));
    if (!entry) {
      throw new Error("Roster catalog description was not present in the pinned search snapshot");
    }
    const projection = this.projectCatalog({
      node: input.node,
      access: input.access,
      functionIds: [input.functionId],
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    const tool = projection.tools[0];
    const provider = projection.providers[input.functionId];
    if (
      !tool
      || tool.version !== input.functionVersion
      || !provider
      || provider.providerId !== input.providerId
      || provider.epoch !== input.providerEpoch
    ) {
      throw new Error("Roster catalog description changed after the pinned search snapshot");
    }
    const content = {
      schemaVersion: ROSTER_CAPABILITY_CATALOG_VERSION,
      searchCatalogVersion: input.snapshot.catalogVersion,
      projectionCatalogVersion: projection.catalogVersion,
      tool,
      provider,
    };
    return {
      ...content,
      descriptionVersion: hashCanonical(content),
    };
  }

  async invoke(input: RosterFunctionInvocationRequest): Promise<RosterFunctionInvocationResult> {
    return (await this.invokeWithTrace(input)).result;
  }

  async invokeWithTrace(input: RosterFunctionInvocationRequest): Promise<{
    readonly result: RosterFunctionInvocationResult;
    readonly trace: RosterFunctionInvocationTrace;
  }> {
    const registered = this.functions.get(input.functionId);
    if (!registered) throw new Error(`Roster function ${input.functionId} is not declared`);
    const access = normalizedAccess(input.access ?? {});
    this.assertAuthorized(input.node, registered.descriptor, access);
    const value = cloneJson(input.value);
    if (!registered.validateInput(value)) {
      throw schemaError(`Roster function ${input.functionId} input`, registered.validateInput);
    }
    const timeoutMs = input.timeoutMs ?? registered.descriptor.defaultTimeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error(`Roster function ${input.functionId} timeoutMs must be a non-negative finite number`);
    }
    const action = input.action ?? { kind: "await" as const };
    if (action.kind === "enqueue") {
      if (!this.enqueue) throw new Error("Roster function enqueue requires a Roster-owned scheduler bridge");
      const { receiptId } = await this.enqueue({
        node: input.node,
        descriptor: cloneDescriptor(registered.descriptor),
        input: value,
        ...(action.queue ? { queue: action.queue } : {}),
        timeoutMs: Math.floor(timeoutMs),
        ...(input.metadata ? { metadata: cloneJson(input.metadata) } : {}),
      });
      if (!receiptId.trim()) throw new Error("Roster function scheduler returned a blank receipt id");
      return {
        result: { status: "enqueued", functionId: input.functionId, receiptId },
        trace: {
          functionId: registered.descriptor.id,
          functionVersion: registered.descriptor.version,
          providerId: "roster-scheduler",
          providerEpoch: 0,
        },
      };
    }
    const bound = this.resolveProvider(input.functionId, input.now ?? Date.now(), input.expectedProvider);
    const provider = bound.provider;
    const output = await invokeWithTimeout({
      timeoutMs: Math.floor(timeoutMs),
      signal: input.signal,
      invoke: (signal) => {
        this.acquireProviderInvocation(bound);
        const invocation = Promise.resolve().then(() => provider.invoke(value, {
          nodeId: input.node.id,
          functionId: input.functionId,
          action: action.kind,
          timeoutMs: Math.floor(timeoutMs),
          signal,
          ...(input.metadata ? { metadata: cloneJson(input.metadata) } : {}),
        }));
        void invocation.then(
          () => this.releaseProviderInvocation(bound),
          () => this.releaseProviderInvocation(bound),
        );
        return invocation;
      },
    });
    if (action.kind === "void") {
      return {
        result: { status: "accepted", functionId: input.functionId, providerId: provider.providerId },
        trace: {
          functionId: registered.descriptor.id,
          functionVersion: registered.descriptor.version,
          providerId: provider.providerId,
          providerEpoch: provider.epoch,
        },
      };
    }
    if (!registered.validateOutput(output)) {
      throw schemaError(`Roster function ${input.functionId} output`, registered.validateOutput);
    }
    return {
      result: {
        status: "completed",
        functionId: input.functionId,
        providerId: provider.providerId,
        output: cloneJson(output),
      },
      trace: {
        functionId: registered.descriptor.id,
        functionVersion: registered.descriptor.version,
        providerId: provider.providerId,
        providerEpoch: provider.epoch,
      },
    };
  }

  private liveProviders(functionId: string, now: number): ReadonlyArray<BoundProvider> {
    return [...(this.providers.get(functionId)?.values() ?? [])]
      .filter((provider) => providerIsLive(provider, now))
      .sort((left, right) =>
        right.provider.epoch - left.provider.epoch
      || left.provider.providerId.localeCompare(right.provider.providerId));
  }

  private acquireProviderInvocation(provider: BoundProvider): void {
    if (provider.state !== "active") {
      throw new Error(
        `Roster function provider ${provider.provider.providerId} is withdrawing and cannot accept new invocations`,
      );
    }
    provider.activeInvocations += 1;
  }

  private releaseProviderInvocation(provider: BoundProvider): void {
    if (provider.activeInvocations < 1) {
      throw new Error(`Roster function provider ${provider.provider.providerId} invocation lease underflow`);
    }
    provider.activeInvocations -= 1;
    if (provider.activeInvocations === 0 && provider.state === "withdrawing") {
      provider.resolveDrained();
    }
  }

  private withdrawProviderGeneration(
    generation: ProviderGenerationRecord,
    options: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RosterFunctionProviderWithdrawalResult> {
    const timeoutMs = providerDrainTimeout(options.timeoutMs);
    if (!generation.withdrawal) {
      generation.state = "withdrawing";
      for (const binding of generation.bindings) {
        if (binding.state === "active") binding.state = "withdrawing";
        if (binding.activeInvocations === 0) binding.resolveDrained();
      }
      generation.withdrawal = (async (): Promise<RosterFunctionProviderWithdrawalResult> => {
        await Promise.all(generation.bindings.map((binding) => binding.drained));
        for (const binding of generation.bindings) {
          const byProvider = this.providers.get(binding.provider.functionId);
          if (byProvider?.get(binding.provider.providerId) === binding) {
            byProvider.delete(binding.provider.providerId);
            if (byProvider.size === 0) this.providers.delete(binding.provider.functionId);
          }
          binding.state = "retired";
        }
        try {
          await generation.dispose?.();
          generation.state = "retired";
          if (this.generations.get(generation.generationId) === generation) {
            this.generations.delete(generation.generationId);
          }
          return {
            generationId: generation.generationId,
            generationHash: generation.generationHash,
            status: "retired",
            activeInvocations: 0,
          };
        } catch (error) {
          generation.state = "cleanup-uncertain";
          if (this.generations.get(generation.generationId) === generation) {
            this.generations.delete(generation.generationId);
          }
          return {
            generationId: generation.generationId,
            generationHash: generation.generationHash,
            status: "cleanup-uncertain",
            activeInvocations: 0,
            cleanupError: error instanceof Error ? error.message : String(error),
          };
        }
      })();
    }
    const abort = new Promise<RosterFunctionProviderWithdrawalResult>((resolve) => {
      let settled = false;
      const timedOut = (): RosterFunctionProviderWithdrawalResult => ({
        generationId: generation.generationId,
        generationHash: generation.generationHash,
        status: "timed-out",
        activeInvocations: generation.bindings.reduce(
          (total, binding) => total + binding.activeInvocations,
          0,
        ),
      });
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(timedOut());
      };
      const timeout = setTimeout(finish, timeoutMs);
      timeout.unref?.();
      const onAbort = (): void => {
        finish();
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      void generation.withdrawal!.finally(() => {
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      });
    });
    return Promise.race([generation.withdrawal, abort]);
  }

  private resolveProvider(
    functionId: string,
    now: number,
    expected?: { readonly providerId: string; readonly epoch: number },
  ): BoundProvider {
    const providers = this.liveProviders(functionId, now);
    const provider = providers[0];
    if (!provider) throw new Error(`Roster function ${functionId} has no available provider`);
    if (
      expected
      && (provider.provider.providerId !== expected.providerId || provider.provider.epoch !== expected.epoch)
    ) {
      throw new Error(`Roster function ${functionId} provider changed after catalog projection`);
    }
    return provider;
  }

  private isAuthorized(
    descriptor: RosterFunctionDescriptor,
    access: RosterFunctionAccess,
  ): boolean {
    if (!(access.functionGrants ?? []).includes(descriptor.id)) return false;
    const scopes = new Set(access.scopes ?? []);
    if ((descriptor.requiredScopes ?? []).some((scope) => !scopes.has(scope))) return false;
    const effects = new Set(access.allowedEffects ?? ["read"]);
    return descriptor.effects.every((effect) => effects.has(effect));
  }

  private assertAuthorized(
    node: WorkspaceNode,
    descriptor: RosterFunctionDescriptor,
    access: RosterFunctionAccess,
  ): void {
    if (!(access.functionGrants ?? []).includes(descriptor.id)) {
      throw new Error(`Workspace node ${node.id} is not granted callable function ${descriptor.id}`);
    }
    const scopes = new Set(access.scopes ?? []);
    const missingScopes = (descriptor.requiredScopes ?? []).filter((scope) => !scopes.has(scope));
    if (missingScopes.length) {
      throw new Error(`Workspace node ${node.id} is missing function scopes: ${missingScopes.join(", ")}`);
    }
    const effects = new Set(access.allowedEffects ?? ["read"]);
    const deniedEffects = descriptor.effects.filter((effect) => !effects.has(effect));
    if (deniedEffects.length) {
      throw new Error(`Workspace node ${node.id} is not authorized for function effects: ${deniedEffects.join(", ")}`);
    }
  }
}
