import type { OrchestrationEvent, OrchestrationState } from "../modules/orchestration.js";
import type { TaskGraphTaskStatus } from "../engine/orchestration/task-graph.js";
import { isOrchestrationEvent, orchestrationWorkspaceNodes } from "../modules/orchestration.js";
import { esc, truncate } from "./agent-framework.js";

type OrchestrationReceipt = {
  readonly ts: number;
  readonly body: {
    readonly type: string;
    readonly outcome?: string;
    readonly summary?: string;
    readonly totalTokens?: number;
    readonly subRunId?: string;
    readonly task?: string;
  };
};

export type OrchestrationBoardOptions = {
  readonly title?: string;
  readonly replayStep?: number | null;
  readonly receipts?: ReadonlyArray<OrchestrationReceipt>;
  readonly compact?: boolean;
};

const label = (value: string): string => value
  .replace(/[._:-]+/g, " ")
  .replace(/\b\w/g, (character) => character.toUpperCase());

const nodeName = (state: OrchestrationState, nodeId: string): string =>
  state.nodes[nodeId]?.name ?? label(nodeId);

const nodeGroup = (state: OrchestrationState, nodeId: string): string => {
  const node = state.nodes[nodeId];
  const group = node?.metadata?.group;
  if (typeof group === "string" && group.trim()) return group;
  if (node?.parentId === state.domain?.coordinatorId && node.capabilities[0]) return label(node.capabilities[0]);
  if (node?.parentId) return nodeName(state, node.parentId);
  return "Coordination";
};

const nodeDepth = (state: OrchestrationState, nodeId: string): number => {
  const visited = new Set<string>();
  let current = state.nodes[nodeId];
  let depth = 0;
  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    depth += 1;
    current = state.nodes[current.parentId];
  }
  return depth;
};

const taskForNode = (state: OrchestrationState, nodeId: string) =>
  (state.taskGraph?.tasks ?? [])
    .filter((task) => task.nodeId === nodeId)
    .sort((left, right) => right.attempt - left.attempt || right.taskId.localeCompare(left.taskId))[0];

const taskStatusPriority = (status: TaskGraphTaskStatus): number => ({
  running: 0,
  leased: 1,
  ready: 2,
  waiting: 3,
  pending: 4,
  failed: 5,
  canceled: 6,
  accepted: 7,
  skipped: 8,
})[status];

const eventSummary = (state: OrchestrationState, event: OrchestrationEvent): string => {
  switch (event.type) {
    case "orchestration.configured":
      return `${event.nodes.length === 1 ? "1 member" : `${event.nodes.length} people and agents`} configured for ${event.domainId}`;
    case "task.graph.projected":
      return `${event.graph.tasks.length} durable graph tasks · ${event.graph.expansions.length} expansions`;
    case "function.activity.recorded":
      return `${nodeName(state, event.activity.nodeId)} ran ${label(event.activity.operation)}`;
    case "node.spawned":
      return `${event.node.name} joined`;
    case "node.retired":
      return `${nodeName(state, event.nodeId)} retired`;
    case "node.runtime.bound":
      return `${nodeName(state, event.binding.nodeId)} bound ${label(event.binding.runtime.kind)} runtime at epoch ${event.binding.epoch}`;
    case "reflection.recorded":
      return `Reflection ${event.iteration}: ${event.reason}`;
    case "topology.selected":
      return `${event.operation} topology with ${event.leaves.length} leaves: ${event.bracket}`;
    case "prompt.compiled":
      return `${nodeName(state, event.nodeId)} compiled ${label(event.capability)} prompt`;
    case "artifact.published":
      return `${nodeName(state, event.nodeId)} published ${label(event.outputKey)}`;
    case "evidence.recorded":
      return `${event.evidence.kind} evidence recorded`;
    case "composition.proposed":
      return `${nodeName(state, event.nodeId)} proposed ${label(event.compositionId)}`;
    case "composition.certified":
      return `${label(event.compositionId)} certified`;
    case "composition.rejected":
      return `${label(event.compositionId)} rejected: ${event.detail}`;
    case "control.update.published": {
      const payload = event.payload;
      if (payload.kind === "proposal") return `${payload.authorRole} proposed ${label(payload.action.type)}`;
      if (payload.kind === "endorsement") return `${payload.nodeRole} ${payload.verdict}d a distributed proposal`;
      return `${payload.nodeId} withdrew a distributed proposal`;
    }
    case "control.frontier.projected":
      return `${event.acceptedProposalIds.length} distributed proposal(s) eligible, ${event.conflictCount} conflict(s)`;
    case "control.frontier.certified":
      return `${event.acceptedProposalIds.length} distributed decision(s) certified`;
  }
};

const orchestrationReceipts = (
  receipts: ReadonlyArray<OrchestrationReceipt>
): ReadonlyArray<{ readonly ts: number; readonly event: OrchestrationEvent }> => receipts
  .filter((receipt): receipt is OrchestrationReceipt & { readonly body: OrchestrationEvent } =>
    isOrchestrationEvent(receipt.body)
  )
  .map((receipt) => ({ ts: receipt.ts, event: receipt.body }));

export const orchestrationBoardHtml = (
  state: OrchestrationState,
  options: OrchestrationBoardOptions = {}
): string => {
  const workspaceNodes = orchestrationWorkspaceNodes(state);
  const nodes = Object.values(state.nodes).sort((left, right) =>
    Number(right.id === state.domain?.coordinatorId) - Number(left.id === state.domain?.coordinatorId)
      || nodeGroup(state, left.id).localeCompare(nodeGroup(state, right.id))
      || nodeDepth(state, left.id) - nodeDepth(state, right.id)
      || left.name.localeCompare(right.name)
  );
  const tasks = state.taskGraph?.tasks ?? [];
  const activeTasks = tasks.filter((task) => task.status === "leased" || task.status === "running");
  const completedTasks = tasks.filter((task) =>
    task.status === "accepted" || task.status === "skipped").length;
  const failedTasks = tasks.filter((task) =>
    task.status === "failed" || task.status === "canceled").length;
  const childRuns = (options.receipts ?? []).filter((receipt) => receipt.body.type === "subagent.merged");
  const isChildFailure = (receipt: (typeof childRuns)[number]): boolean =>
    receipt.body.type === "subagent.merged"
      && (/fail|timeout|cancel|circuit/i.test(receipt.body.outcome ?? "") || /status:\s*failed/i.test(receipt.body.summary ?? ""))
  const childFailures = childRuns.filter(isChildFailure).length;
  const degraded = failedTasks + childFailures;
  const totalTokens = (options.receipts ?? []).reduce((total, receipt) =>
    receipt.body.type === "model.usage" ? total + (receipt.body.totalTokens ?? 0) : total
  , 0);
  const compositions = Object.values(state.compositions).sort((left, right) => right.updatedAt - left.updatedAt);
  const proposals = Object.values(state.proposals).filter((proposal) => !state.compositions[proposal.compositionId]);
  const timeline = orchestrationReceipts(options.receipts ?? []).slice(-24).reverse();
  const replayLabel = options.replayStep === null || options.replayStep === undefined
    ? "Live"
    : `Step ${options.replayStep}`;
  const currentEvent = timeline[0];
  const progressTotal = tasks.length;
  const progressCompleted = completedTasks;
  const progressValue = progressTotal > 0 ? Math.round((progressCompleted / progressTotal) * 100) : 0;
  const latestReflection = state.reflections.at(-1);
  const topology = state.topologyId ? state.topologies[state.topologyId] : undefined;
  const reflectionActions = latestReflection?.actions.map((action) => action.type) ?? [];
  const adaptationHtml = latestReflection || topology
    ? `<section class="orch-adaptation" aria-labelledby="orch-adaptation-title">
        <div class="orch-adaptation-head">
          <div><span class="orch-adaptation-kicker">Reflection</span><strong id="orch-adaptation-title">${latestReflection ? `Iteration ${latestReflection.iteration}` : "Topology initialized"}</strong></div>
          <div class="orch-action-list">${reflectionActions.map((action) => `<span>${esc(label(action))}</span>`).join("") || `<span>Stable</span>`}</div>
        </div>
        <div class="orch-topology-row">
          <span class="orch-topology-size">K<sub>${topology?.leaves.length ?? 0}</sub></span>
          <code>${esc(topology?.bracket ?? "No composition frontier")}</code>
          <span>${esc(topology?.operation ?? "pending")}</span>
        </div>
        ${latestReflection ? `<p>${esc(truncate(latestReflection.reason, 240))}</p>` : ""}
      </section>`
    : "";

  const taskRows = tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) =>
      taskStatusPriority(left.task.status) - taskStatusPriority(right.task.status)
      || left.index - right.index)
    .map(({ task }) => {
    const dependencies = task.dependencies.length > 0
      ? task.dependencies.map((dependency) =>
        `${label(dependency.taskId)} (${dependency.condition})`).join(", ")
      : "root";
    return `<li class="orch-task" data-status="${task.status}">
      <span class="orch-status" aria-hidden="true"></span>
      <span class="orch-task-main">
        <strong>${esc(label(task.taskId))}</strong>
        <span>${esc(nodeName(state, task.nodeId))} / ${esc(label(task.capability))}</span>
        <span class="orch-task-io">${esc(dependencies)}${task.continuationTaskId ? ` → ${esc(label(task.continuationTaskId))}` : ""}</span>
      </span>
      <span class="orch-state">${esc(task.status)}</span>
    </li>`;
  }).join("");
  const childRows = childRuns.slice(-12).reverse().map((receipt) => {
    if (receipt.body.type !== "subagent.merged") return "";
    const failed = isChildFailure(receipt);
    const status = failed ? "failed" : "completed";
    const outcome = receipt.body.outcome?.trim() || (failed ? "failed" : "merged");
    const childRunId = receipt.body.subRunId ?? "worker";
    const childTask = receipt.body.task ?? receipt.body.summary ?? "Delegated work";
    return `<li class="orch-task" data-status="${status}"><span class="orch-status" aria-hidden="true"></span><span class="orch-task-main"><strong title="${esc(childRunId)}">Delegated ${esc(label(childRunId))}</strong><span title="${esc(childTask)}">${esc(truncate(childTask, 92))}</span></span><span class="orch-state">${esc(outcome)}</span></li>`;
  }).join("");
  const taskAndChildRows = `${taskRows}${childRows}`;

  const renderNodeRow = (node: (typeof nodes)[number]): string => {
    const task = taskForNode(state, node.id);
    const status = node.status === "retired" ? "retired" : task?.status ?? "idle";
    const depth = nodeDepth(state, node.id);
    const focus = typeof node.metadata?.focus === "string" ? node.metadata.focus : "";
    const workspaceNode = workspaceNodes[node.id];
    const runtime = workspaceNode?.binding?.runtime ?? workspaceNode?.runtime;
    const runtimeLabel = runtime ? label(runtime.kind) : "Roster Native";
    return `<li class="orch-agent" data-status="${status}" data-depth="${depth}" style="--orch-depth:${depth}">
      <span class="orch-agent-line" aria-hidden="true"></span>
      <span class="orch-avatar" aria-hidden="true">${esc(node.name.slice(0, 1).toUpperCase())}</span>
      <span class="orch-agent-main">
        <strong title="${esc(node.name)}">${esc(node.name)}</strong>
        <span title="${esc(`${runtimeLabel} / ${task ? label(task.capability) : focus || node.capabilities.map(label).join(", ")}`)}">${esc(`${runtimeLabel} / ${task ? label(task.capability) : focus || node.capabilities.map(label).join(", ")}`)}</span>
      </span>
      <span class="orch-state">${esc(status)}</span>
    </li>`;
  };
  const groups = new Map<string, Array<(typeof nodes)[number]>>();
  for (const node of nodes) {
    const group = nodeGroup(state, node.id);
    groups.set(group, [...(groups.get(group) ?? []), node]);
  }
  const nodeRows = [...groups.entries()].map(([group, members]) => `<li class="orch-agent-group"><span>${esc(group)}</span><span>${members.length}</span></li>${members.map(renderNodeRow).join("")}`).join("");

  const compositionRows = [
    ...compositions.map((composition) => ({
      id: composition.compositionId,
      status: "certified",
      inputs: Object.keys(composition.inputVersions).length,
      agent: nodeName(state, composition.nodeId),
      evidence: composition.evidence.length,
      evidenceLabel: [...new Set(composition.evidence.map((item) => label(item.kind)))].join(", ") || "none",
      detail: composition.certificationId,
    })),
    ...proposals.map((proposal) => ({
      id: proposal.compositionId,
      status: "proposed",
      inputs: Object.keys(proposal.inputVersions).length,
      agent: nodeName(state, proposal.nodeId),
      evidence: proposal.evidence.length,
      evidenceLabel: [...new Set(proposal.evidence.map((item) => label(item.kind)))].join(", ") || "none",
      detail: proposal.proposalId,
    })),
    ...state.conflicts.slice(-8).reverse().map((conflict) => {
      const proposal = conflict.proposalId ? state.proposals[conflict.proposalId] : undefined;
      return {
        id: conflict.compositionId,
        status: "rejected",
        inputs: proposal ? Object.keys(proposal.inputVersions).length : 0,
        agent: proposal ? nodeName(state, proposal.nodeId) : "Policy",
        evidence: proposal?.evidence.length ?? 0,
        evidenceLabel: proposal
          ? [...new Set(proposal.evidence.map((item) => label(item.kind)))].join(", ") || "none"
          : "none",
        detail: conflict.detail,
      };
    }),
  ].map((composition) => `<li class="orch-composition" data-status="${composition.status}">
    <span class="orch-merge-mark" aria-hidden="true">${composition.status === "certified" ? "C" : composition.status === "rejected" ? "X" : "+"}</span>
    <span class="orch-composition-main"><strong title="${esc(label(composition.id))}">${esc(label(composition.id))}</strong><span>${esc(composition.agent)} / ${composition.inputs} inputs / ${composition.evidence} checks</span><span class="orch-composition-detail" title="${esc(composition.evidenceLabel)}">${esc(composition.evidenceLabel)}</span><span class="orch-composition-detail" title="${esc(composition.detail)}">${esc(truncate(composition.detail, 72))}</span></span>
    <span class="orch-state">${composition.status}</span>
  </li>`).join("");

  const timelineRows = timeline.map(({ ts, event }) => `<li class="orch-event" data-kind="${esc(event.type)}">
    <time datetime="${new Date(ts).toISOString()}">${esc(new Date(ts).toLocaleTimeString())}</time>
    <span><strong>${esc(event.type)}</strong>${esc(truncate(eventSummary(state, event), 150))}</span>
  </li>`).join("");

  return `<section class="orch-board${options.compact ? " orch-compact" : ""}" aria-label="${esc(options.title ?? "Workspace node orchestration")}">
    <header class="orch-head">
      <div><p class="orch-eyebrow">Orchestration kernel</p><h2>${esc(options.title ?? "Roster coordination")}</h2></div>
      <span class="orch-replay" data-mode="${options.replayStep === null || options.replayStep === undefined ? "live" : "replay"}">${esc(replayLabel)}</span>
    </header>
    <dl class="orch-metrics">
      <div><dt>Members</dt><dd>${nodes.filter((node) => node.status === "active").length}</dd></div>
      <div><dt>Active</dt><dd>${activeTasks.length}</dd></div>
      <div><dt>Completed</dt><dd>${completedTasks}</dd></div>
      <div><dt>Degraded</dt><dd>${degraded}</dd></div>
      <div><dt>Tokens</dt><dd>${totalTokens > 0 ? totalTokens.toLocaleString() : "-"}</dd></div>
      <div><dt>Merges</dt><dd>${compositions.length}</dd></div>
      <div><dt>Conflicts</dt><dd>${state.conflicts.length}</dd></div>
    </dl>
    <div class="orch-live" data-mode="${options.replayStep === null || options.replayStep === undefined ? "live" : "replay"}" aria-live="polite">
      <span class="orch-live-label"><span class="orch-live-dot" aria-hidden="true"></span>${options.replayStep === null || options.replayStep === undefined ? "Latest" : "At step"}</span>
      ${currentEvent ? `<strong>${esc(currentEvent.event.type)}</strong><span>${esc(truncate(eventSummary(state, currentEvent.event), 150))}</span><time datetime="${new Date(currentEvent.ts).toISOString()}">${esc(new Date(currentEvent.ts).toLocaleTimeString())}</time>` : `<span>Waiting for orchestration receipts</span>`}
    </div>
    ${adaptationHtml}
    <div class="orch-grid">
      <section class="orch-section" aria-labelledby="orch-agents-title">
        <div class="orch-section-head"><h3 id="orch-agents-title">Roster · Workspace topology</h3><span>${nodes.length}</span></div>
        <ul class="orch-agent-list">${nodeRows || `<li class="orch-empty">Waiting for configuration</li>`}</ul>
      </section>
      <section class="orch-section" aria-labelledby="orch-plan-title">
        <div class="orch-section-head"><h3 id="orch-plan-title">Dynamic task frontier</h3><span>${state.taskGraph ? `${state.taskGraph.expansions.length} expansions` : "not initialized"} / ${progressCompleted}/${progressTotal}</span></div>
        <div class="orch-progress" role="progressbar" aria-label="Task completion" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressValue}"><span style="width:${progressValue}%"></span></div>
        <ul class="orch-task-list">${taskAndChildRows || `<li class="orch-empty">No tasks recorded</li>`}</ul>
      </section>
      <section class="orch-section" aria-labelledby="orch-composition-title">
        <div class="orch-section-head"><h3 id="orch-composition-title">Composition</h3><span>${compositions.length} certified</span></div>
        <ul class="orch-composition-list">${compositionRows || `<li class="orch-empty">No compositions recorded</li>`}</ul>
      </section>
      <section class="orch-section orch-timeline" aria-labelledby="orch-replay-title">
        <div class="orch-section-head"><h3 id="orch-replay-title">Replay timeline</h3><span>${timeline.length} shown</span></div>
        <ol class="orch-event-list">${timelineRows || `<li class="orch-empty">No kernel receipts recorded</li>`}</ol>
      </section>
    </div>
  </section>
  <style>
    .orch-board { --orch-bg:#101318; --orch-panel:#15191f; --orch-line:#2b3139; --orch-text:#edf1f5; --orch-muted:#8e98a5; --orch-green:#56d68b; --orch-blue:#64b5f6; --orch-amber:#f2bd5b; --orch-red:#ef6a72; color:var(--orch-text); display:grid; gap:14px; min-width:0; }
    .orch-head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; border-bottom:1px solid var(--orch-line); padding-bottom:12px; }
    .orch-head h2 { margin:2px 0 0; font-size:18px; line-height:1.2; letter-spacing:0; }
    .orch-eyebrow { margin:0; color:var(--orch-muted); font:600 10px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.08em; }
    .orch-replay { flex:none; border:1px solid var(--orch-line); border-radius:4px; padding:5px 8px; color:var(--orch-muted); font:600 10px/1 "IBM Plex Mono",monospace; }
    .orch-replay[data-mode="live"] { color:var(--orch-green); border-color:color-mix(in srgb,var(--orch-green) 45%,var(--orch-line)); }
    .orch-metrics { display:grid; grid-template-columns:repeat(7,minmax(72px,1fr)); margin:0; border:1px solid var(--orch-line); border-radius:6px; overflow:hidden; background:var(--orch-bg); }
    .orch-metrics div { padding:10px 12px; border-right:1px solid var(--orch-line); min-width:0; }
    .orch-metrics div:last-child { border-right:0; }
    .orch-metrics dt { color:var(--orch-muted); font:600 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.06em; }
    .orch-metrics dd { margin:5px 0 0; font:700 18px/1 "Space Grotesk",system-ui,sans-serif; }
    .orch-live { min-width:0; min-height:34px; display:grid; grid-template-columns:auto auto minmax(0,1fr) auto; align-items:center; gap:9px; padding:7px 10px; border:1px solid var(--orch-line); border-radius:5px; background:var(--orch-bg); color:var(--orch-muted); font-size:10px; }
    .orch-live strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--orch-text); font:600 9px/1.2 "IBM Plex Mono",monospace; }
    .orch-live>span:not(.orch-live-label) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .orch-live time { white-space:nowrap; font:9px/1.2 "IBM Plex Mono",monospace; }
    .orch-live-label { display:flex; align-items:center; gap:6px; color:var(--orch-green); font:600 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; }
    .orch-live[data-mode="replay"] .orch-live-label { color:var(--orch-amber); }
    .orch-adaptation { display:grid; gap:9px; padding:10px 12px; border:1px solid var(--orch-line); border-radius:6px; background:var(--orch-bg); }
    .orch-adaptation-head,.orch-topology-row { display:flex; align-items:center; justify-content:space-between; gap:10px; min-width:0; }
    .orch-adaptation-head>div:first-child { display:flex; align-items:baseline; gap:8px; }
    .orch-adaptation-kicker { color:var(--orch-muted); font:600 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; letter-spacing:.06em; }
    .orch-adaptation-head strong { font-size:12px; }
    .orch-action-list { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:5px; }
    .orch-action-list span { border:1px solid var(--orch-line); border-radius:4px; padding:3px 6px; color:var(--orch-blue); font:600 9px/1 "IBM Plex Mono",monospace; }
    .orch-topology-row { justify-content:flex-start; }
    .orch-topology-size { flex:none; color:var(--orch-green); font:700 13px/1 "IBM Plex Mono",monospace; }
    .orch-topology-row code { min-width:0; overflow-wrap:anywhere; color:var(--orch-text); font:10px/1.4 "IBM Plex Mono",monospace; }
    .orch-topology-row>span:last-child { margin-left:auto; color:var(--orch-muted); font:9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; }
    .orch-adaptation p { margin:0; color:var(--orch-muted); font-size:10px; line-height:1.45; }
    .orch-live-dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
    .orch-grid { display:grid; grid-template-columns:minmax(170px,.8fr) minmax(250px,1.25fr) minmax(190px,1fr); border:1px solid var(--orch-line); border-radius:6px; overflow:hidden; background:var(--orch-panel); }
    .orch-section { min-width:0; padding:13px; border-right:1px solid var(--orch-line); }
    .orch-section:nth-child(3) { border-right:0; }
    .orch-timeline { grid-column:1/-1; border-top:1px solid var(--orch-line); border-right:0; }
    .orch-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .orch-section-head h3 { margin:0; font-size:12px; letter-spacing:0; }
    .orch-section-head span { color:var(--orch-muted); font:10px/1.2 "IBM Plex Mono",monospace; white-space:nowrap; }
    .orch-agent-list,.orch-task-list,.orch-composition-list,.orch-event-list { list-style:none; display:grid; gap:5px; padding:0; margin:0; max-height:280px; overflow:auto; scrollbar-gutter:stable; }
    .orch-event-list { max-height:190px; }
    .orch-agent-group { position:sticky; top:0; z-index:1; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 3px 3px; color:var(--orch-muted); background:var(--orch-panel); font:600 9px/1.2 "IBM Plex Mono",monospace; text-transform:uppercase; }
    .orch-agent,.orch-task,.orch-composition { min-height:42px; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:9px; padding:7px 8px; border:1px solid transparent; border-radius:4px; background:var(--orch-bg); }
    .orch-agent { padding-left:calc(8px + var(--orch-depth) * 14px); position:relative; }
    .orch-agent-line { display:block; position:absolute; left:calc(10px + var(--orch-depth) * 8px); top:0; bottom:0; border-left:1px solid var(--orch-line); }
    .orch-agent[data-depth="0"] .orch-agent-line { display:none; }
    .orch-avatar { width:24px; height:24px; display:grid; place-items:center; border:1px solid var(--orch-line); border-radius:50%; color:var(--orch-muted); font:600 10px/1 "IBM Plex Mono",monospace; }
    .orch-agent-main,.orch-task-main,.orch-composition-main { display:grid; gap:2px; min-width:0; }
    .orch-agent-main strong,.orch-task-main strong,.orch-composition-main strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
    .orch-agent-main span,.orch-task-main span,.orch-composition-main span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--orch-muted); font-size:10px; }
    .orch-task-io { font-family:"IBM Plex Mono",monospace; }
    .orch-progress { height:3px; margin:-3px 0 9px; overflow:hidden; border-radius:2px; background:var(--orch-line); }
    .orch-progress span { display:block; height:100%; background:var(--orch-green); }
    .orch-status { position:relative; width:8px; height:8px; border-radius:50%; background:var(--orch-muted); }
    [data-status="ready"] .orch-status,[data-status="waiting"] .orch-status,[data-status="leased"] .orch-status { background:var(--orch-amber); }
    [data-status="running"] .orch-status { background:var(--orch-blue); box-shadow:0 0 0 3px color-mix(in srgb,var(--orch-blue) 18%,transparent); }
    [data-status="running"] .orch-status::after { content:""; position:absolute; inset:-4px; border:1px solid var(--orch-blue); border-radius:50%; animation:orch-pulse 1.4s ease-out infinite; }
    [data-status="accepted"] .orch-status,[data-status="skipped"] .orch-status,[data-status="certified"] .orch-status { background:var(--orch-green); }
    [data-status="failed"] .orch-status,[data-status="canceled"] .orch-status,[data-status="rejected"] .orch-status { background:var(--orch-red); }
    .orch-state { color:var(--orch-muted); font:9px/1 "IBM Plex Mono",monospace; text-transform:uppercase; }
    [data-status="running"]>.orch-state { color:var(--orch-blue); }
    [data-status="accepted"]>.orch-state,[data-status="skipped"]>.orch-state,[data-status="certified"]>.orch-state { color:var(--orch-green); }
    [data-status="failed"]>.orch-state,[data-status="canceled"]>.orch-state,[data-status="rejected"]>.orch-state { color:var(--orch-red); }
    .orch-merge-mark { width:24px; height:24px; display:grid; place-items:center; border:1px solid var(--orch-line); border-radius:4px; color:var(--orch-muted); font:700 13px/1 "IBM Plex Mono",monospace; }
    [data-status="certified"] .orch-merge-mark { color:var(--orch-green); border-color:color-mix(in srgb,var(--orch-green) 45%,var(--orch-line)); }
    [data-status="rejected"] .orch-merge-mark { color:var(--orch-red); border-color:color-mix(in srgb,var(--orch-red) 45%,var(--orch-line)); }
    .orch-event { display:grid; grid-template-columns:72px minmax(0,1fr); gap:8px; padding:6px 4px; border-bottom:1px solid var(--orch-line); }
    .orch-event:last-child { border-bottom:0; }
    .orch-event time { color:var(--orch-muted); font:9px/1.4 "IBM Plex Mono",monospace; }
    .orch-event>span { display:grid; gap:2px; min-width:0; color:var(--orch-muted); font-size:10px; }
    .orch-event strong { color:var(--orch-text); font:600 9px/1.2 "IBM Plex Mono",monospace; }
    .orch-empty { padding:12px; color:var(--orch-muted); font-size:11px; }
    .orch-compact .orch-grid { grid-template-columns:1fr; }
    .orch-compact .orch-section { border-right:0; }
    .orch-compact .orch-section:not(:last-child) { border-bottom:1px solid var(--orch-line); }
    @keyframes orch-pulse { from { opacity:.8; transform:scale(.65); } to { opacity:0; transform:scale(1.35); } }
    @media (prefers-reduced-motion:reduce) { [data-status="running"] .orch-status::after { animation:none; } }
    @media (max-width:900px) { .orch-metrics { grid-template-columns:repeat(3,1fr); } .orch-metrics div:nth-child(3) { border-right:0; } .orch-metrics div:nth-child(-n+3) { border-bottom:1px solid var(--orch-line); } .orch-grid { grid-template-columns:1fr; } .orch-section { border-right:0; border-bottom:1px solid var(--orch-line); } .orch-timeline { grid-column:auto; border-top:0; border-bottom:0; } }
    @media (max-width:520px) { .orch-head { align-items:flex-start; } .orch-metrics { grid-template-columns:repeat(2,1fr); } .orch-metrics div:nth-child(3) { border-right:1px solid var(--orch-line); } .orch-metrics div:nth-child(2n) { border-right:0; } .orch-metrics div:nth-child(-n+4) { border-bottom:1px solid var(--orch-line); } .orch-live { grid-template-columns:auto minmax(0,1fr) auto; } .orch-live strong { display:none; } .orch-event { grid-template-columns:58px minmax(0,1fr); } }
  </style>`;
};
