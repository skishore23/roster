import {
  DbConnection,
  tables,
  type SubscriptionHandle,
} from "../spacetimedb-bindings/index.js";
import { SenderError } from "spacetimedb";
import type { JobStatus } from "../modules/job.js";
import {
  memoryEntriesFromReceipts,
  projectMonitorCanvasRuns,
  projectMonitorJobs,
  renderMonitorActivity,
  renderMonitorFleet,
  renderMonitorJobDetail,
  renderMonitorMemory,
  renderMonitorQueue,
  renderMonitorReplay,
  selectedActivityStream,
  type MonitorJobCommandRow,
  type MonitorCanvasRunRow,
  type MonitorJobRow,
  type MonitorReceiptRow,
  type MonitorTimestamp,
} from "./monitor-renderers.js";
import { createReplayController } from "./replay-controller.js";

type MonitorBoot = {
  readonly workspaceId: string;
  readonly queueStream: string;
  readonly activityStream: string;
  readonly selectedJobId?: string;
  readonly memoryScope: string;
  readonly capabilitySecret?: string;
  readonly realtime: {
    readonly enabled: boolean;
    readonly uri: string;
    readonly database: string;
    readonly confirmedReads: boolean;
  };
};

type RosterJobEventRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly seq: bigint;
  readonly kind: string;
  readonly eventJson: string;
  readonly createdAt: MonitorTimestamp;
};

type ConnectionState = "connecting" | "syncing" | "live" | "reconnecting" | "error" | "disabled";

const BOOT_ID = "monitor-realtime-boot";
const MAX_IDENTIFIER = 512;
const TERMINAL = new Set<JobStatus>(["completed", "failed", "canceled"]);

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const required = (source: Readonly<Record<string, unknown>>, key: string): string => {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_IDENTIFIER) {
    throw new Error(`Monitor realtime field ${key} is invalid`);
  }
  return value;
};

const optional = (source: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = source[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_IDENTIFIER) {
    throw new Error(`Monitor realtime field ${key} is invalid`);
  }
  return value;
};

const readBoot = (): MonitorBoot | undefined => {
  const node = document.getElementById(BOOT_ID);
  if (!node?.textContent) return undefined;
  try {
    const value: unknown = JSON.parse(node.textContent);
    if (!record(value) || !record(value.realtime)) throw new Error("Monitor realtime boot must be an object");
    const enabled = value.realtime.enabled;
    const confirmedReads = value.realtime.confirmedReads;
    if (typeof enabled !== "boolean" || typeof confirmedReads !== "boolean") {
      throw new Error("Monitor realtime transport flags are invalid");
    }
    return {
      workspaceId: required(value, "workspaceId"),
      queueStream: required(value, "queueStream"),
      activityStream: required(value, "activityStream"),
      selectedJobId: optional(value, "selectedJobId"),
      memoryScope: optional(value, "memoryScope") ?? "agent",
      capabilitySecret: optional(value, "capabilitySecret"),
      realtime: {
        enabled,
        uri: required(value.realtime, "uri"),
        database: required(value.realtime, "database"),
        confirmedReads,
      },
    };
  } finally {
    node.remove();
  }
};

const timestampMs = (value: MonitorTimestamp): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.max(0, Math.floor(value)));
  return value.microsSinceUnixEpoch / 1_000n;
};

const jobEventReceipt = (row: RosterJobEventRow): MonitorReceiptRow => ({
  id: row.id,
  workspaceId: row.workspaceId,
  streamId: `jobs/${row.jobId}`,
  seq: row.seq,
  receiptId: row.id,
  occurredAtMs: timestampMs(row.createdAt),
  bodyJson: row.eventJson,
});

const statusNode = (): HTMLElement => {
  const existing = document.querySelector<HTMLElement>("[data-roster-connection]");
  if (existing) return existing;
  const output = document.createElement("output");
  output.className = "agent-status";
  output.dataset.rosterConnection = "";
  document.querySelector<HTMLElement>('[data-slot="agent-replay"]')?.prepend(output);
  return output;
};

const setConnectionState = (state: ConnectionState, label: string, detail: string): void => {
  const node = statusNode();
  node.dataset.state = state;
  node.dataset.tone = state === "live" ? "live" : state === "error" || state === "disabled" ? "danger" : "warning";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.textContent = label;
  node.title = detail;
  document.body.dataset.realtimeState = state;
  for (const id of ["monitor-jobs", "monitor-agents", "monitor-activity", "monitor-memory", "monitor-replay-frame"]) {
    document.getElementById(id)?.setAttribute("aria-busy", String(state === "connecting" || state === "syncing" || state === "reconnecting"));
  }
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const tokenKey = (boot: MonitorBoot): string =>
  `roster:spacetimedb:auth:${encodeURIComponent(boot.realtime.uri)}:${encodeURIComponent(boot.realtime.database)}`;

const storedToken = (boot: MonitorBoot): string | undefined => {
  try {
    return window.localStorage.getItem(tokenKey(boot)) ?? undefined;
  } catch {
    return undefined;
  }
};

const storeToken = (boot: MonitorBoot, token: string): void => {
  try {
    window.localStorage.setItem(tokenKey(boot), token);
  } catch {
    // The current connection remains authorized when persistence is unavailable.
  }
};

const parseCursor = (): bigint | null => {
  const url = new URL(window.location.href);
  const encoded = url.searchParams.get("at");
  if (encoded && /^(0|[1-9][0-9]*)$/.test(encoded)) return BigInt(encoded);
  if (encoded) {
    url.searchParams.delete("at");
    window.history.replaceState(window.history.state, "", url);
  }
  return null;
};

const safeMemoryScope = (value: string): string =>
  (value || "agent").toLowerCase().replace(/[^a-z0-9_.-/]/g, "_").slice(0, 200);

const startMonitor = async (boot: MonitorBoot): Promise<void> => {
  const jobRows = new Map<string, MonitorJobRow>();
  const canvasRunRows = new Map<string, MonitorCanvasRunRow>();
  const commandRows = new Map<string, MonitorJobCommandRow>();
  const jobEventRows = new Map<string, RosterJobEventRow>();
  const streamRows = new Map<string, MonitorReceiptRow>();
  let connection: DbConnection | undefined;
  let baseSubscription: SubscriptionHandle | undefined;
  let detailSubscription: SubscriptionHandle | undefined;
  let connectionGeneration = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: number | undefined;
  let renderFrame = 0;
  let closing = false;
  let accessDenied = false;
  let baseReady = false;
  let sessionToken = storedToken(boot);
  let selectedJobId = boot.selectedJobId ?? new URL(window.location.href).searchParams.get("job") ?? "";
  let cursor = parseCursor();
  let memoryScope = safeMemoryScope(boot.memoryScope);
  let memoryQuery = "";
  let statusFilter = "" as JobStatus | "";
  let limit = 80;
  let drawerOpen = Boolean(selectedJobId);
  let subscribedDetailKey = "";
  const capabilityHash = boot.capabilitySecret ? await sha256Hex(boot.capabilitySecret) : undefined;

  const replayRoot = document.getElementById("monitor-travel");
  const replay = replayRoot instanceof HTMLElement
    ? createReplayController({
      root: replayRoot,
      onCursorChange: (next) => {
        cursor = next;
        scheduleRender();
      },
    })
    : undefined;

  const jobs = () => [
    ...projectMonitorJobs([...jobRows.values()], [...commandRows.values()], boot.workspaceId),
    ...projectMonitorCanvasRuns([...canvasRunRows.values()], boot.workspaceId),
  ].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  const selectedJob = () => jobs().find((job) => job.id === selectedJobId);
  const activityStream = () => selectedActivityStream(selectedJob(), boot.activityStream);
  const memoryStream = () => `memory/${memoryScope}`;

  const setHtml = (id: string, value: string): void => {
    const element = document.getElementById(id);
    if (element && element.innerHTML !== value) element.innerHTML = value;
  };

  const syncDrawer = (): void => {
    const drawer = document.getElementById("monitor-detail-drawer");
    if (!drawer) return;
    const open = drawerOpen && Boolean(selectedJobId);
    drawer.classList.toggle("is-open", open);
    drawer.setAttribute("aria-hidden", String(!open));
    drawer.toggleAttribute("inert", !open);
  };

  const syncUrl = (): void => {
    const url = new URL(window.location.href);
    if (selectedJobId) url.searchParams.set("job", selectedJobId);
    else url.searchParams.delete("job");
    if (statusFilter) url.searchParams.set("status", statusFilter);
    else url.searchParams.delete("status");
    if (limit !== 80) url.searchParams.set("limit", String(limit));
    else url.searchParams.delete("limit");
    window.history.replaceState(window.history.state, "", url);
  };

  const render = (): void => {
    renderFrame = 0;
    if (!baseReady) return;
    const projected = jobs();
    if (!selectedJobId || !projected.some((job) => job.id === selectedJobId)) {
      selectedJobId = projected.find((job) => !TERMINAL.has(job.status))?.id ?? projected[0]?.id ?? "";
      drawerOpen = false;
      cursor = null;
    }
    const selected = selectedJob();
    setHtml("monitor-jobs", renderMonitorQueue(projected, {
      selectedJobId,
      status: statusFilter || undefined,
      limit,
    }));
    setHtml("monitor-agents", renderMonitorFleet(projected));
    setHtml("monitor-job-detail", renderMonitorJobDetail(selected));
    const replayView = renderMonitorReplay(
      selected,
      [...jobEventRows.values()]
        .filter((row) => row.workspaceId === boot.workspaceId && row.jobId === selectedJobId)
        .map(jobEventReceipt),
      cursor,
      boot.workspaceId,
    );
    setHtml("monitor-replay-frame", replayView.html);
    replay?.update({ sequences: replayView.sequences, cursor, label: replayView.label });
    const activity = [...streamRows.values()].filter((row) =>
      row.workspaceId === boot.workspaceId && row.streamId === activityStream());
    setHtml("monitor-activity", renderMonitorActivity(activity, boot.workspaceId));
    const memory = memoryEntriesFromReceipts(
      [...streamRows.values()].filter((row) =>
        row.workspaceId === boot.workspaceId && row.streamId === memoryStream()),
      boot.workspaceId,
    );
    setHtml("monitor-memory", renderMonitorMemory(memory, memoryQuery));
    syncDrawer();
    syncUrl();
    void subscribeDetail();
  };

  function scheduleRender(): void {
    if (!baseReady || renderFrame) return;
    renderFrame = window.requestAnimationFrame(render);
  }

  const clearDetailCache = (): void => {
    commandRows.clear();
    jobEventRows.clear();
    streamRows.clear();
  };

  const hydrateBase = (next: DbConnection): void => {
    jobRows.clear();
    canvasRunRows.clear();
    for (const row of next.db.myRosterJobs.iter()) {
      if (row.workspaceId === boot.workspaceId) jobRows.set(row.id, row);
    }
    for (const row of next.db.myCanvasFleetRuns.iter()) {
      if (row.workspaceId === boot.workspaceId) canvasRunRows.set(row.id, row as MonitorCanvasRunRow);
    }
  };

  const hydrateDetail = (next: DbConnection): void => {
    clearDetailCache();
    for (const row of next.db.myRosterJobCommands.iter()) {
      if (row.workspaceId === boot.workspaceId && row.jobId === selectedJobId) commandRows.set(row.id, row);
    }
    for (const row of next.db.myRosterJobEvents.iter()) {
      if (row.workspaceId === boot.workspaceId && row.jobId === selectedJobId) jobEventRows.set(row.id, row);
    }
    const streams = new Set([activityStream(), memoryStream()]);
    for (const row of next.db.myStreamReceipts.iter()) {
      if (row.workspaceId === boot.workspaceId && streams.has(row.streamId)) streamRows.set(row.id, row);
    }
  };

  const registerCallbacks = (next: DbConnection, generation: number): void => {
    const current = () => generation === connectionGeneration;
    next.db.myRosterJobs.onInsert((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      jobRows.set(row.id, row);
      scheduleRender();
    });
    next.db.myRosterJobs.onUpdate((_context, oldRow, row) => {
      if (!current()) return;
      if (oldRow.workspaceId === boot.workspaceId) jobRows.delete(oldRow.id);
      if (row.workspaceId === boot.workspaceId) jobRows.set(row.id, row);
      scheduleRender();
    });
    next.db.myRosterJobs.onDelete((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      jobRows.delete(row.id);
      scheduleRender();
    });
    next.db.myCanvasFleetRuns.onInsert((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      canvasRunRows.set(row.id, row as MonitorCanvasRunRow);
      scheduleRender();
    });
    next.db.myCanvasFleetRuns.onUpdate((_context, oldRow, row) => {
      if (!current()) return;
      if (oldRow.workspaceId === boot.workspaceId) canvasRunRows.delete(oldRow.id);
      if (row.workspaceId === boot.workspaceId) canvasRunRows.set(row.id, row as MonitorCanvasRunRow);
      scheduleRender();
    });
    next.db.myCanvasFleetRuns.onDelete((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      canvasRunRows.delete(row.id);
      scheduleRender();
    });
    next.db.myRosterJobCommands.onInsert((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId || row.jobId !== selectedJobId) return;
      commandRows.set(row.id, row);
      scheduleRender();
    });
    next.db.myRosterJobCommands.onUpdate((_context, oldRow, row) => {
      if (!current()) return;
      if (oldRow.workspaceId === boot.workspaceId) commandRows.delete(oldRow.id);
      if (row.workspaceId === boot.workspaceId && row.jobId === selectedJobId) commandRows.set(row.id, row);
      scheduleRender();
    });
    next.db.myRosterJobCommands.onDelete((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      commandRows.delete(row.id);
      scheduleRender();
    });
    next.db.myRosterJobEvents.onInsert((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId || row.jobId !== selectedJobId) return;
      jobEventRows.set(row.id, row);
      scheduleRender();
    });
    next.db.myRosterJobEvents.onDelete((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      jobEventRows.delete(row.id);
      scheduleRender();
    });
    next.db.myStreamReceipts.onInsert((_context, row) => {
      if (
        !current()
        || row.workspaceId !== boot.workspaceId
        || (row.streamId !== activityStream() && row.streamId !== memoryStream())
      ) return;
      streamRows.set(row.id, row);
      scheduleRender();
    });
    next.db.myStreamReceipts.onUpdate((_context, oldRow, row) => {
      if (!current()) return;
      if (oldRow.workspaceId === boot.workspaceId) streamRows.delete(oldRow.id);
      if (
        row.workspaceId === boot.workspaceId
        && (row.streamId === activityStream() || row.streamId === memoryStream())
      ) streamRows.set(row.id, row);
      scheduleRender();
    });
    next.db.myStreamReceipts.onDelete((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      streamRows.delete(row.id);
      scheduleRender();
    });
  };

  async function subscribeDetail(): Promise<void> {
    const next = connection;
    if (!next || !baseReady) return;
    const key = [boot.workspaceId, selectedJobId, activityStream(), memoryStream()].join("\u0000");
    if (key === subscribedDetailKey) return;
    subscribedDetailKey = key;
    replay?.stop();
    try {
      if (detailSubscription?.isActive()) detailSubscription.unsubscribe();
    } catch {
      // The connection may already have removed the previous scoped snapshot.
    }
    clearDetailCache();
    const queries = [
      ...(selectedJobId && !selectedJobId.startsWith("canvas:") ? [
        tables.myRosterJobCommands.where((row) =>
          row.workspaceId.eq(boot.workspaceId).and(row.jobId.eq(selectedJobId))),
        tables.myRosterJobEvents.where((row) =>
          row.workspaceId.eq(boot.workspaceId).and(row.jobId.eq(selectedJobId))),
      ] : []),
      ...[...new Set([activityStream(), memoryStream()])].map((streamId) =>
        tables.myStreamReceipts.where((row) =>
          row.workspaceId.eq(boot.workspaceId).and(row.streamId.eq(streamId)))),
    ];
    setConnectionState("syncing", "Synchronizing", "Applying selected job, activity, and memory snapshots.");
    detailSubscription = next.subscriptionBuilder()
      .onApplied(() => {
        if (next !== connection || key !== subscribedDetailKey) return;
        hydrateDetail(next);
        scheduleRender();
        setConnectionState("live", "Live", "Fleet projections and selected replay are synchronized directly from SpacetimeDB.");
      })
      .onError((context) => {
        if (next !== connection) return;
        setConnectionState("error", "View interrupted", context.event?.message || "The selected realtime view closed.");
      })
      .subscribe(queries);
  }

  const subscribeBase = async (next: DbConnection, generation: number): Promise<void> => {
    baseReady = false;
    setConnectionState("syncing", "Synchronizing", "Joining the workspace and applying the fleet snapshot.");
    if (capabilityHash) await next.reducers.joinWorkspace({ workspaceId: boot.workspaceId, capabilityHash });
    if (generation !== connectionGeneration) return next.disconnect();
    registerCallbacks(next, generation);
    baseSubscription = next.subscriptionBuilder()
      .onApplied(() => {
        if (generation !== connectionGeneration) return;
        reconnectAttempt = 0;
        hydrateBase(next);
        baseReady = true;
        subscribedDetailKey = "";
        render();
      })
      .onError((context) => {
        if (generation !== connectionGeneration) return;
        scheduleReconnect(context.event?.message || "Fleet subscription closed.");
      })
      .subscribe([
        tables.myRosterJobs.where((row) => row.workspaceId.eq(boot.workspaceId)),
        tables.myCanvasFleetRuns.where((row) => row.workspaceId.eq(boot.workspaceId)),
      ]);
  };

  const scheduleReconnect = (reason: string): void => {
    if (closing || accessDenied || reconnectTimer !== undefined) return;
    baseReady = false;
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
    const generation = ++connectionGeneration;
    try { if (detailSubscription?.isActive()) detailSubscription.unsubscribe(); } catch { /* closed */ }
    try { if (baseSubscription?.isActive()) baseSubscription.unsubscribe(); } catch { /* closed */ }
    detailSubscription = undefined;
    baseSubscription = undefined;
    subscribedDetailKey = "";
    const previous = connection;
    connection = undefined;
    previous?.disconnect();
    setConnectionState(reconnectAttempt ? "reconnecting" : "connecting", reconnectAttempt ? "Reconnecting" : "Connecting", `Opening ${boot.realtime.database}.`);
    try {
      connection = DbConnection.builder()
        .withUri(boot.realtime.uri)
        .withDatabaseName(boot.realtime.database)
        .withToken(sessionToken)
        .withConfirmedReads(boot.realtime.confirmedReads)
        .withLightMode(true)
        .onConnect((next, _identity, token) => {
          if (generation !== connectionGeneration) return next.disconnect();
          sessionToken = token;
          storeToken(boot, token);
          void subscribeBase(next, generation).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof SenderError) {
              accessDenied = true;
              setConnectionState("error", "Access denied", message);
            } else scheduleReconnect(message || "Workspace synchronization failed.");
            next.disconnect();
          });
        })
        .onConnectError((_context, error) => {
          if (generation === connectionGeneration) scheduleReconnect(error.message || "Connection failed.");
        })
        .onDisconnect((_context, error) => {
          if (generation === connectionGeneration) scheduleReconnect(error?.message || "Connection closed.");
        })
        .build();
    } catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  };

  const selectJob = (jobId: string, open: boolean): void => {
    if (jobId === selectedJobId && (!open || drawerOpen)) return;
    selectedJobId = jobId;
    drawerOpen = open;
    cursor = null;
    replay?.stop();
    const url = new URL(window.location.href);
    url.searchParams.delete("at");
    window.history.replaceState(window.history.state, "", url);
    subscribedDetailKey = "";
    scheduleRender();
  };

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    if (!target) return;
    const jobButton = target.closest<HTMLElement>("[data-job-select]");
    if (jobButton?.dataset.jobSelect) return selectJob(jobButton.dataset.jobSelect, true);
    const replayButton = target.closest<HTMLElement>("[data-monitor-replay-seq]");
    if (replayButton?.dataset.monitorReplaySeq) {
      replay?.stop();
      cursor = BigInt(replayButton.dataset.monitorReplaySeq);
      const url = new URL(window.location.href);
      url.searchParams.set("at", cursor.toString());
      window.history.replaceState(window.history.state, "", url);
      scheduleRender();
      return;
    }
    if (target.closest("#monitor-detail-close, #monitor-detail-backdrop")) {
      drawerOpen = false;
      syncDrawer();
      return;
    }
    if (target.closest("#monitor-jobs-clear")) {
      selectedJobId = "";
      drawerOpen = false;
      cursor = null;
      subscribedDetailKey = "";
      scheduleRender();
      return;
    }
    if (target.closest("#monitor-jobs-abort") && selectedJobId) {
      const form = document.querySelector<HTMLFormElement>('#monitor-job-detail form[action*="/abort?"]');
      form?.requestSubmit();
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.id === "monitor-jobs-status") {
      statusFilter = target.value as JobStatus | "";
      scheduleRender();
    } else if (target instanceof HTMLInputElement && target.id === "monitor-jobs-limit") {
      limit = Math.max(10, Math.min(Number(target.value) || 80, 240));
      target.value = String(limit);
      scheduleRender();
    } else if (target instanceof HTMLInputElement && target.id === "monitor-memory-scope") {
      memoryScope = safeMemoryScope(target.value);
      target.value = memoryScope;
      subscribedDetailKey = "";
      scheduleRender();
    }
  });

  document.getElementById("monitor-memory-search")?.addEventListener("click", () => {
    const query = document.getElementById("monitor-memory-query");
    memoryQuery = query instanceof HTMLInputElement ? query.value.trim() : "";
    scheduleRender();
  });
  document.getElementById("monitor-memory-query")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    memoryQuery = event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value.trim() : "";
    scheduleRender();
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-monitor-command-form")) return;
    event.preventDefault();
    const output = document.getElementById("monitor-command-status");
    if (output) output.textContent = "Queuing command…";
    void fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      headers: { "X-Requested-With": "fetch" },
    }).then(async (response) => {
      const message = (await response.text()) || (response.ok ? "Command queued." : "Command failed.");
      if (output) output.textContent = message;
      if (response.ok) form.reset();
    }).catch(() => {
      if (output) output.textContent = "Command request failed.";
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawerOpen) {
      drawerOpen = false;
      syncDrawer();
    }
  });

  window.addEventListener("beforeunload", () => {
    closing = true;
    connectionGeneration += 1;
    replay?.dispose();
    if (renderFrame) window.cancelAnimationFrame(renderFrame);
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    try { if (detailSubscription?.isActive()) detailSubscription.unsubscribe(); } catch { /* closed */ }
    try { if (baseSubscription?.isActive()) baseSubscription.unsubscribe(); } catch { /* closed */ }
    connection?.disconnect();
  }, { once: true });

  if (!boot.realtime.enabled) {
    setConnectionState("disabled", "Realtime unavailable", "SpacetimeDB is disabled for this environment.");
    return;
  }
  connect();
};

const boot = readBoot();
if (boot) {
  void startMonitor(boot).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setConnectionState("error", "Realtime failed", message);
    console.error("Roster monitor realtime failed", error);
  });
}
