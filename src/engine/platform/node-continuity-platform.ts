import type { DataReferenceStore } from "../dataflow/data-reference-store.js";
import type { WorkspaceNode } from "../orchestration/types.js";
import type { DataReference, DynamicTaskDefinition } from "./protocol.js";
import type { RosterPlatform } from "./roster-platform.js";
import {
  normalizeWorkspaceNodeContinuityPolicy,
  type NodeContinuityControl,
  type NodeContinuityManifest,
  type NodeContinuityState,
  type NodeInboxItem,
  type NodeWakeDecision,
} from "../workspace/node-continuity.js";

export type PreparedNodeWake = {
  readonly node: WorkspaceNode;
  readonly state: NodeContinuityState;
  readonly manifest: NodeContinuityManifest;
  readonly reference: DataReference;
};

export type RosterNodeContinuityPlatformOptions = {
  readonly workspaceId: string;
  readonly platform: Pick<RosterPlatform, "definition" | "registry">;
  readonly control: NodeContinuityControl;
  readonly dataReferences: DataReferenceStore;
};

/**
 * Framework-level bridge from durable node wakes into the ordinary Roster task
 * graph. Domains choose the bounded task semantics; this bridge owns identity,
 * exact continuity context, and replay durability.
 */
export class RosterNodeContinuityPlatform {
  constructor(private readonly options: RosterNodeContinuityPlatformOptions) {
    if (options.control.durability === "durable" && options.dataReferences.durability !== "durable") {
      throw new Error("Durable node continuity requires a durable DataReferenceStore");
    }
  }

  async registerWorkspaceNodes(input: {
    readonly occurredAt: number;
    readonly revisions?: Readonly<Record<string, number>>;
  }): Promise<ReadonlyArray<NodeContinuityState>> {
    const states: NodeContinuityState[] = [];
    for (const node of this.options.platform.definition.nodes) {
      const policy = normalizeWorkspaceNodeContinuityPolicy(node.continuity);
      if (policy.mode !== "workspace") continue;
      states.push(await this.options.control.register({
        workspaceId: this.options.workspaceId,
        node,
        nodeRevision: input.revisions?.[node.id] ?? 1,
        occurredAt: input.occurredAt,
      }));
    }
    return Object.freeze(states);
  }

  async deliver(input: Omit<NodeInboxItem, "sequence"> & {
    readonly nodeId: string;
    readonly wake?: {
      readonly requestId: string;
      readonly requestedAt: number;
      readonly notBefore?: number;
    };
  }): Promise<{ readonly state: NodeContinuityState; readonly wake?: NodeWakeDecision }> {
    const node = this.options.platform.registry.node(input.nodeId);
    const policy = normalizeWorkspaceNodeContinuityPolicy(node.continuity);
    if (policy.mode !== "workspace") throw new Error(`Node ${node.id} does not declare workspace continuity`);
    const delivery = {
      workspaceId: this.options.workspaceId,
      nodeId: node.id,
      deliveryId: input.deliveryId,
      cause: input.cause,
      scope: input.scope,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      sourceHash: input.sourceHash,
      ...(input.payloadReference ? { payloadReference: input.payloadReference } : {}),
      ...(input.causalParentId ? { causalParentId: input.causalParentId } : {}),
      causalDepth: input.causalDepth,
      deliveredAt: input.deliveredAt,
    };
    if (!input.wake) return { state: await this.options.control.deliver(delivery) };
    return this.options.control.deliverAndRequestWake({ ...delivery, wake: input.wake });
  }

  async prepareWake(nodeId: string): Promise<PreparedNodeWake> {
    const node = this.options.platform.registry.node(nodeId);
    const state = await this.requireState(nodeId);
    if (!state.activeWake) throw new Error(`Node continuity ${nodeId} has no active wake`);
    const manifest = await this.options.control.manifest(
      this.options.workspaceId,
      nodeId,
      state.activeWake.wakeId,
    );
    const reference = await this.options.dataReferences.put({
      value: manifest,
      mediaType: "application/vnd.roster.node-continuity+json",
      artifactId: manifest.manifestId,
      metadata: {
        schemaVersion: manifest.schemaVersion,
        workspaceId: manifest.workspaceId,
        nodeId: manifest.nodeId,
        wakeId: manifest.wake.wakeId,
        continuityRevision: manifest.continuityRevision,
      },
    });
    return Object.freeze({ node, state, manifest, reference });
  }

  /** Proves a domain wake task preserves the actual node and exact manifest. */
  assertWakeTask(prepared: PreparedNodeWake, definition: DynamicTaskDefinition): void {
    if (definition.nodeId !== prepared.node.id) {
      throw new Error(`Wake task ${definition.taskId} launders ${prepared.node.id} through ${definition.nodeId}`);
    }
    if (!definition.inputs.dataReferences.some((reference) =>
      reference.referenceId === prepared.reference.referenceId
      && reference.contentHash === prepared.reference.contentHash)) {
      throw new Error(`Wake task ${definition.taskId} does not bind its exact continuity manifest`);
    }
    if (!prepared.node.capabilities.includes(definition.capability)) {
      throw new Error(`Wake task ${definition.taskId} assigns unsupported capability ${definition.capability}`);
    }
  }

  private async requireState(nodeId: string): Promise<NodeContinuityState> {
    const state = await this.options.control.snapshot(this.options.workspaceId, nodeId);
    if (!state) throw new Error(`Node continuity ${nodeId} is not registered`);
    return state;
  }
}
