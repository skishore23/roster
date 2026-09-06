import { hashCanonical } from "../../core/canonical.js";
import type { DynamicTaskHandlerContext } from "../orchestration/task-graph.js";
import { taskGraphTask, type TaskGraphControl } from "../orchestration/task-graph-control.js";
import type { WorkspaceNode } from "../orchestration/types.js";
import type { DynamicTaskDefinition } from "../platform/protocol.js";
import type { RosterTaskContextFactory } from "../platform/roster-platform.js";
import {
  SharedWorkspaceLedger,
  selectWorkspaceProjection,
  type RosterTaskContext,
  type TaskWorkspaceAuthority,
  type TaskWorkspaceFence,
} from "./shared-workspace.js";

export type SpacetimeSharedWorkspaceSubscription = {
  readonly ready: Promise<void>;
  readonly close: () => void;
};

export type SpacetimeSharedWorkspaceControl = {
  readonly subscribeRosterRoomState: (
    workspaceId: string,
    roomId: string,
    runId: string,
    onChange?: () => void,
  ) => SpacetimeSharedWorkspaceSubscription;
  readonly roomSnapshot: (
    workspaceId: string,
    roomId: string,
    runId?: string,
  ) => {
    readonly sharedWorkspaceUpdates: ReadonlyArray<{
      readonly updateId: string;
      readonly artifactId: string;
      readonly updateBase64: string;
      readonly createdAt: { readonly microsSinceUnixEpoch: bigint };
    }>;
    readonly sharedWorkspaceCheckpoints: ReadonlyArray<{
      readonly checkpointId: string;
      readonly artifactId: string;
      readonly stateBase64: string;
      readonly createdAt: { readonly microsSinceUnixEpoch: bigint };
    }>;
  };
  readonly publishRosterSharedWorkspaceUpdate: (input: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly runId: string;
    readonly artifactId: string;
    readonly updateId: string;
    readonly taskId: string;
    readonly nodeId: string;
    readonly fence: bigint;
    readonly frontierVersion: string;
    readonly topologyVersion: string;
    readonly catalogVersion: string;
    readonly runtimeBindingEpoch: bigint;
    readonly updateBase64: string;
  }) => Promise<void>;
  readonly checkpointRosterSharedWorkspace: (input: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly runId: string;
    readonly artifactId: string;
    readonly checkpointId: string;
    readonly throughUpdateId: string;
    readonly frontierVersion: string;
    readonly topologyVersion: string;
    readonly stateBase64: string;
  }) => Promise<void>;
};

const bytesFromBase64 = (value: string): Uint8Array => Buffer.from(value, "base64");
const base64FromBytes = (value: Uint8Array): string => Buffer.from(value).toString("base64");

/**
 * Production shared-workspace store. SpacetimeDB admits each fenced delta
 * before it enters the canonical local ledger; subscriptions replay accepted
 * checkpoints and updates after process restart.
 */
export class SpacetimeSharedWorkspace {
  readonly durability = "durable" as const;
  readonly artifactId: string;

  private ledger?: SharedWorkspaceLedger;
  private subscription?: SpacetimeSharedWorkspaceSubscription;
  private initializePromise?: Promise<void>;
  private readonly appliedUpdateIds = new Set<string>();

  constructor(private readonly options: {
    readonly control: SpacetimeSharedWorkspaceControl;
    readonly workspaceId: string;
    readonly roomId: string;
    readonly runId: string;
    readonly artifactId?: string;
  }) {
    this.artifactId = options.artifactId?.trim()
      || `workspace_${hashCanonical(`${options.workspaceId}:${options.roomId}:${options.runId}`).slice(0, 28)}`;
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        this.subscription = this.options.control.subscribeRosterRoomState(
          this.options.workspaceId,
          this.options.roomId,
          this.options.runId,
          () => this.reconcileAcceptedUpdates(),
        );
        await this.subscription.ready;
        const snapshot = this.options.control.roomSnapshot(
          this.options.workspaceId,
          this.options.roomId,
          this.options.runId,
        );
        const checkpoint = snapshot.sharedWorkspaceCheckpoints
          .filter((row) => row.artifactId === this.artifactId)
          .sort((left, right) =>
            left.createdAt.microsSinceUnixEpoch > right.createdAt.microsSinceUnixEpoch ? -1 : 1
          )[0];
        this.ledger = new SharedWorkspaceLedger(
          this.artifactId,
          checkpoint ? bytesFromBase64(checkpoint.stateBase64) : undefined,
        );
        this.reconcileAcceptedUpdates();
      })().catch((error: unknown) => {
        this.subscription?.close();
        this.subscription = undefined;
        this.initializePromise = undefined;
        throw error;
      });
    }
    await this.initializePromise;
  }

  async createTaskContext(input: {
    readonly node: WorkspaceNode;
    readonly fence: TaskWorkspaceFence;
    readonly authority: TaskWorkspaceAuthority;
  }): Promise<RosterTaskContext> {
    await this.initialize();
    const workspace = this;
    return {
      node: input.node,
      fence: input.fence,
      readWorkspace: async (selector) => {
        await input.authority.assertActive("read", input.fence);
        workspace.reconcileAcceptedUpdates();
        return selectWorkspaceProjection(workspace.requireLedger().project({
          frontierVersion: input.fence.frontierVersion,
          topologyVersion: input.fence.topologyVersion,
        }), selector);
      },
      publish: async (entry) => {
        await input.authority.assertActive("publish", input.fence);
        workspace.reconcileAcceptedUpdates();
        const staging = new SharedWorkspaceLedger(
          workspace.artifactId,
          workspace.requireLedger().encode(),
        );
        try {
          const published = staging.publish({
            runId: input.fence.runId,
            taskId: input.fence.taskId,
            nodeId: input.node.id,
            frontierVersion: input.fence.frontierVersion,
            topologyVersion: input.fence.topologyVersion,
            inputVersions: {
              ...input.fence.inputVersions,
              "platform:catalog": input.fence.catalogVersion,
              "platform:runtime-binding-epoch": String(input.fence.runtimeBindingEpoch),
            },
            entry,
          });
          await workspace.options.control.publishRosterSharedWorkspaceUpdate({
            workspaceId: workspace.options.workspaceId,
            roomId: workspace.options.roomId,
            runId: workspace.options.runId,
            artifactId: workspace.artifactId,
            updateId: published.updateId,
            taskId: input.fence.taskId,
            nodeId: input.node.id,
            fence: input.fence.fence,
            frontierVersion: input.fence.frontierVersion,
            topologyVersion: input.fence.topologyVersion,
            catalogVersion: input.fence.catalogVersion,
            runtimeBindingEpoch: BigInt(input.fence.runtimeBindingEpoch),
            updateBase64: base64FromBytes(published.update),
          });
          workspace.requireLedger().apply(published.update);
          workspace.appliedUpdateIds.add(published.updateId);
          return published;
        } finally {
          staging.destroy();
        }
      },
    };
  }

  async checkpoint(input: {
    readonly checkpointId: string;
    readonly throughUpdateId: string;
    readonly frontierVersion: string;
    readonly topologyVersion: string;
  }): Promise<void> {
    await this.initialize();
    await this.options.control.checkpointRosterSharedWorkspace({
      workspaceId: this.options.workspaceId,
      roomId: this.options.roomId,
      runId: this.options.runId,
      artifactId: this.artifactId,
      ...input,
      stateBase64: base64FromBytes(this.requireLedger().encode()),
    });
  }

  close(): void {
    this.subscription?.close();
    this.subscription = undefined;
    this.ledger?.destroy();
    this.ledger = undefined;
    this.initializePromise = undefined;
    this.appliedUpdateIds.clear();
  }

  private requireLedger(): SharedWorkspaceLedger {
    if (!this.ledger) throw new Error("Spacetime shared workspace is not initialized");
    return this.ledger;
  }

  private reconcileAcceptedUpdates(): void {
    if (!this.ledger) return;
    const snapshot = this.options.control.roomSnapshot(
      this.options.workspaceId,
      this.options.roomId,
      this.options.runId,
    );
    const updates = snapshot.sharedWorkspaceUpdates
      .filter((row) => row.artifactId === this.artifactId)
      .sort((left, right) =>
        left.createdAt.microsSinceUnixEpoch < right.createdAt.microsSinceUnixEpoch ? -1 : 1
      );
    for (const update of updates) {
      if (this.appliedUpdateIds.has(update.updateId)) continue;
      this.ledger.apply(bytesFromBase64(update.updateBase64));
      this.appliedUpdateIds.add(update.updateId);
    }
  }
}

export const createSpacetimeTaskGraphWorkspaceContextFactory = (input: {
  readonly taskGraph: TaskGraphControl;
  readonly workspace: SpacetimeSharedWorkspace;
}): RosterTaskContextFactory =>
  Object.assign(async ({ runId, node, definition, lease }: {
    readonly runId: string;
    readonly node: WorkspaceNode;
    readonly definition: DynamicTaskDefinition;
    readonly lease: DynamicTaskHandlerContext["lease"];
  }) => input.workspace.createTaskContext({
    node,
    fence: {
      runId,
      taskId: definition.taskId,
      nodeId: node.id,
      fence: BigInt(lease.fence),
      frontierVersion: definition.inputs.frontierVersion,
      topologyVersion: definition.inputs.topologyVersion,
      catalogVersion: definition.inputs.catalogVersion,
      runtimeBindingEpoch: definition.runtimeBindingEpoch,
      inputVersions: definition.inputs.inputVersions,
    },
    authority: {
      assertActive: async () => {
        const record = taskGraphTask(await input.taskGraph.snapshot(), definition.taskId);
        if (
          !record
          || (record.status !== "leased" && record.status !== "running")
          || (record.leaseOwner !== undefined && record.leaseOwner !== lease.owner)
          || record.leaseFence !== lease.fence
        ) {
          throw new Error(`Roster task ${definition.taskId} no longer owns its shared-workspace fence`);
        }
      },
    },
  }), { durability: input.workspace.durability });
