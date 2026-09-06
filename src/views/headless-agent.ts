import { esc } from "./agent-framework.js";
import {
  agentComposerHtml,
  agentShellCss,
  agentShellFrameHtml,
  agentTopNavHtml,
  agentWorkspaceShellHtml,
  staticRoomRoster,
  agentTabsHtml,
  agentTabsScript,
} from "./agent-shell.js";
import { themeBootstrapScript } from "./theme.js";

export const headlessAgentShell = (options: {
  readonly id: string;
  readonly version: string;
  readonly runPath: string;
  readonly csrf: string;
}): string => {
  const roomName = `#${options.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "headless-agent"}`;
  const runForm = agentComposerHtml({
    id: "headless-run",
    inputId: "headless-agent-problem",
    title: "Start a Headless Run",
    description: "Send a bounded problem to this agent. Roster will retain its receipts and return the durable run identity.",
    action: options.runPath,
    inputName: "problem",
    inputLabel: "Problem",
    placeholder: "Describe the problem, constraints, and expected evidence…",
    submitLabel: "Run Agent",
    inputMaxLength: 100000,
    hiddenHtml: `<input type="hidden" name="csrf" value="${esc(options.csrf)}" />`,
  });
  const work = `<section class="headless-work-card" aria-labelledby="headless-work-title"><p class="agent-eyebrow">Command line</p><h2 id="headless-work-title">Run from a Terminal</h2><p>Use the same registered agent contract without opening the browser workspace.</p><code translate="no">roster run ${esc(options.id)} --problem &lt;text&gt;</code></section>`;
  const room = agentWorkspaceShellHtml({
    id: "headless-agent-workspace",
    room: {
      eyebrow: "Headless agent room",
      title: roomName,
      description: "A lightweight Roster room for one registered agent contract and its durable run receipts.",
      state: "open",
      roster: staticRoomRoster({
        roomId: roomName,
        summary: `${options.id} is ready to join`,
        context: `Agent version ${options.version}`,
        members: [
        { name: "You", role: "Operator", kind: "human", presence: "present" },
        { name: "Roster", role: "Facilitator", kind: "system", presence: "present" },
        { name: options.id, role: "Headless agent", kind: "agent", presence: "waiting" },
        ],
      }),
    },
    conversation: `<div class="room-thread-empty"><span aria-hidden="true">+</span><strong>Start the conversation</strong><p>Send the first bounded task. This room will retain the agent response and its durable receipts.</p></div>`,
    composer: runForm,
    context: agentTabsHtml({ id: "headless-agent-tabs", label: "Headless agent context", tabs: [{ id: "work", label: "Work", content: work }] }),
    contextLabel: "Agent work and context",
    artifact: "Durable task result and receipts",
    acceptance: "Registered agent finalizer",
    coordinationLabel: "Bounded tool loop",
  });
  const chrome = agentTopNavHtml({ statusLabel: `Agent ${options.version} ready` });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#090c11" />
  <title>Roster - ${esc(options.id)}</title>
  ${themeBootstrapScript()}
  <style>
    ${agentShellCss()}
    .headless-work-card{min-width:0;display:grid;gap:14px;padding:20px;background:var(--bg)}
    .headless-work-card h2{margin:0;font-size:17px;letter-spacing:-.02em;text-wrap:balance}.headless-work-card>p{max-width:720px;margin:0;color:var(--muted);font-size:11px;line-height:1.55;text-wrap:pretty}
    .headless-work-card code{overflow:auto;border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;color:var(--agent-accent);background:var(--panel-2);font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
  </style>
</head>
<body>${agentShellFrameHtml({
    skipHref: "#main-content",
    skipLabel: "Skip to agent room",
    chromeHtml: chrome,
    mainHtml: room,
    mainId: "main-content",
    appClass: "agent-unified-page",
  })}
  ${agentTabsScript()}
</body>
</html>`;
};
