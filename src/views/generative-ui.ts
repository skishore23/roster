import { esc, truncate } from "./agent-framework.js";

export type GenerativeUiTone = "neutral" | "info" | "success" | "warning" | "danger";

export type GenerativeUiFlowState =
  | "neutral"
  | "proposed"
  | "supported"
  | "resolved"
  | "unresolved"
  | "blocked";

export type GenerativeUiFlowPath = {
  readonly subject: string;
  readonly outcome: string;
  readonly state: GenerativeUiFlowState;
  readonly stateLabel?: string;
  readonly meta?: string;
};

export type GenerativeUiFact = {
  readonly label: string;
  readonly values: ReadonlyArray<string>;
};

export type GenerativeUiDetailItem = {
  readonly title: string;
  readonly meta?: string;
  readonly body?: string;
  readonly facts?: ReadonlyArray<GenerativeUiFact>;
};

export type GenerativeUiDetailSection = {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
};

export type GenerativeUiDisclosure = {
  readonly label: string;
  readonly metrics?: ReadonlyArray<string>;
  readonly summary?: string;
  readonly items?: ReadonlyArray<GenerativeUiDetailItem>;
  readonly sections?: ReadonlyArray<GenerativeUiDetailSection>;
};

export type GenerativeUiCard = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly tone?: GenerativeUiTone;
  readonly badge?: {
    readonly label: string;
    readonly tone: GenerativeUiTone;
  };
  readonly summary?: string;
  readonly flow?: {
    readonly label: string;
    readonly paths: ReadonlyArray<GenerativeUiFlowPath>;
    readonly visiblePathLimit?: number;
  };
  readonly notice?: {
    readonly tone: GenerativeUiTone;
    readonly text: string;
  };
  readonly disclosure?: GenerativeUiDisclosure;
};

export type GenerativeUiReply = {
  readonly id: string;
  readonly action: string;
  readonly title: string;
  readonly description: string;
  readonly prompts?: ReadonlyArray<string>;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly submitLabel?: string;
  readonly help?: string;
  readonly maxLength?: number;
  readonly hiddenFields?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
};

const MAX_VISIBLE_PATHS = 6;
const MAX_DETAIL_ITEMS = 12;
const MAX_DETAIL_SECTIONS = 6;
const MAX_SECTION_ITEMS = 12;
const MAX_FACTS = 8;
const MAX_FACT_VALUES = 12;

const safeToken = (value: string, label: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalized)) {
    throw new Error(`Generative UI ${label} must be a lowercase token`);
  }
  return normalized;
};

const safeSameOriginAction = (value: string): string => {
  const normalized = value.trim();
  if (!/^\/[A-Za-z0-9/_?&=.%+-]*$/.test(normalized) || normalized.startsWith("//")) {
    throw new Error("Generative UI actions must use a same-origin path");
  }
  return normalized;
};

const safeFieldName = (value: string): string => {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(normalized)) {
    throw new Error("Generative UI field names must be bounded tokens");
  }
  return normalized;
};

const flowHtml = (flow: NonNullable<GenerativeUiCard["flow"]>): string => {
  if (flow.paths.length === 0) return "";
  const requestedLimit = flow.visiblePathLimit ?? 3;
  const visibleLimit = Math.max(1, Math.min(MAX_VISIBLE_PATHS, Math.floor(requestedLimit)));
  const visiblePaths = flow.paths.slice(0, visibleLimit);
  const omitted = flow.paths.length - visiblePaths.length;
  return `<section class="generative-ui-flow" aria-label="${esc(flow.label)}">
    <header><strong>Decision Map</strong><small>${flow.paths.length} path${flow.paths.length === 1 ? "" : "s"}</small></header>
    <ol>${visiblePaths.map((path) => `<li data-state="${safeToken(path.state, "flow state")}"><span class="generative-ui-flow-subject"><small>Subject</small><strong translate="no" title="${esc(path.subject)}">${esc(truncate(path.subject, 160))}</strong></span><i aria-hidden="true">→</i><span class="generative-ui-flow-outcome"><small>${esc(path.stateLabel ?? path.state)}</small><strong title="${esc(path.outcome)}">${esc(truncate(path.outcome, 240))}</strong>${path.meta ? `<em>${esc(truncate(path.meta, 240))}</em>` : ""}</span></li>`).join("")}</ol>
    ${omitted ? `<p>+${omitted} more path${omitted === 1 ? "" : "s"} in the full record</p>` : ""}
  </section>`;
};

const detailItemHtml = (item: GenerativeUiDetailItem): string => {
  const facts = (item.facts ?? []).slice(0, MAX_FACTS);
  return `<li><header><strong>${esc(truncate(item.title, 240))}</strong>${item.meta ? `<small>${esc(truncate(item.meta, 240))}</small>` : ""}</header>${item.body ? `<p>${esc(truncate(item.body, 2_000))}</p>` : ""}${facts.length ? `<dl>${facts.map((fact) => `<div><dt>${esc(truncate(fact.label, 80))}</dt><dd>${fact.values.slice(0, MAX_FACT_VALUES).length > 1 ? `<ul>${fact.values.slice(0, MAX_FACT_VALUES).map((value) => `<li>${esc(truncate(value, 1_000))}</li>`).join("")}</ul>` : esc(truncate(fact.values[0] ?? "", 1_000))}</dd></div>`).join("")}</dl>` : ""}</li>`;
};

const disclosureHtml = (cardId: string, disclosure: GenerativeUiDisclosure): string => {
  const items = (disclosure.items ?? []).slice(0, MAX_DETAIL_ITEMS);
  const sections = (disclosure.sections ?? []).slice(0, MAX_DETAIL_SECTIONS);
  const metrics = (disclosure.metrics ?? []).slice(0, 6).join(" · ");
  return `<details class="generative-ui-disclosure" data-details-key="generative-ui-${cardId}"><summary data-focus-key="generative-ui-${cardId}-disclosure"><span>${esc(disclosure.label)}</span>${metrics ? `<small>${esc(metrics)}</small>` : ""}</summary><div>${disclosure.summary ? `<p class="generative-ui-disclosure-summary">${esc(truncate(disclosure.summary, 2_000))}</p>` : ""}${items.length ? `<ol class="generative-ui-detail-items">${items.map(detailItemHtml).join("")}</ol>` : ""}${sections.map((section) => `<section class="generative-ui-detail-section"><strong>${esc(truncate(section.title, 120))}</strong><ul>${section.items.slice(0, MAX_SECTION_ITEMS).map((item) => `<li>${esc(truncate(item, 1_000))}</li>`).join("")}</ul></section>`).join("")}</div></details>`;
};

export const generativeUiCardHtml = (card: GenerativeUiCard): string => {
  const id = safeToken(card.id, "card id");
  const kind = safeToken(card.kind, "card kind");
  const tone = card.tone ?? "neutral";
  return `<article class="generative-ui-card" data-generative-ui-card="${id}" data-generative-ui-kind="${kind}" data-tone="${safeToken(tone, "tone")}" aria-label="${esc(card.label)}">${card.summary || card.badge ? `<p class="generative-ui-summary">${card.badge ? `<strong data-tone="${safeToken(card.badge.tone, "badge tone")}">${esc(card.badge.label)}</strong>` : ""}${card.summary ? `<span>${esc(truncate(card.summary, 1_200))}</span>` : ""}</p>` : ""}${card.flow ? flowHtml(card.flow) : ""}${card.notice ? `<p class="generative-ui-notice" data-tone="${safeToken(card.notice.tone, "notice tone")}" role="note">${esc(truncate(card.notice.text, 1_200))}</p>` : ""}${card.disclosure ? disclosureHtml(id, card.disclosure) : ""}</article>`;
};

export const generativeUiReplyHtml = (reply: GenerativeUiReply): string => {
  const id = safeToken(reply.id, "reply id");
  const action = safeSameOriginAction(reply.action);
  const maxLength = Math.max(1, Math.min(20_000, Math.floor(reply.maxLength ?? 20_000)));
  const prompts = (reply.prompts ?? []).slice(0, 8);
  const fields = (reply.hiddenFields ?? []).slice(0, 12);
  return `<section class="generative-ui-reply" data-generative-ui-reply="${id}" aria-labelledby="generative-ui-${id}-title">
    <header><span><i aria-hidden="true"></i><strong id="generative-ui-${id}-title">${esc(reply.title)}</strong></span><small>Reply requested</small></header>
    <p>${esc(truncate(reply.description, 1_200))}</p>
    ${prompts.length ? `<ol>${prompts.map((prompt) => `<li>${esc(truncate(prompt, 1_000))}</li>`).join("")}</ol>` : ""}
    <form action="${esc(action)}" method="post" data-generative-ui-reply-form data-generative-ui-state-key="${id}">
      ${fields.map((field) => `<input type="hidden" name="${esc(safeFieldName(field.name))}" value="${esc(field.value)}"/>`).join("")}
      <label for="generative-ui-${id}-input">${esc(reply.inputLabel)}</label>
      <textarea id="generative-ui-${id}-input" name="objective" maxlength="${maxLength}" required rows="2" autocomplete="off" placeholder="${esc(reply.placeholder)}" data-generative-ui-reply-input data-focus-key="generative-ui-${id}-input"></textarea>
      <footer><p>${esc(reply.help ?? "Your reply is recorded through the existing durable conversation.")}</p><button type="submit">${esc(reply.submitLabel ?? "Reply")}</button></footer>
      <p class="generative-ui-reply-status" role="status" aria-live="polite" aria-atomic="true" data-generative-ui-reply-status></p>
    </form>
  </section>`;
};

export const generativeUiCss = (): string => `.generative-ui-card{max-width:76ch;margin-top:5px}.generative-ui-card>.generative-ui-summary{display:flex;align-items:baseline;gap:8px;margin:5px 0 0;color:var(--gui-text,var(--text-primary));font-size:12px;line-height:1.55}.generative-ui-summary>span{min-width:0}.generative-ui-summary>strong{flex:none;color:var(--gui-success,var(--success));font-size:8px;letter-spacing:.055em;text-transform:uppercase}.generative-ui-summary>strong[data-tone="warning"]{color:var(--gui-warning,var(--warning))}.generative-ui-summary>strong[data-tone="danger"]{color:var(--gui-danger,var(--danger))}
.generative-ui-flow{margin-top:9px;overflow:hidden;border:1px solid var(--gui-border,var(--border-subtle));border-radius:var(--gui-card-radius,var(--radius-card));background:var(--gui-inset,var(--surface-inset))}.generative-ui-flow>header{min-height:32px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 10px;border-bottom:1px solid var(--gui-border,var(--border-subtle))}.generative-ui-flow>header strong{color:var(--gui-muted,var(--text-secondary));font-size:8px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.generative-ui-flow>header small{color:var(--gui-faint,var(--text-tertiary));font:8px/1.3 var(--font-mono,ui-monospace,monospace)}.generative-ui-flow>ol{display:grid;margin:0;padding:0;list-style:none}.generative-ui-flow>ol>li{min-width:0;display:grid;grid-template-columns:minmax(96px,138px) 18px minmax(0,1fr);gap:7px;align-items:stretch;padding:8px 10px;border-bottom:1px solid var(--gui-border,var(--border-subtle))}.generative-ui-flow>ol>li:last-child{border-bottom:0}.generative-ui-flow>ol>li>i{display:grid;place-items:center;color:var(--gui-faint,var(--text-tertiary));font-style:normal}.generative-ui-flow-subject,.generative-ui-flow-outcome{min-width:0;display:grid;align-content:center;gap:2px;padding:7px 8px;border:1px solid var(--gui-border,var(--border-subtle));border-radius:var(--gui-control-radius,var(--radius-control));background:var(--gui-panel,var(--surface-panel))}.generative-ui-flow-outcome{border-left:2px solid var(--gui-accent,var(--accent))}.generative-ui-flow [data-state="resolved"]>.generative-ui-flow-outcome,.generative-ui-flow [data-state="supported"]>.generative-ui-flow-outcome{border-left-color:var(--gui-success,var(--success))}.generative-ui-flow [data-state="unresolved"]>.generative-ui-flow-outcome,.generative-ui-flow [data-state="blocked"]>.generative-ui-flow-outcome{border-left-color:var(--gui-warning,var(--warning))}.generative-ui-flow-subject small,.generative-ui-flow-outcome small{color:var(--gui-faint,var(--text-tertiary));font-size:7px;font-weight:700;letter-spacing:.055em;text-transform:uppercase}.generative-ui-flow-subject strong,.generative-ui-flow-outcome strong{min-width:0;overflow:hidden;color:var(--gui-text,var(--text-primary));font-size:9px;font-weight:650;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}.generative-ui-flow-outcome em{min-width:0;overflow:hidden;color:var(--gui-faint,var(--text-tertiary));font:7px/1.35 var(--font-mono,ui-monospace,monospace);font-style:normal;text-overflow:ellipsis;white-space:nowrap}.generative-ui-card .generative-ui-flow>p{margin:0;padding:7px 10px;border-top:1px solid var(--gui-border,var(--border-subtle));color:var(--gui-faint,var(--text-tertiary));font:8px/1.4 var(--font-mono,ui-monospace,monospace)}
.generative-ui-card>.generative-ui-notice{margin:7px 0 0;padding:7px 9px;border:1px solid var(--gui-border,var(--border-subtle));border-radius:var(--gui-control-radius,var(--radius-control));color:var(--gui-muted,var(--text-secondary));background:var(--gui-inset,var(--surface-inset));font-size:9px;line-height:1.45}.generative-ui-notice[data-tone="warning"]{border-color:var(--gui-warning-border,var(--warning-border));color:var(--gui-warning,var(--warning));background:var(--gui-warning-surface,var(--warning-surface))}.generative-ui-notice[data-tone="danger"]{border-color:var(--gui-danger-border,var(--danger-border));color:var(--gui-danger,var(--danger));background:var(--gui-danger-surface,var(--danger-surface))}.generative-ui-notice[data-tone="success"]{border-color:var(--gui-success,var(--success));color:var(--gui-success,var(--success))}
.generative-ui-disclosure{margin-top:7px;border-bottom:1px solid var(--gui-border,var(--border-subtle))}.generative-ui-disclosure>summary{min-height:32px;display:flex;align-items:center;gap:8px;padding:0 2px;color:var(--gui-muted,var(--text-secondary));cursor:pointer;font-size:9px;font-weight:650;list-style:none}.generative-ui-disclosure>summary::-webkit-details-marker{display:none}.generative-ui-disclosure>summary:before{content:"›";color:var(--gui-faint,var(--text-tertiary));font-size:13px;line-height:1;transition:transform .16s ease}.generative-ui-disclosure[open]>summary:before{transform:rotate(90deg)}.generative-ui-disclosure>summary:hover,.generative-ui-disclosure[open]>summary{color:var(--gui-text,var(--text-primary))}.generative-ui-disclosure>summary small{margin-left:auto;color:var(--gui-faint,var(--text-tertiary));font:8px/1.3 var(--font-mono,ui-monospace,monospace);text-align:right}.generative-ui-disclosure>div{display:grid;gap:12px;padding:11px 0 13px;border-top:1px solid var(--gui-border,var(--border-subtle))}.generative-ui-card .generative-ui-disclosure-summary{margin:0;color:var(--gui-muted,var(--text-secondary));font-size:10px;line-height:1.55}.generative-ui-detail-items{display:grid;gap:8px;margin:0;padding:0;list-style:none}.generative-ui-detail-items>li{padding:10px;border:1px solid var(--gui-border,var(--border-subtle));border-radius:var(--gui-control-radius,var(--radius-control));background:var(--gui-panel,var(--surface-panel))}.generative-ui-detail-items>li>header{min-height:0;display:flex;align-items:center;justify-content:space-between;gap:10px}.generative-ui-detail-items>li>header strong{font-size:10px}.generative-ui-detail-items>li>header small{color:var(--gui-faint,var(--text-tertiary));font:8px/1.3 var(--font-mono,ui-monospace,monospace);white-space:nowrap}.generative-ui-detail-items>li>p{margin:6px 0 0;color:var(--gui-text,var(--text-primary));font-size:11px;line-height:1.5}.generative-ui-detail-items dl{display:grid;gap:7px;margin:9px 0 0}.generative-ui-detail-items dl>div{display:grid;grid-template-columns:68px minmax(0,1fr);gap:9px;padding-top:7px;border-top:1px solid var(--gui-border,var(--border-subtle))}.generative-ui-detail-items dt{color:var(--gui-faint,var(--text-tertiary));font-size:7px;font-weight:700;letter-spacing:.055em;text-transform:uppercase}.generative-ui-detail-items dd{min-width:0;margin:0;color:var(--gui-muted,var(--text-secondary));font-size:9px;line-height:1.5;overflow-wrap:anywhere}.generative-ui-detail-items dd ul{display:grid;gap:3px;margin:0;padding-left:14px}.generative-ui-detail-section{padding-top:2px}.generative-ui-detail-section>strong{display:block;margin:0 0 6px;color:var(--gui-faint,var(--text-tertiary));font-size:8px;font-weight:700;letter-spacing:.055em;text-transform:uppercase}.generative-ui-detail-section ul{display:grid;gap:7px;margin:0;padding-left:16px;color:var(--gui-muted,var(--text-secondary));font-size:9px;line-height:1.5}
.generative-ui-reply{max-width:76ch;margin-left:42px;padding:11px;border:1px solid var(--gui-warning-border,var(--warning-border));border-radius:var(--gui-card-radius,var(--radius-card));background:var(--gui-warning-surface,var(--warning-surface))}.generative-ui-reply>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.generative-ui-reply>header>span{display:flex;align-items:center;gap:7px}.generative-ui-reply>header i{width:7px;height:7px;border-radius:50%;background:var(--gui-warning,var(--warning))}.generative-ui-reply>header strong{font-size:10px}.generative-ui-reply>header small{color:var(--gui-warning,var(--warning));font:8px/1.2 var(--font-mono,ui-monospace,monospace)}.generative-ui-reply>p{margin:7px 0;color:var(--gui-muted,var(--text-secondary));font-size:10px;line-height:1.5}.generative-ui-reply>ol{display:grid;gap:4px;margin:7px 0;padding-left:18px;color:var(--gui-text,var(--text-primary));font-size:9px;line-height:1.5}.generative-ui-reply form{display:grid;gap:7px;margin-top:9px}.generative-ui-reply form>label{color:var(--gui-faint,var(--text-tertiary));font-size:8px;font-weight:700;letter-spacing:.055em;text-transform:uppercase}.generative-ui-reply textarea{width:100%;min-height:64px;max-height:180px;resize:vertical;padding:9px;border:1px solid var(--gui-border-strong,var(--border-strong));border-radius:var(--gui-control-radius,var(--radius-control));color:var(--gui-text,var(--text-primary));background:var(--gui-raised,var(--surface-raised));font-size:11px;line-height:1.5}.generative-ui-reply textarea::placeholder{color:var(--gui-faint,var(--text-tertiary))}.generative-ui-reply form>footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.generative-ui-reply form>footer p{margin:0;color:var(--gui-faint,var(--text-tertiary));font-size:8px;line-height:1.45}.generative-ui-reply button{min-height:30px;flex:none;padding:0 12px;border:0;border-radius:var(--gui-control-radius,var(--radius-control));color:var(--gui-action-text,var(--action-primary-foreground));background:var(--gui-action,var(--action-primary));cursor:pointer;font-size:9px;font-weight:700}.generative-ui-reply button:hover{background:var(--gui-action-hover,var(--action-primary-hover))}.generative-ui-reply[data-state="sending"] button{opacity:.55;cursor:wait}.generative-ui-reply-status{min-height:0;margin:0!important;color:var(--gui-faint,var(--text-tertiary))!important;font-size:8px!important}
@media(max-width:560px){.generative-ui-flow>ol>li{grid-template-columns:minmax(0,1fr);gap:5px}.generative-ui-flow>ol>li>i{height:10px;transform:rotate(90deg)}.generative-ui-disclosure>summary{align-items:flex-start;padding-block:8px}.generative-ui-disclosure>summary small{white-space:normal}.generative-ui-reply{margin-left:0}.generative-ui-reply form>footer{align-items:stretch;flex-direction:column}.generative-ui-reply button{min-height:44px}}
@media(prefers-reduced-motion:reduce){.generative-ui-disclosure>summary:before{transition:none}}`;
