import {
  COORDINATION_PATTERNS,
  type CoordinationPattern,
  type SimulationCampaignInput,
  type SimulationCampaignReport,
} from "../simulations/campaign.js";
import { esc, truncate } from "./agent-framework.js";
import {
  agentReplayBarHtml,
  agentReplayClientControlsHtml,
  agentShellCss,
  agentShellFrameHtml,
  staticRoomRoster,
  agentTabsHtml,
  agentTabsScript,
  agentTopNavHtml,
  agentWorkspaceShellHtml,
} from "./agent-shell.js";
import { themeBootstrapScript } from "./theme.js";

const numberFormatter = new Intl.NumberFormat("en-US");
const formatNumber = (value: number): string => numberFormatter.format(value);
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

const patternOptionsHtml = (active: CoordinationPattern): string => COORDINATION_PATTERNS
  .map((pattern) => `<label class="sim-pattern-option">
    <input type="radio" name="pattern" value="${pattern.id}"${pattern.id === active ? " checked" : ""} />
    <span><strong>${esc(pattern.label)}</strong><small>${esc(pattern.topology)}</small></span>
  </label>`)
  .join("");

export const simulationCampaignHtml = (report: SimulationCampaignReport): string => {
  const status = report.summary.converged ? "Converged" : "Diverged";
  const reproduceCommand = (seed: number): string =>
    `npm run simulate:campaign -- --pattern ${report.input.pattern} --agents ${report.input.agents}`
    + ` --parallel ${report.input.maxParallel} --schedules 1 --seed ${seed}`
    + (report.input.injectFaults ? " --faults" : "");
  const scheduleRows = report.schedules.map((schedule) => `<tr>
    <td><code>${schedule.seed}</code><small> · ${esc(schedule.seedHex)}</small></td>
    <td>${formatNumber(schedule.entropyDraws)}</td>
    <td><span class="sim-verdict" data-status="${schedule.converged ? "pass" : "fail"}">${schedule.converged ? "Pass" : "Fail"}</span></td>
    <td>${schedule.replayExact ? "Exact" : "Mismatch"}</td>
    <td>${formatNumber(schedule.peakParallel)}</td>
    <td>${formatNumber(schedule.faultRecoveries)}</td>
    <td><code>${esc(schedule.completionDigest)}</code></td>
    <td><code>${esc(schedule.transitionDigest)}</code><small>${formatNumber(schedule.transitionCount)} transitions</small></td>
    <td><code class="sim-command">${esc(reproduceCommand(schedule.seed))}</code></td>
  </tr>`).join("");
  const topologyRows = report.topologies.map((topology) => `<li>
    <span class="sim-operation">${esc(topology.operation)}</span>
    <span class="sim-k">K<sub>${formatNumber(topology.leaves)}</sub></span>
    <code>${esc(topology.bracket)}</code>
    <small>${esc(truncate(topology.reason, 150))}</small>
  </li>`).join("");
  const applicationTab = report.application ? {
    id: "invariants",
    label: "Application invariants",
    badge: formatNumber(report.application.invariants.length),
    content: `<section class="sim-section" aria-labelledby="simulation-invariants-title">
      <div class="sim-section-head"><h3 id="simulation-invariants-title">Coding Collaboration Contract</h3><span>${formatNumber(report.application.requestedSpecialists)} requested → ${formatNumber(report.application.selectedSpecialists)} selected · ${formatNumber(report.application.taskCount)} tasks · ${formatNumber(report.application.routedResponseCount)} routed responses · ${formatNumber(report.application.consultationTurns)} emergent consultations</span></div>
      <div class="sim-table-wrap"><table><thead><tr><th>Invariant</th><th>State</th><th>Evidence</th></tr></thead><tbody>${report.application.invariants.map((invariant) => `<tr><td>${esc(invariant.label)}</td><td><span class="sim-verdict" data-status="${invariant.passed ? "pass" : "fail"}">${invariant.passed ? "Pass" : "Fail"}</span></td><td>${esc(invariant.evidence)}</td></tr>`).join("")}</tbody></table></div>
    </section>`,
  } : undefined;
  const terminalProjectionTab = report.terminalProjection ? {
    id: "terminal-projection",
    label: "Terminal delivery",
    badge: formatNumber(report.terminalProjection.invariants.length),
    content: `<section class="sim-section" data-simulation-terminal-projection aria-labelledby="simulation-terminal-projection-title">
      <div class="sim-section-head"><h3 id="simulation-terminal-projection-title">Coding Terminal Projection Contract</h3><span>${formatNumber(report.terminalProjection.scheduleCount)} schedules · ${formatNumber(report.terminalProjection.scheduleVariants)} interleavings · ${formatNumber(report.terminalProjection.prefixObservations)} evidence prefixes</span></div>
      <dl class="sim-metrics">
        <div><dt>Entropy draws</dt><dd>${formatNumber(report.terminalProjection.entropyDraws)}</dd></div>
        <div><dt>Exact replays</dt><dd>${formatNumber(report.terminalProjection.exactReplays)}</dd></div>
        <div><dt>Fault operations</dt><dd>${formatNumber(report.terminalProjection.injectedFaults)}</dd></div>
        <div><dt>Projection restarts</dt><dd>${formatNumber(report.terminalProjection.projectionRestarts)}</dd></div>
        <div><dt>Version conflicts</dt><dd>${formatNumber(report.terminalProjection.sameVersionConflicts)}</dd></div>
        <div><dt>State combinations</dt><dd>${formatNumber(report.terminalProjection.exhaustiveCombinations)}</dd></div>
      </dl>
      <div class="sim-table-wrap"><table><thead><tr><th>Invariant</th><th>State</th><th>Evidence</th></tr></thead><tbody>${report.terminalProjection.invariants.map((invariant) => `<tr><td>${esc(invariant.id)}</td><td><span class="sim-verdict" data-status="${invariant.passed ? "pass" : "fail"}">${invariant.passed ? "Pass" : "Fail"}</span></td><td>${esc(invariant.evidence)}</td></tr>`).join("")}</tbody></table></div>
    </section>`,
  } : undefined;
  const taskRows = (report.taskGraph ?? []).map((task) => `<tr>
    <td><code>${esc(task.taskId)}</code></td>
    <td>${esc(task.nodeId)}</td>
    <td>${esc(task.capability)}</td>
    <td>${task.parentTaskId ? `<code>${esc(task.parentTaskId)}</code>` : "—"}</td>
    <td>${task.dependencyTaskIds.length
      ? `<code>${esc(truncate(task.dependencyTaskIds.join(", "), 180))}</code>`
      : "—"}</td>
    <td><span class="sim-verdict" data-status="${task.status === "accepted" || task.status === "skipped" ? "pass" : "fail"}">${esc(task.status)}</span></td>
    <td>${formatNumber(task.attempt)}</td>
  </tr>`).join("");
  const expansionRows = (report.expansions ?? []).map((expansion) => `<tr>
    <td><code>${esc(expansion.expansionKey)}</code></td>
    <td><code>${esc(expansion.parentTaskId)}</code></td>
    <td>${formatNumber(expansion.childTaskIds.length)}</td>
    <td><code>${esc(expansion.continuationTaskId)}</code></td>
    <td><code>${esc(expansion.expansionHash.slice(0, 16))}</code></td>
  </tr>`).join("");
  const functionActivities = report.replayFrames.filter((frame) => frame.functionOperation);
  const activityRows = functionActivities.map((frame) => `<tr>
    <td>${formatNumber(frame.position)}</td>
    <td><code>${esc(frame.functionOperation ?? "")}</code></td>
    <td><code>${esc(frame.taskId ?? "campaign_root")}</code></td>
    <td><code>${esc(frame.functionId ?? "roster::catalog.search")}</code></td>
    <td>${frame.providerId
      ? `<code>${esc(frame.providerId)}@${formatNumber(frame.providerEpoch ?? 0)}</code>`
      : "task-local catalog"}</td>
    <td><code>${esc((frame.catalogVersion ?? "").slice(0, 20))}</code></td>
  </tr>`).join("");
  const lifecycleInvariantRows = report.runtimeLifecycle.invariants.map((invariant) => `<tr>
    <td>${esc(invariant.label)}</td>
    <td><span class="sim-verdict" data-status="${invariant.passed ? "pass" : "fail"}">${invariant.passed ? "Pass" : "Fail"}</span></td>
    <td>${esc(invariant.evidence)}</td>
  </tr>`).join("");
  const lifecycleScheduleRows = report.runtimeLifecycle.schedules.map((schedule) => `<tr>
    <td><code>${schedule.seed}</code><small> · ${esc(schedule.seedHex)}</small></td>
    <td>${formatNumber(schedule.entropyDraws)}</td>
    <td>${schedule.replayExact ? "Exact" : "Mismatch"}</td>
    <td>${formatNumber(schedule.observation.exercisedFaultIds.length)}</td>
    <td><code>${esc(schedule.transitionDigest)}</code><small>${formatNumber(schedule.transitionCount)} transitions</small></td>
  </tr>`).join("");
  const reportTabs = [
    ...(applicationTab ? [applicationTab] : []),
    ...(terminalProjectionTab ? [terminalProjectionTab] : []),
    {
      id: "runtime-lifecycle",
      label: "Runtime lifecycle",
      badge: formatNumber(report.runtimeLifecycle.invariants.length),
      content: `<section class="sim-section" data-simulation-runtime-lifecycle aria-labelledby="simulation-runtime-lifecycle-title">
        <div class="sim-section-head"><h3 id="simulation-runtime-lifecycle-title">Framework Lifecycle Contract</h3><span>${formatNumber(report.runtimeLifecycle.summary.exactReplays)} exact replays · ${formatNumber(report.runtimeLifecycle.summary.scheduleVariants)} interleavings · ${formatNumber(report.runtimeLifecycle.summary.faultRecoveries)} recovered fault occurrences</span></div>
        <div class="sim-table-wrap"><table><thead><tr><th>Invariant</th><th>State</th><th>Evidence</th></tr></thead><tbody>${lifecycleInvariantRows}</tbody></table></div>
        <div class="sim-table-wrap"><table><thead><tr><th>Seed</th><th>Entropy</th><th>Replay</th><th>Faults</th><th>Transitions</th></tr></thead><tbody>${lifecycleScheduleRows}</tbody></table></div>
      </section>`,
    },
    { id: "campaign", label: "Campaign", content: `<section class="sim-section" aria-labelledby="simulation-stages-title"><div class="sim-section-head"><h3 id="simulation-stages-title">Execution Stages</h3><span>${formatNumber(report.summary.receiptsPerRun)} receipts / ${formatNumber(report.summary.finalActiveAgents)} active agents</span></div><ol class="sim-stage-list">${report.stages.map((stage, index) => `<li><span>${formatNumber(index + 1)}</span><strong>${esc(stage.label)}</strong><small>${formatNumber(stage.tasks)} task${stage.tasks === 1 ? "" : "s"}</small></li>`).join("")}</ol></section>` },
    { id: "dag", label: "Dynamic DAG", badge: formatNumber(report.taskGraph?.length ?? 0), content: `<section class="sim-section" data-simulation-dag aria-labelledby="simulation-dag-title"><div class="sim-section-head"><h3 id="simulation-dag-title">Live Task Graph</h3><span>${formatNumber(report.summary.graphExpansions)} atomic expansion${report.summary.graphExpansions === 1 ? "" : "s"} · one TaskGraphControl</span></div>${expansionRows ? `<div class="sim-table-wrap"><table><thead><tr><th>Expansion</th><th>Parent</th><th>Children</th><th>Continuation</th><th>Hash</th></tr></thead><tbody>${expansionRows}</tbody></table></div>` : ""}<div class="sim-table-wrap sim-task-table"><table><thead><tr><th>Task</th><th>Node</th><th>Capability</th><th>Parent</th><th>Dependencies</th><th>State</th><th>Attempt</th></tr></thead><tbody>${taskRows}</tbody></table></div></section>` },
    { id: "mesh", label: "Worker mesh", badge: formatNumber(functionActivities.length), content: `<section class="sim-section" data-simulation-worker-mesh aria-labelledby="simulation-mesh-title"><div class="sim-section-head"><h3 id="simulation-mesh-title">Catalog-pinned Worker Activity</h3><span>${formatNumber(report.summary.catalogSearches)} search · ${formatNumber(report.summary.catalogInvocations)} pinned call</span></div><div class="sim-table-wrap"><table><thead><tr><th>Receipt</th><th>Operation</th><th>Task</th><th>Function</th><th>Provider epoch</th><th>Catalog</th></tr></thead><tbody>${activityRows || `<tr><td colspan="6">This campaign did not invoke the worker catalog.</td></tr>`}</tbody></table></div></section>` },
    { id: "topology", label: "Topology", content: `<section class="sim-section" aria-labelledby="simulation-topology-title"><div class="sim-section-head"><h3 id="simulation-topology-title">Composition Topology</h3><span>${formatNumber(report.topologies.length)} transition${report.topologies.length === 1 ? "" : "s"}</span></div><ol class="sim-topology-list">${topologyRows}</ol></section>` },
    { id: "schedules", label: "Schedules", badge: formatNumber(report.schedules.length), content: `<section class="sim-section" aria-labelledby="simulation-schedules-title"><div class="sim-section-head"><h3 id="simulation-schedules-title">Schedule Search</h3><span>Recorded entropy + exact replay · Determined graph transitions · ${formatNumber(report.summary.entropyDraws)} draws</span></div><div class="sim-table-wrap"><table><thead><tr><th>Seed</th><th>Entropy</th><th>State</th><th>Replay</th><th>Peak</th><th>Faults</th><th>Completion</th><th>Transitions</th><th>Reproduce</th></tr></thead><tbody>${scheduleRows}</tbody></table></div></section>` },
  ];

  return `<section class="sim-report" aria-labelledby="simulation-report-title" aria-live="polite">
    <script type="application/json" data-simulation-replay-data>${scriptJson(report.replayFrames)}</script>
    <section class="sim-replay-frame" data-simulation-replay-frame aria-label="Simulation replay frame">
      <div><p class="sim-kicker">Current replay frame</p><strong data-simulation-replay-label>Live campaign head</strong></div>
      <dl><div><dt>Event</dt><dd data-simulation-replay-kind>complete</dd></div><div><dt>Agents</dt><dd data-simulation-replay-agents>${report.summary.finalActiveAgents}</dd></div><div><dt>Topology</dt><dd data-simulation-replay-topology>${esc(report.topologies.at(-1)?.bracket ?? "No topology selected")}</dd></div></dl>
    </section>
    <header class="sim-report-head">
      <div><p class="sim-kicker">Campaign ${esc(report.campaignId)}</p><h2 id="simulation-report-title">${esc(report.pattern.label)}</h2><p>${esc(report.pattern.acceptance)}</p></div>
      <span class="sim-campaign-status" data-status="${report.summary.converged ? "pass" : "fail"}">${status}</span>
    </header>
    <dl class="sim-metrics">
      <div><dt>Schedules</dt><dd>${formatNumber(report.input.schedules)}</dd></div>
      <div><dt>Exact Replays</dt><dd>${formatNumber(report.summary.exactReplays)}</dd></div>
      <div><dt>Interleavings</dt><dd>${formatNumber(report.summary.scheduleVariants)}</dd></div>
      <div><dt>Fault Recoveries</dt><dd>${formatNumber(report.summary.faultRecoveries)}</dd></div>
      <div><dt>Agents</dt><dd>${formatNumber(report.summary.requestedAgents)}<small> requested</small> → ${formatNumber(report.summary.exercisedAgents)}<small> exercised</small></dd></div>
      <div><dt>Peak Parallel</dt><dd>${formatNumber(report.summary.peakParallel)}</dd></div>
      <div><dt>Duration</dt><dd>${formatNumber(report.durationMs)}<small>ms</small></dd></div>
    </dl>
    ${agentTabsHtml({
      id: "simulation-report-tabs",
      label: "Simulation report views",
      tabs: reportTabs,
    })}
  </section>`;
};

const simulationRoster = () => staticRoomRoster({
  roomId: "simulation-lab",
  summary: "Four members are ready to test a coordination policy",
  members: [
    { name: "You", role: "Experiment partner", kind: "human", presence: "present" },
    { name: "Roster", role: "Facilitator", kind: "system", presence: "present" },
    { name: "Runner", role: "Schedule search", kind: "agent", presence: "waiting" },
    { name: "Verifier", role: "Invariant checks", kind: "agent", presence: "waiting" },
  ],
});

const simulationConversationHtml = (
  initialReport: SimulationCampaignReport,
  defaults: SimulationCampaignInput,
): string => `<div class="simulation-conversation">
  ${agentReplayBarHtml({
    id: "simulation-replay-bar",
    title: "Deterministic schedule history",
    description: "Replay the exact orchestration events retained from the representative schedule.",
    content: agentReplayClientControlsHtml({ id: "simulation-replay-controls", adapter: "simulation", emptyLabel: "Loading deterministic history…" }),
  })}
  <form class="sim-controls" id="simulation-controls" action="/simulations/run" method="post" data-simulation-form aria-describedby="simulation-form-status">
    <h2>Campaign Controls</h2>
    <fieldset class="sim-patterns"><legend>Coordination Pattern</legend>${patternOptionsHtml(defaults.pattern)}</fieldset>
    <div class="sim-control-row">
      <label class="sim-field"><span>Agents</span><input type="number" inputmode="numeric" autocomplete="off" name="agents" min="2" max="128" value="${defaults.agents}" /></label>
      <label class="sim-field"><span>Max Parallel</span><input type="number" inputmode="numeric" autocomplete="off" name="maxParallel" min="1" max="32" value="${defaults.maxParallel}" /></label>
      <label class="sim-field"><span>Schedules</span><input type="number" inputmode="numeric" autocomplete="off" name="schedules" min="1" max="20" value="${defaults.schedules}" /></label>
      <label class="sim-field"><span>Base Seed</span><input type="number" inputmode="numeric" autocomplete="off" name="seed" min="0" max="4294967295" value="${defaults.seed}" /></label>
      <label class="sim-toggle"><input type="checkbox" name="injectFaults" value="1"${defaults.injectFaults ? " checked" : ""} /><span>Inject recoverable campaign and lifecycle faults</span></label>
      <button class="sim-run" type="submit"><span class="sim-idle">Run Campaign</span><span class="sim-running">Running…</span></button>
    </div>
    <p class="sim-form-status" id="simulation-form-status" role="status" aria-live="polite" aria-atomic="true"></p>
  </form>
  <div id="simulation-results" data-simulation-results>${simulationCampaignHtml(initialReport)}</div>
</div>`;

export const simulationShell = (
  initialReport: SimulationCampaignReport,
  defaults: SimulationCampaignInput,
  nonce: string
): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0c0f13" />
  ${themeBootstrapScript(nonce)}
  <title>Roster - Simulation Lab</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style nonce="${esc(nonce)}">
    :root { color-scheme:dark; --bg:#0c0f13; --panel:#11151a; --raised:#171c22; --line:#2a3139; --ink:#eef2f5; --muted:#929daa; --blue:#64b5f6; --green:#57d58a; --amber:#f2bc5a; --red:#ef6b73; }
    * { box-sizing:border-box; }
    body { margin:0; min-width:320px; min-height:100vh; background:var(--bg); color:var(--ink); font-family:"Space Grotesk",system-ui,sans-serif; overflow-x:hidden; }
    button,input,select { font:inherit; touch-action:manipulation; }
    button:focus-visible,input:focus-visible,a:focus-visible { outline:2px solid var(--blue); outline-offset:3px; }
    h1,h2,h3 { text-wrap:balance; letter-spacing:0; }
    code,.mono { font-family:"IBM Plex Mono",ui-monospace,monospace; }
    .skip-link { position:fixed; z-index:10; top:8px; left:8px; padding:7px 10px; border-radius:4px; color:var(--ink); background:var(--raised); transform:translateY(-160%); }
    .skip-link:focus-visible { transform:translateY(0); }
    .simulation-conversation { width:min(100%,1100px); display:grid; gap:16px; margin:0 auto; }
    .sim-controls { display:grid; gap:16px; padding:20px 0; border-bottom:1px solid var(--line); }
    .sim-controls h2 { margin:0; font-size:15px; }
    .sim-patterns { min-width:0; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:6px; padding:0; margin:0; border:0; }
    .sim-patterns legend { margin-bottom:8px; color:var(--muted); font:700 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.08em; }
    .sim-pattern-option { min-width:0; position:relative; cursor:pointer; }
    .sim-pattern-option input { position:absolute; width:1px; height:1px; opacity:0; }
    .sim-pattern-option>span { min-height:68px; display:grid; align-content:center; gap:5px; padding:9px 11px; border:1px solid var(--line); border-radius:5px; background:var(--panel); }
    .sim-pattern-option strong { font-size:12px; }
    .sim-pattern-option small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font:9px/1.3 "IBM Plex Mono",monospace; }
    .sim-pattern-option:hover>span { border-color:#46515e; background:var(--raised); }
    .sim-pattern-option input:checked+span { border-color:color-mix(in srgb,var(--blue) 55%,var(--line)); box-shadow:inset 0 -3px 0 var(--blue); background:color-mix(in srgb,var(--blue) 8%,var(--panel)); }
    .sim-pattern-option input:focus-visible+span { outline:2px solid var(--blue); outline-offset:3px; }
    .sim-control-row { display:grid; grid-template-columns:repeat(4,minmax(100px,150px)) minmax(180px,1fr) auto; align-items:end; gap:10px; }
    .sim-field { display:grid; gap:5px; color:var(--muted); font:700 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.06em; }
    .sim-field input[type="number"] { width:100%; height:38px; padding:7px 9px; border:1px solid var(--line); border-radius:5px; color:var(--ink); background:#101419; }
    .sim-toggle { min-height:38px; display:flex; align-items:center; gap:9px; padding:0 4px; color:var(--ink); font-size:11px; cursor:pointer; }
    .sim-toggle input { width:16px; height:16px; accent-color:var(--blue); }
    .sim-run { min-height:38px; min-width:145px; border:1px solid var(--action-primary); border-radius:var(--radius-control); padding:8px 14px; color:var(--action-primary-foreground); background:var(--action-primary); font-weight:700; cursor:pointer; }
    .sim-run:hover { border-color:var(--action-primary-hover); background:var(--action-primary-hover); }
    .sim-run:disabled { opacity:.62; cursor:wait; }
    .sim-running { display:none; }
    .sim-controls[data-state="running"] .sim-idle { display:none; }
    .sim-controls[data-state="running"] .sim-running { display:inline; }
    .sim-form-status { min-height:16px; margin:0; color:var(--muted); font:9px/1.4 "IBM Plex Mono",monospace; }
    .sim-form-status[data-tone="error"] { color:var(--red); }
    .sim-form-status[data-tone="success"] { color:var(--green); }
    .sim-report { display:grid; gap:0; padding-top:22px; }
    .sim-replay-frame { min-width:0; display:grid; grid-template-columns:minmax(180px,.35fr) minmax(0,1fr); align-items:center; gap:16px; margin-bottom:16px; padding:12px 14px; border:1px solid var(--line); border-radius:var(--radius-md); background:var(--panel); }
    .sim-replay-frame strong { display:block; margin-top:4px; font-size:11px; overflow-wrap:anywhere; }.sim-replay-frame dl { min-width:0; display:grid; grid-template-columns:minmax(90px,.25fr) minmax(80px,.2fr) minmax(0,1fr); gap:8px; margin:0; }.sim-replay-frame dl>div{min-width:0;padding:7px 9px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--bg)}.sim-replay-frame dt{color:var(--muted);font:700 8px/1.2 "IBM Plex Mono",monospace;text-transform:uppercase}.sim-replay-frame dd{margin:4px 0 0;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sim-report-head { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding-bottom:16px; }
    .sim-report-head h2 { margin:2px 0 0; font-size:20px; }
    .sim-report-head p:not(.sim-kicker) { margin:5px 0 0; color:var(--muted); font-size:11px; }
    .sim-kicker { margin:0; color:var(--muted); font:9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.06em; }
    .sim-campaign-status { padding:6px 9px; border:1px solid var(--line); border-radius:4px; font:700 10px/1 "IBM Plex Mono",monospace; text-transform:uppercase; }
    [data-status="pass"] { color:var(--green); }
    [data-status="fail"] { color:var(--red); }
    .sim-metrics { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); margin:0; border:1px solid var(--line); border-radius:6px; overflow:hidden; background:var(--panel); }
    .sim-metrics div { min-width:0; padding:11px 12px; border-right:1px solid var(--line); }
    .sim-metrics div:last-child { border-right:0; }
    .sim-metrics dt { color:var(--muted); font:700 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; }
    .sim-metrics dd { margin:6px 0 0; font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }
    .sim-metrics dd small { margin-left:2px; color:var(--muted); font-size:10px; }
    .sim-section { min-width:0; padding:18px 0; border-bottom:1px solid var(--line); }
    .sim-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:18px; margin-bottom:11px; }
    .sim-section-head h3 { margin:0; font-size:13px; }
    .sim-section-head span { color:var(--muted); font:9px/1.2 "IBM Plex Mono",monospace; }
    .sim-stage-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1px; padding:0; margin:0; list-style:none; background:var(--line); border:1px solid var(--line); border-radius:5px; overflow:hidden; }
    .sim-stage-list li { min-width:0; display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; gap:3px 9px; padding:10px 11px; background:var(--panel); }
    .sim-stage-list li>span { grid-row:1/3; width:24px; height:24px; display:grid; place-items:center; border:1px solid var(--line); border-radius:50%; color:var(--amber); font:700 9px/1 "IBM Plex Mono",monospace; }
    .sim-stage-list strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
    .sim-stage-list small { color:var(--muted); font:9px/1.2 "IBM Plex Mono",monospace; }
    .sim-topology-list { display:grid; gap:5px; padding:0; margin:0; list-style:none; }
    .sim-topology-list li { min-width:0; display:grid; grid-template-columns:74px 42px minmax(0,1fr) minmax(160px,.65fr); align-items:center; gap:9px; padding:8px 10px; border:1px solid var(--line); border-radius:4px; background:var(--panel); }
    .sim-operation { color:var(--blue); font:700 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; }
    .sim-k { color:var(--green); font:700 11px/1 "IBM Plex Mono",monospace; }
    .sim-topology-list code { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d8dee4; font-size:9px; }
    .sim-topology-list small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-size:9px; }
    .sim-table-wrap { overflow:auto; border:1px solid var(--line); border-radius:5px; }
    .sim-task-table { margin-top:10px; }
    .sim-command { display:block; max-width:420px; overflow:hidden; text-overflow:ellipsis; }
    table { width:100%; border-collapse:collapse; font-size:10px; font-variant-numeric:tabular-nums; }
    th,td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
    th { color:var(--muted); background:var(--panel); font:700 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; }
    tbody tr:last-child td { border-bottom:0; }
    tbody tr:hover { background:var(--panel); }
    .sim-verdict { font-weight:700; text-transform:uppercase; }
    ${agentShellCss()}
    .simulation-app .agent-conversation-feed { padding:16px clamp(18px,3.5vw,48px) 36px; }
    .simulation-app .agent-conversation-body { grid-template-rows:minmax(0,1fr); }
    .agent-app .sim-controls { padding:16px; border:1px solid var(--line); border-radius:var(--radius-md); background:var(--panel); }
    .agent-app .sim-report { padding-top:18px; }
    @media(max-width:900px){.sim-patterns{grid-template-columns:repeat(2,minmax(0,1fr))}.sim-control-row{grid-template-columns:repeat(2,minmax(0,1fr))}.sim-toggle,.sim-run{grid-column:1/-1}.sim-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.sim-metrics div:nth-child(3){border-right:0}.sim-topology-list li{grid-template-columns:70px 38px minmax(0,1fr)}.sim-topology-list small{grid-column:3}.sim-replay-frame{grid-template-columns:1fr}}
    @media(max-width:560px){.sim-patterns,.sim-control-row{grid-template-columns:1fr}.sim-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.sim-metrics div:nth-child(3){border-right:1px solid var(--line)}.sim-metrics div:nth-child(2n){border-right:0}}
    @media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto !important; } }
  </style>
</head>
<body>
  ${agentShellFrameHtml({
    skipHref: "#simulation-controls",
    skipLabel: "Skip to simulation controls",
    chromeHtml: agentTopNavHtml({ active: "simulations", statusLabel: "Simulation lab ready" }),
    mainHtml: agentWorkspaceShellHtml({
      id: "simulation-lab-workspace",
      room: {
        eyebrow: "Testing room",
        title: "#simulation-lab",
        description: "A continuing room for exploring schedules, injecting bounded failures, and discussing whether coordination still converges.",
        state: "open",
        roster: simulationRoster(),
      },
      conversation: simulationConversationHtml(initialReport, defaults),
      context: `<section class="agent-architecture-panel"><header class="agent-architecture-head"><div><p>System tool</p><h2>Simulation boundaries</h2></div><span>Deterministic</span></header><p class="agent-architecture-summary">Campaigns search bounded schedules, inject declared faults, and verify exact receipt replay without changing room, node, or runtime identity.</p></section>`,
      contextLabel: "Simulation boundaries",
      artifact: "Deterministic campaign report",
      acceptance: "Every searched schedule converges and the representative receipt stream replays exactly",
      coordinationLabel: "bounded schedule search",
      railActionsHtml: `<a href="/simulations">New Campaign</a>`,
    }),
    mainId: "main-content",
    appClass: "agent-unified-page simulation-app",
  })}
  <script nonce="${esc(nonce)}">
    (()=>{
      const root=document.getElementById("simulation-replay-controls");
      const form=document.querySelector("[data-simulation-form]");
      const results=document.querySelector("[data-simulation-results]");
      const status=document.getElementById("simulation-form-status");
      if(!root||!form||!results||!status)return;
      let frames=[];let position=null;let playing=false;let delay=700;let timer=0;let initial=true;
      const stop=()=>{playing=false;clearTimeout(timer);timer=0;};
      const readFrames=()=>{stop();const node=results.querySelector("[data-simulation-replay-data]");try{frames=JSON.parse(node?.textContent||"[]");}catch(_error){frames=[];}if(initial){const value=new URL(location.href).searchParams.get("at");if(value!==null){const parsed=Number(value);if(Number.isFinite(parsed))position=Math.max(0,Math.min(Math.floor(parsed),frames.length));}initial=false;render(false);}else{position=null;render();}};
      const button=(action)=>root.querySelector('[data-replay-action="'+action+'"]');
      const current=()=>position===null?frames.length:Math.max(0,Math.min(position,frames.length));
      const updateUrl=()=>{const url=new URL(location.href);if(position===null||position>=frames.length)url.searchParams.delete("at");else url.searchParams.set("at",String(position));history.replaceState(history.state,"",url);};
      const render=(writeUrl=true)=>{const at=current();if(position!==null&&at>=frames.length)position=null;root.dataset.current=String(current());root.dataset.maximum=String(frames.length);const start=button("start"),previous=button("previous"),play=button("play"),next=button("next"),live=button("live");if(start)start.disabled=!frames.length||current()<=0;if(previous)previous.disabled=!frames.length||current()<=0;if(next)next.disabled=!frames.length||current()>=frames.length;if(live)live.disabled=!frames.length||position===null;if(play){play.disabled=!frames.length;play.textContent=playing?"Pause":"Play";play.setAttribute("aria-pressed",String(playing));}const slider=root.querySelector("[data-replay-scrub]");if(slider){slider.disabled=!frames.length;slider.max=String(frames.length);slider.value=String(current());slider.setAttribute("aria-valuetext",position===null?"Live simulation head":"Replay event "+current()+" of "+frames.length);}const speed=root.querySelector("[data-replay-speed]");if(speed){speed.disabled=!frames.length;speed.value=String(delay);}const frame=current()>0?frames[current()-1]:null;const output=root.querySelector("output");if(output)output.textContent=!frames.length?"No replay events":position===null?"Live "+frames.length+"/"+frames.length:"Replay "+current()+"/"+frames.length+" · "+(frame?.kind||"start");const card=results.querySelector("[data-simulation-replay-frame]");if(card){card.querySelector("[data-simulation-replay-label]").textContent=frame?.label||"Before orchestration started";card.querySelector("[data-simulation-replay-kind]").textContent=frame?.kind||"start";card.querySelector("[data-simulation-replay-agents]").textContent=frame?frame.activeAgents+" / "+frame.totalAgents:"0";card.querySelector("[data-simulation-replay-topology]").textContent=frame?.topology||"No topology selected";}if(writeUrl)updateUrl();};
      const set=(next)=>{position=next>=frames.length?null:Math.max(0,next);render();};
      const schedule=()=>{clearTimeout(timer);if(!playing)return;timer=setTimeout(()=>{if(current()>=frames.length){stop();render();return;}set(current()+1);if(position===null)stop();render();if(playing)schedule();},delay);};
      root.addEventListener("click",(event)=>{const target=event.target.closest?.("[data-replay-action]");if(!target||target.disabled)return;const action=target.dataset.replayAction;if(action==="play"){if(playing){stop();render();return;}if(current()>=frames.length)set(0);playing=true;render();schedule();return;}stop();if(action==="start")set(0);else if(action==="previous")set(current()-1);else if(action==="next")set(current()+1);else if(action==="live")set(frames.length);});
      root.addEventListener("input",(event)=>{if(!event.target.matches?.("[data-replay-scrub]"))return;stop();set(Number(event.target.value));});
      root.addEventListener("change",(event)=>{if(!event.target.matches?.("[data-replay-speed]"))return;delay=Number(event.target.value)||700;if(playing)schedule();});
      form.addEventListener("submit",async(event)=>{event.preventDefault();if(form.dataset.state==="running")return;form.dataset.state="running";form.setAttribute("aria-busy","true");results.setAttribute("aria-busy","true");const submit=form.querySelector('[type="submit"]');if(submit)submit.disabled=true;status.dataset.tone="";status.textContent="Running deterministic campaign…";try{const response=await fetch(form.action,{method:"POST",headers:{Accept:"application/json","Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:new URLSearchParams(new FormData(form)),credentials:"same-origin"});const contentType=response.headers.get("content-type")||"";const payload=contentType.includes("application/json")?await response.json():{error:await response.text()};if(!response.ok||payload.ok!==true||typeof payload.html!=="string")throw new Error(typeof payload.error==="string"&&payload.error?payload.error:"The campaign could not be completed.");results.innerHTML=payload.html;readFrames();status.dataset.tone="success";status.textContent="Campaign "+payload.campaignId+" completed and is ready to replay.";}catch(error){status.dataset.tone="error";status.textContent=error instanceof Error?error.message:"The campaign could not be completed.";}finally{delete form.dataset.state;form.removeAttribute("aria-busy");results.removeAttribute("aria-busy");if(submit)submit.disabled=false;}});
      document.addEventListener("visibilitychange",()=>{if(document.hidden){stop();render();}});readFrames();
    })();
  </script>
  ${agentTabsScript(nonce)}
</body>
</html>`;
