import { CANVAS_MAX_PAINTERS, CANVAS_MIN_PAINTERS } from "../modules/canvas.js";
import type { CanvasModelRouting } from "../modules/canvas.js";
import { esc } from "./agent-framework.js";
import { themeBootstrapScript } from "./theme.js";
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

export type CanvasRealtimeConfig = {
  readonly enabled?: boolean;
  readonly uri: string;
  readonly database: string;
  readonly confirmedReads?: boolean;
  readonly assetPath?: string;
  readonly workspaceId?: string;
  readonly workspaceCapabilitySecret?: string;
};

const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export const canvasShell = (options: {
  readonly stream: string;
  readonly runId?: string;
  readonly nonce?: string;
  readonly csrfToken: string;
  readonly apiReady: boolean;
  readonly apiNote?: string;
  readonly models?: CanvasModelRouting;
  readonly realtime?: CanvasRealtimeConfig;
}): string => {
  const runId = options.runId ?? "";
  const routeNote = options.models
    ? `Cost-aware new-run route · Director ${options.models.director} · artists ${options.models.painter} · subject validator ${options.models.critic} · composition + consistency ${options.models.finisher} · finish ${options.models.finisher} → ${options.models.finisherEscalation}`
    : "Cost-aware new-run route · Role-aware model routing is recorded with every run.";
  const routeSummary = "The Art Director chooses named specialists for this brief; their work stays attached to the room.";
  const realtime = {
    enabled: options.realtime?.enabled ?? true,
    uri: options.realtime?.uri ?? "http://127.0.0.1:3000",
    database: options.realtime?.database ?? "roster-local",
    runId,
    confirmedReads: options.realtime?.confirmedReads ?? false,
    workspaceId: options.realtime?.workspaceId,
    workspaceCapabilitySecret: options.realtime?.workspaceCapabilitySecret,
  };
  const boot = scriptJson({
    stream: options.stream,
    runId,
    apiReady: options.apiReady,
    models: options.models,
    realtime,
  });
  const formQuery = new URLSearchParams({ stream: options.stream }).toString();
  const assetPath = options.realtime?.assetPath ?? "/assets/canvas-client.js";
  const nonceAttribute = options.nonce ? ` nonce="${esc(options.nonce)}"` : "";

  const connectionStatus = `<div class="connection-pill" id="canvas-live-pill" data-state="${runId ? "connecting" : "idle"}" role="status" aria-live="polite" aria-atomic="true">
    <span class="connection-dot" aria-hidden="true"></span><span id="canvas-live-label">${runId ? "CONNECTING" : "READY"}</span>
  </div>`;

  const promptCard = agentComposerHtml({
    id: "canvas-brief",
    inputId: "canvas-prompt",
    title: "Brief the studio",
    description: "Describe what you want to make. Sending the brief opens a shared run with an Art Director and named specialists.",
    action: `/canvas/run?${formQuery}`,
    formId: "canvas-run-form",
    inputName: "prompt",
    inputLabel: "Message to the studio",
    placeholder: "A Bicycle lighthouse glowing above a moonlit harbor…",
    submitLabel: "Begin Painting",
    submitId: "canvas-submit",
    inputMinLength: 3,
    inputMaxLength: 1000,
    hiddenHtml: `<input type="hidden" name="csrf" value="${esc(options.csrfToken)}" />`,
    toolsHtml: `<label class="agent-composer-number" for="canvas-parallel"><span>Artists</span><input id="canvas-parallel" type="number" name="parallel" min="${CANVAS_MIN_PAINTERS}" max="${CANVAS_MAX_PAINTERS}" value="5" inputmode="numeric" autocomplete="off" required aria-describedby="canvas-artist-range" /></label>`,
    helpHtml: `<span class="route-note" title="${esc(routeNote)}">${esc(routeSummary)}</span><span aria-hidden="true"> · </span><span id="canvas-artist-range">Choose ${CANVAS_MIN_PAINTERS}–${CANVAS_MAX_PAINTERS} artists</span>${options.apiReady ? "" : `<span class="api-note" role="alert">${esc(options.apiNote ?? "Model access is unavailable.")}</span>`}`,
    disabled: !options.apiReady,
  });
  const studioFloor = `<section class="studio-floor" id="studio-floor" data-slot="studio-floor" data-state="idle" aria-labelledby="studio-floor-title" aria-busy="false">
      <h2 class="sr-only" id="studio-floor-title">Team conversation</h2>
      <ol class="agent-message-thread studio-status-thread" aria-label="Studio status">
        <li class="agent-message studio-status-message">
          <span class="agent-message-avatar studio-status-avatar" aria-hidden="true"><span class="studio-beacon"></span></span>
          <article>
            <header><strong>Art Director</strong><span>Studio facilitator</span><span class="studio-phase" id="studio-phase">Ready</span></header>
            <p class="studio-live-copy" id="studio-live-copy" role="status" aria-live="polite" aria-atomic="true">This is your shared Canvas room. Describe a scene and the director will assemble the right specialists here.</p>
          </article>
        </li>
      </ol>
      <section class="studio-feed-section" aria-labelledby="studio-events-title">
        <h3 class="sr-only" id="studio-events-title">Messages</h3><span class="sr-only" id="studio-event-count">0 updates</span>
        <ol class="agent-message-thread studio-event-strip" id="studio-event-strip"></ol>
      </section>
      <details class="studio-team-activity" id="studio-team-activity" hidden>
        <summary><span><strong id="studio-agents-title">Team activity</strong><small>Live specialist assignments</small></span><b id="studio-agent-count">0 active</b><i aria-hidden="true">⌄</i></summary>
        <ul class="studio-agent-strip" id="studio-agent-strip" aria-labelledby="studio-agents-title"></ul>
      </details>
    </section>`;
  const canvasPanel = `<div class="canvas-tab-stack" data-slot="canvas-workspace">
    <dl class="metric-grid" aria-label="Live run summary">
      <div class="metric"><dt>Run State</dt><dd id="metric-run">${runId ? "Joining" : "Ready"}</dd><small id="metric-sync">Direct channel idle</small></div>
      <div class="metric"><dt>Active Agents</dt><dd id="metric-active">0</dd><small id="metric-inflight">0 inflight allowed</small></div>
      <div class="metric"><dt>Waiting</dt><dd id="metric-queued">0</dd><small>scheduled tasks</small></div>
      <div class="metric"><dt>Completed</dt><dd id="metric-completed">0</dd><small>accepted tasks</small></div>
      <div class="metric"><dt>Scene Objects</dt><dd id="metric-budget">0</dd><small id="metric-budget-note">certified vector marks</small></div>
    </dl>

    <figure class="workspace" id="canvas-workspace" data-state="empty" aria-busy="${runId ? "true" : "false"}">
      <div class="canvas-toolbar" aria-hidden="true">
        <div class="canvas-chip"><span>●</span><strong id="canvas-stage-label">Shared vector frontier</strong></div>
        <div class="canvas-chip"><span id="canvas-object-count">0</span> objects</div>
      </div>
      <div class="frontier-bar" id="canvas-frontier" hidden>
        <span class="frontier-pulse" aria-hidden="true"></span>
        <span id="frontier-label">Studio active</span>
        <span class="frontier-signal" id="frontier-signal">Waiting for agent signal</span>
        <span class="frontier-counts" aria-hidden="true"><strong id="frontier-active">0</strong> live · <strong id="frontier-done">0</strong> done</span>
      </div>
      <svg class="canvas-stage" id="canvas-stage" viewBox="0 0 1000 1000" role="img" aria-labelledby="canvas-title canvas-description">
        <title id="canvas-title">Collaborative multi-agent illustration</title>
        <desc id="canvas-description">Waiting for a run. Scene objects appear incrementally as immutable artist patches arrive.</desc>
        <defs><pattern id="canvas-grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#7990a8" stroke-width="1" /></pattern></defs>
        <defs id="canvas-paint-defs"></defs>
        <rect class="canvas-grid" width="1000" height="1000" fill="url(#canvas-grid)" aria-hidden="true" />
        <g id="canvas-scene"></g>
      </svg>
      <div class="scene-empty" id="canvas-empty">
        <div class="empty-art"><span class="empty-orbit" aria-hidden="true"></span><strong id="canvas-empty-title">The studio is ready</strong><span id="canvas-empty-copy">Send a brief to watch independent artists publish directly into one shared scene.</span></div>
      </div>
      <figcaption class="canvas-caption">
        <span><strong id="canvas-caption-title">No active run</strong><br><span id="canvas-caption-copy">The next run will connect to a caller-scoped realtime view.</span></span>
        <span class="progress-wrap"><span id="canvas-progress-copy">0 / 0 tasks</span><span class="progress-track" id="canvas-progress" role="progressbar" aria-label="Run progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="progress-fill" id="canvas-progress-fill"></span></span></span>
      </figcaption>
    </figure>

    <section class="connection-panel agent-surface" aria-labelledby="connection-title">
      <div class="panel-head"><div><p class="panel-kicker">Run channel</p><h2 id="connection-title">Realtime Connection</h2></div><span class="panel-count" id="last-sync">Not connected</span></div>
      <div class="connection-card"><strong id="connection-copy">${runId ? "Opening direct channel…" : "Waiting for a run"}</strong><span id="connection-detail">${esc(realtime.database)}</span></div>
    </section>
  </div>`;

  const teamPanel = `<div class="detail-grid" data-slot="canvas-team-view">
    <section class="detail-panel agent-surface" aria-labelledby="teams-title">
      <div class="panel-head"><div><p class="panel-kicker">Shared frontier</p><h2 id="teams-title">Collaboration Teams</h2></div><span class="panel-count" id="team-count">0 teams</span></div>
      <ul class="team-list" id="team-list"><li class="empty-copy">Assignments appear after the Art Director publishes the task frontier.</li></ul>
    </section>
    <section class="detail-panel agent-surface" aria-labelledby="agents-title">
      <div class="panel-head"><div><p class="panel-kicker">Specialists</p><h2 id="agents-title">Agent Drilldown</h2></div><span class="panel-count" id="agent-count">0 agents</span></div>
      <details class="agent-detail" id="agent-detail" open><summary><strong>Inspect individual agents</strong><span id="agent-summary">No assignments</span></summary><ul class="agent-list" id="agent-list"><li class="empty-copy">No agent tasks yet.</li></ul></details>
    </section>
  </div>`;

  const reviewPanel = `<section class="detail-panel review-panel agent-surface" aria-labelledby="review-title-heading">
    <div class="panel-head"><div><p class="panel-kicker">Independent evidence</p><h2 id="review-title-heading">Validation Council</h2></div><span class="panel-count" id="review-score">PNG + structure</span></div>
    <div class="review-box" id="review-box" data-state="waiting"><div class="review-title"><strong id="review-verdict">Awaiting validator reports</strong><span id="review-scope">not started</span></div><ul class="review-list" id="review-list"><li>Subject, composition, consistency, and structural validators join at the first complete scene frontier.</li></ul></div>
  </section>`;

  const activityPanel = `<section class="detail-panel activity-panel agent-surface" aria-labelledby="activity-title">
    <div class="panel-head"><div><p class="panel-kicker">Detailed run history</p><h2 id="activity-title">Timeline</h2></div><span class="panel-count" id="activity-count" role="status" aria-live="polite" aria-atomic="true">0 events</span></div>
    <ol class="activity-list" id="activity-list"><li class="empty-copy">Waiting for run-scoped activity.</li></ol>
  </section>`;
  const conversationPanel = `<div class="canvas-conversation" data-slot="canvas-conversation">${studioFloor}</div>`;

  const runsPanel = `<section class="detail-panel canvas-runs-panel agent-surface" aria-labelledby="canvas-runs-title">
    <div class="panel-head"><div><p class="panel-kicker">Workspace history</p><h2 id="canvas-runs-title">Runs</h2></div><span class="panel-count" id="canvas-runs-count">Synchronizing</span></div>
    <ul class="canvas-run-list" id="canvas-run-list"><li class="empty-copy">Synchronizing Canvas run history…</li></ul>
  </section>`;
  const replayBar = agentReplayBarHtml({
    id: "canvas-replay",
    title: "Scene history",
    description: runId ? "Scrub immutable artist patches and watch the shared scene form step by step." : "Start or select an illustration to replay its shared scene.",
    content: agentReplayClientControlsHtml({
      id: "canvas-replay-controls",
      adapter: "canvas",
      emptyLabel: runId ? "Loading history…" : "No run selected",
    }),
  });

  const tabs = agentExampleTabsHtml({
    id: "canvas-studio-tabs",
    agentId: "canvas",
    label: "Artist studio views",
    workspaceBadge: runId ? "Live" : undefined,
    history: replayBar,
    railActionsHtml: `<a href="/canvas">New Room</a>`,
    conversation: conversationPanel,
    composer: promptCard,
    workLabel: "Work",
    workspaceLabel: "Scene",
    room: {
      eyebrow: "Studio room",
      title: "#canvas-studio",
      description: "The shared scene is the center of an ongoing creative conversation between the director, artists, reviewers, and you.",
      state: runId ? "active" : "open",
      stateLabel: runId ? "Run selected" : "Room open",
      actionsHtml: connectionStatus,
      roster: staticRoomRoster({
        roomId: "canvas-studio",
        summary: runId ? "You and the Art Director are connected to this run" : "You are here; the Art Director is ready",
        context: "Specialists appear by name only after the run publishes their assignments",
        members: [
        { id: "human.operator", name: "You", role: "Creative partner", kind: "human", presence: "present" },
        { id: "orchestrator", name: "Art Director", role: "Direction and composition", kind: "system", presence: runId ? "joined" : "waiting" },
        ],
      }),
    },
    workspace: canvasPanel,
    runs: runsPanel,
    activity: activityPanel,
    domainTabs: [
      { id: "team", label: "Team", content: teamPanel },
      { id: "review", label: "Review", content: reviewPanel },
    ],
  });

  const toolbar = agentTopNavHtml({ active: "canvas", statusLabel: runId ? "Canvas room active" : "Canvas room ready" });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#090c11" />
  <title>Roster - Canvas Roster</title>${themeBootstrapScript(options.nonce)}
  <style${nonceAttribute}>
    ${agentShellCss()}
    :root {
      --coral:#ff9275; --mint:var(--green); --gold:var(--amber);
      --good:var(--green); --warn:var(--amber); --bad:var(--red); --focus:var(--agent-accent);
      --radius:var(--radius-lg); --shadow:0 24px 80px rgba(0,0,0,.34);
    }
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .canvas-app .agent-main{display:grid;align-content:start}.architecture-note{display:grid;gap:7px;padding:11px;border:1px solid var(--line);border-radius:var(--radius-sm);background:linear-gradient(145deg,rgba(103,217,156,.07),rgba(120,169,255,.025))}.architecture-note strong{display:flex;align-items:center;gap:7px;font-size:10px}.architecture-note p{margin:0;color:var(--muted);font-size:9px;line-height:1.55}
    .connection-pill{flex:none;min-height:34px;display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--panel);font:800 8px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}.connection-dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}.connection-pill[data-state="live"]{color:var(--mint);border-color:color-mix(in srgb,var(--mint) 45%,var(--line))}.connection-pill[data-state="live"] .connection-dot{background:var(--mint);box-shadow:0 0 0 5px rgba(103,217,156,.08)}.connection-pill[data-state="connecting"],.connection-pill[data-state="syncing"],.connection-pill[data-state="reconnecting"]{color:var(--gold)}.connection-pill[data-state="connecting"] .connection-dot,.connection-pill[data-state="syncing"] .connection-dot,.connection-pill[data-state="reconnecting"] .connection-dot{background:var(--gold);animation:pulse 1.1s ease-in-out infinite alternate}.connection-pill[data-state="error"]{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}.connection-pill[data-state="error"] .connection-dot{background:var(--bad)}
    #canvas-studio-tabs{margin-top:0}#canvas-studio-tabs .agent-tablist{position:sticky;z-index:20;top:0;padding-top:2px;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(14px)}.canvas-tab-stack{min-width:0;display:grid;gap:12px}.canvas-app>.agent-main>.agent-replay{margin:16px 0 0}.canvas-app.agent-unified-page .agent-main{align-content:stretch}
    .canvas-conversation{width:100%;display:grid;gap:0}
    .agent-composer-number{min-height:30px;display:flex;align-items:center;gap:6px;padding:0 8px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-tertiary);background:var(--surface-inset);font-size:9px}.agent-composer-number input{width:38px;border:0;padding:0;color:var(--text-primary);background:transparent}.api-note{color:var(--bad);font-weight:750}.route-note{min-width:0;overflow-wrap:anywhere}
    .metric-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:0}.metric{min-width:0;padding:11px 12px;border:1px solid var(--line);border-radius:var(--radius-md);background:linear-gradient(160deg,var(--panel-2),var(--panel))}.metric dt{color:var(--muted);font:800 8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.metric dd{margin:7px 0 0;font-size:18px;font-weight:850;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.metric small{display:block;margin-top:3px;color:var(--faint);font-size:8px}
    .studio-floor{--studio-state:var(--faint);display:grid;gap:12px;padding:15px;overflow:hidden}.studio-floor[data-state="active"]{--studio-state:var(--mint);border-color:color-mix(in srgb,var(--mint) 28%,var(--line))}.studio-floor[data-state="delayed"]{--studio-state:var(--gold);border-color:color-mix(in srgb,var(--gold) 34%,var(--line))}.studio-floor[data-state="stalled"]{--studio-state:var(--bad);border-color:color-mix(in srgb,var(--bad) 38%,var(--line))}.studio-floor-head,.studio-floor-title,.studio-section-head,.studio-agent-head,.studio-event-head{display:flex;align-items:center}.studio-floor-head,.studio-section-head,.studio-agent-head,.studio-event-head{justify-content:space-between}.studio-floor-title{gap:9px}.studio-floor-title h2,.studio-section-head h3{margin:0}.studio-floor-title h2{font-size:15px}.studio-beacon{width:9px;height:9px;border-radius:50%;background:var(--studio-state);box-shadow:0 0 0 5px color-mix(in srgb,var(--studio-state) 11%,transparent)}.studio-floor[data-state="active"] .studio-beacon{animation:pulse 1s ease-in-out infinite alternate}.studio-phase{padding:5px 8px;border:1px solid color-mix(in srgb,var(--studio-state) 38%,var(--line));border-radius:999px;color:var(--studio-state);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em}.studio-live-copy{margin:0;color:var(--muted);font-size:11px;line-height:1.5}.studio-live-copy strong{color:var(--ink)}.studio-floor-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(250px,.7fr);gap:10px}.studio-floor-section{min-width:0;display:grid;align-content:start;gap:9px;padding:11px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:color-mix(in srgb,var(--bg) 84%,transparent)}.studio-section-head h3{font-size:10px;text-transform:uppercase;letter-spacing:.06em}.studio-section-head span{color:var(--faint);font:8px/1 ui-monospace,monospace}.studio-agent-strip,.studio-event-strip{list-style:none;margin:0;padding:0}.studio-agent-strip{display:grid;grid-template-columns:1fr;gap:7px}.studio-agent-card{--agent:var(--blue);min-width:0;display:grid;gap:7px;padding:10px;border:1px solid var(--line-soft);border-radius:8px;background:var(--panel)}.studio-agent-card[data-state="active"]{border-color:color-mix(in srgb,var(--agent) 45%,var(--line));background:linear-gradient(145deg,color-mix(in srgb,var(--agent) 8%,var(--panel)),var(--panel))}.studio-agent-card[data-state="failed"]{border-color:color-mix(in srgb,var(--bad) 48%,var(--line))}.studio-agent-head{gap:8px}.studio-agent-identity{min-width:0;display:flex;align-items:center;gap:7px}.studio-agent-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--agent)}.studio-agent-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.studio-agent-state{flex:none;color:var(--muted);font:800 7px/1 ui-monospace,monospace;text-transform:uppercase}.studio-agent-card[data-state="active"] .studio-agent-state{color:var(--agent)}.studio-agent-task{min-height:29px;display:-webkit-box;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;color:var(--muted);font-size:9px;line-height:1.5}.studio-agent-signal{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--faint);font:7px/1 ui-monospace,monospace}.studio-working-line{height:2px;overflow:hidden;border-radius:2px;background:var(--line)}.studio-working-line:after{content:"";display:block;width:38%;height:100%;border-radius:inherit;background:var(--agent);transform:translateX(-110%)}.studio-agent-card[data-state="active"] .studio-working-line:after{animation:studio-work 1.35s ease-in-out infinite}.studio-event-strip{display:grid;gap:7px}.studio-event-row{min-width:0;display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:start;gap:9px;padding:11px;border:1px solid var(--line-soft);border-radius:8px;background:var(--panel)}.studio-event-mark{width:7px;height:7px;margin-top:4px;border-radius:50%;background:var(--event,var(--blue))}.studio-event-copy{min-width:0;color:var(--muted);font-size:10px;line-height:1.5;overflow-wrap:anywhere}.studio-event-copy strong{color:var(--ink)}.studio-event-time{color:var(--faint);font:8px/1 ui-monospace,monospace}.studio-placeholder{padding:12px;color:var(--faint);font-size:10px;line-height:1.5}
    .workspace{position:relative;min-width:0;min-height:0;margin:0;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:#0b0e14;box-shadow:var(--shadow)}.canvas-toolbar{position:absolute;z-index:5;left:12px;right:12px;top:12px;display:flex;justify-content:space-between;gap:10px;pointer-events:none}.canvas-chip{min-height:31px;display:flex;align-items:center;gap:7px;max-width:min(70%,620px);padding:6px 9px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(8,11,16,.78);color:#bdc6d0;backdrop-filter:blur(10px);font:750 9px/1 ui-monospace,monospace}.canvas-chip span:first-child{color:var(--mint)}.canvas-chip strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.frontier-bar{position:absolute;z-index:5;left:50%;top:55px;transform:translateX(-50%);display:flex;align-items:center;gap:9px;max-width:calc(100% - 32px);min-height:34px;padding:7px 11px;border:1px solid rgba(255,255,255,.13);border-radius:999px;background:rgba(8,11,16,.84);color:#dbe2e9;backdrop-filter:blur(11px);font:800 9px/1 ui-monospace,monospace;box-shadow:0 12px 28px rgba(0,0,0,.25)}.frontier-bar[hidden]{display:none}.frontier-pulse{width:8px;height:8px;border-radius:50%;background:var(--mint);animation:pulse 1s ease-in-out infinite alternate}.frontier-signal{max-width:260px;padding-left:9px;border-left:1px solid rgba(255,255,255,.12);color:var(--mint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.frontier-signal[data-state="delayed"]{color:var(--gold)}.frontier-signal[data-state="stale"]{color:var(--bad)}.frontier-counts{display:flex;gap:8px;color:var(--muted)}.frontier-counts strong{color:var(--ink)}.canvas-stage{width:100%;aspect-ratio:1/1;min-height:460px;display:block;background:radial-gradient(circle at 50% 40%,rgba(103,217,156,.055),transparent 43%),#0b0e14}.canvas-grid{opacity:.18}.scene-object{transform-box:fill-box;transform-origin:center;animation:object-in .42s cubic-bezier(.2,.8,.2,1) both}.workspace[data-replay-state="replay"] .scene-object{animation:none}.scene-object:hover{filter:drop-shadow(0 0 8px var(--owner-color,var(--mint)))}.scene-empty{position:absolute;inset:94px 0 48px;display:grid;place-items:center;padding:28px;pointer-events:none}.scene-empty[hidden]{display:none}.empty-art{width:min(420px,86%);display:grid;justify-items:center;gap:12px;text-align:center;color:var(--muted)}.empty-orbit{position:relative;width:116px;height:116px;border:1px solid rgba(103,217,156,.24);border-radius:50%;box-shadow:inset 0 0 36px rgba(103,217,156,.04)}.empty-orbit:before,.empty-orbit:after{content:"";position:absolute;border-radius:50%}.empty-orbit:before{width:38px;height:38px;left:39px;top:39px;background:linear-gradient(135deg,var(--coral),var(--gold));box-shadow:0 0 36px rgba(255,146,117,.22)}.empty-orbit:after{width:10px;height:10px;left:8px;top:52px;background:var(--mint);box-shadow:89px 0 0 var(--blue);animation:orbit 3.2s linear infinite}.empty-art strong{color:var(--ink);font-size:14px}.empty-art span{max-width:340px;font-size:11px;line-height:1.55}.canvas-caption{min-height:46px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:10px 12px;border-top:1px solid var(--line);color:var(--muted);font-size:10px;overflow-wrap:anywhere}.canvas-caption strong{color:var(--ink)}.progress-wrap{display:flex;align-items:center;gap:9px}.progress-track{width:116px;height:5px;overflow:hidden;border-radius:4px;background:var(--line)}.progress-fill{height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,var(--coral),var(--mint));transition:width .28s ease}
    .connection-panel,.detail-panel{min-width:0;padding:14px}.connection-panel{display:grid;grid-template-columns:minmax(180px,.45fr) minmax(0,1fr);align-items:center;gap:16px}.panel-head{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:12px}.panel-head>div{min-width:0}.panel-kicker{margin:0 0 4px;color:var(--agent-accent);font:800 8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.09em}.panel-head h2{margin:0;font-size:13px;letter-spacing:-.01em}.panel-count{flex:none;color:var(--muted);font:9px/1 ui-monospace,monospace}.connection-card{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--bg)}.connection-card strong{font-size:10px}.connection-card span{min-width:0;color:var(--muted);font:9px/1.45 ui-monospace,monospace;overflow-wrap:anywhere}.detail-grid{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:12px}.detail-panel{display:grid;align-content:start;gap:14px;min-height:360px}.review-panel,.activity-panel{min-height:360px}.team-list,.agent-list,.activity-list,.review-list,.canvas-run-list{list-style:none;display:grid;gap:7px;padding:0;margin:0}.canvas-run-list{grid-template-columns:repeat(2,minmax(0,1fr))}.canvas-run-card a{display:grid;gap:8px;min-height:118px;padding:12px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);color:inherit;background:var(--bg);text-decoration:none}.canvas-run-card a:hover{border-color:color-mix(in srgb,var(--agent-accent) 45%,var(--line))}.canvas-run-card a[aria-current="page"]{border-color:var(--agent-accent);background:var(--agent-accent-soft)}.canvas-run-head,.canvas-run-meta{display:flex;align-items:center;justify-content:space-between;gap:10px}.canvas-run-head strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.canvas-run-head span{flex:none;color:var(--agent-accent);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase}.canvas-run-prompt{display:-webkit-box;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;color:var(--muted);font-size:10px;line-height:1.45}.canvas-run-meta{color:var(--faint);font:8px/1 ui-monospace,monospace}.team-list{grid-template-columns:repeat(2,minmax(0,1fr))}.team-card{display:grid;gap:8px;padding:12px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--bg)}.team-head{display:flex;align-items:center;justify-content:space-between;gap:9px}.team-head strong{font-size:10px}.team-head span{color:var(--muted);font:8px/1 ui-monospace,monospace}.team-meter{height:3px;overflow:hidden;border-radius:3px;background:var(--line)}.team-meter>span{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--mint))}.team-meta{display:flex;gap:7px;color:var(--faint);font:8px/1 ui-monospace,monospace}details.agent-detail{border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--bg)}details.agent-detail>summary{min-height:46px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;cursor:pointer;color:var(--muted);font-size:10px}details.agent-detail>summary strong{color:var(--ink)}.agent-list{max-height:560px;overflow:auto;padding:0 10px 10px}.agent-row{--agent:var(--blue);display:grid;grid-template-columns:7px minmax(0,1fr) auto;align-items:center;gap:9px;min-height:52px;padding:8px 2px;border-top:1px solid var(--line-soft)}.agent-mark{width:7px;height:30px;border-radius:5px;background:var(--agent)}.agent-copy{min-width:0;display:grid;gap:3px}.agent-copy strong,.agent-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-copy strong{font-size:10px}.agent-copy span{color:var(--muted);font-size:8px}.agent-row .agent-status{min-height:0;display:block;padding:0;border:0;border-radius:0;background:transparent;font:800 7px/1 ui-monospace,monospace;text-transform:uppercase;color:var(--muted);letter-spacing:0}.agent-row .agent-status:before{display:none}.agent-row[data-state="running"] .agent-status,.agent-row[data-state="leased"] .agent-status{color:var(--mint)}.agent-row[data-state="failed"] .agent-status{color:var(--bad)}.review-box{display:grid;gap:12px;padding:16px;border:1px solid var(--line-soft);border-radius:var(--radius-md);background:var(--bg)}.review-box[data-state="pass"]{border-color:color-mix(in srgb,var(--good) 43%,var(--line))}.review-box[data-state="warn"]{border-color:color-mix(in srgb,var(--warn) 46%,var(--line))}.review-box[data-state="fail"]{border-color:color-mix(in srgb,var(--bad) 43%,var(--line))}.review-title{display:flex;justify-content:space-between;gap:10px;font-size:12px}.review-title span{color:var(--muted);font:8px/1 ui-monospace,monospace}.review-list{color:var(--muted);font-size:10px;line-height:1.5}.review-list li:before{content:"—";margin-right:6px;color:var(--faint)}.activity-list{max-height:620px;overflow:auto}.activity-row{display:grid;grid-template-columns:70px minmax(0,1fr);gap:12px;padding:11px 3px;border-bottom:1px solid var(--line-soft)}.activity-row time{color:var(--faint);font:8px/1.35 ui-monospace,monospace}.activity-row div{min-width:0;color:var(--muted);font-size:10px;line-height:1.45}.activity-row strong{color:var(--ink)}.activity-kind{display:block;margin-top:3px;color:var(--faint);font:700 7px/1.25 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.04em}.empty-copy{margin:0;padding:9px 2px;color:var(--faint);font-size:9px;line-height:1.45}
    @keyframes pulse{to{opacity:.42;transform:scale(.82)}}@keyframes studio-work{50%{transform:translateX(165%)}100%{transform:translateX(370%)}}@keyframes object-in{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}@keyframes orbit{to{transform:rotate(360deg);transform-origin:50px 5px}}
    @media(min-width:821px) and (max-width:1180px){.detail-grid,.studio-floor-grid{grid-template-columns:1fr}.studio-agent-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.team-list{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:820px){#canvas-studio-tabs .agent-tablist{top:0}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.metric:first-child{grid-column:1/-1}.studio-floor-grid{grid-template-columns:1fr}.studio-agent-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.canvas-stage{min-height:320px}.canvas-toolbar{top:8px;left:8px;right:8px}.canvas-chip{max-width:78%}.frontier-bar{top:48px}.canvas-caption{grid-template-columns:1fr}.connection-panel{grid-template-columns:1fr}.detail-grid{grid-template-columns:1fr}.team-list,.canvas-run-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:560px){.connection-pill{justify-self:start}.studio-floor-head{align-items:flex-start;gap:9px}.studio-phase{max-width:48%;text-align:right;white-space:normal}.studio-agent-strip,.team-list,.canvas-run-list{grid-template-columns:1fr}.studio-event-row{grid-template-columns:8px minmax(0,1fr)}.studio-event-time{grid-column:2}.canvas-chip:first-child{max-width:70%}.frontier-counts{display:none}.panel-head{align-items:flex-start}.connection-card{align-items:flex-start;flex-direction:column}.detail-panel,.review-panel,.activity-panel{min-height:0}}
    .studio-floor{--studio-state:var(--faint);gap:0;padding:0;overflow:visible}.studio-floor[data-state="active"]{--studio-state:var(--mint)}.studio-floor[data-state="delayed"]{--studio-state:var(--gold)}.studio-floor[data-state="stalled"]{--studio-state:var(--bad)}.studio-status-thread{padding-bottom:0}.studio-status-avatar{border-radius:9px}.studio-beacon{width:9px;height:9px;margin:0;border-radius:50%;background:var(--studio-state);box-shadow:0 0 0 4px color-mix(in srgb,var(--studio-state) 13%,transparent)}.studio-phase{padding:0;border:0;border-radius:0;color:var(--studio-state)!important;font:inherit;text-transform:capitalize;letter-spacing:0}.studio-live-copy{margin:4px 0 0;color:var(--ink);font-size:15px;line-height:1.55}.studio-event-strip{gap:0;padding-bottom:0}.studio-event-strip:empty{display:none}.studio-event-row{grid-template-columns:40px minmax(0,1fr);gap:12px;padding:9px 0;border:0;border-radius:0;background:transparent}.studio-event-mark{width:40px;height:40px;margin:0;border:1px solid color-mix(in srgb,var(--event,var(--blue)) 46%,var(--border-strong));border-radius:9px;color:var(--event,var(--blue));background:var(--surface-raised)}.studio-event-copy{margin:4px 0 0;color:var(--ink);font-size:15px;line-height:1.55}.studio-event-time{color:var(--faint);font:11px/1 var(--font-ui)}.studio-team-activity{margin:8px 0 0 52px;border-top:1px solid var(--line-soft)}.studio-team-activity>summary{min-height:42px;display:grid;grid-template-columns:minmax(0,1fr) auto 14px;align-items:center;gap:9px;color:var(--muted);cursor:pointer;list-style:none}.studio-team-activity>summary::-webkit-details-marker{display:none}.studio-team-activity>summary span{display:grid;gap:2px}.studio-team-activity>summary strong{color:var(--ink);font-size:11px}.studio-team-activity>summary small,.studio-team-activity>summary b{color:var(--faint);font-size:9px;font-weight:600}.studio-team-activity>summary i{font-style:normal;transition:transform .14s ease}.studio-team-activity[open]>summary i{transform:rotate(180deg)}.studio-team-activity .studio-agent-strip{grid-template-columns:repeat(2,minmax(0,1fr));padding-bottom:10px}@media(max-width:560px){.studio-team-activity{margin-left:0}.studio-team-activity .studio-agent-strip{grid-template-columns:1fr}}
    @media(prefers-reduced-motion:reduce){.connection-pill .connection-dot,.studio-floor[data-state="active"] .studio-beacon,.studio-agent-card[data-state="active"] .studio-working-line:after,.frontier-pulse,.scene-object,.empty-orbit:after{animation:none!important}.studio-agent-card[data-state="active"] .studio-working-line:after{transform:none;width:100%;opacity:.6}.run-button:hover{transform:none}.progress-fill{transition:none}}
  </style>
</head>
<body>
  ${agentShellFrameHtml({ skipHref: "#canvas-main", skipLabel: "Skip to the Canvas studio", chromeHtml: toolbar, mainHtml: tabs, mainId: "canvas-main", appClass: "agent-unified-page canvas-app" })}
  ${agentTabsScript(options.nonce)}
  <script id="canvas-boot" type="application/json"${nonceAttribute}>${boot}</script>
  <script type="module" src="${esc(assetPath)}"${nonceAttribute}></script>
</body>
</html>`;
};
