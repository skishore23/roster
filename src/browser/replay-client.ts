import { SenderError } from "spacetimedb";

import {
  DbConnection,
  tables,
  type SubscriptionHandle,
} from "../spacetimedb-bindings/index.js";
import type {
  EventStreamProjection,
  StreamReceiptProjection,
} from "../spacetimedb-bindings/types.js";
import type { InspectorEvent } from "../modules/inspector.js";
import { inspectorAnalysisStream } from "../agents/inspector.streams.js";
import {
  buildReceiptChatItems,
  buildReceiptInspectorSnapshot,
  receiptChatHtml,
  receiptFoldsHtml,
  receiptSideHtml,
  receiptTimelineHtml,
  type InspectorEventReceipt,
  type ReceiptEvidenceItem,
  type ReceiptStreamInfo,
} from "../views/receipt.js";
import { createReplayController, type ReplayController } from "./replay-controller.js";

type ReplayBootConfig = {
  readonly domain: "replay";
  readonly stream: string;
  readonly workspaceId: string;
  readonly capabilitySecret?: string;
  readonly capabilityHash?: string;
  readonly realtime: {
    readonly enabled: boolean;
    readonly uri: string;
    readonly database: string;
    readonly confirmedReads: boolean;
  };
};

type ReplayOptions = {
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly depth: number;
};

type ConnectionState = "connecting" | "syncing" | "live" | "reconnecting" | "error" | "disabled";

const BOOT_ID = "roster-realtime-boot";
const MAX_IDENTIFIER_LENGTH = 512;
const INSPECTOR_STREAM_PREFIX = "agents/inspector/by-source/";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (record: Readonly<Record<string, unknown>>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`Replay boot field ${key} is missing or invalid`);
  }
  return value;
};

const optionalString = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`Replay boot field ${key} is invalid`);
  }
  return value;
};

export const parseReplayBootConfig = (encoded: string): ReplayBootConfig => {
  const parsed: unknown = JSON.parse(encoded);
  if (!isRecord(parsed) || parsed.domain !== "replay" || !isRecord(parsed.realtime)) {
    throw new Error("Replay boot configuration is invalid");
  }
  if (typeof parsed.realtime.enabled !== "boolean" || typeof parsed.realtime.confirmedReads !== "boolean") {
    throw new Error("Replay realtime flags are invalid");
  }
  return {
    domain: "replay",
    stream: requiredString(parsed, "stream"),
    workspaceId: requiredString(parsed, "workspaceId"),
    capabilitySecret: optionalString(parsed, "capabilitySecret"),
    capabilityHash: optionalString(parsed, "capabilityHash"),
    realtime: {
      enabled: parsed.realtime.enabled,
      uri: requiredString(parsed.realtime, "uri"),
      database: requiredString(parsed.realtime, "database"),
      confirmedReads: parsed.realtime.confirmedReads,
    },
  };
};

const readBootConfig = (): ReplayBootConfig | undefined => {
  const node = document.getElementById(BOOT_ID);
  if (!node?.textContent) return undefined;
  try {
    return parseReplayBootConfig(node.textContent);
  } finally {
    node.remove();
  }
};

const optionsFromUrl = (): ReplayOptions => {
  const query = new URL(window.location.href).searchParams;
  const rawLimit = Number(query.get("limit") ?? 200);
  const rawDepth = Number(query.get("depth") ?? 2);
  return {
    order: query.get("order") === "asc" ? "asc" : "desc",
    limit: Number.isFinite(rawLimit) ? Math.max(10, Math.min(Math.floor(rawLimit), 5_000)) : 200,
    depth: [1, 2, 3].includes(rawDepth) ? rawDepth : 2,
  };
};

const cursorFromUrl = (): bigint | null => {
  const url = new URL(window.location.href);
  const encoded = url.searchParams.get("at");
  if (encoded === null) return null;
  if (/^(0|[1-9][0-9]*)$/.test(encoded)) return BigInt(encoded);
  url.searchParams.delete("at");
  window.history.replaceState(window.history.state, "", url);
  return null;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const authStorageKey = (boot: ReplayBootConfig): string =>
  `roster:spacetimedb:auth:${encodeURIComponent(boot.realtime.uri)}:${encodeURIComponent(boot.realtime.database)}`;

const readToken = (boot: ReplayBootConfig): string | undefined => {
  try {
    return window.localStorage.getItem(authStorageKey(boot)) ?? undefined;
  } catch {
    return undefined;
  }
};

const saveToken = (boot: ReplayBootConfig, token: string): void => {
  try {
    window.localStorage.setItem(authStorageKey(boot), token);
  } catch {
    // The active socket remains authorized when storage is unavailable.
  }
};

const setConnectionState = (state: ConnectionState, label: string, detail: string): void => {
  const node = document.querySelector<HTMLElement>("[data-roster-connection]");
  if (node) {
    node.dataset.state = state;
    node.dataset.tone = state === "live" ? "live" : state === "error" || state === "disabled" ? "danger" : "warning";
    node.textContent = label;
    node.title = detail;
  }
  document.body.dataset.realtimeState = state;
  for (const panel of document.querySelectorAll<HTMLElement>("#receipt-chat, #receipt-folds, #receipt-timeline, #receipt-side")) {
    panel.setAttribute("aria-busy", String(state === "connecting" || state === "syncing" || state === "reconnecting"));
  }
};

const parseBody = (row: StreamReceiptProjection): Readonly<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(row.bodyJson);
    return isRecord(parsed) ? parsed : { type: "receipt.invalid", error: "Receipt body is not an object" };
  } catch {
    return { type: "receipt.invalid", error: "Receipt body is not valid JSON" };
  }
};

const asInspectorEvent = (body: Readonly<Record<string, unknown>>): InspectorEvent | undefined => {
  const known = new Set([
    "context.set",
    "tool.called",
    "question.set",
    "timeline.set",
    "analysis.set",
    "run.status",
    "run.configured",
  ]);
  if (typeof body.type !== "string" || !known.has(body.type) || typeof body.runId !== "string") return undefined;
  if (body.type === "context.set") {
    if (!isRecord(body.source) || body.source.kind !== "stream" || typeof body.source.name !== "string") return undefined;
  }
  return body as unknown as InspectorEvent;
};

export const buildReplayTimeline = (
  rows: ReadonlyArray<StreamReceiptProjection>,
  depth: number,
): Array<{ readonly label: string; readonly count: number }> => {
  const level = Math.max(1, Math.min(depth, 3));
  const counts = new Map<string, number>();
  for (const row of rows) {
    const body = parseBody(row);
    const type = typeof body.type === "string" ? body.type : "receipt";
    const prefix = type.split(".")[0] || type;
    const actor = typeof body.agentId === "string"
      ? body.agentId
      : typeof body.agent === "string"
        ? body.agent
        : typeof body.role === "string"
          ? body.role
          : "";
    const label = level === 1 ? "run" : level === 2 ? prefix : actor ? `${prefix}/${actor}` : prefix;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
};

export const hasLinkedProjection = (rows: ReadonlyArray<StreamReceiptProjection>): boolean => {
  let previous = "";
  let sequence = 1n;
  for (const row of rows) {
    if (row.seq !== sequence || row.prevHash !== previous) return false;
    previous = row.hash;
    sequence += 1n;
  }
  return true;
};

const streamInfo = (row: EventStreamProjection): ReceiptStreamInfo => ({
  streamId: row.streamId,
  kind: row.kind,
  receiptCount: row.receiptCount,
  parentStreamId: row.parentStreamId || undefined,
  updatedAtMs: Number(row.updatedAt.microsSinceUnixEpoch / 1_000n),
});

const replaceHtml = (id: string, value: string, previous: Map<string, string>): void => {
  const root = document.getElementById(id);
  if (!(root instanceof HTMLElement) || previous.get(id) === value) return;
  const open = new Set([...root.querySelectorAll<HTMLDetailsElement>("details[open]")]
    .map((detail) => detail.dataset.detailId)
    .filter((detailId): detailId is string => Boolean(detailId)));
  const scrollTop = root.scrollTop;
  root.innerHTML = value;
  previous.set(id, value);
  for (const detail of root.querySelectorAll<HTMLDetailsElement>("details[data-detail-id]")) {
    if (detail.dataset.detailId && open.has(detail.dataset.detailId)) detail.open = true;
  }
  root.scrollTop = scrollTop;
  root.dispatchEvent(new CustomEvent("roster:panel-rendered", { bubbles: true }));
};

const orderedRows = (
  rows: ReadonlyMap<string, StreamReceiptProjection>,
  workspaceId: string,
): StreamReceiptProjection[] => [...rows.values()]
  .filter((row) => row.workspaceId === workspaceId)
  .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);

const startReplayClient = async (boot: ReplayBootConfig): Promise<void> => {
  const options = optionsFromUrl();
  const streams = new Map<string, EventStreamProjection>();
  const selectedRows = new Map<string, StreamReceiptProjection>();
  const inspectorRows = new Map<string, StreamReceiptProjection>();
  const previousHtml = new Map<string, string>();
  let requestedSelection = new URL(window.location.href).searchParams.get("stream")?.trim() || undefined;
  let selectedStream = requestedSelection;
  let cursor = cursorFromUrl();
  let connection: DbConnection | undefined;
  let catalogSubscription: SubscriptionHandle | undefined;
  let receiptSubscription: SubscriptionHandle | undefined;
  let replay: ReplayController | undefined;
  let reconnectTimer: number | undefined;
  let reconnectAttempt = 0;
  let generation = 0;
  let catalogApplied = false;
  let receiptsApplied = false;
  let renderQueued = false;
  let closing = false;
  let accessDenied = false;
  let sessionToken = readToken(boot);
  const capabilityHash = boot.capabilitySecret
    ? await sha256Hex(boot.capabilitySecret)
    : boot.capabilityHash;
  const selectedInspectorStream = (): string | undefined =>
    selectedStream ? inspectorAnalysisStream(selectedStream) : undefined;

  const replayRoot = document.getElementById("receipt-travel");
  if (replayRoot instanceof HTMLElement) {
    replay = createReplayController({
      root: replayRoot,
      onCursorChange: (next) => {
        cursor = next;
        const at = document.getElementById("receipt-analysis-at");
        if (at instanceof HTMLInputElement) at.value = next?.toString() ?? "";
        render();
      },
    });
  }

  const updateSelectionUi = (): void => {
    const input = document.getElementById("receipt-analysis-stream");
    if (input instanceof HTMLInputElement) input.value = selectedStream ?? "";
    const button = document.getElementById("receipt-analyze");
    if (button instanceof HTMLButtonElement) {
      button.disabled = !selectedStream;
      button.classList.toggle("disabled", !selectedStream);
    }
  };

  const renderNow = (): void => {
    renderQueued = false;
    if (!catalogApplied) return;
    const allRows = orderedRows(selectedRows, boot.workspaceId);
    const frontier = cursor === null ? allRows : allRows.filter((row) => row.seq <= cursor!);
    const visible = options.order === "desc"
      ? frontier.slice(-options.limit).reverse()
      : frontier.slice(0, options.limit);
    const evidence: ReceiptEvidenceItem[] = visible.map((row) => ({
      seq: row.seq,
      occurredAtMs: row.occurredAtMs,
      hash: row.hash,
      prevHash: row.prevHash,
      body: parseBody(row),
    }));
    const inspectorEvents: InspectorEventReceipt[] = orderedRows(inspectorRows, boot.workspaceId).flatMap((row) => {
      const event = asInspectorEvent(parseBody(row));
      return event ? [{ ts: Number(row.occurredAtMs), body: event }] : [];
    });
    const baseSnapshot = selectedStream
      ? buildReceiptInspectorSnapshot(inspectorEvents, selectedStream)
      : { status: "idle" as const };
    const buckets = buildReplayTimeline(frontier, options.depth);
    const snapshot = {
      ...baseSnapshot,
      context: selectedStream ? {
        name: selectedStream,
        total: allRows.length,
        shown: visible.length,
        order: options.order,
        limit: options.limit,
      } : undefined,
      timeline: { depth: options.depth, buckets },
    };

    replaceHtml(
      "receipt-folds",
      receiptFoldsHtml(
        [...streams.values()]
          .filter((stream) => stream.workspaceId === boot.workspaceId && !stream.streamId.startsWith(INSPECTOR_STREAM_PREFIX))
          .map(streamInfo),
        selectedStream,
        options.order,
        options.limit,
        options.depth,
      ),
      previousHtml,
    );
    replaceHtml(
      "receipt-chat",
      receiptChatHtml({
        selected: selectedStream,
        items: selectedStream ? buildReceiptChatItems(inspectorEvents, selectedStream) : [],
      }),
      previousHtml,
    );
    replaceHtml(
      "receipt-timeline",
      receiptTimelineHtml({
        selected: selectedStream,
        order: options.order,
        limit: options.limit,
        depth: options.depth,
        at: cursor,
        total: allRows.length,
        buckets,
      }),
      previousHtml,
    );
    replaceHtml(
      "receipt-side",
      receiptSideHtml({
        selected: selectedStream,
        order: options.order,
        limit: options.limit,
        depth: options.depth,
        snapshot,
        receipts: evidence,
        chainStatus: allRows.length === 0 ? "empty" : hasLinkedProjection(allRows) ? "linked" : "broken",
      }),
      previousHtml,
    );
    replay?.update({
      sequences: allRows.map((row) => row.seq),
      cursor,
      label: selectedStream
        ? cursor === null
          ? `Live · ${allRows.length} receipts`
          : `Replay #${cursor.toString()} · ${frontier.length}/${allRows.length}`
        : "No stream selected",
    });
    updateSelectionUi();
  };

  function render(): void {
    if (!catalogApplied || renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(renderNow);
  }

  const chooseFallbackStream = (): string | undefined => {
    const candidates = [...streams.values()].filter((stream) => stream.workspaceId === boot.workspaceId).sort((left, right) => {
      const receiptOrder = left.receiptCount > right.receiptCount ? -1 : left.receiptCount < right.receiptCount ? 1 : 0;
      const updateOrder = left.updatedAt.microsSinceUnixEpoch > right.updatedAt.microsSinceUnixEpoch
        ? -1
        : left.updatedAt.microsSinceUnixEpoch < right.updatedAt.microsSinceUnixEpoch ? 1 : 0;
      return receiptOrder || updateOrder || left.streamId.localeCompare(right.streamId);
    });
    return candidates.find((stream) => !stream.streamId.startsWith(INSPECTOR_STREAM_PREFIX) && stream.receiptCount > 0n)?.streamId
      ?? candidates.find((stream) => !stream.streamId.startsWith(INSPECTOR_STREAM_PREFIX))?.streamId;
  };

  const writeSelectionUrl = (streamId: string | undefined): void => {
    const url = new URL(window.location.href);
    if (streamId) url.searchParams.set("stream", streamId);
    else url.searchParams.delete("stream");
    url.searchParams.delete("at");
    window.history.replaceState(window.history.state, "", url);
  };

  const hydrateRows = (next: DbConnection): void => {
    streams.clear();
    selectedRows.clear();
    inspectorRows.clear();
    for (const row of next.db.myEventStreams.iter()) {
      if (row.workspaceId === boot.workspaceId) streams.set(row.streamId, row);
    }
    for (const row of next.db.myStreamReceipts.iter()) {
      if (row.workspaceId !== boot.workspaceId) continue;
      if (row.streamId === selectedInspectorStream()) inspectorRows.set(row.id, row);
      if (row.streamId === selectedStream) selectedRows.set(row.id, row);
    }
  };

  const subscribeSelected = (next: DbConnection, currentGeneration: number): void => {
    try {
      if (receiptSubscription?.isActive()) receiptSubscription.unsubscribe();
    } catch {
      // The old selected-stream subscription may already be closed.
    }
    receiptSubscription = undefined;
    selectedRows.clear();
    inspectorRows.clear();
    receiptsApplied = !selectedStream;
    cursor = null;
    writeSelectionUrl(selectedStream);
    updateSelectionUi();
    if (!selectedStream) {
      render();
      setConnectionState("live", "Live", "The workspace contains no visible streams.");
      return;
    }
    setConnectionState("syncing", "Synchronizing", `Applying the durable ${selectedStream} receipt snapshot.`);
    receiptSubscription = next.subscriptionBuilder()
      .onApplied(() => {
        if (currentGeneration !== generation) return;
        selectedRows.clear();
        inspectorRows.clear();
        for (const row of next.db.myStreamReceipts.iter()) {
          if (row.workspaceId !== boot.workspaceId) continue;
          if (row.streamId === selectedStream) selectedRows.set(row.id, row);
          if (row.streamId === selectedInspectorStream()) inspectorRows.set(row.id, row);
        }
        receiptsApplied = true;
        reconnectAttempt = 0;
        renderNow();
        setConnectionState("live", "Live", `${selectedRows.size} caller-scoped receipts synchronized from SpacetimeDB.`);
      })
      .onError((context) => {
        if (currentGeneration !== generation) return;
        setConnectionState("error", "Stream interrupted", context.event?.message || "The selected stream subscription closed.");
        scheduleReconnect("The selected stream subscription closed.");
      })
      .subscribe([
        tables.myStreamReceipts.where((row) =>
          row.workspaceId.eq(boot.workspaceId).and(row.streamId.eq(selectedStream!))),
        tables.myStreamReceipts.where((row) =>
          row.workspaceId.eq(boot.workspaceId).and(row.streamId.eq(selectedInspectorStream()!))),
      ]);
  };

  const selectStream = (next: DbConnection, streamId: string | undefined, currentGeneration: number): void => {
    const allowed = streamId && streams.has(streamId) ? streamId : chooseFallbackStream();
    if (allowed === selectedStream && (receiptsApplied || receiptSubscription)) {
      render();
      return;
    }
    selectedStream = allowed;
    subscribeSelected(next, currentGeneration);
  };

  const registerCallbacks = (next: DbConnection, currentGeneration: number): void => {
    const active = (): boolean => currentGeneration === generation;
    next.db.myEventStreams.onInsert((_context, row) => {
      if (!active() || row.workspaceId !== boot.workspaceId) return;
      streams.set(row.streamId, row);
      if (!selectedStream) selectStream(next, row.streamId, currentGeneration);
      render();
    });
    next.db.myEventStreams.onUpdate((_context, oldRow, row) => {
      if (!active()) return;
      if (oldRow.workspaceId === boot.workspaceId) streams.delete(oldRow.streamId);
      if (row.workspaceId === boot.workspaceId) streams.set(row.streamId, row);
      render();
    });
    next.db.myEventStreams.onDelete((_context, row) => {
      if (!active() || row.workspaceId !== boot.workspaceId) return;
      streams.delete(row.streamId);
      if (selectedStream === row.streamId) selectStream(next, undefined, currentGeneration);
      render();
    });
    next.db.myStreamReceipts.onInsert((_context, row) => {
      if (!active() || row.workspaceId !== boot.workspaceId) return;
      if (row.streamId === selectedInspectorStream()) inspectorRows.set(row.id, row);
      if (row.streamId === selectedStream) selectedRows.set(row.id, row);
      render();
    });
    next.db.myStreamReceipts.onUpdate((_context, oldRow, row) => {
      if (!active()) return;
      if (oldRow.workspaceId === boot.workspaceId) {
        inspectorRows.delete(oldRow.id);
        selectedRows.delete(oldRow.id);
      }
      if (row.workspaceId === boot.workspaceId && row.streamId === selectedInspectorStream()) inspectorRows.set(row.id, row);
      if (row.workspaceId === boot.workspaceId && row.streamId === selectedStream) selectedRows.set(row.id, row);
      render();
    });
    next.db.myStreamReceipts.onDelete((_context, row) => {
      if (!active() || row.workspaceId !== boot.workspaceId) return;
      inspectorRows.delete(row.id);
      selectedRows.delete(row.id);
      render();
    });
  };

  const subscribeCatalog = async (next: DbConnection, currentGeneration: number): Promise<void> => {
    catalogApplied = false;
    receiptsApplied = false;
    setConnectionState("syncing", "Synchronizing", "Joining the workspace and applying the stream catalog.");
    if (capabilityHash) await next.reducers.joinWorkspace({ workspaceId: boot.workspaceId, capabilityHash });
    if (currentGeneration !== generation) return;
    registerCallbacks(next, currentGeneration);
    catalogSubscription = next.subscriptionBuilder()
      .onApplied(() => {
        if (currentGeneration !== generation) return;
        hydrateRows(next);
        catalogApplied = true;
        const requested = requestedSelection && streams.has(requestedSelection) ? requestedSelection : undefined;
        selectedStream = requested ?? (selectedStream && streams.has(selectedStream) ? selectedStream : undefined);
        selectStream(next, selectedStream, currentGeneration);
        renderNow();
      })
      .onError((context) => {
        if (currentGeneration !== generation) return;
        setConnectionState("error", "Catalog interrupted", context.event?.message || "The workspace subscription closed.");
        scheduleReconnect("The workspace catalog subscription closed.");
      })
      .subscribe([
        tables.myEventStreams.where((row) => row.workspaceId.eq(boot.workspaceId)),
      ]);
  };

  const scheduleReconnect = (reason: string): void => {
    if (closing || accessDenied || reconnectTimer !== undefined) return;
    catalogApplied = false;
    receiptsApplied = false;
    replay?.stop();
    reconnectAttempt += 1;
    const delay = Math.min(30_000, 700 * 2 ** Math.min(reconnectAttempt - 1, 5));
    setConnectionState("reconnecting", "Reconnecting", `${reason} Retrying in ${Math.ceil(delay / 1_000)} seconds.`);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (closing || accessDenied || !boot.realtime.enabled) return;
    const currentGeneration = generation + 1;
    generation = currentGeneration;
    try {
      if (catalogSubscription?.isActive()) catalogSubscription.unsubscribe();
      if (receiptSubscription?.isActive()) receiptSubscription.unsubscribe();
    } catch {
      // A disconnected socket may already have closed its subscriptions.
    }
    catalogSubscription = undefined;
    receiptSubscription = undefined;
    const prior = connection;
    connection = undefined;
    prior?.disconnect();
    replay?.stop();
    setConnectionState(reconnectAttempt ? "reconnecting" : "connecting", reconnectAttempt ? "Reconnecting" : "Connecting", `Opening ${boot.realtime.database}.`);
    connection = DbConnection.builder()
      .withUri(boot.realtime.uri)
      .withDatabaseName(boot.realtime.database)
      .withToken(sessionToken)
      .withConfirmedReads(boot.realtime.confirmedReads)
      .withLightMode(true)
      .onConnect((next, _identity, token) => {
        if (currentGeneration !== generation) {
          next.disconnect();
          return;
        }
        sessionToken = token;
        saveToken(boot, token);
        void subscribeCatalog(next, currentGeneration).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof SenderError) {
            accessDenied = true;
            setConnectionState("error", "Access denied", message);
          } else {
            scheduleReconnect(message || "Workspace synchronization failed.");
          }
          next.disconnect();
        });
      })
      .onConnectError((_context, error) => scheduleReconnect(error.message || "Connection failed."))
      .onDisconnect((_context, error) => scheduleReconnect(error?.message || "Connection closed."))
      .build();
  };

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-stream-id]") : null;
    if (!target || !connection || !catalogApplied) return;
    const streamId = target.dataset.streamId;
    if (!streamId || !streams.has(streamId)) return;
    event.preventDefault();
    requestedSelection = streamId;
    selectStream(connection, streamId, generation);
  });

  document.querySelector<HTMLFormElement>('form[action="/replay/inspect"]')?.addEventListener("submit", () => {
    const button = document.getElementById("receipt-analyze");
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
      button.textContent = "Queuing analysis…";
    }
  });

  window.addEventListener("beforeunload", () => {
    closing = true;
    generation += 1;
    replay?.dispose();
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    try {
      if (catalogSubscription?.isActive()) catalogSubscription.unsubscribe();
      if (receiptSubscription?.isActive()) receiptSubscription.unsubscribe();
    } catch {
      // The socket is already closing.
    }
    connection?.disconnect();
  }, { once: true });

  if (!boot.realtime.enabled) {
    setConnectionState("disabled", "Realtime unavailable", "SpacetimeDB is disabled for this environment.");
    return;
  }
  connect();
};

if (typeof document !== "undefined") {
  const boot = readBootConfig();
  if (boot) {
    void startReplayClient(boot).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionState("error", "Replay failed", message);
      console.error("Roster replay client failed to start", error);
    });
  }
}
