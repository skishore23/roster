import {
  COMMAND_WORKER_AGENT_IDS,
  getAgentCoordinationPattern,
  getAgentDescription,
  getAgentDisplayMeta,
} from "../agents/agent-display.js";
import type { QueueCommandRecord, QueueJob } from "../engine/runtime/job-queue.js";
import type { JobEvent, JobLane, JobStatus } from "../modules/job.js";
import { initial as initialJob, reduce as reduceJob } from "../modules/job.js";
import { esc, truncate } from "../views/agent-framework.js";

export type MonitorTimestamp =
  | number
  | bigint
  | { readonly microsSinceUnixEpoch: bigint };

export type MonitorJobRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly lane: string;
  readonly sessionKey: string;
  readonly singletonMode: string;
  readonly payloadJson: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseWorker: string;
  readonly leaseFence: bigint;
  readonly leaseUntil?: MonitorTimestamp;
  readonly lastError: string;
  readonly resultJson: string;
  readonly canceledReason: string;
  readonly abortRequested: boolean;
  readonly createdAt: MonitorTimestamp;
  readonly updatedAt: MonitorTimestamp;
};

export type MonitorJobCommandRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly command: string;
  readonly lane: string;
  readonly payloadJson: string;
  readonly by: string;
  readonly createdAt: MonitorTimestamp;
  readonly consumedAt?: MonitorTimestamp;
};

export type MonitorCanvasRunRow = {
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
  readonly createdAt: MonitorTimestamp;
  readonly updatedAt: MonitorTimestamp;
};

export type MonitorReceiptRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly seq: bigint;
  readonly receiptId: string;
  readonly occurredAtMs: bigint;
  readonly bodyJson: string;
};

export type MonitorMemoryEntry = {
  readonly id: string;
  readonly scope: string;
  readonly text: string;
  readonly tags?: ReadonlyArray<string>;
  readonly ts: number;
};

const JOB_STATUSES = new Set<JobStatus>([
  "queued",
  "leased",
  "running",
  "completed",
  "failed",
  "canceled",
]);
const JOB_LANES = new Set<JobLane>(["collect", "steer", "follow_up"]);
const TERMINAL = new Set<JobStatus>(["completed", "failed", "canceled"]);

const asRecord = (encoded: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(encoded || "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const timestampMs = (value: MonitorTimestamp | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value.microsSinceUnixEpoch / 1_000n);
};

const jobStatus = (value: string): JobStatus => JOB_STATUSES.has(value as JobStatus)
  ? value as JobStatus
  : "failed";

const jobLane = (value: string): JobLane => JOB_LANES.has(value as JobLane)
  ? value as JobLane
  : "collect";

const commandRowsFor = (
  workspaceId: string,
  jobId: string,
  rows: ReadonlyArray<MonitorJobCommandRow>,
): ReadonlyArray<QueueCommandRecord> => rows
  .filter((row) => row.workspaceId === workspaceId && row.jobId === jobId)
  .sort((left, right) => (timestampMs(left.createdAt) ?? 0) - (timestampMs(right.createdAt) ?? 0))
  .flatMap((row): ReadonlyArray<QueueCommandRecord> => {
    if (row.command !== "steer" && row.command !== "follow_up" && row.command !== "abort") return [];
    const lane = row.lane === "follow_up" ? "follow_up" : "steer";
    return [{
      id: row.id,
      command: row.command,
      lane,
      payload: asRecord(row.payloadJson),
      by: row.by || undefined,
      createdAt: timestampMs(row.createdAt) ?? 0,
      consumedAt: timestampMs(row.consumedAt),
    }];
  });

export const projectMonitorJobs = (
  rows: ReadonlyArray<MonitorJobRow>,
  commands: ReadonlyArray<MonitorJobCommandRow>,
  workspaceId: string,
): ReadonlyArray<QueueJob> => rows
  .filter((row) => row.workspaceId === workspaceId)
  .map((row): QueueJob => ({
  id: row.id,
  agentId: row.agentId,
  lane: jobLane(row.lane),
  sessionKey: row.sessionKey || undefined,
  singletonMode: row.singletonMode === "cancel" || row.singletonMode === "steer" || row.singletonMode === "reject"
    ? row.singletonMode
    : "allow",
  payload: asRecord(row.payloadJson),
  status: jobStatus(row.status),
  attempt: row.attempt,
  maxAttempts: row.maxAttempts,
  createdAt: timestampMs(row.createdAt) ?? 0,
  updatedAt: timestampMs(row.updatedAt) ?? 0,
  leaseOwner: row.leaseWorker || undefined,
  leaseUntil: timestampMs(row.leaseUntil),
  lastError: row.lastError || undefined,
  result: Object.keys(asRecord(row.resultJson)).length > 0 ? asRecord(row.resultJson) : undefined,
  canceledReason: row.canceledReason || undefined,
  abortRequested: row.abortRequested,
  commands: commandRowsFor(row.workspaceId, row.id, commands),
})).sort((left, right) =>
  right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id));

const canvasStatus = (status: string): JobStatus => {
  if (status === "completed" || status === "completed_with_notes") return "completed";
  if (status === "failed" || status === "budget_exhausted") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "queued") return "queued";
  return "running";
};

export const projectMonitorCanvasRuns = (
  rows: ReadonlyArray<MonitorCanvasRunRow>,
  workspaceId: string,
): ReadonlyArray<QueueJob> => rows
  .filter((row) => row.workspaceId === workspaceId)
  .map((row): QueueJob => ({
    id: `canvas:${row.id}`,
    agentId: "canvas",
    lane: "collect",
    sessionKey: row.id,
    singletonMode: "allow",
    payload: {
      runId: row.id,
      stream: "agents/canvas",
      runStream: `agents/canvas/runs/${row.id}`,
      problem: row.prompt,
      kind: "canvas.run",
      canvasRun: true,
      activeAgents: row.activeAgents,
      totalAgents: row.totalAgents,
      objectCount: row.objectCount,
      completedTasks: row.completedTasks,
      totalTasks: row.totalTasks,
    },
    status: canvasStatus(row.status),
    attempt: 1,
    maxAttempts: 1,
    createdAt: timestampMs(row.createdAt) ?? 0,
    updatedAt: timestampMs(row.updatedAt) ?? 0,
    commands: [],
  }))
  .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));

const statusClass = (status: JobStatus): string => `status-${status}`;
const formatClock = (timestamp: number): string => new Date(timestamp).toLocaleTimeString([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const formatDateTime = (timestamp: number): string => new Date(timestamp).toLocaleString();

const jobSummary = (job: QueueJob): string => {
  const problem = typeof job.payload.problem === "string"
    ? job.payload.problem.replace(/\s+/g, " ").trim()
    : "";
  if (problem) return problem;
  const kind = typeof job.payload.kind === "string" ? job.payload.kind : "";
  return kind || `${getAgentDisplayMeta(job.agentId).label} run`;
};

export const renderMonitorQueue = (
  jobs: ReadonlyArray<QueueJob>,
  input: {
    readonly selectedJobId?: string;
    readonly status?: JobStatus;
    readonly limit: number;
  },
): string => {
  const filtered = jobs
    .filter((job) => !input.status || job.status === input.status)
    .slice(0, Math.max(1, Math.min(input.limit, 240)));
  const active = filtered.filter((job) => !TERMINAL.has(job.status)).length;
  const rows = filtered.map((job) => {
    const payloadRun = typeof job.payload.runId === "string" ? job.payload.runId : "";
    const payloadStream = typeof job.payload.stream === "string" ? job.payload.stream : "";
    const explicitName = typeof job.payload.agentName === "string" ? job.payload.agentName : undefined;
    const agent = getAgentDisplayMeta(job.agentId, explicitName);
    return `<tr class="job-row${job.id === input.selectedJobId ? " is-selected" : ""}">
      <td><button class="job-select mono" type="button" data-job-select="${esc(job.id)}" data-job-run="${esc(payloadRun)}" data-job-stream="${esc(payloadStream)}" title="${esc(job.id)}">${esc(truncate(job.id, 30))}</button></td>
      <td><span class="status-pill ${statusClass(job.status)}">${esc(job.status)}</span></td>
      <td title="${esc(agent.rawId ?? agent.label)}">${esc(agent.label)}</td>
      <td class="mono">${job.attempt}/${job.maxAttempts}</td>
      <td class="mono" title="${esc(formatDateTime(job.updatedAt))}">${esc(formatClock(job.updatedAt))}</td>
      <td>${esc(truncate(jobSummary(job), 88))}</td>
    </tr>`;
  }).join("");
  return `<div class="jobs-wrap">
    <div class="jobs-meta"><span class="chip">Visible: ${filtered.length}</span><span class="chip">Active: ${active}</span><span class="chip">Terminal: ${filtered.length - active}</span></div>
    <div class="table-wrap"><table class="jobs-table"><thead><tr><th>Job</th><th>Status</th><th>Agent</th><th>Attempt</th><th>Updated</th><th>Summary</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty-cell">No jobs match this view.</td></tr>`}</tbody></table></div>
  </div>`;
};

export const renderMonitorFleet = (jobs: ReadonlyArray<QueueJob>): string => COMMAND_WORKER_AGENT_IDS
  .map((agentId) => {
    const agentJobs = jobs.filter((job) => job.agentId === agentId);
    const active = agentJobs.filter((job) => !TERMINAL.has(job.status)).length;
    const latest = agentJobs[0];
    const display = getAgentDisplayMeta(agentId);
    const activeCopy = active > 0
      ? `Present in ${active} active ${active === 1 ? "room" : "rooms"}`
      : "Ready to join a room";
    const continuityCopy = latest ? "Recent context available" : "Fresh context";
    return `<article class="agent-card">
      <div class="agent-card-head"><strong>${esc(display.label)}</strong><span class="status-pill ${latest ? statusClass(latest.status) : ""}">${active > 0 ? `${active} active` : esc(latest?.status ?? "idle")}</span></div>
      <span class="agent-pattern">${esc(getAgentCoordinationPattern(agentId))}</span>
      <p>${esc(getAgentDescription(agentId))}</p>
      <footer><span>${esc(activeCopy)}</span><span>${esc(continuityCopy)}</span></footer>
    </article>`;
  }).join("");

const commandFormQuery = (job: QueueJob): string => {
  const params = new URLSearchParams();
  if (typeof job.payload.stream === "string") params.set("stream", job.payload.stream);
  if (typeof job.payload.runId === "string") params.set("run", job.payload.runId);
  params.set("job", job.id);
  return params.toString();
};

const resultMeta = (job: QueueJob): string => {
  const result = job.result ?? {};
  const values = [
    ["Failure class", result.failureClass],
    ["Follow-up job", result.followUpJobId],
    ["Follow-up run", result.followUpRunId],
  ] as const;
  return values.flatMap(([label, value]) => typeof value === "string" && value
    ? [`<div class="detail-card"><span>${esc(label)}</span><strong class="mono">${esc(value)}</strong></div>`]
    : []).join("");
};

export const renderMonitorJobDetail = (job: QueueJob | undefined): string => {
  if (!job) return `<div class="empty">Select a job to inspect its durable state and queue a command.</div>`;
  const query = commandFormQuery(job);
  const commands = [...job.commands].reverse().map((command) => `<li><code>${esc(formatClock(command.createdAt))}</code><span>${esc(command.command)} · ${esc(command.lane)}${command.consumedAt ? " · consumed" : " · pending"}</span></li>`).join("");
  const canvasRun = job.agentId === "canvas" && typeof job.payload.runId === "string";
  const canvasActions = canvasRun
    ? `<a class="primary" href="/canvas?stream=agents%2Fcanvas&amp;run=${encodeURIComponent(job.payload.runId as string)}">Open Canvas studio</a>`
    : `<form class="command-form" method="post" action="/monitor/job/${encodeURIComponent(job.id)}/steer?${esc(query)}" data-monitor-command-form><strong>Steer job</strong><label>Problem override<textarea name="problem" placeholder="Refocus the active worker"></textarea></label><label>Config JSON<textarea name="config" placeholder='{"maxIterations":4}'></textarea></label><button type="submit">Queue steer</button></form>
    <form class="command-form" method="post" action="/monitor/job/${encodeURIComponent(job.id)}/follow-up?${esc(query)}" data-monitor-command-form><strong>Follow-up</strong><label>Guidance<textarea name="note" placeholder="Add another task after this run" required></textarea></label><button type="submit">Queue follow-up</button></form>
    <form class="command-form danger-form" method="post" action="/monitor/job/${encodeURIComponent(job.id)}/abort?${esc(query)}" data-monitor-command-form><strong>Abort</strong><label>Reason<input name="reason" value="operator requested abort" /></label><button type="submit">Queue abort</button></form>`;
  return `<div class="job-detail" data-job-id="${esc(job.id)}">
    <div class="detail-grid">
      <div class="detail-card"><span>Job</span><strong class="mono">${esc(job.id)}</strong></div>
      <div class="detail-card"><span>Status</span><strong><span class="status-pill ${statusClass(job.status)}">${esc(job.status)}</span></strong></div>
      <div class="detail-card"><span>Agent</span><strong>${esc(getAgentDisplayMeta(job.agentId).label)}</strong></div>
      <div class="detail-card"><span>Attempt</span><strong class="mono">${job.attempt}/${job.maxAttempts}</strong></div>
      <div class="detail-card"><span>Worker</span><strong class="mono">${esc(job.leaseOwner ?? "unassigned")}</strong></div>
      <div class="detail-card"><span>Updated</span><strong class="mono">${esc(formatDateTime(job.updatedAt))}</strong></div>
      ${resultMeta(job)}
      ${job.lastError ? `<div class="detail-card span-2"><span>Last error</span><strong>${esc(job.lastError)}</strong></div>` : ""}
    </div>
    <details><summary>Payload</summary><pre>${esc(JSON.stringify(job.payload, null, 2))}</pre></details>
    ${job.result ? `<details><summary>Result</summary><pre>${esc(JSON.stringify(job.result, null, 2))}</pre></details>` : ""}
    <section><h3>Commands</h3><ul class="command-list">${commands || "<li>No commands queued.</li>"}</ul></section>
    <div id="monitor-command-status" class="command-status" role="status" aria-live="polite"></div>
    ${canvasActions}
  </div>`;
};

const parseReceiptBody = (row: MonitorReceiptRow): Record<string, unknown> | undefined => {
  const body = asRecord(row.bodyJson);
  return typeof body.type === "string" ? body : undefined;
};

const jobReceipts = (
  rows: ReadonlyArray<MonitorReceiptRow>,
  workspaceId: string,
  jobId: string,
): ReadonlyArray<MonitorReceiptRow> => rows
  .filter((row) => row.workspaceId === workspaceId && parseReceiptBody(row)?.jobId === jobId)
  .sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);

const summarizeJobEvent = (event: Record<string, unknown>): string => {
  switch (event.type) {
    case "job.enqueued": return `${String(event.agentId ?? "agent")} entered ${String(event.lane ?? "collect")}`;
    case "job.leased": return `${String(event.workerId ?? "worker")} claimed attempt ${String(event.attempt ?? "")}`;
    case "job.heartbeat": return `${String(event.workerId ?? "worker")} renewed its lease`;
    case "job.completed": return `${String(event.workerId ?? "worker")} returned a result`;
    case "job.failed": return `${String(event.error ?? "failed")}${event.willRetry ? "; retry queued" : ""}`;
    case "job.canceled": return String(event.reason ?? "Job canceled");
    case "queue.command": return `${String(event.command ?? "command")} queued`;
    case "queue.command.consumed": return "Command consumed";
    case "job.lease_expired": return event.willRetry ? "Lease expired; retry queued" : "Lease expired";
    default: return String(event.type ?? "event");
  }
};

const replayJobState = (
  job: QueueJob,
  rows: ReadonlyArray<MonitorReceiptRow>,
  cursor: bigint | null,
): QueueJob | undefined => {
  let state = initialJob;
  for (const row of rows) {
    if (cursor !== null && row.seq > cursor) break;
    const event = parseReceiptBody(row);
    if (!event) continue;
    try {
      state = reduceJob(state, event as JobEvent, Number(row.occurredAtMs));
    } catch {
      // Keep the last valid deterministic frame if a receipt is malformed.
    }
  }
  const record = state.jobs[job.id];
  if (!record) return undefined;
  return {
    ...job,
    status: record.status,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    lane: record.lane,
    updatedAt: record.updatedAt,
    leaseOwner: record.workerId,
    commands: record.commands.map((command) => ({ ...command })),
  };
};

export const renderMonitorReplay = (
  job: QueueJob | undefined,
  receiptRows: ReadonlyArray<MonitorReceiptRow>,
  cursor: bigint | null,
  workspaceId: string,
): { readonly html: string; readonly sequences: ReadonlyArray<bigint>; readonly label: string } => {
  if (!job) return {
    html: `<div class="replay-empty">Select a job to replay its durable lifecycle.</div>`,
    sequences: [],
    label: "No job selected",
  };
  const rows = jobReceipts(receiptRows, workspaceId, job.id);
  const position = cursor === null ? rows.length : rows.filter((row) => row.seq <= cursor).length;
  const replayed = replayJobState(job, rows, cursor);
  const status = replayed?.status ?? (position === 0 ? "not started" : job.status);
  const current = position > 0 ? parseReceiptBody(rows[position - 1]!) : undefined;
  const events = [...rows].reverse().slice(0, 30).map((row) => {
    const body = parseReceiptBody(row) ?? {};
    const active = cursor !== null && row.seq === cursor;
    const future = cursor !== null && row.seq > cursor;
    return `<button type="button" class="replay-event${active ? " active" : ""}${future ? " future" : ""}" data-monitor-replay-seq="${row.seq}"><span>#${row.seq}</span><strong>${esc(String(body.type ?? "event"))}</strong><small>${esc(summarizeJobEvent(body))}</small><time>${esc(formatClock(Number(row.occurredAtMs)))}</time></button>`;
  }).join("");
  const stages = ["queued", "leased", "running", "finished"];
  const rank = status === "queued" ? 0 : status === "leased" ? 1 : status === "running" ? 2 : status === "not started" ? -1 : 3;
  return {
    html: `<div class="replay-frame">
      <div class="replay-frame-head"><div><strong>${esc(getAgentDisplayMeta(job.agentId).label)}</strong><span class="mono">${esc(job.id)}</span></div><span class="status-pill ${status !== "not started" ? statusClass(jobStatus(status)) : ""}">${esc(status)}</span></div>
      <div class="replay-stages">${stages.map((stage, index) => `<span class="${index < rank || (index === rank && rank === 3) ? "done" : index === rank ? "current" : ""}">${stage}</span>`).join("")}</div>
      <details><summary>Inspect replay frame · ${position}/${rows.length}</summary><div class="replay-inspector"><div class="replay-facts"><span><small>Attempt</small><strong>${replayed?.attempt ?? 0}/${replayed?.maxAttempts ?? job.maxAttempts}</strong></span><span><small>Worker</small><strong class="mono">${esc(replayed?.leaseOwner ?? "unassigned")}</strong></span><span><small>Event</small><strong class="mono">${esc(String(current?.type ?? "start"))}</strong></span><span><small>Integrity</small><strong>${position} linked receipts</strong></span></div><div class="replay-event-list">${events || `<div class="empty">No receipts in this frame.</div>`}</div></div></details>
    </div>`,
    sequences: rows.map((row) => row.seq),
    label: cursor === null
      ? `Live ${rows.length}/${rows.length} · ${job.status}`
      : `Replay ${position}/${rows.length} · ${String(current?.type ?? "start")}`,
  };
};

const summarizeActivity = (body: Record<string, unknown>): string => {
  const type = String(body.type ?? "event");
  const content = typeof body.content === "string" ? body.content
    : typeof body.note === "string" ? body.note
      : typeof body.problem === "string" ? body.problem
        : typeof body.status === "string" ? body.status
          : "";
  return content ? `${type} · ${truncate(content.replace(/\s+/g, " "), 180)}` : type;
};

export const renderMonitorActivity = (
  rows: ReadonlyArray<MonitorReceiptRow>,
  workspaceId: string,
): string => {
  const items = rows
    .filter((row) => row.workspaceId === workspaceId)
    .sort((left, right) => left.seq < right.seq ? 1 : left.seq > right.seq ? -1 : 0)
    .slice(0, 60)
    .map((row) => {
      const body = parseReceiptBody(row) ?? {};
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      return `<li><time>${esc(formatClock(Number(row.occurredAtMs)))}</time><span>${agentId ? `<strong>${esc(getAgentDisplayMeta(agentId).label)}</strong> ` : ""}${esc(summarizeActivity(body))}</span></li>`;
    }).join("");
  return `<ul class="activity-list">${items || `<li class="empty">No activity in this stream yet.</li>`}</ul>`;
};

export const memoryEntriesFromReceipts = (
  rows: ReadonlyArray<MonitorReceiptRow>,
  workspaceId: string,
): ReadonlyArray<MonitorMemoryEntry> => rows
  .filter((row) => row.workspaceId === workspaceId)
  .flatMap((row): ReadonlyArray<MonitorMemoryEntry> => {
  const body = parseReceiptBody(row);
  if (body?.type !== "memory.committed" && body?.type !== "memory.accepted") return [];
  const entry = body.entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const value = entry as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.scope !== "string" || typeof value.text !== "string") return [];
  return [{
    id: value.id,
    scope: value.scope,
    text: value.text,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    ts: typeof value.ts === "number" ? value.ts : Number(row.occurredAtMs),
  }];
});

export const renderMonitorMemory = (
  entries: ReadonlyArray<MonitorMemoryEntry>,
  query: string,
): string => {
  const terms = query.toLowerCase().split(/\s+/g).filter(Boolean);
  const filtered = entries
    .filter((entry) => terms.every((term) => `${entry.text} ${(entry.tags ?? []).join(" ")}`.toLowerCase().includes(term)))
    .sort((left, right) => right.ts - left.ts)
    .slice(0, 40);
  return `<ul class="memory-list">${filtered.map((entry) => `<li><time>${esc(formatClock(entry.ts))}</time><p>${esc(truncate(entry.text, 320))}</p>${entry.tags?.length ? `<div>${entry.tags.map((tag) => `<span class="memory-tag">${esc(tag)}</span>`).join("")}</div>` : ""}</li>`).join("") || `<li class="empty">No memory entries${query ? " match this search" : " in this scope"}.</li>`}</ul>`;
};

export const selectedActivityStream = (job: QueueJob | undefined, fallback: string): string => {
  if (!job) return fallback;
  const explicit = typeof job.payload.runStream === "string" ? job.payload.runStream : undefined;
  if (explicit) return explicit;
  const stream = typeof job.payload.stream === "string" ? job.payload.stream : undefined;
  const runId = typeof job.payload.runId === "string" ? job.payload.runId : undefined;
  return stream && runId ? `${stream}/runs/${runId}` : stream ?? fallback;
};
