import type { Chain } from "../core/types.js";
import type { AxiomSimpleRunSummary } from "../agents/axiom-simple.runs.js";
import type { AxiomSimpleEvent, AxiomSimpleState, AxiomSimpleWorkerRecord, AxiomSimpleWorkerSnapshot, AxiomSimpleWorkerStatus } from "../modules/axiom-simple.js";
import {
  esc,
  frameworkCoordinationHtml,
  truncate,
  type FrameworkContextRow,
  type FrameworkLaneRow,
  type FrameworkTrailRow,
} from "./agent-framework.js";
import {
  agentComposerHtml,
  agentReplayBarHtml,
  agentReplayClientControlsHtml,
  agentShellCss,
  agentShellFrameHtml,
  agentTopNavHtml,
  agentExampleTabsHtml,
  staticRoomRoster,
  agentTabsScript,
} from "./agent-shell.js";
import { themeBootstrapScript } from "./theme.js";
import {
  rosterRealtimeBootHtml,
  rosterRealtimeStatusHtml,
  type RosterRealtimeBootConfig,
} from "./roster-realtime.js";

const shortHash = (value?: string): string =>
  value ? value.slice(0, 8) : "—";

const prettyStrategy = (value: string): string => {
  if (value === "final_verify") return "Final Verify";
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
};

const prettyStatus = (status: AxiomSimpleWorkerStatus): string =>
  status === "queued"
    ? "Queued"
    : status === "running"
      ? "Running"
      : status === "completed"
        ? "Completed"
        : status === "failed"
          ? "Failed"
          : status === "canceled"
            ? "Canceled"
            : status === "missing"
              ? "Missing"
              : "Planned";

const resultStatus = (state: AxiomSimpleState): string => {
  if (state.solution?.verificationStatus === "verified") return "Verified";
  if (state.solution?.verificationStatus === "false") return "False";
  if (state.status === "failed") return "Failed";
  if (state.status === "completed") return "Completed";
  return "Running";
};

const workerLink = (worker: AxiomSimpleWorkerRecord, basePath: string): string | undefined => {
  if (!worker.childRunId) return undefined;
  const params = new URLSearchParams({
    stream: worker.childStream ?? "agents/axiom",
    run: worker.childRunId,
  });
  return `${basePath}/worker?${params.toString()}`;
};

const workerExcerpt = (snapshot?: AxiomSimpleWorkerSnapshot): string =>
  snapshot?.outputExcerpt
  ?? snapshot?.validationSummary
  ?? snapshot?.observationExcerpt
  ?? "Waiting for worker output…";

const workerMeta = (worker: AxiomSimpleWorkerRecord): string => {
  const parts = [
    `Strategy ${prettyStrategy(worker.strategy)}`,
    worker.phase !== "initial" ? prettyStrategy(worker.phase) : "",
    worker.snapshot ? `iter ${worker.snapshot.iteration}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
};

const detailsBlock = (worker: AxiomSimpleWorkerRecord): string => {
  const snapshot = worker.snapshot;
  if (!snapshot) return `<div class="as-detail-empty">No child snapshot yet.</div>`;
  const rows = [
    snapshot.lastTool ? `<div><span>Last tool</span><code>${esc(snapshot.lastTool)}</code></div>` : "",
    snapshot.validationSummary ? `<div><span>Validation</span><strong>${esc(snapshot.validationSummary)}</strong></div>` : "",
    snapshot.observationExcerpt ? `<div><span>Observation</span><pre>${esc(snapshot.observationExcerpt)}</pre></div>` : "",
    snapshot.touchedPath ? `<div><span>Path</span><code>${esc(snapshot.touchedPath)}</code></div>` : "",
    `<div><span>Candidate hash</span><code>${esc(shortHash(snapshot.candidateHash))}</code></div>`,
    `<div><span>Statement hash</span><code>${esc(shortHash(snapshot.formalStatementHash))}</code></div>`,
  ].filter(Boolean);
  return `<div class="as-detail-grid">${rows.join("")}</div>`;
};

const workerCardsHtml = (
  state: AxiomSimpleState,
  basePath: string,
): string => {
  const cards = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker))
    .sort((left, right) => left.order - right.order)
    .map((worker) => {
      const link = workerLink(worker, basePath);
      const isWinner = state.winner?.workerId === worker.workerId;
      const isVerifier = state.finalVerification?.workerId === worker.workerId;
      return `<article class="as-worker-card ${worker.status} ${isWinner ? "winner" : ""} ${isVerifier ? "verifier" : ""}">
        <div class="as-worker-head">
          <div>
            <div class="as-worker-title">${esc(worker.label)}</div>
            <div class="as-worker-meta">${esc(workerMeta(worker))}</div>
          </div>
          <div class="as-worker-badges">
            ${isWinner ? `<span class="as-badge accent">Winner</span>` : ""}
            ${isVerifier ? `<span class="as-badge verify">Final Verify</span>` : ""}
            <span class="as-badge status ${worker.status}">${esc(prettyStatus(worker.status))}</span>
          </div>
        </div>
        <div class="as-worker-copy">${esc(truncate(workerExcerpt(worker.snapshot), 220))}</div>
        <div class="as-worker-summary">
          <span>${esc(worker.score ? `score ${worker.score.score}` : "score pending")}</span>
          <span>${esc(worker.snapshot ? `failures ${worker.snapshot.failureCount}` : "failures —")}</span>
          <span>${esc(worker.snapshot?.validationGate ?? "no validation")}</span>
        </div>
        <details class="as-worker-details" data-detail-id="${esc(worker.workerId)}">
          <summary>Details</summary>
          ${detailsBlock(worker)}
        </details>
        ${link
          ? `<a class="as-worker-link" href="${link}">Open child run</a>`
          : `<div class="as-worker-link muted">Child run link pending</div>`}
      </article>`;
    }).join("");

  return `<section class="as-workers">
    <div class="as-section-head">
      <div class="as-section-title">Worker Lanes</div>
      <div class="as-section-sub">Each lane is a real Axiom worker. Repair and final verify lanes appear only when used.</div>
    </div>
    <div class="as-worker-strip">${cards || `<div class="empty">No workers yet.</div>`}</div>
  </section>`;
};

const buildTrailRows = (
  chain: Chain<AxiomSimpleEvent>,
): ReadonlyArray<FrameworkTrailRow> => {
  const rows: FrameworkTrailRow[] = [];
  const pushRow = (row: FrameworkTrailRow) => {
    const previous = rows[rows.length - 1];
    if (previous && previous.kind === row.kind && previous.agent === row.agent && previous.body === row.body) {
      return;
    }
    rows.push(row);
  };
  for (const receipt of chain) {
    const event = receipt.body;
    switch (event.type) {
      case "problem.set":
        pushRow({ kind: "status", agent: "Orchestrator", body: "Run initialized.", ts: receipt.ts });
        break;
      case "worker.planned":
        pushRow({ kind: "branch", agent: "Orchestrator", body: `Planned ${event.label}.`, ts: receipt.ts });
        break;
      case "worker.started":
        pushRow({ kind: "status", agent: event.workerId, body: `Started child run ${event.childRunId}.`, ts: receipt.ts });
        break;
      case "worker.progressed":
        pushRow({
          kind: "tool",
          agent: event.workerId,
          body: event.snapshot.validationSummary
            ? `${prettyStatus(event.snapshot.status)} · ${event.snapshot.validationSummary}`
            : `${prettyStatus(event.snapshot.status)} · ${event.snapshot.lastTool ?? "waiting"}`,
          ts: receipt.ts,
        });
        break;
      case "worker.completed":
        pushRow({
          kind: "summary",
          agent: event.workerId,
          body: `${prettyStatus(event.status)}${event.summary ? ` · ${event.summary}` : ""}.`,
          ts: receipt.ts,
        });
        break;
      case "candidate.scored":
        pushRow({
          kind: "summary",
          agent: event.workerId,
          body: `Scored ${event.score} · ${event.reason}.`,
          ts: receipt.ts,
        });
        break;
      case "winner.selected":
        pushRow({ kind: "branch", agent: "Orchestrator", body: `Selected ${event.workerId} as winner.`, ts: receipt.ts });
        break;
      case "repair.started":
        pushRow({ kind: "branch", agent: "Orchestrator", body: `Repair loop started from ${event.sourceWorkerId}.`, ts: receipt.ts });
        break;
      case "repair.completed":
        pushRow({ kind: "summary", agent: event.workerId, body: `Repair completed as ${prettyStatus(event.status)}.`, ts: receipt.ts });
        break;
      case "final.verify.started":
        pushRow({ kind: "branch", agent: "Orchestrator", body: `Final verify launched from ${event.sourceWorkerId}.`, ts: receipt.ts });
        break;
      case "final.verify.completed":
        pushRow({ kind: "summary", agent: event.workerId, body: `Final verify: ${event.status}.`, ts: receipt.ts });
        break;
      case "solution.finalized":
        pushRow({ kind: "final", agent: event.workerId, body: `Solution finalized (${event.verificationStatus}).`, ts: receipt.ts });
        break;
      case "failure.report":
        pushRow({ kind: "status", agent: "Orchestrator", body: `${event.failure.failureClass}: ${event.failure.message}`, ts: receipt.ts });
        break;
      case "run.status":
        pushRow({ kind: "status", agent: "Orchestrator", body: `Run marked ${event.status}${event.note ? ` (${event.note})` : ""}.`, ts: receipt.ts });
        break;
      default:
        break;
    }
  }
  return rows.slice(-16).map((row, index, arr) => ({ ...row, step: arr.length - index }));
};

const buildContextRows = (
  state: AxiomSimpleState,
): ReadonlyArray<FrameworkContextRow> =>
  state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker?.snapshot))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 8)
    .map((worker, index, arr) => ({
      step: arr.length - index,
      title: `${worker.label} snapshot`,
      meta: `${prettyStrategy(worker.strategy)} · ${prettyStatus(worker.status)}`,
      target: worker.snapshot?.touchedPath,
      content: workerExcerpt(worker.snapshot),
      ts: worker.updatedAt,
    }));

const coordinationHtml = (
  state: AxiomSimpleState,
  chain: Chain<AxiomSimpleEvent>,
): string => {
  const metrics = [
    { key: "Run", value: resultStatus(state) },
    { key: "Winner", value: state.winner?.workerId ?? "pending" },
    { key: "Final verify", value: state.finalVerification?.status ?? "pending" },
    { key: "Workers", value: String(state.workerOrder.length) },
  ];
  const lanes: FrameworkLaneRow[] = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker))
    .sort((left, right) => left.order - right.order)
    .map((worker) => ({
      agent: worker.label,
      phase: prettyStrategy(worker.phase),
      status: worker.status === "completed"
        ? "done"
        : worker.status === "failed" || worker.status === "canceled" || worker.status === "missing"
          ? "failed"
          : worker.status === "planned" || worker.status === "queued"
            ? "idle"
            : "running",
      action: worker.snapshot?.validationSummary
        ?? worker.snapshot?.lastToolSummary
        ?? worker.summary
        ?? prettyStatus(worker.status),
    }));

  return frameworkCoordinationHtml({
    palette: "theorem",
    metricsTitle: "Orchestration",
    clockLabel: state.statusNote,
    metrics,
    contextTitle: "Worker Excerpts",
    contextSubtitle: "Receipt-backed snapshots copied into the parent stream for scrub-safe inspection.",
    contextNote: "Open a child run for the full AXLE receipt stream and tool-by-tool detail.",
    contextRows: buildContextRows(state),
    boardTitle: "Coordination Trail",
    boardSubtitle: "The trail shows planning, scoring, winner selection, repair loops, and final verification.",
    lanes,
    trail: buildTrailRows(chain),
  });
};

export const axiomSimpleShell = (
  stream: string,
  examples: ReadonlyArray<{ readonly id: string; readonly label: string; readonly problem: string }>,
  activeRun?: string,
  _at?: number | null,
  opts?: {
    readonly basePath?: string;
    readonly title?: string;
    readonly realtime?: { readonly boot: RosterRealtimeBootConfig; readonly nonce?: string };
  },
): string => {
  const basePath = opts?.basePath ?? "/axiom-simple";
  const replayBar = agentReplayBarHtml({
    id: "proof-swarm-replay",
    title: "Swarm history",
    description: activeRun ? "Replay worker fan-out, ranking, repair, and final verification." : "Start or select a proof run to replay every worker decision.",
    content: agentReplayClientControlsHtml({
      id: "as-travel",
      adapter: "axiom-simple",
      emptyLabel: activeRun ? "Synchronizing durable history…" : "No run selected",
    }),
  });
  const proofComposer = agentComposerHtml({
    id: "proof-brief",
    inputId: "as-problem",
    title: "Start a Proof Run",
    description: "State the task; the proof team will compare candidates, repair failures, and verify the result.",
    action: `${basePath}/run?stream=${encodeURIComponent(stream)}`,
    inputName: "problem",
    inputLabel: "Theorem or Lean task",
    placeholder: "State the theorem or Lean proving task…",
    submitLabel: "Run Proof Swarm",
    toolsHtml: `<details class="agent-composer-options"><summary>Runtime options</summary><div class="agent-composer-options-panel"><div class="run-controls">
        <label><span>Workers</span><select name="workerCount" aria-label="Worker count">
            <option value="2">2</option>
            <option value="3" selected>3</option>
          </select></label>
        <label><span>Repair</span><select name="repairMode" aria-label="Repair mode">
            <option value="auto" selected>Auto</option>
            <option value="off">Off</option>
          </select></label>
      </div></div></details>`,
    examplesHtml: `<div class="examples" role="group" aria-label="Example proof tasks">${examples.map((example) => `<button type="button" data-problem="${esc(example.problem)}">${esc(example.label)}</button>`).join("")}</div>`,
  });
  const tabs = agentExampleTabsHtml({
    id: "proof-swarm-views",
    agentId: "axiom-simple",
    label: "Proof Swarm views",
    workspaceBadge: activeRun ? "Live" : undefined,
    history: replayBar,
    railActionsHtml: `<a class="new-run" href="${basePath}?stream=${encodeURIComponent(stream)}&run=new">New Room</a>`,
    conversation: `<div id="as-conversation" class="run-area" data-slot="axiom-simple-conversation" data-roster-panel aria-busy="true"><div class="empty">Synchronizing room conversation…</div></div>`,
    composer: proofComposer,
    room: {
      eyebrow: "Proof room",
      title: "#proof-swarm",
      description: "A shared proof conversation that keeps candidate ideas, repairs, ranking, and final verification together.",
      state: activeRun ? "active" : "open",
      actionsHtml: opts?.realtime ? rosterRealtimeStatusHtml(activeRun ? "Connecting run…" : "Syncing runs…") : `<span class="agent-status">Ready</span>`,
      roster: staticRoomRoster({
        roomId: "proof-swarm",
        summary: activeRun ? "Proof specialists are comparing candidates" : "The room is ready for a proof",
        members: [
        { name: "You", role: "Problem owner", kind: "human", presence: "present" },
        { name: "Roster", role: "Orchestrator", kind: "system", presence: activeRun ? "working" : "present" },
        { name: "Provers", role: "Candidates", kind: "agent", presence: activeRun ? "working" : "waiting" },
        { name: "Verifier", role: "AXLE", kind: "agent", presence: activeRun ? "working" : "waiting" },
        ],
      }),
    },
    workspace: `<div id="as-chat" class="run-area" data-roster-panel aria-busy="true"><div class="empty">Synchronizing run…</div></div>`,
    runs: `<div id="as-folds" class="folds" data-roster-panel aria-busy="true"><div class="empty">Synchronizing runs…</div></div>`,
    activity: `<div id="as-side" class="activity" data-roster-panel aria-busy="true"><div class="empty">Synchronizing evidence and activity…</div></div>`,
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#090c11" />
  ${themeBootstrapScript()}
  <title>${esc(opts?.title ?? "Roster - Proof Swarm")}</title>
  <style>
    ${agentShellCss()}
    :root { --good:var(--green); --bad:var(--red); --warn:var(--amber); }
    code,pre,.travel-state { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .proof-shell-note { color:var(--muted); font:9px/1.5 ui-monospace,monospace; }
    .new-run {
      min-height:34px; display:inline-flex; align-items:center; justify-content:center;
      border:1px solid var(--line); background:var(--raised); color:var(--ink);
      border-radius:var(--radius-sm); padding:7px 11px; font-size:10px; font-weight:750; text-decoration:none;
    }
    .new-run:hover { border-color:var(--agent-accent); background:var(--panel-2); }
    .run-area,.activity,.travel-island,.folds { min-width:0; display:grid; gap:14px; }
    .activity,.travel-island { padding:0; border:0; background:transparent; }
    .travel-row { display:grid; grid-template-columns:auto minmax(120px,1fr) auto; align-items:center; gap:10px; }
    .travel-row > * { min-width:0; }
    .travel-actions { display:flex; flex-wrap:wrap; gap:5px; }
    .travel-btn { min-height:32px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:4px 9px; color:var(--ink); background:var(--raised); cursor:pointer; font-size:10px; }
    .travel-btn:hover:not(:disabled) { border-color:#46515e; background:var(--panel-2); }
    .travel-play { min-width:48px; color:var(--blue); border-color:#365469; }
    .travel-btn:disabled { opacity:.35; cursor:default; }
    .travel-scrub { display:grid; }.travel-slider { width:100%; accent-color:var(--blue); }
    .travel-meta { display:flex; align-items:center; justify-content:flex-end; gap:7px; }
    .travel-speed { min-height:32px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:3px 6px; color:var(--ink); background:var(--raised); font-size:10px; }
    .travel-state { color:var(--muted); font-size:10px; line-height:1.2; white-space:nowrap; }
    .empty { min-height:68px; display:grid; place-items:center; padding:16px; border:1px dashed var(--line); border-radius:var(--radius-md); color:var(--muted); font-size:11px; text-align:center; }
    .fold-list { min-width:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:8px; }
    .fold-item {
      min-width:0; display:grid; gap:6px; padding:10px 11px; border-radius:var(--radius-sm);
      border:1px solid var(--line); background:var(--panel); text-decoration:none; color:inherit;
    }
    .fold-item:hover,.fold-item.active { border-color:var(--agent-accent); background:var(--panel-2); }
    .fold-head { min-width:0; display: flex; align-items: center; gap: 8px; }
    .fold-dot { width:7px; height:7px; border-radius:50%; background:var(--warn); }
    .fold-dot.done { background:var(--good); }
    .fold-dot.running { background:var(--blue); }
    .fold-dot.failed { background:var(--bad); }
	    .fold-title { min-width:0; font-size: 12px; font-weight: 600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	    .fold-meta { min-width:0; font-size:11px; color:var(--muted); overflow-wrap:anywhere; }
    @media (max-width:700px) { .run-controls { grid-template-columns:1fr 1fr; }.travel-row { grid-template-columns:1fr; }.travel-meta { justify-content:flex-start; }.fold-list { grid-template-columns:1fr; } }
	  </style>
	</head>
<body>
  ${agentShellFrameHtml({ skipHref: "#main-content", skipLabel: "Skip to proof room", chromeHtml: agentTopNavHtml({ active: "swarm", statusLabel: activeRun ? "Proof room active" : "Proof room ready" }), mainHtml: tabs, mainId: "main-content", appClass: "agent-unified-page" })}

  <script${opts?.realtime?.nonce ? ` nonce="${esc(opts.realtime.nonce)}"` : ""}>
    (() => {
      const input = document.getElementById("as-problem");
      document.querySelectorAll(".examples button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const problem = btn.getAttribute("data-problem");
          if (problem && input) input.value = problem;
        });
      });
    })();
  </script>
  ${agentTabsScript(opts?.realtime?.nonce)}
  ${opts?.realtime ? rosterRealtimeBootHtml(opts.realtime.boot, { nonce: opts.realtime.nonce }) : ""}
</body>
</html>`;
};

export const axiomSimpleFoldsHtml = (
  stream: string,
  runs: ReadonlyArray<AxiomSimpleRunSummary>,
  activeRun?: string,
  at?: number | null,
  opts?: { readonly basePath?: string },
): string => {
  const basePath = opts?.basePath ?? "/axiom-simple";
  if (runs.length === 0) return `<div class="empty">No runs yet.</div>`;
  const items = runs.map((run) => {
    const active = run.runId === activeRun;
    const statusClass = run.status === "done" ? "done" : run.status === "failed" ? "failed" : "running";
    const when = run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "-";
    return `<a class="fold-item ${active ? "active" : ""} ${statusClass}"${active ? ` aria-current="page"` : ""}
      href="${basePath}?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(run.runId)}&at=${encodeURIComponent(String(at ?? ""))}">
      <div class="fold-head">
        <span class="fold-dot ${statusClass}" aria-hidden="true"></span>
        <span class="fold-title">${esc(truncate(run.problem || run.runId, 30))}</span>
      </div>
      <div class="fold-meta">${esc(when)} · ${run.count} receipts</div>
    </a>`;
  }).join("");
  return `<div class="fold-list">${items}</div>`;
};

export const axiomSimpleChatHtml = (
  state: AxiomSimpleState,
  chain: Chain<AxiomSimpleEvent>,
  opts?: { readonly basePath?: string },
): string => {
  if (chain.length === 0) return `<div class="empty">No run selected.</div>`;
  const basePath = opts?.basePath ?? "/axiom-simple";
  const finalText = state.solution?.content?.trim()
    || state.finalVerification?.summary
    || state.statusNote
    || "Waiting for worker output…";
  const finalGaps = state.solution?.gaps?.length
    ? `<ul class="as-result-gaps">${state.solution.gaps.map((gap) => `<li>${esc(gap)}</li>`).join("")}</ul>`
    : "";
  return `<div class="as-chat-stack">
    <section class="as-result-card">
      <div class="as-result-head">
        <div>
          <div class="as-result-title">Selected Output</div>
          <div class="as-result-meta">${esc(state.problem)}</div>
        </div>
        <div class="as-result-pill">${esc(resultStatus(state))}</div>
      </div>
      <div class="as-result-grid">
        <div><span>Winner</span><strong>${esc(state.winner?.workerId ?? "pending")}</strong></div>
        <div><span>Final verify</span><strong>${esc(state.finalVerification?.status ?? "pending")}</strong></div>
      </div>
      <pre class="as-result-body">${esc(finalText)}</pre>
      ${finalGaps}
    </section>

    ${workerCardsHtml(state, basePath)}
    ${coordinationHtml(state, chain)}

    <style>
      .as-chat-stack { min-width:0; display: grid; gap: 18px; }
      .as-section-head { min-width:0; display: grid; gap: 4px; }
      .as-section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
      .as-section-sub { font-size: 12px; color: var(--muted); line-height: 1.45; }
      .as-result-card,
      .as-workers {
        min-width:0;
        border-top:1px solid var(--line);
        padding:14px 0;
        display: grid;
        gap: 12px;
      }
      .as-result-head { min-width:0; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .as-result-head > div:first-child { min-width:0; }
      .as-result-title { font-size: 14px; font-weight: 700; }
      .as-result-meta { min-width:0; font-size: 12px; color: rgba(255,255,255,0.62); margin-top: 4px; line-height: 1.45; overflow-wrap:anywhere; }
      .as-result-pill {
        flex:0 0 auto;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        border-radius:4px;
        border:1px solid var(--line);
        padding: 4px 8px;
        color:var(--good);
      }
      .as-result-grid {
        min-width:0;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .as-result-grid > div {
        min-width:0;
        border-radius:4px;
        border:1px solid var(--line);
        background:var(--raised);
        padding: 8px 10px;
        display: grid;
        gap: 4px;
      }
      .as-result-grid span { font-size: 10px; color: rgba(255,255,255,0.55); text-transform: uppercase; letter-spacing: 0.08em; }
      .as-result-body,
      .as-detail-grid pre {
        min-width:0;
        max-width:100%;
        margin: 0;
        padding: 12px;
        border-radius:4px;
        border:1px solid var(--line);
        background:#0b0e12;
        font-size: 12px;
        line-height: 1.5;
        font-family: "IBM Plex Mono", monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .as-result-gaps {
        margin: 0;
        padding-left: 18px;
        color: rgba(255,255,255,0.72);
        display: grid;
        gap: 6px;
      }
      .as-worker-strip {
        min-width:0;
        max-width:100%;
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        overflow-x: auto;
        overscroll-behavior-x: contain;
        padding-bottom: 2px;
      }
      .as-worker-card {
        border-radius:5px;
        border:1px solid var(--line);
        background:var(--raised);
        padding: 14px;
        display: grid;
        gap: 10px;
        min-width: 0;
      }
      .as-worker-card.running,
      .as-worker-card.queued { border-color:var(--blue); }
      .as-worker-card.completed { border-color:var(--good); }
      .as-worker-card.failed,
      .as-worker-card.canceled,
      .as-worker-card.missing { border-color:var(--bad); }
      .as-worker-card.winner { box-shadow:inset 3px 0 0 var(--warn); }
      .as-worker-head { min-width:0; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
      .as-worker-head > div:first-child { min-width:0; }
      .as-worker-title { font-size: 13px; font-weight: 700; }
      .as-worker-meta { min-width:0; font-size: 11px; color: rgba(255,255,255,0.56); margin-top: 4px; overflow-wrap:anywhere; }
      .as-worker-badges { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
      .as-badge {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        border-radius:4px;
        border:1px solid var(--line);
        padding: 4px 7px;
      }
      .as-badge.accent { border-color:var(--warn); color:var(--warn); }
      .as-badge.verify { border-color:var(--blue); color:var(--blue); }
      .as-badge.status.completed { border-color:var(--good); color:var(--good); }
      .as-badge.status.failed,
      .as-badge.status.canceled,
      .as-badge.status.missing { border-color:var(--bad); color:var(--bad); }
      .as-badge.status.running,
      .as-badge.status.queued { border-color:var(--blue); color:var(--blue); }
      .as-worker-copy { min-width:0; font-size: 13px; line-height: 1.5; color: rgba(255,255,255,0.86); overflow-wrap:anywhere; }
      .as-worker-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        font-size: 11px;
        color: rgba(255,255,255,0.62);
      }
      .as-worker-details summary {
        cursor: pointer;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(255,255,255,0.68);
      }
      .as-detail-grid { min-width:0; display: grid; gap: 10px; margin-top: 10px; }
      .as-detail-grid div {
        min-width:0;
        display: grid;
        gap: 6px;
      }
      .as-detail-grid span {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(255,255,255,0.52);
      }
      .as-detail-grid code {
        min-width:0;
        font-family: "IBM Plex Mono", monospace;
        font-size: 12px;
        overflow-wrap:anywhere;
      }
      .as-detail-empty { margin-top: 10px; font-size: 12px; color: rgba(255,255,255,0.6); }
      .as-worker-link { font-size:12px; color:var(--blue); text-decoration:none; }
      .as-worker-link.muted { color: rgba(255,255,255,0.5); }
    </style>
  </div>`;
};

export const axiomSimpleConversationHtml = (
  state: AxiomSimpleState,
): string => {
  if (!state.problem.trim()) {
    return `<div class="room-thread-empty"><span aria-hidden="true">+</span><strong>Start the conversation</strong><p>State a proof goal to invite independent provers into the room.</p></div>`;
  }
  const messages = [
    `<li class="room-message room-message-human" data-message-id="proof-objective"><span class="room-message-avatar" aria-hidden="true">Y</span><article><header><strong>You</strong><span>Problem owner</span></header><p>${esc(state.problem)}</p></article></li>`,
    ...(state.workerOrder.length > 0
      ? [`<li class="room-message room-message-system" data-message-id="proof-roster"><span class="room-message-avatar" aria-hidden="true">R</span><article><header><strong>Roster</strong><span>Facilitator</span></header><p>I invited ${state.workerOrder.length} independent prover${state.workerOrder.length === 1 ? "" : "s"} to explore the same goal. Their candidates stay separate until the room compares their evidence.</p></article></li>`]
      : []),
    ...state.workerOrder.flatMap((workerId) => {
      const worker = state.workers[workerId];
      if (!worker || (!worker.summary && !worker.snapshot?.lastToolSummary && !worker.snapshot?.validationSummary)) return [];
      const summary = worker.snapshot?.validationSummary
        ?? worker.snapshot?.lastToolSummary
        ?? worker.summary
        ?? "I published a candidate.";
      return [`<li class="room-message room-message-agent" data-message-id="proof-${esc(worker.workerId)}"><span class="room-message-avatar" aria-hidden="true">${esc(worker.label.slice(0, 1).toUpperCase())}</span><article><header><strong>${esc(worker.label)}</strong><span>${esc(prettyStrategy(worker.strategy))}</span><time datetime="${new Date(worker.updatedAt).toISOString()}">${esc(new Date(worker.updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}</time></header><p>${esc(summary)}</p></article></li>`];
    }),
    ...(state.winner
      ? [`<li class="room-message room-message-system" data-message-id="proof-resolution" data-tone="resolved"><span class="room-message-avatar" aria-hidden="true">R</span><article><header><strong>Roster</strong><span>Facilitator</span></header><p>The room selected ${esc(state.workers[state.winner.workerId]?.label ?? state.winner.workerId)} after comparing the candidate frontier: ${esc(state.winner.reason)}</p></article></li>`]
      : []),
  ];
  return `<ol class="room-thread" aria-label="Room conversation">${messages.join("")}</ol>`;
};

export const axiomSimpleSideHtml = (
  state: AxiomSimpleState,
  _chain: Chain<AxiomSimpleEvent>,
  opts?: { readonly basePath?: string },
): string => {
  const basePath = opts?.basePath ?? "/axiom-simple";
  const workers = state.workerOrder
    .map((workerId) => state.workers[workerId])
    .filter((worker): worker is AxiomSimpleWorkerRecord => Boolean(worker));
  const linkedRuns = workers
    .filter((worker) => worker.childRunId)
    .map((worker) => ({
      worker,
      href: workerLink(worker, basePath) ?? "#",
    }));
  const touchedPaths = [...new Set(
    workers
      .map((worker) => worker.snapshot?.touchedPath)
      .filter((value): value is string => Boolean(value))
  )];
  const scoreRows = workers
    .filter((worker) => worker.score)
    .sort((left, right) => (right.score?.score ?? 0) - (left.score?.score ?? 0));

  return `<div class="as-side-stack">
    <section class="as-side-panel">
      <div class="as-side-title">Run Overview</div>
      <div class="as-side-grid">
        <div class="as-side-card"><div class="k">Status</div><div class="v">${esc(resultStatus(state))}</div></div>
        <div class="as-side-card"><div class="k">Workers</div><div class="v">${esc(String(state.workerOrder.length))}</div></div>
        <div class="as-side-card"><div class="k">Winner</div><div class="v">${esc(state.winner?.workerId ?? "pending")}</div></div>
        <div class="as-side-card"><div class="k">Repair</div><div class="v">${esc(state.config?.repairMode ?? "auto")}</div></div>
        <div class="as-side-card"><div class="k">Final Verify</div><div class="v">${esc(state.finalVerification?.status ?? "pending")}</div></div>
        <div class="as-side-card"><div class="k">Workflow</div><div class="v">${esc(state.config ? `${state.config.workflowId}@${state.config.workflowVersion}` : "-")}</div></div>
      </div>
    </section>

    <section class="as-side-panel">
      <div class="as-side-title">Candidate Scores</div>
      ${scoreRows.length > 0
        ? `<div class="as-score-list">${scoreRows.map((worker) => `<div class="as-score-row">
            <div class="name">${esc(worker.label)}</div>
            <div class="score">${esc(String(worker.score?.score ?? 0))}</div>
            <div class="reason">${esc(worker.score?.reason ?? "")}</div>
          </div>`).join("")}</div>`
        : `<div class="empty">Scores appear after workers finish.</div>`}
    </section>

    <section class="as-side-panel">
      <div class="as-side-title">Evidence</div>
      <div class="as-meta-list">
        <div class="as-meta-item">Final summary: ${esc(state.finalVerification?.summary ?? "pending")}</div>
        <div class="as-meta-item">Candidate hash: ${esc(shortHash(state.finalVerification?.snapshot.candidateHash))}</div>
        <div class="as-meta-item">Statement hash: ${esc(shortHash(state.finalVerification?.snapshot.formalStatementHash))}</div>
        <div class="as-meta-item">Validation: ${esc(state.finalVerification?.validation?.summary ?? "—")}</div>
      </div>
    </section>

    <section class="as-side-panel">
      <div class="as-side-title">Linked Runs</div>
      ${linkedRuns.length > 0
        ? `<div class="as-link-list">${linkedRuns.map(({ worker, href }) => `<a href="${href}" class="as-link-row">${esc(worker.label)} · ${esc(worker.childRunId ?? "")}</a>`).join("")}</div>`
        : `<div class="empty">No child runs yet.</div>`}
    </section>

    <section class="as-side-panel">
      <div class="as-side-title">Touched Files</div>
      ${touchedPaths.length > 0
        ? `<ul class="as-path-list">${touchedPaths.map((item) => `<li><code>${esc(item)}</code></li>`).join("")}</ul>`
        : `<div class="empty">No touched files recorded yet.</div>`}
    </section>

    <style>
      .as-side-stack { min-width:0; display: grid; gap: 12px; }
      .as-side-panel {
        min-width:0;
        display: grid;
        gap: 10px;
        border-bottom:1px solid var(--line);
        padding:0 0 12px;
      }
      .as-side-title {
        font-size: 11px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.68);
        font-weight: 700;
      }
      .as-side-grid {
        min-width:0;
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .as-side-card {
        min-width:0;
        border-radius:4px;
        border:1px solid var(--line);
        background:var(--raised);
        padding: 8px 9px;
      }
      .as-side-card .k {
        font-size: 10px;
        color: rgba(255,255,255,0.5);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 4px;
      }
      .as-side-card .v {
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .as-score-list,
      .as-link-list,
      .as-meta-list { min-width:0; display: grid; gap: 8px; }
      .as-score-row {
        min-width:0;
        display: grid;
        gap: 3px;
        border-radius:4px;
        border:1px solid var(--line);
        background:var(--raised);
        padding: 8px 9px;
      }
      .as-score-row .name { font-size: 12px; font-weight: 700; }
      .as-score-row .score { font-size:11px; color:var(--warn); }
      .as-score-row .reason { font-size: 11px; color: rgba(255,255,255,0.64); line-height: 1.45; overflow-wrap:anywhere; }
      .as-link-row {
        min-width:0;
        text-decoration: none;
        color:var(--blue);
        font-size: 12px;
        border-radius:4px;
        border:1px solid var(--line);
        background:var(--raised);
        padding: 8px 9px;
        overflow-wrap:anywhere;
      }
      .as-meta-item {
        min-width:0;
        font-size: 12px;
        line-height: 1.45;
        color: rgba(255,255,255,0.78);
        overflow-wrap:anywhere;
      }
      .as-path-list {
        min-width:0;
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 6px;
      }
      .as-path-list code {
        min-width:0;
        font-family: "IBM Plex Mono", monospace;
        font-size: 11px;
        overflow-wrap:anywhere;
      }
    </style>
  </div>`;
};
