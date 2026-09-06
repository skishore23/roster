import { createHash, randomUUID } from "node:crypto";

import { SenderError } from "spacetimedb";

import { codingViewerGrantRefreshDelay } from "../core/coding-viewer-access.js";
import { DbConnection } from "../spacetimedb-bindings/index.js";
import type {
  CodingCliClient,
  CodingCliRealtimeSession,
  CodingCliRunSnapshot,
} from "./coding-client.js";

type ObservableTable = {
  onInsert: (callback: (context: unknown, row: unknown) => void) => void;
  onUpdate: (callback: (context: unknown, previous: unknown, row: unknown) => void) => void;
  onDelete: (callback: (context: unknown, row: unknown) => void) => void;
};

type CodingRealtimeDatabase = {
  readonly myCodingRoomsWindow: ObservableTable;
  readonly myCodingRoomNodesWindow: ObservableTable;
  readonly myCodingRoomTimelineWindow: ObservableTable;
  readonly myCodingControlIntentDeliveriesWindow: ObservableTable;
  readonly myCodingContextFrontiersWindow: ObservableTable;
  readonly myCodingExecutionSummariesWindow: ObservableTable;
  readonly myCodingRunTasksWindow: ObservableTable;
  readonly myCodingRunTaskEdgesWindow: ObservableTable;
  readonly myCodingRunTaskOutputReferencesWindow: ObservableTable;
  readonly myCodingCollaborationSummariesWindow: ObservableTable;
  readonly myCodingActiveRuntimeBindingsWindow: ObservableTable;
};

export type CodingRealtimeState = "connecting" | "syncing" | "live" | "paused" | "denied";

export type CodingRealtimeSubscriptionOptions = {
  readonly client: Pick<CodingCliClient, "realtimeSession" | "run">;
  readonly conversationId: string;
  readonly jobId?: string;
  readonly signal?: AbortSignal;
  readonly onSnapshot: (snapshot: CodingCliRunSnapshot) => void;
  readonly onState?: (state: CodingRealtimeState, detail?: string) => void;
  readonly coalesceMs?: number;
  readonly connectionFactory?: CodingRealtimeTransportFactory;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly renewalLeadMs?: number;
};

export type CodingRealtimeSubscription = {
  readonly close: () => void;
  readonly done: Promise<void>;
};

type CodingRealtimeSubscriptionHandle = {
  readonly isActive: () => boolean;
  readonly unsubscribe: () => void;
};

type CodingRealtimeSubscriptionBuilder = {
  readonly onApplied: (callback: () => void) => CodingRealtimeSubscriptionBuilder;
  readonly onError: (callback: (error: { readonly event?: { readonly message?: string } }) => void) => CodingRealtimeSubscriptionBuilder;
  readonly subscribe: (queries: ReadonlyArray<string>) => CodingRealtimeSubscriptionHandle;
};

export type CodingRealtimeLiveConnection = {
  readonly reducers: {
    readonly joinCanvasRun: (input: {
      readonly runId: string;
      readonly capabilityHash: string;
    }) => Promise<void>;
    readonly selectCodingRoomTimelinePage: (input: {
      readonly runId: string;
      readonly roomId: string;
      readonly beforeSeq: bigint;
      readonly selectionId: string;
      readonly predecessorSelectionId: string;
      readonly ttlSeconds: bigint;
    }) => Promise<void>;
  };
  readonly db: unknown;
  readonly subscriptionBuilder: () => CodingRealtimeSubscriptionBuilder;
  readonly disconnect: () => void;
};

export type CodingRealtimeTransportFactory = (input: {
  readonly session: CodingCliRealtimeSession;
  readonly identityToken?: string;
  readonly onConnect: (connection: CodingRealtimeLiveConnection, token?: string) => void;
  readonly onConnectError: (error: Error) => void;
  readonly onDisconnect: (error?: Error) => void;
}) => { readonly disconnect: () => void };

const defaultCodingRealtimeTransportFactory: CodingRealtimeTransportFactory = (input) => {
  const connection = DbConnection.builder()
    .withUri(input.session.uri)
    .withDatabaseName(input.session.database)
    .withToken(input.identityToken)
    .withConfirmedReads(input.session.confirmedReads)
    .withLightMode(true)
    .onConnect((next, _identity, token) => {
      input.onConnect(next as unknown as CodingRealtimeLiveConnection, token);
    })
    .onConnectError((_context, error) => {
      input.onConnectError(error);
    })
    .onDisconnect((_context, error) => {
      input.onDisconnect(error);
    })
    .build();
  return { disconnect: () => connection.disconnect() };
};

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const capabilityHash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const codingRealtimeQueries = (
  session: Pick<CodingCliRealtimeSession, "workspaceId" | "roomId" | "conversationId" | "executionId">,
  selectionId: string,
): ReadonlyArray<string> => {
  const room = sqlLiteral(session.roomId);
  const run = sqlLiteral(session.executionId);
  const selection = sqlLiteral(selectionId);
  return [
    `SELECT * FROM my_coding_rooms_window WHERE id = ${room}`,
    `SELECT * FROM my_coding_room_nodes_window WHERE room_id = ${room}`,
    `SELECT * FROM my_coding_room_timeline_window WHERE room_id = ${room} AND selection_id = ${selection}`,
    `SELECT * FROM my_coding_control_intent_deliveries_window WHERE room_id = ${room}`,
    `SELECT * FROM my_coding_context_frontiers_window WHERE room_id = ${room}`,
    `SELECT * FROM my_coding_execution_summaries_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_run_tasks_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_run_task_edges_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_run_task_output_references_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_collaboration_summaries_window WHERE run_id = ${run}`,
    `SELECT * FROM my_coding_active_runtime_bindings_window WHERE room_id = ${room}`,
  ];
};

const observedTables = (db: CodingRealtimeDatabase): ReadonlyArray<ObservableTable> => [
  db.myCodingRoomsWindow,
  db.myCodingRoomNodesWindow,
  db.myCodingRoomTimelineWindow,
  db.myCodingControlIntentDeliveriesWindow,
  db.myCodingContextFrontiersWindow,
  db.myCodingExecutionSummariesWindow,
  db.myCodingRunTasksWindow,
  db.myCodingRunTaskEdgesWindow,
  db.myCodingRunTaskOutputReferencesWindow,
  db.myCodingCollaborationSummariesWindow,
  db.myCodingActiveRuntimeBindingsWindow,
];

/**
 * Attaches to the same caller-scoped SpacetimeDB projections as the web UI.
 * HTTP remains the canonical aggregate boundary, but is fetched only after an
 * applied subscription or a coalesced transactional delta—there is no timer
 * polling while the room is idle.
 */
export const subscribeCodingRealtime = (
  options: CodingRealtimeSubscriptionOptions,
): CodingRealtimeSubscription => {
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const coalesceMs = Math.max(10, Math.min(Math.floor(options.coalesceMs ?? 50), 500));
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number): unknown =>
    setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer: unknown): void =>
    clearTimeout(timer as NodeJS.Timeout));
  const connectionFactory = options.connectionFactory ?? defaultCodingRealtimeTransportFactory;
  const renewalLeadMs = Math.max(1, Math.floor(options.renewalLeadMs ?? 30_000));
  const timelineSelectionId = `cli-${randomUUID()}`;
  let connection: { readonly disconnect: () => void } | undefined;
  let subscription: CodingRealtimeSubscriptionHandle | undefined;
  let identityToken: string | undefined;
  let generation = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: unknown;
  let refreshTimer: unknown;
  let renewalTimer: unknown;
  let refreshRunning = false;
  let refreshAgain = false;
  let lastProjection = "";

  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const clear = (): void => {
    if (reconnectTimer !== undefined) clearTimer(reconnectTimer);
    if (refreshTimer !== undefined) clearTimer(refreshTimer);
    if (renewalTimer !== undefined) clearTimer(renewalTimer);
    reconnectTimer = undefined;
    refreshTimer = undefined;
    renewalTimer = undefined;
    try {
      if (subscription?.isActive()) subscription.unsubscribe();
    } catch {
      // The transport may already have closed this generation.
    }
    subscription = undefined;
    connection?.disconnect();
    connection = undefined;
  };

  const close = (): void => {
    if (!lifetime.signal.aborted) lifetime.abort();
    clear();
    resolveDone?.();
    resolveDone = undefined;
  };
  signal.addEventListener("abort", close, { once: true });

  const refresh = async (selectedGeneration: number): Promise<void> => {
    if (signal.aborted || selectedGeneration !== generation) return;
    if (refreshRunning) {
      refreshAgain = true;
      return;
    }
    refreshRunning = true;
    try {
      do {
        refreshAgain = false;
        const snapshot = await options.client.run(options.conversationId, options.jobId, signal);
        if (signal.aborted || selectedGeneration !== generation) return;
        const serialized = JSON.stringify(snapshot);
        if (serialized !== lastProjection) {
          lastProjection = serialized;
          options.onSnapshot(snapshot);
        }
        if (snapshot.job?.terminal) {
          close();
          return;
        }
      } while (refreshAgain && !signal.aborted && selectedGeneration === generation);
    } finally {
      refreshRunning = false;
    }
  };

  const scheduleRefresh = (selectedGeneration: number): void => {
    if (signal.aborted || selectedGeneration !== generation || refreshTimer !== undefined) return;
    refreshTimer = setTimer(() => {
      refreshTimer = undefined;
      void refresh(selectedGeneration).catch((error: unknown) => {
        if (!signal.aborted && selectedGeneration === generation) {
          options.onState?.("paused", error instanceof Error ? error.message : String(error));
        }
      });
    }, coalesceMs);
  };

  const reconnect = (reason: string): void => {
    if (signal.aborted || reconnectTimer !== undefined) return;
    options.onState?.("paused", reason);
    const waitMs = Math.min(30_000, 500 * 2 ** Math.min(6, reconnectAttempt++));
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      connect();
    }, waitMs);
  };

  const connect = (): void => {
    if (signal.aborted) return;
    const selectedGeneration = ++generation;
    clear();
    options.onState?.(reconnectAttempt > 0 ? "paused" : "connecting");
    void options.client.realtimeSession(options.conversationId, options.jobId, signal).then((session) => {
      if (signal.aborted || selectedGeneration !== generation) return;
      connection = connectionFactory({
        session,
        ...(identityToken ? { identityToken } : {}),
        onConnect: (next, token) => {
          if (signal.aborted || selectedGeneration !== generation) {
            next.disconnect();
            return;
          }
          if (token) identityToken = token;
          void next.reducers.joinCanvasRun({
            runId: session.executionId,
            capabilityHash: capabilityHash(session.capabilitySecret),
          }).then(() => next.reducers.selectCodingRoomTimelinePage({
            runId: session.executionId,
            roomId: session.roomId,
            beforeSeq: 0n,
            selectionId: timelineSelectionId,
            predecessorSelectionId: "",
            ttlSeconds: 3_600n,
          })).then(() => {
            if (signal.aborted || selectedGeneration !== generation) return;
            const renewalDelayMs = codingViewerGrantRefreshDelay(
              session.expiresAt,
              now(),
              renewalLeadMs,
            );
            if (renewalDelayMs === undefined) {
              reconnect("Realtime access expired before it could be renewed");
              next.disconnect();
              return;
            }
            renewalTimer = setTimer(() => {
              renewalTimer = undefined;
              if (signal.aborted || selectedGeneration !== generation) return;
              connect();
            }, renewalDelayMs);
            const db = next.db as unknown as CodingRealtimeDatabase;
            for (const table of observedTables(db)) {
              table.onInsert(() => scheduleRefresh(selectedGeneration));
              table.onUpdate(() => scheduleRefresh(selectedGeneration));
              table.onDelete(() => scheduleRefresh(selectedGeneration));
            }
            options.onState?.("syncing");
            subscription = next.subscriptionBuilder()
              .onApplied(() => {
                if (signal.aborted || selectedGeneration !== generation) return;
                reconnectAttempt = 0;
                options.onState?.("live");
                void refresh(selectedGeneration).catch((error: unknown) => {
                  if (!signal.aborted) options.onState?.("paused", error instanceof Error ? error.message : String(error));
                });
              })
              .onError((error) => {
                if (selectedGeneration === generation) reconnect(error.event?.message || "Realtime subscription closed");
              })
              .subscribe([...codingRealtimeQueries(session, timelineSelectionId)]);
          }).catch((error: unknown) => {
            if (error instanceof SenderError) {
              options.onState?.("denied", error.message);
              close();
            } else {
              reconnect(error instanceof Error ? error.message : String(error));
            }
          });
        },
        onConnectError: (error) => {
          if (selectedGeneration === generation) reconnect(error.message || "Realtime connection failed");
        },
        onDisconnect: (error) => {
          if (selectedGeneration === generation && !signal.aborted) {
            reconnect(error?.message || "Realtime connection closed");
          }
        },
      });
    }).catch((error: unknown) => {
      if (!signal.aborted && selectedGeneration === generation) {
        reconnect(error instanceof Error ? error.message : String(error));
      }
    });
  };

  connect();
  return { close, done };
};

export async function* watchCodingRealtime(input: Omit<CodingRealtimeSubscriptionOptions, "onSnapshot">): AsyncGenerator<CodingCliRunSnapshot> {
  const pending: CodingCliRunSnapshot[] = [];
  let wake: (() => void) | undefined;
  const attachment = subscribeCodingRealtime({
    ...input,
    onSnapshot: (snapshot) => {
      pending.push(snapshot);
      wake?.();
      wake = undefined;
    },
  });
  try {
    while (!input.signal?.aborted) {
      const snapshot = pending.shift();
      if (snapshot) {
        yield snapshot;
        continue;
      }
      await Promise.race([
        new Promise<void>((resolve) => { wake = resolve; }),
        attachment.done,
      ]);
      if (pending.length === 0) return;
    }
  } finally {
    attachment.close();
  }
}
