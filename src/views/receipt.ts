// ============================================================================
// Receipt Browser UI - chat-first inspector
// ============================================================================

import { MiniGFM } from "@oblivionocean/minigfm";
import type { InspectorEvent, InspectorMode } from "../modules/inspector.js";
import { esc } from "./agent-framework.js";
import { themeBootstrapScript } from "./theme.js";
import {
  agentComposerHtml,
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
import { rosterRealtimeBootHtml, rosterRealtimeStatusHtml, type RosterRealtimeBootConfig } from "./roster-realtime.js";

export type ReceiptStreamInfo = {
  readonly streamId: string;
  readonly kind: string;
  readonly receiptCount: bigint;
  readonly parentStreamId?: string;
  readonly updatedAtMs: number;
};

export type ReceiptEvidenceItem = {
  readonly seq: bigint;
  readonly occurredAtMs: bigint;
  readonly hash: string;
  readonly prevHash: string;
  readonly body: Readonly<Record<string, unknown>>;
};

export type InspectorEventReceipt = {
  readonly ts: number;
  readonly body: InspectorEvent;
};

export type ReceiptInspectorTool = {
  readonly name: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly error?: string;
};

export type ReceiptInspectorSnapshot = {
  readonly runId?: string;
  readonly status: "idle" | "running" | "failed" | "completed";
  readonly mode?: string;
  readonly question?: string;
  readonly analysis?: string;
  readonly note?: string;
  readonly tools?: ReadonlyArray<ReceiptInspectorTool>;
  readonly agents?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly status?: "idle" | "running" | "failed" | "completed";
    readonly note?: string;
  }>;
  readonly context?: {
    readonly name: string;
    readonly total: number;
    readonly shown: number;
    readonly order: "asc" | "desc";
    readonly limit: number;
  };
  readonly timeline?: {
    readonly depth: number;
    readonly buckets: ReadonlyArray<{ readonly label: string; readonly count: number }>;
  };
};

export type ReceiptChatItem = {
  readonly id: string;
  readonly role: "user" | "agent" | "system";
  readonly label: string;
  readonly content: string;
  readonly status?: "running" | "failed" | "completed";
  readonly kind?: "analyze" | "improve" | "timeline" | "qa";
  readonly groupId?: string;
};

const formatTime = (ts: number): string => new Date(ts).toLocaleString();

const md = new MiniGFM();

const truncate = (text: string, max = 160): string => {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
};

const renderMarkdown = (raw: string): string => {
  const text = raw.trim();
  if (!text) return `<div class="empty">No analysis yet.</div>`;
  return md.parse(text);
};

const formatInspectorAgentName = (agentName?: string, mode?: InspectorMode): string => {
  if (agentName?.trim()) return agentName.trim();
  if (mode === "qa") return "Q&A";
  if (mode === "improve") return "Improver";
  if (mode === "timeline") return "Chronologist";
  if (mode === "analyze") return "Analyst";
  return "Inspector";
};

const mapInspectorAgentId = (agentId?: string, mode?: InspectorMode, runId?: string): string => {
  if (agentId) return agentId;
  if (mode === "analyze") return "analyst";
  if (mode === "improve") return "improver";
  if (mode === "timeline") return "chronologist";
  if (mode === "qa") return "respondent";
  return runId ?? "inspector";
};

export const buildReceiptInspectorSnapshot = (
  receipts: ReadonlyArray<InspectorEventReceipt>,
  stream: string,
): ReceiptInspectorSnapshot => {
  const contexts = receipts.filter((receipt): receipt is InspectorEventReceipt & {
    readonly body: InspectorEvent & { readonly type: "context.set" };
  } => receipt.body.type === "context.set" && receipt.body.source.kind === "stream" && receipt.body.source.name === stream);
  const latestContext = contexts.at(-1)?.body;
  if (!latestContext) return { status: "idle" };

  const groupId = latestContext.groupId ?? latestContext.runId;
  const snapshot: {
    status: ReceiptInspectorSnapshot["status"];
    runId?: string;
    context?: ReceiptInspectorSnapshot["context"];
    question?: string;
    mode?: string;
    analysis?: string;
    note?: string;
    timeline?: ReceiptInspectorSnapshot["timeline"];
    tools?: ReceiptInspectorSnapshot["tools"];
    agents?: ReceiptInspectorSnapshot["agents"];
  } = {
    status: "idle",
    runId: latestContext.runId,
    context: {
      name: latestContext.source.name,
      total: latestContext.total,
      shown: latestContext.shown,
      order: latestContext.order,
      limit: latestContext.limit,
    },
  };
  const tools: ReceiptInspectorTool[] = [];
  const agents = new Map<string, {
    id: string;
    name: string;
    status?: ReceiptInspectorSnapshot["status"];
    note?: string;
  }>();

  for (const receipt of receipts) {
    const event = receipt.body;
    if (!("runId" in event) || (event.groupId ?? event.runId) !== groupId) continue;
    const mode = "mode" in event ? event.mode : undefined;
    const id = mapInspectorAgentId(event.agentId, mode, event.runId);
    const agent = agents.get(id) ?? { id, name: formatInspectorAgentName(event.agentName, mode) };
    if (event.type === "question.set") {
      snapshot.question ??= event.question;
      snapshot.mode ??= event.mode;
    } else if (event.type === "analysis.set") {
      snapshot.analysis = event.content;
    } else if (event.type === "run.status") {
      agent.status = event.status;
      if (event.note) agent.note = event.note;
    } else if (event.type === "timeline.set") {
      snapshot.timeline = { depth: event.depth, buckets: [...event.buckets] };
    } else if (event.type === "tool.called") {
      tools.push({ name: event.tool, summary: event.summary, durationMs: event.durationMs, error: event.error });
    }
    agents.set(id, agent);
  }

  const statuses = [...agents.values()].map((agent) => agent.status);
  if (statuses.includes("running")) snapshot.status = "running";
  else if (statuses.includes("failed")) snapshot.status = "failed";
  else if (statuses.includes("completed")) snapshot.status = "completed";
  else if (snapshot.analysis) snapshot.status = "completed";
  if (tools.length) snapshot.tools = tools;
  if (agents.size) snapshot.agents = [...agents.values()];
  if (snapshot.status === "failed") snapshot.note = [...agents.values()].find((agent) => agent.status === "failed")?.note;
  return snapshot;
};

export const buildReceiptChatItems = (
  receipts: ReadonlyArray<InspectorEventReceipt>,
  stream: string,
  maxGroups = 6,
): ReceiptChatItem[] => {
  type AgentState = {
    readonly agentId: string;
    agentName: string;
    mode?: InspectorMode;
    analysis?: string;
    status?: "running" | "failed" | "completed";
    note?: string;
    kind?: ReceiptChatItem["kind"];
    updatedAt: number;
  };
  type GroupState = {
    readonly groupId: string;
    source?: string;
    question?: string;
    updatedAt: number;
    readonly agents: Map<string, AgentState>;
  };
  const groups = new Map<string, GroupState>();
  for (const receipt of receipts) {
    const event = receipt.body;
    if (!("runId" in event)) continue;
    const groupId = event.groupId ?? event.runId;
    const group: GroupState = groups.get(groupId) ?? {
      groupId,
      updatedAt: receipt.ts,
      agents: new Map<string, AgentState>(),
    };
    group.updatedAt = Math.max(group.updatedAt, receipt.ts);
    if (event.type === "context.set") group.source = event.source.name;
    if (event.type === "question.set") group.question = event.question;
    const mode = "mode" in event ? event.mode : undefined;
    const agentId = mapInspectorAgentId(event.agentId, mode, event.runId);
    const agent = group.agents.get(agentId) ?? {
      agentId,
      agentName: formatInspectorAgentName(event.agentName, mode),
      mode,
      kind: mode,
      updatedAt: receipt.ts,
    };
    agent.updatedAt = Math.max(agent.updatedAt, receipt.ts);
    if (event.type === "analysis.set") agent.analysis = event.content;
    if (event.type === "run.status") {
      agent.status = event.status;
      if (event.note) agent.note = event.note;
    }
    if (event.type === "question.set") agent.mode = event.mode;
    group.agents.set(agentId, agent);
    groups.set(groupId, group);
  }

  const recent = [...groups.values()]
    .filter((group) => group.source === stream)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, maxGroups);
  const items: ReceiptChatItem[] = [];
  for (const group of recent) {
    if (group.question) items.push({
      id: `${group.groupId}-question`,
      role: "user",
      label: "You",
      content: group.question,
      groupId: group.groupId,
    });
    for (const agent of [...group.agents.values()].sort((left, right) => left.updatedAt - right.updatedAt)) {
      items.push({
        id: `${group.groupId}-${agent.agentId}`,
        role: "agent",
        label: agent.agentName,
        content: agent.analysis ?? (agent.status === "running" ? "Inspector is working…" : agent.note ?? "Waiting for output…"),
        status: agent.status,
        kind: agent.kind,
        groupId: group.groupId,
      });
    }
  }
  return items;
};

export const receiptShell = (opts: {
  readonly selected?: string;
  readonly limit: number;
  readonly order: "asc" | "desc";
  readonly depth: number;
  readonly at?: number | null;
  readonly realtime?: { readonly boot: RosterRealtimeBootConfig; readonly nonce?: string };
}): string => {
  const { selected, limit, order, depth, at = null, realtime } = opts;
  const selectedName = selected ?? "";
  const replayControls = agentReplayClientControlsHtml({
    id: "receipt-travel",
    adapter: "replay",
    emptyLabel: selected ? "Synchronizing durable history…" : "Loading workspace streams…",
  });
  const questionCard = agentComposerHtml({
    id: "replay-question-composer",
    inputId: "receipt-question",
    title: "Ask the replay room",
    description: selected ? "The analysis team answers against the selected durable frontier." : "Select a run before asking the analysis team.",
    action: "/replay/inspect",
    inputName: "question",
    inputLabel: "Talk with the replay analysis room",
    placeholder: "Ask the room about a decision, handoff, conflict, or merge…",
    submitLabel: "Send to room",
    hiddenHtml: `<input type="hidden" id="receipt-analysis-stream" name="stream" value="${esc(selectedName)}" /><input type="hidden" name="order" value="${order}" /><input type="hidden" name="limit" value="${limit}" /><input type="hidden" id="receipt-analysis-at" name="at" value="${esc(String(at ?? ""))}" />`,
    toolsHtml: `<label class="agent-composer-select"><span class="sr-only">Analysis depth</span><select name="depth" aria-label="Analysis depth"><option value="1" ${depth === 1 ? "selected" : ""}>Depth 1</option><option value="2" ${depth === 2 ? "selected" : ""}>Depth 2</option><option value="3" ${depth === 3 ? "selected" : ""}>Depth 3</option></select></label>`,
    disabled: !selected,
  });
  const replayTabs = agentTabsHtml({
    id: "replay-tabs",
    label: "Replay room views",
    tabs: [
      { id: "runs", label: "Runs", content: `<div id="receipt-folds" class="fold-list" aria-live="polite"><div class="empty">Synchronizing workspace streams…</div></div>` },
      { id: "timeline", label: "Timeline", content: `<div id="receipt-timeline"><div class="empty">Synchronizing timeline…</div></div>` },
      { id: "evidence", label: "Evidence", content: `<div class="side" id="receipt-side"><div class="empty">Synchronizing evidence…</div></div>` },
      { id: "history", label: "History", content: agentReplayBarHtml({ id: "receipt-replay-bar", title: "Receipt history", description: selected ? "Scrub the selected run before asking about that exact frontier." : "Select a run to replay its durable receipt history.", content: replayControls }) },
    ],
  });
  const replayRoom = agentWorkspaceShellHtml({
    id: "replay-workspace",
    room: {
      eyebrow: "Analysis room",
      title: "#replay-room",
      description: "A continuing conversation with the agents who reconstruct decisions, chronology, conflicts, and evidence from exact receipts.",
      state: selected ? "active" : "open",
      roster: staticRoomRoster({
        roomId: "replay-room",
        summary: selected ? `Four members are reconstructing ${selectedName}` : "Choose a run to begin",
        members: [
        { name: "You", role: "Investigator", kind: "human", presence: "present" },
        { name: "Analyst", role: "Decision tracing", kind: "agent", presence: selected ? "working" : "present" },
        { name: "Chronologist", role: "Sequence", kind: "agent", presence: "present" },
        { name: "Improver", role: "Failure analysis", kind: "agent", presence: "present" },
        ],
      }),
    },
    conversation: `<div id="receipt-chat" class="chat-stack" aria-live="polite"><div class="empty">Synchronizing room conversation…</div></div>`,
    composer: questionCard,
    context: replayTabs,
    contextLabel: "Replay evidence and history",
    artifact: "Exact receipt frontier",
    acceptance: "Hash-linked deterministic reconstruction",
    coordinationLabel: "Deterministic receipt analysis",
  });

  return `<!doctype html>
<html lang="en">
<head>${themeBootstrapScript()}
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#090c11" />
  <title>Roster - Replay</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
  <script>
    (function () {
      const renderMath = function (root) {
        const target = root instanceof HTMLElement ? root : document.body;
        const renderMathInElement = window.renderMathInElement;
        if (typeof renderMathInElement !== "function") return;
        target.querySelectorAll(".chat-bubble, .result-body, .summary-body").forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          try {
            renderMathInElement(node, {
              delimiters: [
                { left: "$$", right: "$$", display: true },
                { left: "\\\\[", right: "\\\\]", display: true },
                { left: "$", right: "$", display: false },
                { left: "\\\\(", right: "\\\\)", display: false },
              ],
              throwOnError: false,
            });
          } catch (_err) {}
        });
      };

      window.receiptRenderMath = renderMath;
      document.addEventListener("DOMContentLoaded", function () {
        renderMath(document.body);
      });
      document.addEventListener("roster:panel-rendered", function (evt) {
        const target = evt && evt.target instanceof HTMLElement ? evt.target : document.body;
        renderMath(target);
      });
    })();
  </script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0c0f13;
      --ink: #eef2f5;
      --muted: #929daa;
      --line: #2a3139;
      --panel: #11151a;
      --raised: #171c22;
      --blue: #64b5f6;
      --green: #57d58a;
      --amber: #f2bc5a;
      --red: #ef6b73;
      --accent: #6bdcff;
      --accent-2: #ffcc80;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--ink);
      background: var(--bg);
      min-height: 100vh;
    }
    .skip-link { position:fixed; z-index:20; top:8px; left:8px; padding:7px 10px; border-radius:4px; color:var(--ink); background:var(--raised); transform:translateY(-160%); }
    .skip-link:focus-visible { transform:translateY(0); outline:2px solid var(--blue); outline-offset:2px; }
    .app {
      display: grid;
      grid-template-columns: 250px minmax(0, 1fr) 320px;
      min-height: 100vh;
      min-width: 0;
    }
    .sidebar {
      min-width: 0;
      border-right: 1px solid var(--line);
      padding: 16px 14px;
      background: rgba(10,12,18,0.92);
    }
    .brand { font-weight: 700; margin-bottom: 6px; }
    .brand-sub { font-size: 11px; color: var(--muted); margin-bottom: 14px; }
    .nav-title {
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 10px 0;
    }
    .fold-list { display: grid; gap: 10px; }
    .fold-item {
      display: grid;
      gap: 6px;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.7);
      color: inherit;
      text-decoration: none;
    }
    .fold-item.active { border-color: rgba(107,220,255,0.4); }
    .fold-title { font-size: 12px; font-weight: 600; word-break: break-all; }
    .fold-meta { font-size: 10px; color: rgba(255,255,255,0.5); }

    .main { min-width: 0; padding: 20px 24px; overflow-x: hidden; }
    .chat-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px; min-width: 0; }
    .chat-title { margin:0; font-size:18px; font-weight:700; }
	    .chat-sub { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .travel-focus {
      margin-top: 14px;
      border-radius: 6px;
      border: 1px solid rgba(107,220,255,0.25);
      background: var(--panel);
      padding: 12px;
      display: grid;
      gap: 8px;
    }
    .travel-focus-head {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .travel-focus-sub { font-size: 12px; color: rgba(255,255,255,0.72); }

    .chat-stack { display: grid; gap: 16px; margin-top: 18px; }
    .chat-row { display: grid; gap: 6px; }
    .chat-row.user { justify-items: end; }
    .chat-label { font-size: 11px; color: rgba(255,255,255,0.5); }
    .chat-bubble {
      max-width: 80%;
      min-width: 0;
      padding: 12px 14px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.75);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .chat-row.user .chat-bubble {
      background: rgba(107,220,255,0.14);
      border-color: rgba(107,220,255,0.35);
    }
    .chat-row.agent .chat-bubble {
      background: rgba(255,204,128,0.12);
      border-color: rgba(255,204,128,0.35);
    }
    .chat-bubble h1, .chat-bubble h2, .chat-bubble h3 { margin: 10px 0 6px; font-size: 14px; }
    .chat-bubble p { margin: 6px 0; }
    .chat-bubble ul { margin: 6px 0 6px 18px; padding: 0; }
    .chat-bubble li { margin: 4px 0; }
    .chat-bubble code {
      font-family: "IBM Plex Mono", monospace;
      background: rgba(255,255,255,0.06);
      padding: 0 4px;
      border-radius: 6px;
    }
    .chat-bubble pre {
      font-family: "IBM Plex Mono", monospace;
      background: rgba(18,20,28,0.7);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      padding: 8px 10px;
      white-space: pre-wrap;
      max-width: 100%;
      overflow-x: auto;
    }
    .chat-group { display: grid; gap: 18px; }
    .result-card {
      border-radius: 6px;
      border: 1px solid rgba(255,204,128,0.35);
      background: var(--panel);
      padding: 16px 18px;
      display: grid;
      gap: 10px;
      max-width: 760px;
      margin: 0 auto;
    }
    .result-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .result-title { font-weight: 600; font-size: 14px; }
    .result-pill {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      border-radius: 999px;
      padding: 3px 8px;
      border: 1px solid rgba(255,204,128,0.4);
      color: rgba(255,204,128,0.9);
    }
    .result-pill.running { border-color: rgba(107,220,255,0.6); color: rgba(107,220,255,0.95); }
    .result-pill.completed { border-color: rgba(110,243,160,0.6); color: rgba(110,243,160,0.95); }
    .result-pill.failed { border-color: rgba(255,107,107,0.6); color: rgba(255,107,107,0.95); }
    .result-body { font-size: 13px; line-height: 1.6; color: rgba(255,255,255,0.92); }
    .result-body h1, .result-body h2, .result-body h3 { margin: 12px 0 6px; font-size: 14px; }
    .result-body p { margin: 6px 0; }
    .result-body ul { margin: 6px 0 8px 18px; padding: 0; }
    .result-body li { margin: 4px 0; }
    .result-body code {
      font-family: "IBM Plex Mono", monospace;
      background: rgba(255,255,255,0.06);
      padding: 0 4px;
      border-radius: 6px;
    }
    .result-body pre {
      font-family: "IBM Plex Mono", monospace;
      font-size: 12px;
      white-space: pre-wrap;
      padding: 10px 12px;
      margin: 8px 0;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.65);
    }
    .coordination { display: grid; gap: 10px; }
    .coord-head {
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.55);
    }
    .coord-summary { display: flex; flex-wrap: wrap; gap: 8px; }
    .coord-badge {
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.18);
      color: rgba(255,255,255,0.78);
      background: rgba(255,255,255,0.06);
      padding: 3px 8px;
    }
    .coord-strip {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(220px, 1fr);
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .mini-card {
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.65);
      padding: 10px 12px;
      display: grid;
      gap: 6px;
      min-height: 88px;
    }
    .mini-card.kind-analyze { border-color: rgba(107,220,255,0.35); }
    .mini-card.kind-improve { border-color: rgba(255,204,128,0.35); }
    .mini-card.kind-timeline { border-color: rgba(110,243,160,0.35); }
    .mini-card.kind-qa { border-color: rgba(195,139,255,0.35); }
    .mini-label { font-size: 11px; color: rgba(255,255,255,0.7); }
    .mini-body { font-size: 12px; color: rgba(255,255,255,0.85); line-height: 1.45; white-space: pre-wrap; }
    .empty { color: var(--muted); font-size: 12px; }

    .side {
      min-width: 0;
      padding: 18px 16px;
      border-left: 1px solid var(--line);
      background: rgba(10,12,18,0.92);
      display: grid;
      gap: 14px;
      overflow-x: auto;
    }
    .side-card {
      min-width: 0;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(18,20,28,0.7);
      padding: 12px;
    }
    .side .meta-item {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .side .chip-row {
      min-width: 0;
      flex-wrap: wrap;
    }
    .side-card h2 {
      margin: 0 0 10px;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.6);
    }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      font-size: 10px;
      color: rgba(255,255,255,0.7);
      text-decoration: none;
    }
    .chip.active { border-color: rgba(107,220,255,0.5); color: rgba(107,220,255,0.9); }
    .meta-list { display: grid; gap: 6px; font-size: 12px; }
    .meta-item { color: rgba(255,255,255,0.8); }
    .metric-list { display: grid; gap: 6px; font-size: 12px; }
    .metric-item { padding:6px 8px; border-radius:5px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); }
    .metric-item.active { border-color: rgba(107,220,255,0.6); background: rgba(107,220,255,0.12); }
    .metric-item.failed { border-color: rgba(255,107,107,0.6); background: rgba(255,107,107,0.12); }
    .timeline-list { display: grid; gap: 8px; }
    .timeline-row { display: grid; gap: 6px; }
    .timeline-label { font-size: 11px; color: rgba(255,255,255,0.75); }
    .timeline-bar {
      position: relative;
      height: 6px;
      border-radius: 999px;
      background: rgba(255,255,255,0.1);
      overflow: hidden;
    }
    .timeline-bar span {
      position: absolute;
      inset: 0;
      width: 0%;
      background: rgba(107,220,255,0.7);
    }
    .node-map { display: grid; gap: 10px; margin-top: 8px; }
    .node-row { display: grid; grid-template-columns: 10px 1fr; gap: 8px; align-items: center; }
    .node-dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,204,128,0.8); }
    .node-label { font-size: 12px; color: rgba(255,255,255,0.85); }
    .tool-list { display: grid; gap: 8px; }
    .tool-item { display:grid; gap:4px; padding:8px; border-radius:5px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.04); }
    .tool-item.error { border-color: rgba(255,107,107,0.5); }
    .tool-name { font-size: 12px; font-weight: 600; }
    .tool-meta { font-size: 10px; color: rgba(255,255,255,0.55); }
    .receipt-ledger { display:grid; gap:8px; }
    .receipt-entry { min-width:0; border:1px solid var(--line-soft); border-radius:var(--radius-sm); background:rgba(255,255,255,.025); }
    .receipt-entry summary { min-width:0; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px; padding:9px 10px; cursor:pointer; list-style:none; }
    .receipt-entry summary::-webkit-details-marker { display:none; }
    .receipt-entry summary span { color:var(--agent-accent); font:800 9px/1 ui-monospace,monospace; }
    .receipt-entry summary strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
    .receipt-entry summary small { color:var(--muted); font:9px/1.2 ui-monospace,monospace; }
    .receipt-hashes { display:flex; flex-wrap:wrap; gap:6px; padding:0 10px 8px; color:var(--faint); font:8px/1.3 ui-monospace,monospace; }
    .receipt-entry pre { max-height:320px; margin:0; overflow:auto; border-top:1px solid var(--line-soft); padding:10px; color:#cbd6e2; background:#080b10; font:9px/1.5 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }

    @media (max-width: 1100px) {
      .app { grid-template-columns: 220px minmax(0, 1fr); }
      .side { display: none; }
    }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--line); padding: 12px; }
      .sidebar > .fold-list {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding-bottom: 4px;
        scrollbar-width: thin;
      }
      .sidebar > .fold-list .fold-item { flex: 0 0 240px; }
      .main { padding: 16px 14px 32px; }
    }
    ${agentShellCss()}
    .agent-app .agent-tabpanel .side { display:grid; padding:0; border:0; background:transparent; overflow:visible; }
    .agent-app .agent-tabpanel .fold-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:8px; }
    .agent-app .travel-focus { margin-top:0; border-radius:var(--radius-md); }
  </style>
</head>
<body>
  ${agentShellFrameHtml({
    skipHref: "#main-content",
    skipLabel: "Skip to replay room",
    chromeHtml: agentTopNavHtml({ active: "replay", statusLabel: selected ? "Replay room active" : "Replay room ready", actionsHtml: realtime ? rosterRealtimeStatusHtml(selected ? "Connecting stream…" : "Syncing streams…") : undefined }),
    mainHtml: replayRoom,
    mainId: "main-content",
    appClass: "agent-unified-page replay-page",
  })}
  <script>
    (() => {
      const input = document.getElementById("receipt-question");
      const storageKey = "roster-replay-question";
      if (input && window.localStorage) {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) input.value = saved;
        input.addEventListener("input", () => {
          window.localStorage.setItem(storageKey, input.value);
        });
      }
    })();
  </script>
  ${agentTabsScript()}
  ${realtime ? rosterRealtimeBootHtml(realtime.boot, { nonce: realtime.nonce, assetPath: "/assets/replay-client.js" }) : ""}
</body>
</html>`;
};

export const receiptFoldsHtml = (
  streams: ReadonlyArray<ReceiptStreamInfo>,
  selected?: string,
  order: "asc" | "desc" = "desc",
  limit = 200,
  depth = 2
): string => {
  if (!streams.length) return `<div class="empty">No durable streams are visible in this workspace.</div>`;
  const sorted = [...streams].sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.streamId.localeCompare(right.streamId));
  return sorted.map((stream) => {
    const active = stream.streamId === selected;
    return `<a class="fold-item ${active ? "active" : ""}" data-stream-id="${esc(stream.streamId)}" href="/replay?stream=${encodeURIComponent(stream.streamId)}&order=${order}&limit=${limit}&depth=${depth}"${active ? ` aria-current="page"` : ""}>
      <div class="fold-title">${esc(stream.streamId)}</div>
      <div class="fold-meta">${esc(stream.kind)} · ${stream.receiptCount.toString()} receipts · ${formatTime(stream.updatedAtMs)}</div>
      ${stream.parentStreamId ? `<div class="fold-meta">Branch of ${esc(stream.parentStreamId)}</div>` : ""}
    </a>`;
  }).join("");
};

export const receiptChatHtml = (opts: {
  readonly selected?: string;
  readonly items: ReadonlyArray<ReceiptChatItem>;
}): string => {
  const { selected, items } = opts;
  if (!selected) return `<div class="empty">Select a run to start chatting.</div>`;
  if (!items.length) return `<div class="empty">Ask the team to inspect this run.</div>`;

  const out: string[] = [];
  let idx = 0;
  while (idx < items.length) {
    const msg = items[idx];
    const question = msg.role === "user" ? msg : undefined;
    if (question) idx += 1;

    const group: ReceiptChatItem[] = [];
    while (idx < items.length && items[idx].role !== "user") {
      group.push(items[idx]);
      idx += 1;
    }

    if (!question && !group.length) continue;

    const priority: Array<ReceiptChatItem["kind"]> = ["analyze", "improve", "qa", "timeline"];
    const pick = group.find((item) => item.kind && priority.includes(item.kind))
      ?? group.find((item) => item.content.trim().length > 0)
      ?? group[0];
    const resultStatus = group.some((item) => item.status === "running")
      ? "running"
      : group.some((item) => item.status === "completed")
        ? "completed"
        : group.some((item) => item.status === "failed")
          ? "failed"
          : "queued";
    const resultBody = pick?.content?.trim()
      ?? (resultStatus === "running" ? "Inspector is working..." : "Waiting for outputs...");
    const resultBodyHtml = renderMarkdown(resultBody);
    const runningAgents = group.filter((item) => item.status === "running").length;
    const completedAgents = group.filter((item) => item.status === "completed").length;
    const failedAgents = group.filter((item) => item.status === "failed").length;

    const miniCards = group.map((item) => {
      const content = item.content.trim() || "Working...";
      const kindClass = item.kind ? ` kind-${item.kind}` : "";
      return `<div class="mini-card${kindClass}" title="${esc(content)}">
        <div class="mini-label">${esc(item.label)}${item.status ? ` · ${esc(item.status)}` : ""}</div>
        <div class="mini-body">${esc(truncate(content, 160))}</div>
      </div>`;
    }).join("");

    out.push(`<section class="chat-group">
      ${question ? `<div class="chat-row user">
        <div class="chat-label">${esc(question.label)}</div>
        <div class="chat-bubble">${esc(question.content)}</div>
      </div>` : ""}
      <div class="coord-summary">
        <span class="coord-badge">Team: ${group.length}</span>
        <span class="coord-badge">Running: ${runningAgents}</span>
        <span class="coord-badge">Completed: ${completedAgents}</span>
        <span class="coord-badge">Failed: ${failedAgents}</span>
      </div>
      <div class="result-card">
        <div class="result-head">
          <div class="result-title">Final synthesis</div>
          <div class="result-pill ${resultStatus}">${esc(resultStatus)}</div>
        </div>
        <div class="result-body">${resultBodyHtml}</div>
      </div>
      <section class="coordination">
        <div class="coord-head">Coordination timeline (latest receipts)</div>
        <div class="coord-strip">
          ${miniCards || `<div class="empty">No agent outputs yet.</div>`}
        </div>
      </section>
    </section>`);
  }

  return out.join("");
};

export const receiptTimelineHtml = (opts: {
  readonly selected?: string;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly depth: number;
  readonly at: bigint | null;
  readonly total: number;
  readonly buckets: ReadonlyArray<{ readonly label: string; readonly count: number }>;
}): string => {
  const totalBucketed = opts.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const cursorQuery = opts.at === null ? "" : `&at=${encodeURIComponent(opts.at.toString())}`;
  const href = (order: "asc" | "desc", limit: number, depth: number): string =>
    `/replay?stream=${encodeURIComponent(opts.selected ?? "")}&order=${order}&limit=${limit}&depth=${depth}${cursorQuery}`;
  return `<section class="travel-focus">
    <div class="travel-focus-head">Durable receipt frontier</div>
    <div class="travel-focus-sub">${opts.at === null ? "Live" : `Replay through sequence ${opts.at.toString()}`} · ${totalBucketed}/${opts.total} visible receipts</div>
    <div class="chip-row"><span class="chip">Order</span>
      <a class="chip ${opts.order === "desc" ? "active" : ""}" href="${href("desc", opts.limit, opts.depth)}">Newest first</a>
      <a class="chip ${opts.order === "asc" ? "active" : ""}" href="${href("asc", opts.limit, opts.depth)}">Oldest first</a>
    </div>
    <div class="chip-row"><span class="chip">Window</span>${[50, 200, 1000].map((limit) =>
      `<a class="chip ${opts.limit === limit ? "active" : ""}" href="${href(opts.order, limit, opts.depth)}">${limit}</a>`
    ).join("")}<span class="chip">Depth</span>${[1, 2, 3].map((depth) =>
      `<a class="chip ${opts.depth === depth ? "active" : ""}" href="${href(opts.order, opts.limit, depth)}">${depth}</a>`
    ).join("")}</div>
    <div class="timeline-list">${opts.buckets.length ? opts.buckets.map((bucket) => {
      const percentage = totalBucketed ? Math.max(2, Math.round((bucket.count / totalBucketed) * 100)) : 0;
      return `<div class="timeline-row"><div class="timeline-label">${esc(bucket.label)} · ${bucket.count}</div><div class="timeline-bar"><span style="width:${percentage}%"></span></div></div>`;
    }).join("") : `<div class="empty">No receipts at this frontier.</div>`}</div>
  </section>`;
};

export const receiptSideHtml = (opts: {
  readonly selected?: string;
  readonly order: "asc" | "desc";
  readonly limit: number;
  readonly depth: number;
  readonly snapshot: ReceiptInspectorSnapshot;
  readonly receipts?: ReadonlyArray<ReceiptEvidenceItem>;
  readonly chainStatus?: "linked" | "broken" | "empty";
}): string => {
  const { selected, order, limit, depth, snapshot, receipts = [], chainStatus = "empty" } = opts;
  const context = snapshot.context;
  const timeline = snapshot.timeline;
  const tools = snapshot.tools ?? [];
  const total = timeline?.buckets.reduce((acc, b) => acc + b.count, 0) ?? 0;
  const agents = snapshot.agents ?? [];

  const timelineRows = timeline?.buckets.map((b) => {
    const pct = total ? Math.round((b.count / total) * 100) : 0;
    return `<div class="timeline-row">
      <div class="timeline-label">${esc(b.label)} · ${b.count}</div>
      <div class="timeline-bar"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join("");

  const nodeRows = timeline?.buckets.map((b) =>
    `<div class="node-row"><span class="node-dot"></span><span class="node-label">${esc(b.label)}</span></div>`
  ).join("");

  const statusLabel = snapshot.status === "running"
    ? "Running"
    : snapshot.status === "failed"
      ? "Failed"
      : snapshot.status === "completed"
        ? "Completed"
        : "Idle";

  const agentRows = agents.length
    ? agents.map((agent) => {
      const isActive = agent.status === "running";
      const isFailed = agent.status === "failed";
      const suffix = agent.status && agent.status !== "idle" ? ` · ${agent.status}` : "";
      return `<div class="metric-item ${isActive ? "active" : isFailed ? "failed" : ""}">${esc(agent.name)}${suffix}</div>`;
    }).join("")
    : `<div class="empty">No agents yet.</div>`;

  const toolRows = tools.length
    ? tools.map((tool) => {
      const duration = tool.durationMs ? `${tool.durationMs}ms` : "";
      const meta = [duration, tool.error ? "error" : "ok"].filter(Boolean).join(" · ");
      return `<div class="tool-item ${tool.error ? "error" : ""}">
        <div class="tool-name">${esc(tool.name)}</div>
        <div class="tool-meta">${esc(meta)}${tool.summary ? ` · ${esc(tool.summary)}` : ""}</div>
      </div>`;
    }).join("")
    : `<div class="empty">No tool calls yet.</div>`;
  const metricRows = [
    `Context receipts: ${context?.shown ?? 0}/${context?.total ?? 0}`,
    `Visible receipts: ${receipts.length}`,
    `Chain: ${chainStatus}`,
    `Timeline buckets: ${timeline?.buckets.length ?? 0}`,
    `Depth: ${timeline?.depth ?? depth}`,
    `Tool calls: ${tools.length}`,
    `Agents: ${agents.length}`,
  ];

  return `
  <section class="side-card">
    <h2>Status</h2>
    <div class="meta-list">
      <div class="meta-item">${statusLabel}${agents.length ? " · team" : snapshot.mode ? ` · ${esc(snapshot.mode)}` : ""}</div>
      ${snapshot.note ? `<div class="meta-item">${esc(snapshot.note)}</div>` : ""}
    </div>
  </section>

  <section class="side-card">
    <h2>Streams</h2>
    ${selected ? `<div class="meta-list">
      <div class="meta-item">Stream: ${esc(selected)}</div>
      <div class="meta-item">Window: ${context?.shown ?? 0}/${context?.total ?? 0} receipts</div>
      <div class="meta-item">Order: ${order}</div>
      <div class="meta-item">Limit: ${limit}</div>
    </div>` : `<div class="empty">Select a run to load context.</div>`}
    <div class="chip-row" style="margin-top:10px;">
      <span class="chip">Order</span>
      <a class="chip ${order === "desc" ? "active" : ""}" href="/replay?stream=${encodeURIComponent(selected ?? "")}&order=desc&limit=${limit}&depth=${depth}">Newest</a>
      <a class="chip ${order === "asc" ? "active" : ""}" href="/replay?stream=${encodeURIComponent(selected ?? "")}&order=asc&limit=${limit}&depth=${depth}">Oldest</a>
    </div>
    <div class="chip-row" style="margin-top:8px;">
      <span class="chip">Limit</span>
      ${[50, 200, 1000].map((n) => `<a class="chip ${limit === n ? "active" : ""}" href="/replay?stream=${encodeURIComponent(selected ?? "")}&order=${order}&limit=${n}&depth=${depth}">${n}</a>`).join("")}
    </div>
    <div class="chip-row" style="margin-top:8px;">
      <span class="chip">Depth</span>
      ${[1, 2, 3].map((d) => `<a class="chip ${depth === d ? "active" : ""}" href="/replay?stream=${encodeURIComponent(selected ?? "")}&order=${order}&limit=${limit}&depth=${d}">${d}</a>`).join("")}
    </div>
  </section>

  <section class="side-card">
    <h2>Team</h2>
    <div class="metric-list">
      ${agentRows}
    </div>
  </section>

  <section class="side-card">
    <h2>Timeline</h2>
    ${timelineRows ? `<div class="timeline-list">${timelineRows}</div>` : `<div class="empty">No timeline yet.</div>`}
    ${nodeRows ? `<div class="node-map">${nodeRows}</div>` : ""}
  </section>

  <section class="side-card">
    <h2>Metrics</h2>
    <div class="metric-list">
      ${metricRows.map((row) => `<div class="metric-item">${esc(row)}</div>`).join("")}
    </div>
  </section>

  <section class="side-card">
    <h2>Tools</h2>
    <div class="tool-list">${toolRows}</div>
  </section>

  <section class="side-card">
    <h2>Receipt evidence</h2>
    <div class="receipt-ledger">${receipts.length ? receipts.map((receipt) => {
      const type = typeof receipt.body.type === "string" ? receipt.body.type : "receipt";
      const actor = typeof receipt.body.agentId === "string"
        ? receipt.body.agentId
        : typeof receipt.body.agent === "string"
          ? receipt.body.agent
          : "system";
      return `<details class="receipt-entry" data-detail-id="receipt-${receipt.seq.toString()}">
        <summary><span>#${receipt.seq.toString()}</span><strong>${esc(type)}</strong><small>${esc(actor)} · ${formatTime(Number(receipt.occurredAtMs))}</small></summary>
        <div class="receipt-hashes"><span>hash ${esc(receipt.hash.slice(0, 16))}</span><span>prev ${esc(receipt.prevHash.slice(0, 16) || "genesis")}</span></div>
        <pre>${esc(JSON.stringify(receipt.body, null, 2))}</pre>
      </details>`;
    }).join("") : `<div class="empty">No receipts at this replay frontier.</div>`}</div>
  </section>`;
};
