import { hashCanonical } from "../../core/canonical.js";
import type {
  JsonValue,
  WorkspaceNode,
  WorkspaceNodeContinuityPolicy,
} from "../orchestration/types.js";

export const NODE_CONTINUITY_SCHEMA_VERSION = "roster.node-continuity.v1" as const;
export const NODE_CONTINUITY_MANIFEST_VERSION = "roster.node-continuity-manifest.v1" as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type NormalizedWorkspaceNodeContinuityPolicy = {
  readonly mode: "run" | "workspace";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly wakeAgentId: string;
  readonly memory: "none" | "private";
  readonly maxPendingInboxItems: number;
  readonly maxInboxItemsPerWake: number;
  readonly maxActiveCommitments: number;
  readonly maxCausalDepth: number;
  readonly maxWakesPerWindow: number;
  readonly wakeWindowMs: number;
  readonly minWakeIntervalMs: number;
};

export const DEFAULT_NODE_CONTINUITY_POLICY: NormalizedWorkspaceNodeContinuityPolicy =
  Object.freeze({
    mode: "run",
    policyId: "roster.continuity.default",
    policyVersion: "1",
    wakeAgentId: "roster-node-continuity",
    memory: "none",
    maxPendingInboxItems: 64,
    maxInboxItemsPerWake: 8,
    maxActiveCommitments: 32,
    maxCausalDepth: 4,
    maxWakesPerWindow: 24,
    wakeWindowMs: DAY_MS,
    minWakeIntervalMs: 0,
  });

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number => {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
};

const boundedText = (value: string | undefined, fallback: string, label: string): string => {
  const normalized = (value ?? fallback).trim();
  if (!normalized || normalized.length > 160) {
    throw new Error(`${label} must be between 1 and 160 characters`);
  }
  return normalized;
};

const boundedId = (value: string | undefined, fallback: string, label: string): string => {
  const normalized = boundedText(value, fallback, label);
  if (!ID_PATTERN.test(normalized)) throw new Error(`${label} contains unsafe characters`);
  return normalized;
};

export const normalizeWorkspaceNodeContinuityPolicy = (
  policy: WorkspaceNodeContinuityPolicy | undefined,
): NormalizedWorkspaceNodeContinuityPolicy => {
  const input = policy ?? DEFAULT_NODE_CONTINUITY_POLICY;
  if (input.mode !== "run" && input.mode !== "workspace") {
    throw new Error("Workspace node continuity mode must be run or workspace");
  }
  const memory = input.memory ?? (input.mode === "workspace" ? "private" : "none");
  if (memory !== "none" && memory !== "private") {
    throw new Error("Workspace node continuity memory must be none or private");
  }
  return Object.freeze({
    mode: input.mode,
    policyId: boundedId(input.policyId, DEFAULT_NODE_CONTINUITY_POLICY.policyId, "Continuity policyId"),
    policyVersion: boundedText(
      input.policyVersion,
      DEFAULT_NODE_CONTINUITY_POLICY.policyVersion,
      "Continuity policyVersion",
    ),
    wakeAgentId: boundedId(
      input.wakeAgentId,
      DEFAULT_NODE_CONTINUITY_POLICY.wakeAgentId,
      "Continuity wakeAgentId",
    ),
    memory,
    maxPendingInboxItems: boundedInteger(
      input.maxPendingInboxItems,
      DEFAULT_NODE_CONTINUITY_POLICY.maxPendingInboxItems,
      "Continuity maxPendingInboxItems",
      1,
      1_024,
    ),
    maxInboxItemsPerWake: boundedInteger(
      input.maxInboxItemsPerWake,
      DEFAULT_NODE_CONTINUITY_POLICY.maxInboxItemsPerWake,
      "Continuity maxInboxItemsPerWake",
      1,
      64,
    ),
    maxActiveCommitments: boundedInteger(
      input.maxActiveCommitments,
      DEFAULT_NODE_CONTINUITY_POLICY.maxActiveCommitments,
      "Continuity maxActiveCommitments",
      1,
      256,
    ),
    maxCausalDepth: boundedInteger(
      input.maxCausalDepth,
      DEFAULT_NODE_CONTINUITY_POLICY.maxCausalDepth,
      "Continuity maxCausalDepth",
      0,
      32,
    ),
    maxWakesPerWindow: boundedInteger(
      input.maxWakesPerWindow,
      DEFAULT_NODE_CONTINUITY_POLICY.maxWakesPerWindow,
      "Continuity maxWakesPerWindow",
      1,
      10_000,
    ),
    wakeWindowMs: boundedInteger(
      input.wakeWindowMs,
      DEFAULT_NODE_CONTINUITY_POLICY.wakeWindowMs,
      "Continuity wakeWindowMs",
      1_000,
      30 * DAY_MS,
    ),
    minWakeIntervalMs: boundedInteger(
      input.minWakeIntervalMs,
      DEFAULT_NODE_CONTINUITY_POLICY.minWakeIntervalMs,
      "Continuity minWakeIntervalMs",
      0,
      DAY_MS,
    ),
  });
};

export type NodeContinuityStatus =
  | "dormant"
  | "queued"
  | "working"
  | "waiting"
  | "suspended";

export type NodeInboxCause =
  | "direct"
  | "task"
  | "schedule"
  | "state"
  | "stream"
  | "operator"
  | "custom";

/**
 * A scheduling lane keeps independent conversations from being merged into
 * one wake. Room and run identifiers are optional projection hints; laneId is
 * the provider-neutral isolation and fairness boundary.
 */
export type NodeInboxScope = {
  readonly laneId: string;
  readonly roomId?: string;
  readonly runId?: string;
};

export type NodeInboxItem = {
  readonly deliveryId: string;
  readonly sequence: number;
  readonly cause: NodeInboxCause;
  readonly scope: NodeInboxScope;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly sourceHash: string;
  readonly payloadReference?: string;
  readonly causalParentId?: string;
  readonly causalDepth: number;
  readonly deliveredAt: number;
};

export type NodeCommitmentStatus = "active" | "waiting" | "completed" | "abandoned";

export type NodeCommitment = {
  readonly commitmentId: string;
  readonly objective: string;
  readonly status: NodeCommitmentStatus;
  readonly revision: number;
  readonly sourceId: string;
  readonly updatedAt: number;
};

export type NodeMemoryFrontier = {
  readonly scopeId: string;
  readonly snapshotVersion: string;
  readonly updatedAt: number;
};

export type NodeWake = {
  readonly wakeId: string;
  readonly requestId: string;
  readonly laneId: string;
  readonly roomId?: string;
  readonly runId?: string;
  readonly inboxDeliveryIds: ReadonlyArray<string>;
  readonly requestedAt: number;
  readonly notBefore: number;
  readonly admittedAt?: number;
};

export const nodeContinuityJobId = (wakeId: string): string =>
  `node_wake_job_${assertId(wakeId, "Wake id")}`;

export type NodeContinuityState = {
  readonly schemaVersion: typeof NODE_CONTINUITY_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly nodeRevision: number;
  readonly policy: NormalizedWorkspaceNodeContinuityPolicy;
  readonly status: NodeContinuityStatus;
  readonly revision: number;
  readonly nextInboxSequence: number;
  readonly pendingInbox: ReadonlyArray<NodeInboxItem>;
  readonly commitments: ReadonlyArray<NodeCommitment>;
  readonly memoryFrontier?: NodeMemoryFrontier;
  readonly activeWake?: NodeWake;
  readonly lastWakeId?: string;
  readonly lastWakeAt?: number;
  readonly wakeWindowStartedAt: number;
  readonly wakesInWindow: number;
  readonly updatedAt: number;
};

export type NodeContinuityEvent =
  | {
      readonly type: "node.continuity.registered";
      readonly workspaceId: string;
      readonly nodeId: string;
      readonly nodeRevision: number;
      readonly policy: NormalizedWorkspaceNodeContinuityPolicy;
      readonly occurredAt: number;
    }
  | { readonly type: "node.inbox.delivered"; readonly item: NodeInboxItem; readonly occurredAt: number }
  | { readonly type: "node.wake.requested"; readonly wake: NodeWake; readonly occurredAt: number }
  | { readonly type: "node.wake.admitted"; readonly wakeId: string; readonly occurredAt: number }
  | {
      readonly type: "node.wake.completed";
      readonly wakeId: string;
      readonly consumedDeliveryIds: ReadonlyArray<string>;
      readonly occurredAt: number;
    }
  | { readonly type: "node.wake.failed"; readonly wakeId: string; readonly occurredAt: number }
  | {
      readonly type: "node.wake.resolved";
      readonly wakeId: string;
      readonly consumedDeliveryIds: ReadonlyArray<string>;
      readonly resolution: "superseded";
      readonly occurredAt: number;
    }
  | { readonly type: "node.continuity.suspended"; readonly occurredAt: number }
  | { readonly type: "node.continuity.resumed"; readonly occurredAt: number }
  | { readonly type: "node.commitment.changed"; readonly commitment: NodeCommitment; readonly occurredAt: number }
  | { readonly type: "node.memory.frontier.updated"; readonly frontier: NodeMemoryFrontier; readonly occurredAt: number };

const assertId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!ID_PATTERN.test(normalized) || normalized.length > 240) {
    throw new Error(`${label} contains unsafe characters or exceeds 240 characters`);
  }
  return normalized;
};

const assertTimestamp = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
};

const normalizeInboxScope = (scope: NodeInboxScope): NodeInboxScope => {
  if (!scope || typeof scope !== "object") throw new Error("Inbox scope is required");
  return Object.freeze({
    laneId: assertId(scope.laneId, "Inbox laneId"),
    ...(scope.roomId ? { roomId: assertId(scope.roomId, "Inbox roomId") } : {}),
    ...(scope.runId ? { runId: assertId(scope.runId, "Inbox runId") } : {}),
  });
};

const assertStateIdentity = (state: NodeContinuityState): void => {
  assertId(state.workspaceId, "Continuity workspaceId");
  assertId(state.nodeId, "Continuity nodeId");
};

const increment = (state: NodeContinuityState, occurredAt: number): Pick<NodeContinuityState, "revision" | "updatedAt"> => ({
  revision: state.revision + 1,
  updatedAt: Math.max(state.updatedAt, occurredAt),
});

export const reduceNodeContinuity = (
  state: NodeContinuityState | undefined,
  event: NodeContinuityEvent,
): NodeContinuityState => {
  assertTimestamp(event.occurredAt, "Continuity event occurredAt");
  if (event.type === "node.continuity.registered") {
    const workspaceId = assertId(event.workspaceId, "Continuity workspaceId");
    const nodeId = assertId(event.nodeId, "Continuity nodeId");
    if (!Number.isSafeInteger(event.nodeRevision) || event.nodeRevision < 1) {
      throw new Error("Continuity nodeRevision must be a positive safe integer");
    }
    if (state) {
      if (state.workspaceId !== workspaceId || state.nodeId !== nodeId) {
        throw new Error("Cannot register continuity over a different node identity");
      }
      if (event.nodeRevision < state.nodeRevision) throw new Error("Cannot apply a stale node continuity revision");
      if (event.nodeRevision === state.nodeRevision) {
        if (hashCanonical(state.policy) !== hashCanonical(event.policy)) {
          throw new Error("Node continuity policy changed without a node revision");
        }
        return state;
      }
      return {
        ...state,
        nodeRevision: event.nodeRevision,
        policy: normalizeWorkspaceNodeContinuityPolicy(event.policy),
        ...increment(state, event.occurredAt),
      };
    }
    return Object.freeze({
      schemaVersion: NODE_CONTINUITY_SCHEMA_VERSION,
      workspaceId,
      nodeId,
      nodeRevision: event.nodeRevision,
      policy: normalizeWorkspaceNodeContinuityPolicy(event.policy),
      status: "dormant",
      revision: 1,
      nextInboxSequence: 1,
      pendingInbox: Object.freeze([]),
      commitments: Object.freeze([]),
      wakeWindowStartedAt: event.occurredAt,
      wakesInWindow: 0,
      updatedAt: event.occurredAt,
    });
  }
  if (!state) throw new Error("Node continuity must be registered before applying lifecycle events");
  assertStateIdentity(state);

  if (event.type === "node.inbox.delivered") {
    const existing = state.pendingInbox.find((item) => item.deliveryId === event.item.deliveryId);
    if (existing) {
      if (hashCanonical(existing) !== hashCanonical(event.item)) throw new Error("Inbox delivery changed during replay");
      return state;
    }
    if (event.item.sequence !== state.nextInboxSequence) throw new Error("Inbox delivery sequence is not contiguous");
    if (event.item.causalDepth > state.policy.maxCausalDepth) throw new Error("Inbox delivery exceeds maxCausalDepth");
    if (state.pendingInbox.length >= state.policy.maxPendingInboxItems) {
      throw new Error("Node continuity inbox is full");
    }
    return {
      ...state,
      pendingInbox: Object.freeze([...state.pendingInbox, Object.freeze({ ...event.item })]),
      nextInboxSequence: state.nextInboxSequence + 1,
      status: state.status === "dormant" ? "waiting" : state.status,
      ...increment(state, event.occurredAt),
    };
  }

  if (event.type === "node.wake.requested") {
    if (state.status === "suspended") throw new Error("Cannot wake a suspended node");
    if (state.activeWake) {
      if (state.activeWake.requestId === event.wake.requestId
        && hashCanonical(state.activeWake) === hashCanonical(event.wake)) return state;
      throw new Error(`Node already has active wake ${state.activeWake.wakeId}`);
    }
    if (state.pendingInbox.length === 0) throw new Error("Cannot wake a node with an empty inbox");
    const pendingIds = new Set(state.pendingInbox.map((item) => item.deliveryId));
    if (!event.wake.inboxDeliveryIds.length
      || event.wake.inboxDeliveryIds.some((deliveryId) => !pendingIds.has(deliveryId))) {
      throw new Error("Wake must bind one or more pending inbox deliveries");
    }
    const selected = state.pendingInbox.filter((item) => event.wake.inboxDeliveryIds.includes(item.deliveryId));
    if (selected.some((item) => item.scope.laneId !== event.wake.laneId)) {
      throw new Error("Wake cannot cross inbox lanes");
    }
    if (selected.length > state.policy.maxInboxItemsPerWake) {
      throw new Error("Wake exceeds maxInboxItemsPerWake");
    }
    const expected = state.pendingInbox
      .filter((item) => item.scope.laneId === state.pendingInbox[0]?.scope.laneId)
      .slice(0, state.policy.maxInboxItemsPerWake);
    if (hashCanonical(event.wake.inboxDeliveryIds) !== hashCanonical(expected.map((item) => item.deliveryId))) {
      throw new Error("Wake must select the bounded prefix of the oldest inbox lane");
    }
    const scope = expected[0]!.scope;
    if (event.wake.laneId !== scope.laneId
      || event.wake.roomId !== scope.roomId
      || event.wake.runId !== scope.runId) {
      throw new Error("Wake scope does not match its inbox lane");
    }
    return {
      ...state,
      activeWake: Object.freeze({ ...event.wake, inboxDeliveryIds: Object.freeze([...event.wake.inboxDeliveryIds]) }),
      status: "queued",
      ...increment(state, event.occurredAt),
    };
  }

  if (event.type === "node.wake.admitted") {
    if (!state.activeWake || state.activeWake.wakeId !== event.wakeId) throw new Error("Wake admission is stale");
    if (event.occurredAt < state.activeWake.notBefore) throw new Error("Wake was admitted before notBefore");
    const windowExpired = event.occurredAt - state.wakeWindowStartedAt >= state.policy.wakeWindowMs;
    const wakesInWindow = windowExpired ? 0 : state.wakesInWindow;
    if (wakesInWindow >= state.policy.maxWakesPerWindow) throw new Error("Node wake budget is exhausted");
    if (state.lastWakeAt !== undefined
      && event.occurredAt - state.lastWakeAt < state.policy.minWakeIntervalMs) {
      throw new Error("Node wake violates minWakeIntervalMs");
    }
    return {
      ...state,
      activeWake: Object.freeze({ ...state.activeWake, admittedAt: event.occurredAt }),
      status: "working",
      lastWakeAt: event.occurredAt,
      wakeWindowStartedAt: windowExpired ? event.occurredAt : state.wakeWindowStartedAt,
      wakesInWindow: wakesInWindow + 1,
      ...increment(state, event.occurredAt),
    };
  }

  if (event.type === "node.wake.completed") {
    if (!state.activeWake || state.activeWake.wakeId !== event.wakeId) throw new Error("Wake completion is stale");
    const bound = new Set(state.activeWake.inboxDeliveryIds);
    if (event.consumedDeliveryIds.some((deliveryId) => !bound.has(deliveryId))) {
      throw new Error("Wake cannot consume an inbox delivery outside its manifest");
    }
    const consumed = new Set(event.consumedDeliveryIds);
    const pendingInbox = state.pendingInbox.filter((item) => !consumed.has(item.deliveryId));
    return {
      ...state,
      activeWake: undefined,
      lastWakeId: event.wakeId,
      pendingInbox: Object.freeze(pendingInbox),
      status: pendingInbox.length ? "waiting" : "dormant",
      ...increment(state, event.occurredAt),
    };
  }

  if (event.type === "node.wake.failed") {
    if (!state.activeWake || state.activeWake.wakeId !== event.wakeId) throw new Error("Wake failure is stale");
    return {
      ...state,
      activeWake: undefined,
      lastWakeId: event.wakeId,
      status: state.pendingInbox.length ? "waiting" : "dormant",
      ...increment(state, event.occurredAt),
    };
  }

  if (event.type === "node.wake.resolved") {
    const requested = new Set(event.consumedDeliveryIds);
    if (!requested.size) throw new Error("Failed wake resolution must consume at least one delivery");
    const pending = new Set(state.pendingInbox.map((item) => item.deliveryId));
    const unresolved = event.consumedDeliveryIds.filter((deliveryId) => pending.has(deliveryId));
    if (unresolved.length === 0) return state;
    if (state.activeWake) throw new Error("Cannot resolve a failed wake while another wake is active");
    if (state.lastWakeId !== event.wakeId) throw new Error("Failed wake resolution is stale");
    if (unresolved.length !== requested.size) {
      throw new Error("Failed wake resolution cannot partially consume its deliveries");
    }
    const pendingInbox = state.pendingInbox.filter((item) => !requested.has(item.deliveryId));
    return {
      ...state,
      pendingInbox: Object.freeze(pendingInbox),
      status: pendingInbox.length ? "waiting" : "dormant",
      ...increment(state, event.occurredAt),
    };
  }

  if (event.type === "node.continuity.suspended") {
    if (state.activeWake?.admittedAt !== undefined) throw new Error("Cannot suspend a node while it is working");
    return state.status === "suspended" ? state : {
      ...state,
      activeWake: undefined,
      status: "suspended",
      ...increment(state, event.occurredAt),
    };
  }

  if (event.type === "node.continuity.resumed") {
    if (state.status !== "suspended") return state;
    return {
      ...state,
      status: state.pendingInbox.length ? "waiting" : "dormant",
      ...increment(state, event.occurredAt),
    };
  }

  if (event.type === "node.commitment.changed") {
    const commitment = event.commitment;
    assertId(commitment.commitmentId, "Commitment id");
    if (!commitment.objective.trim() || commitment.objective.length > 4_000) {
      throw new Error("Commitment objective must be between 1 and 4000 characters");
    }
    const prior = state.commitments.find((candidate) => candidate.commitmentId === commitment.commitmentId);
    if (prior && commitment.revision < prior.revision) throw new Error("Commitment revision is stale");
    if (prior && commitment.revision === prior.revision) {
      if (hashCanonical(prior) !== hashCanonical(commitment)) throw new Error("Commitment changed without a revision");
      return state;
    }
    const commitments = state.commitments
      .filter((candidate) => candidate.commitmentId !== commitment.commitmentId)
      .concat(Object.freeze({ ...commitment }))
      .sort((left, right) => left.commitmentId.localeCompare(right.commitmentId));
    const activeCount = commitments.filter(({ status }) => status === "active" || status === "waiting").length;
    if (activeCount > state.policy.maxActiveCommitments) throw new Error("Node has too many active commitments");
    return { ...state, commitments: Object.freeze(commitments), ...increment(state, event.occurredAt) };
  }

  const frontier = event.frontier;
  if (!frontier.scopeId.trim() || !frontier.snapshotVersion.trim()) {
    throw new Error("Node memory frontier requires scopeId and snapshotVersion");
  }
  return {
    ...state,
    memoryFrontier: Object.freeze({ ...frontier }),
    ...increment(state, event.occurredAt),
  };
};

export const createNodeInboxDelivery = (
  state: NodeContinuityState,
  input: Omit<NodeInboxItem, "sequence">,
): NodeContinuityEvent => ({
  type: "node.inbox.delivered",
  item: Object.freeze({
    ...input,
    deliveryId: assertId(input.deliveryId, "Inbox deliveryId"),
    sourceId: assertId(input.sourceId, "Inbox sourceId"),
    scope: normalizeInboxScope(input.scope),
    sequence: state.nextInboxSequence,
    causalDepth: boundedInteger(
      input.causalDepth,
      0,
      "Inbox causalDepth (maxCausalDepth)",
      0,
      state.policy.maxCausalDepth,
    ),
    deliveredAt: assertTimestamp(input.deliveredAt, "Inbox deliveredAt"),
  }),
  occurredAt: input.deliveredAt,
});

export type NodeWakeDecision =
  | { readonly admitted: true; readonly event: Extract<NodeContinuityEvent, { readonly type: "node.wake.requested" }> }
  | { readonly admitted: false; readonly reason: "suspended" | "already-active" | "empty-inbox" | "cooldown" | "budget" };

export const nodeContinuationWakeRequestId = (state: NodeContinuityState): string => {
  const head = state.pendingInbox[0];
  if (!head) throw new Error("Cannot identify a continuation wake for an empty inbox");
  return `continuation_${hashCanonical({
    workspaceId: state.workspaceId,
    nodeId: state.nodeId,
    deliveryId: head.deliveryId,
    laneId: head.scope.laneId,
  }).slice(0, 28)}`;
};

export const requestNodeWake = (state: NodeContinuityState, input: {
  readonly requestId: string;
  readonly requestedAt: number;
  readonly notBefore?: number;
}): NodeWakeDecision => {
  if (state.status === "suspended") return { admitted: false, reason: "suspended" };
  if (state.activeWake) return { admitted: false, reason: "already-active" };
  if (!state.pendingInbox.length) return { admitted: false, reason: "empty-inbox" };
  const windowExpired = input.requestedAt - state.wakeWindowStartedAt >= state.policy.wakeWindowMs;
  if (!windowExpired && state.wakesInWindow >= state.policy.maxWakesPerWindow) {
    return { admitted: false, reason: "budget" };
  }
  const earliest = state.lastWakeAt === undefined
    ? input.requestedAt
    : state.lastWakeAt + state.policy.minWakeIntervalMs;
  const notBefore = Math.max(input.notBefore ?? input.requestedAt, earliest);
  if (notBefore > input.requestedAt && input.notBefore === undefined) {
    return { admitted: false, reason: "cooldown" };
  }
  const requestId = assertId(input.requestId, "Wake requestId");
  const head = state.pendingInbox[0]!;
  const selected = state.pendingInbox
    .filter((item) => item.scope.laneId === head.scope.laneId)
    .slice(0, state.policy.maxInboxItemsPerWake);
  const identity = {
    workspaceId: state.workspaceId,
    nodeId: state.nodeId,
    requestId,
    continuityRevision: state.revision,
    laneId: head.scope.laneId,
    inboxDeliveryIds: selected.map((item) => item.deliveryId),
    requestedAt: assertTimestamp(input.requestedAt, "Wake requestedAt"),
    notBefore: assertTimestamp(notBefore, "Wake notBefore"),
  };
  return {
    admitted: true,
    event: {
      type: "node.wake.requested",
      wake: Object.freeze({
        wakeId: `node_wake_${hashCanonical(identity).slice(0, 28)}`,
        requestId,
        laneId: identity.laneId,
        ...(head.scope.roomId ? { roomId: head.scope.roomId } : {}),
        ...(head.scope.runId ? { runId: head.scope.runId } : {}),
        inboxDeliveryIds: Object.freeze([...identity.inboxDeliveryIds]),
        requestedAt: identity.requestedAt,
        notBefore: identity.notBefore,
      }),
      occurredAt: identity.requestedAt,
    },
  };
};

export type NodeContinuityManifest = {
  readonly schemaVersion: typeof NODE_CONTINUITY_MANIFEST_VERSION;
  readonly manifestId: string;
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly nodeRevision: number;
  readonly continuityRevision: number;
  readonly wake: NodeWake;
  readonly inbox: ReadonlyArray<NodeInboxItem>;
  readonly commitments: ReadonlyArray<NodeCommitment>;
  readonly memoryFrontier?: NodeMemoryFrontier;
  readonly policy: Pick<NormalizedWorkspaceNodeContinuityPolicy, "policyId" | "policyVersion">;
};

export const createNodeContinuityManifest = (
  state: NodeContinuityState,
): NodeContinuityManifest => {
  if (!state.activeWake) throw new Error("Cannot create a continuity manifest without an active wake");
  const selected = new Set(state.activeWake.inboxDeliveryIds);
  const content = Object.freeze({
    schemaVersion: NODE_CONTINUITY_MANIFEST_VERSION,
    workspaceId: state.workspaceId,
    nodeId: state.nodeId,
    nodeRevision: state.nodeRevision,
    continuityRevision: state.revision,
    wake: state.activeWake,
    inbox: Object.freeze(state.pendingInbox.filter((item) => selected.has(item.deliveryId))),
    commitments: Object.freeze([...state.commitments]),
    ...(state.memoryFrontier ? { memoryFrontier: state.memoryFrontier } : {}),
    policy: Object.freeze({
      policyId: state.policy.policyId,
      policyVersion: state.policy.policyVersion,
    }),
  });
  return Object.freeze({
    ...content,
    manifestId: `node_continuity_manifest_${hashCanonical(content as unknown as JsonValue).slice(0, 28)}`,
  });
};

export type NodeRegistrationRevision = number | "next-on-change";

/** Storage-neutral durable authority implemented by SpacetimeDB in production. */
export interface NodeContinuityControl {
  readonly durability: "process-local" | "durable";
  register(input: {
    readonly workspaceId: string;
    readonly node: WorkspaceNode;
    readonly nodeRevision: NodeRegistrationRevision;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState>;
  deliver(input: Omit<NodeInboxItem, "sequence"> & {
    readonly workspaceId: string;
    readonly nodeId: string;
  }): Promise<NodeContinuityState>;
  deliverAndRequestWake(input: Omit<NodeInboxItem, "sequence"> & {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wake: {
      readonly requestId: string;
      readonly requestedAt: number;
      readonly notBefore?: number;
    };
  }): Promise<{ readonly state: NodeContinuityState; readonly wake: NodeWakeDecision }>;
  requestWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly requestId: string;
    readonly requestedAt: number;
    readonly notBefore?: number;
  }): Promise<NodeWakeDecision>;
  admitWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly admittedAt: number;
    readonly lease?: { readonly workerId: string; readonly fence: string };
  }): Promise<NodeContinuityState>;
  completeWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly consumedDeliveryIds: ReadonlyArray<string>;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState>;
  failWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly occurredAt: number;
    readonly error: string;
  }): Promise<NodeContinuityState>;
  resolveFailedWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly resolution: "superseded";
    readonly occurredAt: number;
  }): Promise<NodeContinuityState>;
  suspend(workspaceId: string, nodeId: string, occurredAt: number): Promise<NodeContinuityState>;
  resume(workspaceId: string, nodeId: string, occurredAt: number): Promise<NodeContinuityState>;
  changeCommitment(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly commitment: NodeCommitment;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState>;
  updateMemoryFrontier(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly frontier: NodeMemoryFrontier;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState>;
  manifest(workspaceId: string, nodeId: string, wakeId: string): Promise<NodeContinuityManifest>;
  snapshot(workspaceId: string, nodeId: string): Promise<NodeContinuityState | undefined>;
}

const continuityKey = (workspaceId: string, nodeId: string): string =>
  `${workspaceId.length}:${workspaceId}${nodeId}`;

/** Process-local reference authority for simulations and contract tests. */
export class InMemoryNodeContinuityControl implements NodeContinuityControl {
  readonly durability = "process-local" as const;
  private readonly states = new Map<string, NodeContinuityState>();
  private readonly nodeHashes = new Map<string, string>();
  private readonly manifests = new Map<string, NodeContinuityManifest>();
  private readonly deliveries = new Map<string, NodeInboxItem>();
  private readonly failedWakeIds = new Set<string>();

  private current(workspaceId: string, nodeId: string): NodeContinuityState {
    const state = this.states.get(continuityKey(workspaceId, nodeId));
    if (!state) throw new Error(`Node continuity ${workspaceId}/${nodeId} is not registered`);
    return state;
  }

  private apply(state: NodeContinuityState | undefined, event: NodeContinuityEvent): NodeContinuityState {
    const updated = reduceNodeContinuity(state, event);
    this.states.set(continuityKey(updated.workspaceId, updated.nodeId), updated);
    return updated;
  }

  async register(input: {
    readonly workspaceId: string;
    readonly node: WorkspaceNode;
    readonly nodeRevision: NodeRegistrationRevision;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    const policy = normalizeWorkspaceNodeContinuityPolicy(input.node.continuity);
    const node = { ...input.node, continuity: policy };
    if (policy.mode !== "workspace") throw new Error(`Node ${node.id} does not declare workspace continuity`);
    const key = continuityKey(input.workspaceId, node.id);
    const current = this.states.get(key);
    const nodeHash = hashCanonical(node as unknown as JsonValue);
    const currentNodeHash = this.nodeHashes.get(key);
    if (input.nodeRevision === "next-on-change" && current && currentNodeHash === nodeHash) return current;
    const nodeRevision = input.nodeRevision === "next-on-change"
      ? (current?.nodeRevision ?? 0) + 1
      : input.nodeRevision;
    if (current?.nodeRevision === nodeRevision && currentNodeHash !== nodeHash) {
      throw new Error(`Workspace node ${node.id} changed without a node revision`);
    }
    const updated = this.apply(current, {
      type: "node.continuity.registered",
      workspaceId: input.workspaceId,
      nodeId: node.id,
      nodeRevision,
      policy,
      occurredAt: input.occurredAt,
    });
    this.nodeHashes.set(key, nodeHash);
    return updated;
  }

  async deliver(input: Omit<NodeInboxItem, "sequence"> & {
    readonly workspaceId: string;
    readonly nodeId: string;
  }): Promise<NodeContinuityState> {
    const state = this.current(input.workspaceId, input.nodeId);
    const deliveryKey = continuityKey(continuityKey(input.workspaceId, input.nodeId), input.deliveryId);
    const existing = this.deliveries.get(deliveryKey);
    if (existing) {
      const { workspaceId: _workspaceId, nodeId: _nodeId, ...delivery } = input;
      const replay = { ...delivery, sequence: existing.sequence };
      if (hashCanonical(existing) !== hashCanonical(replay)) {
        throw new Error(`Inbox delivery ${input.deliveryId} changed during replay`);
      }
      return state;
    }
    const event = createNodeInboxDelivery(state, input);
    if (event.type !== "node.inbox.delivered") throw new Error("Unexpected inbox delivery event");
    this.deliveries.set(deliveryKey, event.item);
    return this.apply(state, event);
  }

  async requestWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly requestId: string;
    readonly requestedAt: number;
    readonly notBefore?: number;
  }): Promise<NodeWakeDecision> {
    const state = this.current(input.workspaceId, input.nodeId);
    const decision = requestNodeWake(state, input);
    if (decision.admitted) {
      const admitted = this.apply(state, decision.event);
      this.manifests.set(decision.event.wake.wakeId, createNodeContinuityManifest(admitted));
    }
    return decision;
  }

  async deliverAndRequestWake(input: Omit<NodeInboxItem, "sequence"> & {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wake: {
      readonly requestId: string;
      readonly requestedAt: number;
      readonly notBefore?: number;
    };
  }): Promise<{ readonly state: NodeContinuityState; readonly wake: NodeWakeDecision }> {
    const { wake, ...delivery } = input;
    await this.deliver(delivery);
    const decision = await this.requestWake({
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      ...wake,
    });
    return { state: this.current(input.workspaceId, input.nodeId), wake: decision };
  }

  async admitWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly admittedAt: number;
  }): Promise<NodeContinuityState> {
    return this.apply(this.current(input.workspaceId, input.nodeId), {
      type: "node.wake.admitted",
      wakeId: input.wakeId,
      occurredAt: input.admittedAt,
    });
  }

  async completeWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly consumedDeliveryIds: ReadonlyArray<string>;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    let state = this.apply(this.current(input.workspaceId, input.nodeId), {
      type: "node.wake.completed",
      wakeId: input.wakeId,
      consumedDeliveryIds: input.consumedDeliveryIds,
      occurredAt: input.occurredAt,
    });
    if (state.pendingInbox.length) {
      const decision = requestNodeWake(state, {
        requestId: nodeContinuationWakeRequestId(state),
        requestedAt: input.occurredAt,
      });
      if (decision.admitted) {
        state = this.apply(state, decision.event);
        this.manifests.set(decision.event.wake.wakeId, createNodeContinuityManifest(state));
      }
    }
    return state;
  }

  async failWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly occurredAt: number;
    readonly error: string;
  }): Promise<NodeContinuityState> {
    const state = this.apply(this.current(input.workspaceId, input.nodeId), {
      type: "node.wake.failed",
      wakeId: input.wakeId,
      occurredAt: input.occurredAt,
    });
    this.failedWakeIds.add(input.wakeId);
    return state;
  }

  async resolveFailedWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly resolution: "superseded";
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    if (!this.failedWakeIds.has(input.wakeId)) throw new Error(`Node wake ${input.wakeId} is not failed`);
    const manifest = this.manifests.get(input.wakeId);
    if (!manifest) throw new Error(`Node wake ${input.wakeId} has no retained manifest`);
    return this.apply(this.current(input.workspaceId, input.nodeId), {
      type: "node.wake.resolved",
      wakeId: input.wakeId,
      consumedDeliveryIds: manifest.wake.inboxDeliveryIds,
      resolution: input.resolution,
      occurredAt: input.occurredAt,
    });
  }

  async suspend(workspaceId: string, nodeId: string, occurredAt: number): Promise<NodeContinuityState> {
    return this.apply(this.current(workspaceId, nodeId), {
      type: "node.continuity.suspended",
      occurredAt,
    });
  }

  async resume(workspaceId: string, nodeId: string, occurredAt: number): Promise<NodeContinuityState> {
    return this.apply(this.current(workspaceId, nodeId), {
      type: "node.continuity.resumed",
      occurredAt,
    });
  }

  async changeCommitment(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly commitment: NodeCommitment;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    return this.apply(this.current(input.workspaceId, input.nodeId), {
      type: "node.commitment.changed",
      commitment: input.commitment,
      occurredAt: input.occurredAt,
    });
  }

  async updateMemoryFrontier(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly frontier: NodeMemoryFrontier;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    return this.apply(this.current(input.workspaceId, input.nodeId), {
      type: "node.memory.frontier.updated",
      frontier: input.frontier,
      occurredAt: input.occurredAt,
    });
  }

  async manifest(workspaceId: string, nodeId: string, wakeId: string): Promise<NodeContinuityManifest> {
    const state = this.current(workspaceId, nodeId);
    if (state.activeWake?.wakeId !== wakeId) throw new Error(`Node wake ${wakeId} is not active`);
    const manifest = this.manifests.get(wakeId);
    if (!manifest || manifest.workspaceId !== workspaceId || manifest.nodeId !== nodeId) {
      throw new Error(`Node wake ${wakeId} has no exact continuity manifest`);
    }
    return manifest;
  }

  async snapshot(workspaceId: string, nodeId: string): Promise<NodeContinuityState | undefined> {
    return this.states.get(continuityKey(workspaceId, nodeId));
  }
}

export type NodeInboxLaneProjection = {
  readonly laneId: string;
  readonly roomId?: string;
  readonly runId?: string;
  readonly pendingItemCount: number;
  readonly oldestDeliveredAt: number;
  readonly active: boolean;
};

export type NodeContinuitySummary = {
  readonly nodeId: string;
  readonly status: NodeContinuityStatus;
  readonly pendingItemCount: number;
  readonly pendingLaneCount: number;
  readonly activeCommitmentCount: number;
  readonly activeLaneId?: string;
  readonly activeRoomId?: string;
  readonly lastWakeAt?: number;
  readonly memoryUpdatedAt?: number;
  readonly lanes: ReadonlyArray<NodeInboxLaneProjection>;
};

/** Safe UI projection: scheduling metadata only, never payload pointers or private memory. */
export const projectNodeContinuitySummary = (state: NodeContinuityState): NodeContinuitySummary => {
  const laneMap = new Map<string, NodeInboxLaneProjection>();
  for (const item of state.pendingInbox) {
    const current = laneMap.get(item.scope.laneId);
    laneMap.set(item.scope.laneId, Object.freeze({
      laneId: item.scope.laneId,
      ...(item.scope.roomId ? { roomId: item.scope.roomId } : {}),
      ...(item.scope.runId ? { runId: item.scope.runId } : {}),
      pendingItemCount: (current?.pendingItemCount ?? 0) + 1,
      oldestDeliveredAt: current?.oldestDeliveredAt ?? item.deliveredAt,
      active: state.activeWake?.laneId === item.scope.laneId,
    }));
  }
  const lanes = [...laneMap.values()].sort((left, right) =>
    left.oldestDeliveredAt - right.oldestDeliveredAt || left.laneId.localeCompare(right.laneId));
  return Object.freeze({
    nodeId: state.nodeId,
    status: state.status,
    pendingItemCount: state.pendingInbox.length,
    pendingLaneCount: lanes.length,
    activeCommitmentCount: state.commitments.filter(({ status }) => status === "active" || status === "waiting").length,
    ...(state.activeWake ? {
      activeLaneId: state.activeWake.laneId,
      ...(state.activeWake.roomId ? { activeRoomId: state.activeWake.roomId } : {}),
    } : {}),
    ...(state.lastWakeAt !== undefined ? { lastWakeAt: state.lastWakeAt } : {}),
    ...(state.memoryFrontier ? { memoryUpdatedAt: state.memoryFrontier.updatedAt } : {}),
    lanes: Object.freeze(lanes),
  });
};
