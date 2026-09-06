import {
  DbConnection,
  tables,
  type SubscriptionHandle,
} from "../spacetimedb-bindings/index.js";

type BootConfig = {
  readonly stream: string;
  readonly runId: string;
  readonly apiReady: boolean;
  readonly models?: Readonly<Record<string, string>>;
  readonly realtime: {
    readonly enabled: boolean;
    readonly uri: string;
    readonly database: string;
    readonly runId: string;
    readonly confirmedReads: boolean;
    readonly workspaceId?: string;
    readonly workspaceCapabilitySecret?: string;
  };
};

type TimestampLike = { readonly microsSinceUnixEpoch: bigint };

type CanvasRunRow = {
  readonly id: string;
  readonly prompt: string;
  readonly status: string;
  readonly uiStatus: string;
  readonly statusNote: string;
  readonly desiredAgents: number;
  readonly maxInflight: number;
  readonly sceneHash: string;
  readonly objectCount: number;
  readonly totalTasks: number;
  readonly completedTasks: number;
  readonly reviewVerdict: string;
  readonly qualityStatus: string;
  readonly updatedAt: TimestampLike;
};

type CanvasFleetRunRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly status: string;
  readonly desiredAgents: number;
  readonly maxInflight: number;
  readonly objectCount: number;
  readonly activeAgents: number;
  readonly totalAgents: number;
  readonly totalTasks: number;
  readonly completedTasks: number;
  readonly createdAt: TimestampLike;
  readonly updatedAt: TimestampLike;
};

type ScenePlanRow = {
  readonly runId: string;
  readonly subject: string;
  readonly artDirection: string;
  readonly paletteJson: string;
  readonly painterCount: number;
  readonly updatedAt: TimestampLike;
};

type CanvasAgentRow = {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  readonly name: string;
  readonly role: string;
  readonly group: string;
  readonly focus: string;
  readonly assignment: string;
  readonly model: string;
  readonly status: string;
  readonly taskId: string;
  readonly updatedAt: TimestampLike;
};

type CanvasTaskStatusRow = {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly capability: string;
  readonly objective: string;
  readonly status: string;
  readonly attempt: number;
  readonly error: string;
  readonly updatedAt: TimestampLike;
};

type SceneReviewRow = {
  readonly id: string;
  readonly runId: string;
  readonly sceneHash: string;
  readonly verdict: string;
  readonly qualityStatus: string;
  readonly scope: string;
  readonly scoresJson: string;
  readonly checksJson: string;
  readonly notesJson: string;
  readonly createdAt: TimestampLike;
};

type SceneObjectRow = {
  readonly id: string;
  readonly runId: string;
  readonly patchId: string;
  readonly objectId: string;
  readonly semanticId: string;
  readonly ownerAgentId: string;
  readonly taskId: string;
  readonly partId: string;
  readonly objectType: string;
  readonly geometryJson: string;
  readonly styleJson: string;
  readonly layer: number;
  readonly rank: number;
  readonly active: boolean;
  readonly createdAt: TimestampLike;
  readonly updatedAt: TimestampLike;
};

type CanvasReplayStepRow = {
  readonly id: string;
  readonly runId: string;
  readonly seq: bigint;
  readonly kind: string;
  readonly agentId: string;
  readonly label: string;
  readonly patchId: string;
  readonly supersedesPatchId: string;
  readonly partId: string;
  readonly status: string;
  readonly objectCount: number;
  readonly createdAt: TimestampLike;
};

type CanvasActivityRow = {
  readonly id: string;
  readonly runId: string;
  readonly seq: bigint;
  readonly kind: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly summary: string;
  readonly createdAt: TimestampLike;
};

type VisualScores = {
  readonly promptMatch?: number;
  readonly recognizability?: number;
  readonly composition?: number;
  readonly coherence?: number;
  readonly polish?: number;
};

const bootNode = document.getElementById("canvas-boot");
if (!bootNode?.textContent) throw new Error("Canvas realtime boot configuration is missing");
const boot = JSON.parse(bootNode.textContent) as BootConfig;
const runId = boot.realtime.runId || boot.runId;

const text = (id: string, value: string): void => {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
};

const element = <T extends HTMLElement>(id: string): T | null => {
  const node = document.getElementById(id);
  return node instanceof HTMLElement ? node as T : null;
};

const svgElement = (id: string): SVGElement | null => {
  const node = document.getElementById(id);
  return node instanceof SVGElement ? node : null;
};

const setConnectionState = (
  state: "idle" | "connecting" | "syncing" | "live" | "reconnecting" | "error",
  label: string,
  detail: string
): void => {
  const pill = element("canvas-live-pill");
  pill?.setAttribute("data-state", state);
  text("canvas-live-label", label);
  text("connection-copy", label === "LIVE" ? "Run-scoped channel live" : label);
  text("connection-detail", detail);
  text("metric-sync", state === "live" ? "Transactional deltas active" : detail);
};

const terminalRunStatuses = new Set(["completed", "completed_with_notes", "failed", "canceled", "budget_exhausted"]);
const activeStatuses = new Set(["leased", "running", "reviewing", "painting", "refining", "directing"]);
const queuedStatuses = new Set(["queued", "delegated", "preparing", "idle"]);

const effectiveRunStatus = (
  run: CanvasRunRow | undefined,
  fallback: string,
): string => {
  if (!run) return fallback;
  return terminalRunStatuses.has(run.status)
    ? run.status
    : run.uiStatus || run.status || fallback;
};

const runStatusLabel = (status: string): string => {
  switch (status) {
    case "completed": return "Done";
    case "completed_with_notes": return "Done · notes";
    case "planning": return "Directing";
    case "reviewing": return "Reviewing";
    case "running": return "Studio live";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    case "queued": return "Queued";
    default: return status ? status.replaceAll("_", " ") : "Joining";
  }
};

const taskStatusLabel = (status: string): string => {
  if (status === "leased") return "starting";
  if (status === "completed") return "done";
  return status.replaceAll("_", " ");
};

const displayAgentStatus = (status: string, runStatus: string): string => {
  if (runStatus !== "failed" && runStatus !== "canceled" && runStatus !== "budget_exhausted") return status;
  if (status === "completed" || status === "failed" || status === "retired" || status === "canceled") return status;
  return "stopped";
};

const replaySteps = (): CanvasReplayStepRow[] => [...replayStepRows.values()]
  .filter((row) => row.runId === runId)
  .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);

const replayPosition = (steps = replaySteps()): number => {
  if (replayCursorSeq === null) return steps.length;
  let position = 0;
  for (const step of steps) {
    if (step.seq > replayCursorSeq) break;
    position += 1;
  }
  return position;
};

const replayActivePatchIds = (steps = replaySteps()): ReadonlySet<string> => {
  const active = new Set<string>();
  if (replayCursorSeq === null) return active;
  for (const step of steps) {
    if (step.seq > replayCursorSeq) break;
    if (!step.patchId) continue;
    if (step.supersedesPatchId) active.delete(step.supersedesPatchId);
    active.add(step.patchId);
  }
  return active;
};

const replayStepAtPosition = (position: number, steps = replaySteps()): CanvasReplayStepRow | undefined =>
  position <= 0 ? undefined : steps[Math.min(position, steps.length) - 1];

const stopReplayPlayback = (): void => {
  replayPlaying = false;
  window.clearTimeout(replayTimer);
  replayTimer = 0;
};

const updateReplayUrl = (): void => {
  const url = new URL(window.location.href);
  if (replayCursorSeq === null) url.searchParams.delete("at");
  else url.searchParams.set("at", String(replayCursorSeq));
  window.history.replaceState(window.history.state, "", url);
};

const epochMs = (value: TimestampLike): number => Number(value.microsSinceUnixEpoch / 1_000n);

const parseRecord = (encoded: string): Readonly<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(encoded);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
};

const parseStringList = (encoded: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const formatClock = (value: TimestampLike): string => new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
}).format(new Date(epochMs(value)));

const colorFor = (id: string): string => {
  const colors = ["#82acff", "#79dacb", "#ff9275", "#f4ce71", "#c795ff", "#72c5f5", "#ef7aa7", "#91d46d"];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  return colors[Math.abs(hash) % colors.length] ?? colors[0]!;
};

const consumeAccessSecret = (): string | undefined => {
  const fragment = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (!fragment) return undefined;
  const params = new URLSearchParams(fragment);
  const secret = params.get("access") ?? undefined;
  // Capability bearers never remain in address history, logs, copied links, or referrers.
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  return secret;
};

const sha256Hex = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const authStorageKey = (): string => `roster:spacetimedb:auth:${encodeURIComponent(boot.realtime.uri)}:${encodeURIComponent(boot.realtime.database)}`;

const readStoredAuthToken = (): string | undefined => {
  try {
    return window.localStorage.getItem(authStorageKey()) ?? undefined;
  } catch {
    return undefined;
  }
};

const persistAuthToken = (token: string): void => {
  try {
    window.localStorage.setItem(authStorageKey(), token);
  } catch {
    // Storage may be disabled. The current authenticated connection remains usable.
  }
};

const runRows = new Map<string, CanvasRunRow>();
const fleetRunRows = new Map<string, CanvasFleetRunRow>();
const planRows = new Map<string, ScenePlanRow>();
const agentRows = new Map<string, CanvasAgentRow>();
const taskRows = new Map<string, CanvasTaskStatusRow>();
const reviewRows = new Map<string, SceneReviewRow>();
const activityRows = new Map<string, CanvasActivityRow>();
const sceneRows = new Map<string, SceneObjectRow>();
const replayStepRows = new Map<string, CanvasReplayStepRow>();
const sceneNodes = new Map<string, SVGElement>();
const gradientNodes = new Map<string, SVGElement>();
const sceneRoot = svgElement("canvas-scene");
const paintDefs = svgElement("canvas-paint-defs");
const workspace = element("canvas-workspace");

let renderQueued = false;
let lastUpdateAt = 0;
let replayCursorSeq: bigint | null = (() => {
  const value = new URL(window.location.href).searchParams.get("at");
  if (value === null) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
})();
let replayTimer = 0;
let replayDelay = 700;
let replayPlaying = false;

const scheduleRender = (): void => {
  lastUpdateAt = Date.now();
  if (renderQueued) return;
  renderQueued = true;
  window.requestAnimationFrame(() => {
    renderQueued = false;
    renderDashboard();
  });
};

const clearCollectionState = (): void => {
  runRows.clear();
  fleetRunRows.clear();
  planRows.clear();
  agentRows.clear();
  taskRows.clear();
  reviewRows.clear();
  activityRows.clear();
  sceneRows.clear();
  replayStepRows.clear();
  sceneNodes.clear();
  gradientNodes.clear();
  sceneRoot?.replaceChildren();
  paintDefs?.replaceChildren();
};

const statusRank = (status: string): number => {
  if (status === "failed") return 0;
  if (activeStatuses.has(status)) return 1;
  if (queuedStatuses.has(status)) return 2;
  if (status === "completed") return 3;
  if (status === "canceled" || status === "retired") return 4;
  return 5;
};

const createTextNode = (tag: string, value: string, className?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
};

const syncReplayControls = (): void => {
  const root = element("canvas-replay-controls");
  if (!root) return;
  const steps = replaySteps();
  const maximum = steps.length;
  const current = replayPosition(steps);
  const historical = replayCursorSeq !== null && current < maximum;
  root.dataset.current = String(current);
  root.dataset.maximum = String(maximum);
  root.dataset.state = maximum === 0 ? "empty" : historical ? "replay" : "live";

  const button = (action: string): HTMLButtonElement | null => {
    const node = root.querySelector(`[data-replay-action="${action}"]`);
    return node instanceof HTMLButtonElement ? node : null;
  };
  const start = button("start");
  const previous = button("previous");
  const play = button("play");
  const next = button("next");
  const live = button("live");
  if (start) start.disabled = maximum === 0 || current <= 0;
  if (previous) previous.disabled = maximum === 0 || current <= 0;
  if (next) next.disabled = maximum === 0 || current >= maximum;
  if (live) live.disabled = maximum === 0 || replayCursorSeq === null;
  if (play) {
    play.disabled = maximum === 0;
    play.textContent = replayPlaying ? "Pause" : "Play";
    play.setAttribute("aria-pressed", String(replayPlaying));
  }

  const slider = root.querySelector("[data-replay-scrub]");
  if (slider instanceof HTMLInputElement) {
    slider.disabled = maximum === 0;
    slider.max = String(maximum);
    slider.value = String(current);
    slider.setAttribute("aria-valuetext", historical
      ? `Replay step ${current} of ${maximum}`
      : maximum > 0 ? `Live at step ${maximum}` : "No replay history");
  }
  const speed = root.querySelector("[data-replay-speed]");
  if (speed instanceof HTMLSelectElement) {
    speed.disabled = maximum === 0;
    speed.value = String(replayDelay);
  }
  const output = root.querySelector("output");
  if (output) {
    const step = replayStepAtPosition(current, steps);
    output.textContent = maximum === 0
      ? runId ? "Waiting for history…" : "No run selected"
      : historical
        ? `Replay ${current}/${maximum}${step?.label ? ` · ${step.label}` : ""}`
        : `Live ${maximum}/${maximum}`;
    output.setAttribute("title", step?.label ?? "Live run head");
  }
};

const renderTeams = (agents: ReadonlyArray<CanvasAgentRow>): void => {
  const root = element<HTMLUListElement>("team-list");
  if (!root) return;
  const run = runRows.get(runId);
  const runStatus = effectiveRunStatus(run, "idle");
  const groups = new Map<string, CanvasAgentRow[]>();
  for (const agent of agents) {
    const key = agent.group.trim() || (agent.role.startsWith("validator-") ? "Validation council" : agent.role === "composer" ? "Finishing" : agent.role === "coordinator" ? "Direction" : "Studio artists");
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  text("team-count", `${groups.size} team${groups.size === 1 ? "" : "s"}`);
  if (groups.size === 0) {
    root.replaceChildren(createTextNode("li", "Assignments appear after the Art Director publishes the task frontier.", "empty-copy"));
    return;
  }
  const nodes = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, members]) => {
      const active = members.filter((agent) => activeStatuses.has(displayAgentStatus(agent.status, runStatus))).length;
      const queued = members.filter((agent) => queuedStatuses.has(displayAgentStatus(agent.status, runStatus))).length;
      const completed = members.filter((agent) => agent.status === "completed").length;
      const percent = members.length > 0 ? Math.round(completed / members.length * 100) : 0;
      const row = document.createElement("li");
      row.className = "team-card";
      const head = document.createElement("div");
      head.className = "team-head";
      head.append(createTextNode("strong", name), createTextNode("span", `${members.length} agents`));
      const meter = document.createElement("div");
      meter.className = "team-meter";
      meter.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.style.width = `${percent}%`;
      meter.append(fill);
      const meta = document.createElement("div");
      meta.className = "team-meta";
      meta.append(createTextNode("span", `${active} live`), createTextNode("span", `${queued} waiting`), createTextNode("span", `${completed} done`));
      row.append(head, meter, meta);
      return row;
    });
  root.replaceChildren(...nodes);
};

const renderAgents = (agents: ReadonlyArray<CanvasAgentRow>): void => {
  const root = element<HTMLUListElement>("agent-list");
  if (!root) return;
  const run = runRows.get(runId);
  const runStatus = effectiveRunStatus(run, "idle");
  const ordered = [...agents].sort((left, right) =>
    statusRank(displayAgentStatus(left.status, runStatus)) - statusRank(displayAgentStatus(right.status, runStatus))
    || epochMs(right.updatedAt) - epochMs(left.updatedAt)
    || left.name.localeCompare(right.name)
  );
  const visible = ordered.slice(0, 60);
  text("agent-count", `${agents.length} agent${agents.length === 1 ? "" : "s"}`);
  text("agent-summary", agents.length > visible.length ? `${visible.length} priority agents shown` : `${agents.length} assignments`);
  if (visible.length === 0) {
    root.replaceChildren(createTextNode("li", "No agent assignments yet.", "empty-copy"));
    return;
  }
  const nodes: HTMLElement[] = visible.map((agent) => {
    const effectiveStatus = displayAgentStatus(agent.status, runStatus);
    const row = document.createElement("li");
    row.className = "agent-row";
    row.dataset.state = effectiveStatus;
    row.style.setProperty("--agent", colorFor(agent.agentId));
    const mark = document.createElement("span");
    mark.className = "agent-mark";
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "agent-copy";
    const title = createTextNode("strong", agent.name || agent.agentId);
    const detail = agent.assignment || agent.focus || agent.role;
    const subtitle = createTextNode("span", agent.model ? `${detail} · ${agent.model}` : detail);
    copy.append(title, subtitle);
    const status = createTextNode("span", taskStatusLabel(effectiveStatus), "agent-status");
    row.title = agent.model ? `${detail} · ${agent.model}` : detail;
    row.append(mark, copy, status);
    return row;
  });
  if (ordered.length > visible.length) {
    nodes.push(createTextNode("li", `${ordered.length - visible.length} settled agents are collapsed to keep this panel fast.`, "empty-copy"));
  }
  root.replaceChildren(...nodes);
};

const signalAge = (at: number): { readonly seconds: number; readonly label: string } => {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1_000));
  return {
    seconds,
    label: seconds < 2 ? "signal now" : `signal ${seconds}s ago`,
  };
};

const renderStudioFloor = (): void => {
  const root = element("studio-floor");
  const agentList = element<HTMLUListElement>("studio-agent-strip");
  const eventList = element<HTMLOListElement>("studio-event-strip");
  const teamActivity = element<HTMLDetailsElement>("studio-team-activity");
  if (!root || !agentList || !eventList || !teamActivity) return;

  const run = runRows.get(runId);
  const status = effectiveRunStatus(run, runId ? "connecting" : "idle");
  const terminal = terminalRunStatuses.has(status);
  const agents = [...agentRows.values()]
    .filter((agent) => agent.runId === runId)
    .map((agent) => ({ ...agent, status: displayAgentStatus(agent.status, status) }));
  const tasks = [...taskRows.values()].filter((task) => task.runId === runId);
  const activities = [...activityRows.values()]
    .filter((activity) => activity.runId === runId && (replayCursorSeq === null || activity.seq <= replayCursorSeq))
    .sort((left, right) => left.seq < right.seq ? 1 : left.seq > right.seq ? -1 : 0);
  const latestActivityByAgent = new Map<string, CanvasActivityRow>();
  for (const activity of activities) {
    if (!latestActivityByAgent.has(activity.agentId)) latestActivityByAgent.set(activity.agentId, activity);
  }
  const latestTaskByAgent = new Map<string, CanvasTaskStatusRow>();
  for (const task of [...tasks].sort((left, right) => (
    Number(activeStatuses.has(right.status)) - Number(activeStatuses.has(left.status))
    || epochMs(right.updatedAt) - epochMs(left.updatedAt)
  ))) {
    if (!latestTaskByAgent.has(task.agentId)) latestTaskByAgent.set(task.agentId, task);
  }

  const activeAgents = agents.filter((agent) => activeStatuses.has(agent.status));
  const waitingAgents = agents.filter((agent) => queuedStatuses.has(agent.status));
  const visibleAgents = (activeAgents.length > 0 ? activeAgents : waitingAgents).slice(0, 6);
  const syntheticDirector = Boolean(run && !terminal && visibleAgents.length === 0 && (status === "planning" || agents.length === 0));
  const signalTimes = [
    run ? epochMs(run.updatedAt) : 0,
    ...activeAgents.map((agent) => epochMs(agent.updatedAt)),
    ...tasks.filter((task) => activeStatuses.has(task.status)).map((task) => epochMs(task.updatedAt)),
    ...activities.slice(0, 1).map((activity) => epochMs(activity.createdAt)),
  ].filter((value) => value > 0);
  const latestSignalAt = signalTimes.length > 0 ? Math.max(...signalTimes) : 0;
  const age = latestSignalAt > 0 ? signalAge(latestSignalAt) : undefined;
  const floorState = !run || status === "idle" || status === "connecting"
    ? "idle"
    : terminal
      ? status === "failed" ? "stalled" : "settled"
      : age && age.seconds > 60 ? "stalled"
        : age && age.seconds > 15 ? "delayed"
          : "active";
  root.dataset.state = floorState;
  root.setAttribute("aria-busy", String(Boolean(run && !terminal)));

  const phase = status === "planning" ? "Direction"
    : status === "reviewing" ? "Validation"
      : status === "completed" || status === "completed_with_notes" ? "Certified"
        : status === "failed" ? "Stopped"
          : status === "running" ? (agents.some((agent) => agent.role === "composer" && activeStatuses.has(agent.status)) ? "Finishing" : "Parallel painting")
            : runStatusLabel(status);
  text("studio-phase", phase);

  const activeNames = activeAgents.slice(0, 3).map((agent) => agent.name || agent.agentId);
  const liveCopy = !run
    ? "Agent work will appear here as soon as the durable run begins."
    : terminal
      ? status === "failed"
        ? `The studio stopped. ${run.statusNote || "The durable activity trail contains the failure reason."}`
        : `The studio completed with ${run.objectCount} scene objects and ${run.completedTasks}/${run.totalTasks} accepted tasks.`
      : floorState === "stalled"
        ? `No durable agent update for ${age?.seconds ?? 0}s. The realtime channel is live, but the active worker may be stalled or waiting on its model provider.`
        : status === "planning"
          ? `The Art Director is interpreting the brief and designing independent painter responsibilities${age ? ` · ${age.label}` : ""}. Planning is one model call, so the first agent team appears after its structured plan returns.`
          : status === "reviewing"
            ? `${Math.max(1, activeAgents.length)} validation agents are inspecting the same rendered frontier for subject, composition, and consistency${age ? ` · ${age.label}` : ""}.`
            : activeAgents.length > 0
              ? `${activeAgents.length} agents are working in parallel${activeNames.length > 0 ? `: ${activeNames.join(", ")}${activeAgents.length > activeNames.length ? ` +${activeAgents.length - activeNames.length}` : ""}` : ""}${age ? ` · ${age.label}` : ""}.`
              : `${waitingAgents.length} agents are queued for the next available frontier${age ? ` · ${age.label}` : ""}.`;
  text("studio-live-copy", liveCopy);

  const cards: Array<{
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly detail: string;
    readonly updatedAt: number;
    readonly model?: string;
  }> = syntheticDirector && run
    ? [{
        id: "orchestrator",
        name: "Art Director",
        status: "directing",
        detail: run.statusNote || "Interpreting the brief and designing the specialist team.",
        updatedAt: epochMs(run.updatedAt),
      }]
    : visibleAgents.map((agent) => {
        const task = latestTaskByAgent.get(agent.agentId);
        const activity = latestActivityByAgent.get(agent.agentId);
        const activityFresh = activity && Date.now() - epochMs(activity.createdAt) < 90_000;
        return {
          id: agent.agentId,
          name: agent.name || agent.agentId,
          status: agent.status,
          detail: activityFresh ? activity.summary : task?.objective || agent.assignment || agent.focus || agent.role,
          updatedAt: Math.max(epochMs(agent.updatedAt), task ? epochMs(task.updatedAt) : 0, activity ? epochMs(activity.createdAt) : 0),
          model: agent.model,
        };
      });
  text("studio-agent-count", `${cards.length} ${activeAgents.length > 0 || syntheticDirector ? "active" : "waiting"}`);
  teamActivity.hidden = cards.length === 0;
  if (cards.length === 0) {
    agentList.replaceChildren();
  } else {
    agentList.replaceChildren(...cards.map((agent) => {
      const active = activeStatuses.has(agent.status) || agent.status === "directing";
      const item = document.createElement("li");
      item.className = "studio-agent-card";
      item.dataset.state = agent.status === "failed" ? "failed" : active ? "active" : "waiting";
      item.dataset.slot = "studio-agent-card";
      item.style.setProperty("--agent", colorFor(agent.id));
      const head = document.createElement("div");
      head.className = "studio-agent-head";
      const identity = document.createElement("div");
      identity.className = "studio-agent-identity";
      const dot = document.createElement("span");
      dot.className = "studio-agent-dot";
      dot.setAttribute("aria-hidden", "true");
      identity.append(dot, createTextNode("strong", agent.name, "studio-agent-name"));
      head.append(identity, createTextNode("span", taskStatusLabel(agent.status), "studio-agent-state"));
      const task = createTextNode("div", agent.detail, "studio-agent-task");
      const signal = document.createElement("div");
      signal.className = "studio-agent-signal";
      signal.append(createTextNode("span", signalAge(agent.updatedAt).label), createTextNode("span", agent.model || "runtime"));
      const line = document.createElement("div");
      line.className = "studio-working-line";
      line.setAttribute("aria-hidden", "true");
      item.append(head, task, signal, line);
      return item;
    }));
  }

  const recentEvents = activities.slice(0, 4);
  text("studio-event-count", `${recentEvents.length} update${recentEvents.length === 1 ? "" : "s"}`);
  if (recentEvents.length === 0) {
    eventList.replaceChildren();
  } else {
    eventList.replaceChildren(...recentEvents.map((activity) => {
      const item = document.createElement("li");
      item.className = "agent-message studio-event-row";
      const mark = document.createElement("span");
      mark.className = "agent-message-avatar studio-event-mark";
      mark.style.setProperty("--event", colorFor(activity.agentId || activity.kind));
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = (activity.agentName || activity.agentId || "Studio").slice(0, 1).toUpperCase();
      const article = document.createElement("article");
      const head = document.createElement("header");
      head.append(createTextNode("strong", activity.agentName || activity.agentId || "Studio"));
      const time = createTextNode("time", formatClock(activity.createdAt), "studio-event-time");
      time.setAttribute("datetime", new Date(epochMs(activity.createdAt)).toISOString());
      head.append(time);
      const copy = createTextNode("p", activity.summary, "studio-event-copy");
      article.append(head, copy);
      item.append(mark, article);
      return item;
    }));
  }
};

const renderActivity = (): void => {
  const root = element<HTMLOListElement>("activity-list");
  if (!root) return;
  const available = [...activityRows.values()]
    .filter((row) => replayCursorSeq === null || row.seq <= replayCursorSeq);
  const ordered = available
    .sort((left, right) => left.seq < right.seq ? 1 : left.seq > right.seq ? -1 : 0)
    .slice(0, 28);
  text("activity-count", replayCursorSeq === null
    ? `${activityRows.size} events`
    : `${available.length} / ${replayStepRows.size} events`);
  if (ordered.length === 0) {
    root.replaceChildren(createTextNode("li", replayCursorSeq === null ? "Waiting for run-scoped activity summaries." : "No activity at this replay step.", "empty-copy"));
    return;
  }
  const nodes = ordered.map((activity) => {
    const row = document.createElement("li");
    row.className = "activity-row";
    const time = document.createElement("time");
    time.dateTime = new Date(epochMs(activity.createdAt)).toISOString();
    time.textContent = formatClock(activity.createdAt);
    const copy = document.createElement("div");
    copy.append(createTextNode("strong", activity.agentName || activity.agentId || "Studio"));
    copy.append(document.createTextNode(` ${activity.summary}`));
    copy.append(createTextNode("span", activity.kind, "activity-kind"));
    row.append(time, copy);
    return row;
  });
  root.replaceChildren(...nodes);
};

const renderRunHistory = (): void => {
  const root = element<HTMLUListElement>("canvas-run-list");
  if (!root) return;
  const rows = [...fleetRunRows.values()]
    .sort((left, right) => epochMs(right.updatedAt) - epochMs(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, 80);
  text("canvas-runs-count", `${rows.length} run${rows.length === 1 ? "" : "s"}`);
  if (rows.length === 0) {
    root.replaceChildren(createTextNode("li", "No Canvas runs are visible in this workspace yet.", "empty-copy"));
    return;
  }
  const nodes = rows.map((row) => {
    const item = document.createElement("li");
    item.className = "canvas-run-card";
    const link = document.createElement("a");
    const params = new URLSearchParams({ stream: boot.stream, run: row.id });
    link.href = `/canvas?${params.toString()}`;
    if (row.id === runId) link.setAttribute("aria-current", "page");
    const head = document.createElement("div");
    head.className = "canvas-run-head";
    head.append(createTextNode("strong", row.id), createTextNode("span", runStatusLabel(row.status)));
    const prompt = createTextNode("div", row.prompt || "Untitled Canvas run", "canvas-run-prompt");
    const meta = document.createElement("div");
    meta.className = "canvas-run-meta";
    meta.append(
      createTextNode("span", `${row.objectCount} objects`),
      createTextNode("span", `${row.completedTasks}/${row.totalTasks} tasks`),
      createTextNode("time", new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(new Date(epochMs(row.updatedAt))))
    );
    link.append(head, prompt, meta);
    item.append(link);
    return item;
  });
  root.replaceChildren(...nodes);
};

const renderReview = (): void => {
  const box = element("review-box");
  const list = element<HTMLUListElement>("review-list");
  if (!box || !list) return;
  const steps = replaySteps();
  const cursorStep = replayCursorSeq === null ? undefined : replayStepAtPosition(replayPosition(steps), steps);
  const visibleReviews = [...reviewRows.values()]
    .filter((row) => replayCursorSeq === null || Boolean(cursorStep && row.createdAt.microsSinceUnixEpoch <= cursorStep.createdAt.microsSinceUnixEpoch))
    .sort((left, right) => epochMs(right.createdAt) - epochMs(left.createdAt));
  const review = visibleReviews.find((row) => row.scope === "rendered-visual") ?? visibleReviews[0];
  if (!review) {
    box.dataset.state = "waiting";
    text("review-verdict", "Awaiting validator reports");
    text("review-scope", "not started");
    text("review-score", "PNG + structure");
    list.replaceChildren(createTextNode("li", "Independent subject, composition, consistency, and structural reports join at the first complete scene frontier."));
    return;
  }
  const scores = parseRecord(review.scoresJson) as VisualScores;
  const scoreValues = Object.values(scores).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const average = scoreValues.length > 0 ? Math.round(scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length) : undefined;
  const withNotes = review.qualityStatus === "accepted-with-notes" || review.qualityStatus === "accepted_with_notes";
  box.dataset.state = withNotes ? "warn" : review.verdict === "pass" ? "pass" : "fail";
  text("review-verdict", withNotes ? "Completed with validation notes" : review.verdict === "pass" ? "Validation council passed" : "Targeted repair requested");
  text("review-scope", review.scope.replaceAll("-", " ") || "rendered visual");
  const specialistScopes = ["validator-semantic", "validator-composition", "validator-consistency"];
  const specialistReports = specialistScopes.map((scope) => visibleReviews.find((row) => (
    row.sceneHash === review.sceneHash && row.scope === scope
  ))).filter((row): row is SceneReviewRow => Boolean(row));
  text("review-score", average === undefined ? `${specialistReports.length + 1} validators` : `${average} / 100 · ${specialistReports.length + 1} validators`);
  const specialistNotes = specialistReports.flatMap((row) => {
    const summary = parseStringList(row.checksJson)[0];
    return summary ? [`${row.scope.replace("validator-", "")}: ${summary.replace(/^[^:]+:\s*/, "")}`] : [];
  });
  const notes = [
    ...specialistNotes,
    ...parseStringList(review.checksJson),
    ...parseStringList(review.notesJson),
  ].slice(0, 12);
  list.replaceChildren(...(notes.length > 0 ? notes.map((note) => createTextNode("li", note)) : [createTextNode("li", "No visual issues recorded.")]));
};

const renderLiveness = (): void => {
  const run = runRows.get(runId);
  const status = effectiveRunStatus(run, runId ? "connecting" : "idle");
  const signal = element("frontier-signal");
  if (!signal || terminalRunStatuses.has(status) || status === "idle") return;
  const activeAgents = [...agentRows.values()].filter((agent) => activeStatuses.has(agent.status));
  const activeTasks = [...taskRows.values()].filter((task) => activeStatuses.has(task.status));
  const candidates = [
    ...activeAgents.map((agent) => ({ name: agent.name || agent.agentId, at: epochMs(agent.updatedAt) })),
    ...activeTasks.map((task) => ({
      name: agentRows.get(`${task.runId.length}:${task.runId}${task.agentId}`)?.name || task.agentId || "Agent",
      at: epochMs(task.updatedAt),
    })),
    ...(run ? [{ name: status === "planning" ? "Art Director" : "Coordinator", at: epochMs(run.updatedAt) }] : []),
  ].sort((left, right) => right.at - left.at);
  const latest = candidates[0];
  if (!latest || latest.at <= 0) {
    signal.dataset.state = "delayed";
    signal.textContent = "Waiting for first agent signal";
    return;
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - latest.at) / 1_000));
  signal.dataset.state = ageSeconds > 60 ? "stale" : ageSeconds > 15 ? "delayed" : "live";
  signal.textContent = ageSeconds > 60
    ? `No durable agent update for ${ageSeconds}s`
    : ageSeconds > 15
      ? `${latest.name} · model call may be in flight · ${ageSeconds}s`
      : `${latest.name} · signal now`;
};

const renderDashboard = (): void => {
  const run = runRows.get(runId);
  const plan = planRows.get(runId);
  const steps = replaySteps();
  const currentReplayPosition = replayPosition(steps);
  const replayStep = replayStepAtPosition(currentReplayPosition, steps);
  const historical = replayCursorSeq !== null && currentReplayPosition < steps.length;
  const agents = [...agentRows.values()].filter((row) => row.runId === runId);
  const tasks = [...taskRows.values()].filter((row) => row.runId === runId);
  const status = effectiveRunStatus(run, runId ? "connecting" : "idle");
  const terminal = terminalRunStatuses.has(status);
  const active = terminal ? 0 : agents.filter((agent) => activeStatuses.has(agent.status)).length
    || new Set(tasks.filter((task) => activeStatuses.has(task.status)).map((task) => task.agentId)).size;
  const queued = terminal ? 0 : agents.filter((agent) => queuedStatuses.has(agent.status)).length
    || tasks.filter((task) => queuedStatuses.has(task.status)).length;
  const completed = run?.completedTasks ?? tasks.filter((task) => task.status === "completed").length;
  const total = run?.totalTasks ?? tasks.length;
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : 0;
  const label = runStatusLabel(status);

  text("metric-run", historical ? "Replay" : label);
  text("metric-active", String(active));
  text("metric-queued", String(queued));
  text("metric-completed", String(completed));
  text("metric-inflight", `${run?.maxInflight ?? 0} inflight allowed`);
  text("metric-budget", String(run?.objectCount ?? sceneNodes.size));
  text("metric-budget-note", "certified scene objects");
  text("canvas-progress-copy", `${completed} / ${total} tasks`);
  const progress = element("canvas-progress");
  progress?.setAttribute("aria-valuenow", String(percent));
  const fill = element("canvas-progress-fill");
  if (fill) fill.style.width = `${percent}%`;

  const live = !historical && !terminalRunStatuses.has(status) && status !== "idle" && status !== "connecting";
  const frontier = element("canvas-frontier");
  if (frontier) frontier.hidden = !live;
  text("frontier-active", String(active));
  text("frontier-done", String(completed));
  text("frontier-label", status === "reviewing" ? "Validation council reviewing the merged frontier" : active > 0 ? `${active} agents publishing together` : "Studio frontier synchronized");

  const subject = plan?.subject || run?.prompt || "Shared vector frontier";
  text("canvas-stage-label", subject);
  text("canvas-caption-title", historical ? `Replay ${currentReplayPosition}/${steps.length}: ${subject}` : status === "completed_with_notes" ? `Completed with notes: ${subject}` : terminalRunStatuses.has(status) ? `${label}: ${subject}` : subject);
  text("canvas-caption-copy", historical
    ? replayStep?.label || "Scene state at the selected durable receipt."
    : status === "canceled"
      ? "This durable run was canceled. Start a new brief to continue."
      : status === "failed" || status === "budget_exhausted"
        ? run?.statusNote || "The durable activity trail preserves why the run stopped."
        : run?.statusNote || plan?.artDirection || run?.prompt || "Scene changes stream directly from SpacetimeDB.");
  const description = document.getElementById("canvas-description");
  if (description) description.textContent = run?.prompt ? `Live multi-agent illustration for: ${run.prompt}` : "Waiting for a run. Scene objects appear incrementally as immutable artist patches arrive.";
  const prompt = element<HTMLTextAreaElement>("canvas-prompt");
  if (prompt && run?.prompt && !prompt.value) prompt.value = run.prompt;
  const parallel = element<HTMLInputElement>("canvas-parallel");
  if (parallel && run?.desiredAgents) parallel.value = String(Math.max(3, run.desiredAgents - 3));
  const submit = element<HTMLButtonElement>("canvas-submit");
  const runActive = Boolean(run && !terminalRunStatuses.has(status));
  if (submit) {
    submit.disabled = !boot.apiReady || runActive;
    submit.setAttribute("aria-disabled", String(!boot.apiReady || runActive));
    submit.textContent = !boot.apiReady
      ? "Provider Setup Required"
      : runActive
      ? label
      : status === "failed" || status === "budget_exhausted"
        ? "Retry as New Run"
        : run
          ? "Start New Painting"
          : "Begin Painting";
  }
  if (parallel) parallel.disabled = runActive;

  text("canvas-object-count", String(sceneNodes.size));
  const empty = element("canvas-empty");
  if (empty) empty.hidden = sceneNodes.size > 0;
  const stopped = status === "failed" || status === "canceled" || status === "budget_exhausted";
  text("canvas-empty-title", status === "canceled"
    ? "The run was canceled"
    : stopped
      ? "The run stopped"
      : run
        ? sceneRows.size > 0 ? "Applying scene patches" : "The studio is connected"
        : "The studio is ready");
  text("canvas-empty-copy", stopped
    ? status === "canceled"
      ? "Start a new brief to create a fresh durable run."
      : run?.statusNote || "The durable activity log preserves the failure reason for a safe retry."
    : run
      ? "Waiting for the first active scene objects from the artist frontier."
      : "Send a brief to watch independent artists publish directly into one shared scene.");
  workspace?.setAttribute("data-state", sceneNodes.size > 0 ? "painted" : run ? "connected" : "empty");
  workspace?.setAttribute("data-replay-state", historical ? "replay" : "live");
  workspace?.setAttribute("aria-busy", String(Boolean(runActive && sceneNodes.size === 0)));
  if (run?.sceneHash) text("last-sync", `scene ${run.sceneHash.slice(0, 9)}…`);
  else if (lastUpdateAt > 0) text("last-sync", `synced ${new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(lastUpdateAt))}`);

  renderTeams(agents);
  renderAgents(agents);
  renderStudioFloor();
  renderActivity();
  renderRunHistory();
  renderReview();
  renderLiveness();
  syncReplayControls();
};

const allowedObjectTypes = new Set(["ellipse", "circle", "line", "polygon", "polyline", "path", "rect"]);
const allowedGeometry = new Set(["cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "d"]);
const allowedStyle = new Map([
  ["fill", "fill"], ["stroke", "stroke"], ["strokeWidth", "stroke-width"], ["opacity", "opacity"],
  ["fillOpacity", "fill-opacity"], ["strokeOpacity", "stroke-opacity"], ["strokeLinecap", "stroke-linecap"],
  ["strokeLinejoin", "stroke-linejoin"], ["strokeDasharray", "stroke-dasharray"],
]);
const pathPattern = /^[MmZzLlHhVvCcSsQqTtAaEe0-9,.\-+\s]+$/;

const gradientIdFor = (row: SceneObjectRow): string => {
  const encoded = [...row.id].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `canvas-paint-${encoded}`;
};

const boundedUnit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const ensureGradient = (row: SceneObjectRow, value: unknown): string | undefined => {
  if (!paintDefs || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const gradient = value as Readonly<Record<string, unknown>>;
  const kind = gradient.kind;
  if (kind !== "linear-gradient" && kind !== "radial-gradient") return undefined;
  const stops = gradient.stops;
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 4) return undefined;
  const coordinates = kind === "linear-gradient"
    ? [gradient.x1, gradient.y1, gradient.x2, gradient.y2]
    : [gradient.cx, gradient.cy, gradient.r];
  if (!coordinates.every(boundedUnit)) return undefined;
  if (kind === "radial-gradient" && gradient.r === 0) return undefined;
  const parsedStops = stops.map((stop) => {
    if (!stop || typeof stop !== "object" || Array.isArray(stop)) return undefined;
    const record = stop as Readonly<Record<string, unknown>>;
    if (!boundedUnit(record.offset) || !boundedUnit(record.opacity)
      || typeof record.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(record.color)) return undefined;
    return { offset: record.offset, opacity: record.opacity, color: record.color };
  });
  if (parsedStops.some((stop) => !stop)) return undefined;
  let previousOffset = -1;
  for (const stop of parsedStops) {
    if (!stop || stop.offset < previousOffset) return undefined;
    previousOffset = stop.offset;
  }
  const id = gradientIdFor(row);
  gradientNodes.get(row.id)?.remove();
  const node = document.createElementNS(
    "http://www.w3.org/2000/svg",
    kind === "linear-gradient" ? "linearGradient" : "radialGradient"
  );
  node.id = id;
  if (kind === "linear-gradient") {
    node.setAttribute("x1", String(gradient.x1));
    node.setAttribute("y1", String(gradient.y1));
    node.setAttribute("x2", String(gradient.x2));
    node.setAttribute("y2", String(gradient.y2));
  } else {
    node.setAttribute("cx", String(gradient.cx));
    node.setAttribute("cy", String(gradient.cy));
    node.setAttribute("r", String(gradient.r));
  }
  for (const stop of parsedStops) {
    if (!stop) continue;
    const stopNode = document.createElementNS("http://www.w3.org/2000/svg", "stop");
    stopNode.setAttribute("offset", `${stop.offset * 100}%`);
    stopNode.setAttribute("stop-color", stop.color);
    stopNode.setAttribute("stop-opacity", String(stop.opacity));
    node.append(stopNode);
  }
  paintDefs.append(node);
  gradientNodes.set(row.id, node);
  return id;
};

const geometryValue = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.length <= 512 && value.every((item) => typeof item === "number" && Number.isFinite(item))) return value.join(" ");
  if (typeof value === "string" && value.length <= 8_000) return value;
  return undefined;
};

const compareSceneOrder = (left: SceneObjectRow, right: SceneObjectRow): number =>
  left.layer - right.layer || left.rank - right.rank || left.objectId.localeCompare(right.objectId);

const sceneObjectVisible = (row: SceneObjectRow, replayPatches: ReadonlySet<string>): boolean =>
  replayCursorSeq === null ? row.active : replayPatches.has(row.patchId);

const insertNodeInOrder = (node: SVGElement, row: SceneObjectRow, replayPatches: ReadonlySet<string>): void => {
  if (!sceneRoot) return;
  const orderedRows = [...sceneRows.values()]
    .filter((candidate) => sceneObjectVisible(candidate, replayPatches) && sceneNodes.has(candidate.id))
    .sort(compareSceneOrder);
  const index = orderedRows.findIndex((candidate) => candidate.id === row.id);
  const nextRow = index >= 0 ? orderedRows[index + 1] : undefined;
  const nextNode = nextRow ? sceneNodes.get(nextRow.id) : undefined;
  sceneRoot.insertBefore(node, nextNode ?? null);
};

const removeSceneObject = (id: string): void => {
  sceneRows.delete(id);
  sceneNodes.get(id)?.remove();
  sceneNodes.delete(id);
  gradientNodes.get(id)?.remove();
  gradientNodes.delete(id);
  scheduleRender();
};

const renderSceneObject = (row: SceneObjectRow, replayPatches: ReadonlySet<string>): void => {
  if (!allowedObjectTypes.has(row.objectType) || !sceneRoot) {
    sceneNodes.get(row.id)?.remove();
    sceneNodes.delete(row.id);
    gradientNodes.get(row.id)?.remove();
    gradientNodes.delete(row.id);
    return;
  }
  if (!sceneObjectVisible(row, replayPatches)) {
    const existing = sceneNodes.get(row.id);
    if (existing) existing.style.display = "none";
    return;
  }
  const geometry = parseRecord(row.geometryJson);
  const style = parseRecord(row.styleJson);
  if (!style.fill || typeof style.fill !== "object" || Array.isArray(style.fill)) {
    gradientNodes.get(row.id)?.remove();
    gradientNodes.delete(row.id);
  }
  if (row.objectType === "path" && (typeof geometry.d !== "string" || !pathPattern.test(geometry.d))) return;
  let node = sceneNodes.get(row.id);
  if (!node || node.tagName.toLowerCase() !== row.objectType) {
    node?.remove();
    node = document.createElementNS("http://www.w3.org/2000/svg", row.objectType);
    node.classList.add("scene-object");
    node.id = `scene-${row.objectId}`;
    sceneNodes.set(row.id, node);
  }
  node.style.removeProperty("display");
  for (const key of allowedGeometry) node.removeAttribute(key);
  for (const attr of allowedStyle.values()) node.removeAttribute(attr);
  for (const [key, value] of Object.entries(geometry)) {
    if (!allowedGeometry.has(key)) continue;
    const encoded = geometryValue(value);
    if (encoded !== undefined) node.setAttribute(key, encoded);
  }
  for (const [key, value] of Object.entries(style)) {
    const attr = allowedStyle.get(key);
    if (!attr || value === undefined) continue;
    if (key === "fill" && typeof value === "object" && !Array.isArray(value)) {
      const id = ensureGradient(row, value);
      if (id) node.setAttribute("fill", `url(#${id})`);
      continue;
    }
    if (key === "strokeDasharray" && Array.isArray(value)
      && value.length >= 1 && value.length <= 8
      && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0 && entry <= 100)) {
      node.setAttribute(attr, value.join(" "));
      continue;
    }
    if ((typeof value !== "string" && typeof value !== "number") || String(value).length > 200 || /url\s*\(/i.test(String(value))) continue;
    node.setAttribute(attr, String(value));
  }
  node.dataset.agent = row.ownerAgentId;
  node.dataset.part = row.partId;
  node.style.setProperty("--owner-color", colorFor(row.ownerAgentId));
  let title = node.querySelector<SVGTitleElement>("title");
  if (!title) {
    title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    node.prepend(title);
  }
  title.textContent = `${row.semanticId} — ${row.ownerAgentId}`;
  insertNodeInOrder(node, row, replayPatches);
};

const reconcileScene = (): void => {
  const replayPatches = replayActivePatchIds();
  for (const row of sceneRows.values()) renderSceneObject(row, replayPatches);
  scheduleRender();
};

const applySceneObject = (row: SceneObjectRow): void => {
  sceneRows.set(row.id, row);
  reconcileScene();
};

const capActivityMemory = (): void => {
  if (activityRows.size <= 240) return;
  const oldest = [...activityRows.values()].sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
  for (const row of oldest.slice(0, activityRows.size - 240)) activityRows.delete(row.id);
};

const registerDeltaHandlers = (connection: DbConnection): void => {
  connection.db.myCanvasFleetRuns.onInsert((_ctx, row) => { fleetRunRows.set(row.id, row as CanvasFleetRunRow); scheduleRender(); });
  connection.db.myCanvasFleetRuns.onUpdate((_ctx, _old, row) => { fleetRunRows.set(row.id, row as CanvasFleetRunRow); scheduleRender(); });
  connection.db.myCanvasFleetRuns.onDelete((_ctx, row) => { fleetRunRows.delete(row.id); scheduleRender(); });
  connection.db.myCanvasRunUi.onInsert((_ctx, row) => { if (row.id === runId) { runRows.set(row.id, row as CanvasRunRow); scheduleRender(); } });
  connection.db.myCanvasRunUi.onUpdate((_ctx, _old, row) => { if (row.id === runId) { runRows.set(row.id, row as CanvasRunRow); scheduleRender(); } });
  connection.db.myCanvasRunUi.onDelete((_ctx, row) => { if (row.id === runId) { runRows.delete(row.id); scheduleRender(); } });

  connection.db.myScenePlan.onInsert((_ctx, row) => { planRows.set(row.runId, row as ScenePlanRow); scheduleRender(); });
  connection.db.myScenePlan.onUpdate((_ctx, _old, row) => { planRows.set(row.runId, row as ScenePlanRow); scheduleRender(); });
  connection.db.myScenePlan.onDelete((_ctx, row) => { planRows.delete(row.runId); scheduleRender(); });

  connection.db.myCanvasAgents.onInsert((_ctx, row) => { agentRows.set(row.id, row as CanvasAgentRow); scheduleRender(); });
  connection.db.myCanvasAgents.onUpdate((_ctx, _old, row) => { agentRows.set(row.id, row as CanvasAgentRow); scheduleRender(); });
  connection.db.myCanvasAgents.onDelete((_ctx, row) => { agentRows.delete(row.id); scheduleRender(); });

  connection.db.myCanvasTaskStatuses.onInsert((_ctx, row) => { taskRows.set(row.id, row as CanvasTaskStatusRow); scheduleRender(); });
  connection.db.myCanvasTaskStatuses.onUpdate((_ctx, _old, row) => { taskRows.set(row.id, row as CanvasTaskStatusRow); scheduleRender(); });
  connection.db.myCanvasTaskStatuses.onDelete((_ctx, row) => { taskRows.delete(row.id); scheduleRender(); });

  connection.db.mySceneReviews.onInsert((_ctx, row) => { reviewRows.set(row.id, row as SceneReviewRow); scheduleRender(); });
  connection.db.mySceneReviews.onDelete((_ctx, row) => { reviewRows.delete(row.id); scheduleRender(); });

  connection.db.mySceneObjects.onInsert((_ctx, row) => applySceneObject(row as SceneObjectRow));
  connection.db.mySceneObjects.onUpdate((_ctx, _old, row) => applySceneObject(row as SceneObjectRow));
  connection.db.mySceneObjects.onDelete((_ctx, row) => removeSceneObject(row.id));

  connection.db.myCanvasActivity.onInsert((_ctx, row) => {
    activityRows.set(row.id, row as CanvasActivityRow);
    capActivityMemory();
    scheduleRender();
  });
  connection.db.myCanvasActivity.onDelete((_ctx, row) => { activityRows.delete(row.id); scheduleRender(); });

  connection.db.myCanvasReplaySteps.onInsert((_ctx, row) => {
    replayStepRows.set(row.id, row as CanvasReplayStepRow);
    reconcileScene();
  });
  connection.db.myCanvasReplaySteps.onDelete((_ctx, row) => {
    replayStepRows.delete(row.id);
    reconcileScene();
  });
};

const hydrateFromCache = (connection: DbConnection): void => {
  for (const row of connection.db.myCanvasFleetRuns.iter()) fleetRunRows.set(row.id, row as CanvasFleetRunRow);
  for (const row of connection.db.myCanvasRunUi.iter()) if (row.id === runId) runRows.set(row.id, row as CanvasRunRow);
  for (const row of connection.db.myScenePlan.iter()) planRows.set(row.runId, row as ScenePlanRow);
  for (const row of connection.db.myCanvasAgents.iter()) agentRows.set(row.id, row as CanvasAgentRow);
  for (const row of connection.db.myCanvasTaskStatuses.iter()) taskRows.set(row.id, row as CanvasTaskStatusRow);
  for (const row of connection.db.mySceneReviews.iter()) reviewRows.set(row.id, row as SceneReviewRow);
  for (const row of connection.db.myCanvasActivity.iter()) activityRows.set(row.id, row as CanvasActivityRow);
  capActivityMemory();
  for (const row of connection.db.mySceneObjects.iter()) sceneRows.set(row.id, row as SceneObjectRow);
  for (const row of connection.db.myCanvasReplaySteps.iter()) replayStepRows.set(row.id, row as CanvasReplayStepRow);
  const steps = replaySteps();
  const head = steps.at(-1);
  if (replayCursorSeq !== null && head && replayCursorSeq >= head.seq) {
    replayCursorSeq = null;
    updateReplayUrl();
  }
  reconcileScene();
};

const runQueries = () => [
  ...(boot.realtime.workspaceId
    ? [tables.myCanvasFleetRuns.where((row) => row.workspaceId.eq(boot.realtime.workspaceId!))]
    : []),
  ...(runId ? [
    tables.myCanvasRunUi.where((row) => row.id.eq(runId)),
    tables.myScenePlan.where((row) => row.runId.eq(runId)),
    tables.myCanvasAgents.where((row) => row.runId.eq(runId)),
    tables.myCanvasTaskStatuses.where((row) => row.runId.eq(runId)),
    tables.mySceneReviews.where((row) => row.runId.eq(runId)),
    tables.mySceneObjects.where((row) => row.runId.eq(runId)),
    tables.myCanvasActivity.where((row) => row.runId.eq(runId)),
    tables.myCanvasReplaySteps.where((row) => row.runId.eq(runId)),
  ] : []),
];

const setReplayPosition = (position: number, updateUrl = true): void => {
  const steps = replaySteps();
  const next = Math.max(0, Math.min(Math.round(position), steps.length));
  replayCursorSeq = next >= steps.length
    ? null
    : next === 0
      ? 0n
      : steps[next - 1]!.seq;
  // Set replay styling before reconciling SVG nodes so newly visible objects
  // never retrigger their live entrance animation during playback.
  workspace?.setAttribute("data-replay-state", "replay");
  if (updateUrl) updateReplayUrl();
  reconcileScene();
};

const scheduleReplayPlayback = (): void => {
  window.clearTimeout(replayTimer);
  if (!replayPlaying) return;
  replayTimer = window.setTimeout(() => {
    const steps = replaySteps();
    const current = replayPosition(steps);
    if (steps.length === 0 || current >= steps.length) {
      stopReplayPlayback();
      syncReplayControls();
      return;
    }
    setReplayPosition(current + 1);
    if (replayCursorSeq === null) stopReplayPlayback();
    syncReplayControls();
    if (replayPlaying) scheduleReplayPlayback();
  }, replayDelay);
};

const replayControls = element("canvas-replay-controls");
replayControls?.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-replay-action]") : null;
  if (!(target instanceof HTMLButtonElement) || target.disabled) return;
  const action = target.dataset.replayAction;
  if (action === "play") {
    if (replayPlaying) {
      stopReplayPlayback();
      syncReplayControls();
      return;
    }
    const steps = replaySteps();
    if (steps.length === 0) return;
    if (replayPosition(steps) >= steps.length) setReplayPosition(0);
    replayPlaying = true;
    syncReplayControls();
    scheduleReplayPlayback();
    return;
  }
  stopReplayPlayback();
  const current = replayPosition();
  if (action === "start") setReplayPosition(0);
  else if (action === "previous") setReplayPosition(current - 1);
  else if (action === "next") setReplayPosition(current + 1);
  else if (action === "live") setReplayPosition(replaySteps().length);
  syncReplayControls();
});

replayControls?.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches("[data-replay-scrub]")) return;
  stopReplayPlayback();
  setReplayPosition(Number(target.value));
  syncReplayControls();
});

replayControls?.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || !target.matches("[data-replay-speed]")) return;
  replayDelay = Number(target.value) || 700;
  if (replayPlaying) scheduleReplayPlayback();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden || !replayPlaying) return;
  stopReplayPlayback();
  syncReplayControls();
});

let connection: DbConnection | undefined;
let subscription: SubscriptionHandle | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let closing = false;
let connectionGeneration = 0;
const livenessTimer = window.setInterval(() => {
  renderLiveness();
  renderStudioFloor();
}, 1_000);
const accessSecret = consumeAccessSecret();
const capabilityHashPromise = accessSecret ? sha256Hex(accessSecret) : Promise.resolve(undefined);
const workspaceCapabilityHashPromise = boot.realtime.workspaceCapabilitySecret
  ? sha256Hex(boot.realtime.workspaceCapabilitySecret)
  : Promise.resolve(undefined);

const subscribeToRun = async (next: DbConnection, generation: number): Promise<void> => {
  setConnectionState("syncing", "SYNCING", "Joining the workspace and applying one atomic snapshot…");
  const workspaceCapabilityHash = await workspaceCapabilityHashPromise;
  if (boot.realtime.workspaceId && workspaceCapabilityHash) {
    await next.reducers.joinWorkspace({ workspaceId: boot.realtime.workspaceId, capabilityHash: workspaceCapabilityHash });
  }
  const capabilityHash = await capabilityHashPromise;
  if (runId && capabilityHash) await next.reducers.joinCanvasRun({ runId, capabilityHash });
  if (runId && boot.realtime.workspaceId) {
    await next.reducers.joinCanvasWorkspaceRun({ workspaceId: boot.realtime.workspaceId, runId });
  }
  clearCollectionState();
  registerDeltaHandlers(next);
  subscription = next.subscriptionBuilder()
    .onApplied(() => {
      if (generation !== connectionGeneration) return;
      reconnectAttempt = 0;
      hydrateFromCache(next);
      setConnectionState("live", "LIVE", "Caller-scoped transactional updates are active.");
      if (runId && !runRows.has(runId)) {
        text("connection-copy", "Connected, but this identity cannot see the run");
        text("connection-detail", "Use a valid #access capability or sign in with an existing run member identity.");
      }
    })
    .onError(() => {
      if (generation !== connectionGeneration) return;
      setConnectionState("error", "SUBSCRIPTION ERROR", "The run-scoped view could not be applied.");
      scheduleReconnect("The run subscription closed.");
    })
    .subscribe(runQueries());
};

const scheduleReconnect = (reason: string): void => {
  if (closing || reconnectTimer !== undefined) return;
  reconnectAttempt += 1;
  const delay = Math.min(30_000, 700 * 2 ** Math.min(reconnectAttempt - 1, 5));
  setConnectionState("reconnecting", "RECONNECTING", `${reason} Retrying in ${Math.ceil(delay / 1_000)}s.`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
};

const connect = (): void => {
  if (closing || !boot.realtime.enabled || (!runId && !boot.realtime.workspaceId)) return;
  const generation = connectionGeneration + 1;
  connectionGeneration = generation;
  subscription?.unsubscribe();
  subscription = undefined;
  const previous = connection;
  connection = undefined;
  // The generation guard makes this intentional disconnect invisible to the
  // old socket's onDisconnect callback.
  previous?.disconnect();
  setConnectionState(reconnectAttempt > 0 ? "reconnecting" : "connecting", reconnectAttempt > 0 ? "RECONNECTING" : "CONNECTING", `Opening ${boot.realtime.database}…`);
  try {
    connection = DbConnection.builder()
      .withUri(boot.realtime.uri)
      .withDatabaseName(boot.realtime.database)
      .withToken(readStoredAuthToken())
      .withConfirmedReads(boot.realtime.confirmedReads)
      .withLightMode(true)
      .onConnect((next, _identity, token) => {
        if (generation !== connectionGeneration) {
          next.disconnect();
          return;
        }
        persistAuthToken(token);
        void subscribeToRun(next, generation).catch((error: unknown) => {
          if (generation !== connectionGeneration) return;
          const message = error instanceof Error ? error.message : String(error);
          setConnectionState("error", "ACCESS DENIED", message);
        });
      })
      .onConnectError((_ctx, error) => {
        if (generation === connectionGeneration) scheduleReconnect(error.message || "Connection failed.");
      })
      .onDisconnect((_ctx, error) => {
        if (generation === connectionGeneration) scheduleReconnect(error?.message || "Connection closed.");
      })
      .build();
  } catch (error) {
    scheduleReconnect(error instanceof Error ? error.message : String(error));
  }
};

const form = element<HTMLFormElement>("canvas-run-form");
form?.addEventListener("submit", (event) => {
  if (form.dataset.submitting === "true") {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  form.dataset.submitting = "true";
  const submit = element<HTMLButtonElement>("canvas-submit");
  if (submit) {
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = "Opening studio…";
  }
  setConnectionState("syncing", "OPENING STUDIO", "Creating the durable run before redirecting…");

  void (async () => {
    try {
      const response = await fetch("/canvas/run-token", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("Canvas could not refresh the run form.");
      const payload: unknown = await response.json();
      const csrfToken = typeof payload === "object" && payload !== null && "csrfToken" in payload
        ? (payload as { readonly csrfToken?: unknown }).csrfToken
        : undefined;
      const csrfInput = form.elements.namedItem("csrf");
      if (typeof csrfToken !== "string" || !(csrfInput instanceof HTMLInputElement)) {
        throw new Error("Canvas could not refresh the run form.");
      }
      csrfInput.value = csrfToken;
      HTMLFormElement.prototype.submit.call(form);
    } catch {
      delete form.dataset.submitting;
      renderDashboard();
      setConnectionState("error", "RUN NOT STARTED", "Canvas could not refresh the run form. Try again.");
    }
  })();
});

window.addEventListener("beforeunload", () => {
  closing = true;
  window.clearInterval(livenessTimer);
  connectionGeneration += 1;
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  subscription?.unsubscribe();
  connection?.disconnect();
});

if (!boot.realtime.enabled) {
  setConnectionState("error", "REALTIME DISABLED", "SpacetimeDB realtime is not enabled for this environment.");
} else if (runId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(runId)) {
  setConnectionState("error", "INVALID RUN", "The requested run identifier is not valid.");
} else if (!runId && !boot.realtime.workspaceId) {
  setConnectionState("idle", "READY", "Submit a visual brief to open a run-scoped realtime channel.");
} else {
  connect();
}

renderDashboard();
