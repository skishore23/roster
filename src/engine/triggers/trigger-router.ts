import { hashCanonical } from "../../core/canonical.js";
import type {
  RosterFunctionAccess,
  RosterFunctionDirectory,
  RosterFunctionInvocationAction,
  RosterFunctionInvocationResult,
} from "../functions/function-directory.js";
import type { JsonValue, WorkspaceNode } from "../orchestration/types.js";
import type { ExecutionTraceContext } from "../platform/protocol.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFAULT_MAX_TRIGGERS = 1_024;
const DEFAULT_MAX_ROUTES_PER_EVENT = 32;
const DEFAULT_MAX_SEEN_DELIVERIES = 10_000;

export const ROSTER_TRIGGER_DEFINITION_VERSION = "roster.trigger-definition.v1" as const;
export const ROSTER_TRIGGER_CATALOG_VERSION = "roster.trigger-catalog.v1" as const;

export type RosterTriggerKind =
  | "direct"
  | "http"
  | "schedule"
  | "queue"
  | "state"
  | "stream"
  | "custom";

export type RosterTriggerDefinition = {
  readonly schemaVersion: typeof ROSTER_TRIGGER_DEFINITION_VERSION;
  readonly triggerId: string;
  readonly version: string;
  readonly source: {
    readonly kind: RosterTriggerKind;
    readonly key: string;
  };
  readonly target: {
    readonly functionId: string;
    readonly functionVersion: string;
    readonly action: RosterFunctionInvocationAction;
  };
  /**
   * Event forwards only the trigger value. Envelope also includes bounded
   * routing metadata; it never includes a worker result or model transcript.
   */
  readonly inputMode: "event" | "envelope";
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type RosterTriggerCatalog = {
  readonly schemaVersion: typeof ROSTER_TRIGGER_CATALOG_VERSION;
  readonly catalogVersion: string;
  readonly triggers: ReadonlyArray<RosterTriggerDefinition>;
};

export type RosterTriggerEvent = {
  readonly eventId: string;
  readonly source: {
    readonly kind: RosterTriggerKind;
    readonly key: string;
  };
  readonly value: JsonValue;
  readonly occurredAt: number;
  readonly trace?: ExecutionTraceContext;
};

export type RosterTriggerDelivery = {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly triggerId: string;
  readonly triggerVersion: string;
  readonly catalogVersion: string;
  readonly functionId: string;
  readonly functionVersion: string;
  readonly status: RosterFunctionInvocationResult["status"];
  readonly providerId?: string;
  readonly receiptId?: string;
};

export type RosterTriggerRouterOptions = {
  readonly directory: RosterFunctionDirectory;
  readonly maxTriggers?: number;
  readonly maxRoutesPerEvent?: number;
  readonly maxSeenDeliveries?: number;
};

const cloneJson = <Value extends JsonValue>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

const cloneDefinition = (definition: RosterTriggerDefinition): RosterTriggerDefinition => ({
  ...definition,
  source: { ...definition.source },
  target: {
    ...definition.target,
    action: { ...definition.target.action },
  },
  ...(definition.metadata ? { metadata: cloneJson(definition.metadata) } : {}),
});

const boundedPositiveInteger = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
};

const assertIdentifier = (kind: string, value: string): void => {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${kind} "${value}"`);
};

/**
 * Provider-neutral reactive routing. The router only maps trigger events to
 * function invocations. Durable scheduling, task retries, and acceptance stay
 * in the Roster task graph and are reached through an enqueue action.
 */
export class RosterTriggerRouter {
  private readonly directory: RosterFunctionDirectory;
  private readonly definitions = new Map<string, RosterTriggerDefinition>();
  private readonly deliveries = new Map<string, ReadonlyArray<RosterTriggerDelivery>>();
  private readonly maxTriggers: number;
  private readonly maxRoutesPerEvent: number;
  private readonly maxSeenDeliveries: number;

  constructor(options: RosterTriggerRouterOptions) {
    this.directory = options.directory;
    this.maxTriggers = boundedPositiveInteger(options.maxTriggers, DEFAULT_MAX_TRIGGERS, "maxTriggers");
    this.maxRoutesPerEvent = boundedPositiveInteger(
      options.maxRoutesPerEvent,
      DEFAULT_MAX_ROUTES_PER_EVENT,
      "maxRoutesPerEvent",
    );
    this.maxSeenDeliveries = boundedPositiveInteger(
      options.maxSeenDeliveries,
      DEFAULT_MAX_SEEN_DELIVERIES,
      "maxSeenDeliveries",
    );
  }

  register(input: RosterTriggerDefinition): () => void {
    if (input.schemaVersion !== ROSTER_TRIGGER_DEFINITION_VERSION) {
      throw new Error("Unsupported Roster trigger definition version");
    }
    assertIdentifier("trigger id", input.triggerId);
    assertIdentifier("trigger source key", input.source.key);
    if (!input.version.trim()) throw new Error(`Roster trigger ${input.triggerId} requires a version`);
    if (this.definitions.has(input.triggerId)) {
      throw new Error(`Roster trigger ${input.triggerId} is already registered`);
    }
    if (this.definitions.size >= this.maxTriggers) {
      throw new Error(`Roster trigger catalog exceeds maxTriggers=${this.maxTriggers}`);
    }
    const descriptor = this.directory.descriptor(input.target.functionId);
    if (descriptor.version !== input.target.functionVersion) {
      throw new Error(
        `Roster trigger ${input.triggerId} requires unavailable `
        + `${input.target.functionId}@${input.target.functionVersion}`,
      );
    }
    if (
      input.timeoutMs !== undefined
      && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)
    ) {
      throw new Error(`Roster trigger ${input.triggerId} timeoutMs must be a positive safe integer`);
    }
    const definition = cloneDefinition({
      ...input,
      version: input.version.trim(),
    });
    this.definitions.set(definition.triggerId, definition);
    return () => {
      if (this.definitions.get(definition.triggerId) === definition) {
        this.definitions.delete(definition.triggerId);
      }
    };
  }

  catalog(): RosterTriggerCatalog {
    const triggers = [...this.definitions.values()]
      .map(cloneDefinition)
      .sort((left, right) => left.triggerId.localeCompare(right.triggerId));
    return {
      schemaVersion: ROSTER_TRIGGER_CATALOG_VERSION,
      catalogVersion: hashCanonical({
        schemaVersion: ROSTER_TRIGGER_CATALOG_VERSION,
        triggers,
      }),
      triggers,
    };
  }

  async route(input: {
    readonly node: WorkspaceNode;
    readonly event: RosterTriggerEvent;
    readonly access?: RosterFunctionAccess;
    readonly signal?: AbortSignal;
  }): Promise<ReadonlyArray<RosterTriggerDelivery>> {
    assertIdentifier("trigger event id", input.event.eventId);
    assertIdentifier("trigger event source key", input.event.source.key);
    if (!Number.isSafeInteger(input.event.occurredAt) || input.event.occurredAt < 0) {
      throw new Error("Roster trigger event occurredAt must be a non-negative safe integer");
    }
    const replay = this.deliveries.get(input.event.eventId);
    if (replay) return replay.map((delivery) => ({ ...delivery }));

    const catalog = this.catalog();
    const matches = catalog.triggers.filter((trigger) =>
      trigger.enabled
      && trigger.source.kind === input.event.source.kind
      && trigger.source.key === input.event.source.key);
    if (matches.length > this.maxRoutesPerEvent) {
      throw new Error(
        `Roster trigger event ${input.event.eventId} exceeds maxRoutesPerEvent=${this.maxRoutesPerEvent}`,
      );
    }

    const deliveries: RosterTriggerDelivery[] = [];
    for (const trigger of matches) {
      const value = trigger.inputMode === "event"
        ? cloneJson(input.event.value)
        : {
            eventId: input.event.eventId,
            source: { ...input.event.source },
            value: cloneJson(input.event.value),
            occurredAt: input.event.occurredAt,
          };
      const invocation = await this.directory.invoke({
        node: input.node,
        functionId: trigger.target.functionId,
        value,
        action: trigger.target.action,
        access: input.access,
        timeoutMs: trigger.timeoutMs,
        signal: input.signal,
        now: input.event.occurredAt,
        metadata: {
          triggerId: trigger.triggerId,
          triggerVersion: trigger.version,
          eventId: input.event.eventId,
          catalogVersion: catalog.catalogVersion,
          ...(input.event.trace ? {
            traceId: input.event.trace.traceId,
            spanId: input.event.trace.spanId,
          } : {}),
          ...(trigger.metadata ?? {}),
        },
      });
      deliveries.push({
        deliveryId: hashCanonical({
          eventId: input.event.eventId,
          triggerId: trigger.triggerId,
          triggerVersion: trigger.version,
          catalogVersion: catalog.catalogVersion,
        }),
        eventId: input.event.eventId,
        triggerId: trigger.triggerId,
        triggerVersion: trigger.version,
        catalogVersion: catalog.catalogVersion,
        functionId: trigger.target.functionId,
        functionVersion: trigger.target.functionVersion,
        status: invocation.status,
        ...("providerId" in invocation ? { providerId: invocation.providerId } : {}),
        ...("receiptId" in invocation ? { receiptId: invocation.receiptId } : {}),
      });
    }
    const stable = deliveries.map((delivery) => ({ ...delivery }));
    this.deliveries.set(input.event.eventId, stable);
    while (this.deliveries.size > this.maxSeenDeliveries) {
      const oldest = this.deliveries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.deliveries.delete(oldest);
    }
    return stable.map((delivery) => ({ ...delivery }));
  }
}
