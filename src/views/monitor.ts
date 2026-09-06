import {
  COMMAND_RUN_AGENT_IDS,
  getAgentArchitecture,
  getAgentCoordinationPattern,
  getAgentDescription,
  getAgentDisplayName,
} from "../agents/agent-display.js";
import {
  coordinationArchitectures,
  coordinationExamples,
  examplesForArchitecture,
  getCoordinationAgentDefinition,
} from "../engine/orchestration/architecture-catalog.js";
import { esc } from "./agent-framework.js";
import { themeBootstrapScript } from "./theme.js";
import {
  agentComposerHtml,
  agentPageHeaderHtml,
  agentReplayBarHtml,
  agentReplayClientControlsHtml,
  agentShellCss,
  agentSidebarHtml,
  agentTabsHtml,
  agentTabsScript,
} from "./agent-shell.js";

export type MonitorRealtimeBootConfig = {
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

export type MonitorShellOptions = {
  readonly stream: string;
  readonly selectedJobId?: string;
  readonly nonce: string;
  readonly realtime?: MonitorRealtimeBootConfig;
  readonly improvementAudit?: MonitorImprovementAudit;
};

export type MonitorImprovementAudit = {
  readonly generationId: string;
  readonly activeCount: number;
  readonly proposals: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly artifactType: string;
    readonly target: string;
    readonly source: string;
    readonly transitionCount: number;
    readonly observationCount: number;
    readonly updatedAt: number;
  }>;
};

const scriptJson = (value: unknown): string => JSON.stringify(value)
  .replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

const agentOptions = (): string => COMMAND_RUN_AGENT_IDS.map((agentId) => {
  const definition = getCoordinationAgentDefinition(agentId);
  const roomName = definition?.roomName ?? `#${getAgentDisplayName(agentId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
  return `<option value="${esc(agentId)}"${agentId === "theorem" ? " selected" : ""}>${esc(roomName)} · ${esc(getAgentDisplayName(agentId))} — ${esc(getAgentArchitecture(agentId)?.name ?? getAgentCoordinationPattern(agentId))}</option>`;
}).join("");

const coordinationGuide = (): string => COMMAND_RUN_AGENT_IDS.map((agentId) =>
  `<article><div><strong>${esc(getAgentDisplayName(agentId))}</strong><span>${esc(getAgentCoordinationPattern(agentId))}</span></div><p>${esc(getAgentDescription(agentId))}</p></article>`).join("");

const autonomousImprovementAuditHtml = (audit?: MonitorImprovementAudit): string => `<section class="autonomous-improvement-audit" aria-labelledby="autonomous-improvement-title">
  <header><div><p class="catalog-kicker">Autonomous runtime</p><h2 id="autonomous-improvement-title">Self-improvement audit</h2><p>Coding nodes may propose bounded framework changes. Independent deterministic policies verify, canary, promote, monitor, and roll them back without an operator workflow.</p></div><span>${audit?.activeCount ?? 0} active</span></header>
  <div class="improvement-generation"><span>Generation</span><code>${esc(audit?.generationId ?? "unavailable")}</code></div>
  ${audit?.proposals.length ? `<ol>${audit.proposals.map((proposal) => `<li data-status="${esc(proposal.status)}"><div><strong>${esc(proposal.target)}</strong><span>${esc(proposal.artifactType.replace(/_/g, " "))}</span></div><code class="improvement-proposal-id">${esc(proposal.id)}</code><p>${esc(proposal.source)} · ${proposal.transitionCount} transitions · ${proposal.observationCount} monitored runs</p><footer><span>${esc(proposal.status.replace(/-/g, " "))}</span><time datetime="${new Date(proposal.updatedAt).toISOString()}">${esc(new Date(proposal.updatedAt).toLocaleString())}</time></footer></li>`).join("")}</ol>` : `<p class="catalog-empty">No autonomous framework candidates have been admitted yet.</p>`}
</section>`;

export const architectureCatalogHtml = (audit?: MonitorImprovementAudit): string => `<section class="architecture-catalog" aria-labelledby="architecture-catalog-title">
  ${autonomousImprovementAuditHtml(audit)}
  <header class="catalog-intro"><p class="catalog-kicker">Extension registry</p><h2 id="architecture-catalog-title">Coordination architectures</h2><p>Every example declares one reusable execution architecture plus domain-specific artifact and acceptance extensions.</p></header>
  <div class="architecture-grid">
    ${coordinationArchitectures().map((architecture) => {
      const examples = examplesForArchitecture(architecture.id);
      return `<article class="architecture-card" data-architecture="${esc(architecture.id)}">
        <header><div><span class="architecture-id">${esc(architecture.id)}</span><h3>${esc(architecture.name)}</h3></div><span class="topology-pill">${esc(architecture.topology)}</span></header>
        <p class="architecture-summary">${esc(architecture.summary)}</p>
        <dl class="architecture-contract">
          <div><dt>Runtime adapter</dt><dd>${esc(architecture.runtimeAdapter)}</dd></div>
          <div><dt>Population</dt><dd>${esc(architecture.population)}</dd></div>
          <div><dt>Composition</dt><dd>${esc(architecture.composition)}</dd></div>
          <div><dt>Acceptance</dt><dd>${esc(architecture.acceptance)}</dd></div>
        </dl>
        <section class="architecture-examples" aria-label="${esc(architecture.name)} rooms">
          <h4>Rooms using this architecture</h4>
          ${examples.length > 0 ? `<ul>${examples.map((example) => `<li><div><strong>${esc(example.roomName ?? example.name)}</strong><span>${esc(example.coordinationLabel)}</span></div><p>${esc(example.description)}</p><footer><span>${esc(example.artifact)}</span><a href="${esc(example.routePath ?? "/monitor")}">Open room<span class="sr-only"> ${esc(example.name)}</span></a></footer></li>`).join("")}</ul>` : `<p class="catalog-empty">Used by worker primitives; no standalone room.</p>`}
        </section>
      </article>`;
    }).join("")}
  </div>
</section>`;

const monitorCss = (): string => `
  ${agentShellCss()}
  :root{--agent-accent:#79e3bf;--agent-accent-soft:rgba(121,227,191,.11)}
  .agent-main{width:min(100%,1560px)}
  .chip{display:inline-flex;align-items:center;min-height:30px;padding:6px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--panel);font:9px/1 ui-monospace,monospace}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .panel{min-width:0;border:1px solid var(--line);border-radius:var(--radius-md);padding:14px;background:var(--panel)}
  .history-stack{display:grid;gap:14px}.history-stack>.agent-replay{margin:0}
  .panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}.panel-head h2{margin:0;font-size:13px}.panel-head p{margin:4px 0 0;color:var(--muted);font-size:10px;line-height:1.5}
  .overview-grid{display:grid;grid-template-columns:minmax(290px,.68fr) minmax(480px,1.32fr);gap:14px}
  .room-lobby{display:grid;gap:14px}.room-directory{display:grid;gap:11px}.room-directory>header{display:flex;align-items:end;justify-content:space-between;gap:18px}.room-directory>header h2{margin:0;font-size:16px}.room-directory>header p{max-width:680px;margin:4px 0 0;color:var(--muted);font-size:10px;line-height:1.5}.room-directory>header>span{color:var(--agent-accent);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.room-directory-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.room-directory-card{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px;border:1px solid var(--line);border-radius:var(--radius-md);color:inherit;background:var(--panel);text-decoration:none}.room-directory-card:hover{border-color:color-mix(in srgb,var(--agent-accent) 44%,var(--line));background:var(--panel-2)}.room-directory-copy{min-width:0}.room-directory-copy strong,.room-directory-copy span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.room-directory-copy strong{font-size:11px}.room-directory-copy span{margin-top:3px;color:var(--muted);font-size:8px}.room-directory-open{color:var(--faint);font-size:15px}.room-directory-card:focus-visible{outline:2px solid var(--agent-accent);outline-offset:3px}
  .room-directory-card{grid-template-columns:34px minmax(0,1fr) auto}.room-directory-mark{width:34px;height:34px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--agent-accent) 35%,var(--line));border-radius:50%;color:var(--agent-accent);background:var(--agent-accent-soft);font-size:11px;font-weight:850}
  .jobs-toolbar label,.memory-toolbar label,.command-form label{display:grid;gap:5px;color:var(--muted);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em}
  select,input,textarea{width:100%;min-width:0;border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 9px;color:var(--ink);background:var(--raised);font-size:11px}
  button{border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 10px;color:var(--ink);background:var(--raised);cursor:pointer;font-size:10px;font-weight:700}button:hover{border-color:color-mix(in srgb,var(--agent-accent) 48%,var(--line))}
  .primary{border-color:color-mix(in srgb,var(--agent-accent) 48%,var(--line));color:var(--agent-accent);background:var(--agent-accent-soft)}
  .dispatch-guide{display:grid;gap:7px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft)}.dispatch-guide article{padding:9px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:rgba(255,255,255,.018)}.dispatch-guide article>div{display:flex;align-items:center;justify-content:space-between;gap:8px}.dispatch-guide strong{font-size:10px}.dispatch-guide span{color:var(--agent-accent);font:8px/1 ui-monospace,monospace}.dispatch-guide p{margin:5px 0 0;color:var(--muted);font-size:9px;line-height:1.45}
  .architecture-catalog{display:grid;gap:14px}.catalog-intro{max-width:760px}.catalog-intro h2{margin:3px 0 6px;font-size:17px}.catalog-intro>p:last-child{margin:0;color:var(--muted);font-size:10px;line-height:1.55}.catalog-kicker{margin:0;color:var(--agent-accent);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}.architecture-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.architecture-card{min-width:0;display:grid;align-content:start;gap:11px;padding:13px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--panel)}.architecture-card>header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.architecture-card h3{margin:4px 0 0;font-size:13px}.architecture-id{color:var(--agent-accent);font:800 8px/1 ui-monospace,monospace}.topology-pill{padding:4px 7px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase}.architecture-summary{margin:0;color:var(--muted);font-size:10px;line-height:1.5}.architecture-contract{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0}.architecture-contract div{display:grid;gap:3px;padding:7px;border:1px solid var(--line-soft);border-radius:6px}.architecture-contract dt{color:var(--faint);font:800 7px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em}.architecture-contract dd{margin:0;color:var(--muted);font-size:9px;line-height:1.35}.architecture-examples{display:grid;gap:7px;padding-top:2px}.architecture-examples h4{margin:0;color:var(--faint);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.architecture-examples ul{display:grid;gap:6px;margin:0;padding:0;list-style:none}.architecture-examples li{display:grid;gap:5px;padding:8px;border:1px solid var(--line-soft);border-radius:7px;background:rgba(255,255,255,.018)}.architecture-examples li>div,.architecture-examples footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.architecture-examples strong{font-size:10px}.architecture-examples li>div span{color:var(--agent-accent);font:8px/1 ui-monospace,monospace}.architecture-examples li p{margin:0;color:var(--muted);font-size:9px;line-height:1.45}.architecture-examples footer{color:var(--faint);font-size:8px}.architecture-examples a{color:var(--agent-accent);font-weight:800;text-decoration:none}.architecture-examples a:hover{text-decoration:underline}.architecture-examples a:focus-visible{outline:2px solid var(--agent-accent);outline-offset:3px;border-radius:2px}.catalog-empty{margin:0;padding:10px;border:1px dashed var(--line);border-radius:7px;color:var(--muted);font-size:9px}
  .autonomous-improvement-audit{display:grid;gap:10px;padding:13px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--panel)}.autonomous-improvement-audit>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.autonomous-improvement-audit h2{margin:4px 0 5px;font-size:15px}.autonomous-improvement-audit header p:last-child{max-width:760px;margin:0;color:var(--muted);font-size:9px;line-height:1.5}.autonomous-improvement-audit>header>span{padding:5px 8px;border:1px solid var(--line);border-radius:999px;color:var(--agent-accent);font:800 8px/1 ui-monospace,monospace}.improvement-generation{display:flex;align-items:center;gap:8px;color:var(--faint);font-size:8px}.improvement-generation code{color:var(--muted)}.autonomous-improvement-audit ol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:0;padding:0;list-style:none}.autonomous-improvement-audit li{display:grid;gap:6px;padding:9px;border:1px solid var(--line-soft);border-radius:7px;background:rgba(255,255,255,.018)}.autonomous-improvement-audit li>div,.autonomous-improvement-audit li>footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.autonomous-improvement-audit li strong{font-size:10px}.autonomous-improvement-audit li span,.autonomous-improvement-audit li time{color:var(--faint);font:8px/1 ui-monospace,monospace;text-transform:uppercase}.autonomous-improvement-audit li p{margin:0;color:var(--muted);font-size:9px}.improvement-proposal-id{overflow:hidden;color:var(--faint);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.autonomous-improvement-audit li[data-status="promoted"] footer span{color:var(--green)}.autonomous-improvement-audit li[data-status="rejected"] footer span,.autonomous-improvement-audit li[data-status="rollback-forward"] footer span{color:var(--red)}
  .agents-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.agent-card{display:grid;gap:6px;padding:10px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:rgba(255,255,255,.018)}.agent-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.agent-card-head strong{font-size:11px}.agent-pattern{color:var(--agent-accent);font:8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.agent-card p{margin:0;color:var(--muted);font-size:9px;line-height:1.45}.agent-card footer{display:flex;justify-content:space-between;gap:8px;color:var(--faint);font-size:8px}
  .status-pill{display:inline-flex;align-items:center;min-height:22px;padding:4px 7px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em}.status-queued{color:var(--blue)}.status-leased,.status-running{color:var(--amber)}.status-completed{color:var(--green)}.status-failed,.status-canceled{color:var(--red)}
  .jobs-toolbar{display:grid;grid-template-columns:minmax(140px,.6fr) 90px auto auto 1fr;gap:8px;align-items:end;margin-bottom:12px}.jobs-toolbar-note{align-self:center;justify-self:end;color:var(--muted);font-size:9px}.danger{color:var(--red);border-color:color-mix(in srgb,var(--red) 40%,var(--line))}
  .jobs-wrap{display:grid;gap:10px}.jobs-meta{display:flex;flex-wrap:wrap;gap:6px}.table-wrap{overflow:auto;border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.jobs-table{width:100%;min-width:850px;border-collapse:collapse;font-size:10px}.jobs-table th{padding:7px;text-align:left;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.07em;background:var(--panel-2)}.jobs-table td{padding:7px;border-top:1px solid var(--line-soft);vertical-align:middle}.job-row.is-selected td{background:var(--agent-accent-soft)}.job-select{width:100%;padding:5px 7px;text-align:left}.empty-cell{padding:24px!important;text-align:center;color:var(--muted)}
  .activity-list,.memory-list,.command-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}.activity-list{max-height:620px;overflow:auto}.activity-list li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;padding:8px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);font-size:10px}.activity-list time,.memory-list time{color:var(--faint);font:8px/1.4 ui-monospace,monospace}.activity-list strong{color:var(--agent-accent)}
  .memory-toolbar{display:grid;grid-template-columns:minmax(160px,.6fr) minmax(220px,1fr) auto;gap:8px;align-items:end;margin-bottom:12px}.memory-list li{padding:9px;border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.memory-list p{margin:4px 0 6px;color:var(--muted);font-size:10px;line-height:1.5}.memory-tag{display:inline-flex;margin-right:4px;padding:2px 6px;border:1px solid color-mix(in srgb,var(--agent-accent) 35%,var(--line));border-radius:999px;color:var(--agent-accent);font-size:8px}
  .empty{padding:22px;color:var(--muted);font-size:10px;text-align:center}.skeleton{min-height:120px;display:grid;place-items:center;color:var(--muted);font-size:10px}
  #monitor-replay-stack{display:grid;gap:10px}.replay-frame{display:grid;gap:9px;padding-top:9px;border-top:1px solid var(--line-soft)}.replay-frame-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.replay-frame-head>div{min-width:0;display:grid;gap:3px}.replay-frame-head strong{font-size:10px}.replay-frame-head .mono{overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:8px}.replay-stages{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}.replay-stages span{padding:6px;border:1px solid var(--line-soft);border-radius:6px;color:var(--faint);font:8px/1 ui-monospace,monospace;text-align:center;text-transform:uppercase}.replay-stages .done{color:var(--green);border-color:color-mix(in srgb,var(--green) 35%,var(--line))}.replay-stages .current{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 40%,var(--line))}.replay-frame details{border-top:1px solid var(--line-soft)}.replay-frame summary{padding:8px 0;color:var(--muted);cursor:pointer;font-size:9px}.replay-inspector{display:grid;grid-template-columns:minmax(200px,.55fr) minmax(360px,1.45fr);gap:10px}.replay-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.replay-facts span{display:grid;gap:3px;padding:7px;border:1px solid var(--line-soft);border-radius:6px}.replay-facts small{color:var(--faint);font-size:8px}.replay-facts strong{overflow-wrap:anywhere;font-size:9px}.replay-event-list{display:grid;gap:5px;max-height:210px;overflow:auto}.replay-event{display:grid;grid-template-columns:34px 130px minmax(0,1fr) auto;gap:7px;align-items:center;padding:7px;text-align:left}.replay-event>span,.replay-event time{color:var(--faint);font:8px/1 ui-monospace,monospace}.replay-event strong{color:var(--agent-accent);font:8px/1 ui-monospace,monospace}.replay-event small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:8px}.replay-event.future{opacity:.36}.replay-event.active{border-color:var(--agent-accent);background:var(--agent-accent-soft)}
  .drawer{position:fixed;z-index:60;inset:0;pointer-events:none}.drawer-backdrop{position:absolute;inset:0;width:100%;border:0;border-radius:0;background:rgba(0,0,0,.62);opacity:0}.drawer-panel{position:absolute;inset:0 0 0 auto;width:min(540px,94vw);display:grid;grid-template-rows:auto minmax(0,1fr);border-left:1px solid var(--line);background:var(--bg);transform:translateX(100%);transition:transform .18s ease}.drawer.is-open{pointer-events:auto}.drawer.is-open .drawer-backdrop{opacity:1}.drawer.is-open .drawer-panel{transform:none}.drawer-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid var(--line)}.drawer-head h2{margin:0;font-size:12px}.drawer-body{overflow:auto;padding:14px}.job-detail{display:grid;gap:12px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.detail-card{min-width:0;display:grid;gap:4px;padding:8px;border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.detail-card>span{color:var(--faint);font-size:8px;text-transform:uppercase}.detail-card>strong{overflow-wrap:anywhere;font-size:9px}.span-2{grid-column:1/-1}.job-detail details{border:1px solid var(--line-soft);border-radius:var(--radius-sm)}.job-detail summary{padding:9px;cursor:pointer;font-size:9px}.job-detail pre{max-height:300px;overflow:auto;margin:0;padding:10px;border-top:1px solid var(--line-soft);color:var(--muted);background:var(--panel);font-size:9px;white-space:pre-wrap}.job-detail h3{font-size:10px}.command-list li{display:flex;gap:8px;padding:7px;border:1px solid var(--line-soft);border-radius:6px;color:var(--muted);font-size:9px}.command-list code{color:var(--agent-accent)}.command-form{display:grid;gap:8px;padding:10px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--panel)}.command-form>strong{font-size:10px}.command-form textarea{min-height:58px;resize:vertical}.danger-form{border-color:color-mix(in srgb,var(--red) 30%,var(--line))}.command-status{min-height:18px;color:var(--muted);font-size:9px}
  @media(max-width:1120px){.overview-grid{grid-template-columns:1fr}.room-directory-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.architecture-grid{grid-template-columns:1fr}.jobs-toolbar{grid-template-columns:1fr 90px auto auto}.jobs-toolbar-note{grid-column:1/-1;justify-self:start}.replay-inspector{grid-template-columns:1fr}}
  @media(max-width:720px){.room-directory-grid{grid-template-columns:1fr}.room-directory>header{align-items:flex-start;flex-direction:column}.agents-grid{grid-template-columns:1fr}.architecture-contract{grid-template-columns:1fr}.jobs-toolbar,.memory-toolbar{grid-template-columns:1fr}.jobs-toolbar-note{grid-column:auto}.replay-event{grid-template-columns:30px minmax(0,1fr) auto}.replay-event small{display:none}.detail-grid{grid-template-columns:1fr}.span-2{grid-column:auto}}
  @media(prefers-reduced-motion:reduce){.drawer-panel{transition:none}}
`;

const roomDirectoryHtml = (): string => `<section class="room-directory" aria-labelledby="room-directory-title">
  <header><div><h2 id="room-directory-title">Your rooms</h2><p>Each room keeps its people, conversation, domain artifact, and run history together. Open one to continue where the team left off.</p></div><span>${coordinationExamples().length} open rooms</span></header>
  <div class="room-directory-grid">${coordinationExamples().map((example) => `<a class="room-directory-card" href="${esc(example.routePath ?? "/monitor")}"><span class="room-directory-mark" aria-hidden="true">${esc((example.roomName ?? example.name).replace(/^#/, "").slice(0, 1).toUpperCase())}</span><span class="room-directory-copy"><strong>${esc(example.roomName ?? `#${example.navigationId ?? example.agentId}`)}</strong><span>${esc(example.name)} · ${esc(example.navigationSummary ?? example.coordinationLabel)}</span></span><span class="room-directory-open" aria-hidden="true">›</span></a>`).join("")}</div>
</section>`;

const overviewHtml = (stream: string): string => `<div class="room-lobby">${roomDirectoryHtml()}<div class="overview-grid">
  <section class="panel"><header class="panel-head"><div><h2>Start something new</h2><p>Choose a room and send its first message. Roster creates the bounded run behind the conversation.</p></div></header>
    ${agentComposerHtml({ id: "monitor-dispatch", title: "Open a room", description: "The message opens the selected durable room.", action: `/monitor/run?stream=${encodeURIComponent(stream)}`, inputName: "problem", inputLabel: "First message", placeholder: "Talk with the team about an outcome, question, or idea…", submitLabel: "Open room and send", toolsHtml: `<label class="agent-composer-select"><span class="sr-only">Room</span><select name="agentId" aria-label="Room">${agentOptions()}</select></label>` })}
    <details class="dispatch-guide"><summary>Compare coordination patterns</summary>${coordinationGuide()}</details>
  </section>
  <section class="panel"><header class="panel-head"><div><h2>Who’s available</h2><p>Teams ready to join a room, plus anyone already working together.</p></div></header><div id="monitor-agents" class="agents-grid skeleton" aria-live="polite">Gathering the roster…</div></section>
</div></div>`;

const queueHtml = (): string => `<section class="panel"><header class="panel-head"><div><h2>Durable queue</h2><p>Transactional jobs, fenced leases, and retry-safe commands.</p></div></header>
  <div class="jobs-toolbar">
    <label>Status<select id="monitor-jobs-status"><option value="">all</option><option value="queued">queued</option><option value="leased">leased</option><option value="running">running</option><option value="completed">completed</option><option value="failed">failed</option><option value="canceled">canceled</option></select></label>
    <label>Limit<input id="monitor-jobs-limit" type="number" min="10" max="240" value="80" /></label>
    <button id="monitor-jobs-clear" type="button">Clear selection</button><button id="monitor-jobs-abort" class="danger" type="button">Abort selected</button>
    <span class="jobs-toolbar-note">Realtime is automatic · no refresh polling</span>
  </div>
  <div id="monitor-jobs" class="skeleton" aria-live="polite">Applying queue snapshot…</div>
</section>`;

const activityHtml = (): string => `<section class="panel"><header class="panel-head"><div><h2>Live activity</h2><p>The selected run’s authoritative receipt stream.</p></div></header><div id="monitor-activity" class="skeleton" aria-live="polite">Synchronizing selected activity…</div></section>`;

const memoryHtml = (): string => `<section class="panel"><header class="panel-head"><div><h2>Shared memory</h2><p>Search the caller-visible memory stream locally after one scoped subscription.</p></div></header>
  <div class="memory-toolbar"><label>Scope<input id="monitor-memory-scope" value="agent" autocomplete="off" spellcheck="false" /></label><label>Filter<input id="monitor-memory-query" placeholder="Filter text and tags…" autocomplete="off" /></label><button id="monitor-memory-search" type="button">Filter</button></div>
  <div id="monitor-memory" class="skeleton" aria-live="polite">Synchronizing memory scope…</div>
</section>`;

const historyHtml = (): string => `<div class="history-stack">
  ${agentReplayBarHtml({ id: "monitor-replay", title: "Decision history", description: "Select a run and reconstruct how people and agents reached the current state.", content: `<div id="monitor-replay-stack">${agentReplayClientControlsHtml({ id: "monitor-travel", adapter: "monitor", emptyLabel: "Synchronizing job events…" })}<div id="monitor-replay-frame" aria-live="polite"><div class="replay-empty">Select a run to load its history.</div></div></div>` })}
  ${activityHtml()}
  ${memoryHtml()}
</div>`;

export const monitorShell = (options: MonitorShellOptions): string => {
  const boot = options.realtime
    ? `<script id="monitor-realtime-boot" type="application/json" nonce="${esc(options.nonce)}">${scriptJson(options.realtime)}</script><script type="module" src="/assets/roster-client.js" nonce="${esc(options.nonce)}"></script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="theme-color" content="#090c11"/><title>Roster - Lobby</title>${themeBootstrapScript(options.nonce)}<style nonce="${esc(options.nonce)}">${monitorCss()}</style></head><body>
  <a class="skip-link" href="#main-content">Skip to Roster lobby</a><div class="agent-app" data-slot="agent-shell">
    ${agentSidebarHtml({ active: "monitor", description: "Move between durable rooms, see who is working, and supervise the shared system.", footerHtml: `<span class="agent-status" data-tone="live">SpacetimeDB authority</span>` })}
    <main class="agent-main" id="main-content" data-slot="agent-main">
      ${agentPageHeaderHtml({ eyebrow: "Where people and agents work together", title: "Your rooms", description: "Bring Codex, Claude, Pi, Hermes, or your own agent. Give everyone a shared room, a shared artifact, and a clear way to reach a decision.", metaHtml: `<span class="agent-status" data-roster-connection data-tone="warning" role="status" aria-live="polite">Connecting</span><span class="chip">Shared workspace</span>` })}
      ${agentTabsHtml({ id: "monitor-tabs", activeId: "overview", label: "Roster lobby views", tabs: [
        { id: "overview", label: "Rooms", content: overviewHtml(options.stream) },
        { id: "attention", label: "Attention", content: queueHtml() },
        { id: "history", label: "History", content: historyHtml() },
        { id: "inspect", label: "Inspect", content: architectureCatalogHtml(options.improvementAudit) },
      ] })}
    </main>
    <div id="monitor-detail-drawer" class="drawer" aria-hidden="true" inert><button id="monitor-detail-backdrop" class="drawer-backdrop" type="button" aria-label="Close selected job"></button><section class="drawer-panel" role="dialog" aria-modal="true" aria-label="Selected job details"><header class="drawer-head"><h2>Selected job</h2><button id="monitor-detail-close" type="button">Close</button></header><div class="drawer-body"><div id="monitor-job-detail"><div class="empty">Select a job to inspect details.</div></div></div></section></div>
  </div>${boot}${agentTabsScript(options.nonce)}</body></html>`;
};
