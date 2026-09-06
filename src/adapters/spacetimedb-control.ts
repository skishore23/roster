import fs from "node:fs";
import path from "node:path";

import type { Identity } from "spacetimedb";
import type {
  AcceptedTaskOutcome,
  DataReference,
  DynamicTaskDefinition,
  RunExecutionPolicy,
} from "../engine/platform/protocol.js";
import type { TaskContextManifest } from "../engine/platform/task-context-manifest.js";
import type {
  JsonValue,
  NodeExecutionUsage,
  WorkspaceNode,
  WorkspaceNodeRuntimeBinding,
} from "../engine/orchestration/types.js";

import {
  DbConnection,
  type SubscriptionHandle,
} from "../spacetimedb-bindings/index.js";
import type {
  CanvasActivityProjection,
  CanvasAgentProjection,
  CanvasFleetRunProjection,
  CanvasRunProjection,
  CanvasRunUiProjection,
  CanvasTaskStatusProjection,
  CodingRoomProjection,
  EventStreamProjection,
  RosterJobCommandProjection,
  RosterJobEventProjection,
  RosterJobProjection,
  RosterJobRequestProjection,
  RosterContextFrontierProjection,
  RosterExecutionSummaryProjection,
  RosterModelReservation,
  RosterNodeCommitment,
  RosterNodeContinuity,
  RosterNodeContinuityEvent,
  RosterNodeInboxItem,
  RosterNodeWake,
  RosterProjectionOutbox,
  RosterParticipantProfileProjection,
  RosterRoom,
  RosterRoomControlIntent,
  RosterRoomNodeProjection,
  RosterRoomTimelineEntry,
  RosterRuntimeBinding,
  RosterSharedWorkspaceCheckpoint,
  RosterSharedWorkspaceUpdate,
  RosterTaskContextManifest,
  RosterTaskEdge,
  RosterTaskExpansion,
  RosterTaskOutcome,
  RosterTaskOutputReference,
  RosterTaskProjection,
  RosterWorkspaceNode,
  ReceiptProjection,
  RunMemberProjection,
  SceneObjectProjection,
  ScenePatchProjection,
  ScenePlanPartProjection,
  ScenePlanProjection,
  SceneReviewProjection,
  StreamBranchProjection,
  StreamReceiptProjection,
  WorkspaceProjection,
  WorkspaceUsageProjection,
} from "../spacetimedb-bindings/types.js";

const DEFAULT_URI = "http://127.0.0.1:3000";
const DEFAULT_DATABASE = "roster-local";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_PATH = path.join(process.cwd(), ".spacetime", "canvas-service.token");

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export type SpacetimeControlConfig = {
  readonly uri: string;
  readonly database: string;
  readonly token?: string;
  /** Local service identity persistence. Ignored when an explicit token is supplied. */
  readonly tokenPath?: string;
  readonly connectTimeoutMs: number;
  /** Ask the server to acknowledge only durable reads. This trades latency for stronger recovery semantics. */
  readonly confirmedReads: boolean;
};

const publicSpacetimeEndpoint = (uri: string): string => {
  try {
    const parsed = new URL(uri);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "<configured endpoint>";
  }
};

export const spacetimeStartupFailure = (
  config: Pick<SpacetimeControlConfig, "uri" | "database">,
  error: unknown,
): Error => {
  const detail = error instanceof Error ? error.message : String(error);
  const identityRecovery = detail.includes("belongs to another identity")
    ? " Restore the service identity token used when this workspace was created, or select a new ROSTER_WORKSPACE_ID. Roster will not take over or delete another identity's workspace."
    : "";
  return new Error(
    `SpacetimeDB startup validation failed for database '${config.database}' at ${publicSpacetimeEndpoint(config.uri)}. `
    + "Confirm SPACETIMEDB_DATABASE selects the intended database and publish the current Roster module before restarting. "
    + `Cause: ${detail}.${identityRecovery}`,
    { cause: error },
  );
};

export const spacetimeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SPACETIMEDB_ENABLED !== "0";

const readServiceToken = (tokenPath: string): string | undefined => {
  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    return token || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const resolveSpacetimeControlConfig = (
  env: NodeJS.ProcessEnv = process.env
): SpacetimeControlConfig => {
  const explicitToken = env.SPACETIMEDB_TOKEN?.trim() || undefined;
  const tokenPath = env.SPACETIMEDB_TOKEN_PATH?.trim() || DEFAULT_TOKEN_PATH;
  return {
    uri: env.SPACETIMEDB_URI?.trim() || DEFAULT_URI,
    database: env.SPACETIMEDB_DATABASE?.trim() || DEFAULT_DATABASE,
    token: explicitToken ?? readServiceToken(tokenPath),
    tokenPath: explicitToken ? undefined : tokenPath,
    connectTimeoutMs: boundedInteger(
      env.SPACETIMEDB_CONNECT_TIMEOUT_MS,
      DEFAULT_CONNECT_TIMEOUT_MS,
      1_000,
      60_000
    ),
    confirmedReads: env.SPACETIMEDB_CONFIRMED_READS === "1",
  };
};

export type SpacetimeConnectionIdentity = {
  readonly identity: Identity;
  /** Returned for anonymous local connections. Treat it as a secret and persist it only in a secret store. */
  readonly token: string;
};

export type SpacetimeCanvasSnapshot = {
  readonly runs: ReadonlyArray<CanvasRunProjection>;
  /** Workspace links visible to this identity; use these to scope dispatch. */
  readonly fleetRuns: ReadonlyArray<CanvasFleetRunProjection>;
  readonly runUi: ReadonlyArray<CanvasRunUiProjection>;
  readonly members: ReadonlyArray<RunMemberProjection>;
  readonly tasks: ReadonlyArray<RosterTaskProjection>;
  readonly canvasTasks: ReadonlyArray<CanvasTaskStatusProjection>;
  readonly claimableTasks: ReadonlyArray<RosterTaskProjection>;
  readonly receipts: ReadonlyArray<ReceiptProjection>;
  readonly patches: ReadonlyArray<ScenePatchProjection>;
  readonly plans: ReadonlyArray<ScenePlanProjection>;
  readonly planParts: ReadonlyArray<ScenePlanPartProjection>;
  readonly agents: ReadonlyArray<CanvasAgentProjection>;
  readonly objects: ReadonlyArray<SceneObjectProjection>;
  readonly reviews: ReadonlyArray<SceneReviewProjection>;
  readonly activity: ReadonlyArray<CanvasActivityProjection>;
};

export type SpacetimeRosterSnapshot = {
  readonly executions: ReadonlyArray<RosterExecutionSummaryProjection>;
  readonly tasks: ReadonlyArray<RosterTaskProjection>;
  readonly claimableTasks: ReadonlyArray<RosterTaskProjection>;
  readonly outcomes: ReadonlyArray<RosterTaskOutcome>;
  readonly expansions: ReadonlyArray<RosterTaskExpansion>;
  readonly outputReferences: ReadonlyArray<RosterTaskOutputReference>;
  readonly runtimeBindings: ReadonlyArray<RosterRuntimeBinding>;
  readonly modelReservations: ReadonlyArray<RosterModelReservation>;
};

export type SpacetimeRoomSnapshot = {
  readonly rooms: ReadonlyArray<RosterRoom>;
  readonly nodes: ReadonlyArray<RosterRoomNodeProjection>;
  readonly timeline: ReadonlyArray<RosterRoomTimelineEntry>;
  readonly controlIntents: ReadonlyArray<RosterRoomControlIntent>;
  readonly contextFrontiers: ReadonlyArray<RosterContextFrontierProjection>;
  readonly executions: ReadonlyArray<RosterExecutionSummaryProjection>;
  readonly edges: ReadonlyArray<RosterTaskEdge>;
  readonly outcomes: ReadonlyArray<RosterTaskOutcome>;
  readonly expansions: ReadonlyArray<RosterTaskExpansion>;
  readonly outputReferences: ReadonlyArray<RosterTaskOutputReference>;
  readonly runtimeBindings: ReadonlyArray<RosterRuntimeBinding>;
  readonly contextManifests: ReadonlyArray<RosterTaskContextManifest>;
  readonly modelReservations: ReadonlyArray<RosterModelReservation>;
  readonly projectionOutbox: ReadonlyArray<RosterProjectionOutbox>;
  readonly sharedWorkspaceUpdates: ReadonlyArray<RosterSharedWorkspaceUpdate>;
  readonly sharedWorkspaceCheckpoints: ReadonlyArray<RosterSharedWorkspaceCheckpoint>;
};

export type RosterExecutionRoomInitialization = {
  readonly workspaceId: string;
  readonly runId: string;
  readonly receiptStreamId?: string;
  readonly policy: RunExecutionPolicy;
  readonly room: {
    readonly id: string;
    readonly roomKey: string;
    readonly kind: string;
    readonly title: string;
  };
  readonly nodes: ReadonlyArray<WorkspaceNode>;
  readonly runtimeBindings: ReadonlyArray<WorkspaceNodeRuntimeBinding>;
  readonly seedTasks: ReadonlyArray<DynamicTaskDefinition>;
  readonly initialContextFrontier: {
    readonly contextVersion: string;
    readonly frontierVersion: string;
    readonly topologyVersion: string;
    readonly catalogVersion: string;
    readonly bindingVersion: string;
    readonly [key: string]: JsonValue;
  };
  readonly idempotencyKey: string;
};

export type SpacetimeWorkspaceSnapshot = {
  readonly workspaces: ReadonlyArray<WorkspaceProjection>;
  readonly usage: ReadonlyArray<WorkspaceUsageProjection>;
  readonly streams: ReadonlyArray<EventStreamProjection>;
  readonly receipts: ReadonlyArray<StreamReceiptProjection>;
  readonly branches: ReadonlyArray<StreamBranchProjection>;
  readonly codingRooms: ReadonlyArray<CodingRoomProjection>;
  readonly participantProfiles: ReadonlyArray<RosterParticipantProfileProjection>;
};

export type SpacetimeJobSnapshot = {
  readonly jobs: ReadonlyArray<RosterJobProjection>;
  readonly commands: ReadonlyArray<RosterJobCommandProjection>;
  readonly events: ReadonlyArray<RosterJobEventProjection>;
  readonly requests: ReadonlyArray<RosterJobRequestProjection>;
};

export type SpacetimeNodeContinuitySnapshot = {
  readonly nodes: ReadonlyArray<RosterWorkspaceNode>;
  readonly continuities: ReadonlyArray<RosterNodeContinuity>;
  readonly inboxItems: ReadonlyArray<RosterNodeInboxItem>;
  readonly wakes: ReadonlyArray<RosterNodeWake>;
  readonly commitments: ReadonlyArray<RosterNodeCommitment>;
  readonly events: ReadonlyArray<RosterNodeContinuityEvent>;
};

export type SpacetimeSubscription = {
  readonly ready: Promise<void>;
  readonly close: () => void;
};

export class SpacetimeControlPlane {
  private intentionalDisconnect = false;
  private readonly disconnectListeners = new Set<(error?: Error) => void>();

  private constructor(
    readonly connection: DbConnection,
    readonly auth: SpacetimeConnectionIdentity,
    readonly config: SpacetimeControlConfig
  ) {}

  static async connect(config: SpacetimeControlConfig): Promise<SpacetimeControlPlane> {
    let connection: DbConnection | undefined;
    let controlPlane: SpacetimeControlPlane | undefined;
    const connected = new Promise<SpacetimeConnectionIdentity>((resolve, reject) => {
      const builder = DbConnection.builder()
        .withUri(config.uri)
        .withDatabaseName(config.database)
        .withToken(config.token)
        .withConfirmedReads(config.confirmedReads)
        .onConnect((_connection, identity, token) => resolve({ identity, token }))
        .onConnectError((_ctx, error) => reject(error))
        .onDisconnect((_ctx, error) => controlPlane?.notifyDisconnect(error));
      connection = builder.build();
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      const auth = await Promise.race([
        connected,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`SpacetimeDB connection timed out after ${config.connectTimeoutMs}ms`)),
            config.connectTimeoutMs
          );
        }),
      ]);
      if (!connection) throw new Error("SpacetimeDB connection was not created");
      if (!config.token && config.tokenPath) {
        await fs.promises.mkdir(path.dirname(config.tokenPath), { recursive: true, mode: 0o700 });
        try {
          await fs.promises.writeFile(config.tokenPath, `${auth.token}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const winner = (await fs.promises.readFile(config.tokenPath, "utf8")).trim();
          if (winner !== auth.token) {
            throw new Error("Another process created a different SpacetimeDB service identity; restart with the persisted token");
          }
        }
      }
      controlPlane = new SpacetimeControlPlane(connection, auth, config);
      return controlPlane;
    } catch (error) {
      connection?.disconnect();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.connection.disconnect();
  }

  onDisconnect(listener: (error?: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private notifyDisconnect(error?: Error): void {
    if (this.intentionalDisconnect) return;
    for (const listener of this.disconnectListeners) listener(error);
  }

  subscribeToMyCanvasState(onChange?: () => void): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const notify = () => onChange?.();
    const observedTables = [
      this.connection.db.myCanvasRuns,
      this.connection.db.myCanvasFleetRuns,
      this.connection.db.myCanvasRunUi,
      this.connection.db.myRunMembers,
      this.connection.db.myRosterTasks,
      this.connection.db.myCanvasTaskStatuses,
      this.connection.db.myClaimableRosterTasks,
      this.connection.db.myReceipts,
      this.connection.db.myScenePatches,
      this.connection.db.myScenePlan,
      this.connection.db.myScenePlanParts,
      this.connection.db.myCanvasAgents,
      this.connection.db.mySceneObjects,
      this.connection.db.mySceneReviews,
      this.connection.db.myCanvasActivity,
    ] as const;
    for (const table of observedTables) {
      table.onInsert(notify);
      table.onUpdate(notify);
      table.onDelete(notify);
    }

    const handle: SubscriptionHandle = this.connection
      .subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError(() => rejectReady?.(new Error("SpacetimeDB Canvas subscription failed")))
      .subscribe([
        "SELECT * FROM my_canvas_runs",
        "SELECT * FROM my_canvas_fleet_runs",
        "SELECT * FROM my_canvas_run_ui",
        "SELECT * FROM my_run_members",
        "SELECT * FROM my_roster_tasks",
        "SELECT * FROM my_canvas_task_statuses",
        "SELECT * FROM my_claimable_roster_tasks",
        "SELECT * FROM my_receipts",
        "SELECT * FROM my_scene_patches",
        "SELECT * FROM my_scene_plan",
        "SELECT * FROM my_scene_plan_parts",
        "SELECT * FROM my_canvas_agents",
        "SELECT * FROM my_scene_objects",
        "SELECT * FROM my_scene_reviews",
        "SELECT * FROM my_canvas_activity",
      ]);

    return {
      ready,
      close: () => {
        for (const table of observedTables) {
          table.removeOnInsert(notify);
          table.removeOnUpdate(notify);
          table.removeOnDelete(notify);
        }
        handle.unsubscribe();
      },
    };
  }

  /**
   * Subscribe only to one Canvas run. This is the production runtime path: it
   * avoids multiplying a coordinator's cache by every run that identity can
   * access while retaining the complete, ordered receipt stream.
   */
  subscribeCanvasRun(runId: string, onChange?: () => void): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const notify = () => onChange?.();
    const observedTables = [
      this.connection.db.myCanvasRuns,
      this.connection.db.myCanvasRunUi,
      this.connection.db.myRunMembers,
      this.connection.db.myRosterTasks,
      this.connection.db.myCanvasTaskStatuses,
      this.connection.db.myClaimableRosterTasks,
      this.connection.db.myReceipts,
      this.connection.db.myScenePatches,
      this.connection.db.myScenePlan,
      this.connection.db.myScenePlanParts,
      this.connection.db.myCanvasAgents,
      this.connection.db.mySceneObjects,
      this.connection.db.mySceneReviews,
      this.connection.db.myCanvasActivity,
    ] as const;
    for (const table of observedTables) {
      table.onInsert(notify);
      table.onUpdate(notify);
      table.onDelete(notify);
    }

    const literal = `'${runId.replaceAll("'", "''")}'`;
    const handle: SubscriptionHandle = this.connection
      .subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError(() => rejectReady?.(new Error("SpacetimeDB Canvas run subscription failed")))
      .subscribe([
        `SELECT * FROM my_canvas_runs WHERE id = ${literal}`,
        `SELECT * FROM my_canvas_run_ui WHERE id = ${literal}`,
        `SELECT * FROM my_run_members WHERE run_id = ${literal}`,
        `SELECT * FROM my_roster_tasks WHERE run_id = ${literal}`,
        `SELECT * FROM my_canvas_task_statuses WHERE run_id = ${literal}`,
        `SELECT * FROM my_claimable_roster_tasks WHERE run_id = ${literal}`,
        `SELECT * FROM my_receipts WHERE run_id = ${literal}`,
        `SELECT * FROM my_scene_patches WHERE run_id = ${literal}`,
        `SELECT * FROM my_scene_plan WHERE run_id = ${literal}`,
        `SELECT * FROM my_scene_plan_parts WHERE run_id = ${literal}`,
        `SELECT * FROM my_canvas_agents WHERE run_id = ${literal}`,
        `SELECT * FROM my_scene_objects WHERE run_id = ${literal}`,
        `SELECT * FROM my_scene_reviews WHERE run_id = ${literal}`,
        `SELECT * FROM my_canvas_activity WHERE run_id = ${literal}`,
      ]);

    return {
      ready,
      close: () => {
        for (const table of observedTables) {
          table.removeOnInsert(notify);
          table.removeOnUpdate(notify);
          table.removeOnDelete(notify);
        }
        handle.unsubscribe();
      },
    };
  }

  /** Subscribe to the provider-neutral durable task graph for one execution. */
  subscribeRosterExecution(runId: string, onChange?: () => void): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const notify = () => onChange?.();
    const observedTables = [
      this.connection.db.myRosterTasks,
      this.connection.db.myClaimableRosterTasks,
      this.connection.db.myRosterWorkerCapabilities,
      this.connection.db.myRosterExecutionSummaries,
      this.connection.db.myRosterTaskOutcomes,
      this.connection.db.myRosterTaskExpansions,
      this.connection.db.myRosterTaskOutputReferences,
       this.connection.db.myRosterRuntimeBindings,
       this.connection.db.myRosterModelReservations,
     ] as const;
    for (const table of observedTables) {
      table.onInsert(notify);
      table.onUpdate(notify);
      table.onDelete(notify);
    }
    const literal = `'${runId.replaceAll("'", "''")}'`;
    const handle: SubscriptionHandle = this.connection
      .subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError(() => rejectReady?.(new Error("SpacetimeDB Roster execution subscription failed")))
      .subscribe([
        `SELECT * FROM my_roster_execution_summaries WHERE run_id = ${literal}`,
        `SELECT * FROM my_roster_tasks WHERE run_id = ${literal}`,
        `SELECT * FROM my_claimable_roster_tasks WHERE run_id = ${literal}`,
        `SELECT * FROM my_roster_worker_capabilities WHERE run_id = ${literal}`,
        `SELECT * FROM my_roster_task_outcomes WHERE run_id = ${literal}`,
        `SELECT * FROM my_roster_task_expansions WHERE run_id = ${literal}`,
        `SELECT * FROM my_roster_task_output_references WHERE run_id = ${literal}`,
         `SELECT * FROM my_roster_runtime_bindings WHERE run_id = ${literal}`,
         `SELECT * FROM my_roster_model_reservations WHERE run_id = ${literal}`,
       ]);
    return {
      ready,
      close: () => {
        for (const table of observedTables) {
          table.removeOnInsert(notify);
          table.removeOnUpdate(notify);
          table.removeOnDelete(notify);
        }
        handle.unsubscribe();
      },
    };
  }

  /** Watch the owner-visible dispatch frontier so nonterminal runs resume on startup or lease expiry. */
  subscribeCanvasDispatch(onChange?: () => void): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const notify = () => onChange?.();
    const observedTables = [
      this.connection.db.myCanvasRuns,
      this.connection.db.myCanvasFleetRuns,
      this.connection.db.myRosterTasks,
    ] as const;
    for (const table of observedTables) {
      table.onInsert(notify);
      table.onUpdate(notify);
      table.onDelete(notify);
    }
    const handle: SubscriptionHandle = this.connection
      .subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError(() => rejectReady?.(new Error("SpacetimeDB Canvas dispatch subscription failed")))
      .subscribe([
        "SELECT * FROM my_canvas_runs",
        "SELECT * FROM my_canvas_fleet_runs",
        "SELECT * FROM my_roster_tasks",
      ]);
    return {
      ready,
      close: () => {
        for (const table of observedTables) {
          table.removeOnInsert(notify);
          table.removeOnUpdate(notify);
          table.removeOnDelete(notify);
        }
        handle.unsubscribe();
      },
    };
  }

  /**
   * Subscribe to one workspace's stream catalog and a bounded set of receipt
   * chains. Callers add streams lazily rather than multiplying every server or
   * browser cache by the complete workspace history.
   */
  subscribeEventStreams(
    workspaceId: string,
    streamIds: ReadonlyArray<string>,
    onChange?: () => void
  ): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const notify = () => onChange?.();
    const observedTables = [
      this.connection.db.myWorkspaces,
      this.connection.db.myWorkspaceUsage,
      this.connection.db.myEventStreams,
      this.connection.db.myStreamReceipts,
      this.connection.db.myStreamBranches,
      this.connection.db.myCodingRooms,
      this.connection.db.myRosterParticipantProfiles,
    ] as const;
    for (const table of observedTables) {
      table.onInsert(notify);
      table.onUpdate(notify);
      table.onDelete(notify);
    }
    const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const workspaceLiteral = literal(workspaceId);
    const uniqueStreams = [...new Set(streamIds.filter((streamId) => streamId.trim().length > 0))];
    const queries = [
      `SELECT * FROM my_workspaces WHERE id = ${workspaceLiteral}`,
      `SELECT * FROM my_workspace_usage WHERE workspace_id = ${workspaceLiteral}`,
      `SELECT * FROM my_event_streams WHERE workspace_id = ${workspaceLiteral}`,
      `SELECT * FROM my_stream_branches WHERE workspace_id = ${workspaceLiteral}`,
      `SELECT * FROM my_coding_rooms WHERE workspace_id = ${workspaceLiteral}`,
      `SELECT * FROM my_roster_participant_profiles WHERE workspace_id = ${workspaceLiteral}`,
      ...uniqueStreams.map((streamId) =>
        `SELECT * FROM my_stream_receipts WHERE workspace_id = ${workspaceLiteral} AND stream_id = ${literal(streamId)}`
      ),
    ];
    const handle: SubscriptionHandle = this.connection
      .subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError((ctx) => rejectReady?.(
        ctx.event instanceof Error ? ctx.event : new Error("SpacetimeDB event-stream subscription failed")
      ))
      .subscribe(queries);
    return {
      ready,
      close: () => {
        for (const table of observedTables) {
          table.removeOnInsert(notify);
          table.removeOnUpdate(notify);
          table.removeOnDelete(notify);
        }
        handle.unsubscribe();
      },
    };
  }

  subscribeStreamReceipts(
    workspaceId: string,
    streamId: string,
    onChange?: () => void
  ): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const table = this.connection.db.myStreamReceipts;
    const notify = () => onChange?.();
    table.onInsert(notify);
    table.onUpdate(notify);
    table.onDelete(notify);
    const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const handle: SubscriptionHandle = this.connection
      .subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError(() => rejectReady?.(new Error("SpacetimeDB receipt subscription failed")))
      .subscribe(
        `SELECT * FROM my_stream_receipts WHERE workspace_id = ${literal(workspaceId)} AND stream_id = ${literal(streamId)}`
      );
    return {
      ready,
      close: () => {
        table.removeOnInsert(notify);
        table.removeOnUpdate(notify);
        table.removeOnDelete(notify);
        handle.unsubscribe();
      },
    };
  }

  workspaceSnapshot(workspaceId: string): SpacetimeWorkspaceSnapshot {
    return {
      workspaces: [...this.connection.db.myWorkspaces.iter()]
        .filter((workspace) => workspace.id === workspaceId),
      usage: [...this.connection.db.myWorkspaceUsage.iter()]
        .filter((usage) => usage.workspaceId === workspaceId),
      streams: [...this.connection.db.myEventStreams.iter()]
        .filter((stream) => stream.workspaceId === workspaceId),
      receipts: [...this.connection.db.myStreamReceipts.iter()]
        .filter((receipt) => receipt.workspaceId === workspaceId)
        .sort((left, right) => {
          const streamOrder = left.streamId.localeCompare(right.streamId);
          return streamOrder || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
        }),
      branches: [...this.connection.db.myStreamBranches.iter()]
        .filter((branch) => branch.workspaceId === workspaceId),
      codingRooms: [...this.connection.db.myCodingRooms.iter()]
        .filter((room) => room.workspaceId === workspaceId)
        .sort((left, right) => {
          const leftUpdated = left.updatedAt.microsSinceUnixEpoch;
          const rightUpdated = right.updatedAt.microsSinceUnixEpoch;
          return leftUpdated > rightUpdated ? -1 : leftUpdated < rightUpdated ? 1 : 0;
        }),
      participantProfiles: [...this.connection.db.myRosterParticipantProfiles.iter()]
        .filter((profile) => profile.workspaceId === workspaceId),
    };
  }

  streamReceipts(workspaceId: string, streamId: string): ReadonlyArray<StreamReceiptProjection> {
    return [...this.connection.db.myStreamReceipts.iter()]
      .filter((receipt) => receipt.workspaceId === workspaceId && receipt.streamId === streamId)
      .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
  }

  subscribeRosterJobs(workspaceId: string, onChange?: () => void): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const notify = () => onChange?.();
    const tables = [
      this.connection.db.myRosterJobs,
      this.connection.db.myRosterJobCommands,
      this.connection.db.myRosterJobEvents,
      this.connection.db.myRosterJobRequests,
    ] as const;
    for (const table of tables) {
      table.onInsert(notify);
      table.onUpdate(notify);
      table.onDelete(notify);
    }
    const literal = `'${workspaceId.replaceAll("'", "''")}'`;
    const handle = this.connection.subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError(() => rejectReady?.(new Error("SpacetimeDB Roster job subscription failed")))
      .subscribe([
        `SELECT * FROM my_roster_jobs WHERE workspace_id = ${literal}`,
        `SELECT * FROM my_roster_job_commands WHERE workspace_id = ${literal}`,
        `SELECT * FROM my_roster_job_events WHERE workspace_id = ${literal}`,
        `SELECT * FROM my_roster_job_requests WHERE workspace_id = ${literal}`,
      ]);
    return {
      ready,
      close: () => {
        for (const table of tables) {
          table.removeOnInsert(notify);
          table.removeOnUpdate(notify);
          table.removeOnDelete(notify);
        }
        if (handle.isActive()) handle.unsubscribe();
      },
    };
  }

  jobSnapshot(workspaceId: string): SpacetimeJobSnapshot {
    return {
      jobs: [...this.connection.db.myRosterJobs.iter()].filter((row) => row.workspaceId === workspaceId),
      commands: [...this.connection.db.myRosterJobCommands.iter()].filter((row) => row.workspaceId === workspaceId),
      events: [...this.connection.db.myRosterJobEvents.iter()]
        .filter((row) => row.workspaceId === workspaceId)
        .sort((left, right) => {
          const jobOrder = left.jobId.localeCompare(right.jobId);
          return jobOrder || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
        }),
      requests: [...this.connection.db.myRosterJobRequests.iter()].filter((row) => row.workspaceId === workspaceId),
    };
  }

  subscribeRosterNodeContinuity(workspaceId: string, onChange?: () => void): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const notify = () => onChange?.();
    const tables = [
      this.connection.db.myRosterWorkspaceNodes,
      this.connection.db.myRosterNodeContinuities,
      this.connection.db.myRosterNodeInboxItems,
      this.connection.db.myRosterNodeWakes,
      this.connection.db.myRosterNodeCommitments,
      this.connection.db.myRosterNodeContinuityEvents,
    ] as const;
    for (const table of tables) {
      table.onInsert(notify);
      table.onUpdate(notify);
      table.onDelete(notify);
    }
    const literal = `'${workspaceId.replaceAll("'", "''")}'`;
    const handle = this.connection.subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError(() => rejectReady?.(new Error("SpacetimeDB node continuity subscription failed")))
      .subscribe([
        `SELECT * FROM my_roster_workspace_nodes WHERE workspace_id = ${literal}`,
        `SELECT * FROM my_roster_node_continuities WHERE workspace_id = ${literal}`,
        `SELECT * FROM my_roster_node_inbox_items WHERE workspace_id = ${literal}`,
        `SELECT * FROM my_roster_node_wakes WHERE workspace_id = ${literal}`,
        `SELECT * FROM my_roster_node_commitments WHERE workspace_id = ${literal}`,
        `SELECT * FROM my_roster_node_continuity_events WHERE workspace_id = ${literal}`,
      ]);
    return {
      ready,
      close: () => {
        for (const table of tables) {
          table.removeOnInsert(notify);
          table.removeOnUpdate(notify);
          table.removeOnDelete(notify);
        }
        if (handle.isActive()) handle.unsubscribe();
      },
    };
  }

  nodeContinuitySnapshot(workspaceId: string): SpacetimeNodeContinuitySnapshot {
    return {
      nodes: [...this.connection.db.myRosterWorkspaceNodes.iter()]
        .filter((row) => row.workspaceId === workspaceId),
      continuities: [...this.connection.db.myRosterNodeContinuities.iter()]
        .filter((row) => row.workspaceId === workspaceId),
      inboxItems: [...this.connection.db.myRosterNodeInboxItems.iter()]
        .filter((row) => row.workspaceId === workspaceId),
      wakes: [...this.connection.db.myRosterNodeWakes.iter()]
        .filter((row) => row.workspaceId === workspaceId),
      commitments: [...this.connection.db.myRosterNodeCommitments.iter()]
        .filter((row) => row.workspaceId === workspaceId),
      events: [...this.connection.db.myRosterNodeContinuityEvents.iter()]
        .filter((row) => row.workspaceId === workspaceId)
        .sort((left, right) => {
          const nodeOrder = left.nodeId.localeCompare(right.nodeId);
          return nodeOrder || (left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
        }),
    };
  }

  snapshot(): SpacetimeCanvasSnapshot {
    return {
      runs: [...this.connection.db.myCanvasRuns.iter()],
      fleetRuns: [...this.connection.db.myCanvasFleetRuns.iter()],
      runUi: [...this.connection.db.myCanvasRunUi.iter()],
      members: [...this.connection.db.myRunMembers.iter()],
      tasks: [...this.connection.db.myRosterTasks.iter()],
      canvasTasks: [...this.connection.db.myCanvasTaskStatuses.iter()],
      claimableTasks: [...this.connection.db.myClaimableRosterTasks.iter()],
      receipts: [...this.connection.db.myReceipts.iter()].sort((left, right) =>
        left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0
      ),
      patches: [...this.connection.db.myScenePatches.iter()],
      plans: [...this.connection.db.myScenePlan.iter()],
      planParts: [...this.connection.db.myScenePlanParts.iter()],
      agents: [...this.connection.db.myCanvasAgents.iter()],
      objects: [...this.connection.db.mySceneObjects.iter()],
      reviews: [...this.connection.db.mySceneReviews.iter()],
      activity: [...this.connection.db.myCanvasActivity.iter()].sort((left, right) =>
        left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0
      ),
    };
  }

  rosterSnapshot(runId?: string): SpacetimeRosterSnapshot {
    const matches = <T extends { readonly runId: string }>(row: T): boolean =>
      runId === undefined || row.runId === runId;
    return {
      executions: [...this.connection.db.myRosterExecutionSummaries.iter()].filter(matches),
      tasks: [...this.connection.db.myRosterTasks.iter()].filter(matches),
      claimableTasks: [...this.connection.db.myClaimableRosterTasks.iter()].filter(matches),
      outcomes: [...this.connection.db.myRosterTaskOutcomes.iter()].filter(matches),
      expansions: [...this.connection.db.myRosterTaskExpansions.iter()].filter(matches),
      outputReferences: [...this.connection.db.myRosterTaskOutputReferences.iter()].filter(matches),
      runtimeBindings: [...this.connection.db.myRosterRuntimeBindings.iter()].filter(matches),
      modelReservations: [...this.connection.db.myRosterModelReservations.iter()].filter(matches),
    };
  }

  subscribeRosterRoomState(
    workspaceId: string,
    roomId: string,
    runId: string,
    onChange?: () => void
  ): SpacetimeSubscription {
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const notify = () => onChange?.();
    const tables = [
      this.connection.db.myRosterRooms,
      this.connection.db.myRosterRoomNodes,
      this.connection.db.myRosterRoomTimelineEntries,
      this.connection.db.myRosterControlIntents,
      this.connection.db.myRosterContextFrontiers,
      this.connection.db.myRosterExecutionSummaries,
      this.connection.db.myRosterTasks,
      this.connection.db.myRosterTaskEdges,
      this.connection.db.myRosterTaskOutcomes,
      this.connection.db.myRosterTaskExpansions,
      this.connection.db.myRosterTaskOutputReferences,
      this.connection.db.myRosterRuntimeBindings,
      this.connection.db.myRosterTaskContextManifests,
      this.connection.db.myRosterModelReservations,
      this.connection.db.myRosterProjectionOutbox,
      this.connection.db.myRosterSharedWorkspaceUpdates,
      this.connection.db.myRosterSharedWorkspaceCheckpoints,
    ] as const;
    for (const table of tables) {
      table.onInsert(notify);
      table.onUpdate(notify);
      table.onDelete(notify);
    }
    const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const workspace = literal(workspaceId);
    const room = literal(roomId);
    const run = literal(runId);
    const handle = this.connection.subscriptionBuilder()
      .onApplied(() => {
        resolveReady?.();
        notify();
      })
      .onError(() => rejectReady?.(new Error("SpacetimeDB Room OS subscription failed")))
      .subscribe([
        `SELECT * FROM my_roster_rooms WHERE workspace_id = ${workspace} AND id = ${room}`,
        `SELECT * FROM my_roster_room_nodes WHERE workspace_id = ${workspace} AND room_id = ${room}`,
        `SELECT * FROM my_roster_room_timeline_entries WHERE workspace_id = ${workspace} AND room_id = ${room}`,
        `SELECT * FROM my_roster_control_intents WHERE workspace_id = ${workspace} AND room_id = ${room}`,
        `SELECT * FROM my_roster_context_frontiers WHERE workspace_id = ${workspace} AND room_id = ${room}`,
        `SELECT * FROM my_roster_execution_summaries WHERE workspace_id = ${workspace} AND run_id = ${run}`,
        `SELECT * FROM my_roster_tasks WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_task_edges WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_task_outcomes WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_task_expansions WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_task_output_references WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_runtime_bindings WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_task_context_manifests WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_model_reservations WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_projection_outbox WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_shared_workspace_updates WHERE run_id = ${run}`,
        `SELECT * FROM my_roster_shared_workspace_checkpoints WHERE run_id = ${run}`,
      ]);
    return {
      ready,
      close: () => {
        for (const table of tables) {
          table.removeOnInsert(notify);
          table.removeOnUpdate(notify);
          table.removeOnDelete(notify);
        }
        if (handle.isActive()) handle.unsubscribe();
      },
    };
  }

  roomSnapshot(workspaceId: string, roomId: string, runId?: string): SpacetimeRoomSnapshot {
    const roomRows = [...this.connection.db.myRosterRooms.iter()]
      .filter((row) => row.workspaceId === workspaceId && row.id === roomId);
    const activeRunId = runId ?? roomRows[0]?.activeRunId ?? "";
    return {
      rooms: roomRows,
      nodes: [...this.connection.db.myRosterRoomNodes.iter()]
        .filter((row) => row.workspaceId === workspaceId && row.roomId === roomId),
      timeline: [...this.connection.db.myRosterRoomTimelineEntries.iter()]
        .filter((row) => row.workspaceId === workspaceId && row.roomId === roomId)
        .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0),
      controlIntents: [...this.connection.db.myRosterControlIntents.iter()]
        .filter((row) => row.workspaceId === workspaceId && row.roomId === roomId),
      contextFrontiers: [...this.connection.db.myRosterContextFrontiers.iter()]
        .filter((row) => row.workspaceId === workspaceId && row.roomId === roomId),
      executions: [...this.connection.db.myRosterExecutionSummaries.iter()]
        .filter((row) => row.workspaceId === workspaceId && (!activeRunId || row.runId === activeRunId)),
      edges: [...this.connection.db.myRosterTaskEdges.iter()].filter((row) => row.runId === activeRunId),
      outcomes: [...this.connection.db.myRosterTaskOutcomes.iter()].filter((row) => row.runId === activeRunId),
      expansions: [...this.connection.db.myRosterTaskExpansions.iter()].filter((row) => row.runId === activeRunId),
      outputReferences: [...this.connection.db.myRosterTaskOutputReferences.iter()]
        .filter((row) => row.runId === activeRunId),
      runtimeBindings: [...this.connection.db.myRosterRuntimeBindings.iter()]
        .filter((row) => row.runId === activeRunId),
      contextManifests: [...this.connection.db.myRosterTaskContextManifests.iter()]
        .filter((row) => row.runId === activeRunId),
      modelReservations: [...this.connection.db.myRosterModelReservations.iter()]
        .filter((row) => row.runId === activeRunId),
      projectionOutbox: [...this.connection.db.myRosterProjectionOutbox.iter()]
        .filter((row) => row.runId === activeRunId),
      sharedWorkspaceUpdates: [...this.connection.db.myRosterSharedWorkspaceUpdates.iter()]
        .filter((row) => row.runId === activeRunId),
      sharedWorkspaceCheckpoints: [...this.connection.db.myRosterSharedWorkspaceCheckpoints.iter()]
        .filter((row) => row.runId === activeRunId),
    };
  }

  canvasReceipts(runId: string): ReadonlyArray<ReceiptProjection> {
    return [...this.connection.db.myReceipts.iter()]
      .filter((receipt) => receipt.runId === runId)
      .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
  }

  ensureWorkspace(workspaceId: string, name: string): Promise<void> {
    return this.connection.reducers.ensureWorkspace({ workspaceId, name });
  }

  addWorkspaceMember(input: {
    readonly workspaceId: string;
    readonly member: Identity;
    readonly role: "coordinator" | "worker" | "viewer";
  }): Promise<void> {
    return this.connection.reducers.addWorkspaceMember(input);
  }

  createWorkspaceViewerCapability(input: {
    readonly workspaceId: string;
    readonly capabilityId: string;
    readonly capabilityHash: string;
    readonly maxUses: number;
    readonly ttlSeconds: number;
  }): Promise<void> {
    return this.connection.reducers.createWorkspaceViewerCapability(input);
  }

  revokeWorkspaceViewerCapability(workspaceId: string, capabilityId: string): Promise<void> {
    return this.connection.reducers.revokeWorkspaceViewerCapability({ workspaceId, capabilityId });
  }

  joinWorkspace(workspaceId: string, capabilityHash: string): Promise<void> {
    return this.connection.reducers.joinWorkspace({ workspaceId, capabilityHash });
  }

  ensureEventStream(input: {
    readonly workspaceId: string;
    readonly streamId: string;
    readonly kind: string;
    readonly parentStreamId?: string;
    readonly forkAt?: number;
  }): Promise<void> {
    return this.connection.reducers.ensureEventStream({
      workspaceId: input.workspaceId,
      streamId: input.streamId,
      kind: input.kind,
      parentStreamId: input.parentStreamId ?? "",
      forkAt: input.forkAt ?? 0,
    });
  }

  appendStreamReceipt(input: {
    readonly workspaceId: string;
    readonly streamId: string;
    readonly receiptId: string;
    readonly occurredAtMs: bigint;
    readonly prevHash: string;
    readonly hash: string;
    readonly bodyJson: string;
    readonly hintsJson: string;
  }): Promise<void> {
    return this.connection.reducers.appendStreamReceipt(input);
  }

  appendCodingRoomReceipt(input: {
    readonly workspaceId: string;
    readonly codingWorkspaceId: string;
    readonly roomId: string;
    readonly conversationId: string;
    readonly streamId: string;
    readonly receiptId: string;
    readonly occurredAtMs: bigint;
    readonly prevHash: string;
    readonly hash: string;
    readonly bodyJson: string;
    readonly hintsJson: string;
  }): Promise<void> {
    return this.connection.reducers.appendCodingRoomReceipt(input);
  }

  registerRosterWorkspaceNode(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly nodeRevision: bigint;
    readonly nodeJson: string;
    readonly continuityPolicyJson: string;
    readonly expectedRevision: bigint;
  }): Promise<void> {
    return this.connection.reducers.registerRosterWorkspaceNode(input);
  }

  deliverRosterNodeInbox(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly deliveryId: string;
    readonly cause: string;
    readonly laneId: string;
    readonly roomId: string;
    readonly runId: string;
    readonly sourceId: string;
    readonly sourceVersion: string;
    readonly sourceHash: string;
    readonly payloadReference: string;
    readonly causalParentId: string;
    readonly causalDepth: number;
    readonly deliveredAtMs: bigint;
    readonly requestWake: boolean;
    readonly wakeRequestId: string;
    readonly notBeforeMs: bigint;
  }): Promise<void> {
    return this.connection.reducers.deliverRosterNodeInbox(input);
  }

  requestRosterNodeWake(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly requestId: string;
    readonly notBeforeMs: bigint;
  }): Promise<void> {
    return this.connection.reducers.requestRosterNodeWake(input);
  }

  admitRosterNodeWake(input: {
    readonly workspaceId: string;
    readonly wakeId: string;
    readonly workerId: string;
    readonly fence: bigint;
  }): Promise<void> {
    return this.connection.reducers.admitRosterNodeWake(input);
  }

  completeRosterNodeWake(input: {
    readonly workspaceId: string;
    readonly wakeId: string;
    readonly consumedDeliveryIdsJson: string;
    readonly resultJson: string;
  }): Promise<void> {
    return this.connection.reducers.completeRosterNodeWake(input);
  }

  failRosterNodeWake(input: {
    readonly workspaceId: string;
    readonly wakeId: string;
    readonly error: string;
  }): Promise<void> {
    return this.connection.reducers.failRosterNodeWake(input);
  }

  resolveFailedRosterNodeWake(input: {
    readonly workspaceId: string;
    readonly wakeId: string;
    readonly resolution: string;
  }): Promise<void> {
    return this.connection.reducers.resolveFailedRosterNodeWake(input);
  }

  suspendRosterNodeContinuity(workspaceId: string, nodeId: string): Promise<void> {
    return this.connection.reducers.suspendRosterNodeContinuity({ workspaceId, nodeId });
  }

  resumeRosterNodeContinuity(workspaceId: string, nodeId: string): Promise<void> {
    return this.connection.reducers.resumeRosterNodeContinuity({ workspaceId, nodeId });
  }

  changeRosterNodeCommitment(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly commitmentId: string;
    readonly objective: string;
    readonly status: string;
    readonly revision: bigint;
    readonly sourceId: string;
    readonly updatedAtMs: bigint;
  }): Promise<void> {
    return this.connection.reducers.changeRosterNodeCommitment(input);
  }

  updateRosterNodeMemoryFrontier(input: {
    readonly workspaceId: string;
    readonly nodeId: string;
    readonly scopeId: string;
    readonly snapshotVersion: string;
  }): Promise<void> {
    return this.connection.reducers.updateRosterNodeMemoryFrontier(input);
  }

  enqueueRosterJob(input: {
    readonly workspaceId: string;
    readonly requestId: string;
    readonly jobId: string;
    readonly agentId: string;
    readonly lane: string;
    readonly sessionKey: string;
    readonly singletonMode: string;
    readonly payloadJson: string;
    readonly maxAttempts: number;
  }): Promise<void> {
    return this.connection.reducers.enqueueRosterJob(input);
  }

  claimNextRosterJob(input: {
    readonly workspaceId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly leaseMs: number;
    readonly agentId: string;
  }): Promise<void> {
    return this.connection.reducers.claimNextRosterJob(input);
  }

  heartbeatRosterJob(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly fence: bigint;
    readonly leaseMs: number;
  }): Promise<void> {
    return this.connection.reducers.heartbeatRosterJob(input);
  }

  completeRosterJob(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly fence: bigint;
    readonly resultJson: string;
  }): Promise<void> {
    return this.connection.reducers.completeRosterJob(input);
  }

  failRosterJob(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly fence: bigint;
    readonly error: string;
    readonly retryable: boolean;
    readonly resultJson: string;
  }): Promise<void> {
    return this.connection.reducers.failRosterJob(input);
  }

  reconcileTerminalRosterJobCommands(input: {
    readonly workspaceId: string;
    readonly jobId: string;
  }): Promise<void> {
    return this.connection.reducers.reconcileTerminalRosterJobCommands(input);
  }

  cancelRosterJob(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly reason: string;
    readonly by: string;
  }): Promise<void> {
    return this.connection.reducers.cancelRosterJob(input);
  }

  queueRosterJobCommand(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly commandId: string;
    readonly command: string;
    readonly payloadJson: string;
    readonly by: string;
  }): Promise<void> {
    return this.connection.reducers.queueRosterJobCommand(input);
  }

  consumeRosterJobCommands(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly consumeId: string;
    readonly filtersJson: string;
  }): Promise<void> {
    return this.connection.reducers.consumeRosterJobCommands(input);
  }

  createCanvasRun(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly requestId: string;
    readonly prompt: string;
    readonly desiredAgents: number;
    readonly maxInflight: number;
    readonly budgetMicros: bigint;
  }): Promise<void> {
    return this.connection.reducers.createCanvasRun(input);
  }

  ensureRosterExecution(input: {
    readonly runId: string;
    readonly kind: string;
    readonly workspaceId: string;
    readonly receiptStreamId?: string;
    readonly policy: RunExecutionPolicy;
  }): Promise<void> {
    return this.connection.reducers.ensureRosterExecution({
      runId: input.runId,
      kind: input.kind,
      workspaceId: input.workspaceId,
      receiptStreamId: input.receiptStreamId ?? "",
      policyJson: JSON.stringify(input.policy),
    });
  }

  initializeRosterExecution(input: RosterExecutionRoomInitialization): Promise<void> {
    const bindings = input.runtimeBindings.map((binding) => ({
      ...binding,
      epoch: 1,
      topologyVersion: input.initialContextFrontier.topologyVersion,
    }));
    const bindingEpochByNode = new Map(bindings.map((binding) => [binding.nodeId, binding.epoch] as const));
    const seedTasks = input.seedTasks.map((task) => {
      const runtimeBindingEpoch = bindingEpochByNode.get(task.nodeId);
      if (runtimeBindingEpoch === undefined) {
        throw new Error(`No initial runtime binding was provided for node ${task.nodeId}`);
      }
      return { ...task, runtimeBindingEpoch };
    });
    return this.connection.reducers.initializeRosterExecution({
      workspaceId: input.workspaceId,
      runId: input.runId,
      receiptStreamId: input.receiptStreamId ?? "",
      policyJson: JSON.stringify(input.policy),
      roomJson: JSON.stringify(input.room),
      nodesJson: JSON.stringify(input.nodes),
      runtimeBindingsJson: JSON.stringify(bindings),
      seedTasksJson: JSON.stringify(seedTasks),
      contextFrontierJson: JSON.stringify(input.initialContextFrontier),
      idempotencyKey: input.idempotencyKey,
    });
  }

  queueRosterRoomControlIntent(input: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly intentId: string;
    readonly kind: "follow_up" | "steer" | "cancel" | "retry" | "approve";
    readonly payloadJson: string;
  }): Promise<void> {
    return this.connection.reducers.queueRosterRoomControlIntent(input);
  }

  consumeRosterRoomControlIntent(input: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly intentId: string;
    readonly runId: string;
    readonly consumerId: string;
  }): Promise<void> {
    return this.connection.reducers.consumeRosterRoomControlIntent(input);
  }

  pendingRosterRoomControlIntents(
    workspaceId: string,
    roomId: string
  ): ReadonlyArray<RosterRoomControlIntent> {
    return [...this.connection.db.myRosterControlIntents.iter()]
      .filter((row) =>
        row.workspaceId === workspaceId
        && row.roomId === roomId
        && row.status === "pending"
      )
      .sort((left, right) =>
        left.createdAt.microsSinceUnixEpoch < right.createdAt.microsSinceUnixEpoch ? -1 : 1
      );
  }

  hasPendingRequiredRosterRoomControlIntents(workspaceId: string, roomId: string): boolean {
    return this.pendingRosterRoomControlIntents(workspaceId, roomId).some((intent) =>
      intent.kind !== "approve"
    );
  }

  publishRosterSharedWorkspaceUpdate(input: {
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
  }): Promise<void> {
    return this.connection.reducers.publishRosterSharedWorkspaceUpdate(input);
  }

  checkpointRosterSharedWorkspace(input: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly runId: string;
    readonly artifactId: string;
    readonly checkpointId: string;
    readonly throughUpdateId: string;
    readonly frontierVersion: string;
    readonly topologyVersion: string;
    readonly stateBase64: string;
  }): Promise<void> {
    return this.connection.reducers.checkpointRosterSharedWorkspace(input);
  }

  linkCanvasRunWorkspace(workspaceId: string, runId: string): Promise<void> {
    return this.connection.reducers.linkCanvasRunWorkspace({ workspaceId, runId });
  }

  /** Atomically persist and project one complete, hash-chained CanvasEvent. */
  projectCanvasEvent(input: {
    readonly runId: string;
    readonly coordinatorTaskId: string;
    readonly coordinatorFence: bigint;
    readonly eventId: string;
    readonly expectedPrev: string;
    readonly eventHash: string;
    readonly kind: string;
    readonly agentId: string;
    readonly eventJson: string;
    readonly summary: string;
  }): Promise<void> {
    return this.connection.reducers.projectCanvasEvent(input);
  }

  createViewerCapability(input: {
    readonly runId: string;
    readonly capabilityId: string;
    readonly capabilityHash: string;
    readonly maxUses: number;
    readonly ttlSeconds: number;
  }): Promise<void> {
    return this.connection.reducers.createViewerCapability(input);
  }

  revokeViewerCapability(input: {
    readonly runId: string;
    readonly capabilityId: string;
  }): Promise<void> {
    return this.connection.reducers.revokeViewerCapability(input);
  }

  joinCanvasRun(input: {
    readonly runId: string;
    readonly capabilityHash: string;
  }): Promise<void> {
    return this.connection.reducers.joinCanvasRun(input);
  }

  enqueueRosterTask(input: {
    readonly runId: string;
    readonly definition: DynamicTaskDefinition;
  }): Promise<void> {
    return this.connection.reducers.enqueueRosterTask({
      runId: input.runId,
      definitionJson: JSON.stringify(input.definition),
    });
  }

  setRosterWorkerCapabilities(input: {
    readonly runId: string;
    readonly member: Identity;
    readonly capabilities: ReadonlyArray<string>;
  }): Promise<void> {
    return this.connection.reducers.setRosterWorkerCapabilities({
      runId: input.runId,
      member: input.member,
      capabilitiesJson: JSON.stringify(input.capabilities),
    });
  }

  expandAndDelegateRosterTask(input: {
    readonly runId: string;
    readonly parentTaskId: string;
    readonly fence: bigint;
    readonly expansionKey: string;
    readonly children: ReadonlyArray<DynamicTaskDefinition>;
    readonly continuation: DynamicTaskDefinition;
    readonly usage?: NodeExecutionUsage;
  }): Promise<void> {
    return this.connection.reducers.expandAndDelegateRosterTask({
      runId: input.runId,
      parentTaskId: input.parentTaskId,
      fence: input.fence,
      expansionKey: input.expansionKey,
      childrenJson: JSON.stringify(input.children),
      continuationJson: JSON.stringify(input.continuation),
      usageJson: JSON.stringify(input.usage ?? {}),
    });
  }

  claimRosterTask(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly leaseMs: number;
  }): Promise<void> {
    return this.connection.reducers.claimRosterTask(input);
  }

  heartbeatRosterTask(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly fence: bigint;
    readonly leaseMs: number;
  }): Promise<void> {
    return this.connection.reducers.heartbeatRosterTask(input);
  }

  startRosterTask(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly fence: bigint;
    readonly contextManifest: TaskContextManifest;
  }): Promise<void> {
    return this.connection.reducers.startRosterTask({
      runId: input.runId,
      taskId: input.taskId,
      fence: input.fence,
      contextManifestJson: JSON.stringify(input.contextManifest),
    });
  }

  reserveRosterModelCall(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly fence: bigint;
    readonly provider: string;
    readonly model: string;
    readonly reservedTokens: bigint;
  }): Promise<void> {
    return this.connection.reducers.reserveRosterModelCall(input);
  }

  bindRosterNodeRuntime(input: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly runId: string;
    readonly binding: WorkspaceNodeRuntimeBinding;
  }): Promise<void> {
    return this.connection.reducers.bindRosterNodeRuntime({
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      runId: input.runId,
      bindingJson: JSON.stringify(input.binding),
    });
  }

  markRosterModelReservationDispatched(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly fence: bigint;
  }): Promise<void> {
    return this.connection.reducers.markRosterModelReservationDispatched(input);
  }

  settleRosterModelReservation(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly fence: bigint;
    readonly actualCostMicros: bigint;
    readonly actualTokens: bigint;
  }): Promise<void> {
    return this.connection.reducers.settleRosterModelReservation(input);
  }

  acceptRosterTaskOutcome(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly fence: bigint;
    readonly outcome: AcceptedTaskOutcome;
    readonly dataReferences?: ReadonlyArray<{
      readonly artifactId: string;
      readonly reference: DataReference;
      readonly presentationText?: string;
    }>;
  }): Promise<void> {
    return this.connection.reducers.acceptRosterTaskOutcome({
      runId: input.runId,
      taskId: input.taskId,
      fence: input.fence,
      outcomeJson: JSON.stringify(input.outcome),
      dataReferencesJson: JSON.stringify(input.dataReferences ?? []),
    });
  }

  failRosterTask(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly fence: bigint;
    readonly error: string;
    readonly retryable: boolean;
  }): Promise<void> {
    return this.connection.reducers.failRosterTask(input);
  }

  cancelRosterExecution(runId: string, reason: string): Promise<void> {
    return this.connection.reducers.cancelRosterExecution({ runId, reason });
  }

  finalizeRosterExecution(input: {
    readonly runId: string;
    readonly outcome: "completed" | "failed";
    readonly reason?: string;
  }): Promise<void> {
    return this.connection.reducers.finalizeRosterExecution({
      runId: input.runId,
      outcome: input.outcome,
      reason: input.reason ?? "",
    });
  }

  cancelRosterTask(input: {
    readonly runId: string;
    readonly taskId: string;
    readonly fence?: bigint;
    readonly reason: string;
  }): Promise<void> {
    return this.connection.reducers.cancelRosterTask({
      runId: input.runId,
      taskId: input.taskId,
      fence: input.fence ?? 0n,
      reason: input.reason,
    });
  }

  cancelCanvasRun(runId: string, reason: string): Promise<void> {
    return this.connection.reducers.cancelCanvasRun({ runId, reason });
  }

  finalizeCanvasRun(input: {
    readonly runId: string;
    readonly outcome: "completed" | "completed_with_notes";
    readonly sceneHash: string;
    readonly objectCount: number;
  }): Promise<void> {
    return this.connection.reducers.finalizeCanvasRun(input);
  }
}

export const connectSpacetimeControlPlaneFromEnv = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<SpacetimeControlPlane | undefined> => {
  if (!spacetimeEnabled(env)) return undefined;
  const config = resolveSpacetimeControlConfig(env);
  try {
    return await SpacetimeControlPlane.connect(config);
  } catch (error) {
    throw spacetimeStartupFailure(config, error);
  }
};
