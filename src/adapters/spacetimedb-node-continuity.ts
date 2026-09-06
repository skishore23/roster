import { hashCanonical } from "../core/canonical.js";
import type { JsonValue, WorkspaceNode } from "../engine/orchestration/types.js";
import {
  NODE_CONTINUITY_SCHEMA_VERSION,
  normalizeWorkspaceNodeContinuityPolicy,
  type NodeCommitment,
  type NodeContinuityControl,
  type NodeContinuityManifest,
  type NodeContinuityState,
  type NodeContinuityStatus,
  type NodeInboxItem,
  type NodeMemoryFrontier,
  type NodeRegistrationRevision,
  type NodeWake,
  type NodeWakeDecision,
} from "../engine/workspace/node-continuity.js";
import { normalizeWorkspaceNode } from "../engine/workspace/node.js";
import type { SpacetimeControlPlane, SpacetimeSubscription } from "./spacetimedb-control.js";

const VALID_STATUSES = new Set<NodeContinuityStatus>([
  "dormant",
  "queued",
  "working",
  "waiting",
  "suspended",
]);

const safeNumber = (value: bigint, label: string): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} exceeds safe integer bounds`);
  return number;
};

const parseObject = <Value>(json: string, label: string): Value => {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Value;
};

export type SpacetimeNodeContinuityControlOptions = {
  readonly control: SpacetimeControlPlane;
  readonly workspaceId: string;
};

/** Production NodeContinuityControl backed by caller-scoped SpacetimeDB views and reducers. */
export class SpacetimeNodeContinuityControl implements NodeContinuityControl {
  readonly durability = "durable" as const;
  private subscription?: SpacetimeSubscription;

  constructor(private readonly options: SpacetimeNodeContinuityControlOptions) {}

  async initialize(): Promise<void> {
    if (this.subscription) return;
    this.subscription = this.options.control.subscribeRosterNodeContinuity(this.options.workspaceId);
    await this.subscription.ready;
  }

  close(): void {
    this.subscription?.close();
    this.subscription = undefined;
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.options.workspaceId) {
      throw new Error(`Node continuity control is scoped to ${this.options.workspaceId}`);
    }
  }

  async register(input: {
    readonly workspaceId: string;
    readonly node: WorkspaceNode;
    readonly nodeRevision: NodeRegistrationRevision;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    this.assertWorkspace(input.workspaceId);
    const node = normalizeWorkspaceNode(input.node);
    const policy = normalizeWorkspaceNodeContinuityPolicy(node.continuity);
    if (policy.mode !== "workspace") throw new Error(`Node ${node.id} does not declare workspace continuity`);
    const current = this.options.control.nodeContinuitySnapshot(input.workspaceId).nodes
      .find((candidate) => candidate.nodeId === node.id);
    const definitionMatches = current
      && hashCanonical(JSON.parse(current.nodeJson) as JsonValue) === hashCanonical(node as unknown as JsonValue)
      && hashCanonical(JSON.parse(current.continuityPolicyJson) as JsonValue)
        === hashCanonical(policy as unknown as JsonValue);
    if (input.nodeRevision === "next-on-change" && current && definitionMatches) {
      return this.requireSnapshot(input.workspaceId, node.id);
    }
    const nodeRevision = input.nodeRevision === "next-on-change"
      ? safeNumber((current?.nodeRevision ?? 0n) + 1n, "Workspace node revision")
      : input.nodeRevision;
    if (current?.nodeRevision === BigInt(nodeRevision)) {
      if (!definitionMatches) {
        throw new Error(`Workspace node ${node.id} changed without a node revision`);
      }
      return this.requireSnapshot(input.workspaceId, node.id);
    }
    await this.options.control.registerRosterWorkspaceNode({
      workspaceId: input.workspaceId,
      nodeId: node.id,
      nodeRevision: BigInt(nodeRevision),
      nodeJson: JSON.stringify(node),
      continuityPolicyJson: JSON.stringify(policy),
      expectedRevision: current?.nodeRevision ?? 0n,
    });
    return this.requireSnapshot(input.workspaceId, node.id);
  }

  async deliver(input: Omit<NodeInboxItem, "sequence"> & {
    readonly workspaceId: string;
    readonly nodeId: string;
  }): Promise<NodeContinuityState> {
    this.assertWorkspace(input.workspaceId);
    await this.options.control.deliverRosterNodeInbox({
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      deliveryId: input.deliveryId,
      cause: input.cause,
      laneId: input.scope.laneId,
      roomId: input.scope.roomId ?? "",
      runId: input.scope.runId ?? "",
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      sourceHash: input.sourceHash,
      payloadReference: input.payloadReference ?? "",
      causalParentId: input.causalParentId ?? "",
      causalDepth: input.causalDepth,
      deliveredAtMs: BigInt(input.deliveredAt),
      requestWake: false,
      wakeRequestId: "",
      notBeforeMs: 0n,
    });
    return this.requireSnapshot(input.workspaceId, input.nodeId);
  }

  async requestWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly requestId: string;
    readonly requestedAt: number;
    readonly notBefore?: number;
  }): Promise<NodeWakeDecision> {
    this.assertWorkspace(input.workspaceId);
    const before = await this.snapshot(input.workspaceId, input.nodeId);
    if (!before) throw new Error(`Node continuity ${input.nodeId} is not registered`);
    if (before.status === "suspended") return { admitted: false, reason: "suspended" };
    if (before.activeWake) return { admitted: false, reason: "already-active" };
    if (!before.pendingInbox.length) return { admitted: false, reason: "empty-inbox" };
    const windowExpired = input.requestedAt - before.wakeWindowStartedAt >= before.policy.wakeWindowMs;
    if (!windowExpired && before.wakesInWindow >= before.policy.maxWakesPerWindow) {
      return { admitted: false, reason: "budget" };
    }
    if (before.lastWakeAt !== undefined
      && input.notBefore === undefined
      && input.requestedAt - before.lastWakeAt < before.policy.minWakeIntervalMs) {
      return { admitted: false, reason: "cooldown" };
    }
    await this.options.control.requestRosterNodeWake({
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      requestId: input.requestId,
      notBeforeMs: BigInt(input.notBefore ?? input.requestedAt),
    });
    const state = await this.requireSnapshot(input.workspaceId, input.nodeId);
    if (!state.activeWake) throw new Error("SpacetimeDB accepted a wake without projecting it");
    return {
      admitted: true,
      event: {
        type: "node.wake.requested",
        wake: state.activeWake,
        occurredAt: state.activeWake.requestedAt,
      },
    };
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
    this.assertWorkspace(input.workspaceId);
    const before = await this.snapshot(input.workspaceId, input.nodeId);
    if (!before) throw new Error(`Node continuity ${input.nodeId} is not registered`);
    await this.options.control.deliverRosterNodeInbox({
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      deliveryId: input.deliveryId,
      cause: input.cause,
      laneId: input.scope.laneId,
      roomId: input.scope.roomId ?? "",
      runId: input.scope.runId ?? "",
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      sourceHash: input.sourceHash,
      payloadReference: input.payloadReference ?? "",
      causalParentId: input.causalParentId ?? "",
      causalDepth: input.causalDepth,
      deliveredAtMs: BigInt(input.deliveredAt),
      requestWake: true,
      wakeRequestId: input.wake.requestId,
      notBeforeMs: BigInt(input.wake.notBefore ?? input.wake.requestedAt),
    });
    const state = await this.requireSnapshot(input.workspaceId, input.nodeId);
    const admittedWake = state.activeWake?.inboxDeliveryIds.includes(input.deliveryId)
      ? state.activeWake
      : undefined;
    if (!admittedWake) {
      const windowExpired = input.wake.requestedAt - state.wakeWindowStartedAt >= state.policy.wakeWindowMs;
      return {
        state,
        wake: {
          admitted: false,
          reason: before.status === "suspended"
            ? "suspended"
            : before.activeWake ? "already-active"
              : !windowExpired && state.wakesInWindow >= state.policy.maxWakesPerWindow ? "budget"
                : "already-active",
        },
      };
    }
    return {
      state,
      wake: {
        admitted: true,
        event: {
          type: "node.wake.requested",
          wake: admittedWake,
          occurredAt: admittedWake.requestedAt,
        },
      },
    };
  }

  async admitWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly admittedAt: number;
    readonly lease?: { readonly workerId: string; readonly fence: string };
  }): Promise<NodeContinuityState> {
    this.assertWorkspace(input.workspaceId);
    if (!input.lease) throw new Error("Durable node wake admission requires its generic job lease fence");
    await this.options.control.admitRosterNodeWake({
      workspaceId: input.workspaceId,
      wakeId: input.wakeId,
      workerId: input.lease.workerId,
      fence: BigInt(input.lease.fence),
    });
    return this.requireSnapshot(input.workspaceId, input.nodeId);
  }

  async completeWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly consumedDeliveryIds: ReadonlyArray<string>;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    this.assertWorkspace(input.workspaceId);
    const current = await this.snapshot(input.workspaceId, input.nodeId);
    const wake = this.options.control.nodeContinuitySnapshot(input.workspaceId).wakes
      .find((candidate) => candidate.id === input.wakeId && candidate.nodeId === input.nodeId);
    if (current && (wake?.status === "completed" || (!current.activeWake && current.lastWakeId === input.wakeId))) {
      return current;
    }
    await this.options.control.completeRosterNodeWake({
      workspaceId: input.workspaceId,
      wakeId: input.wakeId,
      consumedDeliveryIdsJson: JSON.stringify(input.consumedDeliveryIds),
      resultJson: JSON.stringify({ acceptedAt: input.occurredAt }),
    });
    return this.requireSnapshot(input.workspaceId, input.nodeId);
  }

  async failWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly occurredAt: number;
    readonly error: string;
  }): Promise<NodeContinuityState> {
    this.assertWorkspace(input.workspaceId);
    const current = await this.snapshot(input.workspaceId, input.nodeId);
    const wake = this.options.control.nodeContinuitySnapshot(input.workspaceId).wakes
      .find((candidate) => candidate.id === input.wakeId && candidate.nodeId === input.nodeId);
    if (current && (wake?.status === "failed" || (!current.activeWake && current.lastWakeId === input.wakeId))) {
      return current;
    }
    await this.options.control.failRosterNodeWake({
      workspaceId: input.workspaceId,
      wakeId: input.wakeId,
      error: input.error,
    });
    return this.requireSnapshot(input.workspaceId, input.nodeId);
  }

  async resolveFailedWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly wakeId: string;
    readonly resolution: "superseded";
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    this.assertWorkspace(input.workspaceId);
    await this.options.control.resolveFailedRosterNodeWake({
      workspaceId: input.workspaceId,
      wakeId: input.wakeId,
      resolution: input.resolution,
    });
    return this.requireSnapshot(input.workspaceId, input.nodeId);
  }

  async suspend(workspaceId: string, nodeId: string, _occurredAt: number): Promise<NodeContinuityState> {
    this.assertWorkspace(workspaceId);
    await this.options.control.suspendRosterNodeContinuity(workspaceId, nodeId);
    return this.requireSnapshot(workspaceId, nodeId);
  }

  async resume(workspaceId: string, nodeId: string, _occurredAt: number): Promise<NodeContinuityState> {
    this.assertWorkspace(workspaceId);
    await this.options.control.resumeRosterNodeContinuity(workspaceId, nodeId);
    return this.requireSnapshot(workspaceId, nodeId);
  }

  async changeCommitment(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly commitment: NodeCommitment;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    this.assertWorkspace(input.workspaceId);
    await this.options.control.changeRosterNodeCommitment({
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      commitmentId: input.commitment.commitmentId,
      objective: input.commitment.objective,
      status: input.commitment.status,
      revision: BigInt(input.commitment.revision),
      sourceId: input.commitment.sourceId,
      updatedAtMs: BigInt(input.commitment.updatedAt),
    });
    return this.requireSnapshot(input.workspaceId, input.nodeId);
  }

  async updateMemoryFrontier(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly frontier: NodeMemoryFrontier;
    readonly occurredAt: number;
  }): Promise<NodeContinuityState> {
    this.assertWorkspace(input.workspaceId);
    await this.options.control.updateRosterNodeMemoryFrontier({
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      scopeId: input.frontier.scopeId,
      snapshotVersion: input.frontier.snapshotVersion,
    });
    return this.requireSnapshot(input.workspaceId, input.nodeId);
  }

  async manifest(workspaceId: string, nodeId: string, wakeId: string) {
    this.assertWorkspace(workspaceId);
    const wake = this.options.control.nodeContinuitySnapshot(workspaceId).wakes
      .find((candidate) => candidate.id === wakeId && candidate.nodeId === nodeId);
    if (!wake) throw new Error(`Node wake ${wakeId} is not projected`);
    return parseObject<NodeContinuityManifest>(
      wake.manifestJson,
      `node wake ${wakeId} manifest`,
    );
  }

  async snapshot(workspaceId: string, nodeId: string): Promise<NodeContinuityState | undefined> {
    this.assertWorkspace(workspaceId);
    const snapshot = this.options.control.nodeContinuitySnapshot(workspaceId);
    const node = snapshot.nodes.find((candidate) => candidate.nodeId === nodeId);
    const continuity = snapshot.continuities.find((candidate) => candidate.nodeId === nodeId);
    if (!node || !continuity) return undefined;
    if (!VALID_STATUSES.has(continuity.status as NodeContinuityStatus)) {
      throw new Error(`Unknown node continuity status ${continuity.status}`);
    }
    const pendingInbox = snapshot.inboxItems
      .filter((item) => item.nodeId === nodeId && item.status !== "consumed")
      .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0)
      .map((item) => parseObject<NodeInboxItem>(item.itemJson, `node inbox item ${item.deliveryId}`));
    const commitments = snapshot.commitments
      .filter((commitment) => commitment.nodeId === nodeId)
      .sort((left, right) => left.commitmentId.localeCompare(right.commitmentId))
      .map((commitment): NodeCommitment => ({
        commitmentId: commitment.commitmentId,
        objective: commitment.objective,
        status: commitment.status as NodeCommitment["status"],
        revision: safeNumber(commitment.revision, "Node commitment revision"),
        sourceId: commitment.sourceId,
        updatedAt: safeNumber(commitment.updatedAtMs, "Node commitment updatedAt"),
      }));
    const activeWakeRow = continuity.activeWakeId
      ? snapshot.wakes.find((wake) => wake.id === continuity.activeWakeId)
      : undefined;
    const activeWake = activeWakeRow
      ? parseObject<{ readonly wake: NodeWake }>(activeWakeRow.manifestJson, `node wake ${activeWakeRow.id} manifest`).wake
      : undefined;
    return Object.freeze({
      schemaVersion: NODE_CONTINUITY_SCHEMA_VERSION,
      workspaceId,
      nodeId,
      nodeRevision: safeNumber(node.nodeRevision, "Workspace node revision"),
      policy: normalizeWorkspaceNodeContinuityPolicy(JSON.parse(node.continuityPolicyJson)),
      status: continuity.status as NodeContinuityStatus,
      revision: safeNumber(continuity.revision, "Node continuity revision"),
      nextInboxSequence: safeNumber(continuity.nextInboxSeq + 1n, "Node inbox sequence"),
      pendingInbox: Object.freeze(pendingInbox),
      commitments: Object.freeze(commitments),
      ...(continuity.memoryScopeId && continuity.memorySnapshotVersion ? {
        memoryFrontier: Object.freeze({
          scopeId: continuity.memoryScopeId,
          snapshotVersion: continuity.memorySnapshotVersion,
          updatedAt: Number(continuity.updatedAt.microsSinceUnixEpoch / 1_000n),
        }),
      } : {}),
      ...(activeWake ? { activeWake: Object.freeze(activeWake) } : {}),
      ...(continuity.lastWakeId ? { lastWakeId: continuity.lastWakeId } : {}),
      ...(continuity.lastWakeAtMs > 0n
        ? { lastWakeAt: safeNumber(continuity.lastWakeAtMs, "Node lastWakeAt") }
        : {}),
      wakeWindowStartedAt: safeNumber(continuity.wakeWindowStartedAtMs, "Node wake window"),
      wakesInWindow: continuity.wakesInWindow,
      updatedAt: Number(continuity.updatedAt.microsSinceUnixEpoch / 1_000n),
    });
  }

  private async requireSnapshot(workspaceId: string, nodeId: string): Promise<NodeContinuityState> {
    const state = await this.snapshot(workspaceId, nodeId);
    if (!state) throw new Error(`SpacetimeDB did not project node continuity ${nodeId}`);
    return state;
  }
}
