import { esc } from "./agent-framework.js";
import { themeCss, themeSelectorHtml } from "./theme.js";
import { pageMenuCss, pageMenuHtml, pageTopNavHtml, type PageMenuId } from "./page-menu.js";
import {
  getCoordinationAgentDefinition,
  getCoordinationArchitecture,
} from "../engine/orchestration/architecture-catalog.js";
import {
  projectRoomRoster,
  roomParticipant,
  type RoomPresenceState,
  type RoomRosterProjection,
} from "../engine/workspace/room.js";
import { roomRosterCss, roomRosterHtml } from "./room-roster.js";
import {
  participantProfileCss,
  participantProfileDialogHtml,
  participantProfileViewClientSource,
} from "./participant-profile.js";

export type AgentTab = {
  readonly id: string;
  readonly label: string;
  readonly content: string;
  readonly badge?: string;
};

export type AgentReplayBarOptions = {
  readonly id: string;
  readonly content: string;
  readonly title?: string;
  readonly description?: string;
};

export type AgentRoomHeaderOptions = {
  readonly title: string;
  readonly description: string;
  readonly eyebrow?: string;
  readonly state?: "open" | "active" | "waiting" | "complete";
  readonly stateLabel?: string;
  readonly roster?: RoomRosterProjection;
  readonly actionsHtml?: string;
  readonly contextId?: string;
};

export type AgentComposerOptions = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly inputId?: string;
  readonly inputName: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly submitId?: string;
  readonly method?: "get" | "post";
  readonly formId?: string;
  readonly hiddenHtml?: string;
  readonly toolsHtml?: string;
  readonly examplesHtml?: string;
  readonly helpHtml?: string;
  readonly inputValue?: string;
  readonly inputMinLength?: number;
  readonly inputMaxLength?: number;
  readonly inputRequired?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
};

// One product palette for every runnable agent surface. Domains may use the
// semantic success, warning, and danger tokens, but do not own brand accents.
export const agentWorkspaceThemeTokens = "--surface-canvas:#11120f;--surface-sidebar:#0d0e0c;--surface-panel:#181a16;--surface-raised:#22251e;--surface-hover:#292d24;--surface-inset:#121410;--surface-overlay:#1c1f19;--border-subtle:#2f312b;--border-default:#3a3e34;--border-strong:#4b5143;--text-primary:#f3f0e8;--text-secondary:#b9b8b0;--text-tertiary:#85887f;--accent:#b9f67c;--accent-strong:#cbff96;--success:#94ce72;--success-surface:#172014;--success-border:#4d6b3e;--warning:#e3c879;--warning-surface:#282315;--warning-border:#66572f;--danger:#f2a79a;--danger-surface:#2b1b18;--danger-border:#74443d;--focus-ring:#b9f67c;--action-primary:#b9f67c;--action-primary-hover:#cbff96;--action-primary-foreground:#11120f;--font-ui:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--font-mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;--shadow-card:0 10px 30px rgba(0,0,0,.24);--shadow-overlay:0 24px 70px rgba(0,0,0,.55);--radius-control:7px;--radius-card:10px;--radius-overlay:14px;--radius-pill:999px";

const safeId = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Agent shell IDs must contain a letter or number");
  return normalized;
};

const nonceAttribute = (nonce?: string): string => nonce ? ` nonce="${esc(nonce)}"` : "";

const roomOrbState = (state: NonNullable<AgentRoomHeaderOptions["state"]>): "working" | "listening" | "solving" =>
  state === "active" ? "working" : state === "waiting" ? "listening" : state === "complete" ? "solving" : "listening";

export const staticRoomRoster = (input: {
  readonly roomId: string;
  readonly label?: string;
  readonly summary?: string;
  readonly context?: string;
  readonly members: ReadonlyArray<{
    readonly id?: string;
    readonly name: string;
    readonly role: string;
    readonly kind: "human" | "agent" | "system";
    readonly presence: RoomPresenceState;
  }>;
}): RoomRosterProjection => projectRoomRoster({
  roomId: input.roomId,
  label: input.label ?? "People and agents",
  summary: input.summary ?? `${input.members.length} member${input.members.length === 1 ? "" : "s"} in the room`,
  ...(input.context ? { context: input.context } : {}),
  members: input.members.map((member, index) => roomParticipant({
    nodeId: member.id
      ?? (member.kind === "human" && member.name === "You" ? "human.operator" : undefined)
      ?? (member.kind === "system" && member.name === "Roster" ? "coordinator" : undefined)
      ?? `${member.kind}-${member.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || String(index + 1)}`,
    displayName: member.name,
    role: member.role,
    kind: member.kind,
    presence: member.presence,
  })),
});

export const agentTopNavHtml = (options: {
  readonly active?: PageMenuId;
  readonly actionsHtml?: string;
  readonly leadingHtml?: string;
  readonly showStatus?: boolean;
  readonly statusLabel?: string;
  readonly showNavigation?: boolean;
}): string => {
  const brand = `<span class="agent-brand-mark" aria-hidden="true">R</span><span><strong translate="no">Roster</strong><small>People + agents</small></span>`;
  return `<header class="top-navbar agent-top-nav" data-slot="agent-top-nav">
  ${options.leadingHtml ?? (options.showNavigation === false
    ? `<span class="top-navbar-brand" aria-label="Roster">${brand}</span>`
    : `<a class="top-navbar-brand" href="/monitor" aria-label="Roster rooms">${brand}</a>`)}
  ${options.showNavigation === false ? "" : pageTopNavHtml(options.active)}
  ${options.actionsHtml ? `<div class="agent-top-nav-actions" data-slot="agent-top-nav-actions">${options.actionsHtml}</div>` : ""}
  ${themeSelectorHtml("theme-control agent-theme-control")}
  ${options.showStatus === false ? "" : `<span class="top-navbar-status" aria-label="Workspace status"><span class="top-navbar-status-dot" aria-hidden="true"></span>${esc(options.statusLabel ?? "Operational")}</span>`}
</header>`;
};

export const agentSidebarRailHtml = (options: {
  readonly active?: PageMenuId;
  readonly description: string;
  readonly footerHtml?: string;
}): string => `<aside class="sidebar agent-sidebar" data-slot="agent-sidebar" aria-label="Roster navigation">
  <p class="agent-product-note">${esc(options.description)}</p>
  ${pageMenuHtml(options.active)}
  ${options.footerHtml ? `<div class="agent-sidebar-footer">${options.footerHtml}</div>` : ""}
</aside>`;

export const agentSidebarHtml = (options: {
  readonly active?: PageMenuId;
  readonly description: string;
  readonly footerHtml?: string;
}): string => `${agentTopNavHtml({ active: options.active })}
${agentSidebarRailHtml(options)}`;

export const agentShellFrameHtml = (options: {
  readonly skipHref: string;
  readonly skipLabel: string;
  readonly chromeHtml: string;
  readonly mainHtml: string;
  readonly mainId: string;
  readonly appClass?: string;
  readonly mainClass?: string;
}): string => `<a class="skip-link" href="${esc(options.skipHref)}">${esc(options.skipLabel)}</a>
<div class="agent-app${options.appClass ? ` ${esc(options.appClass)}` : ""}" data-slot="agent-shell" data-ui-family="roster-agent">
  ${options.chromeHtml}
  <main class="agent-main${options.mainClass ? ` ${esc(options.mainClass)}` : ""}" id="${safeId(options.mainId)}" data-slot="agent-main">${options.mainHtml}</main>
</div>`;

export const agentShellChromeCss = (): string => `
  .agent-top-nav{grid-column:1/-1;grid-row:1;min-width:0;display:flex;align-items:center;gap:22px;min-height:var(--shell-bar);padding:10px clamp(14px,2.2vw,32px);border-bottom:1px solid var(--line-soft);background:color-mix(in srgb,var(--panel) 92%,var(--bg));backdrop-filter:blur(18px);box-shadow:0 10px 30px rgba(0,0,0,.16)}
  .top-navbar-brand{flex:none;display:flex;align-items:center;gap:9px;color:var(--ink);text-decoration:none}.top-navbar-brand>span:last-child{display:grid;gap:1px}.top-navbar-brand strong{font-size:14px;letter-spacing:-.02em}.top-navbar-brand small{color:var(--muted);font:8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}
  .top-navbar-links{min-width:0;flex:1;overflow-x:auto;scrollbar-width:thin}.top-navbar-links ul{display:flex;align-items:center;gap:4px;min-width:max-content;margin:0;padding:0;list-style:none}.top-navbar-link{display:flex;align-items:center;min-height:36px;padding:0 10px;border:1px solid transparent;border-radius:var(--radius-sm);color:var(--muted);text-decoration:none;font-size:10px;font-weight:750;white-space:nowrap}.top-navbar-link:hover{color:var(--ink);border-color:var(--line);background:var(--raised)}.top-navbar-link.active{color:var(--ink);border-color:color-mix(in srgb,var(--agent-accent) 38%,var(--line));background:color-mix(in srgb,var(--agent-accent) 10%,var(--panel))}.top-navbar-link:focus-visible{outline:2px solid var(--agent-accent);outline-offset:2px}.top-navbar-status{flex:none;display:inline-flex;align-items:center;gap:7px;color:var(--muted);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.top-navbar-status-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px color-mix(in srgb,var(--green) 12%,transparent)}
  .agent-top-nav-actions{min-width:0;display:flex;align-items:center;gap:4px}
  .agent-brand-mark{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--agent-accent);border-radius:9px;color:var(--agent-accent);background:color-mix(in srgb,var(--agent-accent) 7%,transparent);font:800 13px/1 ui-monospace,monospace;box-shadow:0 0 24px var(--agent-accent-soft)}
  @media(max-width:820px){.agent-top-nav{gap:12px;min-height:56px;padding:8px 12px}.top-navbar-brand small,.top-navbar-status{display:none}.top-navbar-links{margin-right:-4px}.top-navbar-link{min-height:40px;padding-inline:9px}.agent-top-nav-actions{flex:none}}
  @media(max-width:560px){.agent-top-nav{gap:8px;overflow:hidden}.agent-theme-control>label,.top-navbar-brand>span:last-child{display:none}.top-navbar-link{padding-inline:8px}.agent-top-nav-actions nav{max-width:34vw}}
`;

export const agentPageHeaderHtml = (options: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly metaHtml?: string;
  readonly actionsHtml?: string;
}): string => `<header class="agent-page-header" data-slot="agent-page-header">
  <div class="agent-page-copy"><p class="agent-eyebrow">${esc(options.eyebrow)}</p><h1>${esc(options.title)}</h1><p>${esc(options.description)}</p></div>
  ${options.metaHtml || options.actionsHtml ? `<div class="agent-page-actions">${options.metaHtml ?? ""}${options.actionsHtml ?? ""}</div>` : ""}
</header>`;

/**
 * Shared social orientation for a Roster workspace. It presents room identity
 * and participants only; durable membership and execution remain projections
 * of each domain's receipts.
 */
export const agentRoomHeaderHtml = (options: AgentRoomHeaderOptions): string => {
  const state = options.state ?? "open";
  const stateLabel = options.stateLabel ?? (state === "active" ? "Working together" : state === "waiting" ? "Waiting for you" : state === "complete" ? "Conversation retained" : "Room open");
  return `<header class="agent-room-header" data-agent-room data-room-state="${state}" data-slot="agent-room-header">
    <div class="agent-room-identity"><span class="agent-room-orb" data-thinking-orb data-orb-state="${roomOrbState(state)}" data-orb-size="40" data-orb-paused="${state === "complete"}" aria-label="${esc(stateLabel)}"></span><div class="agent-room-copy"><span class="agent-room-eyebrow">${esc(options.eyebrow ?? "Shared room")}</span><div class="agent-room-title"><h1>${esc(options.title)}</h1><span class="agent-room-state"><i aria-hidden="true"></i>${esc(stateLabel)}</span></div><p>${esc(options.description)}</p></div></div>
    <div class="agent-room-header-actions">${options.actionsHtml ?? ""}${options.roster ? roomRosterHtml(options.roster, { id: `${options.roster.roomId}-compact-roster`, compact: true }) : ""}${options.contextId ? `<button class="agent-context-toggle" type="button" aria-controls="${safeId(options.contextId)}" aria-expanded="false" data-workspace-context-toggle>Context</button>` : ""}</div>
  </header>`;
};

export const agentRoomWorkspaceHtml = (options: {
  readonly room: AgentRoomHeaderOptions;
  readonly content: string;
  readonly includeExpandedRoster?: boolean;
}): string => `<section class="agent-room-workspace" data-slot="agent-room-workspace">${agentRoomHeaderHtml(options.room)}${options.room.roster && options.includeExpandedRoster !== false ? `<div class="agent-room-roster">${roomRosterHtml(options.room.roster)}</div>` : ""}${options.content}</section>`;

/**
 * Persistent page-level home for replay controls. The runtime-specific replay
 * adapter owns the contents, while every Roster surface shares this placement,
 * hierarchy, and responsive behavior.
 */
export const agentReplayBarHtml = (options: AgentReplayBarOptions): string => {
  const id = safeId(options.id);
  return `<details class="agent-replay agent-surface" id="${id}" data-agent-replay-bar data-slot="agent-replay">
    <summary class="agent-replay-head">
      <span class="agent-replay-mark" aria-hidden="true">&#8634;</span>
      <span class="agent-replay-copy"><small>How we got here</small><strong>${esc(options.title ?? "Replay the collaboration")}</strong>${options.description ? `<span>${esc(options.description)}</span>` : ""}</span>
      <span class="agent-replay-disclosure">Inspect history <i aria-hidden="true">⌄</i></span>
    </summary>
    <div class="agent-replay-body">${options.content}</div>
  </details>`;
};

/**
 * Framework-owned message surface. Domains provide fields and controls, while
 * Roster owns placement, hierarchy, focus treatment, and responsive behavior.
 */
export const agentComposerHtml = (options: AgentComposerOptions): string => {
  const id = safeId(options.id);
  const inputId = safeId(options.inputId ?? options.id);
  const inputAttributes = [
    options.inputMinLength === undefined ? "" : ` minlength="${options.inputMinLength}"`,
    options.inputMaxLength === undefined ? "" : ` maxlength="${options.inputMaxLength}"`,
    options.inputRequired === false ? "" : " required",
  ].join("");
  const examples = options.examplesHtml
    ? `<section class="agent-composer-examples" aria-label="Examples"><strong>Examples</strong>${options.examplesHtml}</section>`
    : "";
  const advanced = examples || options.toolsHtml
    ? `<details class="agent-composer-advanced" data-composer-advanced data-details-key="${id}-composer-tools"><summary aria-label="Open composer tools"><span aria-hidden="true">＋</span><span>Tools</span></summary><div class="agent-composer-advanced-panel">${examples}${options.toolsHtml ?? ""}</div></details>`
    : "";
  return `<form class="coding-composer agent-composer${options.className ? ` ${esc(options.className)}` : ""}"${options.formId ? ` id="${safeId(options.formId)}"` : ""} action="${esc(options.action)}" method="${options.method ?? "post"}" data-slot="workspace-composer" data-composer-kind="workspace" aria-labelledby="${id}-title">
    ${options.hiddenHtml ?? ""}
    <span class="sr-only" id="${id}-title">${esc(options.title)}</span>
    <label class="sr-only" for="${inputId}">${esc(options.inputLabel)}</label>
    <textarea id="${inputId}" name="${esc(options.inputName)}" rows="1" autocomplete="off" enterkeyhint="send" placeholder="${esc(options.placeholder)}" data-slot="composer-input"${inputAttributes}>${esc(options.inputValue ?? "")}</textarea>
    <div class="coding-composer-footer" data-slot="composer-footer">
      <div class="coding-composer-tools" data-slot="composer-tools">${advanced}</div>
      <button${options.submitId ? ` id="${safeId(options.submitId)}"` : ""} type="submit" aria-label="${esc(options.submitLabel)}" data-slot="composer-submit"${options.disabled ? " disabled" : ""}><span aria-hidden="true">↑</span></button>
    </div>
    <p class="coding-composer-help" data-slot="composer-help"><span>${options.helpHtml ?? esc(options.description)}</span><span>Enter to send · Shift+Enter for a new line</span></p>
  </form>`;
};

export const agentReplayClientControlsHtml = (options: {
  readonly id: string;
  readonly adapter: string;
  readonly emptyLabel?: string;
}): string => {
  const id = safeId(options.id);
  const adapter = safeId(options.adapter);
  return `<div class="travel-row" id="${id}" data-replay-controls data-replay-adapter="${adapter}" data-current="0" data-maximum="0">
    <div class="travel-actions" role="group" aria-label="Replay controls">
      <button class="travel-btn" type="button" data-replay-command data-replay-action="start" aria-label="Replay from beginning" disabled>Start</button>
      <button class="travel-btn" type="button" data-replay-command data-replay-action="previous" aria-label="Previous replay step" disabled>Previous</button>
      <button class="travel-btn travel-play" type="button" data-replay-play data-replay-action="play" aria-pressed="false" disabled>Play</button>
      <button class="travel-btn" type="button" data-replay-command data-replay-action="next" aria-label="Next replay step" disabled>Next</button>
      <button class="travel-btn" type="button" data-replay-command data-replay-action="live" aria-label="Return to live state" disabled>Live</button>
    </div>
    <label class="travel-scrub"><span class="sr-only">Replay step</span><input class="travel-slider" type="range" min="0" max="0" value="0" data-replay-scrub disabled /></label>
    <div class="travel-meta"><label><span class="sr-only">Replay speed</span><select class="travel-speed" aria-label="Replay speed" data-replay-speed disabled><option value="1200">0.5x</option><option value="700" selected>1x</option><option value="350">2x</option></select></label><output class="travel-state" aria-live="polite" aria-atomic="true">${esc(options.emptyLabel ?? "No run selected")}</output></div>
  </div>`;
};

export const agentTabsHtml = (options: {
  readonly id: string;
  readonly tabs: ReadonlyArray<AgentTab>;
  readonly activeId?: string;
  readonly label?: string;
}): string => {
  if (options.tabs.length === 0) throw new Error("Agent tabs require at least one panel");
  const rootId = safeId(options.id);
  const ids = new Set<string>();
  const tabs = options.tabs.map((tab) => {
    const id = safeId(tab.id);
    if (ids.has(id)) throw new Error(`Duplicate agent tab ${id}`);
    ids.add(id);
    return { ...tab, id };
  });
  const activeId = ids.has(safeId(options.activeId ?? tabs[0]!.id))
    ? safeId(options.activeId ?? tabs[0]!.id)
    : tabs[0]!.id;
  return `<section class="agent-tabs" id="${rootId}" data-agent-tabs data-slot="agent-tabs" data-default-tab="${activeId}">
    <div class="agent-tablist" role="tablist" aria-label="${esc(options.label ?? "Workspace views")}">
      ${tabs.map((tab) => {
        const selected = tab.id === activeId;
        return `<button type="button" class="agent-tab" id="${rootId}-tab-${tab.id}" role="tab" aria-selected="${selected}" aria-controls="${rootId}-panel-${tab.id}" tabindex="${selected ? "0" : "-1"}" data-agent-tab="${tab.id}"><span>${esc(tab.label)}</span>${tab.badge ? `<small>${esc(tab.badge)}</small>` : ""}</button>`;
      }).join("")}
    </div>
    <div class="agent-tabpanels">
      ${tabs.map((tab) => `<section class="agent-tabpanel" id="${rootId}-panel-${tab.id}" role="tabpanel" aria-labelledby="${rootId}-tab-${tab.id}" tabindex="0" data-agent-panel="${tab.id}" data-slot="agent-tab-panel"${tab.id === activeId ? "" : " hidden"}>${tab.content}</section>`).join("")}
    </div>
  </section>`;
};

export const agentArchitecturePanelHtml = (agentId: string): string => {
  const example = getCoordinationAgentDefinition(agentId);
  if (!example) throw new Error(`Architecture panel requires a registered agent, received ${agentId}`);
  const architecture = getCoordinationArchitecture(example.architectureId);
  return `<article class="agent-architecture-panel agent-surface" aria-labelledby="${safeId(agentId)}-architecture-title">
    <header class="agent-architecture-head"><div><p>Coordination architecture</p><h2 id="${safeId(agentId)}-architecture-title">${esc(architecture.name)}</h2></div><span>${esc(architecture.id)}</span></header>
    <p class="agent-architecture-summary">${esc(architecture.summary)}</p>
    <dl class="agent-architecture-grid">
      <div><dt>How agents coordinate</dt><dd>${esc(architecture.topology)}</dd></div>
      <div><dt>Where agents run</dt><dd>${esc(architecture.runtimeAdapter)}</dd></div>
      <div><dt>How agents are formed</dt><dd>${esc(architecture.population)}</dd></div>
      <div><dt>How work combines</dt><dd>${esc(architecture.composition)}</dd></div>
      <div><dt>Shared artifact</dt><dd>${esc(example.artifact)} · ${esc(architecture.artifactProtocol)}</dd></div>
      <div><dt>When work is accepted</dt><dd>${esc(example.acceptance)}</dd></div>
    </dl>
    <section class="agent-architecture-extensions" aria-label="Enabled architecture extensions"><h3>Enabled extensions</h3><ul>${example.extensions.map((extension) => `<li>${esc(extension)}</li>`).join("")}</ul></section>
  </article>`;
};

/**
 * The provider-neutral room layout used by built-in and package-owned agents.
 * Domains supply bounded content; the framework owns placement, participants,
 * responsive context disclosure, and accessibility semantics.
 */
export const agentWorkspaceShellHtml = (options: {
  readonly id: string;
  readonly room: AgentRoomHeaderOptions;
  readonly conversation: string;
  readonly composer?: string;
  readonly context: string;
  readonly contextLabel: string;
  readonly artifact: string;
  readonly acceptance: string;
  readonly coordinationLabel: string;
  readonly railActionsHtml?: string;
}): string => {
  const contextId = `${safeId(options.id)}-context`;
  const railStateLabel = options.room.stateLabel
    ?? (options.room.state === "active" ? "Working together" : options.room.state === "waiting" ? "Waiting for you" : options.room.state === "complete" ? "Conversation retained" : "Room open");
  const rail = `<aside class="agent-workspace-rail" data-slot="workspace-rail" data-workspace-region="rail" aria-label="Repository rooms and team">
    <div class="agent-workspace-rail-head"><span class="agent-workspace-mark" aria-hidden="true">R</span><span><strong>Roster workspace</strong><small>${esc(options.coordinationLabel)}</small></span></div>
    ${options.railActionsHtml ? `<div class="agent-workspace-rail-actions">${options.railActionsHtml}</div>` : ""}
    <div class="agent-workspace-rooms"><div class="agent-workspace-section-title"><span>Rooms</span><small>1</small></div><a href="#" aria-current="page"><i aria-hidden="true"></i><span><strong>${esc(options.room.title)}</strong><small>${esc(railStateLabel)}</small></span></a></div>
    ${options.room.roster ? `<div class="agent-workspace-people"><div class="agent-workspace-section-title"><span>People & agents</span><small>${options.room.roster.members.length}</small></div>${roomRosterHtml(options.room.roster)}</div>` : ""}
    <div class="agent-workspace-artifact"><span>Shared artifact</span><strong>${esc(options.artifact)}</strong><small>${esc(options.acceptance)}</small></div>
  </aside>`;
  const conversation = `<section class="agent-conversation" data-slot="workspace-conversation" data-workspace-region="conversation" aria-label="Room conversation">${agentRoomHeaderHtml({ ...options.room, contextId })}<div class="agent-conversation-body"><div class="agent-conversation-feed" data-slot="conversation-feed">${options.conversation}</div>${options.composer ? `<div class="agent-composer-dock" data-slot="composer-dock">${options.composer}</div>` : ""}</div></section>`;
  const context = `<aside class="agent-workspace-context" id="${contextId}" data-slot="workspace-context" data-workspace-region="context" aria-label="${esc(options.contextLabel)}" hidden><header class="agent-workbench-head"><span>Context</span><strong>${esc(options.artifact)}</strong><button type="button" aria-label="Close context" data-workspace-context-close>Close</button></header>${options.context}</aside>`;
  const content = `<div class="agent-workspace-shell" data-workspace-shell data-layout="room" data-context-open="false" data-slot="workspace-shell">${rail}${conversation}${context}</div>`;
  return `<section class="agent-room-workspace" data-slot="agent-room-workspace">${content}</section>`;
};

/**
 * Shared information architecture for every runnable coordination example.
 * Every room opens as a conversation. Domain artifacts live in a sibling Work
 * surface (or a domain-specific label such as Canvas) without duplicating the
 * live projection nodes that browser adapters update in place.
 */
export const agentExampleTabsHtml = (options: {
  readonly id: string;
  readonly agentId: string;
  readonly workspace: string;
  readonly runs: string;
  readonly activity: string;
  readonly conversation: string;
  readonly composer?: string;
  readonly workspaceBadge?: string;
  readonly room?: AgentRoomHeaderOptions;
  readonly workLabel?: string;
  readonly workspaceLabel?: string;
  readonly domainTabs?: ReadonlyArray<AgentTab>;
  readonly history?: string;
  readonly railActionsHtml?: string;
  readonly label?: string;
}): string => {
  const example = getCoordinationAgentDefinition(options.agentId);
  if (!example) throw new Error(`Workspace surface requires a registered agent, received ${options.agentId}`);
  const workLabel = options.workLabel?.trim() || "Work";
  const workspaceLabel = options.workspaceLabel?.trim() || workLabel;
  const contextTabs = agentTabsHtml({
    id: `${options.id}-context-tabs`,
    activeId: "workspace",
    label: options.label ?? `${workLabel} and room context`,
    tabs: [
      { id: "workspace", label: workspaceLabel, badge: options.workspaceBadge, content: options.workspace },
      { id: "runs", label: "Runs", content: options.runs },
      { id: "activity", label: "Timeline", content: options.activity },
      ...(options.history ? [{ id: "history", label: "History", content: options.history }] : []),
      ...(options.domainTabs ?? []),
      { id: "architecture", label: "System", content: agentArchitecturePanelHtml(options.agentId) },
    ],
  });
  const room = options.room ?? {
    title: example.roomName ?? example.name,
    description: example.description,
  };
  return agentWorkspaceShellHtml({
    id: options.id,
    room,
    conversation: options.conversation,
    composer: options.composer,
    context: contextTabs,
    contextLabel: `${workLabel} and room context`,
    artifact: example.artifact,
    acceptance: example.acceptance,
    coordinationLabel: example.coordinationLabel,
    railActionsHtml: options.railActionsHtml,
  });
};

export const agentShellCss = (): string => `
  :root {
    color-scheme:dark;
    ${agentWorkspaceThemeTokens};
    --bg:var(--surface-canvas); --panel:var(--surface-panel); --panel-2:var(--surface-inset); --raised:var(--surface-raised);
    --line:var(--border-default); --line-soft:var(--border-subtle); --ink:var(--text-primary); --muted:var(--text-secondary); --faint:var(--text-tertiary);
    --blue:var(--accent-strong); --green:var(--success); --amber:var(--warning); --red:var(--danger); --violet:var(--accent-strong);
    --agent-accent:var(--accent-strong); --agent-accent-soft:rgba(185,246,124,.1);
    --radius-sm:var(--radius-control); --radius-md:var(--radius-card); --radius-lg:var(--radius-overlay); --shell-rail:248px; --shell-bar:48px;
    font-family:var(--font-ui);
  }
  *{box-sizing:border-box} html{background:var(--bg)} body{margin:0;min-width:320px;min-height:100vh;background:var(--bg);color:var(--ink);font-family:inherit;overflow-x:hidden}
  button,input,textarea,select{font:inherit} button,a,input,textarea,select,summary{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  .sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
  :focus-visible{outline:2px solid var(--agent-accent);outline-offset:3px}
  .skip-link{position:fixed;z-index:100;left:12px;top:12px;transform:translateY(-160%);padding:9px 12px;border-radius:var(--radius-sm);background:var(--ink);color:var(--bg)}.skip-link:focus{transform:none}
  .agent-app{min-height:100vh;display:grid;grid-template-columns:var(--shell-rail) minmax(0,1fr);grid-template-rows:var(--shell-bar) minmax(0,1fr)}
  ${agentShellChromeCss()}
  .agent-sidebar{grid-column:1;grid-row:2}
  .agent-sidebar{position:sticky;top:0;height:calc(100vh - var(--shell-bar));overflow:auto;padding:18px 14px;border-right:1px solid var(--line-soft);background:linear-gradient(180deg,color-mix(in srgb,var(--panel) 96%,var(--agent-accent) 4%),var(--panel))}
  .agent-product-note{margin:0 3px;color:var(--muted);font-size:11px;line-height:1.5}.agent-sidebar-footer{margin-top:16px;padding-top:14px;border-top:1px solid var(--line-soft)}
  ${pageMenuCss()}
  ${roomRosterCss()}
  ${participantProfileCss()}
  .agent-main{grid-column:2;grid-row:2;min-width:0;width:min(100%,1580px);margin:0 auto;padding:24px clamp(18px,2.7vw,42px) 56px}
  .agent-page-header{min-width:0;display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:18px}.agent-page-copy{min-width:0}.agent-eyebrow{margin:0 0 7px;color:var(--agent-accent);font:800 10px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.13em}.agent-page-header h1{margin:0;font-size:clamp(25px,3vw,40px);line-height:1.04;letter-spacing:-.04em;text-wrap:balance}.agent-page-copy>p:last-child{max-width:720px;margin:9px 0 0;color:var(--muted);font-size:13px;line-height:1.55}.agent-page-actions{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
  .agent-surface{min-width:0;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--panel);box-shadow:0 20px 60px rgba(0,0,0,.18)}
  .agent-room-workspace{min-width:0;display:grid;gap:0;overflow:hidden;border:1px solid var(--line-soft);border-radius:var(--radius-lg);background:var(--panel);box-shadow:0 28px 80px rgba(0,0,0,.16)}.agent-room-workspace>.agent-room-header{position:sticky;z-index:8;top:0;background:color-mix(in srgb,var(--bg) 96%,transparent);backdrop-filter:blur(16px)}.agent-room-header{min-width:0;min-height:68px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;padding:9px 18px;border-bottom:1px solid var(--line-soft)}.agent-room-identity{min-width:0;display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:10px}.agent-room-orb{width:32px;height:32px;display:grid;place-items:center;overflow:hidden;flex:none;border:1px solid var(--line-soft);border-radius:50%;background:radial-gradient(circle at 50% 45%,color-mix(in srgb,var(--agent-accent) 12%,var(--raised)),transparent 68%);box-shadow:0 8px 22px color-mix(in srgb,var(--agent-accent) 9%,transparent)}.agent-room-orb canvas{width:40px;height:40px;display:block}.agent-room-copy{min-width:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 8px;align-items:center}.agent-room-eyebrow{color:var(--agent-accent);font:800 7px/1.2 var(--font-mono);text-transform:uppercase;letter-spacing:.12em}.agent-room-title{min-width:0;display:flex;align-items:center;gap:9px}.agent-room-title h1{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;letter-spacing:-.015em}.agent-room-state{flex:none;display:inline-flex;align-items:center;gap:6px;color:var(--muted);font:700 8px/1 var(--font-mono)}.agent-room-state i{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px color-mix(in srgb,var(--green) 10%,transparent)}.agent-room-header[data-room-state="waiting"] .agent-room-state i{background:var(--amber);box-shadow:0 0 0 4px color-mix(in srgb,var(--amber) 10%,transparent)}.agent-room-header[data-room-state="complete"] .agent-room-state i{background:var(--faint);box-shadow:none}.agent-room-copy>p{grid-column:2;min-width:0;max-width:780px;overflow:hidden;margin:0;color:var(--muted);font-size:9px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.agent-room-header-actions{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px}.agent-context-toggle{min-height:32px;padding:0 10px;border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--ink);background:var(--raised);cursor:pointer;font-size:9px;font-weight:700}.agent-context-toggle:hover{border-color:var(--border-strong);background:var(--surface-hover)}
  .agent-room-roster{padding:12px 16px;border-bottom:1px solid var(--line-soft);background:var(--bg)}
  .agent-conversation{min-width:0;display:grid;align-content:start;min-height:440px;background:radial-gradient(circle at 18% 8%,color-mix(in srgb,var(--agent-accent) 6%,transparent),transparent 30rem),radial-gradient(circle at 82% 72%,color-mix(in srgb,var(--agent-accent) 3%,transparent),transparent 26rem),var(--bg)}.agent-conversation-head{min-width:0;min-height:40px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:0 18px;border-bottom:1px solid var(--line-soft);background:color-mix(in srgb,var(--panel) 96%,transparent)}.agent-conversation-head>div{min-width:0;display:flex;align-items:baseline;gap:9px}.agent-conversation-head span{color:var(--agent-accent);font:800 8px/1 var(--font-mono);text-transform:uppercase;letter-spacing:.1em}.agent-conversation-head strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.agent-conversation-head small{color:var(--faint);font-size:8px}.agent-conversation-body{min-width:0;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;overflow:hidden}.agent-conversation-feed{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;padding:18px clamp(18px,3.5vw,48px);scrollbar-width:thin}.agent-conversation-feed>.agent-surface{border:0;border-radius:0;background:transparent;box-shadow:none}.agent-conversation-feed>.workspace-panel{padding:0}.agent-composer-dock{min-width:0;padding:10px clamp(18px,3.5vw,48px) 20px;background:linear-gradient(180deg,transparent,var(--bg) 20%)}.agent-composer{width:min(100%,920px);min-width:0;display:grid;gap:10px;margin:0 auto;padding:11px 13px 10px;border:1px solid color-mix(in srgb,var(--agent-accent) 18%,var(--border-strong));border-radius:12px;background:color-mix(in srgb,var(--raised) 94%,var(--agent-accent));box-shadow:0 8px 28px rgba(0,0,0,.2)}.agent-composer:focus-within{border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--border-strong));box-shadow:0 0 0 3px color-mix(in srgb,var(--agent-accent) 10%,transparent),0 14px 40px rgba(0,0,0,.3)}.agent-composer-head{min-width:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start}.agent-composer-head>span{margin-top:2px;color:var(--agent-accent);font:800 7px/1.2 var(--font-mono);text-transform:uppercase;letter-spacing:.1em}.agent-composer-head>div{min-width:0}.agent-composer-head h2{margin:0;font-size:10px;font-weight:700}.agent-composer-head p{margin:2px 0 0;color:var(--faint);font-size:8px;line-height:1.4}.agent-composer-body{min-width:0}.agent-composer :is(textarea,input,select){border-color:var(--line);background:var(--surface-inset);color:var(--ink)}.agent-composer :is(textarea,input,select):hover{border-color:var(--border-strong)}.agent-composer :is(button[type="submit"],.primary,.run-submit,.run-button){border-color:var(--agent-accent);color:var(--action-primary-foreground);background:var(--action-primary);box-shadow:none}.agent-composer :is(button[type="submit"],.primary,.run-submit,.run-button):hover{border-color:var(--action-primary-hover);background:var(--action-primary-hover);filter:none;transform:none}
  .agent-composer.coding-composer{position:relative;width:min(100%,920px);display:block;gap:0;padding:11px 13px 9px;border:1px solid var(--border-strong);border-radius:var(--radius-card);background:var(--surface-raised);box-shadow:var(--shadow-card)}.agent-composer.coding-composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 13%,transparent),var(--shadow-card)}.agent-composer.coding-composer textarea{width:100%;min-height:48px;max-height:180px;field-sizing:content;resize:none;overflow:auto;border:0;padding:5px 1px;color:var(--text-primary);background:transparent;font-size:15px;line-height:1.45;outline:0}.agent-composer.coding-composer textarea:hover{border:0}.agent-composer.coding-composer textarea::placeholder{color:var(--text-tertiary)}.coding-composer-footer{min-width:0;display:flex;align-items:flex-end;justify-content:space-between;gap:10px}.coding-composer-tools{min-width:0;display:flex;align-items:center;gap:6px}.agent-composer-advanced{position:relative}.agent-composer-advanced>summary{min-height:34px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-secondary);background:var(--surface-inset);cursor:pointer;font-size:10px;font-weight:650;list-style:none}.agent-composer-advanced>summary::-webkit-details-marker{display:none}.agent-composer-advanced>summary:hover,.agent-composer-advanced[open]>summary{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.agent-composer-advanced-panel{position:absolute;z-index:30;left:0;bottom:calc(100% + 8px);width:min(380px,calc(100vw - 48px));max-height:min(420px,55vh);display:flex;flex-wrap:wrap;align-items:center;gap:8px;overflow:auto;padding:10px;border:1px solid var(--border-strong);border-radius:var(--radius-overlay);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.agent-composer-examples{width:100%;display:grid;gap:7px}.agent-composer-examples>strong{color:var(--text-tertiary);font-size:9px;text-transform:uppercase;letter-spacing:.06em}.agent-composer.coding-composer button[type="submit"]{min-width:40px;min-height:36px;height:36px;display:grid;place-items:center;border:0;border-radius:var(--radius-control);padding:0 9px;color:var(--action-primary-foreground);background:var(--action-primary);cursor:pointer;font-size:17px;font-weight:700}.agent-composer.coding-composer button[type="submit"]:hover{background:var(--action-primary-hover)}.agent-composer.coding-composer button[type="submit"]:disabled{cursor:not-allowed;opacity:.45}.coding-composer-help{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 1px 0;color:var(--text-tertiary);font-size:10px;line-height:1.4}.coding-composer-help span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-composer-help span:last-child{flex:none;font-family:var(--font-mono)}.agent-composer-select{min-height:30px;display:flex;align-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);padding:0 8px;background:var(--surface-inset)}.agent-composer-select select{height:28px;border:0;color:var(--text-secondary);background:transparent;font-size:9px}.agent-composer-menu{position:relative}.agent-composer-menu>summary{min-height:30px;display:grid;place-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);padding:0 10px;color:var(--text-secondary);background:var(--surface-inset);cursor:pointer;font-size:9px;font-weight:650;list-style:none}.agent-composer-menu>summary::-webkit-details-marker{display:none}.agent-composer-menu>summary:hover,.agent-composer-menu[open]>summary{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.agent-composer-popover{position:absolute;z-index:30;left:0;bottom:calc(100% + 8px);width:min(360px,calc(100vw - 48px));max-height:min(420px,55vh);overflow:auto;padding:8px;border:1px solid var(--border-strong);border-radius:var(--radius-overlay);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.agent-composer-popover :is(.example-list,.examples){display:flex;flex-wrap:wrap;gap:6px}.agent-composer-popover :is(.example-list,.examples) button{min-height:36px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);padding:6px 10px;color:var(--text-secondary);background:var(--surface-inset);cursor:pointer;font-size:9px;text-align:left}.agent-composer-popover :is(.example-list,.examples) button:hover{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.agent-composer-options{position:relative}.agent-composer-options>summary{min-height:30px;display:grid;place-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);padding:0 10px;color:var(--text-secondary);background:var(--surface-inset);cursor:pointer;font-size:9px;font-weight:650;list-style:none}.agent-composer-options>summary::-webkit-details-marker{display:none}.agent-composer-options>summary:hover,.agent-composer-options[open]>summary{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.agent-composer-options-panel{position:absolute;z-index:30;left:0;bottom:calc(100% + 8px);min-width:260px;max-width:min(520px,calc(100vw - 48px));padding:10px;border:1px solid var(--border-strong);border-radius:var(--radius-overlay);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.agent-composer-options-panel :is(.config-row,.run-controls){display:flex;flex-wrap:wrap;gap:8px;padding:0}.agent-composer-options-panel label{display:grid;gap:5px;color:var(--text-tertiary);font-size:8px;font-weight:700}.agent-composer-options-panel :is(input,select){width:96px;min-height:36px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);padding:6px 8px;color:var(--text-primary);background:var(--surface-inset)}
  .room-thread{width:min(100%,820px);display:grid;gap:15px;margin:0 auto;padding:2px 0;list-style:none}.room-message{min-width:0;display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;align-items:start}.room-message-avatar{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--line);border-radius:10px;color:var(--ink);background:var(--raised);font:850 10px/1 ui-monospace,monospace}.room-message-human .room-message-avatar{color:#18200e;border-color:transparent;background:var(--agent-accent)}.room-message article{min-width:0;display:grid;gap:7px;padding:10px 12px;border:1px solid var(--line-soft);border-radius:4px 13px 13px 13px;background:var(--panel)}.room-message-human article{border-color:color-mix(in srgb,var(--agent-accent) 30%,var(--line));background:var(--agent-accent-soft)}.room-message[data-tone="attention"] article{border-color:color-mix(in srgb,var(--amber) 42%,var(--line))}.room-message[data-tone="resolved"] article{border-color:color-mix(in srgb,var(--green) 42%,var(--line))}.room-message header{min-width:0;display:flex;align-items:baseline;gap:7px}.room-message header strong{font-size:10px}.room-message header span,.room-message header time{color:var(--faint);font-size:8px}.room-message header time{margin-left:auto;font-family:ui-monospace,monospace}.room-message p{margin:0;color:var(--ink);font-size:11px;line-height:1.58;white-space:pre-wrap;overflow-wrap:anywhere}.room-thread-empty{min-height:260px;display:grid;place-items:center;align-content:center;gap:8px;text-align:center}.room-thread-empty>span{width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;color:var(--agent-accent);font-size:18px}.room-thread-empty strong{font-size:12px}.room-thread-empty p{max-width:48ch;margin:0;color:var(--muted);font-size:10px;line-height:1.5}
  .agent-workbench-head{min-width:0;min-height:49px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--line-soft);background:var(--panel)}.agent-workbench-head>span{color:var(--agent-accent);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}.agent-workbench-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}
  .agent-unified-page{grid-template-columns:minmax(0,1fr);height:100dvh;overflow:hidden}.agent-unified-page>.agent-top-nav{grid-column:1}.agent-unified-page>.agent-main{grid-column:1;width:100%;max-width:none;height:calc(100dvh - var(--shell-bar));min-height:0;margin:0;padding:0}.agent-unified-page .agent-room-workspace{height:100%;grid-template-rows:minmax(0,1fr);border:0;border-radius:0;box-shadow:none}.agent-unified-page .agent-room-workspace>.agent-room-header{position:relative;top:auto}
  .agent-workspace-shell{min-width:0;min-height:0;display:grid;grid-template-columns:260px minmax(380px,1fr) minmax(300px,360px);overflow:hidden;background:var(--bg)}.agent-workspace-shell[data-context-open="false"]{grid-template-columns:260px minmax(0,1fr)}.agent-workspace-rail,.agent-workspace-context,.agent-conversation{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.agent-workspace-rail{border-right:1px solid var(--line-soft);background:linear-gradient(180deg,color-mix(in srgb,var(--agent-accent) 3%,var(--surface-sidebar)),var(--surface-sidebar) 28%)}.agent-workspace-rail-head{display:grid;gap:4px;padding:16px;border-bottom:1px solid var(--line-soft)}.agent-workspace-rail-head>span,.agent-workspace-artifact>span,.agent-workspace-section-title{color:var(--faint);font:800 8px/1.2 var(--font-mono);text-transform:uppercase;letter-spacing:.08em}.agent-workspace-rail-head strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.agent-workspace-rail-head small{color:var(--muted);font-size:9px;line-height:1.4}.agent-workspace-rail-actions{display:grid;gap:7px;padding:12px 14px;border-bottom:1px solid var(--line-soft)}.agent-workspace-rail-actions>a,.agent-workspace-rail-actions>button{width:100%;min-height:36px;display:grid;place-items:center;border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--ink);background:var(--raised);cursor:pointer;text-decoration:none;font-size:10px;font-weight:700}.agent-workspace-rail-actions>a:hover,.agent-workspace-rail-actions>button:hover{border-color:var(--border-strong);background:var(--surface-hover)}.agent-workspace-people{padding:13px 12px;border-bottom:1px solid var(--line-soft)}.agent-workspace-section-title{display:flex;align-items:center;justify-content:space-between;padding:0 4px 8px}.agent-workspace-section-title small{font:inherit}.agent-workspace-people .room-roster{padding:0;border:0;background:transparent}.agent-workspace-people .room-roster-head{display:none}.agent-workspace-artifact{display:grid;gap:6px;padding:14px 16px}.agent-workspace-artifact strong{font-size:10px;line-height:1.4}.agent-workspace-artifact small{color:var(--muted);font-size:8px;line-height:1.5}.agent-workspace-context{border-left:1px solid var(--line-soft);background:var(--panel)}.agent-workspace-context[hidden]{display:none}.agent-workspace-context>.agent-workbench-head{position:sticky;z-index:4;top:0}.agent-workspace-context>.agent-workbench-head button{margin-left:auto;min-height:30px;border:0;padding:0 4px;color:var(--muted);background:transparent;cursor:pointer;font-size:8px;font-weight:750}.agent-workspace-context>.agent-workbench-head button:hover{color:var(--ink)}.agent-workspace-context>.agent-tabs{margin:0}.agent-workspace-context>.agent-tabs>.agent-tablist{position:sticky;z-index:3;top:49px;padding:0 8px;background:var(--panel)}.agent-workspace-context>.agent-tabs>.agent-tablist .agent-tab{min-height:40px;padding-inline:8px;font-size:9px}.agent-workspace-context>.agent-tabs>.agent-tabpanels>.agent-tabpanel{padding:12px}.agent-workspace-context .agent-surface{border-radius:var(--radius-sm);box-shadow:none}.agent-workspace-context .agent-replay{margin:0}.agent-workspace-context .travel-row{grid-template-columns:1fr}.agent-workspace-context .travel-actions{overflow-x:auto}.agent-workspace-context .travel-meta{justify-content:space-between}.agent-workspace-context .agent-architecture-grid{grid-template-columns:1fr}.agent-workspace-context .agent-architecture-panel{padding:13px}.agent-workspace-shell>.agent-conversation{height:100%;overflow:hidden;align-content:stretch;grid-template-rows:auto minmax(0,1fr)}.agent-workspace-shell>.agent-conversation>.agent-conversation-head{position:sticky;z-index:4;top:0}.agent-workspace-shell>.agent-conversation>.agent-conversation-body{min-height:0;overflow:hidden}
  .agent-workspace-rail .agent-workspace-rail-head{display:grid;grid-template-columns:30px minmax(0,1fr);gap:9px;align-items:center;padding:14px 12px}.agent-workspace-rail-head>.agent-workspace-mark{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--accent);background:var(--surface-raised);font:800 10px/1 var(--font-mono)}.agent-workspace-rail-head>span:last-child{min-width:0;display:grid;gap:2px;color:inherit;font:inherit;text-transform:none;letter-spacing:normal}.agent-workspace-rail-head>span:last-child strong,.agent-workspace-rail-head>span:last-child small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-workspace-rail-head>span:last-child strong{font-size:11px}.agent-workspace-rail-head>span:last-child small{color:var(--faint);font:8px/1.3 var(--font-mono)}.agent-workspace-rooms{padding:12px 9px;border-bottom:1px solid var(--line-soft)}.agent-workspace-rooms>a{min-width:0;display:grid;grid-template-columns:6px minmax(0,1fr);gap:8px;align-items:start;padding:8px 7px;border-radius:var(--radius-control);color:inherit;background:var(--surface-raised);text-decoration:none}.agent-workspace-rooms>a>i{width:6px;height:6px;margin-top:4px;border-radius:50%;background:var(--accent)}.agent-workspace-rooms>a>span{min-width:0}.agent-workspace-rooms>a strong,.agent-workspace-rooms>a small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-workspace-rooms>a strong{font-size:10px}.agent-workspace-rooms>a small{margin-top:2px;color:var(--faint);font-size:8px}
  .agent-replay{min-width:0;margin:0 0 16px;border-color:var(--line-soft);background:var(--panel)}
  .agent-replay-head{min-width:0;display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:9px;padding:10px 13px;cursor:pointer;list-style:none}.agent-replay-head::-webkit-details-marker{display:none}.agent-replay-mark{width:30px;height:30px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--agent-accent) 34%,var(--line));border-radius:9px;color:var(--agent-accent);background:var(--agent-accent-soft);font-size:17px}.agent-replay-copy{min-width:0;display:grid;gap:2px}.agent-replay-copy small{color:var(--agent-accent);font:800 8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}.agent-replay-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.agent-replay-copy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:9px}.agent-replay-disclosure{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:9px;font-weight:750}.agent-replay-disclosure i{font-style:normal;transition:transform .14s ease}.agent-replay[open] .agent-replay-disclosure i{transform:rotate(180deg)}.agent-replay-body{min-width:0;padding:12px 13px;border-top:1px solid var(--line-soft);background:linear-gradient(110deg,var(--agent-accent-soft),transparent 36%)}.agent-replay-body>div{min-width:0}
  .travel-row{min-width:0;display:grid;grid-template-columns:auto minmax(110px,1fr) auto;align-items:center;gap:11px}.travel-actions{display:flex;flex-wrap:nowrap;gap:5px}.travel-btn{min-height:34px;border:1px solid var(--line);border-radius:var(--radius-sm);padding:4px 8px;color:var(--ink);background:var(--raised);cursor:pointer;font-size:10px;font-weight:700}.travel-btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--agent-accent) 48%,var(--line));background:var(--panel-2)}.travel-play{min-width:47px;color:var(--agent-accent);border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--line))}.travel-btn:disabled,.travel-speed:disabled,.travel-slider:disabled{opacity:.36;cursor:not-allowed}.travel-scrub{min-width:0;display:grid}.travel-slider{width:100%;accent-color:var(--agent-accent)}.travel-meta{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:7px}.travel-speed{min-height:34px;border:1px solid var(--line);border-radius:var(--radius-sm);padding:3px 6px;color:var(--ink);background:var(--raised);font-size:10px}.travel-state{min-width:76px;max-width:220px;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
  .agent-tabs{min-width:0;margin-top:16px}.agent-tablist{display:flex;align-items:flex-end;gap:4px;overflow-x:auto;padding:0 2px;border-bottom:1px solid var(--line);scrollbar-width:thin}.agent-tab{position:relative;min-height:42px;flex:0 0 auto;display:flex;align-items:center;gap:7px;border:0;padding:0 12px;color:var(--muted);background:transparent;cursor:pointer;font-size:11px;font-weight:700}.agent-tab:after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:transparent}.agent-tab:hover{color:var(--ink)}.agent-tab[aria-selected="true"]{color:var(--ink)}.agent-tab[aria-selected="true"]:after{background:var(--agent-accent)}.agent-tab small{min-width:18px;padding:3px 5px;border-radius:999px;background:var(--raised);color:var(--muted);font:8px/1 ui-monospace,monospace;text-align:center}
  .agent-tabpanels{min-width:0}.agent-tabpanel{min-width:0;padding:16px 0}.agent-tabpanel[hidden]{display:none!important}
  .agent-architecture-panel{display:grid;gap:15px;padding:18px}.agent-architecture-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.agent-architecture-head p{margin:0 0 5px;color:var(--agent-accent);font:800 8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}.agent-architecture-head h2{margin:0;font-size:18px;letter-spacing:-.02em}.agent-architecture-head>span{padding:5px 8px;border:1px solid color-mix(in srgb,var(--agent-accent) 35%,var(--line));border-radius:999px;color:var(--agent-accent);font:800 8px/1 ui-monospace,monospace}.agent-architecture-summary{max-width:820px;margin:0;color:var(--muted);font-size:11px;line-height:1.6}.agent-architecture-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}.agent-architecture-grid>div{display:grid;align-content:start;gap:5px;min-height:84px;padding:11px;border:1px solid var(--line-soft);border-radius:var(--radius-sm);background:var(--panel-2)}.agent-architecture-grid dt{color:var(--faint);font:800 8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.07em}.agent-architecture-grid dd{margin:0;color:var(--muted);font-size:10px;line-height:1.5}.agent-architecture-extensions{display:grid;gap:8px;padding-top:2px}.agent-architecture-extensions h3{margin:0;color:var(--faint);font:800 8px/1.2 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.agent-architecture-extensions ul{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}.agent-architecture-extensions li{padding:5px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--raised);font:8px/1 ui-monospace,monospace}
  .agent-status{min-height:32px;display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--panel);font:800 8px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.agent-status:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint)}.agent-status[data-tone="live"]{color:var(--green);border-color:color-mix(in srgb,var(--green) 42%,var(--line))}.agent-status[data-tone="live"]:before{background:var(--green)}.agent-status[data-tone="warning"]{color:var(--amber)}.agent-status[data-tone="warning"]:before{background:var(--amber)}.agent-status[data-tone="danger"]{color:var(--red)}.agent-status[data-tone="danger"]:before{background:var(--red)}
  .agent-message-thread{display:grid;gap:0;margin:0;padding:0 0 30px;list-style:none}.agent-message{min-width:0;display:grid;grid-template-columns:40px minmax(0,1fr);gap:12px;align-items:start;padding:9px 0}.agent-message-avatar{width:40px;height:40px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:9px;color:var(--text-primary);background:var(--surface-raised);font-size:13px;font-weight:700}.agent-message>article{min-width:0;width:min(900px,100%);max-width:100%}.agent-message>article>header{min-height:20px;display:flex;align-items:center;gap:8px}.agent-message>article>header strong{font-size:14px}.agent-message>article>header span,.agent-message>article>header time{color:var(--text-tertiary);font-size:11px}.agent-message>article>p{max-width:80ch;margin:4px 0 0;color:var(--text-primary);font-size:15px;line-height:1.55;overflow-wrap:anywhere;white-space:pre-wrap}
  @media(max-width:1180px){.agent-workspace-shell{grid-template-columns:230px minmax(360px,1fr) minmax(280px,320px)}.agent-workspace-shell[data-context-open="false"]{grid-template-columns:230px minmax(0,1fr)}}
  @media(max-width:960px){.agent-workspace-shell{grid-template-columns:230px minmax(0,1fr)}.agent-workspace-context{position:absolute;z-index:12;top:0;right:0;bottom:0;width:min(420px,calc(100vw - 230px));box-shadow:-22px 0 60px rgba(0,0,0,.3)}.agent-workspace-shell{position:relative}.agent-workspace-context[hidden]{display:none}}
  @media(max-width:820px){.agent-conversation-feed{padding:14px}.agent-composer-dock{padding:8px 13px 14px}.agent-workbench-head{padding-inline:13px}}
  @media(max-width:560px){.agent-room-identity{grid-template-columns:32px minmax(0,1fr);gap:10px}.agent-conversation-head small{display:none}.agent-room-header{padding:10px 12px}.coding-composer-help span:last-child{display:none}.agent-composer.coding-composer textarea{font-size:16px}}
  @media(max-width:1040px){.agent-replay-head{grid-template-columns:26px minmax(0,1fr) auto}.agent-replay-mark{width:26px;height:26px}.agent-replay-copy>span{display:none}}
  @media(max-width:820px){.agent-app{display:block}.agent-unified-page{display:grid;grid-template-rows:56px minmax(0,1fr)}.agent-unified-page>.agent-main{height:calc(100dvh - 56px);padding:0}.agent-top-nav{position:sticky;top:0;z-index:20;gap:12px;min-height:56px;padding:8px 12px}.top-navbar-brand small,.top-navbar-status{display:none}.top-navbar-links{margin-right:-4px}.top-navbar-link{min-height:40px;padding:0 9px}.agent-sidebar{position:static;width:auto;height:auto;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line)}.agent-product-note,.agent-sidebar-footer{display:none}.agent-sidebar .page-menu{display:flex;gap:5px;margin:0;overflow-x:auto}.agent-sidebar .page-menu-group,.agent-sidebar .page-menu-group ul{display:contents}.agent-sidebar .page-menu-label,.agent-sidebar .page-menu-marker{display:none}.agent-sidebar .page-menu a{grid-template-columns:minmax(0,1fr);min-width:max-content;min-height:34px;flex:0 0 auto;padding-inline:12px}.agent-sidebar .page-menu-copy small{display:none}.agent-main{padding:16px 12px 36px}.agent-page-header{align-items:flex-start}.agent-page-actions{align-self:flex-start}.agent-page-copy>p:last-child{font-size:12px}.agent-tab{min-height:40px;padding:0 10px}.agent-architecture-grid{grid-template-columns:1fr}.agent-room-header{grid-template-columns:1fr;align-items:start}.agent-workspace-shell{grid-template-columns:minmax(0,1fr)}.agent-workspace-rail{display:none}.agent-workspace-context{width:min(420px,100vw)}.travel-row{grid-template-columns:1fr}.travel-actions{overflow-x:auto;padding-bottom:2px}.travel-meta{justify-content:space-between}.travel-state{text-align:right}}
  @media(max-width:560px){.agent-top-nav{gap:8px;overflow:hidden}.agent-theme-control{display:none}.top-navbar-brand>span:last-child{display:none}.top-navbar-link{padding-inline:8px}.agent-page-header{display:grid;gap:12px}.agent-page-actions{justify-content:flex-start}.agent-tabpanel{padding-top:12px}.agent-replay{padding:10px}.agent-room-title{align-items:flex-start;flex-direction:column;gap:6px}.agent-room-header-actions{width:100%;padding-left:0}.agent-context-toggle{min-height:44px}.travel-actions{display:grid;grid-template-columns:repeat(5,minmax(0,1fr))}.travel-btn{min-width:0;min-height:44px;padding-inline:4px}.travel-speed{min-height:44px}}
  @media(pointer:coarse){.travel-btn,.travel-speed,.agent-sidebar .page-menu a,[data-workspace-context-close]{min-height:44px}}
   @media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
   ${themeCss()}
   @media(max-width:560px){.agent-top-nav .agent-theme-control{display:none}}
 `;

export const agentTabsScript = (nonce?: string): string => `${participantProfileDialogHtml({ editable: false })}<script type="module" src="/assets/roster-shell.js"${nonceAttribute(nonce)}></script><script${nonceAttribute(nonce)}>
  ${participantProfileViewClientSource}
  (()=>{
    const selector='[data-agent-tabs]';
    const workspaceSelector='[data-workspace-shell]';
    const owned=(root,childSelector)=>[...root.querySelectorAll(childSelector)].filter((node)=>node.closest(selector)===root);
    const activate=(root,id,focus=false,updateUrl=true)=>{
      const tabs=owned(root,'[data-agent-tab]');
      const panels=owned(root,'[data-agent-panel]');
      if(!tabs.some((tab)=>tab.getAttribute('data-agent-tab')===id))return;
      tabs.forEach((tab)=>{const selected=tab.getAttribute('data-agent-tab')===id;tab.setAttribute('aria-selected',String(selected));tab.setAttribute('tabindex',selected?'0':'-1');if(selected&&focus)tab.focus();});
      panels.forEach((panel)=>{panel.hidden=panel.getAttribute('data-agent-panel')!==id;});
      root.setAttribute('data-active-tab',id);
      if(updateUrl){const url=new URL(location.href);url.searchParams.set('tab',id);history.replaceState(history.state,'',url);}
    };
    const initRoot=(root)=>{
      if(root.getAttribute('data-tabs-ready')==='true')return;
      const tabs=owned(root,'[data-agent-tab]');if(!tabs.length)return;
      root.setAttribute('data-tabs-ready','true');
      const requested=new URL(location.href).searchParams.get('tab');
      const fallback=root.getAttribute('data-default-tab')||tabs[0].getAttribute('data-agent-tab');
      activate(root,tabs.some((tab)=>tab.getAttribute('data-agent-tab')===requested)?requested:fallback,false,false);
      root.addEventListener('click',(event)=>{
        const tab=event.target instanceof Element?event.target.closest('[data-agent-tab]'):null;
        if(!tab||tab.closest(selector)!==root)return;
        activate(root,tab.getAttribute('data-agent-tab'),false);
      });
      root.addEventListener('keydown',(event)=>{
        const tab=event.target instanceof Element?event.target.closest('[data-agent-tab]'):null;
        if(!tab||tab.closest(selector)!==root)return;
        const currentTabs=owned(root,'[data-agent-tab]');const index=currentTabs.indexOf(tab);if(index<0)return;
        let next=index;if(event.key==='ArrowRight')next=(index+1)%currentTabs.length;else if(event.key==='ArrowLeft')next=(index-1+currentTabs.length)%currentTabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=currentTabs.length-1;else return;
        event.preventDefault();activate(root,currentTabs[next].getAttribute('data-agent-tab'),true);
      });
    };
	    const initWorkspace=(root)=>{
      if(root.getAttribute('data-workspace-ready')==='true'||root.getAttribute('data-layout')==='coding')return;
      const room=root.closest('[data-slot="agent-room-workspace"]')||root.parentElement;
      const context=root.querySelector('[data-slot="workspace-context"]');
      if(!(context instanceof HTMLElement)||!room)return;
      root.setAttribute('data-workspace-ready','true');
      const toggles=[...room.querySelectorAll('[data-workspace-context-toggle]')];
      const setOpen=(open)=>{context.hidden=!open;toggles.forEach((button)=>button.setAttribute('aria-expanded',String(open)));root.setAttribute('data-context-open',String(open));};
      toggles.forEach((button)=>button.addEventListener('click',()=>setOpen(context.hidden)));
      context.querySelectorAll('[data-workspace-context-close]').forEach((button)=>button.addEventListener('click',()=>{setOpen(false);const trigger=toggles[0];if(trigger instanceof HTMLElement)trigger.focus();}));
	      setOpen(false);
	    };
	    const initComposer=(form)=>{
	      if(!(form instanceof HTMLFormElement)||form.getAttribute('data-composer-ready')==='true'||!form.classList.contains('agent-composer'))return;
	      form.setAttribute('data-composer-ready','true');
	      const input=form.querySelector('[data-slot="composer-input"]');
	      if(!(input instanceof HTMLTextAreaElement))return;
	      input.addEventListener('keydown',(event)=>{if(event.key!=='Enter'||event.shiftKey||event.isComposing)return;event.preventDefault();if(form.checkValidity())form.requestSubmit();else form.reportValidity();});
	    };
	    const init=(scope)=>{
	      if(scope instanceof Element&&scope.matches(selector))initRoot(scope);
	      if(scope instanceof Element&&scope.matches(workspaceSelector))initWorkspace(scope);
	      if(scope instanceof Element&&scope.matches('[data-composer-kind="workspace"]'))initComposer(scope);
	      if('querySelectorAll' in scope)scope.querySelectorAll(selector).forEach(initRoot);
	      if('querySelectorAll' in scope)scope.querySelectorAll(workspaceSelector).forEach(initWorkspace);
	      if('querySelectorAll' in scope)scope.querySelectorAll('[data-composer-kind="workspace"]').forEach(initComposer);
	    };
    const start=()=>{
      init(document);
      const target=document.documentElement;if(!target)return;
      new MutationObserver((records)=>records.forEach((record)=>record.addedNodes.forEach((node)=>{if(node instanceof Element)init(node);}))).observe(target,{childList:true,subtree:true});
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  })();
</script>`;
