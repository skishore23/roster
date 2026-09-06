import { MiniGFM } from "@oblivionocean/minigfm";

import { fold } from "../core/chain.js";
import type { Branch, Chain } from "../core/types.js";
import type { WriterRunSummary } from "../agents/writer.runs.js";
import type { WriterEvent, WriterState } from "../modules/writer.js";
import { initial as initialWriter, reduce as reduceWriter } from "../modules/writer.js";
import { orchestrationOutputValues } from "../modules/orchestration.js";
import { esc, truncate } from "./agent-framework.js";
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
import { orchestrationBoardHtml } from "./orchestration.js";
import { hasLinkedReceiptChain } from "./receipt-integrity.js";
import {
  rosterRealtimeBootHtml,
  rosterRealtimeStatusHtml,
  type RosterRealtimeBootConfig,
} from "./roster-realtime.js";

const markdown = new MiniGFM();

const renderMarkdown = (value: string): string => {
  const content = value.trim();
  return content ? markdown.parse(content) : `<p class="empty">No content recorded.</p>`;
};

const pretty = (value: string): string => value
  .replace(/[._:-]+/g, " ")
  .replace(/\b\w/g, (character) => character.toUpperCase());

export const writerShell = (
  stream: string,
  examples: ReadonlyArray<{ id: string; label: string; problem: string }>,
  activeRun?: string,
  at?: number | null,
  branch?: string,
  realtime?: { readonly boot: RosterRealtimeBootConfig; readonly nonce?: string },
): string => {
  const query = activeRun
    ? [
        `stream=${encodeURIComponent(stream)}`,
        `run=${encodeURIComponent(activeRun)}`,
        branch ? `branch=${encodeURIComponent(branch)}` : "",
        at !== null && at !== undefined ? `at=${encodeURIComponent(String(at))}` : "",
      ].filter(Boolean).join("&")
    : "";
  const resumeUrl = activeRun ? `/writer/run?${query}` : "";
  const toolbar = agentTopNavHtml({ active: "writer", statusLabel: activeRun ? "Writing room active" : "Writing room ready" });
  const replayBar = agentReplayBarHtml({
    id: "writer-replay",
    title: "Editorial history",
    description: activeRun ? "Replay research, drafting, critique, revision, and publication step by step." : "Start or select a run to replay the editorial collaboration.",
    content: agentReplayClientControlsHtml({
      id: "wg-travel",
      adapter: "writer",
      emptyLabel: activeRun ? "Synchronizing durable history…" : "No run selected",
    }),
  });
  const writerComposer = agentComposerHtml({
    id: "writer-control",
    inputId: "wg-problem",
    title: activeRun ? "Continue the Writing Room" : "Start a Writing Run",
    description: activeRun ? "Add context for the current draft, or start a separate writing run." : "Describe the deliverable; optional runtime tuning stays out of the way.",
    action: activeRun ? resumeUrl : `/writer/run?stream=${encodeURIComponent(stream)}`,
    inputName: activeRun ? "append" : "problem",
    inputLabel: activeRun ? "Follow-up context" : "Writing brief",
    placeholder: activeRun ? "Add context, a correction, or a new editorial direction…" : "Describe the audience, deliverable, evidence, and tone…",
    submitLabel: activeRun ? "Continue Current Run" : "Start Writing Run",
    toolsHtml: activeRun ? undefined : `<details class="agent-composer-options"><summary>Runtime options</summary><div class="agent-composer-options-panel"><div class="config-row"><label class="number-field"><span>Parallel cap</span><input type="number" inputmode="numeric" autocomplete="off" name="parallel" min="1" max="32" placeholder="Auto…" /></label></div></div></details>`,
    examplesHtml: activeRun ? undefined : `<div class="example-list" aria-label="Example writing briefs">${examples.map((example) => `<button type="button" data-problem="${esc(example.problem)}">${esc(example.label)}</button>`).join("")}</div>`,
  });
  const workspaceTabs = agentExampleTabsHtml({
    id: "writer-workspace",
    agentId: "writer",
    label: "Writer workspace views",
    workspaceBadge: activeRun ? "Live" : undefined,
    history: replayBar,
    railActionsHtml: `<a class="new-run" href="/writer?stream=${encodeURIComponent(stream)}&run=new">New Room</a>`,
    conversation: `<div class="agent-surface workspace-panel" data-slot="writer-conversation"><div id="wg-conversation" class="run-area" data-roster-panel aria-busy="true"><p class="empty">Synchronizing the writing room…</p></div></div>`,
    composer: writerComposer,
    room: {
      eyebrow: "Editorial room",
      title: "#writing-room",
      description: "A continuing conversation around the brief, evidence, draft, and review—not a stack of disconnected agent runs.",
      state: activeRun ? "active" : "open",
      actionsHtml: realtime ? rosterRealtimeStatusHtml(activeRun ? "Connecting run…" : "Syncing runs…") : `<span class="agent-status">Ready</span>`,
      roster: staticRoomRoster({
        roomId: "writing-room",
        summary: activeRun ? "The editorial team is shaping one draft" : "The writing room is ready",
        members: [
        { name: "You", role: "Author", kind: "human", presence: "present" },
        { name: "Roster", role: "Editor", kind: "system", presence: activeRun ? "working" : "present" },
        { name: "Research", role: "Evidence", kind: "agent", presence: activeRun ? "working" : "waiting" },
        { name: "Draft", role: "Writing", kind: "agent", presence: activeRun ? "working" : "waiting" },
        { name: "Review", role: "Critique", kind: "agent", presence: activeRun ? "working" : "waiting" },
        ],
      }),
    },
    workspace: `<div class="agent-surface workspace-panel"><div id="wg-chat" class="run-area" data-roster-panel aria-busy="true"><p class="empty">Synchronizing orchestration…</p></div></div>`,
    runs: `<div class="agent-surface workspace-panel compact-panel"><div id="wg-folds" class="folds" data-roster-panel aria-busy="true"><p class="empty">Synchronizing runs…</p></div></div>`,
    activity: `<div class="agent-surface workspace-panel"><div id="wg-side" class="activity" data-roster-panel aria-busy="true"><p class="empty">Synchronizing activity…</p></div></div>`,
  });

  return `<!doctype html>
<html lang="en">
<head>${themeBootstrapScript()}
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Roster - Writer Roster</title>
  <style>
    ${agentShellCss()}
    .muted,.empty { color:var(--muted); font-size:11px; }
    .new-run,.travel-btn { min-height:36px; border:1px solid var(--line); border-radius:var(--radius-sm); cursor:pointer; color:var(--ink); background:var(--raised); }
    .new-run { width:100%; display:grid; place-items:center; padding:0 12px; text-decoration:none; font-size:11px; font-weight:750; }
    .new-run:hover,.travel-btn:hover:not(:disabled),.branch-select:hover,.travel-speed:hover { border-color:var(--border-strong); background:var(--surface-hover); }
    .workspace-panel { min-width:0; min-height:220px; padding:18px; overflow:hidden; }.compact-panel { min-height:116px; }
    .fold-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:8px; }.fold-item { min-width:0; display:grid; gap:6px; padding:11px 12px; border:1px solid var(--line-soft); border-radius:var(--radius-sm); color:inherit; text-decoration:none; background:var(--panel-2); }.fold-item:hover,.fold-item.active { border-color:color-mix(in srgb,var(--agent-accent) 50%,var(--line)); background:var(--raised); }.fold-head { display:flex; align-items:center; gap:8px; min-width:0; }.fold-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; font-weight:700; }.fold-meta { color:var(--muted); font:9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }.fold-dot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--amber); }.fold-dot.done { background:var(--green); }.fold-dot.failed { background:var(--red); }
    .travel { min-width:0; }.travel-row { display:grid; grid-template-columns:auto minmax(120px,1fr) auto; align-items:center; gap:12px; }.travel-actions { display:flex; flex-wrap:wrap; gap:6px; }.travel-btn { min-height:34px; padding:5px 9px; font-size:10px; }.travel-play { min-width:52px; color:var(--agent-accent); border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--line)); }.travel-btn:disabled { opacity:.38; cursor:default; }.travel-scrub { display:grid; }.travel-slider { width:100%; accent-color:var(--agent-accent); }.travel-meta { display:flex; align-items:center; justify-content:flex-end; gap:8px; }.travel-speed { min-height:34px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:4px 7px; color:var(--ink); background:var(--raised); font-size:10px; }.travel-state { color:var(--muted); font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; font-variant-numeric:tabular-nums; }
    .run-area { min-width:0; display:grid; grid-template-columns:minmax(0,1fr); gap:18px; }.writer-brief,.writer-output,.writer-diagnostics { display:grid; gap:9px; padding:16px 0; border-top:1px solid var(--line); }.section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }.section-head h2 { margin:0; font-size:13px; }.section-head span { color:var(--muted); font:9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }.brief-text { margin:0; color:var(--ink); line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }.final-output { border-left:3px solid var(--green); padding:4px 0 4px 14px; }
    .agent-main h2,.agent-main h3 { scroll-margin-top:24px; }.artifact-list { display:grid; gap:7px; }.artifact { border:1px solid var(--line-soft); border-radius:var(--radius-sm); padding:9px 10px; background:var(--panel-2); }.artifact summary { display:flex; align-items:center; justify-content:space-between; gap:12px; cursor:pointer; font-size:11px; font-weight:700; }.artifact summary span { color:var(--muted); font:9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; }.markdown { color:var(--ink); font-size:12px; line-height:1.62; overflow-wrap:anywhere; }.markdown h1,.markdown h2,.markdown h3 { margin:14px 0 6px; font-size:14px; text-wrap:balance; }.markdown p { margin:7px 0; }.markdown pre { overflow:auto; border:1px solid var(--line); border-radius:var(--radius-sm); padding:10px; background:#0b0e12; }.markdown code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .activity { min-width:0; }.side-stack { display:grid; grid-template-columns:repeat(auto-fit,minmax(245px,1fr)); gap:10px; }.side-section { min-width:0; align-self:start; padding:13px; border:1px solid var(--line-soft); border-radius:var(--radius-sm); background:var(--panel-2); }.side-section h2 { margin:0 0 10px; color:var(--muted); font-size:9px; text-transform:uppercase; letter-spacing:.08em; }.meta-list,.receipt-list,.prompt-list,.branch-list { display:grid; gap:6px; }.meta-row,.branch-row,.prompt-row { min-width:0; padding:7px 8px; border-radius:6px; background:var(--panel); font-size:10px; overflow-wrap:anywhere; }.meta-row strong { color:var(--ink); }.meta-row span { color:var(--muted); }.branch-select { width:100%; margin-bottom:8px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:7px; background:var(--panel); color:var(--ink); font-size:10px; }.receipt-row { display:grid; grid-template-columns:70px minmax(0,1fr); gap:8px; border-bottom:1px solid var(--line-soft); padding:6px 0; font-size:9px; }.receipt-row time { color:var(--muted); font-variant-numeric:tabular-nums; }.receipt-row code { color:#cfd6dc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    @media (max-width:760px) { .workspace-panel { padding:13px; }.travel-row { grid-template-columns:1fr; }.travel-state { text-align:right; } }
  </style>
</head>
<body class="writer-page">
  ${agentShellFrameHtml({ skipHref: "#main-content", skipLabel: "Skip to writing room", chromeHtml: toolbar, mainHtml: workspaceTabs, mainId: "main-content", appClass: "agent-unified-page" })}
  <script>
    (() => {
      const input = document.getElementById("wg-problem");
      document.querySelectorAll(".example-list button").forEach((button) => button.addEventListener("click", () => {
        const problem = button.getAttribute("data-problem");
        if (problem && input instanceof HTMLTextAreaElement) input.value = problem;
      }));
    })();
  </script>
  ${agentTabsScript()}
  ${realtime ? rosterRealtimeBootHtml(realtime.boot, { nonce: realtime.nonce }) : ""}
</body>
</html>`;
};

export const writerFoldsHtml = (
  stream: string,
  runs: ReadonlyArray<WriterRunSummary>,
  activeRun?: string,
  at?: number | null
): string => {
  if (runs.length === 0) return `<p class="empty">No runs.</p>`;
  return `<div class="fold-list">${runs.map((run) => {
    const active = run.runId === activeRun;
    const status = run.status === "done" ? "done" : run.status;
    const when = run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "-";
    return `<a class="fold-item${active ? " active" : ""}" href="/writer?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(run.runId)}&at=${encodeURIComponent(String(at ?? ""))}"><span class="fold-head"><span class="fold-dot ${status}"></span><span class="fold-title">${esc(truncate(run.problem || run.runId, 32))}</span></span><span class="fold-meta">${esc(when)} / ${run.count} receipts</span></a>`;
  }).join("")}</div>`;
};

export const writerChatHtml = (chain: Chain<WriterEvent>, at?: number | null): string => {
  if (chain.length === 0) return `<p class="empty">Start or select a run.</p>`;
  const state = fold(chain, reduceWriter, initialWriter);
  const outputs = orchestrationOutputValues(state.orchestration);
  const artifacts = Object.entries(outputs)
    .filter(([key]) => key !== "problem" && key !== "final")
    .map(([key, value]) => {
      const binding = state.orchestration.outputs[key];
      return `<details class="artifact"><summary><strong>${esc(pretty(key))}</strong><span>${esc(binding?.contentHash.slice(0, 10) ?? "")}</span></summary><div class="markdown">${renderMarkdown(value)}</div></details>`;
    }).join("");
  const diagnostics = chain.filter((receipt) =>
    receipt.body.type === "context.pruned"
    || receipt.body.type === "context.compacted"
    || receipt.body.type === "overflow.recovered"
  );

  return `${orchestrationBoardHtml(state.orchestration, {
    title: "Writer coordination",
    replayStep: at,
    receipts: chain,
  })}
  <section class="writer-brief"><div class="section-head"><h2>Brief</h2><span>${esc(state.status)}</span></div><p class="brief-text">${esc(state.problem || "No brief recorded.")}</p></section>
  ${state.solution ? `<section class="writer-output"><div class="section-head"><h2>Final document</h2><span>${Math.round(state.solution.confidence * 100)}% confidence</span></div><div class="final-output markdown">${renderMarkdown(state.solution.content)}</div></section>` : ""}
  <section class="writer-output"><div class="section-head"><h2>Published artifacts</h2><span>${Object.keys(outputs).length}</span></div><div class="artifact-list">${artifacts || `<p class="empty">No task artifacts published.</p>`}</div></section>
  ${diagnostics.length > 0 ? `<section class="writer-diagnostics"><div class="section-head"><h2>Context controls</h2><span>${diagnostics.length}</span></div>${diagnostics.slice(-8).reverse().map((receipt) => `<div class="meta-row"><strong>${esc(receipt.body.type)}</strong> <span>${"note" in receipt.body ? esc(receipt.body.note ?? "") : ""}</span></div>`).join("")}</section>` : ""}`;
};

export const writerSideHtml = (
  state: WriterState,
  chain: Chain<WriterEvent>,
  at: number | null | undefined,
  _total: number,
  indexStream: string,
  runId?: string,
  _team: ReadonlyArray<{ id: string; name: string }> = [],
  chainStream?: string,
  branchStream?: string,
  branches: ReadonlyArray<Branch> = [],
  _activityChain?: Chain<WriterEvent>
): string => {
  const runStream = runId ? `${indexStream}/runs/${runId}` : indexStream;
  const prefix = `${runStream}/branches/`;
  const relevantBranches = branches.filter((branch) => branch.name.startsWith(prefix));
  const branchOptions = [
    { value: "", name: "Main run" },
    ...relevantBranches.map((branch) => ({ value: branch.name, name: branch.name.slice(prefix.length) })),
  ].map((option) => `<option value="${esc(option.value)}"${option.value === (branchStream ?? "") ? " selected" : ""}>${esc(option.name)}</option>`).join("");
  const integrityLabel = hasLinkedReceiptChain(chain) ? "valid" : "broken";
  const taskGraph = state.orchestration.taskGraph;
  const tasks = taskGraph?.tasks ?? [];
  const prompts = Object.values(state.orchestration.prompts).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 8);
  const activeTasks = tasks.filter((task) => task.status === "leased" || task.status === "running");
  const taskGraphStatus = taskGraph === undefined
    ? state.status
    : tasks.some((task) => task.status === "failed" || task.status === "canceled")
      ? "failed"
      : tasks.length > 0 && tasks.every((task) => task.status === "accepted" || task.status === "skipped")
        ? "completed"
        : "running";
  const receipts = [...chain].reverse().slice(0, 24);
  const effectiveRun = runId ?? state.runId ?? "";

  return `<div class="side-stack">
    <section class="side-section"><h2>Run</h2><div class="meta-list">
      <div class="meta-row"><strong>${esc(taskGraphStatus)}</strong>${state.statusNote ? ` <span>${esc(state.statusNote)}</span>` : ""}</div>
      <div class="meta-row"><span>Task graph</span> <strong>${taskGraph ? `${tasks.length} tasks / ${taskGraph.expansions.length} expansions` : "pending"}</strong></div>
      <div class="meta-row"><span>Active tasks</span> <strong>${activeTasks.length}</strong></div>
      <div class="meta-row"><span>Integrity</span> <strong>${integrityLabel}</strong></div>
      <div class="meta-row"><span>View</span> <strong>${at === null || at === undefined ? "live" : `receipt ${at}`}</strong></div>
    </div></section>
    <section class="side-section"><h2>Streams</h2><select class="branch-select" aria-label="Branch" onchange="(function(select){const query=new URLSearchParams(window.location.search);query.set('stream','${esc(indexStream)}');query.set('run','${esc(effectiveRun)}');if(select.value)query.set('branch',select.value);else query.delete('branch');query.delete('at');window.location.search='?'+query.toString();})(this)">${branchOptions}</select><div class="branch-list"><div class="branch-row">${esc(chainStream ?? runStream)}</div>${relevantBranches.map((branch) => `<div class="branch-row">${esc(branch.name.slice(prefix.length))} / fork ${branch.forkAt ?? 0}</div>`).join("")}</div></section>
    <section class="side-section"><h2>Prompt receipts</h2><div class="prompt-list">${prompts.map((prompt) => `<div class="prompt-row"><strong>${esc(pretty(prompt.capability))}</strong><br><span class="muted">${esc(prompt.nodeId)} / ${esc(prompt.promptHash.slice(0, 10))}</span></div>`).join("") || `<p class="empty">No prompts compiled.</p>`}</div></section>
    <section class="side-section"><h2>Receipt log</h2><div class="receipt-list">${receipts.map((receipt) => `<div class="receipt-row"><time>${esc(new Date(receipt.ts).toLocaleTimeString())}</time><code>${esc(receipt.body.type)}</code></div>`).join("") || `<p class="empty">No receipts.</p>`}</div></section>
  </div>`;
};
