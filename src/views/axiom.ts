import type { Chain } from "../core/types.js";
import type { AgentEvent, AgentState } from "../modules/agent.js";
import { esc } from "./agent-framework.js";

const prettyTool = (name: string): string =>
  name
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part, index) => index === 0 ? part : part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");

const formatClock = (ts?: number): string => ts ? new Date(ts).toLocaleTimeString() : "-";

const formatJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const eventBadgeClass = (event: AgentEvent): string => {
  switch (event.type) {
    case "problem.set":
      return "user";
    case "thought.logged":
    case "response.finalized":
      return "agent";
    case "tool.called":
    case "tool.observed":
      return "tool";
    case "validation.report":
      return event.ok ? "ok" : "bad";
    case "failure.report":
      return "bad";
    case "run.status":
      return event.status === "completed" ? "ok" : event.status === "failed" ? "bad" : "system";
    default:
      return "system";
  }
};

export const axiomChatHtml = (chain: Chain<AgentEvent>, runId?: string): string => {
  if (chain.length === 0) {
    return runId
      ? `<div class="empty">Run <code>${esc(runId)}</code> is queued. Waiting for first receipt...</div>`
      : `<div class="empty">No run selected.</div>`;
  }

  const cards = chain.map((receipt) => {
    const event = receipt.body;
    const badge = eventBadgeClass(event);
    const ts = new Date(receipt.ts).toLocaleTimeString();
    const heading = (() => {
      switch (event.type) {
        case "problem.set":
          return "Problem";
        case "run.configured":
          return "Run Configured";
        case "failure.report":
          return `Failure · ${prettyTool(event.failure.failureClass)}`;
        case "run.status":
          return `Run ${event.status}`;
        case "iteration.started":
          return `Iteration ${event.iteration}`;
        case "thought.logged":
          return "Reasoning";
        case "action.planned":
          return event.actionType === "tool"
            ? `Plan · ${prettyTool(event.name ?? "tool")}`
            : "Plan · Final answer";
        case "tool.called":
          return `Tool · ${prettyTool(event.tool)}`;
        case "tool.observed":
          return `Observation · ${prettyTool(event.tool)}`;
        case "validation.report":
          return `Validation · ${event.gate}`;
        case "response.finalized":
          return "Final response";
        case "config.updated":
          return "Config updated";
        case "memory.slice":
          return `Memory slice · ${event.scope}`;
        case "context.pruned":
          return `Context pruned · ${event.mode}`;
        case "context.compacted":
          return `Context compacted · ${event.reason}`;
        case "overflow.recovered":
          return "Overflow recovered";
        case "subagent.merged":
          return `Subagent merged · ${event.subRunId}`;
        case "agent.delegated":
          return `Delegated · ${event.delegatedTo}`;
        case "memory.flushed":
          return `Memory flushed · ${event.scope}`;
      }
    })();

    const body = (() => {
      switch (event.type) {
        case "problem.set":
          return `<pre>${esc(event.problem)}</pre>`;
        case "run.configured":
          return `<pre>${esc(formatJson({
            workflow: event.workflow,
            model: event.model,
            config: event.config,
            promptHash: event.promptHash,
            promptPath: event.promptPath,
          }))}</pre>`;
        case "failure.report":
          return `<div class="meta-row">
            <span class="meta-pill bad">${esc(event.failure.failureClass)}</span>
            <span class="meta-pill">${esc(event.failure.stage)}</span>
            ${typeof event.failure.iteration === "number" ? `<span class="meta-pill">iter ${event.failure.iteration}</span>` : ""}
            ${event.failure.retryable === true ? `<span class="meta-pill warn">retryable</span>` : ""}
          </div>
          <div class="card-copy">${esc(event.failure.message)}</div>
          ${event.failure.details ? `<pre>${esc(event.failure.details)}</pre>` : ""}
          ${event.failure.evidence ? `<pre>${esc(formatJson(event.failure.evidence))}</pre>` : ""}`;
        case "run.status":
          return event.note ? `<div class="card-copy">${esc(event.note)}</div>` : `<div class="card-copy">No status note.</div>`;
        case "iteration.started":
          return `<div class="card-copy">Iteration ${event.iteration} started.</div>`;
        case "thought.logged":
          return `<div class="card-copy">${esc(event.content)}</div>`;
        case "action.planned":
          return event.actionType === "tool"
            ? `<pre>${esc(formatJson({ name: event.name, input: event.input ?? {} }))}</pre>`
            : `<div class="card-copy">Preparing final response.</div>`;
        case "tool.called":
          return `<div class="meta-row">
            ${event.summary ? `<span class="meta-pill">${esc(event.summary)}</span>` : ""}
            ${typeof event.durationMs === "number" ? `<span class="meta-pill">${Math.round(event.durationMs)} ms</span>` : ""}
            ${event.error ? `<span class="meta-pill bad">${esc(event.error)}</span>` : ""}
          </div>
          <pre>${esc(formatJson(event.input))}</pre>`;
        case "tool.observed":
          return `<pre>${esc(event.output)}</pre>`;
        case "validation.report":
          return `<div class="meta-row">
            <span class="meta-pill ${event.ok ? "ok" : "bad"}">${event.ok ? "pass" : "fail"}</span>
            ${event.target ? `<span class="meta-pill">${esc(event.target)}</span>` : ""}
          </div>
          <div class="card-copy">${esc(event.summary)}</div>
          ${event.details ? `<pre>${esc(event.details)}</pre>` : ""}`;
        case "response.finalized":
          return `<pre>${esc(event.content)}</pre>`;
        case "config.updated":
          return `<pre>${esc(formatJson(event.config))}</pre>`;
        case "memory.slice":
          return `<div class="meta-row">
            <span class="meta-pill">${event.itemCount} items</span>
            <span class="meta-pill">${event.chars} chars</span>
            ${event.truncated ? `<span class="meta-pill warn">truncated</span>` : ""}
          </div>
          ${event.query ? `<div class="card-copy">query: ${esc(event.query)}</div>` : ""}`;
        case "context.pruned":
          return `<div class="card-copy">${event.before} -> ${event.after}${event.note ? ` · ${esc(event.note)}` : ""}</div>`;
        case "context.compacted":
          return `<div class="card-copy">${event.before} -> ${event.after}${event.note ? ` · ${esc(event.note)}` : ""}</div>`;
        case "overflow.recovered":
          return `<div class="card-copy">${esc(event.note ?? "Recovered from model context overflow.")}</div>`;
        case "subagent.merged":
          return `<div class="card-copy">${esc(event.task)}</div><pre>${esc(event.summary)}</pre>`;
        case "agent.delegated":
          return `<div class="card-copy">${esc(event.task)}</div><pre>${esc(event.summary)}</pre>`;
        case "memory.flushed":
          return `<div class="card-copy">${event.chars} chars committed to <code>${esc(event.scope)}</code>.</div>`;
      }
    })();

    return `<article class="event-card ${badge}">
      <div class="event-head">
        <div>
          <div class="event-title">${esc(heading)}</div>
          <div class="event-meta">${esc(ts)}${"agentId" in event && event.agentId ? ` · ${esc(event.agentId)}` : ""}</div>
        </div>
        <span class="event-badge ${badge}">${esc(event.type)}</span>
      </div>
      ${body}
    </article>`;
  }).join("");

  return `<div class="event-feed">${cards}</div>
  <style>
    .event-feed { display: grid; gap: 12px; }
    .event-card {
      display: grid;
      gap: 10px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(12,18,18,0.88);
      padding: 14px;
    }
    .event-card.agent { border-color: rgba(140,255,193,0.22); }
    .event-card.user { border-color: rgba(127,216,255,0.24); }
    .event-card.tool { border-color: rgba(255,255,255,0.12); }
    .event-card.ok { border-color: rgba(132,248,177,0.32); }
    .event-card.bad { border-color: rgba(255,135,135,0.32); }
    .event-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .event-title { font-size: 13px; font-weight: 700; }
    .event-meta { font-size: 11px; color: rgba(255,255,255,0.54); margin-top: 2px; }
    .event-badge {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.16);
      padding: 4px 8px;
      white-space: nowrap;
    }
    .event-badge.agent { border-color: rgba(140,255,193,0.35); color: rgba(140,255,193,0.95); }
    .event-badge.user { border-color: rgba(127,216,255,0.35); color: rgba(127,216,255,0.95); }
    .event-badge.tool,
    .event-badge.system { color: rgba(255,255,255,0.76); }
    .event-badge.ok { border-color: rgba(132,248,177,0.35); color: rgba(132,248,177,0.95); }
    .event-badge.bad { border-color: rgba(255,135,135,0.38); color: rgba(255,135,135,0.95); }
    .card-copy { font-size: 13px; line-height: 1.5; color: rgba(255,255,255,0.86); }
    .meta-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .meta-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.14);
      padding: 3px 8px;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.8);
      background: rgba(255,255,255,0.04);
    }
    .meta-pill.ok { border-color: rgba(132,248,177,0.35); color: rgba(132,248,177,0.95); }
    .meta-pill.bad { border-color: rgba(255,135,135,0.38); color: rgba(255,135,135,0.95); }
    .meta-pill.warn { border-color: rgba(255,217,120,0.35); color: rgba(255,217,120,0.95); }
    .event-card pre {
      margin: 0;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      font-size: 12px;
      line-height: 1.5;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>`;
};

export const axiomSideHtml = (opts: {
  readonly state: AgentState;
  readonly chain: Chain<AgentEvent>;
  readonly at: number | null | undefined;
  readonly total: number;
  readonly runId?: string;
}): string => {
  const { state, chain, at, total, runId } = opts;
  if (!runId) return `<div class="empty">Select a run to inspect AXLE tools, validation gates, and final status.</div>`;

  const toolCalls = chain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "tool.called" }> } =>
    receipt.body.type === "tool.called"
  );
  const usedTools = [...new Set(toolCalls.map((receipt) => receipt.body.tool))];
  const validations = chain.filter((receipt): receipt is typeof receipt & { body: Extract<AgentEvent, { type: "validation.report" }> } =>
    receipt.body.type === "validation.report"
  ).slice(-8).reverse();
  const paths = [...new Set(
    toolCalls.flatMap((receipt) => {
      const input = receipt.body.input;
      const values = [input.path, input.outputPath, input.output_path, input.formalStatementPath, input.formal_statement_path, input.outputDir, input.output_dir];
      return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    })
  )];

  const extra = state.config?.extra ?? {};
  const summaryCards = [
    { k: "Status", v: `${state.status}${state.statusNote ? ` · ${state.statusNote}` : ""}` },
    { k: "Iteration", v: `${state.iteration} / ${state.config?.maxIterations ?? "-"}` },
    { k: "Workflow", v: state.config ? `${state.config.workflowId} ${state.config.workflowVersion}` : "-" },
    { k: "Model", v: state.config?.model ?? "-" },
    { k: "Workspace", v: state.config?.workspace ?? "." },
    { k: "Lean Env", v: typeof extra.leanEnvironment === "string" ? extra.leanEnvironment : "-" },
    { k: "Auto Repair", v: String(extra.autoRepair ?? false) },
    { k: "Local Validation", v: String(extra.localValidationMode ?? "off") },
    { k: "Receipts", v: `${chain.length}${at === null || at === undefined ? ` / ${total}` : ` / ${total}`}` },
  ];

  return `<div class="side-stack">
    <section class="side-panel">
      <div class="side-title">Run Overview</div>
      <div class="side-grid">
        ${summaryCards.map((row) => `<div class="side-card"><div class="k">${esc(row.k)}</div><div class="v">${esc(row.v)}</div></div>`).join("")}
      </div>
    </section>

    <section class="side-panel">
      <div class="side-title">AXLE Tools Used</div>
      ${usedTools.length > 0
        ? `<div class="pill-list">${usedTools.map((tool) => `<span class="tool-pill">${esc(tool)}</span>`).join("")}</div>`
        : `<div class="empty">No tool calls yet.</div>`}
    </section>

    <section class="side-panel">
      <div class="side-title">Validation Gates</div>
      ${validations.length > 0
        ? `<div class="validation-list">${validations.map((receipt) => {
            const event = receipt.body;
            return `<div class="validation-row ${event.ok ? "ok" : "bad"}">
              <div class="validation-head">
                <span>${esc(event.gate)}</span>
                <span>${esc(formatClock(receipt.ts))}</span>
              </div>
              <div class="validation-summary">${esc(event.summary)}</div>
              ${event.target ? `<div class="validation-target">${esc(event.target)}</div>` : ""}
            </div>`;
          }).join("")}</div>`
        : `<div class="empty">No validation receipts yet.</div>`}
    </section>

    <section class="side-panel">
      <div class="side-title">Touched Files</div>
      ${paths.length > 0
        ? `<ul class="side-list">${paths.map((entry) => `<li><code>${esc(entry)}</code></li>`).join("")}</ul>`
        : `<div class="empty">No file paths recorded yet.</div>`}
    </section>

    ${state.finalResponse
      ? `<section class="side-panel">
          <div class="side-title">Latest Final Response</div>
          <pre>${esc(state.finalResponse)}</pre>
        </section>`
      : ""}
  </div>
  <style>
    .side-stack { display: grid; gap: 12px; }
    .side-panel {
      display: grid;
      gap: 10px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(12,18,18,0.9);
      padding: 12px;
    }
    .side-title {
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.7);
      font-weight: 700;
    }
    .side-grid {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .side-card {
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      padding: 8px 9px;
    }
    .side-card .k {
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .side-card .v {
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .pill-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .tool-pill {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 10px;
      border-radius: 999px;
      border: 1px solid rgba(127,216,255,0.28);
      background: rgba(127,216,255,0.1);
      color: rgba(127,216,255,0.96);
      padding: 4px 8px;
    }
    .validation-list { display: grid; gap: 8px; }
    .validation-row {
      display: grid;
      gap: 5px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      padding: 8px 9px;
    }
    .validation-row.ok { border-color: rgba(132,248,177,0.22); }
    .validation-row.bad { border-color: rgba(255,135,135,0.24); }
    .validation-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      font-weight: 600;
    }
    .validation-summary { font-size: 11px; color: rgba(255,255,255,0.82); line-height: 1.45; }
    .validation-target {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 10px;
      color: rgba(255,255,255,0.58);
      overflow-wrap: anywhere;
    }
    .side-list {
      margin: 0;
      padding-left: 16px;
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: rgba(255,255,255,0.86);
    }
    .side-panel pre {
      margin: 0;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      font-size: 12px;
      line-height: 1.5;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>`;
};
