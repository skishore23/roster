import { fold } from "../core/chain.js";
import type { Branch, Chain } from "../core/types.js";
import type { TheoremRunSummary } from "../agents/theorem.js";
import type { TheoremEvent, TheoremState } from "../modules/theorem.js";
import { initial as initialTheorem, reduce as reduceTheorem } from "../modules/theorem.js";
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

export type TheoremShellOptions = {
  readonly basePath?: string;
  readonly title?: string;
  readonly brand?: string;
  readonly brandSub?: string;
  readonly controlsTitle?: string;
  readonly controlsSub?: string;
  readonly runButtonLabel?: string;
  readonly realtime?: {
    readonly boot: RosterRealtimeBootConfig;
    readonly nonce?: string;
  };
};

type TeamMember = { readonly id: string; readonly name: string };

const pretty = (value: string): string => value
  .replace(/[._:-]+/g, " ")
  .replace(/\b\w/g, (character) => character.toUpperCase());

const renderInlineMath = (line: string): string =>
  esc(line).replace(/\\\((.+?)\\\)/g, (_match, content) => `<span class="math-inline">${content}</span>`);

const renderProof = (raw: string): string => {
  if (!raw.trim()) return `<p class="empty">No proof recorded.</p>`;
  const lines = raw.split("\n");
  let html = "";
  let inList = false;
  let inMath = false;
  let mathLines: string[] = [];
  const closeList = () => {
    if (!inList) return;
    html += "</ul>";
    inList = false;
  };
  const closeMath = () => {
    if (!inMath) return;
    html += `<div class="math-block">${esc(mathLines.join("\n"))}</div>`;
    mathLines = [];
    inMath = false;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "\\[") {
      closeList();
      inMath = true;
      continue;
    }
    if (trimmed === "\\]") {
      closeMath();
      continue;
    }
    if (inMath) {
      mathLines.push(line);
      continue;
    }
    if (trimmed.startsWith("### ")) {
      closeList();
      html += `<h3>${renderInlineMath(trimmed.slice(4))}</h3>`;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      closeList();
      html += `<h2>${renderInlineMath(trimmed.slice(3))}</h2>`;
      continue;
    }
    if (trimmed.startsWith("- ")) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${renderInlineMath(trimmed.slice(2))}</li>`;
      continue;
    }
    closeList();
    html += trimmed ? `<p>${renderInlineMath(line)}</p>` : `<div class="proof-space"></div>`;
  }
  closeMath();
  closeList();
  return html;
};

const isAxleVerifyTool = (tool?: string): boolean =>
  tool === "lean.verify" || tool === "lean.verify_file";

const shellEscapeSingleQuoted = (value: string): string =>
  value.replace(/'/g, "'\"'\"'");

const buildVerifyProofCurl = (options: {
  readonly content: string;
  readonly formalStatement: string;
  readonly environment: string;
}): string => {
  const payload = JSON.stringify({
    content: options.content,
    formal_statement: options.formalStatement,
    environment: options.environment,
    ignore_imports: true,
  });
  return [
    "curl -s -X POST https://axle.axiommath.ai/api/v1/verify_proof \\",
    '  -H "Content-Type: application/json" \\',
    `  -d '${shellEscapeSingleQuoted(payload)}' | jq`,
  ].join("\n");
};

const shortHash = (value?: string): string =>
  value ? `${value.slice(0, 12)}${value.length > 12 ? "..." : ""}` : "-";

const extractAxiomSummaryLine = (summary: string): string => {
  const lines = summary.split("\n").map((line) => line.trim()).filter(Boolean);
  return truncate(
    lines.find((line) => /^AXLE tools:/i.test(line))
      ?? lines.find((line) => /^validation:/i.test(line))
      ?? lines.find((line) => !/^status:/i.test(line))
      ?? lines[0]
      ?? "",
    140
  );
};

export const theoremShell = (
  stream: string,
  examples: ReadonlyArray<{ id: string; label: string; problem: string }>,
  activeRun?: string,
  at?: number | null,
  branch?: string,
  options?: TheoremShellOptions
): string => {
  const basePath = options?.basePath ?? "/theorem";
  const title = options?.title ?? "Roster - Adaptive Proof";
  const controlsTitle = options?.controlsTitle ?? "Adaptive proof coordination";
  const runButton = options?.runButtonLabel ?? "Start Proof Run";
  const activePage = basePath === "/axiom" ? "verified" : "adaptive";
  const resumeQuery = activeRun
    ? [
        `stream=${encodeURIComponent(stream)}`,
        `run=${encodeURIComponent(activeRun)}`,
        branch ? `branch=${encodeURIComponent(branch)}` : "",
        at !== null && at !== undefined ? `at=${encodeURIComponent(String(at))}` : "",
      ].filter(Boolean).join("&")
    : "";
  const resumeUrl = activeRun ? `${basePath}/run?${resumeQuery}` : "";
  const pageTitle = activePage === "verified" ? "Verified Proof" : "Adaptive Proof";
  const toolbar = agentTopNavHtml({
    active: activePage,
    statusLabel: activeRun ? `${pageTitle} active` : `${pageTitle} ready`,
  });
  const replayBar = agentReplayBarHtml({
    id: `${activePage}-replay`,
    title: `${pageTitle} history`,
    description: activeRun ? "Scrub every durable coordination step or return to the live frontier." : "Start or select a run to replay its coordination history.",
    content: agentReplayClientControlsHtml({
      id: "tg-travel",
      adapter: activePage,
      emptyLabel: activeRun ? "Synchronizing durable history…" : "No run selected",
    }),
  });
  const proofComposer = agentComposerHtml({
    id: "theorem-control",
    inputId: "tg-problem",
    title: activeRun ? `Continue ${controlsTitle}` : controlsTitle,
    description: activeRun ? `Add context or request another proof pass for ${activeRun}.` : "Describe the problem, tune the search budget, and start coordinated proof work.",
    action: activeRun ? resumeUrl : `${basePath}/run?stream=${encodeURIComponent(stream)}`,
    inputName: activeRun ? "append" : "problem",
    inputLabel: activeRun ? "Follow-up context" : "Theorem or problem",
    placeholder: activeRun ? "Add a constraint, correction, or new proof direction…" : "State the theorem, assumptions, and desired proof standard…",
    submitLabel: activeRun ? "Continue Proof Run" : runButton,
    toolsHtml: activeRun ? undefined : `<details class="agent-composer-options"><summary>Search options</summary><div class="agent-composer-options-panel"><div class="config-row"><label class="number-field"><span>Rounds</span><input type="number" inputmode="numeric" autocomplete="off" name="rounds" min="1" max="5" value="2" /></label><label class="number-field"><span>Depth</span><input type="number" inputmode="numeric" autocomplete="off" name="depth" min="1" max="4" value="2" /></label><label class="number-field"><span>Memory</span><input type="number" inputmode="numeric" autocomplete="off" name="memory" min="5" max="200" value="60" /></label><label class="number-field"><span>Threshold</span><input type="number" inputmode="numeric" autocomplete="off" name="branch" min="1" max="6" value="2" /></label><label class="number-field"><span>Parallel cap</span><input type="number" inputmode="numeric" autocomplete="off" name="concurrency" min="1" max="32" placeholder="Auto…" /></label></div></div></details>`,
    examplesHtml: activeRun ? undefined : `<div class="example-list" aria-label="Example problems">${examples.map((example) => `<button type="button" data-problem="${esc(example.problem)}">${esc(example.label)}</button>`).join("")}</div>`,
  });
  const workspaceTabs = agentExampleTabsHtml({
    id: `${activePage}-workspace`,
    agentId: activePage === "verified" ? "axiom-roster" : "theorem",
    label: `${pageTitle} workspace views`,
    workspaceBadge: activeRun ? "Live" : undefined,
    history: replayBar,
    railActionsHtml: `<a class="new-run" href="${basePath}?stream=${encodeURIComponent(stream)}&run=new">New Room</a>`,
    conversation: `<div class="agent-surface workspace-panel" data-slot="theorem-conversation"><div id="tg-conversation" class="run-area" data-roster-panel aria-busy="true"><p class="empty">Synchronizing the proof room…</p></div></div>`,
    composer: proofComposer,
    room: {
      eyebrow: "Proof room",
      title: activePage === "verified" ? "#verified-proof" : "#adaptive-proof",
      description: "A shared mathematical conversation where conjectures, counterexamples, repairs, and verification remain in one visible thread.",
      state: activeRun ? "active" : "open",
      actionsHtml: options?.realtime ? rosterRealtimeStatusHtml(activeRun ? "Connecting run…" : "Syncing runs…") : `<span class="agent-status">Ready</span>`,
      roster: staticRoomRoster({
        roomId: activePage === "verified" ? "verified-proof" : "adaptive-proof",
        summary: activeRun ? "Proof specialists are testing a shared argument" : "The proof room is ready",
        members: [
        { name: "You", role: "Mathematical partner", kind: "human", presence: "present" },
        { name: "Roster", role: "Orchestrator", kind: "system", presence: activeRun ? "working" : "present" },
        { name: "Explorers", role: "Proof search", kind: "agent", presence: activeRun ? "working" : "waiting" },
        { name: "Critics", role: "Challenge", kind: "agent", presence: activeRun ? "working" : "waiting" },
        { name: "Verifier", role: "Validation", kind: "agent", presence: activeRun ? "working" : "waiting" },
        ],
      }),
    },
    workspace: `<div class="agent-surface workspace-panel"><div id="tg-chat" class="run-area" data-roster-panel aria-busy="true"><p class="empty">Synchronizing orchestration…</p></div></div>`,
    runs: `<div class="agent-surface workspace-panel compact-panel"><div id="tg-folds" class="folds" data-roster-panel aria-busy="true"><p class="empty">Synchronizing runs…</p></div></div>`,
    activity: `<div class="agent-surface workspace-panel"><div id="tg-side" class="activity" data-roster-panel aria-busy="true"><p class="empty">Synchronizing activity…</p></div></div>`,
  });

  return `<!doctype html>
<html lang="en">
<head>${themeBootstrapScript()}
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
  <style>
    ${agentShellCss()}
    .muted,.empty { color:var(--muted); font-size:11px; }
    .new-run,.travel-btn { min-height:36px; border:1px solid var(--line); border-radius:var(--radius-sm); cursor:pointer; color:var(--ink); background:var(--raised); }
    .new-run { width:100%; display:grid; place-items:center; padding:0 12px; text-decoration:none; font-size:11px; font-weight:750; }
    .new-run:hover,.travel-btn:hover:not(:disabled),.branch-select:hover,.travel-speed:hover { border-color:var(--border-strong); background:var(--surface-hover); }
    .workspace-panel { min-width:0; min-height:220px; padding:18px; overflow:hidden; }.compact-panel { min-height:116px; }
    .fold-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:8px; }.fold-item { min-width:0; display:grid; gap:6px; padding:11px 12px; border:1px solid var(--line-soft); border-radius:var(--radius-sm); color:inherit; text-decoration:none; background:var(--panel-2); }
    .fold-item:hover,.fold-item.active { border-color:color-mix(in srgb,var(--agent-accent) 50%,var(--line)); background:var(--raised); }.fold-head { display:flex; align-items:center; gap:8px; min-width:0; }.fold-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; font-weight:700; }.fold-meta { color:var(--muted); font:9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }
    .fold-dot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--amber); }.fold-dot.done { background:var(--green); }.fold-dot.failed { background:var(--red); }
    .travel { min-width:0; }.travel-row { display:grid; grid-template-columns:auto minmax(120px,1fr) auto; align-items:center; gap:12px; }.travel-actions { display:flex; flex-wrap:wrap; gap:6px; }.travel-btn { min-height:34px; padding:5px 9px; font-size:10px; }.travel-play { min-width:52px; color:var(--agent-accent); border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--line)); }.travel-btn:disabled { opacity:.38; cursor:default; }.travel-scrub { display:grid; }.travel-slider { width:100%; accent-color:var(--agent-accent); }.travel-meta { display:flex; align-items:center; justify-content:flex-end; gap:8px; }.travel-speed { min-height:34px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:4px 7px; color:var(--ink); background:var(--raised); font-size:10px; }.travel-state { color:var(--muted); font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; font-variant-numeric:tabular-nums; }
    .run-area { min-width:0; display:grid; grid-template-columns:minmax(0,1fr); gap:18px; }.theorem-section { min-width:0; display:grid; grid-template-columns:minmax(0,1fr); gap:9px; padding:16px 0; border-top:1px solid var(--line); }.section-head { min-width:0; display:flex; align-items:baseline; justify-content:space-between; gap:12px; }.section-head h2 { margin:0; font-size:13px; }.section-head span { color:var(--muted); font:9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }.problem-text { margin:0; color:var(--ink); line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
    .agent-main h2,.agent-main h3 { scroll-margin-top:24px; }.strategy-row { border-left:3px solid var(--amber); padding:6px 0 6px 12px; color:var(--ink); font-size:11px; }.verification-row { border-left:3px solid var(--blue); padding:5px 0 5px 12px; }.verification-row[data-status="valid"] { border-left-color:var(--green); }.verification-row[data-status="false"] { border-left-color:var(--red); }
    .artifact-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:8px; }.domain-artifact { min-width:0; padding:10px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--panel-2); }.domain-artifact header { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }.domain-artifact strong { font-size:10px; }.domain-artifact span { color:var(--muted); font:9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; }.domain-artifact p { margin:0; color:var(--ink); font-size:10px; line-height:1.5; overflow-wrap:anywhere; }
    .proof { min-width:0; max-width:100%; overflow-x:auto; border-left:3px solid var(--green); padding:4px 0 4px 14px; color:var(--ink); font-size:12px; line-height:1.65; overflow-wrap:anywhere; }.proof h2,.proof h3 { margin:14px 0 6px; font-size:14px; text-wrap:balance; }.proof p { margin:6px 0; }.proof-space { height:8px; }.proof pre { overflow:auto; }.result-pill { border:1px solid var(--line); border-radius:var(--radius-sm); padding:4px 7px; color:var(--muted); font:9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .activity { min-width:0; }.side-stack { display:grid; grid-template-columns:repeat(auto-fit,minmax(245px,1fr)); gap:10px; }.side-section { min-width:0; align-self:start; padding:13px; border:1px solid var(--line-soft); border-radius:var(--radius-sm); background:var(--panel-2); }.side-section h2 { margin:0 0 10px; color:var(--muted); font-size:9px; text-transform:uppercase; letter-spacing:.08em; }.meta-list,.receipt-list,.memory-list,.branch-list { display:grid; gap:6px; }.meta-row,.branch-row,.memory-row { min-width:0; padding:7px 8px; border-radius:6px; background:var(--panel); font-size:10px; overflow-wrap:anywhere; }.meta-row span { color:var(--muted); }.branch-select { width:100%; margin-bottom:8px; border:1px solid var(--line); border-radius:var(--radius-sm); padding:7px; background:var(--panel); color:var(--ink); font-size:10px; }
    .axiom-link { color:var(--agent-accent); font-size:10px; }.axiom-curl { margin-top:8px; border-top:1px solid var(--line); padding-top:8px; }.axiom-curl summary { cursor:pointer; font-size:10px; }.axiom-curl-note { margin:6px 0; color:var(--muted); font-size:9px; }.axiom-curl pre { white-space:pre-wrap; overflow-wrap:anywhere; font:9px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .receipt-row { display:grid; grid-template-columns:70px minmax(0,1fr); gap:8px; border-bottom:1px solid var(--line-soft); padding:6px 0; font-size:9px; }.receipt-row time { color:var(--muted); font-variant-numeric:tabular-nums; }.receipt-row code { color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    @media (max-width:760px) { .workspace-panel { padding:13px; }.travel-row { grid-template-columns:1fr; }.travel-state { text-align:right; } }
  </style>
</head>
<body class="theorem-page">
  ${agentShellFrameHtml({ skipHref: "#main-content", skipLabel: "Skip to proof room", chromeHtml: toolbar, mainHtml: workspaceTabs, mainId: "main-content", appClass: "agent-unified-page" })}
  <script>
    (() => {
      const input=document.getElementById("tg-problem");
      document.querySelectorAll(".example-list button").forEach((button)=>button.addEventListener("click",()=>{const problem=button.getAttribute("data-problem");if(problem&&input instanceof HTMLTextAreaElement)input.value=problem;}));
      const renderMath=(root)=>{const target=root instanceof HTMLElement?root:document.body;const render=window.renderMathInElement;if(typeof render!=="function")return;target.querySelectorAll(".proof").forEach((node)=>{try{render(node,{delimiters:[{left:"$$",right:"$$",display:true},{left:"\\\\[",right:"\\\\]",display:true},{left:"$",right:"$",display:false},{left:"\\\\(",right:"\\\\)",display:false}],throwOnError:false});}catch(_error){}});};
      document.addEventListener("DOMContentLoaded",()=>renderMath(document.body));document.addEventListener("roster:panel-rendered",(event)=>renderMath(event.target));
    })();
  </script>
  ${agentTabsScript()}
  ${options?.realtime ? rosterRealtimeBootHtml(options.realtime.boot, { nonce: options.realtime.nonce }) : ""}
</body>
</html>`;
};

export const theoremFoldsHtml = (
  stream: string,
  runs: ReadonlyArray<TheoremRunSummary>,
  activeRun?: string,
  at?: number | null,
  options?: { readonly basePath?: string }
): string => {
  const basePath = options?.basePath ?? "/theorem";
  if (runs.length === 0) return `<p class="empty">No runs.</p>`;
  return `<div class="fold-list">${runs.map((run) => {
    const status = run.status === "done" ? "done" : run.status;
    const when = run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "-";
    return `<a class="fold-item${run.runId === activeRun ? " active" : ""}" href="${basePath}?stream=${encodeURIComponent(stream)}&run=${encodeURIComponent(run.runId)}&at=${encodeURIComponent(String(at ?? ""))}"><span class="fold-head"><span class="fold-dot ${status}"></span><span class="fold-title">${esc(truncate(run.problem || run.runId, 32))}</span></span><span class="fold-meta">${esc(when)} / ${run.count} raw receipts</span></a>`;
  }).join("")}</div>`;
};

const domainArtifacts = (state: TheoremState) => [
  ...Object.values(state.attempts).map((artifact) => ({ kind: "Attempt", ...artifact })),
  ...Object.values(state.lemmas).map((artifact) => ({ kind: "Lemma", ...artifact })),
  ...Object.values(state.critiques).map((artifact) => ({ kind: "Critique", ...artifact })),
  ...Object.values(state.patches).map((artifact) => ({ kind: "Patch", ...artifact })),
  ...Object.values(state.summaries).map((artifact) => ({ kind: "Summary", ...artifact })),
].sort((left, right) => right.updatedAt - left.updatedAt);

export const theoremChatHtml = (chain: Chain<TheoremEvent>, at?: number | null): string => {
  if (chain.length === 0) return `${orchestrationBoardHtml(initialTheorem.orchestration, { title: "Theorem coordination", replayStep: at, receipts: [] })}<p class="empty">Start or select a run.</p>`;
  const state = fold(chain, reduceTheorem, initialTheorem);
  const artifacts = domainArtifacts(state);
  const latestRebracket = [...chain].reverse().find((receipt) => receipt.body.type === "rebracket.applied") as
    | { readonly body: Extract<TheoremEvent, { readonly type: "rebracket.applied" }> }
    | undefined;
  const resultStatus = state.status === "completed"
    ? state.solution?.gaps.length ? "Completed with gaps" : "Completed"
    : state.status === "failed" ? "Failed" : "Running";
  const verificationLabel = state.verification
    ? state.verification.status === "valid"
      ? state.verification.trust === "formal" ? "Machine verified" : "Model verified"
      : state.verification.status
    : "pending";

  return `${orchestrationBoardHtml(state.orchestration, {
    title: "Theorem coordination",
    replayStep: at,
    receipts: chain,
  })}
  <section class="theorem-section"><div class="section-head"><h2>Problem</h2><span>${esc(state.status)}</span></div><p class="problem-text">${esc(state.problem || "No problem recorded.")}</p></section>
  ${latestRebracket ? `<section class="theorem-section"><div class="section-head"><h2>Composition policy</h2><span>score ${latestRebracket.body.score.toFixed(2)}</span></div><div class="strategy-row">${esc(latestRebracket.body.note ?? "Merge strategy updated.")}</div></section>` : ""}
  ${state.verification ? `<section class="theorem-section"><div class="section-head"><h2>Verification</h2><span>${esc(verificationLabel)}</span></div><div class="verification-row" data-status="${esc(state.verification.status)}"><div class="proof">${renderProof(state.verification.content)}</div></div></section>` : ""}
  ${state.solution ? `<section class="theorem-section"><div class="section-head"><h2>Final proof</h2><div class="result-pill">${resultStatus}</div></div>${state.solution.gaps.length > 0 ? `<p class="strategy-row">${state.solution.gaps.length} declared gap(s) remain.</p>` : ""}<div class="proof">${renderProof(state.solution.content)}</div></section>` : ""}
  <section class="theorem-section"><div class="section-head"><h2>Theorem artifacts</h2><span>${artifacts.length}</span></div><div class="artifact-grid">${artifacts.slice(0, 40).map((artifact) => `<article class="domain-artifact"><header><strong>${esc(artifact.kind)}</strong><span>${esc(pretty(artifact.agentId))}</span></header><p>${esc(truncate(artifact.content, 260))}</p></article>`).join("") || `<p class="empty">No theorem artifacts recorded.</p>`}</div></section>`;
};

export const theoremSideHtml = (
  state: TheoremState,
  chain: Chain<TheoremEvent>,
  at: number | null | undefined,
  _total: number,
  indexStream: string,
  runId?: string,
  _team: ReadonlyArray<TeamMember> = [],
  chainStream?: string,
  branchStream?: string,
  activityChain?: Chain<TheoremEvent>,
  durableBranches: ReadonlyArray<Branch> = [],
): string => {
  const activity = activityChain ?? chain;
  const axiomDelegates = activity.filter((receipt): receipt is typeof receipt & { body: Extract<TheoremEvent, { type: "tool.called" }> } =>
    receipt.body.type === "tool.called" && receipt.body.tool === "axiom.delegate"
  );
  const axiomMerges = activity.filter((receipt): receipt is typeof receipt & { body: Extract<TheoremEvent, { type: "subagent.merged" }> } =>
    receipt.body.type === "subagent.merged"
  );
  const lastAxiomMerge = axiomMerges.at(-1)?.body;
  const finalEvidence = state.verification?.evidence
    ?? [...axiomMerges].reverse().flatMap((receipt) => receipt.body.evidence ?? []).find((evidence) => evidence.phase === "verify");
  const verificationRan = isAxleVerifyTool(finalEvidence?.tool);
  const exactPayload = verificationRan && finalEvidence?.candidateContent && finalEvidence.formalStatement
    ? {
        content: finalEvidence.candidateContent,
        formalStatement: finalEvidence.formalStatement,
        environment: finalEvidence.environment ?? "lean-4.28.0",
      }
    : undefined;
  const verifyCurl = exactPayload ? buildVerifyProofCurl(exactPayload) : undefined;
  const runStream = runId ? `${indexStream}/runs/${runId}` : indexStream;
  const prefix = `${runStream}/branches/`;
  const branchName = (id: string): string => id.startsWith(prefix) ? id.slice(prefix.length) : id;
  const projectedBranches = durableBranches
    .filter((candidate) => candidate.name.startsWith(prefix))
    .map((candidate) => ({ id: candidate.name, forkAt: candidate.forkAt ?? 0 }));
  const visibleBranches = [
    ...state.branches.map((candidate) => ({ id: candidate.id, forkAt: candidate.forkAt })),
    ...projectedBranches,
  ].filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index);
  const branchOptions = [
    { value: "", name: "Main run" },
    ...visibleBranches.map((candidate) => ({ value: candidate.id, name: branchName(candidate.id) })),
  ].filter((option, index, all) => all.findIndex((candidate) => candidate.value === option.value) === index)
    .map((option) => `<option value="${esc(option.value)}"${option.value === (branchStream ?? "") ? " selected" : ""}>${esc(option.name)}</option>`).join("");
  const effectiveRun = runId ?? state.runId ?? "";
  const integrityLabel = hasLinkedReceiptChain(chain) ? "valid" : "broken";
  const memories = activity.filter((receipt): receipt is typeof receipt & { body: Extract<TheoremEvent, { type: "memory.slice" }> } => receipt.body.type === "memory.slice").slice(-8).reverse();
  const receipts = [...chain].reverse().slice(0, 24);

  return `<div class="side-stack">
    <section class="side-section"><h2>Status</h2><div class="meta-list"><div class="meta-row"><strong>${esc(state.status)}</strong>${state.statusNote ? ` <span>${esc(state.statusNote)}</span>` : ""}</div><div class="meta-row"><span>Verification</span> <strong>${esc(state.verification?.status === "valid" ? state.verification.trust === "formal" ? "machine verified" : "model verified" : state.verification?.status ?? "pending")}</strong></div><div class="meta-row"><span>Declared gaps</span> <strong>${state.solution?.gaps.length ?? 0}</strong></div><div class="meta-row"><span>Members</span> <strong>${Object.keys(state.orchestration.nodes).length}</strong></div><div class="meta-row"><span>Tasks</span> <strong>${state.orchestration.taskGraph?.tasks.length ?? 0}</strong></div><div class="meta-row"><span>Integrity</span> <strong>${integrityLabel}</strong></div><div class="meta-row"><span>View</span> <strong>${at === null || at === undefined ? "live" : `step ${at}`}</strong></div></div></section>
    <section class="side-section"><h2>Streams</h2><select class="branch-select" aria-label="Branch" onchange="(function(select){const query=new URLSearchParams(window.location.search);query.set('stream','${esc(indexStream)}');query.set('run','${esc(effectiveRun)}');if(select.value)query.set('branch',select.value);else query.delete('branch');query.delete('at');window.location.search='?'+query.toString();})(this)">${branchOptions}</select><div class="branch-list"><div class="branch-row">${esc(chainStream ?? runStream)}</div>${visibleBranches.map((candidate) => `<div class="branch-row">${esc(branchName(candidate.id))} / fork ${candidate.forkAt}</div>`).join("")}</div></section>
    <section class="side-section"><h2>Shared Memory</h2><div class="memory-list">${memories.map((receipt) => `<div class="memory-row"><strong>${esc(pretty(receipt.body.phase))}</strong> / ${receipt.body.itemCount} items / ${receipt.body.chars} chars${receipt.body.truncated ? " / truncated" : ""}</div>`).join("") || `<p class="empty">No memory slices.</p>`}</div></section>
    ${(axiomDelegates.length > 0 || axiomMerges.length > 0) ? `<section class="side-section"><h2>AXLE</h2><div class="meta-list"><div class="meta-row">Verification run: ${verificationRan ? "yes" : "no"}</div><div class="meta-row">Delegations: ${axiomDelegates.length}</div><div class="meta-row">Merged workers: ${axiomMerges.length}</div><div class="meta-row">Last worker: ${esc(lastAxiomMerge?.subRunId ?? "-")}</div><div class="meta-row">Last outcome: ${esc(lastAxiomMerge?.outcome ?? "-")}</div><div class="meta-row">Last summary: ${esc(lastAxiomMerge ? extractAxiomSummaryLine(lastAxiomMerge.summary) : "-")}</div><div class="meta-row">Final verify tool: ${esc(finalEvidence?.tool ?? "-")}</div><div class="meta-row">Final environment: ${esc(finalEvidence?.environment ?? "-")}</div><div class="meta-row">Candidate hash: ${esc(shortHash(finalEvidence?.candidateHash))}</div><div class="meta-row">Statement hash: ${esc(shortHash(finalEvidence?.formalStatementHash))}</div></div><p><a class="axiom-link" href="https://axle.axiommath.ai/api/v1/verify_proof" target="_blank" rel="noreferrer noopener">AXLE verify_proof endpoint</a></p>${verifyCurl ? `<details class="axiom-curl"><summary>Derived verify_proof curl</summary><div class="axiom-curl-note">Derived from persisted AXLE verification evidence for this run.</div><pre>${esc(verifyCurl)}</pre></details>` : `<div class="axiom-curl-note">Exact verification payload not persisted.</div>`}</section>` : ""}
    <section class="side-section"><h2>Metrics</h2><div class="meta-list"><div class="meta-row">Attempts: ${Object.keys(state.attempts).length}</div><div class="meta-row">Lemmas: ${Object.keys(state.lemmas).length}</div><div class="meta-row">Critiques: ${Object.keys(state.critiques).length}</div><div class="meta-row">Patches: ${Object.keys(state.patches).length}</div><div class="meta-row">Summaries: ${Object.keys(state.summaries).length}</div><div class="meta-row">Certified compositions: ${Object.keys(state.orchestration.compositions).length}</div><div class="meta-row">Composition conflicts: ${state.orchestration.conflicts.length}</div></div></section>
    <section class="side-section"><h2>Receipts</h2><div class="receipt-list">${receipts.map((receipt) => `<div class="receipt-row"><time>${esc(new Date(receipt.ts).toLocaleTimeString())}</time><code>${esc(receipt.body.type)}</code></div>`).join("") || `<p class="empty">No receipts.</p>`}</div></section>
  </div>`;
};
