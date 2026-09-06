import {
  DbConnection,
  tables,
  type SubscriptionHandle,
} from "../spacetimedb-bindings/index.js";
import { SenderError } from "spacetimedb";
import {
  renderAxiomSimplePanels,
  renderAxiomWorkerPanels,
  renderTheoremPanels,
  renderWriterPanels,
  type RosterPanels,
  type RealtimeBranchRow,
  type RealtimeReceiptRow,
} from "./roster-renderers.js";
import {
  createReplayController,
  type ReplayController,
} from "./replay-controller.js";

export type RosterRealtimeDomain = "theorem" | "axiom" | "writer" | "axiom-simple";
export type RosterRealtimeSurface = "axiom-worker";

export type RosterRealtimeTransportConfig = {
  readonly enabled?: boolean;
  readonly uri: string;
  readonly database: string;
  readonly confirmedReads: boolean;
};

type RosterRealtimeBootBase = {
  readonly domain: RosterRealtimeDomain;
  readonly stream: string;
  readonly runId?: string;
  readonly runStream?: string;
  readonly branchStream?: string;
  readonly surface?: RosterRealtimeSurface;
  readonly workspaceId: string;
  readonly capabilitySecret?: string;
  readonly capabilityHash?: string;
  readonly capabilityFragmentParam?: string;
};

/**
 * JSON contract emitted in `<script id="roster-realtime-boot" type="application/json">`.
 *
 * Prefer a capability secret in the URL fragment (the default key is `access`).
 * `capabilitySecret` exists for short-lived server-rendered handoffs, and
 * `capabilityHash` is itself a bearer credential rather than an at-rest secret.
 */
export type RosterRealtimeBootConfig = RosterRealtimeBootBase & (
  | ({ readonly realtime: RosterRealtimeTransportConfig } & Partial<RosterRealtimeTransportConfig>)
  | ({ readonly realtime?: undefined } & RosterRealtimeTransportConfig)
);

type ResolvedRosterRealtimeBootConfig = RosterRealtimeBootBase & RosterRealtimeTransportConfig;

type EventStreamRow = {
  readonly workspaceId: string;
  readonly streamId: string;
};

type RosterJobRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly lastError: string;
};

type ConnectionState = "connecting" | "syncing" | "live" | "reconnecting" | "error" | "disabled";

type PanelPrefix = "tg" | "wg" | "as" | "aw";

type FocusSnapshot = {
  readonly id?: string;
  readonly name?: string;
  readonly href?: string;
  readonly ariaLabel?: string;
  readonly focusKey?: string;
  readonly detailId?: string;
  readonly path: ReadonlyArray<number>;
  readonly tagName: string;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
};

type DetailSnapshot = {
  readonly index: number;
  readonly id?: string;
  readonly detailId?: string;
  readonly taskId?: string;
};

type ScrollSnapshot = {
  readonly index: number;
  readonly left: number;
  readonly top: number;
};

declare global {
  interface Window {
    renderMathInElement?: (element: Element, options: Readonly<Record<string, unknown>>) => void;
  }
}

const BOOT_ID = "roster-realtime-boot";
const MAX_IDENTIFIER_LENGTH = 512;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requiredString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`Roster realtime boot field ${key} is missing or invalid`);
  }
  return value;
};

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = record[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`Roster realtime boot field ${key} is invalid`);
  }
  return value;
};

const parseBootConfig = (encoded: string): ResolvedRosterRealtimeBootConfig => {
  const parsed: unknown = JSON.parse(encoded);
  if (!isRecord(parsed)) throw new Error("Roster realtime boot configuration must be an object");
  const domain = requiredString(parsed, "domain");
  if (domain !== "theorem" && domain !== "axiom" && domain !== "writer" && domain !== "axiom-simple") {
    throw new Error(`Unsupported Roster realtime domain: ${domain}`);
  }
  const realtime = isRecord(parsed.realtime) ? parsed.realtime : undefined;
  const confirmedReads = parsed.confirmedReads ?? realtime?.confirmedReads;
  if (typeof confirmedReads !== "boolean") {
    throw new Error("Roster realtime boot field confirmedReads must be boolean");
  }
  const enabled = parsed.enabled ?? realtime?.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Roster realtime boot field enabled must be boolean when present");
  }
  const surface = optionalString(parsed, "surface");
  if (surface !== undefined && surface !== "axiom-worker") {
    throw new Error(`Unsupported Roster realtime surface: ${surface}`);
  }
  if (surface === "axiom-worker" && domain !== "axiom") {
    throw new Error("The axiom-worker surface requires the axiom domain");
  }
  return {
    domain,
    stream: requiredString(parsed, "stream"),
    runId: optionalString(parsed, "runId"),
    runStream: optionalString(parsed, "runStream"),
    branchStream: optionalString(parsed, "branchStream"),
    surface,
    workspaceId: requiredString(parsed, "workspaceId"),
    uri: parsed.uri !== undefined ? requiredString(parsed, "uri") : requiredString(realtime ?? {}, "uri"),
    database: parsed.database !== undefined ? requiredString(parsed, "database") : requiredString(realtime ?? {}, "database"),
    confirmedReads,
    enabled,
    capabilitySecret: optionalString(parsed, "capabilitySecret"),
    capabilityHash: optionalString(parsed, "capabilityHash"),
    capabilityFragmentParam: optionalString(parsed, "capabilityFragmentParam"),
  };
};

const readBootConfig = (): ResolvedRosterRealtimeBootConfig | undefined => {
  const node = document.getElementById(BOOT_ID);
  if (!node?.textContent) return undefined;
  try {
    return parseBootConfig(node.textContent);
  } finally {
    // Do not retain an inline capability in the live DOM after boot.
    node.remove();
  }
};

const panelPrefix = (
  domain: RosterRealtimeDomain,
  surface?: RosterRealtimeSurface,
): PanelPrefix => {
  if (surface === "axiom-worker") return "aw";
  if (domain === "writer") return "wg";
  if (domain === "axiom-simple") return "as";
  return "tg";
};

const parseReplayCursor = (): bigint | null => {
  const url = new URL(window.location.href);
  const encoded = url.searchParams.get("at");
  if (encoded === null) return null;
  try {
    if (!/^(0|[1-9][0-9]*)$/.test(encoded)) throw new Error("Invalid replay sequence");
    const value = BigInt(encoded);
    if (value >= 0n) return value;
  } catch {
    // Invalid cursors are removed below.
  }
  url.searchParams.delete("at");
  window.history.replaceState(window.history.state, "", url);
  return null;
};

const selectedBranchStream = (
  runStream: string | undefined,
  configured: string | undefined,
): string | undefined => {
  if (!runStream) return undefined;
  const branch = configured ?? new URL(window.location.href).searchParams.get("branch");
  return branch && branch.startsWith(`${runStream}/branches/`) && branch.length <= MAX_IDENTIFIER_LENGTH
    ? branch
    : undefined;
};

const consumeFragmentSecret = (parameter: string): string | undefined => {
  const encoded = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!encoded) return undefined;
  const fragment = new URLSearchParams(encoded);
  const secret = fragment.get(parameter) ?? undefined;
  if (!secret) return undefined;
  fragment.delete(parameter);
  const remainder = fragment.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${remainder ? `#${remainder}` : ""}`,
  );
  return secret;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const capabilityHashFor = async (boot: ResolvedRosterRealtimeBootConfig): Promise<string | undefined> => {
  const fragmentSecret = consumeFragmentSecret(boot.capabilityFragmentParam ?? "access");
  const secret = fragmentSecret ?? boot.capabilitySecret;
  if (secret) return sha256Hex(secret);
  return boot.capabilityHash;
};

const authStorageKey = (boot: ResolvedRosterRealtimeBootConfig): string =>
  `roster:spacetimedb:auth:${encodeURIComponent(boot.uri)}:${encodeURIComponent(boot.database)}`;

const readStoredToken = (boot: ResolvedRosterRealtimeBootConfig): string | undefined => {
  try {
    return window.localStorage.getItem(authStorageKey(boot)) ?? undefined;
  } catch {
    return undefined;
  }
};

const persistToken = (boot: ResolvedRosterRealtimeBootConfig, token: string): void => {
  try {
    window.localStorage.setItem(authStorageKey(boot), token);
  } catch {
    // The active connection is still valid when storage is unavailable.
  }
};

const findOrCreateConnectionStatus = (): HTMLElement => {
  const existing = document.querySelector<HTMLElement>("[data-roster-connection]");
  if (existing) return existing;
  const output = document.createElement("output");
  output.className = "roster-connection-state";
  output.dataset.rosterConnection = "";
  const replay = document.querySelector<HTMLElement>('[data-slot="agent-replay"]');
  (replay ?? document.body).prepend(output);
  return output;
};

const applyParticipantProfile = (profile: {
  readonly nodeId: string;
  readonly displayName: string;
  readonly role: string;
  readonly bio: string;
  readonly skillsJson: string;
  readonly capabilitiesJson: string;
}): void => {
  for (const trigger of document.querySelectorAll<HTMLElement>(
    `[data-participant-profile="${CSS.escape(profile.nodeId)}"]`,
  )) {
    trigger.dataset.profileName = profile.displayName;
    trigger.dataset.profileRole = profile.role;
    trigger.dataset.profileBio = profile.bio;
    trigger.dataset.profileSkills = profile.skillsJson;
    trigger.dataset.profileCapabilities = profile.capabilitiesJson;
    const identity = trigger.querySelector<HTMLElement>(".room-roster-identity");
    const avatar = trigger.querySelector<HTMLElement>(".room-roster-avatar");
    const name = identity?.querySelector<HTMLElement>("strong");
    const meta = identity?.querySelector<HTMLElement>("small");
    if (name) name.textContent = profile.displayName;
    if (meta) meta.textContent = `@${profile.displayName.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-")} · ${profile.role}`;
    if (avatar) avatar.textContent = (profile.displayName[0] || "?").toUpperCase();
  }
};

const setConnectionState = (
  state: ConnectionState,
  label: string,
  detail: string,
): void => {
  const node = findOrCreateConnectionStatus();
  node.dataset.state = state;
  node.dataset.tone = state === "live" ? "live" : state === "error" || state === "disabled" ? "danger" : "warning";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.setAttribute("aria-atomic", "true");
  const detailNode = document.createElement("span");
  detailNode.className = "sr-only";
  detailNode.textContent = `. ${detail}`;
  node.replaceChildren(document.createTextNode(label), detailNode);
  node.title = detail;
  document.body.dataset.realtimeState = state;
  for (const panel of document.querySelectorAll<HTMLElement>("[data-roster-panel]")) {
    panel.setAttribute("aria-busy", String(state === "connecting" || state === "syncing" || state === "reconnecting"));
  }
};

const detailIdentity = (detail: HTMLDetailsElement, index: number): DetailSnapshot => ({
  index,
  id: detail.id || undefined,
  detailId: detail.dataset.detailId,
  taskId: detail.dataset.taskId,
});

const matchesDetail = (detail: HTMLDetailsElement, snapshot: DetailSnapshot): boolean =>
  Boolean(
    (snapshot.id && detail.id === snapshot.id)
    || (snapshot.detailId && detail.dataset.detailId === snapshot.detailId)
    || (snapshot.taskId && detail.dataset.taskId === snapshot.taskId),
  );

const captureFocus = (root: HTMLElement): FocusSnapshot | undefined => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return undefined;
  const path: number[] = [];
  let current: Element = active;
  while (current !== root) {
    const parent = current.parentElement;
    if (!parent) break;
    path.unshift([...parent.children].indexOf(current));
    current = parent;
  }
  const textControl = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  return {
    id: active.id || undefined,
    name: "name" in active && typeof active.name === "string" ? active.name || undefined : undefined,
    href: active instanceof HTMLAnchorElement ? active.getAttribute("href") ?? undefined : undefined,
    ariaLabel: active.getAttribute("aria-label") ?? undefined,
    focusKey: active.dataset.focusKey,
    detailId: active.closest<HTMLDetailsElement>("details[data-detail-id]")?.dataset.detailId,
    path,
    tagName: active.tagName,
    selectionStart: textControl ? active.selectionStart : undefined,
    selectionEnd: textControl ? active.selectionEnd : undefined,
  };
};

const restoreFocus = (root: HTMLElement, snapshot: FocusSnapshot | undefined): void => {
  if (!snapshot) return;
  const candidates = [...root.querySelectorAll<HTMLElement>(snapshot.tagName.toLowerCase())];
  let pathTarget: Element = root;
  for (const index of snapshot.path) {
    const child = pathTarget.children.item(index);
    if (!child) break;
    pathTarget = child;
  }
  const hasSemanticKey = Boolean(
    snapshot.id
    || snapshot.name
    || snapshot.href
    || snapshot.ariaLabel
    || snapshot.focusKey
    || snapshot.detailId,
  );
  const target = candidates.find((candidate) => snapshot.id && candidate.id === snapshot.id)
    ?? candidates.find((candidate) => snapshot.name && "name" in candidate && candidate.name === snapshot.name)
    ?? candidates.find((candidate) => snapshot.href && candidate instanceof HTMLAnchorElement && candidate.getAttribute("href") === snapshot.href)
    ?? candidates.find((candidate) => snapshot.ariaLabel && candidate.getAttribute("aria-label") === snapshot.ariaLabel)
    ?? candidates.find((candidate) => snapshot.focusKey && candidate.dataset.focusKey === snapshot.focusKey)
    ?? candidates.find((candidate) => snapshot.detailId && candidate.closest<HTMLDetailsElement>("details[data-detail-id]")?.dataset.detailId === snapshot.detailId)
    ?? (!hasSemanticKey && pathTarget instanceof HTMLElement && pathTarget.tagName === snapshot.tagName ? pathTarget : undefined);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    && snapshot.selectionStart !== undefined
    && snapshot.selectionStart !== null
  ) {
    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd ?? snapshot.selectionStart);
  }
};

const renderMath = (root: HTMLElement): void => {
  const render = window.renderMathInElement;
  if (typeof render !== "function") return;
  for (const proof of root.querySelectorAll(".proof")) {
    try {
      render(proof, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
      });
    } catch {
      // A malformed formula should not block the live transaction projection.
    }
  }
};

const replacePanelHtml = (
  id: string,
  html: string,
  previousHtml: Map<string, string>,
): void => {
  const root = document.getElementById(id);
  if (!(root instanceof HTMLElement) || previousHtml.get(id) === html) return;
  const details = [...root.querySelectorAll<HTMLDetailsElement>("details")];
  const openDetails = details
    .map(detailIdentity)
    .filter((snapshot) => details[snapshot.index]?.open);
  const scrollNodes = [root, ...root.querySelectorAll<HTMLElement>("[data-preserve-scroll], .as-worker-strip")];
  const scroll = scrollNodes.map((node, index): ScrollSnapshot => ({
    index,
    left: node.scrollLeft,
    top: node.scrollTop,
  }));
  const focus = captureFocus(root);
  root.innerHTML = html;
  previousHtml.set(id, html);

  const nextDetails = [...root.querySelectorAll<HTMLDetailsElement>("details")];
  for (const snapshot of openDetails) {
    const match = nextDetails.find((detail) => matchesDetail(detail, snapshot)) ?? nextDetails[snapshot.index];
    if (match) match.open = true;
  }
  const nextScrollNodes = [root, ...root.querySelectorAll<HTMLElement>("[data-preserve-scroll], .as-worker-strip")];
  for (const snapshot of scroll) {
    const node = nextScrollNodes[snapshot.index];
    if (node) {
      node.scrollLeft = snapshot.left;
      node.scrollTop = snapshot.top;
    }
  }
  restoreFocus(root, focus);
  renderMath(root);
  root.dispatchEvent(new CustomEvent("roster:panel-rendered", { bubbles: true }));
};

const orderedReceipts = (
  rows: ReadonlyMap<string, RealtimeReceiptRow>,
  workspaceId: string,
): ReadonlyArray<RealtimeReceiptRow> => [...rows.values()]
  .filter((row) => row.workspaceId === workspaceId)
  .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);

const orderedBranches = (
  rows: ReadonlyMap<string, RealtimeBranchRow>,
  workspaceId: string,
): ReadonlyArray<RealtimeBranchRow> => [...rows.values()]
  .filter((row) => row.workspaceId === workspaceId)
  .sort((left, right) =>
    left.createdAtMs < right.createdAtMs ? -1 : left.createdAtMs > right.createdAtMs ? 1 : left.streamId.localeCompare(right.streamId),
  );

const renderForDomain = (input: {
  readonly boot: ResolvedRosterRealtimeBootConfig;
  readonly runStream?: string;
  readonly branchStream?: string;
  readonly indexRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly runRows: ReadonlyArray<RealtimeReceiptRow>;
  readonly branchRows: ReadonlyArray<RealtimeBranchRow>;
  readonly cursor: bigint | null;
}): RosterPanels => {
  const common = {
    stream: input.boot.stream,
    runId: input.boot.runId,
    runStream: input.runStream,
    indexRows: input.indexRows,
    runRows: input.runRows,
    cursor: { seq: input.cursor },
  };
  if (input.boot.surface === "axiom-worker") {
    if (!input.boot.runId) throw new Error("Axiom worker realtime requires a run id");
    return renderAxiomWorkerPanels({
      stream: input.boot.stream,
      runId: input.boot.runId,
      runRows: input.runRows,
      cursor: common.cursor,
    });
  }
  if (input.boot.domain === "writer") {
    return renderWriterPanels({
      ...common,
      branchRows: input.branchRows,
      branchStream: input.branchStream,
    });
  }
  if (input.boot.domain === "axiom-simple") return renderAxiomSimplePanels(common);
  return renderTheoremPanels({
    ...common,
    basePath: input.boot.domain === "axiom" ? "/axiom" : "/theorem",
    branchRows: input.branchRows,
    branchStream: input.branchStream,
  });
};

const startRosterRealtime = async (boot: ResolvedRosterRealtimeBootConfig): Promise<void> => {
  const prefix = panelPrefix(boot.domain, boot.surface);
  const runStream = boot.runStream ?? (boot.runId ? `${boot.stream}/runs/${boot.runId}` : undefined);
  const supportsBranches = boot.domain !== "axiom-simple" && boot.surface !== "axiom-worker";
  const branchStream = supportsBranches ? selectedBranchStream(runStream, boot.branchStream) : undefined;
  const receiptStream = branchStream ?? runStream;
  const selectedJobId = new URL(window.location.href).searchParams.get("job") ?? undefined;
  const eventStreams = new Map<string, EventStreamRow>();
  const indexReceipts = new Map<string, RealtimeReceiptRow>();
  const runReceipts = new Map<string, RealtimeReceiptRow>();
  const branches = new Map<string, RealtimeBranchRow>();
  let selectedJob: RosterJobRow | undefined;
  const previousHtml = new Map<string, string>();
  let cursor = parseReplayCursor();
  let replay: ReplayController | undefined;
  let connection: DbConnection | undefined;
  let subscription: SubscriptionHandle | undefined;
  let reconnectTimer: number | undefined;
  let reconnectAttempt = 0;
  let connectionGeneration = 0;
  let snapshotApplied = false;
  let renderQueued = false;
  let closing = false;
  let accessDenied = false;
  let sessionToken = readStoredToken(boot);
  const capabilityHash = await capabilityHashFor(boot);

  const replayRoot = document.getElementById(`${prefix}-travel`);
  if (replayRoot instanceof HTMLElement) {
    replay = createReplayController({
      root: replayRoot,
      onCursorChange: (nextCursor) => {
        cursor = nextCursor;
        render();
      },
    });
  }

  const clearCache = (): void => {
    eventStreams.clear();
    indexReceipts.clear();
    runReceipts.clear();
    branches.clear();
    selectedJob = undefined;
  };

  const updateWorkState = (): void => {
    if (!selectedJob) return;
    const attempt = selectedJob.attempt > 0
      ? ` Attempt ${selectedJob.attempt} of ${selectedJob.maxAttempts}.`
      : "";
    switch (selectedJob.status) {
      case "queued":
        setConnectionState("syncing", "Queued", `Waiting for an ${selectedJob.agentId} worker.${attempt}`);
        break;
      case "leased":
      case "running":
        setConnectionState("syncing", "Agents working", `${selectedJob.agentId} is producing durable events.${attempt}`);
        break;
      case "completed":
        setConnectionState("live", "Run complete", "The durable result and full replay are synchronized.");
        break;
      case "failed":
        setConnectionState("error", "Run failed", selectedJob.lastError || "The worker exhausted its attempts.");
        break;
      case "canceled":
        setConnectionState("error", "Run canceled", "This queued run was superseded or canceled.");
        break;
      default:
        break;
    }
  };

  const renderNow = (): void => {
    renderQueued = false;
    if (!snapshotApplied) return;
    try {
      const runRows = orderedReceipts(runReceipts, boot.workspaceId);
      const panels = renderForDomain({
        boot,
        runStream,
        branchStream,
        indexRows: orderedReceipts(indexReceipts, boot.workspaceId),
        runRows,
        branchRows: orderedBranches(branches, boot.workspaceId),
        cursor,
      });
      replacePanelHtml(`${prefix}-conversation`, panels.conversationHtml, previousHtml);
      replacePanelHtml(`${prefix}-chat`, panels.chatHtml, previousHtml);
      replacePanelHtml(`${prefix}-folds`, panels.foldsHtml, previousHtml);
      replacePanelHtml(`${prefix}-side`, panels.sideHtml, previousHtml);
      replay?.update({
        sequences: runRows.map((row) => row.seq),
        cursor,
        label: receiptStream ? panels.replay.label : "No run selected",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionState("error", "Render interrupted", message);
      console.error("Roster realtime render failed", error);
    }
  };

  function render(): void {
    if (!snapshotApplied || renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(renderNow);
  }

  const applyReceipt = (row: RealtimeReceiptRow): void => {
    if (row.workspaceId !== boot.workspaceId) return;
    if (row.streamId === boot.stream) indexReceipts.set(row.id, row);
    if (receiptStream && row.streamId === receiptStream) runReceipts.set(row.id, row);
  };

  const deleteReceipt = (row: RealtimeReceiptRow): void => {
    if (row.workspaceId !== boot.workspaceId) return;
    indexReceipts.delete(row.id);
    runReceipts.delete(row.id);
  };

  const registerRowCallbacks = (next: DbConnection, generation: number): void => {
    const current = (): boolean => generation === connectionGeneration;
    next.db.myEventStreams.onInsert((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      eventStreams.set(row.streamId, row);
      render();
    });
    next.db.myEventStreams.onUpdate((_context, oldRow, row) => {
      if (!current()) return;
      if (oldRow.workspaceId === boot.workspaceId) eventStreams.delete(oldRow.streamId);
      if (row.workspaceId === boot.workspaceId) eventStreams.set(row.streamId, row);
      render();
    });
    next.db.myEventStreams.onDelete((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      eventStreams.delete(row.streamId);
      render();
    });

    next.db.myStreamReceipts.onInsert((_context, row) => {
      if (!current()) return;
      applyReceipt(row);
      render();
    });
    next.db.myStreamReceipts.onUpdate((_context, oldRow, row) => {
      if (!current()) return;
      deleteReceipt(oldRow);
      applyReceipt(row);
      render();
    });
    next.db.myStreamReceipts.onDelete((_context, row) => {
      if (!current()) return;
      deleteReceipt(row);
      render();
    });

    next.db.myStreamBranches.onInsert((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId || row.parentStreamId !== runStream) return;
      branches.set(row.id, row);
      render();
    });
    next.db.myStreamBranches.onUpdate((_context, oldRow, row) => {
      if (!current()) return;
      if (oldRow.workspaceId === boot.workspaceId) branches.delete(oldRow.id);
      if (row.workspaceId === boot.workspaceId && row.parentStreamId === runStream) branches.set(row.id, row);
      render();
    });
    next.db.myStreamBranches.onDelete((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      branches.delete(row.id);
      render();
    });

    next.db.myRosterJobs.onInsert((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId || row.id !== selectedJobId) return;
      selectedJob = row;
      updateWorkState();
    });
    next.db.myRosterJobs.onUpdate((_context, oldRow, row) => {
      if (!current()) return;
      if (oldRow.workspaceId === boot.workspaceId && oldRow.id === selectedJobId) selectedJob = undefined;
      if (row.workspaceId === boot.workspaceId && row.id === selectedJobId) selectedJob = row;
      updateWorkState();
    });
    next.db.myRosterJobs.onDelete((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId || row.id !== selectedJobId) return;
      selectedJob = undefined;
    });
    next.db.myRosterParticipantProfiles.onInsert((_context, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      applyParticipantProfile(row);
    });
    next.db.myRosterParticipantProfiles.onUpdate((_context, _oldRow, row) => {
      if (!current() || row.workspaceId !== boot.workspaceId) return;
      applyParticipantProfile(row);
    });
  };

  const hydrateFromCache = (next: DbConnection): void => {
    clearCache();
    for (const row of next.db.myEventStreams.iter()) {
      if (row.workspaceId === boot.workspaceId) eventStreams.set(row.streamId, row);
    }
    for (const row of next.db.myStreamReceipts.iter()) applyReceipt(row);
    for (const row of next.db.myStreamBranches.iter()) {
      if (row.workspaceId === boot.workspaceId && row.parentStreamId === runStream) branches.set(row.id, row);
    }
    if (selectedJobId) {
      selectedJob = [...next.db.myRosterJobs.iter()].find((row) =>
        row.workspaceId === boot.workspaceId && row.id === selectedJobId);
    }
    for (const row of next.db.myRosterParticipantProfiles.iter()) {
      if (row.workspaceId === boot.workspaceId) applyParticipantProfile(row);
    }
  };

  const queries = () => {
    const selectedStreams = new Set([boot.stream, runStream, receiptStream].filter((value): value is string => Boolean(value)));
    return [
      ...[...selectedStreams].map((streamId) =>
        tables.myEventStreams.where((row) =>
          row.workspaceId.eq(boot.workspaceId).and(row.streamId.eq(streamId)))),
      tables.myStreamReceipts.where((row) =>
        row.workspaceId.eq(boot.workspaceId).and(row.streamId.eq(boot.stream))),
      ...(receiptStream && receiptStream !== boot.stream
        ? [tables.myStreamReceipts.where((row) =>
            row.workspaceId.eq(boot.workspaceId).and(row.streamId.eq(receiptStream)))]
        : []),
      ...(runStream && supportsBranches
        ? [tables.myStreamBranches.where((row) =>
            row.workspaceId.eq(boot.workspaceId).and(row.parentStreamId.eq(runStream)))]
        : []),
      ...(selectedJobId
        ? [tables.myRosterJobs.where((row) =>
            row.workspaceId.eq(boot.workspaceId).and(row.id.eq(selectedJobId)))]
        : []),
      tables.myRosterParticipantProfiles.where((row) => row.workspaceId.eq(boot.workspaceId)),
    ];
  };

  const subscribe = async (nextConnection: DbConnection, generation: number): Promise<void> => {
    const next = nextConnection;
    snapshotApplied = false;
    replay?.stop();
    setConnectionState("syncing", "Synchronizing", "Joining the workspace and applying one atomic snapshot.");
    if (capabilityHash) {
      await next.reducers.joinWorkspace({ workspaceId: boot.workspaceId, capabilityHash });
    }
    if (generation !== connectionGeneration) {
      next.disconnect();
      return;
    }
    clearCache();
    registerRowCallbacks(next, generation);
    subscription = next.subscriptionBuilder()
      .onApplied(() => {
        if (generation !== connectionGeneration) return;
        reconnectAttempt = 0;
        hydrateFromCache(next);
        snapshotApplied = true;
        renderNow();
        const selectedCount = runReceipts.size;
        const detail = receiptStream
          ? `${selectedCount} durable event${selectedCount === 1 ? "" : "s"} synchronized for the selected run.`
          : `${indexReceipts.size} index event${indexReceipts.size === 1 ? "" : "s"} synchronized.`;
        setConnectionState("live", "Live", detail);
        updateWorkState();
      })
      .onError((context) => {
        if (generation !== connectionGeneration) return;
        replay?.stop();
        setConnectionState(
          "error",
          "Subscription interrupted",
          context.event?.message || "The caller-scoped snapshot closed.",
        );
        scheduleReconnect("The caller-scoped subscription closed.");
      })
      .subscribe(queries());
  };

  const scheduleReconnect = (reason: string): void => {
    if (closing || accessDenied || reconnectTimer !== undefined) return;
    snapshotApplied = false;
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
    if (closing || accessDenied || boot.enabled === false) return;
    const generation = connectionGeneration + 1;
    connectionGeneration = generation;
    try {
      if (subscription?.isActive()) subscription.unsubscribe();
    } catch {
      // The old connection may already be closed.
    }
    subscription = undefined;
    const previous = connection;
    connection = undefined;
    previous?.disconnect();
    replay?.stop();
    snapshotApplied = false;
    setConnectionState(
      reconnectAttempt > 0 ? "reconnecting" : "connecting",
      reconnectAttempt > 0 ? "Reconnecting" : "Connecting",
      `Opening ${boot.database}.`,
    );
    try {
      connection = DbConnection.builder()
        .withUri(boot.uri)
        .withDatabaseName(boot.database)
        .withToken(sessionToken)
        .withConfirmedReads(boot.confirmedReads)
        .withLightMode(true)
        .onConnect((next, _identity, token) => {
          if (generation !== connectionGeneration) {
            next.disconnect();
            return;
          }
          sessionToken = token;
          persistToken(boot, token);
          void subscribe(next, generation).catch((error: unknown) => {
            if (generation !== connectionGeneration) return;
            replay?.stop();
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof SenderError) {
              accessDenied = true;
              setConnectionState("error", "Access denied", message);
            } else {
              scheduleReconnect(message || "Workspace synchronization failed.");
            }
            if (connection === next) connection = undefined;
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

  window.addEventListener("beforeunload", () => {
    closing = true;
    connectionGeneration += 1;
    replay?.dispose();
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    try {
      if (subscription?.isActive()) subscription.unsubscribe();
    } catch {
      // The socket is already closing.
    }
    connection?.disconnect();
  }, { once: true });

  if (boot.enabled === false) {
    setConnectionState("disabled", "Realtime unavailable", "SpacetimeDB is disabled for this environment.");
    return;
  }
  connect();
};

const boot = readBootConfig();
if (boot) {
  void startRosterRealtime(boot).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setConnectionState("error", "Realtime failed", message);
    console.error("Roster realtime client failed to start", error);
  });
}
