import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

import { Hono } from "hono";

import { memoryBranchStore, memoryStore } from "../../src/adapters/memory-store.ts";
import { createRuntime } from "../../src/core/runtime.ts";
import { hashCanonical } from "../../src/core/canonical.ts";
import * as codingRoomStream from "../../src/browser/coding-room-stream.ts";

import {
  createCodingRoute as createCodingRouteWithDeps,
  discoverCodingRuntimeOnboardingOptions,
  discoverCodingWorkerRuntimeOptions,
  executeCodingWorkspaceRescanJob,
  type CodingAgentRuntime,
  type CodingRouteDeps,
} from "../../src/agents/coding.agent.ts";
import type { AgentLoaderContext } from "../../src/framework/agent-types.ts";
import type { QueueJob, QueueCommandRecord } from "../../src/engine/runtime/job-queue.ts";
import { InMemoryTaskGraphControl } from "../../src/engine/orchestration/task-graph-control.ts";
import { InMemoryDataReferenceStore } from "../../src/engine/dataflow/data-reference-store.ts";
import { NodeRuntimeLogStore } from "../../src/engine/runtime/node-runtime-log.ts";
import {
  NodeRoomUpdateStore,
  type NodeRoomUpdateStoreEvent,
} from "../../src/engine/runtime/node-room-updates.ts";
import {
  createRosterTaskContext,
  SharedWorkspaceLedger,
} from "../../src/engine/workspace/shared-workspace.ts";
import type { RosterPlatformExecutionOptions } from "../../src/engine/platform/roster-platform.ts";
import {
  initialOrchestrationState,
  inlineArtifactPublishedEvent,
  nodeRuntimeBoundEvent,
  orchestrationConfiguredEvent,
  orchestrationOutputValues,
  reduceOrchestration,
  type OrchestrationEvent,
  type OrchestrationState,
} from "../../src/modules/orchestration.ts";
import type { DomainPack } from "../../src/engine/orchestration/types.ts";
import {
  DEFAULT_CODING_WORKER_RUNTIME_OPTIONS,
  codingComposerClientPrelude,
  codingReviewShell,
  codingWorkbenchClientPrelude,
  codingRunDeliveryState,
  codingRunPanelHtml,
  codingRunProgress,
  codingShell,
} from "../../src/views/coding.ts";
import {
  codingInvestigationReportFilename,
  parseCodingInvestigationReport,
  renderCodingInvestigationReport,
} from "../../src/views/coding-investigation-report.ts";
import {
  codingConversationImageEvent,
  codingConversationMessageEvent,
  codingConversationRouteEvent,
  createCodingConversationImage,
  createCodingConversationMessage,
  createCodingConversationRoute,
  type CodingConversationPlanner,
  type CodingConversationRepositoryContext,
} from "../../src/domains/coding-conversation.ts";
import {
  codingControlDeliveryEvent,
  createCodingControlIngressAuthorization,
} from "../../src/domains/coding-control-ingress.ts";
import { createCodingAgentTurn } from "../../src/domains/coding-agent-turn.ts";
import { createCodingImprovementRuntimePin } from "../../src/domains/coding-improvements.ts";
import {
  codingAcceptedOutputProjectionKey,
  projectCodingAcceptedOutputs,
} from "../../src/domains/coding-accepted-outputs.ts";
import { ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION } from "../../src/engine/runtime/self-improvement-framework.ts";
import { gitRoomBranchName } from "../../src/engine/runtime/git-run-workspace.ts";
import {
  createCodingWorkerExecution,
  type CodingWorkerExecution,
} from "../../src/domains/coding-execution.ts";
import {
  CODING_WORKSPACE_PROFILE_OUTPUT,
  CODING_WORKSPACE_CATALOG_STREAM,
  codingRepositoryWorkspace,
  codingWorkspaceSettingsOutputKey,
  parseCodingRepositoryWorkspace,
  parseCodingWorkspaceSettings,
  codingWorkspacePack,
  reviewCodingWorkspaceSnapshot,
} from "../../src/domains/coding-workspace.ts";
import {
  codingRepositoryRoomId,
  codingRoomProjection,
  codingRoomReactionEvent,
  createCodingRoomReaction,
  type CodingRoomDirectory,
} from "../../src/domains/coding-room.ts";
import { codingAcceptedContinuationFixture } from "../helpers/coding-accepted-continuation-fixture.ts";

const execFileAsync = promisify(execFile);

const codingWorkbenchClientBehavior = (workbench: string | ReadonlyArray<string> | undefined, overlay: boolean) => {
  const values = workbench === undefined ? [] : typeof workbench === "string" ? [workbench] : workbench;
  return JSON.parse(JSON.stringify(runInNewContext(`
${codingWorkbenchClientPrelude}
const url = new URL(${JSON.stringify(`https://roster.test/coding?workspace=workspace-test${values.map((value) => `&workbench=${encodeURIComponent(value)}`).join("")}`)});
const tab = canonicalWorkbenchTab(url);
({ tab, href: url.href, opens: Boolean(tab), closesOnEscape: workbenchEscapeCloses(${overlay}) });
`, { URL }))) as {
  readonly tab?: string;
  readonly href: string;
  readonly opens: boolean;
  readonly closesOnEscape: boolean;
};
};

const codingComposerClientBehavior = () => JSON.parse(JSON.stringify(runInNewContext(`
${codingComposerClientPrelude}
const unchanged = codingComposerRevisionState();
const unchangedSubmitRevision = unchanged.revision;
const edited = codingComposerRevisionState();
const editedSubmitRevision = edited.revision;
codingComposerRecordInput(edited);
codingComposerRecordInput(edited);
({
  clearsUnchangedAcceptedDraft: codingComposerCanClearDraft(unchanged, unchangedSubmitRevision, true),
  clearsUnconfirmedDraft: codingComposerCanClearDraft(unchanged, unchangedSubmitRevision, false),
  clearsEditedRoundTripDraft: codingComposerCanClearDraft(edited, editedSubmitRevision, true),
  away: codingComposerLiveEdgeAfterAppend({
    distanceFromBottom: 81,
    scrollTop: 640,
    scrollHeight: 2600,
    unreadCount: 2,
  }),
  near: codingComposerLiveEdgeAfterAppend({
    distanceFromBottom: 80,
    scrollTop: 1800,
    scrollHeight: 2600,
    unreadCount: 2,
  }),
});
`, {}))) as {
  readonly clearsUnchangedAcceptedDraft: boolean;
  readonly clearsUnconfirmedDraft: boolean;
  readonly clearsEditedRoundTripDraft: boolean;
  readonly away: { readonly followEnd: boolean; readonly scrollTop: number; readonly unreadCount: number };
  readonly near: { readonly followEnd: boolean; readonly scrollTop: number; readonly unreadCount: number };
};

test("Coding composer revisions and live-edge appends preserve newer drafts and an away reader", () => {
  assert.deepEqual(codingComposerClientBehavior(), {
    clearsUnchangedAcceptedDraft: true,
    clearsUnconfirmedDraft: false,
    clearsEditedRoundTripDraft: false,
    away: { followEnd: false, scrollTop: 640, unreadCount: 3 },
    near: { followEnd: true, scrollTop: 2600, unreadCount: 0 },
  });
});

test("coding Workbench client behavior canonicalizes URLs and only dismisses overlays on Escape", () => {
  assert.deepEqual(codingWorkbenchClientBehavior("changes", false), {
    href: "https://roster.test/coding?workspace=workspace-test",
    opens: false,
    closesOnEscape: false,
  });
  assert.deepEqual(codingWorkbenchClientBehavior("artifacts", true), {
    href: "https://roster.test/coding?workspace=workspace-test",
    opens: false,
    closesOnEscape: true,
  });
  assert.deepEqual(codingWorkbenchClientBehavior("files", false), {
    tab: "files",
    href: "https://roster.test/coding?workspace=workspace-test&workbench=files",
    opens: true,
    closesOnEscape: false,
  });
  assert.deepEqual(codingWorkbenchClientBehavior(["changes", "files"], false), {
    tab: "files",
    href: "https://roster.test/coding?workspace=workspace-test&workbench=files",
    opens: true,
    closesOnEscape: false,
  });
  assert.deepEqual(codingWorkbenchClientBehavior(["team", "team"], false), {
    tab: "team",
    href: "https://roster.test/coding?workspace=workspace-test&workbench=team",
    opens: true,
    closesOnEscape: false,
  });
  assert.deepEqual(codingWorkbenchClientBehavior(["changes", "artifacts"], false), {
    href: "https://roster.test/coding?workspace=workspace-test",
    opens: false,
    closesOnEscape: false,
  });
});

const directChildTagNames = (html: string, parentAttribute: string): ReadonlyArray<string> => {
  const opening = new RegExp(`<([a-z][\\w-]*)\\b[^>]*${parentAttribute}[^>]*>`, "iu").exec(html);
  assert.ok(opening, `expected a parent with ${parentAttribute}`);
  const parentName = opening[1]!.toLowerCase();
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const tags: string[] = [];
  const tagPattern = /<\/?([a-z][\w-]*)\b[^>]*>/giu;
  tagPattern.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const tagName = match[1]!.toLowerCase();
    const closing = match[0].startsWith("</");
    if (closing) {
      depth -= 1;
      if (depth === 0) {
        assert.equal(tagName, parentName);
        break;
      }
      continue;
    }
    if (depth === 1) tags.push(tagName);
    if (!voidTags.has(tagName) && !match[0].endsWith("/>")) depth += 1;
  }
  assert.equal(depth, 0, `expected a closing ${parentName} tag`);
  return tags;
};

const socialRowBody = (html: string, sourceKind: string, authorNodeId: string): string => {
  const rowStart = html.search(new RegExp(`<article[^>]*data-source-kind="${sourceKind}"[^>]*data-author-node-id="${authorNodeId.replaceAll(".", "\\.")}"`, "u"));
  assert.ok(rowStart >= 0, `expected ${sourceKind} row by ${authorNodeId}`);
  const bodyStartMarker = '<div class="coding-message-body">';
  const bodyStart = html.indexOf(bodyStartMarker, rowStart);
  const bodyEnd = html.indexOf('<details class="coding-message-evidence"', bodyStart);
  assert.ok(bodyStart >= rowStart && bodyEnd > bodyStart, `expected bounded body for ${sourceKind} row`);
  return html.slice(bodyStart + bodyStartMarker.length, bodyEnd);
};

type ParsedHtmlNode = {
  readonly tagName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly parent?: ParsedHtmlNode;
  readonly children: ParsedHtmlNode[];
  readonly content: Array<string | ParsedHtmlNode>;
};

const parseStrictHtmlFragment = (html: string): ParsedHtmlNode => {
  const root: ParsedHtmlNode = { tagName: "#root", attributes: {}, children: [], content: [] };
  const stack: ParsedHtmlNode[] = [root];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const tagPattern = /<\/?([a-z][\w-]*)\b[^>]*>/giu;
  let contentOffset = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const raw = match[0];
    const tagName = match[1]!.toLowerCase();
    if (match.index > contentOffset) stack.at(-1)!.content.push(html.slice(contentOffset, match.index));
    contentOffset = match.index + raw.length;
    if (raw.startsWith("</")) {
      assert.equal(stack.at(-1)?.tagName, tagName, `mismatched closing ${tagName}`);
      stack.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const attribute of raw.matchAll(/\s([A-Za-z_:][\w:.-]*)(?:="([^"]*)")?/gu)) {
      attributes[attribute[1]!.toLowerCase()] = attribute[2] ?? "";
    }
    const parent = stack.at(-1)!;
    const node: ParsedHtmlNode = { tagName, attributes, parent, children: [], content: [] };
    parent.children.push(node);
    parent.content.push(node);
    if (!voidTags.has(tagName) && !raw.endsWith("/>")) stack.push(node);
  }
  if (contentOffset < html.length) stack.at(-1)!.content.push(html.slice(contentOffset));
  assert.deepEqual(stack.map((node) => node.tagName), ["#root"], "every rendered element closes inside the parsed fragment");
  return root;
};

const parsedDescendants = (
  node: ParsedHtmlNode,
  predicate: (candidate: ParsedHtmlNode) => boolean,
): ReadonlyArray<ParsedHtmlNode> => node.children.flatMap((child) => [
  ...(predicate(child) ? [child] : []),
  ...parsedDescendants(child, predicate),
]);

const parsedTextContent = (node: ParsedHtmlNode): string => node.content
  .map((item) => typeof item === "string" ? item : parsedTextContent(item))
  .join(" ")
  .replace(/\s+/gu, " ")
  .trim();

const hasParsedClass = (node: ParsedHtmlNode, className: string): boolean =>
  (node.attributes.class ?? "").split(/\s+/u).includes(className);

const codingSocialRows = (html: string): ReadonlyArray<ParsedHtmlNode> => {
  const marker = html.indexOf("data-coding-room-transcript");
  const transcriptStart = html.lastIndexOf("<ol", marker);
  const transcriptEnd = html.indexOf("</ol>", marker);
  assert.ok(marker >= 0 && transcriptStart >= 0 && transcriptEnd > marker, "expected a bounded Coding transcript");
  const parsed = parseStrictHtmlFragment(html.slice(transcriptStart, transcriptEnd + "</ol>".length));
  const transcripts = parsedDescendants(parsed, (node) => "data-coding-room-transcript" in node.attributes);
  assert.equal(transcripts.length, 1, "expected one Coding transcript");
  return parsedDescendants(transcripts[0]!, (node) => "data-coding-social-row" in node.attributes);
};

const codingSocialRow = (
  rows: ReadonlyArray<ParsedHtmlNode>,
  expected: Readonly<Record<string, string>>,
): ParsedHtmlNode => {
  const matches = rows.filter((row) => Object.entries(expected).every(
    ([attribute, value]) => row.attributes[attribute] === value,
  ));
  assert.equal(matches.length, 1, `expected one Coding social row matching ${JSON.stringify(expected)}`);
  return matches[0]!;
};

const codingRowRecipients = (row: ParsedHtmlNode): ReadonlyArray<string> => parsedDescendants(
  row,
  (node) => hasParsedClass(node, "coding-message-recipient"),
).map(parsedTextContent);

const assertSystemRowsAreNotAuthoredSpeech = (rows: ReadonlyArray<ParsedHtmlNode>): void => {
  for (const row of rows.filter((candidate) => candidate.attributes["data-source-kind"] === "system-activity")) {
    const bodies = parsedDescendants(row, (node) => hasParsedClass(node, "coding-message-body"));
    if (bodies.some((body) => /\bI(?:['’]m| am)\b/u.test(parsedTextContent(body)))) {
      throw new Error(`system-activity row ${row.attributes["data-row-id"] ?? "unknown"} contains first-person authored speech`);
    }
  }
};

const rescanExecutionPlanes = (runId: string) => {
  const taskGraph = new InMemoryTaskGraphControl();
  const dataReferences = new InMemoryDataReferenceStore();
  const ledger = new SharedWorkspaceLedger(`workspace-rescan-${runId}`);
  const createTaskContext: RosterPlatformExecutionOptions["createTaskContext"] = ({
    node,
    definition,
    lease,
  }) => createRosterTaskContext({
    node,
    ledger,
    fence: {
      runId,
      taskId: definition.taskId,
      nodeId: definition.nodeId,
      fence: BigInt(lease.fence),
      runtimeBindingEpoch: definition.runtimeBindingEpoch,
      frontierVersion: definition.inputs.frontierVersion,
      topologyVersion: definition.inputs.topologyVersion,
      catalogVersion: definition.inputs.catalogVersion,
      inputVersions: definition.inputs.inputVersions,
    },
    authority: {
      assertActive: async () => {
        const snapshot = await taskGraph.snapshot();
        const record = snapshot.tasks.find((candidate) =>
          candidate.definition.taskId === definition.taskId);
        if (
          !record
          || (record.status !== "leased" && record.status !== "running")
          || record.leaseFence !== lease.fence
        ) throw new Error(`Task ${definition.taskId} no longer owns its workspace fence`);
      },
    },
  });
  return { taskGraph, dataReferences, createTaskContext };
};

const projectedTaskGraph = (
  runId: string,
  tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly nodeId: string;
    readonly capability: string;
    readonly status: NonNullable<OrchestrationState["taskGraph"]>["tasks"][number]["status"];
    readonly attempt?: number;
    readonly objective?: string;
    readonly dependencies?: NonNullable<OrchestrationState["taskGraph"]>["tasks"][number]["dependencies"];
    readonly continuationTaskId?: string;
    readonly error?: string;
  }>,
): NonNullable<OrchestrationState["taskGraph"]> => ({
  runId,
  projectionVersion: `projection-${runId}`,
  tasks: tasks.map((task) => ({
    ...task,
    objective: task.objective ?? task.capability,
    attempt: task.attempt ?? 1,
    dependencies: task.dependencies ?? [],
  })),
  expansions: [],
  acceptedCostMicros: 0,
  acceptedTokens: 0,
  updatedAt: 1,
});

const withGraphStatus = (
  state: OrchestrationState,
  status: NonNullable<OrchestrationState["taskGraph"]>["tasks"][number]["status"],
): OrchestrationState => ({
  ...state,
  taskGraph: state.taskGraph
    ? {
        ...state.taskGraph,
        tasks: state.taskGraph.tasks.map((task) => ({
          ...task,
          status,
          ...(status === "failed" ? { error: "task failed" } : {}),
        })),
      }
    : undefined,
});

const testRoomDirectory: CodingRoomDirectory = {
  backfill: async () => undefined,
  list: async () => [],
};

const createCodingRoute = (
  deps: Omit<CodingRouteDeps, "rooms"> & { readonly rooms?: CodingRoomDirectory },
) => createCodingRouteWithDeps({ ...deps, rooms: deps.rooms ?? testRoomDirectory });

const testWorkerExecution = (
  runtime: "claude-code" | "codex-cli" | "pi-agent" | "hermes-agent" = "pi-agent",
  workerModel?: string,
): CodingWorkerExecution => createCodingWorkerExecution({
  runtime,
  source: "product-default",
  ...(workerModel ? { workerModel } : {}),
  env: {},
});

const explicitMutationPlanner: CodingConversationPlanner = async ({ messages, workspaceNodes, activeRunContext }) => {
  if (activeRunContext && messages.at(-1)?.text === "What is the current status? Keep working.") {
    return {
      disposition: "informational",
      selectedNodeIds: [],
      tags: ["intent:status"],
      questions: [],
      answer: `${activeRunContext.acceptedTasks} of ${activeRunContext.totalTasks} tasks are accepted; ${activeRunContext.inflightTasks} are in flight.`,
      rationale: "Answered from the durable active-run projection without changing the work.",
      confidence: 1,
    };
  }
  const worker = workspaceNodes.find((node) => node.capabilities.includes("implement"));
  const reviewer = workspaceNodes.find((node) =>
    node.id !== worker?.id
    && node.metadata?.participantKind !== "human"
    && node.capabilities.includes("review"));
  const plannerRecommendsReviewedInvestigation = messages.at(-1)?.text.startsWith("Planner reviewed investigation:") ?? false;
  const plannerRecommendsFast = messages.at(-1)?.text.startsWith("Planner recommends fast:") ?? false;
  return {
    disposition: plannerRecommendsReviewedInvestigation ? "investigating" : "ready",
    selectedNodeIds: [worker?.id, ...(plannerRecommendsFast || plannerRecommendsReviewedInvestigation ? [] : [reviewer?.id])]
      .filter((nodeId): nodeId is string => Boolean(nodeId)),
    ...(worker ? { primaryNodeId: worker.id } : {}),
    coordination: { reviewMode: plannerRecommendsFast ? "fast" : "reviewed", validationScope: "focused" },
    tags: messages.at(-1)?.tags ?? [],
    questions: [],
    rationale: "The test submitted an explicit mutation objective.",
    confidence: 1,
  };
};

test("coding run panel presents an exact branch as a human-agent room", () => {
  const message = createCodingConversationMessage({
    conversationId: "conversation-room-1",
    author: { kind: "agent", id: "coordinator", name: "Roster" },
    source: { kind: "agent" },
    text: "**I’ll** keep this room with the branch.\n\n- Preserve the conversation\n- Keep the branch bounded\n\n<script>alert('unsafe')</script>",
    createdAt: 10,
  });
  const reaction = createCodingRoomReaction({
    conversationId: "conversation-room-1",
    messageId: message.messageId,
    authorId: "human.operator",
    emoji: "👍",
    createdAt: 11,
  });
  const diagram = createCodingConversationMessage({
    conversationId: "conversation-room-1",
    author: { kind: "agent", id: "coordinator", name: "Roster" },
    source: { kind: "agent" },
    text: "```mermaid\ngraph TD\n  ROOM[Room] --> NODE[Workspace node]\n```",
    createdAt: 12,
  });
  const html = codingRunPanelHtml({
    state: initialOrchestrationState,
    events: [
      codingConversationMessageEvent(message),
      codingRoomReactionEvent(reaction),
      codingConversationMessageEvent(diagram),
    ],
    runId: "conversation-room-1",
    job: {
      id: "job-room-1",
      status: "running",
      branch: "roster/social-room-1",
      objective: "Keep the implementation conversation natural across runs.",
    },
  });

  assert.match(html, /data-room-kind="branch" data-room-state="open"/);
  assert.match(html, /data-thinking-orb data-orb-state="listening" data-orb-size="20"/);
  assert.match(html, /<h2>#social-room-1<\/h2>/);
  assert.match(html, /data-node-id="human\.operator" data-kind="human" data-presence="present"/);
  assert.doesNotMatch(html, /data-node-id="coordinator" data-kind="system"/);
  assert.match(html, /Branch-scoped · conversation continues across runs/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true">1 person here<\/p>/);
  assert.match(html, /Branch<\/span><code>roster\/social-room-1<\/code>/);
  assert.doesNotMatch(html, /role="tablist" aria-label="Room views"/);
  assert.match(html, /data-slot="room-timeline"[\s\S]*aria-label="Room conversation"/);
  assert.match(html, /data-coding-social-row[^>]*data-source-kind="message"[^>]*data-author-node-id="coordinator"/);
  assert.match(html, /data-slot="context-cast"[^>]*aria-labelledby="coding-context-cast-title"/);
  assert.match(html, /data-slot="room-participants"/);
  assert.match(html, />Workbench<\/span><\/button>/);
  assert.match(html, /data-coding-context-toggle/);
  assert.match(html, /role="tablist" aria-label="Workbench views"/);
  assert.deepEqual(
    [...html.matchAll(/data-coding-workbench-tab="([^"]+)"/g)].map((match) => match[1]),
    ["work", "files", "team", "details"],
  );
  for (const panel of ["work", "files", "team", "details"]) {
    assert.match(html, new RegExp(`data-workbench-panel="${panel}"`));
  }
  assert.doesNotMatch(html, /data-coding-workbench-tab="changes"/);
  assert.doesNotMatch(html, /data-coding-workbench-tab="artifacts"/);
  assert.match(html, /data-slot="context-frontier"/);
  assert.match(html, /<details class="coding-operations"/);
  assert.doesNotMatch(html, /coding-message-reactions/);
  assert.doesNotMatch(html, /aria-label="React /);
  assert.doesNotMatch(html, /Room Reaction/);
  assert.doesNotMatch(html, /roster\.coding-room-reaction\.v1/);
  assert.doesNotMatch(html, /coding-message system">\s*<span class="coding-message-avatar" aria-hidden="true">T<\/span>/);
  assert.match(html, /class="coding-message-body"/);
  assert.match(html, /<strong>I’ll<\/strong>/);
  assert.match(html, /<ul>[\s\S]*Preserve the conversation[\s\S]*Keep the branch bounded[\s\S]*<\/ul>/);
  assert.match(html, /&lt;script>alert\('unsafe'\)&lt;\/script>/);
  assert.doesNotMatch(html, /<script>alert\('unsafe'\)<\/script>/);
  assert.match(html, /<pre lang="mermaid"><code>graph TD/);

  const starterHtml = codingRunPanelHtml({ state: initialOrchestrationState, events: [] });
  assert.doesNotMatch(starterHtml, /class="coding-starter-actions"/);
  assert.doesNotMatch(starterHtml, /What do you want to accomplish\?/);
  assert.doesNotMatch(starterHtml, /data-room-empty[\s\S]*Start a conversation/);
  assert.match(starterHtml, /class="coding-room"[\s\S]*class="coding-room-timeline"/);
});

test("coding runtime picker projects only locally executable CLIs", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-runtime-options-"));
  try {
    await writeFile(join(root, "codex"), "#!/bin/sh\nif [ \"$1\" = \"mcp\" ]; then printf '[{\"name\":\"docs\",\"enabled\":true,\"transport\":{\"type\":\"streamable_http\",\"url\":\"https://secret.invalid/mcp\"}}]'; fi\nexit 0\n");
    await chmod(join(root, "codex"), 0o755);
    const options = await discoverCodingWorkerRuntimeOptions({ PATH: root }, process.platform);
    assert.deepEqual(options.map((option) => option.value), ["codex-cli"]);
    assert.equal(options[0]?.label, "Codex CLI");
    assert.deepEqual(options[0]?.mcp?.servers, [{
      name: "docs",
      transport: "http",
      status: "enabled",
      source: "runtime",
    }]);
    assert.doesNotMatch(JSON.stringify(options), /secret\.invalid/u);
    const onboarding = await discoverCodingRuntimeOnboardingOptions({ PATH: root }, process.platform);
    assert.deepEqual(onboarding.find((runtime) => runtime.id === "codex-cli"), {
      id: "codex-cli",
      label: "Codex · Sol high",
      detail: "Installed implementation runtime",
      source: "builtin",
      available: true,
      ready: true,
      readiness: "ready",
      access: ["read-only", "workspace-write"],
      mcp: {
        mode: "native",
        readiness: "discovered",
        servers: [{
          name: "docs",
          transport: "http",
          status: "enabled",
          source: "runtime",
        }],
        truncated: false,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const runtime: CodingAgentRuntime = {
  execute: async () => [],
  state: async () => initialOrchestrationState,
  stateAt: async () => initialOrchestrationState,
  chain: async () => [],
  chainAt: async () => [],
  verify: async () => ({ ok: true, count: 0 }),
  fork: async (_stream, _at, name) => ({ name, createdAt: Date.now() }),
  branch: async () => undefined,
  branches: async () => [],
  children: async () => [],
};

test("Needs attention remains server rendered until direct realtime applies", () => {
  const repositoryPath = "/tmp/roster-notification-test";
  const html = codingShell({
    state: initialOrchestrationState,
    events: [],
    nonce: "notification-test",
    repositoryPath,
    gitRemote: "",
    gitAccount: "",
    workspaceId: "workspace-notification-test",
    composerDraft: "Author an improvementPatch with <bounded> evidence.",
    chatModel: "openai-codex/gpt-5.6-luna",
    workspaceProfile: reviewCodingWorkspaceSnapshot({
      repositoryRoot: repositoryPath,
      files: ["package.json"],
      manifests: [{ path: "package.json", content: "{}" }],
      reviewedAt: 1,
    }),
    attentionItems: [{
      id: "attention:job-failed:failed",
      kind: "failed",
      title: "Coding run failed",
      detail: "worker runtime exited before certification",
      workspaceId: "workspace-notification-test",
      workspaceName: "roster-notification-test",
      conversationId: "coding-failed",
      jobId: "job-failed",
      updatedAt: 1,
    }, {
      id: "attention:job-ready:merge-ready",
      kind: "merge-ready",
      title: "Certified code is ready to merge",
      detail: "Roster verified the exact commit and can fast-forward main.",
      workspaceId: "workspace-notification-test",
      workspaceName: "roster-notification-test",
      conversationId: "coding-ready",
      jobId: "job-ready",
      updatedAt: 2,
      targetBranch: "main",
    }],
  });
  assert.match(html, /data-slot="attention-item"[\s\S]*Coding run failed[\s\S]*Retry safely/);
  assert.match(html, /data-slot="agent-shell" data-ui-family="roster-agent"/);
  assert.match(html, /data-workspace-shell[^>]*data-layout="slack-workspace"/);
  assert.match(html, /data-slot="workspace-rail"[^>]*aria-label="Repository rooms and team"/);
  assert.match(html, /data-slot="room-header"/);
  assert.match(html, /data-room-empty/);
  assert.match(html, /data-room-suggestion="understand"/);
  assert.equal((html.match(/data-slot="room-header"/g) ?? []).length, 1);
  assert.match(html, /data-slot="workspace-conversation" data-workspace-region="conversation"/);
  assert.match(html, /data-slot="conversation-feed"/);
  assert.match(html, /data-slot="composer-dock"/);
  assert.match(html, /data-slot="workspace-composer"/);
  assert.doesNotMatch(html, /class="coding-titlebar-breadcrumb"/);
  assert.doesNotMatch(html, /coding-starter-actions[^>]*>[\s\S]*grid-template-columns:repeat\(2/);
  assert.match(html, /<h2>#repository-room<\/h2>/);
  assert.match(html, /Certified code is ready to merge[\s\S]*Merge into main/);
  assert.match(html, /<strong data-attention-count>2<\/strong>/);
  assert.match(html, /--coding-rail-width:240px/);
  assert.match(html, /\.coding-page \.coding-workbench\{height:100dvh;[\s\S]*padding:0/);
  assert.match(html, /\.coding-page \.coding-conversation\{[\s\S]*border-radius:0/);
  assert.match(html, /\.coding-page \.coding-room-kind\{display:none\}/);
  assert.match(html, /\.coding-page \.coding-composer-presence\{display:none\}/);
  assert.match(html, /\.coding-page \.coding-composer-help\{display:flex/);
  assert.match(html, /\.coding-page \.coding-image-previews\{display:flex/);
  assert.match(html, /\.coding-page \.coding-composer\{position:relative;padding:10px 12px 8px/);
  assert.doesNotMatch(html, /--workspace-inspector-width/);
  assert.match(html, /class="coding-run-main coding-run-main-detached"/);
  assert.match(html, /\.coding-page \.coding-run-main-detached\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(html, /\.coding-attention li\{display:grid;grid-template-columns:7px minmax\(0,1fr\);gap:8px;padding:6px/);
  assert.match(html, /src="\/assets\/roster-shell\.js" nonce="notification-test"/);
  assert.match(html, /Routing: GPT-5\.6 Luna/);
  assert.match(html, /Author an improvementPatch with &lt;bounded&gt; evidence\./);
  assert.doesNotMatch(html, /Routing: openai-codex\/gpt-5\.6-luna|Routing: Pi · local/);

  assert.doesNotMatch(html, /fetch\('\/coding\/attention/);
  assert.doesNotMatch(html, /setInterval\([\s\S]{0,240}(?:attention|\/coding\/status)/);
  assert.match(html, /setInterval\(update,1000\)/);
});

test("repository-only coding shell omits links to the unavailable global workspace", () => {
  const html = codingShell({
    state: initialOrchestrationState,
    events: [],
    nonce: "repository-surface-test",
    repositoryPath: "/tmp/roster-repository-surface-test",
    gitRemote: "",
    gitAccount: "",
    showGlobalNavigation: false,
  });

  assert.doesNotMatch(html, /aria-label="Primary navigation"/);
  assert.doesNotMatch(html, /class="top-navbar-brand" href="\/monitor"/);
  assert.doesNotMatch(html, /aria-label="Repository workspace controls"/);
});

test("Coding profiles expose safe room-laned continuity state without inbox contents", () => {
  const repositoryPath = "/tmp/roster-continuity-profile";
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: repositoryPath,
    files: ["package.json", "src/index.ts"],
    manifests: [{ path: "package.json", content: "{}" }],
    reviewedAt: 1,
  });
  const node = profile.nodes.find((candidate) => candidate.metadata?.participantKind !== "human")!;
  const roomId = "coding-room-continuity";
  const html = codingShell({
    state: initialOrchestrationState,
    events: [],
    nonce: "continuity-profile",
    repositoryPath,
    gitRemote: "",
    gitAccount: "",
    workspaceId: "workspace-continuity-profile",
    workspaceProfile: profile,
    rooms: [{
      roomId,
      conversationId: roomId,
      codingWorkspaceId: "workspace-continuity-profile",
      streamId: `coding/rooms/${roomId}`,
      title: "Refine the room-aware scheduler",
      state: "waiting",
      firstMessageId: "message-continuity",
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
    }],
    continuitySummaries: {
      [node.id]: {
        nodeId: node.id,
        status: "working",
        pendingItemCount: 1,
        pendingLaneCount: 1,
        activeCommitmentCount: 2,
        activeLaneId: roomId,
        activeRoomId: roomId,
        memoryUpdatedAt: 2,
        lanes: [{
          laneId: roomId,
          roomId,
          pendingItemCount: 1,
          oldestDeliveredAt: 1,
          active: true,
        }],
      },
    },
  });
  assert.match(html, /data-profile-continuity=/);
  assert.match(html, /Workspace continuity/);
  assert.match(html, /Current activity/);
  assert.match(html, /Queue/);
  assert.match(html, /data-coding-room-activity>Working</);
  assert.match(html, /Inbox contents and private memory remain private/);
  assert.doesNotMatch(html, /payloadReference|message body/);
});

test("Coding profiles show durable continuity before a specialist receives its first message", () => {
  const repositoryPath = "/tmp/roster-dormant-continuity-profile";
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: repositoryPath,
    files: ["package.json", "src/index.ts"],
    manifests: [{ path: "package.json", content: "{}" }],
    reviewedAt: 1,
  });
  const durableNode = profile.nodes.find((candidate) => candidate.continuity?.mode === "workspace")!;
  const html = codingShell({
    state: initialOrchestrationState,
    events: [],
    nonce: "dormant-continuity-profile",
    repositoryPath,
    gitRemote: "",
    gitAccount: "",
    workspaceId: "workspace-dormant-continuity-profile",
    workspaceProfile: profile,
  });
  assert.match(
    html,
    new RegExp(`data-participant-profile="${durableNode.id.replaceAll(".", "\\.")}"[^>]*data-profile-continuity="[^"]*&quot;status&quot;:&quot;dormant&quot;`),
  );
});

test("Coding room rail prioritizes durable agent activity over a stale run label", () => {
  const repositoryPath = "/tmp/roster-continuity-active-run";
  const profile = reviewCodingWorkspaceSnapshot({
    repositoryRoot: repositoryPath,
    files: ["package.json", "src/index.ts"],
    manifests: [{ path: "package.json", content: "{}" }],
    reviewedAt: 1,
  });
  const node = profile.nodes.find((candidate) => candidate.metadata?.participantKind !== "human")!;
  const roomId = "coding-room-with-run";
  const html = codingShell({
    state: initialOrchestrationState,
    events: [],
    nonce: "continuity-active-run",
    repositoryPath,
    gitRemote: "",
    gitAccount: "",
    workspaceId: "workspace-continuity-active-run",
    workspaceProfile: profile,
    rooms: [{
      roomId,
      conversationId: roomId,
      codingWorkspaceId: "workspace-continuity-active-run",
      streamId: `coding/rooms/${roomId}`,
      title: "Continue an existing room",
      state: "active",
      firstMessageId: "message-active-run",
      messageCount: 2,
      createdAt: 1,
      updatedAt: 2,
    }],
    recentRuns: [{
      id: "job-active-run",
      runId: roomId,
      conversationId: roomId,
      objective: "Continue an existing room",
      status: "completed",
      updatedAt: 1,
    }],
    continuitySummaries: {
      [node.id]: {
        nodeId: node.id,
        status: "working",
        pendingItemCount: 1,
        pendingLaneCount: 1,
        activeCommitmentCount: 0,
        activeLaneId: roomId,
        activeRoomId: roomId,
        lanes: [{
          laneId: roomId,
          roomId,
          pendingItemCount: 1,
          oldestDeliveredAt: 1,
          active: true,
        }],
      },
    },
  });
  assert.match(html, /data-coding-room-activity>Working</);
  assert.doesNotMatch(html, /Completed · moments ago/);
});

test("workspace rescan worker runs a tracked branchless dynamic graph and publishes one profile revision", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-tracked-rescan-"));
  t.after(async () => rm(repositoryRoot, { recursive: true, force: true }));
  await writeFile(join(repositoryRoot, "package.json"), JSON.stringify({
    scripts: { test: "node --test" },
    dependencies: { hono: "1.0.0" },
  }));
  await writeFile(join(repositoryRoot, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  await writeFile(join(repositoryRoot, "server.ts"), "export const ready = true;\n");
  await execFileAsync("git", ["init"], { cwd: repositoryRoot });
  await execFileAsync("git", ["add", "."], { cwd: repositoryRoot });
  const trackedRuntime = createRuntime(
    memoryStore<OrchestrationEvent>(),
    memoryBranchStore(),
    (command: Parameters<CodingAgentRuntime["execute"]>[1]) => [command.event],
    reduceOrchestration,
    initialOrchestrationState,
  );
  const workspace = codingRepositoryWorkspace(repositoryRoot);
  const previousProfile = reviewCodingWorkspaceSnapshot({
    repositoryRoot,
    files: ["package.json", "src/views/archive.ts"],
    manifests: [{
      path: "package.json",
      content: JSON.stringify({ dependencies: { react: "1.0.0" } }),
    }],
  });
  const { nodes: _previousNodes, ...previousReview } = previousProfile;
  await trackedRuntime.execute(workspace.profileStream, {
    type: "emit",
    eventId: "coding-workspace-configured:previous",
    event: orchestrationConfiguredEvent(workspace.id, codingWorkspacePack(previousProfile)),
  });
  await trackedRuntime.execute(workspace.profileStream, {
    type: "emit",
    eventId: "coding-workspace-profile:previous",
    event: inlineArtifactPublishedEvent({
      runId: workspace.id,
      artifactId: "workspace-profile-previous",
      origin: "input",
      outputKey: CODING_WORKSPACE_PROFILE_OUTPUT,
      nodeId: "coordinator",
      kind: "coding.workspace-profile",
      inputVersions: {},
    }, JSON.stringify(previousReview)),
  });
  assert.ok(previousProfile.nodes.some((node) => node.id === "workspace.ui"));
  assert.ok(!previousProfile.nodes.some((node) => node.id === "workspace.api"));
  const runId = "coding_tracked_rescan";
  const job: QueueJob = {
    id: "coding-rescan-test",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.workspace-rescan",
      runId,
      conversationId: runId,
      objective: "Rescan team and track the objective",
      codingWorkspaceId: workspace.id,
      workspaceProfileStream: workspace.profileStream,
      workingDirectory: workspace.repositoryRoot,
      workspace: JSON.stringify(workspace),
    },
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 1,
    commands: [],
  };
  let leaseChecks = 0;
  let specialistReviewCount = 0;
  let toolchainEvidencePaths: ReadonlyArray<string> = [];
  const executionPlanes = rescanExecutionPlanes(runId);
  Object.defineProperty(executionPlanes.taskGraph, "durability", { value: "durable" });
  Object.defineProperty(executionPlanes.dataReferences, "durability", { value: "durable" });
  Object.assign(executionPlanes.createTaskContext, { durability: "durable" as const });
  const result = await executeCodingWorkspaceRescanJob({
    runtime: trackedRuntime,
    job,
    ...executionPlanes,
    assertLease: async () => { leaseChecks += 1; },
    toolchainOnboarder: async ({ evidence }) => {
      toolchainEvidencePaths = evidence.map((entry) => entry.path);
      return {
        summary: "Use the repository-owned test script.",
        evidenceFiles: ["package.json"],
        installCommands: [],
        verifyCommands: [{ command: "npm", args: ["test"] }],
      };
    },
    reviewer: async ({ node }) => {
      specialistReviewCount += 1;
      if (specialistReviewCount === 1) throw new Error("bounded specialist review unavailable");
      return {
        summary: `Reviewed ${node.name}`,
        operatingInstructions: "Use bounded repository evidence.",
        skills: [],
        toolRequirements: [],
        dependencies: [],
      };
    },
  });
  const graph = await executionPlanes.taskGraph.snapshot();
  assert.equal(graph.expansions.length, 1);
  assert.equal(graph.tasks.find((task) =>
    task.definition.taskId === "workspace-rescan-coordinate")?.status, "skipped");
  assert.equal(graph.tasks.find((task) =>
    task.definition.taskId === "workspace-rescan-execute")?.status, "accepted");
  assert.equal(graph.tasks.find((task) =>
    task.definition.taskId === "workspace-rescan-finalize")?.status, "accepted");
  assert.equal(result.runKind, "workspace-rescan");
  assert.equal(result.workspaceId, workspace.id);
  assert.equal((result.toolchainOnboarding as { readonly status?: string }).status, "complete");
  assert.ok(toolchainEvidencePaths.includes("package-lock.json"));
  assert.ok(leaseChecks >= 2);
  assert.ok(Array.isArray(result.specialistOutcomes));
  assert.ok((result.specialistOutcomes as ReadonlyArray<{ readonly state: string }>).some((outcome) => outcome.state === "partial"));
  assert.match(String(result.outputProfileStream), /\/revisions\/[a-f0-9]{32}$/);
  const catalog = await trackedRuntime.state(CODING_WORKSPACE_CATALOG_STREAM);
  const selected = parseCodingRepositoryWorkspace(
    orchestrationOutputValues(catalog)[`workspace:${workspace.id}`],
  );
  assert.equal(selected?.profileStream, result.outputProfileStream);
  assert.ok(selected);
  const completedJob: QueueJob = { ...job, status: "completed", result };
  const projectionApp = new Hono();
  createCodingRoute({
    runtime: trackedRuntime,
    queue: {
      enqueue: async () => completedJob,
      leaseNext: async () => undefined,
      heartbeat: async () => undefined,
      complete: async () => undefined,
      fail: async () => undefined,
      cancel: async () => undefined,
      queueCommand: async () => undefined,
      consumeCommands: async () => [],
      getJob: async (jobId) => jobId === completedJob.id ? completedJob : undefined,
      listJobs: async () => [completedJob],
      waitForJob: async () => undefined,
    },
  }).register(projectionApp);
  const projectionResponse = await projectionApp.request(
    `/api/v2/coding/runs/${runId}?job=${completedJob.id}`,
  );
  assert.equal(projectionResponse.status, 200);
  const projection = await projectionResponse.json() as {
    readonly run: { readonly branch?: string };
    readonly job: { readonly reviewPolicy?: string; readonly workerRuntime?: string };
    readonly result: { readonly runKind: string; readonly outputProfileStream: string };
    readonly frontier?: unknown;
  };
  assert.equal(projection.run.branch, undefined);
  assert.equal(projection.job.reviewPolicy, undefined);
  assert.equal(projection.job.workerRuntime, undefined);
  assert.equal(projection.frontier, undefined);
  assert.equal(projection.result.runKind, "workspace-rescan");
  assert.equal(projection.result.outputProfileStream, result.outputProfileStream);
  assert.equal((await trackedRuntime.chain(`agents/coding-agent/runs/${runId}`)).length, 0,
    "TaskGraphControl owns rescan lifecycle; no synthetic plan/task receipts are emitted");
  const failedRunId = "coding_failed_rescan";
  const failedPlanes = rescanExecutionPlanes(failedRunId);
  await assert.rejects(executeCodingWorkspaceRescanJob({
    runtime: trackedRuntime,
    ...failedPlanes,
    job: {
      ...job,
      id: "coding-rescan-failed-test",
      payload: {
        ...job.payload,
        runId: failedRunId,
        conversationId: failedRunId,
        workspaceProfileStream: selected.profileStream,
        workspace: JSON.stringify(selected),
      },
    },
    reviewer: async ({ node }) => ({
      summary: `Reviewed ${node.name}`,
      operatingInstructions: "Use bounded repository evidence.",
      skills: [],
      toolRequirements: [],
      dependencies: [],
    }),
    assertLease: async () => { throw new Error("lease lost before profile publication"); },
  }), /lease lost before profile publication/);
  const catalogAfterFailure = await trackedRuntime.state(CODING_WORKSPACE_CATALOG_STREAM);
  assert.equal(parseCodingRepositoryWorkspace(
    orchestrationOutputValues(catalogAfterFailure)[`workspace:${workspace.id}`],
  )?.profileStream, selected.profileStream);
  assert.ok((await failedPlanes.taskGraph.snapshot()).tasks.some((task) => task.status === "failed"));
  const abortController = new AbortController();
  const abortedRunId = "coding_aborted_rescan";
  await assert.rejects(executeCodingWorkspaceRescanJob({
    runtime: trackedRuntime,
    ...rescanExecutionPlanes(abortedRunId),
    job: {
      ...job,
      id: "coding-rescan-aborted-test",
      payload: {
        ...job.payload,
        runId: abortedRunId,
        conversationId: abortedRunId,
        workspaceProfileStream: selected.profileStream,
        workspace: JSON.stringify(selected),
      },
    },
    signal: abortController.signal,
    reviewer: async ({ node }) => ({
      summary: `Reviewed ${node.name}`,
      operatingInstructions: "Use bounded repository evidence.",
      skills: [],
      toolRequirements: [],
      dependencies: [],
    }),
    assertLease: async () => { abortController.abort(new Error("abort requested")); },
  }), /abort requested/);
  const catalogAfterAbort = await trackedRuntime.state(CODING_WORKSPACE_CATALOG_STREAM);
  assert.equal(parseCodingRepositoryWorkspace(
    orchestrationOutputValues(catalogAfterAbort)[`workspace:${workspace.id}`],
  )?.profileStream, selected.profileStream);
});

test("coding run progress keeps a receipt-quiet active heartbeat working and transitions durably", () => {
  const now = Date.UTC(2026, 6, 17, 12, 0);
  const message = createCodingConversationMessage({
    conversationId: "coding-progress",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Implement the bounded change",
    createdAt: now - 180_000,
  });
  const route = createCodingConversationRoute({
    conversationId: "coding-progress",
    inReplyTo: message.messageId,
    disposition: "ready",
    selectedNodeIds: ["specialist.alpha", "specialist.beta"],
    primaryNodeId: "specialist.alpha",
    coordination: { reviewMode: "reviewed", validationScope: "focused" },
    rationale: "The objective is actionable.",
    confidence: 1,
    createdAt: now - 179_000,
  });
  const events: ReadonlyArray<OrchestrationEvent> = [
    codingConversationMessageEvent(message),
    codingConversationRouteEvent(route),
    {
      type: "task.graph.projected",
      runId: "coding-progress",
      graph: {
        ...projectedTaskGraph("coding-progress", [
          { taskId: "implement", nodeId: "specialist.alpha", capability: "implement", status: "running" },
          { taskId: "review", nodeId: "specialist.beta", capability: "review", status: "running", attempt: 2 },
        ]),
        projectionVersion: "projection-coding-progress",
      },
    },
  ];
  const state: OrchestrationState = {
    ...initialOrchestrationState,
    nodes: {
      "specialist.alpha": {
        id: "specialist.alpha",
        name: "Ada, Implementation Specialist",
        capabilities: ["implement"],
        status: "active",
        updatedAt: now - 160_000,
      },
      "specialist.beta": {
        id: "specialist.beta",
        name: "Ben, Validation Specialist",
        capabilities: ["review"],
        status: "active",
        updatedAt: now - 160_000,
      },
    },
    taskGraph: projectedTaskGraph("coding-progress", [
      { taskId: "implement", nodeId: "specialist.alpha", capability: "implement", status: "running" },
      { taskId: "review", nodeId: "specialist.beta", capability: "review", status: "running", attempt: 2 },
    ]),
  };
  const working = codingRunProgress({
    state,
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: {
      id: "job-progress",
      status: "running",
      attempt: 2,
      maxAttempts: 3,
      updatedAt: now - 5_000,
      leaseUntil: now + 30_000,
    },
    now,
  });
  assert.equal(working?.state, "working");
  assert.equal(working?.message, "Ada is implementing the change.");
  assert.match(working?.headline ?? "", /0 of 2 steps complete · Ada and Ben/);
  assert.match(working?.activity ?? "", /about 2 minutes; the worker lease heartbeat remains active/);

  const overdue = codingRunProgress({
    state,
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: { id: "job-progress", status: "running", leaseUntil: now - 1, updatedAt: now - 40_000 },
    now,
  });
  assert.equal(overdue?.state, "working");
  assert.match(overdue?.activity ?? "", /Lease renewal is overdue; bounded recovery is pending/);

  const retrying = codingRunProgress({
    state,
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: { id: "job-progress", status: "queued", attempt: 2, maxAttempts: 3, updatedAt: now - 2_000 },
    now,
  });
  assert.equal(retrying?.state, "waiting");
  assert.equal(retrying?.label, "Queued");
  assert.equal(retrying?.message, "Roster queued the next bounded attempt.");
  assert.match(retrying?.activity ?? "", /Bounded recovery is queued at attempt 2 of 3/);

  const completed = codingRunProgress({
    state: withGraphStatus(state, "accepted"),
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: { id: "job-progress", status: "running", leaseUntil: now + 30_000, updatedAt: now - 5_000 },
    now,
  });
  assert.equal(completed?.state, "working");
  assert.equal(completed?.label, "Finalizing delivery");
  assert.equal(completed?.message, "The work is certified. Roster is preparing the merge handoff.");
  assert.match(completed?.headline ?? "", /steps complete · finalizing delivery/);

  const expiredCertifiedDelivery = codingRunProgress({
    state: withGraphStatus(state, "accepted"),
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: { id: "job-progress", status: "running", leaseUntil: now - 1, updatedAt: now - 40_000 },
    now,
  });
  assert.equal(expiredCertifiedDelivery?.state, "failed");
  assert.equal(expiredCertifiedDelivery?.label, "Needs attention");
  assert.match(expiredCertifiedDelivery?.headline ?? "", /steps complete · merge blocked/);
  assert.match(expiredCertifiedDelivery?.activity ?? "", /worker lease expired after certification/i);
  assert.doesNotMatch(expiredCertifiedDelivery?.message ?? "", /preparing the merge handoff/i);

  const consultedState: OrchestrationState = {
    ...state,
    taskGraph: projectedTaskGraph("coding-progress", [
      {
        taskId: "proposal",
        nodeId: "specialist.alpha",
        capability: "propose",
        status: "skipped",
        continuationTaskId: "continue-proposal",
      },
      {
        taskId: "consult-security",
        nodeId: "specialist.beta",
        capability: "respond",
        status: "accepted",
      },
      {
        taskId: "continue-proposal",
        nodeId: "specialist.alpha",
        capability: "propose",
        status: "accepted",
        dependencies: [{ taskId: "consult-security", condition: "accepted" }],
      },
    ]),
  };
  const consulted = codingRunProgress({
    state: consultedState,
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: { id: "job-progress", status: "running", leaseUntil: now + 30_000, updatedAt: now - 5_000 },
    now,
  });
  assert.equal(consulted?.label, "Finalizing delivery");
  assert.match(consulted?.headline ?? "", /3 of 3 steps complete/);
  const consultedHtml = codingRunPanelHtml({
    state: consultedState,
    events,
    runId: "coding-progress",
    job: { id: "job-progress", status: "running", leaseUntil: now + 30_000, updatedAt: now - 500 },
  });
  assert.match(consultedHtml, /data-coding-task-outcome><b>Outcome<\/b>Completed through Continue Proposal; its accepted outcome is preserved\./);

  const peerAnswer = codingRunProgress({
    state: {
      ...state,
      taskGraph: projectedTaskGraph("coding-progress", [
        { taskId: "consult-security", nodeId: "specialist.beta", capability: "respond", status: "running" },
      ]),
    },
    events: [
      ...events.slice(0, 2),
      {
        type: "task.graph.projected",
        runId: "coding-progress",
        graph: projectedTaskGraph("coding-progress", [
          { taskId: "consult-security", nodeId: "specialist.beta", capability: "respond", status: "running" },
        ]),
      },
    ],
    eventTimestamps: [now - 180_000, now - 179_000, now - 1_000],
    job: { id: "job-progress", status: "running", leaseUntil: now + 30_000, updatedAt: now - 500 },
    now,
  });
  assert.equal(peerAnswer?.message, "Ben is answering a peer question.");

  for (const terminalJob of [
    { id: "job-progress", status: "failed" as const, error: "commit creation failed" },
    { id: "job-progress", status: "canceled" as const, error: "operator canceled handoff" },
    {
      id: "job-progress",
      status: "failed" as const,
      error: "worker failed after publishing stale delivery metadata",
      noChanges: true,
      commit: "a".repeat(40),
      integration: { integrated: true, canIntegrate: false },
    },
  ]) {
    const blocked = codingRunProgress({
      state: withGraphStatus(state, "accepted"),
      events,
      eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
      job: terminalJob,
      now,
    });
    assert.equal(blocked?.state, "failed");
    assert.equal(blocked?.label, "Needs attention");
    assert.match(blocked?.message ?? "", /the work is certified, but the merge is blocked/i);
    assert.match(blocked?.headline ?? "", /steps complete · merge blocked/);
    assert.match(blocked?.activity ?? "", /certification|certified|handoff|integration/i);
    assert.doesNotMatch(blocked?.activity ?? "", new RegExp(terminalJob.error));
    assert.doesNotMatch(blocked?.headline ?? "", /finalizing/);
  }

  const certifiedBlockedState: OrchestrationState = {
    ...state,
    taskGraph: projectedTaskGraph("coding-progress", [
      { taskId: "implement", nodeId: "specialist.alpha", capability: "implement", status: "accepted" },
      { taskId: "review", nodeId: "specialist.beta", capability: "review", status: "accepted" },
      {
        taskId: "coding-finalize",
        nodeId: "coordinator",
        capability: "coordinate",
        status: "failed",
        error: "Commit or stash current repository changes before applying this run.",
      },
    ]),
  };
  const certifiedBlockedHtml = codingRunPanelHtml({
    state: certifiedBlockedState,
    events,
    runId: "coding-progress",
    job: {
      id: "job-progress",
      status: "completed",
      commit: "a".repeat(40),
      baselineBranch: "main",
      integration: {
        integrated: false,
        canIntegrate: false,
        reason: "Commit or stash current repository changes before applying this run.",
      },
    },
  });
  assert.match(certifiedBlockedHtml, /Needs attention/i);
  assert.match(certifiedBlockedHtml, /certified handoff needs attention before integration can continue/i);
  assert.doesNotMatch(certifiedBlockedHtml, /Commit or stash current repository changes/);
  assert.match(certifiedBlockedHtml, /Close &amp; keep branch/);
  assert.match(certifiedBlockedHtml, /\/coding\/runs\/coding-progress\/close/);
  assert.doesNotMatch(certifiedBlockedHtml, />Retry Run<|start a fresh bounded attempt/);

  const canceledManagement = codingRunProgress({
    state: withGraphStatus(state, "accepted"),
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: {
      id: "job-management",
      runKind: "workspace-rescan",
      status: "canceled",
      error: "operator canceled rescan",
    },
    now,
  });
  assert.equal(canceledManagement?.state, "failed");
  assert.match(canceledManagement?.activity ?? "", /bounded run was canceled before certification/i);
  assert.doesNotMatch(canceledManagement?.activity ?? "", /operator canceled rescan/);

  const unavailable = codingRunProgress({
    state: withGraphStatus(state, "accepted"),
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: { id: "job-progress", status: "completed" },
    now,
  });
  assert.equal(unavailable?.state, "failed");
  assert.equal(unavailable?.label, "Needs attention");
  assert.match(unavailable?.headline ?? "", /steps complete · merge unavailable/);
  assert.match(unavailable?.activity ?? "", /without the validated commit and baseline metadata/);

  const missingJob = codingRunProgress({
    state: withGraphStatus(state, "accepted"),
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    now,
  });
  assert.equal(codingRunDeliveryState(withGraphStatus(state, "accepted")), "unavailable");
  assert.equal(missingJob?.state, "failed");
  assert.equal(missingJob?.label, "Needs attention");
  assert.match(missingJob?.activity ?? "", /durable job and delivery record are unavailable/);
  assert.doesNotMatch(missingJob?.headline ?? "", /finalizing delivery/);

  const failed = codingRunProgress({
    state,
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: { id: "job-progress", status: "failed", attempt: 3, maxAttempts: 3, error: "worker stopped" },
    now,
  });
  assert.equal(failed?.state, "failed");
  assert.match(failed?.headline ?? "", /3 of 3 attempts/);
  assert.match(failed?.activity ?? "", /No human answer is requested/);

  const html = codingRunPanelHtml({
    state,
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    job: { id: "job-progress", status: "running", leaseUntil: Date.now() + 30_000, updatedAt: Date.now() - 5_000 },
  });
  assert.doesNotMatch(html, /data-coding-run-progress|data-coding-team-snapshot/);
  assert.match(html, /data-coding-room-transcript/);
  const transcriptHtml = html.match(/<ol class="coding-thread coding-timeline"[\s\S]*?<\/ol>/)?.[0] ?? "";
  assert.doesNotMatch(transcriptHtml, /Ada is implementing the change\./);
  assert.match(html, /data-run-presentation-progress>0 of 2 contributions accepted/);
  assert.doesNotMatch(html, /data-coding-team-snapshot/);
  assert.match(html, /class="coding-work-status"/);
  assert.match(html, /data-coding-run-panel[^>]+aria-busy="false"/);

  const interactiveHtml = codingRunPanelHtml({
    state: withGraphStatus(state, "accepted"),
    events,
    eventTimestamps: [now - 180_000, now - 179_000, now - 125_000],
    runId: "coding-progress",
    job: {
      id: "job-progress",
      status: "completed",
      commit: "a".repeat(40),
      baselineBranch: "main",
      baselineCommit: "b".repeat(40),
      integration: { integrated: false, canIntegrate: true },
    },
  });
  assert.match(interactiveHtml, /data-focus-key="git-review"/);
  assert.match(interactiveHtml, /data-focus-key="git-integrate"/);
  assert.match(interactiveHtml, /Merge certified code into main/);
  assert.doesNotMatch(interactiveHtml, /data-coding-run-progress/);
  assert.match(interactiveHtml, /class="coding-run-merge-action"[^>]+action="\/coding\/runs\/coding-progress\/integrate"/);
  assert.match(interactiveHtml, />Merge into main<\/button>/);
  assert.match(interactiveHtml, /data-details-key="git-delivery-rules"><summary data-focus-key="git-delivery-rules"/);
  assert.match(interactiveHtml, /data-details-key="run-receipts"><summary data-focus-key="run-receipts"/);
});

test("coding run progress requires durable message and route acceptance", () => {
  const planOnly: OrchestrationState = {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph("coding-without-route", []),
  };
  assert.equal(codingRunProgress({ state: planOnly, events: [] }), undefined);
  assert.equal(codingRunProgress({
    state: initialOrchestrationState,
    events: [],
    job: { id: "job-without-route", status: "running", leaseUntil: Date.now() + 30_000 },
  }), undefined);
  const html = codingRunPanelHtml({
    state: planOnly,
    events: [],
    job: { id: "job-without-route", status: "running", leaseUntil: Date.now() + 30_000 },
  });
  assert.doesNotMatch(html, /data-coding-run-progress/);
  assert.doesNotMatch(html, /Roster accepted the bounded run/);
});

test("branch rooms stay open through certified delivery and archive only after closure", () => {
  const base = {
    conversationId: "coding-delivery-room",
    nodes: [],
  } as const;
  const ready = codingRoomProjection({
    ...base,
    job: {
      id: "job-delivery-room",
      status: "completed",
      branch: "roster/coding-delivery-room",
      commit: "a".repeat(40),
      integration: { integrated: false, canIntegrate: true },
    },
  });
  assert.equal(ready.state, "open");
  assert.equal(ready.stateLabel, "Ready to merge");

  const blocked = codingRoomProjection({
    ...base,
    job: {
      id: "job-delivery-room",
      status: "completed",
      branch: "roster/coding-delivery-room",
      commit: "a".repeat(40),
      integration: { integrated: false, canIntegrate: false, reason: "main moved" },
    },
  });
  assert.equal(blocked.state, "waiting");
  assert.equal(blocked.stateLabel, "Needs attention");

  const integrated = codingRoomProjection({
    ...base,
    job: {
      id: "job-delivery-room",
      status: "completed",
      branch: "roster/coding-delivery-room",
      commit: "a".repeat(40),
      integration: { integrated: true, canIntegrate: false },
    },
  });
  assert.equal(integrated.state, "open");
  assert.equal(integrated.stateLabel, "Open room");

  const noChanges = codingRoomProjection({
    ...base,
    job: {
      id: "job-delivery-room",
      status: "completed",
      branch: "roster/coding-delivery-room",
      noChanges: true,
    },
  });
  assert.equal(noChanges.state, "open");

  for (const status of ["failed", "canceled"] as const) {
    const staleSuccess = codingRoomProjection({
      ...base,
      job: {
        id: `job-delivery-${status}`,
        status,
        branch: "roster/coding-delivery-room",
        commit: "a".repeat(40),
        integration: { integrated: true, canIntegrate: false },
      },
    });
    assert.equal(staleSuccess.state, "waiting");
    assert.equal(staleSuccess.stateLabel, "Needs attention");
  }

  const contradictorySuccess = codingRoomProjection({
    ...base,
    job: {
      id: "job-delivery-conflict",
      status: "completed",
      branch: "roster/coding-delivery-room",
      commit: "a".repeat(40),
      noChanges: true,
      integration: { integrated: false, canIntegrate: true },
    },
  });
  assert.equal(contradictorySuccess.state, "waiting");
  assert.equal(contradictorySuccess.stateLabel, "Needs attention");
});

test("coding conversation renders queued, consumed, and continuation delivery markers", () => {
  const message = createCodingConversationMessage({
    conversationId: "coding-delivery-ui",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui", externalId: "submission-1" },
    text: "Also preserve replay compatibility.",
    tags: ["delivery:queued"],
  });
  const route = createCodingConversationRoute({
    conversationId: message.conversationId,
    inReplyTo: message.messageId,
    disposition: "ready",
    selectedNodeIds: ["workspace.implementation"],
    primaryNodeId: "workspace.implementation",
    coordination: { reviewMode: "fast", validationScope: "focused" },
    rationale: "The follow-up is actionable.",
    confidence: 1,
  });
  const turn = createCodingAgentTurn({
    kind: "clarification",
    authorNodeId: "human.operator",
    recipients: ["workspace.implementation"],
    subjectId: `human-${message.messageId}`,
    originatingTaskId: "implement",
    responseRequirement: "none",
    body: message.text,
  });
  const authorization = createCodingControlIngressAuthorization({
    workspaceId: "workspace-1",
    conversationId: message.conversationId,
    runId: message.conversationId,
    messageId: message.messageId,
    turnId: turn.turnId,
    jobId: "job-1",
    jobAttempt: 1,
    topologyVersion: "topology-1",
    authorNodeId: "human.operator",
    recipientTaskId: "implement",
    recipientNodeId: "workspace.implementation",
  });
  const state: OrchestrationState = {
    ...initialOrchestrationState,
    nodes: {
      "workspace.implementation": {
        id: "workspace.implementation",
        name: "Kai, Implementation Engineer",
        capabilities: ["implement"],
        status: "active",
        updatedAt: Date.now(),
      },
    },
  };
  const baseEvents = [codingConversationMessageEvent(message), codingConversationRouteEvent(route)];
  const activeJob = { id: "job-1", status: "running" as const, attempt: 1 };
  const queuedHtml = codingRunPanelHtml({ state, events: baseEvents, job: activeJob });
  assert.match(queuedHtml, /data-delivery-state="queued"/);
  assert.match(queuedHtml, /Message queued for the next safe handoff/);

  const consumedHtml = codingRunPanelHtml({
    state,
    events: [...baseEvents, codingControlDeliveryEvent(message.conversationId, "human.operator", {
      schema: "coding-control-delivery/v1", authorization, state: "consumed", turn,
    })],
    job: activeJob,
  });
  assert.match(consumedHtml, /data-delivery-state="consumed"/);
  assert.match(consumedHtml, /Read by Kai, Implementation Engineer/);

  const supersededHtml = codingRunPanelHtml({
    state,
    events: [...baseEvents, codingControlDeliveryEvent(message.conversationId, "human.operator", {
      schema: "coding-control-delivery/v1", authorization, state: "superseded", reason: "boundary exhausted",
    })],
    job: { id: "job-1", status: "failed" },
  });
  assert.match(supersededHtml, /data-delivery-state="superseded"/);
  assert.match(supersededHtml, /Run ended before this message was delivered/);
});

test("failed Coding runs expose retry without inventing coordinator dialogue", () => {
  const message = createCodingConversationMessage({
    conversationId: "coding-retry-action",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Make the recovery action obvious.",
  });
  const route = createCodingConversationRoute({
    conversationId: message.conversationId,
    inReplyTo: message.messageId,
    disposition: "ready",
    selectedNodeIds: ["workspace.implementation"],
    primaryNodeId: "workspace.implementation",
    coordination: { reviewMode: "fast", validationScope: "focused" },
    rationale: "The change is bounded.",
    confidence: 1,
  });
  const state: OrchestrationState = {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph("coding-retry-action", [{
      taskId: "finalize",
      nodeId: "coordinator",
      capability: "certify",
      status: "failed",
    }]),
  };
  const html = codingRunPanelHtml({
    state,
    events: [codingConversationMessageEvent(message), codingConversationRouteEvent(route)],
    runId: message.conversationId,
    job: {
      id: "job-budget-exhausted",
      status: "failed",
      error: "execution budget exhausted",
      attempt: 1,
      maxAttempts: 4,
    },
  });
  assert.match(html, /data-coding-social-row[^>]*data-author-node-id="human\.operator"/);
  assert.doesNotMatch(html, /data-coding-social-row[^>]*data-author-node-id="coordinator"/);
  assert.doesNotMatch(html, /data-coding-run-progress|data-conversation-kind="activity-event"/);
  assert.match(html, /id="coding-run-status"/);
  assert.match(html, /action="\/coding\/runs\/coding-retry-action\/retry"/);
  assert.match(html, /name="jobId" value="job-budget-exhausted"/);
  assert.match(html, />Retry Run<\/button>/);
  assert.doesNotMatch(html, /Roster’s Finalize step failed/i);
  assert.match(html, /execution budget/i);
});

test("a certified run with an old budget-finalizer cancellation still requires its merge", () => {
  const runId = "coding-committed-usage-note";
  const state: OrchestrationState = {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph(runId, [
      {
        taskId: "implement",
        nodeId: "workspace.implementation",
        capability: "implement",
        status: "accepted",
      },
      {
        taskId: "coding-finalize",
        nodeId: "coordinator",
        capability: "coordinate",
        status: "canceled",
        error: "execution budget exhausted",
      },
    ]),
  };
  const html = codingRunPanelHtml({
    state,
    events: [],
    runId,
    job: {
      id: "job-committed-usage-note",
      status: "completed",
      commit: "972b3357bd60c9fc463624653831faf00ef798c7",
      branch: "roster/coding-committed-usage-note",
      baselineBranch: "main",
      integration: { integrated: false, canIntegrate: true },
    },
  });

  assert.match(html, /Ready to merge/);
  assert.match(html, /Merge certified code into main/);
  assert.match(html, /Close &amp; keep branch/);
  assert.match(html, /Nothing is merged or deleted/);
  assert.match(html, /\/coding\/runs\/coding-committed-usage-note\/close/);
  assert.doesNotMatch(html, /data-coding-live-attention|>Retry Run<|Failed<\/span>/);

  const shell = codingShell({
    state,
    events: [],
    runId,
    job: {
      id: "job-committed-usage-note",
      status: "completed",
      commit: "972b3357bd60c9fc463624653831faf00ef798c7",
      branch: "roster/coding-committed-usage-note",
      baselineBranch: "main",
      integration: { integrated: false, canIntegrate: true },
    },
    nonce: "committed-usage-note",
    repositoryPath: "/tmp/roster-committed-usage-note",
    gitRemote: "",
    gitAccount: "",
    workspaceId: "workspace-committed-usage-note",
    workspaceProfile: reviewCodingWorkspaceSnapshot({
      repositoryRoot: "/tmp/roster-committed-usage-note",
      files: ["package.json"],
      manifests: [{ path: "package.json", content: "{}" }],
      reviewedAt: 1,
    }),
    realtime: {
      enabled: true,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
      workspaceId: "workspace-committed-usage-note",
      activeRunId: runId,
    },
  });
  assert.match(shell, /"committedUsageNote":true/);
  assert.match(shell, /"conversationId":"coding-committed-usage-note"/);
  assert.match(shell, /"job":\{"id":"job-committed-usage-note","status":"completed"\}/);
  assert.match(shell, /"delivery":\{"status":"ready","certified":true,"branch":"roster\/coding-committed-usage-note","targetBranch":"main"/);
});

test("coding conversation keeps routing metadata out of chat while preserving addressing and direct-reply identity", () => {
  const input = createCodingConversationMessage({
    conversationId: "coding-visible-addressing",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "@mira say hello",
    createdAt: 10,
  });
  const route = createCodingConversationRoute({
    conversationId: input.conversationId,
    inReplyTo: input.messageId,
    disposition: "informational",
    selectedNodeIds: ["workspace.quality"],
    tags: ["domain:quality"],
    answer: "Hello!",
    rationale: "Mira was directly addressed.",
    confidence: 1,
    createdAt: 11,
  });
  const reply = createCodingConversationMessage({
    conversationId: input.conversationId,
    author: { kind: "agent", id: "workspace.quality", name: "Mira, Quality Reviewer" },
    source: { kind: "agent" },
    text: "Hello!",
    tags: ["intent:informational", "routing:direct-mention"],
    replyTo: input.messageId,
    createdAt: 12,
  });
  const mira = {
    id: "workspace.quality",
    name: "Mira, Quality Reviewer",
    capabilities: ["review"],
    status: "active" as const,
    updatedAt: 10,
    metadata: { givenName: "Mira", displayRole: "Quality Reviewer" },
  };
  const html = codingRunPanelHtml({
    state: {
      ...initialOrchestrationState,
      nodes: { [mira.id]: mira },
    },
    events: [
      codingConversationMessageEvent(input),
      codingConversationRouteEvent(route),
      codingConversationMessageEvent(reply),
    ],
    chatModel: "gpt-5.6-luna",
  });

  assert.match(html, /data-author-node-id="human\.operator"[\s\S]*class="coding-message-recipients"[^>]*>[\s\S]*@Mira/);
  assert.match(html, /data-author-node-id="workspace\.quality"[\s\S]*class="coding-message-recipients"[^>]*>[\s\S]*@You/);
  assert.doesNotMatch(html, /#source:ui|#author:user|#routing:mention/);
  assert.match(html, /<dt>Source<\/dt><dd>message<\/dd>/);
  assert.match(html, /<dt>Durability<\/dt><dd>durable<\/dd>/);
  assert.doesNotMatch(html, /Agent binding pending|Model pending/);
  assert.doesNotMatch(html, />Roster<\/strong>.*Hello!/s);
});

test("coding conversation labels the routed model without conflating local placement", () => {
  const message = createCodingConversationMessage({
    conversationId: "coding-routing-model",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Which model handled this?",
    createdAt: 10,
  });
  const route = createCodingConversationRoute({
    conversationId: message.conversationId,
    inReplyTo: message.messageId,
    disposition: "informational",
    selectedNodeIds: [],
    tags: ["intent:question"],
    questions: [],
    answer: "The selected conversation model handled this turn.",
    rationale: "Answered from routing metadata.",
    confidence: 1,
    createdAt: 11,
  });
  const html = codingRunPanelHtml({
    state: initialOrchestrationState,
    events: [
      codingConversationMessageEvent(message),
      codingConversationRouteEvent(route),
    ],
    chatModel: "openai-codex/gpt-5.6-luna",
  });

  assert.match(html, /data-author-node-id="coordinator"[\s\S]*The selected conversation model handled this turn\./);
  assert.match(html, /<dt>Source<\/dt><dd>message<\/dd>/);
  assert.doesNotMatch(html, /Model: Pi · local|Routing: Pi · local/);
});

test("coding conversation renders an attached image once without exposing its artifact payload", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const image = createCodingConversationImage({
    conversationId: "coding-image-chat",
    name: "layout.png",
    mediaType: "image/png",
    dataUrl,
    width: 1,
    height: 1,
    createdAt: 9,
  });
  const message = createCodingConversationMessage({
    conversationId: image.conversationId,
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Fix the layout shown here.",
    attachments: [image],
    createdAt: 10,
  });
  const html = codingRunPanelHtml({
    state: initialOrchestrationState,
    events: [
      codingConversationImageEvent(image),
      codingConversationMessageEvent(message),
    ],
    runId: image.conversationId,
  });

  assert.equal(html.split(dataUrl).length - 1, 1, "image bytes appear only in the image source");
  assert.match(html, /alt="Attached image: layout\.png"/);
  assert.match(html, /Fix the layout shown here\./);
  assert.doesNotMatch(html, /Conversation Image|protocol:artifact|turn:artifact|roster\.coding-conversation\.v1/);
});

test("coding run progress waits only on a durable clarification route", () => {
  const now = Date.UTC(2026, 6, 17, 12, 0);
  const message = createCodingConversationMessage({
    conversationId: "coding-clarification",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Change the public contract",
    createdAt: now - 2_000,
  });
  const route = createCodingConversationRoute({
    conversationId: message.conversationId,
    inReplyTo: message.messageId,
    disposition: "needs_clarification",
    selectedNodeIds: ["human.operator"],
    questions: ["Which compatibility contract should remain?"],
    rationale: "Compatibility changes the implementation.",
    confidence: 1,
    createdAt: now - 1_000,
  });
  const progress = codingRunProgress({
    state: initialOrchestrationState,
    events: [codingConversationMessageEvent(message), codingConversationRouteEvent(route)],
    eventTimestamps: [now - 2_000, now - 1_000],
    now,
  });
  assert.equal(progress?.state, "waiting");
  assert.equal(progress?.label, "Waiting for you");
  assert.match(progress?.activity ?? "", /Which compatibility contract should remain/);
});

test("coding streams process-local runtime logs only for the exact workspace job execution", async () => {
  const workspace = codingRepositoryWorkspace(process.cwd());
  const conversationId = "coding-log-conversation";
  const executionRunId = "coding-log-execution";
  const job: QueueJob = {
    id: "job-log-stream",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.run",
      conversationId,
      runId: executionRunId,
      codingWorkspaceId: workspace.id,
      workingDirectory: workspace.repositoryRoot,
      reviewPolicy: "fast",
      coordination: { reviewMode: "fast", validationScope: "focused" },
      workerExecution: testWorkerExecution(),
    },
    status: "running",
    attempt: 1,
    maxAttempts: 4,
    createdAt: 1,
    updatedAt: 2,
    commands: [],
  };
  const queue = {
    enqueue: async () => job,
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (id: string) => id === job.id ? job : undefined,
    listJobs: async () => [job],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const runtimeLogs = new NodeRuntimeLogStore();
  runtimeLogs.append({
    runId: executionRunId,
    nodeId: "workspace.implementation",
    taskId: "implement",
    runtime: "pi-agent",
    stream: "stdout",
    text: "Inspecting the live change frontier\n",
  });
  const app = new Hono();
  let pageSessionNow = 10_000;
  createCodingRoute({
    runtime,
    queue,
    runtimeLogs,
    realtime: {
      enabled: true,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
      workspaceId: "workspace-control-runtime-logs",
      capabilitySecret: "server-only-bootstrap-secret",
    },
    realtimeSession: async () => ({
      capabilitySecret: "rotated-runtime-log-viewer",
      capabilityId: "rotated-runtime-log-viewer-id",
      expiresAt: Date.now() + 3_600_000,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
    }),
    pageSessionNow: () => pageSessionNow,
  }).register(app);

  const unauthorized = await app.request(
    `/coding/runtime-logs?run=${executionRunId}&conversation=${conversationId}&job=${job.id}&workspace=${workspace.id}&after=0`,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");

  const page = await app.request(
    `/coding?workspace=${workspace.id}&run=${conversationId}&job=${job.id}`,
  );
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.doesNotMatch(
    pageHtml,
    /Inspecting the live change frontier/u,
    "Workbench-authorized runtime bodies must never enter initial public HTML",
  );
  const pageCookie = page.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.match(pageCookie, /^roster_coding_page=/u);

  const controller = new AbortController();
  const response = await app.request(
    `/coding/runtime-logs?run=${executionRunId}&conversation=${conversationId}&job=${job.id}&workspace=${workspace.id}&after=0`,
    { signal: controller.signal, headers: { cookie: pageCookie } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  const message = new TextDecoder().decode(first.value);
  assert.match(message, /"type":"log"/);
  assert.match(message, /"runId":"coding-log-execution"/);
  assert.match(message, /Inspecting the live change frontier/);

  const rotated = await app.request("/coding/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: pageCookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      workspaceId: workspace.id,
      conversationId,
      jobId: job.id,
      executionId: executionRunId,
    }),
  });
  assert.equal(rotated.status, 200);
  const rotatedPageCookie = rotated.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.notEqual(rotatedPageCookie, pageCookie);
  runtimeLogs.append({
    runId: executionRunId,
    nodeId: "workspace.implementation",
    taskId: "implement",
    runtime: "pi-agent",
    stream: "stderr",
    text: "Running focused verification\n",
  });
  const next = await reader.read();
  assert.equal(next.done, true, "a rotated page token revokes every predecessor stream before its next event");
  controller.abort();
  await reader.cancel();

  const mismatched = await app.request(
    `/coding/runtime-logs?run=coding-other-execution&conversation=${conversationId}&job=${job.id}&workspace=${workspace.id}&after=0`,
    { headers: { cookie: pageCookie } },
  );
  assert.equal(mismatched.status, 401, "a revoked page token cannot probe another execution");

  pageSessionNow += 10 * 60_000 + 1;
  const expired = await app.request(
    `/coding/runtime-logs?run=${executionRunId}&conversation=${conversationId}&job=${job.id}&workspace=${workspace.id}&after=0`,
    { headers: { cookie: rotatedPageCookie } },
  );
  assert.equal(expired.status, 401, "an expired exact page authority cannot open a new stream");
});

test("coding streams only public process-local room updates for the active authorized run", async () => {
  const workspace = codingRepositoryWorkspace(process.cwd());
  const foreignWorkspace = codingRepositoryWorkspace("/tmp/foreign-coding-room");
  const conversationId = "coding-room-update-conversation";
  const executionRunId = "coding-room-update-execution";
  const foreignConversationId = "coding-foreign-room-conversation";
  const foreignExecutionRunId = "coding-foreign-room-execution";
  const job: QueueJob = {
    id: "job-room-update-stream",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.run",
      conversationId,
      runId: executionRunId,
      codingWorkspaceId: workspace.id,
      workingDirectory: workspace.repositoryRoot,
      reviewPolicy: "fast",
      coordination: { reviewMode: "fast", validationScope: "focused" },
      workerExecution: testWorkerExecution(),
    },
    status: "running",
    attempt: 1,
    maxAttempts: 4,
    createdAt: 1,
    updatedAt: 2,
    commands: [],
  };
  const foreignJob: QueueJob = {
    ...job,
    id: "job-foreign-room-update-stream",
    payload: {
      ...job.payload,
      conversationId: foreignConversationId,
      runId: foreignExecutionRunId,
      codingWorkspaceId: foreignWorkspace.id,
      workingDirectory: foreignWorkspace.repositoryRoot,
    },
    createdAt: 3,
    updatedAt: 4,
  };
  const inactiveJob: QueueJob = {
    ...job,
    id: "job-inactive-room-update-stream",
    payload: {
      ...job.payload,
      conversationId: "coding-inactive-room-conversation",
      runId: "coding-inactive-room-execution",
    },
    status: "completed",
    createdAt: 5,
    updatedAt: 6,
  };
  const jobs = new Map([job, foreignJob, inactiveJob].map((candidate) => [candidate.id, candidate]));
  const resolveJobWaits: Array<() => void> = [];
  let waitForJobCalls = 0;
  let markJobWaitStarted!: () => void;
  const jobWaitStarted = new Promise<void>((resolve) => { markJobWaitStarted = resolve; });
  let deferNextAuthorizationLookup = false;
  let markAuthorizationLookupStarted!: () => void;
  const authorizationLookupStarted = new Promise<void>((resolve) => { markAuthorizationLookupStarted = resolve; });
  let resolveStaleAuthorization!: () => void;
  const queue = {
    enqueue: async () => job,
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (id: string) => {
      const snapshot = jobs.get(id);
      if (!deferNextAuthorizationLookup) return snapshot;
      deferNextAuthorizationLookup = false;
      markAuthorizationLookupStarted();
      return new Promise<QueueJob | undefined>((resolve) => {
        resolveStaleAuthorization = () => resolve(snapshot);
      });
    },
    listJobs: async () => [...jobs.values()],
    waitForJob: async (id: string) => {
      waitForJobCalls += 1;
      if (waitForJobCalls === 1) return jobs.get(id);
      return new Promise<QueueJob | undefined>((resolve) => {
        markJobWaitStarted();
        resolveJobWaits.push(() => resolve(jobs.get(id)));
      });
    },
  } as AgentLoaderContext["queue"];
  const roomUpdates = new NodeRoomUpdateStore({
    now: () => "2026-08-26T20:00:00.000Z",
  });
  roomUpdates.post({
    runId: executionRunId,
    taskId: "implement",
    executionId: "node-execution-own",
    nodeId: "workspace.implementation",
  }, {
    updateKey: "working",
    text: "I’m validating the authorized room stream.",
    intent: "progress",
    recipientNodeIds: ["human.operator"],
  });
  roomUpdates.post({
    runId: foreignExecutionRunId,
    taskId: "review",
    executionId: "node-execution-foreign",
    nodeId: "workspace.quality",
  }, {
    updateKey: "reviewing",
    text: "This foreign workspace update must remain isolated.",
    intent: "progress",
    recipientNodeIds: ["human.operator"],
  });
  const publicList = roomUpdates.list.bind(roomUpdates);
  const publicSubscribe = roomUpdates.subscribe.bind(roomUpdates);
  let unsubscribeCount = 0;
  let markStreamUnsubscribed!: () => void;
  const streamUnsubscribed = new Promise<void>((resolve) => { markStreamUnsubscribed = resolve; });
  let snapshotRaceInjected = false;
  let injectRoomEvent: ((event: NodeRoomUpdateStoreEvent) => void) | undefined;
  Object.defineProperty(roomUpdates, "list", {
    value: (runId: string) => {
      if (runId === executionRunId && !snapshotRaceInjected) {
        snapshotRaceInjected = true;
        roomUpdates.post({
          runId: executionRunId,
          taskId: "implement",
          executionId: "node-execution-own",
          nodeId: "workspace.implementation",
        }, {
          updateKey: "snapshot-race",
          text: "This update landed while the authorized snapshot was captured.",
          intent: "progress",
          recipientNodeIds: ["human.operator"],
        });
      }
      return publicList(runId).map((update) => ({
        ...update,
        functionControlMetadata: { executionFence: "private-function-control" },
        runtimeEnvironment: { ROSTER_PRIVATE_VALUE: "private-runtime-environment" },
        inboxBody: "private-inbox-body",
        prompt: "private-model-prompt",
        toolInput: { authorization: "private-tool-input" },
        credentials: { token: "private-credential" },
      }));
    },
  });
  Object.defineProperty(roomUpdates, "subscribe", {
    value: (runId: string, listener: Parameters<NodeRoomUpdateStore["subscribe"]>[1]) => {
      const forward = (event: NodeRoomUpdateStoreEvent): void => listener({
        type: event.type,
        update: {
          ...event.update,
          prompt: "private-live-prompt",
          toolInput: { authorization: "private-live-tool-input" },
        },
      });
      if (runId === executionRunId) injectRoomEvent = forward;
      const unsubscribe = publicSubscribe(runId, forward);
      return () => {
        unsubscribeCount += 1;
        markStreamUnsubscribed();
        unsubscribe();
      };
    },
  });
  const app = new Hono();
  let viewerGrant = 0;
  createCodingRoute({
    runtime,
    queue,
    roomUpdates,
    realtime: {
      enabled: true,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
      workspaceId: "workspace-control-room-updates",
      capabilitySecret: "server-only-bootstrap-secret",
    },
    realtimeSession: async () => ({
      capabilitySecret: `room-update-viewer-${++viewerGrant}`,
      capabilityId: `room-update-viewer-id-${viewerGrant}`,
      expiresAt: Date.now() + 3_600_000,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
    }),
  }).register(app);

  const unauthorized = await app.request(
    `/coding/room-updates?run=${executionRunId}&conversation=${conversationId}&job=${job.id}&workspace=${workspace.id}`,
  );
  assert.equal(unauthorized.status, 401);
  const page = await app.request(
    `/coding?workspace=${workspace.id}&run=${conversationId}&job=${job.id}`,
  );
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.doesNotMatch(
    pageHtml,
    /validating the authorized room stream/u,
    "room-update bodies must arrive only after exact page authorization",
  );
  assert.doesNotMatch(pageHtml, /foreign workspace update/u);
  assert.doesNotMatch(pageHtml, /private-(?:function|runtime|inbox|model|tool|credential)/u);
  const pageCookie = page.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.match(pageCookie, /^roster_coding_page=/u);

  const controller = new AbortController();
  const response = await app.request(
    `/coding/room-updates?run=${executionRunId}&conversation=${conversationId}&job=${job.id}&workspace=${workspace.id}`,
    { signal: controller.signal, headers: { cookie: pageCookie } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  let reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  const snapshotText = new TextDecoder().decode(first.value);
  const snapshot = JSON.parse(snapshotText.trim()) as {
    readonly type: string;
    readonly updates: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(snapshot.type, "snapshot");
  assert.equal(waitForJobCalls, 1, "an eager durable queue response must not create a busy poll loop");
  assert.deepEqual(snapshot.updates.map((update) => update.runId), [executionRunId, executionRunId]);
  assert.match(snapshotText, /validating the authorized room stream/u);
  assert.match(snapshotText, /while the authorized snapshot was captured/u);
  assert.doesNotMatch(snapshotText, /foreign workspace update/u);
  for (const privateValue of [
    "functionControlMetadata",
    "private-function-control",
    "runtimeEnvironment",
    "private-runtime-environment",
    "inboxBody",
    "private-inbox-body",
    "prompt",
    "private-model-prompt",
    "toolInput",
    "private-tool-input",
    "credentials",
    "private-credential",
  ]) assert.doesNotMatch(snapshotText, new RegExp(privateValue, "u"));
  roomUpdates.post({
    runId: executionRunId,
    taskId: "implement",
    executionId: "node-execution-own",
    nodeId: "workspace.implementation",
  }, {
    updateKey: "working",
    text: "The authorized stream now has a live replacement.",
    intent: "progress",
    recipientNodeIds: ["human.operator"],
  });
  const live = await reader.read();
  assert.equal(live.done, false);
  const liveText = new TextDecoder().decode(live.value);
  assert.match(liveText, /"type":"update"/u);
  assert.match(liveText, /live replacement/u);
  assert.doesNotMatch(liveText, /private-live-(?:prompt|tool-input)/u);

  const eofTransition = (codingRoomStream as unknown as {
    readonly codingRoomStreamEofTransition?: (
      jobStatus: string | undefined,
      executionStatus?: string,
    ) => "paused" | "terminal";
  }).codingRoomStreamEofTransition;
  assert.equal(typeof eofTransition, "function");
  let currentPageCookie = pageCookie;
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const renewed = await app.request("/coding/realtime-session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: currentPageCookie,
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        conversationId,
        jobId: job.id,
        executionId: executionRunId,
      }),
    });
    assert.equal(renewed.status, 200);
    const rotatedCookie = renewed.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    assert.match(rotatedCookie, /^roster_coding_page=/u);
    assert.notEqual(rotatedCookie, currentPageCookie);
    const lateText = `Late authorized update after page rotation ${cycle}`;
    roomUpdates.post({
      runId: executionRunId,
      taskId: `rotation-${cycle}`,
      executionId: `rotation-execution-${cycle}`,
      nodeId: "workspace.implementation",
    }, {
      updateKey: "late-update",
      text: lateText,
      intent: "progress",
      recipientNodeIds: ["human.operator"],
    });
    const revokedEof = await reader.read();
    assert.equal(revokedEof.done, true, "a rotated page authority closes its predecessor stream cleanly");
    assert.equal(eofTransition!(job.status, "running"), "paused",
      "clean EOF for an exact active job must schedule a generation-fenced reconnect");

    const reconnected = await app.request(
      `/coding/room-updates?run=${executionRunId}&conversation=${conversationId}&job=${job.id}&workspace=${workspace.id}`,
      { headers: { cookie: rotatedCookie } },
    );
    assert.equal(reconnected.status, 200);
    reader = reconnected.body!.getReader();
    const reconnectedSnapshot = await reader.read();
    assert.equal(reconnectedSnapshot.done, false);
    const reconnectedText = new TextDecoder().decode(reconnectedSnapshot.value);
    assert.equal(reconnectedText.split(lateText).length - 1, 1,
      "the reconnect snapshot contains each late update exactly once");
    currentPageCookie = rotatedCookie;
  }

  roomUpdates.settleTask(executionRunId, "implement");
  for (let index = 0; index < 2; index += 1) {
    const settled = await reader.read();
    assert.equal(settled.done, false);
    const settledText = new TextDecoder().decode(settled.value);
    assert.match(settledText, /"type":"settled"/u);
    assert.match(settledText, /"settled":true/u);
    assert.doesNotMatch(settledText, /private-live-(?:prompt|tool-input)/u);
  }

  const syntheticBase = publicList(executionRunId)[0];
  assert.ok(syntheticBase);
  assert.ok(injectRoomEvent);
  for (let index = 0; index < 300; index += 1) {
    injectRoomEvent({
      type: "update",
      update: {
        ...syntheticBase,
        updateId: `synthetic-${String(index)}`,
        taskId: `synthetic-task-${String(index)}`,
        updateKey: "working",
        text: `Synthetic bounded update ${String(index)}`,
        sequence: 1_000 + index,
        settled: false,
      },
    });
  }
  const retainedSequences: number[] = [];
  for (let index = 0; index < 256; index += 1) {
    const retained = await reader.read();
    assert.equal(retained.done, false);
    const record = JSON.parse(new TextDecoder().decode(retained.value).trim()) as {
      readonly update: { readonly sequence: number };
    };
    retainedSequences.push(record.update.sequence);
  }
  assert.equal(retainedSequences[0], 1_044);
  assert.equal(retainedSequences.at(-1), 1_299);

  injectRoomEvent({
    type: "update",
    update: {
      ...syntheticBase,
      updateId: "coalesced-update",
      text: "This intermediate pending event must be replaced.",
      sequence: 2_000,
      settled: false,
    },
  });
  injectRoomEvent({
    type: "settled",
    update: {
      ...syntheticBase,
      updateId: "coalesced-update",
      text: "The coalesced event retains its terminal presentation state.",
      sequence: 2_000,
      settled: true,
    },
  });
  const coalesced = await reader.read();
  assert.equal(coalesced.done, false);
  const coalescedText = new TextDecoder().decode(coalesced.value);
  assert.match(coalescedText, /"type":"settled"/u);
  assert.match(coalescedText, /coalesced event retains its terminal/u);

  await jobWaitStarted;
  deferNextAuthorizationLookup = true;
  roomUpdates.post({
    runId: executionRunId,
    taskId: "late-task",
    executionId: "late-execution",
    nodeId: "workspace.implementation",
  }, {
    updateKey: "late-update",
    text: "This update must not cross the terminal job boundary.",
    intent: "progress",
    recipientNodeIds: ["human.operator"],
  });
  await authorizationLookupStarted;
  jobs.set(job.id, { ...job, status: "completed", updatedAt: 7 });
  for (const resolveJobWait of resolveJobWaits) resolveJobWait();
  await streamUnsubscribed;
  resolveStaleAuthorization();
  const ended = await reader.read();
  assert.equal(ended.done, true);
  assert.equal(unsubscribeCount, 3, "two revoked generations and the terminal generation each unsubscribe once");

  const missing = await app.request(
    `/coding/room-updates?run=${executionRunId}&conversation=${conversationId}&job=job-missing-room-update&workspace=${workspace.id}`,
    { headers: { cookie: currentPageCookie } },
  );
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Coding run not found.");
  const foreign = await app.request(
    `/coding/room-updates?run=${foreignExecutionRunId}&conversation=${foreignConversationId}&job=${foreignJob.id}&workspace=${workspace.id}`,
    { headers: { cookie: currentPageCookie } },
  );
  assert.equal(foreign.status, 404);
  assert.equal(await foreign.text(), "Coding run not found.");
  const inactive = await app.request(
    `/coding/room-updates?run=coding-inactive-room-execution&conversation=coding-inactive-room-conversation&job=${inactiveJob.id}&workspace=${workspace.id}`,
    { headers: { cookie: currentPageCookie } },
  );
  assert.equal(inactive.status, 404);
  assert.equal(await inactive.text(), "Coding run not found.");
});

test("retired coding status projection is unavailable while page selectors stay scoped", async () => {
  const mismatchedJob: QueueJob = {
    id: "job-other-run",
    agentId: "coding-agent",
    lane: "collect",
    payload: { kind: "coding-agent.run", runId: "coding-other-run" },
    status: "failed",
    attempt: 3,
    maxAttempts: 3,
    createdAt: 1,
    updatedAt: 2,
    lastError: "must not cross the run boundary",
    commands: [],
  };
  const nonCodingJob: QueueJob = {
    ...mismatchedJob,
    id: "job-non-coding",
    agentId: "other-agent",
    payload: { kind: "other.run", runId: "coding-expected-run" },
    lastError: "must not project a non-Coding job",
  };
  const otherWorkspaceJob: QueueJob = {
    ...mismatchedJob,
    id: "job-other-workspace",
    payload: {
      kind: "coding-agent.run",
      runId: "coding-expected-run",
      codingWorkspaceId: "workspace-other",
    },
    lastError: "must not cross the workspace boundary",
  };
  const jobs = new Map([mismatchedJob, nonCodingJob, otherWorkspaceJob].map((job) => [job.id, job]));
  const queue = {
    enqueue: async () => mismatchedJob,
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (id: string) => jobs.get(id),
    listJobs: async () => [...jobs.values()],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const app = new Hono();
  createCodingRoute({ runtime, queue }).register(app);
  const response = await app.request("/coding/status?run=coding-expected-run&job=job-other-run");
  assert.equal(response.status, 404);
  const invalid = await app.request("/coding/status?run=coding-expected-run&job=../other");
  assert.equal(invalid.status, 404);

  const initialWithoutRun = await app.request("/coding?job=job-other-run");
  assert.equal(initialWithoutRun.status, 400);
  assert.match(await initialWithoutRun.text(), /requires a valid run/);
  const initialInvalidRun = await app.request("/coding?run=..%2Fother&job=job-other-run");
  assert.equal(initialInvalidRun.status, 400);
  assert.match(await initialInvalidRun.text(), /Invalid coding run/);
  const initialInvalidJob = await app.request("/coding?run=coding-expected-run&job=..%2Fother");
  assert.equal(initialInvalidJob.status, 400);
  assert.match(await initialInvalidJob.text(), /Invalid coding job/);
  const initialMismatch = await app.request("/coding?run=coding-expected-run&job=job-other-run");
  assert.equal(initialMismatch.status, 404);
  assert.match(await initialMismatch.text(), /Coding job not found/);
  const initialNonCoding = await app.request("/coding?run=coding-expected-run&job=job-non-coding");
  assert.equal(initialNonCoding.status, 404);
  assert.match(await initialNonCoding.text(), /Coding job not found/);
  const initialOtherWorkspace = await app.request("/coding?run=coding-expected-run&job=job-other-workspace");
  assert.equal(initialOtherWorkspace.status, 404);
  assert.match(await initialOtherWorkspace.text(), /Coding job not found/);
});

const savedWorkspaceState = (options: { readonly minimalReviewTeam?: boolean } = {}) => {
  const discovered = reviewCodingWorkspaceSnapshot({
    repositoryRoot: process.cwd(),
    files: ["package.json", "src/server.ts", "src/views/coding.ts", "docs/README.md"],
    manifests: [{
      path: "package.json",
      content: JSON.stringify({ dependencies: { react: "1.0.0" } }),
    }],
    reviewedAt: 10,
  });
  const retainedNodeIds = new Set(["workspace.implementation", "workspace.quality"]);
  const profile = options.minimalReviewTeam
    ? {
        ...discovered,
        nodes: discovered.nodes.filter((node) => retainedNodeIds.has(node.id)),
        dependencies: discovered.dependencies?.filter((dependency) =>
          retainedNodeIds.has(dependency.nodeId) && retainedNodeIds.has(dependency.dependsOnNodeId)),
        dependencyProposals: [],
        dependencyConflicts: [],
      }
    : discovered;
  const { nodes: _nodes, ...review } = profile;
  let state = reduceOrchestration(
    initialOrchestrationState,
    orchestrationConfiguredEvent("coding-workspace", codingWorkspacePack(profile)),
    10,
  );
  state = reduceOrchestration(state, inlineArtifactPublishedEvent({
    runId: "coding-workspace",
    artifactId: "workspace-profile-test",
    origin: "input",
    outputKey: CODING_WORKSPACE_PROFILE_OUTPUT,
    nodeId: "coordinator",
    kind: "coding.workspace-profile",
    inputVersions: {},
  }, JSON.stringify(review)), 11);
  return state;
};

test("reviewed routes require planner-selected reviewers and clarify when none remain", async () => {
  const workspace = codingRepositoryWorkspace(process.cwd());
  const states = new Map<string, OrchestrationState>([[
    workspace.profileStream,
    savedWorkspaceState(),
  ]]);
  const events = new Map<string, OrchestrationEvent[]>();
  const routeRuntime: CodingAgentRuntime = {
    ...runtime,
    execute: async (stream, command) => {
      states.set(stream, reduceOrchestration(states.get(stream) ?? initialOrchestrationState, command.event, Date.now()));
      events.set(stream, [...(events.get(stream) ?? []), command.event]);
      return [command.event];
    },
    state: async (stream) => states.get(stream) ?? initialOrchestrationState,
    chain: async (stream) => (events.get(stream) ?? []).map((event, index) => ({
      id: `reviewer-preflight-${index}`,
      stream,
      sequence: index + 1,
      timestamp: index + 1,
      hash: `reviewer-preflight-hash-${index}`,
      previousHash: index ? `reviewer-preflight-hash-${index - 1}` : "",
      body: event,
    })),
  };
  let enqueueCount = 0;
  const queue = {
    enqueue: async (input: Parameters<AgentLoaderContext["queue"]["enqueue"]>[0]) => {
      enqueueCount += 1;
      return {
        id: `reviewer-preflight-job-${enqueueCount}`,
        agentId: input.agentId,
        lane: input.lane ?? "collect",
        payload: input.payload,
        status: "queued" as const,
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 1,
        createdAt: enqueueCount,
        updatedAt: enqueueCount,
        commands: [],
      };
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async () => undefined,
    listJobs: async () => [],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const app = new Hono();
  let reviewerMode: "supervisor-only" | "unavailable" = "supervisor-only";
  let plannerSelectsReviewer = false;
  createCodingRoute({
    runtime: routeRuntime,
    queue,
    conversationPlanner: async ({ workspaceNodes }) => {
      const primary = workspaceNodes.find((node) => node.capabilities.includes("implement"));
      assert.ok(primary);
      for (const node of workspaceNodes) {
        if (node.id === primary.id || node.metadata?.participantKind === "human") continue;
        const mutableNode = node as {
          capabilities: string[];
          metadata?: Record<string, unknown>;
        };
        mutableNode.capabilities.splice(0, mutableNode.capabilities.length, "respond");
        mutableNode.metadata = {
          ...(mutableNode.metadata ?? {}),
          role: reviewerMode === "supervisor-only" ? "supervisor" : "worker",
        };
      }
      const selectedReviewer = workspaceNodes.find((node) =>
        node.id !== primary.id
        && node.metadata?.participantKind !== "human"
        && node.metadata?.role === "supervisor");
      return {
        disposition: "ready",
        selectedNodeIds: [
          primary.id,
          ...(plannerSelectsReviewer && selectedReviewer ? [selectedReviewer.id] : []),
        ],
        primaryNodeId: primary.id,
        coordination: { reviewMode: "reviewed", validationScope: "focused" },
        tags: ["intent:change"],
        questions: [],
        rationale: "The requested repository change requires review.",
        confidence: 1,
      };
    },
  }).register(app);

  const omittedResponse = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Do not infer a saved reviewer", reviewPolicy: "reviewed" }),
  });
  assert.equal(omittedResponse.status, 200, await omittedResponse.clone().text());
  const omittedBody = await omittedResponse.json() as {
    readonly disposition: string;
    readonly activation: string;
    readonly route: { readonly questions: ReadonlyArray<string> };
    readonly job: unknown;
  };
  assert.equal(omittedBody.disposition, "needs_clarification");
  assert.equal(omittedBody.activation, "none");
  assert.equal(omittedBody.job, null);
  assert.equal(enqueueCount, 0);
  assert.match(omittedBody.route.questions.join(" "), /enable or select a saved review-capable workspace node/i);

  states.set(workspace.profileStream, savedWorkspaceState());
  plannerSelectsReviewer = true;
  const supervisorResponse = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Use the explicitly selected supervisor reviewer", reviewPolicy: "reviewed" }),
  });
  assert.equal(supervisorResponse.status, 202, await supervisorResponse.clone().text());
  const supervisorBody = await supervisorResponse.json() as {
    readonly route: {
      readonly primaryNodeId: string;
      readonly selectedNodeIds: ReadonlyArray<string>;
    };
    readonly job: { readonly id: string } | null;
  };
  assert.ok(supervisorBody.job);
  assert.ok(supervisorBody.route.selectedNodeIds.some((nodeId) =>
    nodeId !== supervisorBody.route.primaryNodeId));
  assert.equal(enqueueCount, 1);

  states.set(workspace.profileStream, savedWorkspaceState());
  reviewerMode = "unavailable";
  const response = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Change the repository with review", reviewPolicy: "reviewed" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as {
    readonly disposition: string;
    readonly activation: string;
    readonly route: { readonly questions: ReadonlyArray<string>; readonly rationale: string };
    readonly job: unknown;
  };
  assert.equal(body.disposition, "needs_clarification");
  assert.equal(body.activation, "none");
  assert.equal(body.job, null);
  assert.equal(enqueueCount, 1);
  assert.match(body.route.questions.join(" "), /enable or select a saved review-capable workspace node/i);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /Stopped before the first step/i);
  assert.doesNotMatch(serialized, /Reviewed coding execution requires an explicitly selected review-capable workspace node/i);
});

test("reviewed Retry Run clarifies without enqueue when the current saved profile has no reviewer", async () => {
  const workspace = codingRepositoryWorkspace(process.cwd());
  const conversationId = "coding-reviewer-unavailable-retry";
  const failedJob: QueueJob = {
    id: "job-reviewer-unavailable-retry",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.run",
      runId: conversationId,
      conversationId,
      codingWorkspaceId: workspace.id,
      executionKind: "investigation",
      objective: "Retry this reviewed change",
      reviewPolicy: "reviewed",
      workerExecution: testWorkerExecution(),
      selectedNodeIds: ["workspace.quality", "workspace.ui"],
      primaryNodeId: "workspace.quality",
      coordination: { reviewMode: "reviewed", validationScope: "focused" },
    },
    status: "failed",
    attempt: 1,
    maxAttempts: 4,
    createdAt: 1,
    updatedAt: 2,
    lastError: "reviewer was unavailable",
    commands: [],
  };
  const profileState = savedWorkspaceState({ minimalReviewTeam: true });
  const states = new Map<string, OrchestrationState>([[workspace.profileStream, profileState]]);
  const events = new Map<string, OrchestrationEvent[]>();
  const retryRuntime: CodingAgentRuntime = {
    ...runtime,
    execute: async (stream, command) => {
      states.set(stream, reduceOrchestration(states.get(stream) ?? initialOrchestrationState, command.event, Date.now()));
      events.set(stream, [...(events.get(stream) ?? []), command.event]);
      return [command.event];
    },
    state: async (stream) => states.get(stream) ?? initialOrchestrationState,
    chain: async (stream) => (events.get(stream) ?? []).map((event, index) => ({
      id: `reviewer-retry-${index}`,
      stream,
      sequence: index + 1,
      timestamp: index + 1,
      hash: `reviewer-retry-hash-${index}`,
      previousHash: index ? `reviewer-retry-hash-${index - 1}` : "",
      body: event,
    })),
  };
  let enqueueCount = 0;
  const queue = {
    enqueue: async () => {
      enqueueCount += 1;
      throw new Error("reviewer retry preflight must happen before enqueue");
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (jobId: string) => jobId === failedJob.id ? failedJob : undefined,
    listJobs: async () => [failedJob],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const app = new Hono();
  createCodingRoute({ runtime: retryRuntime, queue }).register(app);

  const response = await app.request(`/api/v2/coding/runs/${conversationId}/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: failedJob.id }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as {
    readonly disposition: string;
    readonly route: { readonly disposition: string; readonly questions: ReadonlyArray<string> };
    readonly job: unknown;
  };
  assert.equal(body.disposition, "needs_clarification");
  assert.equal(body.route.disposition, "needs_clarification");
  assert.equal(body.job, null);
  assert.equal(enqueueCount, 0);
  assert.match(body.route.questions.join(" "), /enable or select a saved review-capable workspace node/i);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /Stopped before the first step/i);
  assert.doesNotMatch(serialized, /Reviewed coding execution requires an explicitly selected review-capable workspace node/i);
});

test("tracked rescan API is additive, idempotent, and workspace-single-flight", async () => {
  const jobs = new Map<string, QueueJob>();
  const queue = {
    enqueue: async (input: Parameters<AgentLoaderContext["queue"]["enqueue"]>[0]) => {
      const job: QueueJob = {
        id: input.jobId ?? "tracked-rescan-job",
        agentId: input.agentId,
        lane: input.lane ?? "collect",
        sessionKey: input.sessionKey,
        payload: input.payload,
        status: "queued",
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        commands: [],
      };
      jobs.set(job.id, job);
      return job;
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (jobId: string) => jobs.get(jobId),
    listJobs: async () => [...jobs.values()],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const apiRuntime: CodingAgentRuntime = {
    ...runtime,
    state: async (stream) => stream === codingRepositoryWorkspace(process.cwd()).profileStream
      ? savedWorkspaceState()
      : initialOrchestrationState,
  };
  const app = new Hono();
  createCodingRoute({ runtime: apiRuntime, queue }).register(app);
  const request = (requestId: string, objective = "Rescan the saved team") => app.request("/api/v2/coding/workspace/rescans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective, requestId }),
  });
  const [accepted, simultaneousRetry] = await Promise.all([
    request("rescan-request-1"),
    request("rescan-request-1"),
  ]);
  assert.equal(accepted.status, 202);
  assert.equal(simultaneousRetry.status, 202);
  assert.match(accepted.headers.get("location") ?? "", /job=coding-rescan-/);
  const acceptedBody = await accepted.json() as {
    readonly duplicate: boolean;
    readonly statusLocation: string;
    readonly job: { readonly runKind: string; readonly capabilities: { readonly readOnly: boolean; readonly integratable: boolean } };
  };
  assert.equal(acceptedBody.duplicate, false);
  assert.equal(acceptedBody.job.runKind, "workspace-rescan");
  assert.deepEqual(acceptedBody.job.capabilities, { readOnly: true, integratable: false });
  const acceptedJobId = acceptedBody.statusLocation.split("job=")[1]!;
  const discoveryExecution = jobs.get(acceptedJobId)?.payload.discoveryExecution as {
    readonly schema?: string;
    readonly runtime?: string;
    readonly model?: string;
    readonly pi?: {
      readonly extensionPackages?: ReadonlyArray<string>;
      readonly tools?: ReadonlyArray<string>;
    };
  } | undefined;
  assert.equal(discoveryExecution?.schema, "roster.coding-worker-execution.v1");
  assert.equal(discoveryExecution?.runtime, "pi-agent");
  assert.equal(discoveryExecution?.model, "openai-codex/gpt-5.6-luna");
  assert.deepEqual(discoveryExecution?.pi?.extensionPackages, ["@cortexkit/aft-pi"]);
  assert.deepEqual(discoveryExecution?.pi?.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "aft_outline",
    "aft_zoom",
    "aft_search",
    "ast_grep_search",
    "lsp_diagnostics",
  ]);
  assert.match(acceptedBody.statusLocation, /^\/api\/v2\/coding\/runs\/workspace-rescan-/);
  assert.equal((await app.request(acceptedBody.statusLocation)).headers.get("content-type")?.includes("application/json"), true);
  const simultaneousBody = await simultaneousRetry.json() as {
    readonly runId: string;
    readonly job: { readonly id: string };
  };
  assert.equal(simultaneousBody.job.id, acceptedBody.statusLocation.split("job=")[1]);
  assert.match(simultaneousBody.runId, /^workspace-rescan-/);
  const duplicate = await request("rescan-request-1");
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json() as { readonly duplicate: boolean }).duplicate, true);
  const changedDuplicate = await request("rescan-request-1", "Rescan the saved team with changed input");
  assert.equal(changedDuplicate.status, 409);
  for (let index = 0; index < 201; index += 1) {
    jobs.set(`newer-${index}`, {
      id: `newer-${index}`,
      agentId: "coding-agent",
      lane: "collect",
      payload: { kind: "coding-agent.run", runId: `newer-${index}` },
      status: "completed",
      attempt: 1,
      maxAttempts: 1,
      createdAt: Date.now() + index,
      updatedAt: Date.now() + index,
      commands: [],
    });
  }
  const oldRetry = await request("rescan-request-1");
  assert.equal(oldRetry.status, 202);
  assert.equal((await oldRetry.json() as { readonly duplicate: boolean }).duplicate, true);
  const conflict = await request("rescan-request-2");
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json() as { readonly error: string }).error, /already active/);
  const malformed = await app.request("/api/v2/coding/workspace/rescans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "[]",
  });
  assert.equal(malformed.status, 400);
  const invalidMediaType = await app.request("/api/v2/coding/workspace/rescans", {
    method: "POST",
    headers: { "content-type": "text/application/json-invalid" },
    body: JSON.stringify({ requestId: "invalid-media" }),
  });
  assert.equal(invalidMediaType.status, 415);
  const initialScan = await app.request("/api/v2/coding/workspace/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(initialScan.status, 409);
});

test("coding demo renders the coordinated local-only workflow and enqueues a run", async () => {
  const enqueued: Array<Readonly<Record<string, unknown>>> = [];
  const queuedJobs = new Map<string, QueueJob>();
  const previousRun: QueueJob = {
    id: "previous-job",
    agentId: "coding-agent",
    lane: "collect",
    sessionKey: "coding-agent:test",
    singletonMode: "cancel",
    payload: {
      kind: "coding-agent.run",
      runId: "coding_previous_docs",
      objective: "Previous docs run",
      reviewPolicy: "fast",
      workerExecution: testWorkerExecution(),
    },
    status: "completed",
    attempt: 1,
    maxAttempts: 1,
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now() - 60_000,
    commands: [],
  };
  const activeRun: QueueJob = {
    ...previousRun,
    id: "job-active",
    payload: {
      kind: "coding-agent.run",
      runId: "coding-active",
      conversationId: "coding-active",
      codingWorkspaceId: codingRepositoryWorkspace(process.cwd()).id,
      objective: "Active coding run",
      reviewPolicy: "auto",
      workerExecution: testWorkerExecution(),
    },
    status: "running",
    updatedAt: Date.now(),
  };
  const failedRun: QueueJob = {
    ...previousRun,
    id: "job-failed",
    payload: {
      kind: "coding-agent.run",
      runId: "coding-failed",
      conversationId: "coding-failed",
      codingWorkspaceId: codingRepositoryWorkspace(process.cwd()).id,
      executionKind: "investigation",
      objective: "Retry this failed change",
      reviewPolicy: "reviewed",
      workerExecution: testWorkerExecution("codex-cli"),
      selectedNodeIds: ["workspace.implementation", "workspace.api"],
      primaryNodeId: "workspace.implementation",
      coordination: { reviewMode: "reviewed", validationScope: "focused" },
    },
    status: "failed",
    updatedAt: Date.now() - 20_000,
    lastError: "worker runtime exited before certification",
  };
  const semanticFailedRun: QueueJob = {
    ...failedRun,
    id: "job-semantic-failed",
    payload: {
      ...failedRun.payload,
      runId: "coding-semantic-failed",
      conversationId: "coding-semantic-failed",
      objective: "Retry a graph failure recorded under a completed wrapper",
    },
    status: "completed",
    lastError: undefined,
  };
  const queue = {
    enqueue: async (input: Readonly<Record<string, unknown>>) => {
      enqueued.push(input);
      const job: QueueJob = {
        id: typeof input.jobId === "string" ? input.jobId : `coding-job-${enqueued.length}`,
        agentId: String(input.agentId ?? "coding-agent"),
        lane: "collect" as const,
        payload: input.payload as QueueJob["payload"],
        status: "queued" as const,
        attempt: 0,
        maxAttempts: Number(input.maxAttempts ?? 1),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        commands: [],
      };
      queuedJobs.set(job.id, job);
      return job;
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (id: string) => queuedJobs.get(id) ?? (id === previousRun.id
      ? previousRun
      : id === activeRun.id
        ? activeRun
        : id === failedRun.id
          ? failedRun
          : id === semanticFailedRun.id ? semanticFailedRun : undefined),
    listJobs: async () => [...queuedJobs.values(), activeRun, failedRun, semanticFailedRun, previousRun],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const enrichedNodes: string[] = [];
  const workspaceStates = new Map<string, OrchestrationState>();
  let workspaceSettingsWrites = 0;
  let rejectWorkspacePersistence = false;
  const scanningRuntime: CodingAgentRuntime = {
    ...runtime,
    execute: async (stream, command) => {
      if (rejectWorkspacePersistence
        && command.event.type === "artifact.published"
        && command.event.outputKey === CODING_WORKSPACE_PROFILE_OUTPUT) {
        throw new Error("workspace profile store unavailable");
      }
      if (command.event.type === "artifact.published" && command.event.kind === "coding.workspace-settings") {
        workspaceSettingsWrites += 1;
      }
      workspaceStates.set(stream, reduceOrchestration(
        workspaceStates.get(stream) ?? initialOrchestrationState,
        command.event,
        Date.now(),
      ));
      return [command.event];
    },
    state: async (stream) => workspaceStates.get(stream) ?? initialOrchestrationState,
  };
  workspaceStates.set("agents/coding-agent/runs/coding-semantic-failed", {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph("coding-semantic-failed", [{
      taskId: "coding-finalize",
      nodeId: "coordinator",
      capability: "certify",
      status: "canceled",
    }]),
  });
  const app = new Hono();
  createCodingRoute({
    showGlobalNavigation: false,
    runtime: scanningRuntime,
    queue,
    conversationPlanner: explicitMutationPlanner,
    workspaceReviewer: async ({ node }) => {
      enrichedNodes.push(node.id);
      return {
        summary: `Repository-specific ${node.id} responsibility.`,
        operatingInstructions: `Review the bounded ${node.id} evidence before reporting.`,
        skills: [{ name: `${node.id} evidence`, description: "Use repository evidence for this specialty." }],
        toolRequirements: ["lsp"],
        dependencies: node.id === "workspace.quality"
          ? [{ nodeId: "workspace.implementation", reason: "Quality consumes implementation evidence." }]
          : [],
      };
    },
    runtimeOptions: async () => [
      { value: "pi-agent", label: "Pi Code · AFT", detail: "Pi with curated AST, search, and LSP extensions" },
      { value: "hermes-agent", label: "Hermes Agent", detail: "Nous Hermes in quiet one-shot mode" },
      { value: "claude-code", label: "Claude Code", detail: "Installed implementation runtime" },
      {
        value: "codex-cli",
        label: "Codex CLI",
        detail: "Native OpenAI Codex CLI",
        mcp: {
          mode: "native",
          readiness: "discovered",
          servers: [{ name: "docs", transport: "http", status: "enabled", source: "runtime" }],
          truncated: false,
        },
      },
    ],
  }).register(app);

  const page = await app.request("/coding");
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Coding Roster/);
  assert.match(body, /Assemble a roster for this repository/);
  assert.match(body, /Scan repository and assemble roster/);
  assert.match(body, /Read-only structural discovery · source files stay untouched/);
  assert.match(body, /data-coding-workspace-scan/);
  assert.match(body, /data-coding-workspace-scan-status/);
  assert.match(body, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(body, /Scanning…/);
  assert.match(body, /Repository scan failed\./);
  const onboardingScripts = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .filter((match) => !/\btype="(?:application\/json|importmap)"/u.test(match[0]))
    .map((match) => match[1] ?? "");
  assert.ok(onboardingScripts.length > 0);
  onboardingScripts.forEach((script, index) => {
    assert.doesNotThrow(() => new Function(script), `inline onboarding script ${index + 1} must parse`);
  });
  assert.doesNotMatch(body, /Send to team/);
  assert.doesNotMatch(body, /One workspace, one branch per change/i);
  assert.doesNotMatch(body, /Recent coding runs/);

  const blockedBeforeScan = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Add a health endpoint" }),
  });
  assert.equal(blockedBeforeScan.status, 409);
  assert.match(await blockedBeforeScan.text(), /scan this repository/i);

  const scan = await app.request("/coding/workspace/scan", { method: "POST" });
  assert.equal(scan.status, 303);
  const scanDestination = scan.headers.get("location") ?? "";
  assert.match(scanDestination, /teamRefresh=[a-f0-9]{48}/);
  const scannedPage = await app.request(scanDestination);
  const scannedBody = await scannedPage.text();
  assert.match(scannedBody, /class="coding-workbench"/);
  assert.match(scannedBody, /data-workspace-shell data-layout="slack-workspace" data-slot="workspace-shell"/);
  assert.match(scannedBody, /data-workspace-region="rail"/);
  assert.match(scannedBody, /data-workspace-region="conversation"/);
  assert.match(scannedBody, /data-workspace-region="context"/);
  assert.match(scannedBody, /class="agent-app coding-page" data-slot="agent-shell"/);
  assert.doesNotMatch(scannedBody, /class="top-navbar agent-top-nav" data-slot="agent-top-nav"/);
  assert.doesNotMatch(scannedBody, /aria-label="Primary navigation"/);
  assert.doesNotMatch(scannedBody, /class="top-navbar-brand" href="\/monitor"/);
  assert.doesNotMatch(scannedBody, /Coding ready|aria-label="Workspace status"/);
  assert.match(scannedBody, /class="sidebar agent-sidebar coding-project-rail"[^>]*data-coding-project-rail[^>]*data-slot="workspace-rail"/);
  assert.match(scannedBody, /id="main" data-slot="agent-main"/);
  assert.match(scannedBody, /aria-label="Repository rooms and team"/);
  assert.match(scannedBody, /Project scope/);
  assert.match(scannedBody, /Needs attention/);
  assert.match(scannedBody, /Coding run failed/);
  assert.match(scannedBody, /Retry safely/);
  assert.match(scannedBody, /data-enable-notifications/);
  assert.match(scannedBody, /data-disclosure-key="recent-rooms" open/);
  assert.match(scannedBody, /<h2 id="coding-project-runs-title">Rooms<\/h2>/);
  assert.match(scannedBody, /class="coding-new-room" href="\/coding\?workspace=workspace_[a-f0-9]{20}" aria-current="page" data-new-room/);
  assert.match(scannedBody, /<strong>New room<\/strong><small>Start a fresh conversation<\/small>/);
  assert.match(scannedBody, /\.coding-page \.coding-message,\.coding-page \.coding-message\.user\{display:grid;grid-template-columns:40px minmax\(0,1fr\)/);
  assert.match(scannedBody, /\.coding-page \.coding-message article,\.coding-page \.coding-message\.user article\{width:min\(900px,100%\);max-width:100%;padding:0;border:0;border-radius:0;background:transparent\}/);
  assert.match(scannedBody, /\.coding-page \.coding-run-progress\.coding-message\{grid-template-columns:40px minmax\(0,1fr\);gap:12px;padding:10px clamp\(22px,4vw,52px\);border:0;border-radius:0;background:transparent\}/);
  assert.doesNotMatch(scannedBody, /--workspace-inspector-width|justify-items:stretch|border-radius:16px 16px 4px 16px/);
  assert.match(scannedBody, /<progress class="coding-progress"[^>]+value="\d+" max="100">/);
  assert.doesNotMatch(scannedBody, /\sstyle="/);
  const renderedAgentCount = Number(scannedBody.match(/Agents<\/h2><span>(\d+)<\/span>/)?.[1]);
  assert.ok(renderedAgentCount >= 2 && renderedAgentCount <= 10);
  assert.match(scannedBody, /data-coding-room-search/);
  assert.match(scannedBody, /placeholder="Search rooms…"/);
  assert.match(scannedBody, /class="coding-composer-presence"/);
  assert.match(scannedBody, /coding-project-runs/);
  assert.match(scannedBody, /coding-project-team/);
  const projectRail = scannedBody.match(/<aside class="sidebar agent-sidebar coding-project-rail"[\s\S]*?<\/aside>/)?.[0] ?? "";
  assert.doesNotMatch(projectRail, /<footer>|github\.com\/|skishore23/);
  assert.match(scannedBody, /data-workspace-switcher/);
  const currentRepositoryName = process.cwd().split(/[\\/]/).at(-1) ?? "repository";
  assert.match(scannedBody, new RegExp(`Switch workspace, ${currentRepositoryName} selected`));
  assert.match(scannedBody, new RegExp(`<em>Workspace</em><strong translate="no">${currentRepositoryName}</strong>`));
  const workspaceSummary = scannedBody.match(/<summary class="coding-project-identity"[\s\S]*?<\/summary>/)?.[0] ?? "";
  assert.match(workspaceSummary, /^<summary[^>]*><div>/);
  assert.doesNotMatch(workspaceSummary, /<span[^>]*aria-hidden="true"/);
  assert.match(scannedBody, /\.coding-project-identity\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(scannedBody, /\.coding-workspace-switcher>summary\{grid-template-columns:minmax\(0,1fr\) 12px\}/);
  assert.match(scannedBody, /aria-current="page"/);
  assert.match(scannedBody, /Add Workspace/);
  assert.match(scannedBody, /aria-haspopup="dialog"/);
  assert.match(scannedBody, /<dialog class="coding-workspace-picker"/);
  assert.match(scannedBody, /Add a Repository/);
  assert.match(scannedBody, /data-workspace-picker-status/);
  assert.match(scannedBody, /data-workspace-add-progress role="status" aria-live="polite"/);
  assert.match(scannedBody, /Adding repository and creating its agent team/);
  assert.match(scannedBody, /large repositories can take a few minutes/);
  assert.match(scannedBody, /fetch\(form\.action,\{method:'POST',headers:\{accept:'application\/json'\}/);
  assert.match(scannedBody, /action="\/coding\/workspaces"/);
  assert.match(scannedBody, /name="repositoryPath"/);
  assert.match(scannedBody, /aria-disabled="true" data-workspace-picker-submit/);
  assert.match(scannedBody, /Saved team/);
  assert.match(scannedBody, /evolved 1/);
  assert.ok(enrichedNodes.length > 0);
  const enrichedWorkspaceResponse = await app.request("/api/v2/coding/workspace");
  const enrichedWorkspaceBody = await enrichedWorkspaceResponse.json() as {
    readonly workspace: {
      readonly enrichmentEpoch?: number;
      readonly dependencies?: ReadonlyArray<{ readonly nodeId: string; readonly dependsOnNodeId: string }>;
      readonly nodes: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly skills?: ReadonlyArray<unknown>;
      }>;
    };
  };
  assert.equal(enrichedWorkspaceBody.workspace.enrichmentEpoch, 1);
  assert.ok(enrichedWorkspaceBody.workspace.dependencies?.some((dependency) =>
    dependency.nodeId === "workspace.quality" && dependency.dependsOnNodeId === "workspace.implementation"));
  assert.ok(enrichedWorkspaceBody.workspace.nodes.find((node) => node.id === "workspace.quality")?.skills?.length);
  assert.match(scannedBody, /Rescan team/);
  assert.match(scannedBody, /action="\/coding\/workspace\/scan" method="post" data-coding-team-refresh/);
  assert.match(scannedBody, /aria-describedby="coding-team-refresh-status"/);
  assert.match(scannedBody, /role="status" aria-live="polite" aria-atomic="true" data-coding-team-refresh-status/);
  assert.match(scannedBody, /Repository scan complete\. The saved specialist profile is ready for future conversations\./);
  assert.doesNotMatch(await (await app.request(scanDestination)).text(), /Repository scan complete/);
  assert.doesNotMatch(await (await app.request(`${scanDestination.split("&teamRefresh=")[0]}&teamRefresh=${"f".repeat(48)}`)).text(), /scan complete/i);
  assert.doesNotMatch(projectRail, /<strong>Avery<\/strong>|<strong>You<\/strong>/);
  assert.equal(scannedBody.match(/data-coding-agent-node=/g)?.length, renderedAgentCount);
  assert.equal(scannedBody.match(/class="coding-project-agent-execution" data-coding-agent="Pi Code" data-coding-model="GPT-5\.6 Luna"/g)?.length, renderedAgentCount);
  assert.equal(scannedBody.match(/class="coding-project-agent-change participant-profile-trigger"/g)?.length, renderedAgentCount);
  for (const node of enrichedWorkspaceBody.workspace.nodes.filter((candidate) => candidate.id.startsWith("workspace."))) {
    const separator = node.name.indexOf(", ");
    assert.ok(separator > 0, `saved specialist ${node.id} must expose its display identity`);
    const givenName = node.name.slice(0, separator);
    const displayRole = node.name.slice(separator + 2);
    assert.ok(
      scannedBody.includes(`>${givenName}</button><small class="coding-project-agent-role">${displayRole}</small>`),
      `saved specialist ${givenName}, ${displayRole} must appear in the project roster`,
    );
  }
  assert.match(scannedBody, />Kai<\/button><small class="coding-project-agent-role">Implementation Engineer<\/small>/);
  assert.match(scannedBody, /data-participant-profile="workspace\.implementation"[^>]*aria-label="Open Kai profile and change agent or model">Change<\/button>/);
  assert.match(scannedBody, />Mira<\/button><small class="coding-project-agent-role">Quality Reviewer<\/small>/);
  assert.match(scannedBody, /data-participant-runtime-editor/);
  assert.match(scannedBody, /action="\/coding\/workspace\/settings" method="post" data-participant-runtime-form/);
  assert.match(scannedBody, /class="coding-agent-symbol coding-project-agent-mark"/);
  assert.match(scannedBody, /data-agent-tone="interface"/);
  assert.match(scannedBody, /viewBox="0 0 16 16"/);
  assert.match(scannedBody, /Chat with your repository team/);
  assert.match(scannedBody, /You are messaging #repository-room/);
  assert.match(scannedBody, /class="coding-composer-runtime"/);
  assert.match(scannedBody, /placeholder="Message #repository-room…"/);
  assert.match(scannedBody, /Send to team/);
  assert.match(scannedBody, /Runs stay local until you merge/);
  assert.match(scannedBody, /Codex Sol\/high review/);
  assert.match(scannedBody, /Enter to send/);
  assert.match(scannedBody, /data-composer-advanced/);
  assert.match(scannedBody, /data-coding-new-messages[^>]*hidden/);
  assert.match(scannedBody, /Shift\+Enter for a new line/);
  assert.match(scannedBody, /data-coding-image-input/);
  assert.match(scannedBody, /accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
  assert.match(scannedBody, /data-coding-image-previews/);
  assert.match(scannedBody, /aria-label="Add images"/);
  assert.match(scannedBody, /prepareImage=async/);
  assert.match(scannedBody, /payload\.set\(&#39;images&#39;|payload\.set\('images'/);
  assert.match(scannedPage.headers.get("content-security-policy") ?? "", /img-src 'self' data: blob:/);
  assert.match(scannedBody, /Review mode/);
  assert.match(scannedBody, /Auto review/);
  const composer = scannedBody.match(/<form class="coding-composer"[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.ok(composer);
  assert.doesNotMatch(composer, /name="workerRuntime"|Implementation runtime/);
  assert.match(composer, /<strong data-run-presence-name>Kai<\/strong><span data-run-presence-status>· Ready<\/span>/);
  assert.match(composer, /class="coding-composer-runtime"><span>Pi Code<\/span>[\s\S]*<span>GPT-5\.6 Luna<\/span>/);
  assert.doesNotMatch(scannedBody, /<section class="coding-workspace-settings"/);
  assert.match(scannedBody, /Saved changes apply to future assignments/);
  const attentionResponse = await app.request("/coding/attention");
  assert.equal(attentionResponse.status, 404);
  const activeComposerBody = await (await app.request(`/coding?workspace=${codingRepositoryWorkspace(process.cwd()).id}&run=coding-active&job=job-active`)).text();
  const activeComposer = activeComposerBody.match(/<form class="coding-composer"[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.ok(activeComposer);
  const newRoomHref = activeComposerBody.match(/class="coding-new-room" href="([^"]+)"[^>]*data-new-room/)?.[1]?.replaceAll("&amp;", "&");
  assert.equal(newRoomHref, `/coding?workspace=${codingRepositoryWorkspace(process.cwd()).id}`);
  const freshRoomBody = await (await app.request(newRoomHref!)).text();
  const freshRoomComposer = freshRoomBody.match(/<form class="coding-composer"[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.ok(freshRoomComposer);
  assert.doesNotMatch(freshRoomComposer, /name="conversationId"/);
  assert.match(freshRoomComposer, /You are messaging #repository-room/);
  assert.match(activeComposer, /name="reviewPolicy"/);
  assert.doesNotMatch(activeComposer, /workerRuntime|Implementation runtime/);
  assert.match(scannedBody, /data-coding-mention-menu/);
  assert.match(scannedBody, /Mention a Specialist/);
  assert.match(scannedBody, /data-coding-mention="@iris"/);
  assert.match(scannedBody, /id="coding-mention-options" role="listbox"/);
  assert.match(scannedBody, /role="option" aria-selected="false" data-coding-mention="@iris"/);
  assert.match(scannedBody, /aria-controls="coding-mention-options" aria-haspopup="listbox" aria-expanded="false"/);
  assert.match(scannedBody, /src="\/assets\/coding-enhancements\.js\?v=[a-f0-9]{64}"[^>]*data-coding-enhancements/);
  assert.match(scannedBody, /\.coding-mermaid-diagram/);
  assert.match(scannedBody, /justify-items:start/);
  assert.match(scannedBody, /Optional routing input/);
  assert.match(scannedBody, /data-coding-room-transcript/);
  assert.doesNotMatch(scannedBody, /This repository room is ready for a question, a change request, or an addressed teammate message\./);
  assert.match(scannedBody, /event\.key!==&#39;Enter&#39;|event\.key!=='Enter'/);
  assert.match(scannedBody, /event\.shiftKey\|\|event\.isComposing/);
  assert.match(scannedBody, /application\/x-ndjson/);
  assert.match(scannedBody, /form\.dataset\.streamState='draining'/);
  assert.match(scannedBody, /event\.stopImmediatePropagation\(\)/);
  assert.match(scannedBody, /while\(queue\.length\)/);
  assert.match(scannedBody, /form\.dataset\.pendingMessages/);
  assert.match(scannedBody, /item\.user\?\.state.*textContent=&#39;Sending|item\.user\?\.state.*textContent='Sending/);
  assert.doesNotMatch(scannedBody, /item\.user\.state\.textContent=&#39;Accepted&#39;|item\.user\.state\.textContent='Accepted'/);
  assert.match(scannedBody, /Checking the live run…/);
  assert.match(scannedBody, /Working on it…/);
  assert.match(scannedBody, /avatar\.dataset\.thinkingOrb=''/);
  assert.match(scannedBody, /avatar\.dataset\.orbState='working'/);
  assert.match(scannedBody, /avatar\.dataset\.orbSize='32'/);
  assert.match(scannedBody, /\.coding-composer button\[type="submit"\]/);
  assert.doesNotMatch(scannedBody, /\.coding-composer button\{/);
  assert.doesNotMatch(scannedBody, /assistant=item\.active\?undefined/);
  assert.match(scannedBody, /update\.type===&#39;progress&#39;|update\.type==='progress'/);
  assert.match(scannedBody, /queueMicrotask/);
  assert.match(scannedBody, /form\.setAttribute\('aria-busy','true'\)/);
  assert.match(scannedBody, /submit\.disabled=true/);
  assert.match(scannedBody, /dataset\.state==='pending'/);
  assert.match(scannedBody, /Building your team/);
  assert.match(scannedBody, /Updating your team/);
  assert.match(scannedBody, /headers:\{accept:'application\/json'\}/);
  assert.match(scannedBody, /status\.dataset\.state='error'/);
  assert.match(scannedBody, /submit\.disabled=false/);
  assert.match(scannedBody, /status\.textContent='';/);
  assert.match(scannedBody, /queueMicrotask\(\(\)=>\{status\.textContent=announcement;/);
  assert.match(scannedBody, /body\.set\('returnTo',location\.pathname\+location\.search\)/);
  assert.match(scannedBody, /body\.set\('selectedAgent',selectedDetail\.id\)/);
  assert.match(scannedBody, /queueMicrotask\(\(\)=>trigger\.click\(\)\)/);
  assert.match(scannedBody, /data-coding-human-reply/);
  assert.match(scannedBody, /textarea\.scrollIntoView/);
  assert.match(scannedBody, /data-coding-command-trigger/);
  assert.match(scannedBody, /id="coding-command-dialog"/);
  assert.match(scannedBody, /data-coding-command-action="focus-composer"/);
  assert.match(scannedBody, /data-coding-command-action="workbench-work"/);
  assert.match(scannedBody, /data-coding-command-action="workbench-files"/);
  assert.match(scannedBody, /data-coding-command-action="workbench-team"/);
  assert.match(scannedBody, /data-coding-command-action="workbench-details"/);
  assert.match(scannedBody, /data-coding-overlay-scrim hidden/);
  assert.match(scannedBody, /const workbenchTabs=\['work','files','team','details'\]/);
  assert.match(scannedBody, /data-coding-rail-toggle/);
  assert.match(scannedBody, /data-coding-rail-close/);
  assert.match(scannedBody, /coding:open-workbench/);
  assert.doesNotMatch(scannedBody, /compactRailMedia\.matches&&projectRail instanceof HTMLElement\)projectRail\.hidden=true/);
  assert.doesNotMatch(scannedBody, /data-coding-command-action="workbench-(?:plan|changes|artifacts)"/);
  assert.match(scannedBody, /showModal\(\)/);
  assert.match(scannedBody, /key===&#39;k&#39;|key==='k'/);
  assert.doesNotMatch(scannedBody, /storedContext===&#39;open&#39;|storedContext==='open'/);
  assert.doesNotMatch(scannedBody, /matchMedia\(&#39;\(min-width: 1100px\)&#39;\)|matchMedia\('\(min-width: 1100px\)'\)/);
  assert.match(scannedBody, /searchParams\.set\(&#39;workbench&#39;|searchParams\.set\('workbench'/);
  assert.match(scannedBody, /roster:coding-scroll:v1/);
  assert.match(scannedBody, /roster:coding-rail-scroll:v1/);
  assert.match(scannedBody, /sessionStorage\.getItem\(scrollStorageKey\)/);
  assert.match(scannedBody, /sessionStorage\.setItem\(scrollStorageKey/);
  assert.match(scannedBody, /addEventListener\(&#39;pagehide&#39;|addEventListener\('pagehide'/);
  assert.match(scannedBody, /roomScroll\[roomView\]=scroller\.scrollTop/);
  assert.match(scannedBody, /openDetails:Array\.isArray\(parsed\.openDetails\)/);
  assert.match(scannedBody, /document\.addEventListener\(&#39;toggle&#39;|document\.addEventListener\('toggle'/);
  assert.match(scannedBody, /codingComposerLiveEdgeAfterAppend/);
  assert.doesNotMatch(scannedBody, /forceReveal\|\|pinned/);
  assert.match(scannedBody, /data-generative-ui-reply-form/);
  assert.match(scannedBody, /status\.textContent=&#39;Sending…&#39;|status\.textContent='Sending…'/);
  assert.match(scannedBody, /addEventListener\(&#39;beforeunload&#39;|addEventListener\('beforeunload'/);
  assert.doesNotMatch(scannedBody, /class="coding-submit-busy"/);
  const inlineScripts = [...scannedBody.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .filter((match) => !/\btype="(?:application\/json|importmap)"/u.test(match[0]))
    .map((match) => match[1] ?? "");
  assert.ok(inlineScripts.length > 0);
  inlineScripts.forEach((script, index) => {
    assert.doesNotThrow(() => new Function(script), `inline coding script ${index + 1} must parse`);
  });
  assert.match(scannedBody, /data-agent-detail-open/);
  assert.match(scannedBody, /addEventListener\('pointerdown'/);
  assert.match(scannedBody, /codingAgentPointerActive/);
  assert.match(scannedBody, /data-focus-key/);
  assert.match(scannedBody, /details\[data-details-key\]\[open\]/);
  assert.match(scannedBody, /detail\.open=true/);
  assert.doesNotMatch(scannedBody, /if\(form\)form\.addEventListener\('submit'/);
  assert.match(scannedBody, /Coding run progress/);
  assert.match(scannedBody, /--surface-canvas:#11120f/);
  assert.match(scannedBody, /--action-primary:#b9f67c/);
  assert.match(scannedBody, /roster\.coding\.disclosures\.v1/);
  assert.match(scannedBody, /details\[data-disclosure-key\]/);
  assert.match(scannedBody, /--font-ui:ui-sans-serif/);

  const enhancedScan = await app.request("/coding/workspace/scan", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      returnTo: `/coding?workspace=${new URL(scanDestination, "http://roster.local").searchParams.get("workspace")}&run=coding-active&job=job-active`,
      selectedAgent: "coding-agent-detail-workspace-quality",
    }).toString(),
  });
  assert.equal(enhancedScan.status, 202);
  const enhancedScanBody = await enhancedScan.json() as { readonly ok: boolean; readonly destination: string };
  assert.equal(enhancedScanBody.ok, true);
  assert.match(enhancedScanBody.destination, /run=workspace-rescan-/);
  assert.match(enhancedScanBody.destination, /job=coding-rescan-/);
  const refreshedBody = await (await app.request(enhancedScanBody.destination)).text();
  assert.match(refreshedBody, /Team rescan/);
  assert.match(refreshedBody, /Team rescan progress/);
  assert.match(refreshedBody, /Team profile refresh/);
  assert.doesNotMatch(refreshedBody, /Rescan this workspace repository and update the specialist team/);
  assert.match(refreshedBody, /data-coding-room-transcript/);
  const missingWorkspace = await app.request("/coding/workspace/scan", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "workspaceId=workspace_deadbeefdeadbeefdead",
  });
  assert.equal(missingWorkspace.status, 404);
  assert.deepEqual(await missingWorkspace.json(), {
    ok: false,
    error: "Coding workspace not found.",
  });
  assert.match(scannedBody, /\.coding-page>\.agent-top-nav\{display:none\}/);
  assert.doesNotMatch(scannedBody, /class="coding-titlebar-breadcrumb"/);
  assert.match(scannedBody, /font-synthesis:none/);
  assert.match(scannedBody, /--coding-rail-width:240px/);
  assert.doesNotMatch(scannedBody, /--workspace-inspector-width/);
  assert.match(scannedBody, /body\{min-width:0\}/);
  assert.doesNotMatch(scannedBody, /data-coding-agent-inspector/);
  assert.match(scannedBody, /coding-agent-detail-card/);
  assert.match(scannedBody, /const setRoomView=/);
  assert.match(scannedBody, /history\.pushState\(history\.state,''\,url\)/);
  assert.match(scannedBody, /addEventListener\('popstate'/);
  assert.match(scannedBody, /data-room-view="work"/);
  assert.match(scannedBody, /\.coding-page \.coding-inspector\[hidden\]\{display:none\}/);
  assert.match(scannedBody, /--agent-color:#c795ff/);
  assert.match(scannedBody, /\.coding-page \.coding-conversation\{position:relative;min-width:0;height:100%;display:grid;grid-template-columns:minmax\(0,1fr\) var\(--coding-workbench-width\);grid-template-rows:minmax\(0,1fr\) auto;overflow:hidden;border:0;border-radius:0/);
  assert.match(scannedBody, /\.coding-page \.coding-composer-wrap\{min-width:0;grid-column:1;grid-row:2\}/);
  assert.match(scannedBody, /\.coding-page \.coding-composer-grid\{width:100%;max-width:none;margin:0;grid-template-columns:minmax\(0,1fr\);gap:0\}/);
  assert.match(scannedBody, /\.coding-page \.coding-context-cast\[data-layout="rail"\]\{width:var\(--coding-workbench-width\);grid-column:2;grid-row:1\/-1;height:100%;display:block;overflow:hidden/);
  assert.match(scannedBody, /--coding-room-header-height:56px/);
  assert.match(scannedBody, /\.coding-page \.coding-conversation-scroll\{min-width:0;min-height:0;grid-column:1;grid-row:1;overflow:auto/);
  assert.match(scannedBody, /\.coding-page \.coding-workbench\{height:100dvh;min-height:0;display:grid;grid-template-columns:var\(--coding-rail-width\) minmax\(0,1fr\);padding:0/);
  assert.doesNotMatch(scannedBody, /calc\(\(100% - 980px\)\/2\)|max-width:980px/);
  assert.match(scannedBody, /\.coding-page \.coding-conversation::after\{display:none\}/);
  assert.match(scannedBody, /data-slot="context-cast"[^>]*aria-labelledby="coding-context-cast-title"[^>]*data-layout="rail"/);
  assert.match(scannedBody, /data-layout="rail" hidden/);
  assert.match(scannedBody, /aria-controls="coding-context-cast" aria-expanded="false"/);
  assert.match(scannedBody, /:root\[data-coding-context-cast="closed"\] \.coding-page \.coding-conversation\{grid-template-columns:minmax\(0,1fr\) 0\}/);
  assert.match(scannedBody, /\.coding-page \.coding-context-cast\[data-layout="rail"\]\{width:var\(--coding-workbench-width\);grid-column:2;grid-row:1\/-1;height:100%;display:block;overflow:hidden/);
  assert.match(scannedBody, /\.coding-page \.coding-context-cast\.coding-inspector\{grid-auto-rows:max-content;align-content:start;overscroll-behavior:contain\}/);
  assert.match(scannedBody, /\.coding-page \.coding-context-cast\[data-layout="rail"\]\{height:100%;max-height:100%\}/);
  assert.match(scannedBody, /\.coding-page \.coding-context-cast>\.coding-room-context-head\{position:sticky;z-index:5;top:-16px/);
  assert.match(scannedBody, /\.coding-page \.coding-context-cast \.coding-collaboration-frontier\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(scannedBody, /\.coding-page \.coding-sidebar-section>summary\{min-height:44px/);
  assert.match(scannedBody, /\.coding-page \.coding-sidebar-section-body\{padding:4px 12px 12px\}/);
  assert.match(scannedBody, /@media\(max-width:1179px\)\{\.coding-page \.coding-context-cast\[data-layout="rail"\]\{position:absolute;z-index:40/);
  assert.match(scannedBody, /\.coding-page \.agent-main\{width:100%;height:100dvh;min-height:0;padding:0/);
  assert.match(scannedBody, /@media\(max-width:899px\)\{:root\{--coding-rail-width:0px\}/);
  assert.match(scannedBody, /@media\(pointer:coarse\)/);
  assert.match(scannedBody, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(scannedBody, /@media\(max-width:899px\)\{[\s\S]*?\.coding-page \.coding-workbench\{grid-template-columns:minmax\(0,1fr\)/);
  assert.doesNotMatch(scannedBody, /--surface-canvas:#0c0f14/);
  assert.doesNotMatch(scannedBody, /coding-team-intro-message/);

  const response = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ objective: "Add a health endpoint and tests" }).toString(),
  });
  assert.equal(response.status, 303);
  assert.equal(enqueued.length, 2);
  assert.equal((enqueued[1]?.payload as { readonly kind?: string }).kind, "coding-agent.run");
  assert.equal(enqueued[1]?.singletonMode, "allow");
  assert.equal(enqueued[1]?.maxAttempts, 4);
  assert.equal((enqueued[1]?.payload as { readonly reviewPolicy?: string }).reviewPolicy, "auto");
  assert.equal((enqueued[1]?.payload as { readonly workerRuntime?: string }).workerRuntime, undefined);
  assert.equal((enqueued[1]?.payload as { readonly workerModel?: string }).workerModel, undefined);
  const workerExecution = (enqueued[1]?.payload as {
    readonly workerExecution?: {
      readonly schema?: string;
      readonly runtime?: string;
      readonly model?: string;
      readonly source?: string;
      readonly pi?: { readonly extensionPackages?: ReadonlyArray<string> };
    };
  }).workerExecution;
  assert.equal(workerExecution?.schema, "roster.coding-worker-execution.v1");
  assert.equal(workerExecution?.runtime, "pi-agent");
  assert.equal(workerExecution?.model, "openai-codex/gpt-5.6-luna");
  assert.equal(workerExecution?.source, "product-default");
  assert.deepEqual(workerExecution?.pi?.extensionPackages, ["@cortexkit/aft-pi"]);
  assert.match((enqueued[1]?.payload as { readonly branch?: string }).branch ?? "", /^roster\/rooms\/room_repository_coding_/);
  assert.match(response.headers.get("location") ?? "", /^\/coding\?workspace=workspace_[a-f0-9]{20}&run=coding_/);

  const retry = await app.request("/coding/runs/coding-failed/retry", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ jobId: failedRun.id }).toString(),
  });
  assert.equal(retry.status, 303);
  assert.match(retry.headers.get("location") ?? "", /run=coding-failed&job=coding_retry_/);
  assert.equal(enqueued.length, 3);
  const retryPayload = enqueued[2]?.payload as Readonly<Record<string, unknown>>;
  assert.equal(retryPayload.retryOfJobId, failedRun.id);
  assert.equal(retryPayload.conversationId, "coding-failed");
  assert.notEqual(retryPayload.runId, "coding-failed");
  assert.deepEqual(retryPayload.selectedNodeIds, ["workspace.implementation", "workspace.api"]);
  assert.equal(retryPayload.reviewPolicy, "reviewed");
  assert.equal(retryPayload.executionKind, "investigation", "retry must preserve the exhausted run's read-only mode");
  assert.deepEqual(retryPayload.workerExecution, failedRun.payload.workerExecution);
  assert.equal(retryPayload.workerRuntime, undefined);
  assert.equal(retryPayload.workerModel, undefined);

  const semanticRetry = await app.request("/coding/runs/coding-semantic-failed/retry", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ jobId: semanticFailedRun.id }).toString(),
  });
  assert.equal(semanticRetry.status, 303);
  assert.match(semanticRetry.headers.get("location") ?? "", /run=coding-semantic-failed&job=coding_retry_/);
  assert.equal(enqueued.length, 4);
  const semanticRetryPayload = enqueued[3]?.payload as Readonly<Record<string, unknown>>;
  assert.equal(semanticRetryPayload.retryOfJobId, semanticFailedRun.id);
  assert.notEqual(semanticRetryPayload.runId, "coding-semantic-failed");

  const workspaceId = codingRepositoryWorkspace(process.cwd()).id;
  const invalidSettings = await app.request("/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ workspaceId, workerRuntime: "unknown-runtime" }).toString(),
  });
  assert.equal(invalidSettings.status, 400);
  const missingSettingsWorkspace = await app.request("/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ workspaceId: "workspace_deadbeefdeadbeefdead", workerRuntime: "pi-agent" }).toString(),
  });
  assert.equal(missingSettingsWorkspace.status, 404);
  for (const workerRuntime of ["pi-agent", "pi-agent", "codex-cli", "claude-code", "hermes-agent", "pi-agent"] as const) {
    const savedSettings = await app.request("/coding/workspace/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        workspaceId,
        workerRuntime,
        codexModel: "gpt-5.6-terra",
        piModel: "openai-codex/gpt-5.6-sol",
        claudeModel: "opus",
        hermesModel: "default",
      }).toString(),
    });
    assert.equal(savedSettings.status, 303);
    assert.match(savedSettings.headers.get("location") ?? "", new RegExp(`^/coding\\?workspace=${workspaceId}&settingsSaved=[a-f0-9]{48}$`));
    if (workerRuntime === "pi-agent") {
      const confirmation = await (await app.request(savedSettings.headers.get("location") ?? "/coding")).text();
      assert.doesNotMatch(confirmation, /<details class="coding-menu coding-repository-menu"/);
    }
    if (workerRuntime === "claude-code") {
      const confirmation = await (await app.request(savedSettings.headers.get("location") ?? "/coding")).text();
      assert.match(confirmation, /data-coding-agent-node="workspace\.implementation"[\s\S]*?data-coding-agent="Claude Code" data-coding-model="Opus"/);
    }
  }
  assert.equal(workspaceSettingsWrites, 5);
  const settingsState = workspaceStates.get(CODING_WORKSPACE_CATALOG_STREAM);
  const settings = parseCodingWorkspaceSettings(
    settingsState
      ? orchestrationOutputValues(settingsState)[codingWorkspaceSettingsOutputKey(workspaceId)]
      : undefined,
    workspaceId,
  );
  assert.deepEqual(settings, {
    schema: "roster.coding-workspace-settings.v2",
    workspaceId,
    workerRuntime: "pi-agent",
    codexModel: "gpt-5.6-terra",
    piModel: "openai-codex/gpt-5.6-sol",
    claudeModel: "opus",
    hermesModel: "default",
    nodePreferences: [{
      nodeId: "workspace.implementation",
      workerRuntime: "pi-agent",
      codexModel: "gpt-5.6-terra",
      piModel: "openai-codex/gpt-5.6-sol",
      claudeModel: "opus",
      hermesModel: "default",
    }],
    revision: 5,
  });
  const piConfiguredBody = await (await app.request(`/coding?workspace=${workspaceId}`)).text();
  assert.match(piConfiguredBody, /data-coding-agent-node="workspace\.implementation"[\s\S]*?class="coding-project-agent-execution" data-coding-agent="Pi Code" data-coding-model="GPT-5\.6 Sol"/);

  const rescanFeedbackChange = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      objective: "Improve loading feedback for the Rescan team control while its bounded repository scan is running",
    }).toString(),
  });
  assert.equal(rescanFeedbackChange.status, 303);
  assert.equal(enqueued.length, 5);
  const feedbackExecution = (enqueued[4]?.payload as { readonly workerExecution?: CodingWorkerExecution }).workerExecution;
  assert.equal(feedbackExecution?.runtime, "pi-agent");
  assert.equal(feedbackExecution?.model, "openai-codex/gpt-5.6-sol");
  assert.equal((enqueued[4]?.payload as { readonly workerRuntime?: string }).workerRuntime, undefined);
  assert.equal((enqueued[4]?.payload as { readonly workerModel?: string }).workerModel, undefined);

  const terminalRoomPage = await app.request(
    `/coding?workspace=${workspaceId}&run=coding_previous_docs&job=previous-job`,
  );
  assert.equal(terminalRoomPage.status, 200);
  const terminalRoomComposer = (await terminalRoomPage.text())
    .match(/<form class="coding-composer"[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.match(terminalRoomComposer, /name="conversationId" value="coding_previous_docs"/);

  const continuedRoom = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      workspaceId,
      conversationId: "coding_previous_docs",
      objective: "continue",
    }).toString(),
  });
  assert.equal(continuedRoom.status, 303);
  assert.equal(enqueued.length, 6);
  const continuedPayload = enqueued[5]?.payload as Readonly<Record<string, unknown>>;
  assert.equal(continuedPayload.conversationId, "coding_previous_docs");
  assert.notEqual(continuedPayload.runId, "coding_previous_docs");
  assert.match(String(continuedPayload.runId), /^coding_/);
  assert.equal(continuedPayload.retryOfJobId, undefined);
  assert.match(
    continuedRoom.headers.get("location") ?? "",
    /^\/coding\?workspace=workspace_[a-f0-9]{20}&run=coding_previous_docs&job=coding-job-6$/,
  );
});

test("concurrent workspace runtime saves publish consecutive revisions and deduplicate identical choices", async () => {
  const settingsRuntime = createRuntime(
    memoryStore<OrchestrationEvent>(),
    memoryBranchStore(),
    (command: Parameters<CodingAgentRuntime["execute"]>[1]) => [command.event],
    reduceOrchestration,
    initialOrchestrationState,
  );
  const queue = {
    enqueue: async () => { throw new Error("not expected"); },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async () => undefined,
    listJobs: async () => [],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const app = new Hono();
  createCodingRoute({ runtime: settingsRuntime, queue }).register(app);
  const workspaceId = codingRepositoryWorkspace(process.cwd()).id;
  const save = (workerRuntime: "codex-cli" | "pi-agent") => app.request("/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ workspaceId, workerRuntime }).toString(),
  });

  const conflicting = await Promise.all([save("codex-cli"), save("pi-agent")]);
  assert.deepEqual(conflicting.map((response) => response.status), [303, 303]);
  let state = await settingsRuntime.state(CODING_WORKSPACE_CATALOG_STREAM);
  let settings = parseCodingWorkspaceSettings(
    orchestrationOutputValues(state)[codingWorkspaceSettingsOutputKey(workspaceId)],
    workspaceId,
  );
  assert.equal(settings?.revision, 2);
  const nextRuntime = settings?.workerRuntime === "pi-agent" ? "codex-cli" : "pi-agent";
  const identical = await Promise.all([save(nextRuntime), save(nextRuntime)]);
  assert.deepEqual(identical.map((response) => response.status), [303, 303]);
  state = await settingsRuntime.state(CODING_WORKSPACE_CATALOG_STREAM);
  settings = parseCodingWorkspaceSettings(
    orchestrationOutputValues(state)[codingWorkspaceSettingsOutputKey(workspaceId)],
    workspaceId,
  );
  assert.equal(settings?.revision, 3);
  assert.equal(settings?.workerRuntime, nextRuntime);
  const transitions = (await settingsRuntime.chain(CODING_WORKSPACE_CATALOG_STREAM))
    .filter((entry) => entry.body.type === "artifact.published" && entry.body.kind === "coding.workspace-settings");
  assert.deepEqual(transitions.map((entry) => parseCodingWorkspaceSettings(
    entry.body.type === "artifact.published" && entry.body.payload.storage === "inline"
      ? entry.body.payload.value
      : undefined,
    workspaceId,
  )?.revision), [1, 2, 3]);
});

test("workspace switcher adds, scans, and selects a different Git repository", async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "roster-coding-workspace-"));
  t.after(async () => rm(repositoryRoot, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repositoryRoot });
  await execFileAsync("git", ["config", "user.email", "roster@example.test"], { cwd: repositoryRoot });
  await execFileAsync("git", ["config", "user.name", "Roster Test"], { cwd: repositoryRoot });
  await writeFile(join(repositoryRoot, "README.md"), "# Other workspace\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "Initial"], { cwd: repositoryRoot });
  const canonicalRoot = await realpath(repositoryRoot);
  const workspace = codingRepositoryWorkspace(canonicalRoot);
  const crossWorkspaceConversationId = "coding-cross-workspace-completed";
  const chatOnlyConversationId = "coding-cross-workspace-chat";

  const states = new Map<string, OrchestrationState>([[
    codingRepositoryWorkspace(process.cwd()).profileStream,
    savedWorkspaceState(),
  ]]);
  const workspaceRuntime: CodingAgentRuntime = {
    ...runtime,
    execute: async (stream, command) => {
      states.set(stream, reduceOrchestration(states.get(stream) ?? initialOrchestrationState, command.event, Date.now()));
      return [command.event];
    },
    state: async (stream) => states.get(stream) ?? initialOrchestrationState,
  };
  const rescanJobs = new Map<string, QueueJob>();
  const queue = {
    enqueue: async (input: Parameters<AgentLoaderContext["queue"]["enqueue"]>[0]) => {
      const job: QueueJob = {
        id: input.jobId ?? "workspace-rescan-job",
        agentId: "coding-agent",
        lane: "collect",
        sessionKey: input.sessionKey,
        singletonMode: input.singletonMode,
        payload: input.payload,
        status: "queued",
        attempt: 0,
        maxAttempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        commands: [],
      };
      rescanJobs.set(job.id, job);
      return job;
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (jobId: string) => rescanJobs.get(jobId),
    listJobs: async () => [...rescanJobs.values()],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const app = new Hono();
  createCodingRoute({
    runtime: workspaceRuntime,
    queue,
    runtimeOptions: async () => DEFAULT_CODING_WORKER_RUNTIME_OPTIONS,
    rooms: {
      list: async (workspaceId) => workspaceId === workspace.id ? [{
        roomId: codingRepositoryRoomId(chatOnlyConversationId),
        conversationId: chatOnlyConversationId,
        codingWorkspaceId: workspace.id,
        streamId: `coding-room/${chatOnlyConversationId}`,
        title: "Chat-only room in the second workspace",
        state: "open",
        firstMessageId: "chat-only-first-message",
        messageCount: 1,
        createdAt: 1,
        updatedAt: 1,
      }] : [],
    },
  }).register(app);

  const invalidBrowse = await app.request("/coding/workspaces/browse?path=relative");
  assert.equal(invalidBrowse.status, 400);
  assert.match(await invalidBrowse.text(), /absolute folder/);

  const browsed = await app.request(`/coding/workspaces/browse?path=${encodeURIComponent(repositoryRoot)}`);
  assert.equal(browsed.status, 200);
  const directory = await browsed.json() as {
    readonly schema: string;
    readonly path: string;
    readonly gitRepository: boolean;
    readonly breadcrumbs: ReadonlyArray<{ readonly path: string }>;
  };
  assert.equal(directory.schema, "roster.coding-directory.v1");
  assert.equal(directory.path, await realpath(repositoryRoot));
  assert.equal(directory.gitRepository, true);
  assert.ok(directory.breadcrumbs.some((breadcrumb) => breadcrumb.path === directory.path));

  const relative = await app.request("/coding/workspaces", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ repositoryPath: "." }).toString(),
  });
  assert.equal(relative.status, 400);
  assert.match(await relative.text(), /absolute Git repository root/);

  const added = await app.request("/coding/workspaces", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ repositoryPath: repositoryRoot }).toString(),
  });
  assert.equal(added.status, 303);
  assert.equal(added.headers.get("location"), `/coding?workspace=${workspace.id}`);
  const enhancedAdd = await app.request("/coding/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ repositoryPath: repositoryRoot }).toString(),
  });
  assert.equal(enhancedAdd.status, 200);
  assert.deepEqual(await enhancedAdd.json(), {
    schema: "roster.coding-workspace-add.v1",
    ok: true,
    destination: `/coding?workspace=${workspace.id}`,
  });
  const catalogState = states.get(CODING_WORKSPACE_CATALOG_STREAM);
  assert.ok(catalogState?.outputs[`workspace:${workspace.id}`]);
  const savedEntry = parseCodingRepositoryWorkspace(
    catalogState ? orchestrationOutputValues(catalogState)[`workspace:${workspace.id}`] : undefined,
  );
  assert.ok(savedEntry);
  assert.match(savedEntry.profileStream, /\/revisions\/[a-f0-9]{32}$/);
  assert.ok(states.get(savedEntry.profileStream)?.outputs[CODING_WORKSPACE_PROFILE_OUTPUT]);

  const savedRuntime = await app.request("/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ workspaceId: workspace.id, workerRuntime: "pi-agent" }).toString(),
  });
  assert.equal(savedRuntime.status, 303);
  const settingsState = states.get(CODING_WORKSPACE_CATALOG_STREAM);
  assert.equal(parseCodingWorkspaceSettings(
    settingsState
      ? orchestrationOutputValues(settingsState)[codingWorkspaceSettingsOutputKey(workspace.id)]
      : undefined,
    workspace.id,
  )?.workerRuntime, "pi-agent");

  const invalidSettingsMedia = await app.request("/api/v2/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(invalidSettingsMedia.status, 415);
  const apiSettings = await app.request("/api/v2/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: workspace.id,
      nodeId: "workspace.implementation",
      workerRuntime: "codex-cli",
      codexModel: "gpt-5.6-luna",
      piModel: "openai-codex/gpt-5.6-luna",
    }),
  });
  assert.equal(apiSettings.status, 200);
  assert.equal(apiSettings.headers.get("cache-control"), "no-store");
  const apiSettingsBody = await apiSettings.json() as {
    readonly schema: string;
    readonly selectedModel: string;
    readonly settings: { readonly workerRuntime: string };
  };
  assert.equal(apiSettingsBody.schema, "roster.coding.v2");
  assert.equal(apiSettingsBody.settings.workerRuntime, "codex-cli");
  assert.equal(apiSettingsBody.selectedModel, "gpt-5.6-luna");
  const restoredSettings = await app.request("/api/v2/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: workspace.id,
      nodeId: "workspace.implementation",
      workerRuntime: "pi-agent",
      codexModel: "gpt-5.6-luna",
      piModel: "openai-codex/gpt-5.6-luna",
    }),
  });
  assert.equal(restoredSettings.status, 200);

  const page = await app.request(added.headers.get("location") ?? "/coding");
  const body = await page.text();
  assert.equal(page.status, 200);
  assert.match(body, new RegExp(`Switch workspace, ${repositoryRoot.split("/").at(-1)} selected`));
  assert.match(body, new RegExp(canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(body, new RegExp(process.cwd().split(/[\\/]/).at(-1) ?? "repository"));
  assert.match(body, new RegExp(`/coding\\?workspace=${workspace.id}`));
  assert.match(body, /Saved team/);
  const defaultWorkspaceBody = await (await app.request(`/coding?workspace=${codingRepositoryWorkspace(process.cwd()).id}`)).text();

  const crossWorkspaceExecutionId = "coding-cross-workspace-execution";
  const crossWorkspaceJob: QueueJob = {
    id: "cross-workspace-completed-job",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.run",
      runId: crossWorkspaceExecutionId,
      conversationId: crossWorkspaceConversationId,
      codingWorkspaceId: workspace.id,
      workingDirectory: canonicalRoot,
      objective: "Inspect the second workspace",
      executionKind: "investigation",
      workerExecution: testWorkerExecution(),
    },
    status: "completed",
    attempt: 1,
    maxAttempts: 2,
    createdAt: 20,
    updatedAt: 30,
    result: { noChanges: true },
    commands: [],
  };
  rescanJobs.set(crossWorkspaceJob.id, crossWorkspaceJob);
  states.set(`agents/coding-agent/runs/${crossWorkspaceExecutionId}`, {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph(crossWorkspaceExecutionId, [{
      taskId: "synthesize-investigation",
      nodeId: "workspace.implementation",
      capability: "investigate",
      status: "accepted",
    }]),
  });
  const unscopedCompleted = await app.request(
    `/coding?run=${crossWorkspaceConversationId}&draft=${encodeURIComponent("keep this draft")}`,
  );
  assert.equal(unscopedCompleted.status, 302);
  const canonicalCompletedLocation = unscopedCompleted.headers.get("location") ?? "";
  const canonicalCompletedUrl = new URL(canonicalCompletedLocation, "http://roster.local");
  assert.equal(canonicalCompletedUrl.searchParams.get("workspace"), workspace.id);
  assert.equal(canonicalCompletedUrl.searchParams.get("run"), crossWorkspaceConversationId);
  assert.equal(canonicalCompletedUrl.searchParams.get("job"), crossWorkspaceJob.id);
  assert.equal(canonicalCompletedUrl.searchParams.get("draft"), "keep this draft");
  const canonicalCompletedPage = await app.request(canonicalCompletedLocation);
  assert.equal(canonicalCompletedPage.status, 200);
  const canonicalCompletedBody = await canonicalCompletedPage.text();
  assert.match(canonicalCompletedBody, /data-run-presentation-label>Complete</);
  assert.doesNotMatch(canonicalCompletedBody, /Finalizing delivery/);
  assert.equal((await app.request(
    `/coding?workspace=${codingRepositoryWorkspace(process.cwd()).id}&run=${crossWorkspaceConversationId}`,
  )).status, 404, "an explicitly wrong workspace must fail closed instead of projecting another room");

  const unscopedChatOnly = await app.request(`/coding?run=${chatOnlyConversationId}`);
  assert.equal(unscopedChatOnly.status, 302);
  const canonicalChatOnlyUrl = new URL(unscopedChatOnly.headers.get("location") ?? "", "http://roster.local");
  assert.equal(canonicalChatOnlyUrl.searchParams.get("workspace"), workspace.id);
  assert.equal(canonicalChatOnlyUrl.searchParams.get("run"), chatOnlyConversationId);
  assert.equal(canonicalChatOnlyUrl.searchParams.has("job"), false);

  const trackedRescan = await app.request("/coding/workspace/scan", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ workspaceId: workspace.id }).toString(),
  });
  assert.equal(trackedRescan.status, 303);
  assert.match(trackedRescan.headers.get("location") ?? "", /run=workspace-rescan-.*job=coding-rescan-/);
  const concurrentRescan = await app.request("/coding/workspace/scan", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ workspaceId: workspace.id }).toString(),
  });
  assert.equal(concurrentRescan.status, 409);
  assert.match(await concurrentRescan.text(), /team rescan is already active/i);
});

test("trivial repository facts stay conversational while substantive questions launch read-only investigations", async () => {
  const events = new Map<string, OrchestrationEvent[]>();
  const states = new Map<string, OrchestrationState>([[
    codingRepositoryWorkspace(process.cwd()).profileStream,
    savedWorkspaceState(),
  ]]);
  const conversationRuntime: CodingAgentRuntime = {
    ...runtime,
    execute: async (stream, command) => {
      const timestamp = Date.now();
      states.set(stream, reduceOrchestration(states.get(stream) ?? initialOrchestrationState, command.event, timestamp));
      events.set(stream, [...(events.get(stream) ?? []), command.event]);
      return [command.event];
    },
    state: async (stream) => states.get(stream) ?? initialOrchestrationState,
    chain: async (stream) => (events.get(stream) ?? []).map((event, index) => ({
      id: `receipt-${index}`,
      ts: 10 + index,
      stream,
      hash: `hash-${index}`,
      body: event,
    })),
  };
  let enqueueCount = 0;
  let rescanJob: QueueJob | undefined;
  const queue = {
    enqueue: async (input: Parameters<AgentLoaderContext["queue"]["enqueue"]>[0]) => {
      enqueueCount += 1;
      rescanJob = {
        id: input.jobId ?? "rescan-job",
        agentId: "coding-agent",
        lane: "collect",
        sessionKey: input.sessionKey,
        singletonMode: input.singletonMode,
        payload: input.payload,
        status: "queued",
        attempt: 0,
        maxAttempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        commands: [],
      };
      return rescanJob;
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (jobId: string) => rescanJob?.id === jobId ? rescanJob : undefined,
    listJobs: async () => rescanJob ? [rescanJob] : [],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  let socialPlannerCalls = 0;
  let conversationalAnswererCalls = 0;
  const conversationalResponderIds: string[] = [];
  let enrichedRepositoryContext: CodingConversationRepositoryContext | undefined;
  const app = new Hono();
  createCodingRoute({
    runtime: conversationRuntime,
    queue,
    repositoryContext: async () => ({
      repositoryName: "theorem",
      currentBranch: "codex/coding-run-branches",
      headCommit: "abc123",
      workingTree: "clean",
    }),
    conversationPlanner: async ({ repositoryContext, messages, workspaceNodes }) => {
      enrichedRepositoryContext = repositoryContext;
      if (messages.at(-1)?.text === "Explain billing deeply from the actual repository") {
        const primary = workspaceNodes.find((node) => node.capabilities.includes("implement"));
        const reviewer = workspaceNodes.find((node) => node.capabilities.includes("review"));
        assert.ok(primary);
        assert.ok(reviewer);
        return {
          disposition: "investigating",
          selectedNodeIds: [primary.id, reviewer.id],
          primaryNodeId: primary.id,
          coordination: { reviewMode: "reviewed", validationScope: "focused" },
          tags: ["intent:investigation"],
          questions: [],
          rationale: "The answer requires repository evidence.",
          confidence: 1,
        };
      }
      if (messages.at(-1)?.text === "Can you restart this local server and refresh my browser?") {
        return {
          disposition: "operational",
          selectedNodeIds: [],
          tags: ["intent:operational"],
          questions: [],
          answer: "This room cannot control the host process or refresh your browser, so no repository run was started.",
          rationale: "The request targets host and browser operations rather than tracked repository content.",
          confidence: 1,
        };
      }
      if (messages.at(-1)?.text === "introduce yourself") {
        socialPlannerCalls += 1;
        return {
          disposition: "informational",
          selectedNodeIds: [],
          tags: ["intent:social"],
          questions: [],
          answer: "The workspace team can answer this conversationally.",
          rationale: `Introductions are ordinary conversation across ${workspaceNodes.length} saved nodes.`,
          confidence: 1,
        };
      }
      if (messages.at(-1)?.text === "introduce the team one by one") {
        return {
          disposition: "informational",
          selectedNodeIds: ["workspace.quality", "workspace.implementation"],
          tags: ["intent:social", "routing:participants"],
          questions: [],
          answer: "I’ll let each teammate introduce themselves.",
          rationale: "The human asked the saved teammates to answer individually in the room.",
          confidence: 1,
        };
      }
      return {
        disposition: "informational",
        selectedNodeIds: [],
        tags: ["intent:question"],
        questions: [],
        answer: `You are on \`${repositoryContext.currentBranch}\`.`,
        rationale: "Answered from the bounded read-only repository context.",
        confidence: 1,
      };
    },
    conversationAnswerer: async ({ repositoryContext, messages, responder, onDelta }) => {
      conversationalAnswererCalls += 1;
      if (responder) conversationalResponderIds.push(responder.id);
      const latestText = messages.at(-1)?.text;
      const parts = latestText === "introduce the team one by one" && responder?.id === "workspace.quality"
        ? ["I’m Mira. I review changes independently and look for correctness and regressions."]
        : latestText === "introduce the team one by one" && responder?.id === "workspace.implementation"
          ? ["I’m Kai. I implement repository changes and validate the result before handoff."]
      : latestText === "introduce yourself"
        ? [
            "This is your repository team. ",
            "Kai handles implementation and Mira reviews quality; they coordinate here by sharing context and handing work across specialties.",
          ]
        : latestText === "@mira say hello"
          ? ["Hello! How can I help?"]
          : latestText === "@mira tag kai and ask him to introduce himself"
            ? ["@Kai, please introduce yourself to @You."]
            : messages.at(-1)?.author.kind === "agent" && latestText === "@Kai, please introduce yourself to @You."
              ? ["Hi @Mira and @You! I’m Kai, and I handle implementation and repository changes."]
        : ["You are on ", `\`${repositoryContext.currentBranch}\`.`];
      for (const part of parts) await onDelta?.(part);
      return parts.join("");
    },
    conversationModel: "gpt-5.6-luna",
  }).register(app);

  const operational = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      objective: "Can you restart this local server and refresh my browser?",
    }).toString(),
  });
  assert.equal(operational.status, 303);
  assert.equal(enqueueCount, 0, "host operations cannot enqueue a repository graph");
  assert.doesNotMatch(operational.headers.get("location") ?? "", /job=/);
  const operationalPage = await app.request(operational.headers.get("location") ?? "/coding");
  const operationalBody = await operationalPage.text();
  assert.match(operationalBody, /data-author-node-id="coordinator"/);
  assert.match(operationalBody, /cannot control the host process or refresh your browser/);
  const operationalFeed = operationalBody.match(/<ol class="coding-thread coding-timeline"[\s\S]*?<\/ol>/)?.[0] ?? "";
  assert.doesNotMatch(operationalFeed, /data-coding-run-progress|This crosses specialties/);

  const social = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ objective: "introduce yourself" }).toString(),
  });
  assert.equal(social.status, 303);
  assert.equal(socialPlannerCalls, 1, "the semantic planner classifies ordinary conversation");
  assert.equal(conversationalAnswererCalls, 1, "the conversational model answers without a hardcoded phrase template");
  assert.equal(typeof enrichedRepositoryContext?.fileCount, "number");
  assert.equal(typeof enrichedRepositoryContext?.filesTruncated, "boolean");
  assert.ok(Array.isArray(enrichedRepositoryContext?.technologies));
  assert.ok(Array.isArray(enrichedRepositoryContext?.toolchains));
  assert.ok(Array.isArray(enrichedRepositoryContext?.topLevelAreas));
  assert.equal(enqueueCount, 0);
  assert.doesNotMatch(social.headers.get("location") ?? "", /job=/);
  const socialPage = await app.request(social.headers.get("location") ?? "/coding");
  const socialBody = await socialPage.text();
  assert.match(socialBody, /This is your repository team\./);
  assert.match(socialBody, /they coordinate here by sharing context/i);
  assert.match(socialBody, /data-coding-social-row[^>]*data-author-node-id="coordinator"/);
  assert.doesNotMatch(socialBody, /I’m Roster|Collaboration Facilitator/);
  assert.doesNotMatch(socialBody, /Implementation Report|Work Activity|Coding run progress/);

  const teamIntroduction = await app.request("/coding/run", {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ objective: "introduce the team one by one" }).toString(),
  });
  assert.equal(teamIntroduction.status, 200);
  assert.equal(enqueueCount, 0, "a conversational team response must not create a coding job");
  const teamIntroductionStream = await teamIntroduction.text();
  assert.match(teamIntroductionStream, /"type":"delta","delta":"I’m Mira\.[^"]+","author":\{"id":"workspace\.quality"/);
  assert.match(teamIntroductionStream, /"type":"delta","delta":"I’m Kai\.[^"]+","author":\{"id":"workspace\.implementation"/);
  const teamIntroductionUpdates = teamIntroductionStream.trim().split("\n")
    .map((line) => JSON.parse(line) as {
      readonly type: string;
      readonly location?: string;
      readonly author?: { readonly id?: string };
    });
  assert.deepEqual(
    teamIntroductionUpdates
      .filter((entry) => entry.type === "delta" && entry.author?.id)
      .map((entry) => entry.author?.id),
    ["workspace.quality", "workspace.implementation"],
    "selected saved participants stream one by one in the model-planned order",
  );
  const teamIntroductionResult = teamIntroductionUpdates
    .findLast((entry) => entry.type === "result");
  const teamIntroductionPage = await app.request(teamIntroductionResult?.location ?? "/coding");
  const teamIntroductionBody = await teamIntroductionPage.text();
  assert.match(teamIntroductionBody, /data-coding-social-row[^>]*data-author-node-id="workspace\.quality"[\s\S]*?I’m Mira\. I review changes independently/);
  assert.match(teamIntroductionBody, /data-coding-social-row[^>]*data-author-node-id="workspace\.implementation"[\s\S]*?I’m Kai\. I implement repository changes/);
  assert.ok(
    teamIntroductionBody.indexOf("I’m Mira. I review changes independently")
      < teamIntroductionBody.indexOf("I’m Kai. I implement repository changes"),
    "selected saved participants answer one by one in the model-planned order",
  );

  const mentioned = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ objective: "@mira say hello" }).toString(),
  });
  assert.equal(mentioned.status, 303);
  assert.deepEqual(conversationalResponderIds, [
    "workspace.quality",
    "workspace.implementation",
    "workspace.quality",
  ]);
  assert.equal(enqueueCount, 0);
  const mentionedPage = await app.request(mentioned.headers.get("location") ?? "/coding");
  const mentionedBody = await mentionedPage.text();
  assert.match(mentionedBody, /data-coding-social-row[^>]*data-author-node-id="workspace\.quality"[\s\S]*?<strong>Mira<\/strong><span class="coding-agent-role">Quality Reviewer<\/span>/);
  assert.match(mentionedBody, /Hello! How can I help\?/);
  assert.doesNotMatch(mentionedBody, /<strong>Roster<\/strong>[\s\S]*?Hello! How can I help\?/);
  assert.match(mentionedBody, /Mira answered directly; no branch or execution lease was created/);
  assert.equal(
    (mentionedBody.match(/applyAssistantAuthor\(assistant,update\.author\)/g) ?? []).length,
    2,
    "both streamed deltas and result-only answers must replace Roster's optimistic identity",
  );

  const handedOff = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      objective: "@mira tag kai and ask him to introduce himself",
      externalId: "ui_peer_handoff_stable",
    }).toString(),
  });
  assert.equal(handedOff.status, 303);
  assert.deepEqual(conversationalResponderIds, [
    "workspace.quality",
    "workspace.implementation",
    "workspace.quality",
    "workspace.quality",
    "workspace.implementation",
  ]);
  assert.equal(enqueueCount, 0);
  const handedOffPage = await app.request(handedOff.headers.get("location") ?? "/coding");
  const handedOffBody = await handedOffPage.text();
  assert.match(handedOffBody, /data-coding-social-row[^>]*data-author-node-id="workspace\.quality"[\s\S]*?@Kai, please introduce yourself to @You\./);
  assert.match(handedOffBody, /data-coding-social-row[^>]*data-author-node-id="workspace\.implementation"[\s\S]*?I’m Kai, and I handle implementation and repository changes\./);
  assert.match(handedOffBody, /class="coding-message-recipients"[^>]*>[\s\S]*?@Mira[\s\S]*?@You/);
  const handedOffUrl = new URL(handedOff.headers.get("location") ?? "/coding", "http://roster.local");
  const handedOffConversationId = handedOffUrl.searchParams.get("run") ?? "";
  const handedOffRetry = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      objective: "@mira tag kai and ask him to introduce himself",
      conversationId: handedOffConversationId,
      externalId: "ui_peer_handoff_stable",
    }).toString(),
  });
  assert.equal(handedOffRetry.status, 303, await handedOffRetry.text());
  assert.equal(conversationalAnswererCalls, 7, "the durable peer reply is not regenerated on transport retry");

  const localPlannerOnlyApp = new Hono();
  let localPlannerOnlyCalls = 0;
  createCodingRoute({
    runtime: conversationRuntime,
    queue,
    repositoryContext: async () => ({
      repositoryName: "theorem",
      currentBranch: "codex/coding-run-branches",
      headCommit: "abc123",
      workingTree: "clean",
    }),
    conversationPlanner: async ({ messages, onDelta }) => {
      localPlannerOnlyCalls += 1;
      const latest = messages.at(-1);
      if (latest?.text === "stream a local answer") {
        await onDelta?.("Local runtime ");
        await onDelta?.("answer streamed.");
        return {
          disposition: "informational",
          selectedNodeIds: [],
          tags: ["intent:question"],
          questions: [],
          answer: "Local runtime answer streamed.",
          rationale: "This answer is process-local until the route is validated.",
          confidence: 1,
        };
      }
      return {
        disposition: "informational",
        selectedNodeIds: [],
        tags: ["intent:social"],
        questions: [],
        answer: latest?.author.kind === "agent"
          ? "Hi @Mira and @You! I’m Kai, and I handle implementation."
          : "@Kai, please introduce yourself to @You.",
        rationale: "This is one bounded room conversation handoff.",
        confidence: 1,
      };
    },
    conversationModel: "openai-codex/gpt-5.6-luna",
  }).register(localPlannerOnlyApp);
  const localPlannerOnly = await localPlannerOnlyApp.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ objective: "@mira ask kai to introduce himself" }).toString(),
  });
  assert.equal(localPlannerOnly.status, 303, await localPlannerOnly.text());
  assert.equal(localPlannerOnlyCalls, 2, "local CLI mode routes the direct reply and one peer reply");
  const localPlannerOnlyPage = await localPlannerOnlyApp.request(
    localPlannerOnly.headers.get("location") ?? "/coding",
  );
  const localPlannerOnlyBody = await localPlannerOnlyPage.text();
  assert.match(localPlannerOnlyBody, /data-coding-social-row[^>]*data-author-node-id="workspace\.quality"[\s\S]*?@Kai, please introduce yourself to @You\./);
  assert.match(localPlannerOnlyBody, /data-coding-social-row[^>]*data-author-node-id="workspace\.implementation"[\s\S]*?I’m Kai, and I handle implementation\./);

  const localPlannerStream = await localPlannerOnlyApp.request("/coding/run", {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ objective: "stream a local answer" }).toString(),
  });
  assert.equal(localPlannerStream.status, 200);
  const localPlannerStreamBody = await localPlannerStream.text();
  assert.match(localPlannerStreamBody, /"type":"delta","delta":"Local runtime "/);
  assert.match(localPlannerStreamBody, /"type":"delta","delta":"answer streamed\."/);
  assert.ok(
    localPlannerStreamBody.indexOf('"delta":"Local runtime "')
      < localPlannerStreamBody.indexOf('"type":"result"'),
  );

  const response = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ objective: "what branch are you on" }).toString(),
  });
  assert.equal(response.status, 303);
  assert.equal(enqueueCount, 0);
  const location = response.headers.get("location") ?? "";
  assert.match(location, /^\/coding\?workspace=workspace_[a-f0-9]{20}&run=coding_/);
  assert.doesNotMatch(location, /job=/);

  const page = await app.request(location);
  const body = await page.text();
  assert.match(body, /You are on <code>codex\/coding-run-branches<\/code>\./);
  assert.match(body, /Answered/);
  assert.match(body, /No execution needed/);
  assert.match(body, /Conversation answer · no branch or worker created/);
  assert.match(body, /The repository room stays open/);
  assert.match(body, /Routing: GPT-5\.6 Luna/);
  assert.equal(conversationalAnswererCalls, 8);
  assert.doesNotMatch(body, /Needs your answer/);
  assert.doesNotMatch(body, /I need one detail before I create a branch/);
  assert.doesNotMatch(body, /Coding run progress/);
  assert.doesNotMatch(body, /<li class="coding-run-progress"/);

  const implementationReview = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      objective: "Review the Comfy agent implementation in this repository and create documentation",
    }).toString(),
  });
  assert.equal(implementationReview.status, 303);
  const implementationReviewPage = await app.request(implementationReview.headers.get("location") ?? "/coding");
  const implementationReviewBody = await implementationReviewPage.text();
  assert.match(implementationReviewBody, /You are on <code>codex\/coding-run-branches<\/code>\./);
  assert.doesNotMatch(implementationReviewBody, /saved a new tailored team/);

  const conversationalRescan = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ objective: "Scan this repo thoroughly and create proper agents" }).toString(),
  });
  assert.equal(conversationalRescan.status, 303);
  assert.equal(enqueueCount, 0, "conversation text is interpreted by the planner, not a rescan phrase matcher");
  assert.doesNotMatch(conversationalRescan.headers.get("location") ?? "", /job=/);

  const rescanned = await app.request("/coding/workspace/scan", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      workspaceId: codingRepositoryWorkspace(process.cwd()).id,
      requestId: "rescan-request-one",
    }).toString(),
  });
  assert.equal(rescanned.status, 303);
  assert.equal(enqueueCount, 1);
  const rescanLocation = rescanned.headers.get("location") ?? "";
  assert.match(rescanLocation, /job=coding-rescan-/);
  const rescanPage = await app.request(rescanLocation);
  const rescanBody = await rescanPage.text();
  assert.match(rescanBody, /Rescan this workspace repository and update the specialist team/);
  assert.match(rescanBody, /Team rescan/);
  assert.match(rescanBody, /Working/);
  assert.doesNotMatch(rescanBody, /Integrate into/);
  const conflictingWorkspaceRescan = await app.request("/coding/workspace/scan", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      workspaceId: codingRepositoryWorkspace(process.cwd()).id,
      requestId: "rescan-request-two",
    }).toString(),
  });
  assert.equal(conflictingWorkspaceRescan.status, 409);
  assert.equal(conflictingWorkspaceRescan.headers.get("location"), rescanLocation);
  assert.match(await conflictingWorkspaceRescan.text(), /team rescan is already active/i);

  const streamed = await app.request("/coding/run", {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ objective: "@mira say hello" }).toString(),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.equal(streamed.headers.get("x-accel-buffering"), "no");
  const streamBody = await streamed.text();
  assert.match(streamBody, /"type":"accepted"/);
  assert.match(streamBody, /"model":"gpt-5\.6-luna"/);
  assert.match(streamBody, /"type":"progress","stage":"routing"/);
  assert.ok(streamBody.indexOf('"type":"accepted"') < streamBody.indexOf('"type":"progress"'));
  assert.ok(streamBody.indexOf('"type":"progress"') < streamBody.indexOf('"type":"delta"'));
  assert.match(
    streamBody,
    /"type":"delta","delta":"Hello! How can I help\?","author":\{"id":"workspace\.quality","name":"Mira","role":"Quality Reviewer"\}/,
  );
  assert.match(streamBody, /"type":"result","disposition":"informational"/);
  assert.match(streamBody, /"location":"\/coding\?workspace=workspace_[a-f0-9]{20}&run=coding_/);
  assert.equal(enqueueCount, 1);

  const investigation = await app.request("/coding/run", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      objective: "Explain billing deeply from the actual repository",
    }).toString(),
  });
  assert.equal(investigation.status, 303);
  assert.equal(enqueueCount, 2, "substantive repository research must enqueue a durable investigation");
  assert.match(investigation.headers.get("location") ?? "", /job=/);
  assert.equal(rescanJob?.payload.executionKind, "investigation");
  assert.match(String(rescanJob?.payload.branch), /^roster\/rooms\//, "read-only investigation must use the room branch frontier");
  assert.equal(rescanJob?.payload.primaryNodeId, "workspace.implementation");

  const investigationUrl = new URL(investigation.headers.get("location") ?? "", "http://roster.local");
  const activeDirectReply = await app.request("/coding/run", {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      objective: "@mira say hello while this run is active",
      conversationId: investigationUrl.searchParams.get("run") ?? "",
      workspaceId: codingRepositoryWorkspace(process.cwd()).id,
    }).toString(),
  });
  assert.equal(activeDirectReply.status, 200);
  const activeDirectReplyBody = await activeDirectReply.text();
  assert.doesNotMatch(activeDirectReplyBody, /"type":"delta"/, "active-run planner answers may complete without deltas");
  assert.match(
    activeDirectReplyBody,
    /"type":"result","disposition":"informational"[\s\S]*"author":\{"id":"workspace\.quality","name":"Mira","role":"Quality Reviewer"\}/,
  );
  assert.match(activeDirectReplyBody, /"answer":"You are on `codex\/coding-run-branches`\."/);
});

test("coding conversation asks before enqueueing and starts exactly once after the answer", async () => {
  const events = new Map<string, OrchestrationEvent[]>();
  const states = new Map<string, OrchestrationState>([[
    codingRepositoryWorkspace(process.cwd()).profileStream,
    savedWorkspaceState(),
  ]]);
  const conversationRuntime: CodingAgentRuntime = {
    ...runtime,
    execute: async (stream, command) => {
      const nextState = reduceOrchestration(states.get(stream) ?? initialOrchestrationState, command.event, Date.now());
      states.set(stream, nextState);
      events.set(stream, [...(events.get(stream) ?? []), command.event]);
      return [command.event];
    },
    state: async (stream) => states.get(stream) ?? initialOrchestrationState,
    chain: async (stream) => (events.get(stream) ?? []).map((event, index) => ({
      id: `receipt-${index}`,
      stream,
      sequence: index + 1,
      timestamp: 10 + index,
      hash: `hash-${index}`,
      previousHash: index ? `hash-${index - 1}` : "",
      body: event,
    })),
  };
  const jobs = new Map<string, QueueJob>();
  let enqueueCount = 0;
  const queue = {
    enqueue: async (input: Parameters<AgentLoaderContext["queue"]["enqueue"]>[0]) => {
      enqueueCount += 1;
      const job: QueueJob = {
        id: `conversation-job-${enqueueCount}`,
        agentId: input.agentId,
        lane: input.lane ?? "collect",
        payload: input.payload,
        status: "queued",
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 1,
        createdAt: 20,
        updatedAt: 20,
        commands: [],
      };
      jobs.set(job.id, job);
      return job;
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (id: string) => jobs.get(id),
    listJobs: async () => [...jobs.values()],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  let plannerCalls = 0;
  let continuationContext: unknown;
  const app = new Hono();
  createCodingRoute({
    runtime: conversationRuntime,
    queue,
    conversationPlanner: async ({ workspaceNodes, collaborationContext }) => {
      plannerCalls += 1;
      if (collaborationContext) continuationContext = collaborationContext;
      return plannerCalls === 1
        ? {
            disposition: "needs_clarification",
            selectedNodeIds: ["human.operator"],
            tags: ["intent:clarification"],
            questions: ["Should the public API remain backward compatible?"],
            rationale: "Compatibility changes the implementation contract.",
            confidence: 0.9,
          }
        : {
            disposition: "ready",
            selectedNodeIds: workspaceNodes
              .filter((node) => ["workspace.implementation", "workspace.api"].includes(node.id))
              .map((node) => node.id),
            primaryNodeId: "workspace.implementation",
            coordination: { reviewMode: "reviewed", validationScope: "focused" },
            tags: ["domain:api"],
            questions: [],
            rationale: "The answer makes the change actionable.",
            confidence: 0.95,
          };
    },
  }).register(app);

  const started = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Change the public API" }),
  });
  assert.equal(started.status, 200);
  const startedBody = await started.json() as {
    readonly conversationId: string;
    readonly disposition: string;
    readonly route: { readonly questions: ReadonlyArray<string>; readonly selectedNodeIds: ReadonlyArray<string> };
    readonly job: unknown;
  };
  assert.equal(startedBody.disposition, "needs_clarification");
  assert.deepEqual(startedBody.route.questions, ["Should the public API remain backward compatible?"]);
  assert.deepEqual(startedBody.route.selectedNodeIds, ["human.operator"]);
  assert.equal(startedBody.job, null);
  assert.equal(enqueueCount, 0);
  const waitingPage = await app.request(`/coding?run=${startedBody.conversationId}`);
  const waitingBody = await waitingPage.text();
  assert.match(waitingBody, /Needs your answer/);
  assert.match(waitingBody, /Should the public API remain backward compatible/);
  assert.match(waitingBody, /Human action/);
  assert.match(waitingBody, /Roster needs a bounded product decision before work can start\./);
  assert.doesNotMatch(waitingBody, /Compatibility changes the implementation contract\./);
  assert.match(waitingBody, /data-coding-human-reply aria-controls="coding-objective">Reply/);
  assert.doesNotMatch(waitingBody, /I need one detail before I create a branch or start an agent/);
  assert.match(waitingBody, /The team is waiting for your answer/);
  assert.match(waitingBody, /Reply in #repository-room/);

  const workspaceId = codingRepositoryWorkspace(process.cwd()).id;
  const savedApiRuntime = await app.request("/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      workspaceId,
      nodeId: "workspace.implementation",
      workerRuntime: "pi-agent",
      codexModel: "gpt-5.6-sol",
      piModel: "openai-codex/gpt-5.6-terra",
    }).toString(),
  });
  assert.equal(savedApiRuntime.status, 303);

  const answered = await app.request(`/api/v2/coding/runs/${startedBody.conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Yes, preserve backward compatibility." }),
  });
  assert.equal(answered.status, 202);
  const answeredBody = await answered.json() as {
    readonly disposition: string;
    readonly job: { readonly id: string };
  };
  assert.equal(answeredBody.disposition, "ready");
  assert.equal(answeredBody.job.id, "conversation-job-1");
  assert.equal(enqueueCount, 1);
  const enqueued = jobs.get("conversation-job-1");
  assert.equal(enqueued?.payload.runId, startedBody.conversationId);
  assert.equal(enqueued?.payload.conversationId, startedBody.conversationId);
  assert.deepEqual(enqueued?.payload.selectedNodeIds, ["workspace.api", "workspace.implementation"]);
  assert.equal(enqueued?.payload.primaryNodeId, "workspace.implementation");
  assert.deepEqual(enqueued?.payload.coordination, {
    reviewMode: "reviewed",
    validationScope: "focused",
  });
  assert.equal((enqueued?.payload.workerExecution as CodingWorkerExecution | undefined)?.runtime, "pi-agent");
  assert.equal((enqueued?.payload.workerExecution as CodingWorkerExecution | undefined)?.model, "openai-codex/gpt-5.6-terra");
  assert.equal(enqueued?.payload.workerRuntime, undefined);
  assert.equal(enqueued?.payload.workerModel, undefined);
  assert.match(String(enqueued?.payload.objective), /Follow-up 1: Yes, preserve backward compatibility/);

  jobs.set(enqueued!.id, { ...enqueued!, status: "failed", lastError: "human context required", updatedAt: 30 });
  const ambiguity = inlineArtifactPublishedEvent({
    runId: startedBody.conversationId,
    artifactId: "artifact-human-escalation",
    origin: "input",
    outputKey: "collaboration_resolution",
    nodeId: "coding.resolution.dynamic",
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "ambiguous",
    summary: "The repository cannot establish the product contract.",
    decisions: [],
    unresolved: [{
      subjectId: "public-contract",
      reason: "Both choices are compatible.",
      candidateSummaries: ["attachment", "inline"],
    }],
  }));
  await conversationRuntime.execute(`agents/coding-agent/runs/${startedBody.conversationId}`, {
    type: "emit",
    eventId: "event-human-escalation",
    event: ambiguity,
  });
  const continued = await app.request(`/api/v2/coding/runs/${startedBody.conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Use attachment semantics for this endpoint." }),
  });
  assert.equal(continued.status, 202);
  const continuedBody = await continued.json() as { readonly job: { readonly id: string } };
  assert.equal(continuedBody.job.id, "conversation-job-2");
  assert.equal(enqueueCount, 2);
  const continuationJob = jobs.get("conversation-job-2");
  assert.equal(continuationJob?.payload.conversationId, startedBody.conversationId);
  assert.notEqual(continuationJob?.payload.runId, startedBody.conversationId);
  assert.match(String(continuationJob?.payload.runId), /^coding_/);
  assert.equal(continuationJob?.payload.runStream, `agents/coding-agent/runs/${continuationJob?.payload.runId as string}`);
  assert.equal(continuationJob?.payload.branch, gitRoomBranchName(codingRepositoryRoomId(startedBody.conversationId)));
  assert.deepEqual(continuationContext, {
    stage: "awaiting_human",
    summary: "The repository cannot establish the product contract.",
    decisions: [],
    unresolved: [{
      subjectId: "public-contract",
      reason: "Both choices are compatible.",
      candidateSummaries: ["attachment", "inline"],
    }],
  });
  assert.match(String(continuationJob?.payload.objective), /Use attachment semantics/);
  assert.deepEqual(continuationJob?.payload.humanResolution, {
    status: "resolved",
    summary: "The human participant resolved the remaining collaboration subjects. The repository cannot establish the product contract.",
    decisions: [{
      subjectId: "public-contract",
      resolution: "Use attachment semantics for this endpoint.",
      rationale: "The human participant supplied the missing product context for public-contract: Both choices are compatible.",
      evidence: [
        "Human conversation answer: Use attachment semantics for this endpoint.",
        "Prior candidate: attachment",
        "Prior candidate: inline",
      ],
    }],
    unresolved: [],
  });
  jobs.set(continuationJob!.id, {
    ...continuationJob!,
    createdAt: 40,
    updatedAt: 40,
  });
  const historicalPage = await app.request(
    `/coding?run=${startedBody.conversationId}&job=conversation-job-1`,
  );
  assert.equal(historicalPage.status, 200);
  const historicalPageHtml = await historicalPage.text();
  assert.match(historicalPageHtml, /data-coding-form data-coding-active="true"/);
  assert.match(
    historicalPageHtml,
    new RegExp(`name="conversationId" value="${startedBody.conversationId}"`),
  );
  assert.match(historicalPageHtml, /Message to the working team · delivered at the next safe handoff/);
  assert.match(historicalPageHtml, /Saved in the room now; the working team receives it at the next safe boundary/);
  const runEvents = events.get(`agents/coding-agent/runs/${startedBody.conversationId}`) ?? [];
  assert.ok(runEvents.some((event) => event.type === "artifact.published"
    && event.outputKey.startsWith("conversation_message_")
    && event.payload.storage === "inline"
    && event.payload.value.includes("intent:human-resolution")));

  await conversationRuntime.execute(`agents/coding-agent/runs/${startedBody.conversationId}`, {
    type: "emit",
    eventId: "event-first-execution-only",
    event: inlineArtifactPublishedEvent({
      runId: startedBody.conversationId,
      artifactId: "artifact-first-execution-only",
      origin: "input",
      outputKey: "first_execution_only",
      nodeId: "coordinator",
      kind: "text/plain",
      inputVersions: {},
    }, "first"),
  });
  const continuationExecutionId = String(continuationJob?.payload.runId);
  await conversationRuntime.execute(`agents/coding-agent/runs/${continuationExecutionId}`, {
    type: "emit",
    eventId: "event-second-execution-only",
    event: inlineArtifactPublishedEvent({
      runId: continuationExecutionId,
      artifactId: "artifact-second-execution-only",
      origin: "input",
      outputKey: "second_execution_only",
      nodeId: "coordinator",
      kind: "text/plain",
      inputVersions: {},
    }, "second"),
  });
  const priorDeliveryMessage = createCodingConversationMessage({
    conversationId: startedBody.conversationId,
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Retain this delivered instruction across continuations.",
    tags: ["delivery:queued"],
  });
  const priorTurn = createCodingAgentTurn({
    kind: "clarification",
    authorNodeId: "human.operator",
    recipients: ["workspace.api"],
    subjectId: `human-${priorDeliveryMessage.messageId}`,
    originatingTaskId: "implement",
    responseRequirement: "none",
    body: priorDeliveryMessage.text,
  });
  const priorAuthorization = createCodingControlIngressAuthorization({
    workspaceId: codingRepositoryWorkspace(process.cwd()).id,
    conversationId: startedBody.conversationId,
    runId: startedBody.conversationId,
    messageId: priorDeliveryMessage.messageId,
    turnId: priorTurn.turnId,
    jobId: "conversation-job-1",
    jobAttempt: 1,
    topologyVersion: "topology-first-execution",
    authorNodeId: "human.operator",
    recipientTaskId: "implement",
    recipientNodeId: "workspace.api",
  });
  await conversationRuntime.execute(`agents/coding-agent/runs/${startedBody.conversationId}`, {
    type: "emit",
    eventId: "event-prior-delivery-message",
    event: codingConversationMessageEvent(priorDeliveryMessage),
  });
  await conversationRuntime.execute(`agents/coding-agent/runs/${startedBody.conversationId}`, {
    type: "emit",
    eventId: "event-prior-delivery-consumed",
    event: codingControlDeliveryEvent(startedBody.conversationId, "human.operator", {
      schema: "coding-control-delivery/v1",
      authorization: priorAuthorization,
      state: "consumed",
      turn: priorTurn,
    }),
  });
  const firstProjection = await app.request(
    `/api/v2/coding/runs/${startedBody.conversationId}?job=conversation-job-1`,
  );
  const secondProjection = await app.request(
    `/api/v2/coding/runs/${startedBody.conversationId}?job=conversation-job-2`,
  );
  assert.equal(firstProjection.status, 200);
  assert.equal(secondProjection.status, 200);
  const firstProjectionBody = await firstProjection.json() as {
    readonly run: { readonly executionId: string; readonly stream: string; readonly conversationStream: string };
    readonly outputs: Readonly<Record<string, unknown>>;
  };
  const secondProjectionBody = await secondProjection.json() as {
    readonly run: { readonly executionId: string; readonly stream: string; readonly conversationStream: string };
    readonly outputs: Readonly<Record<string, unknown>>;
    readonly conversation: {
      readonly messages: ReadonlyArray<{
        readonly messageId: string;
        readonly delivery?: { readonly state: string; readonly runId?: string };
      }>;
    };
  };
  assert.equal(firstProjectionBody.run.executionId, startedBody.conversationId);
  assert.equal(firstProjectionBody.outputs.first_execution_only !== undefined, true);
  assert.equal(firstProjectionBody.outputs.second_execution_only, undefined);
  assert.equal(secondProjectionBody.run.executionId, continuationExecutionId);
  assert.equal(secondProjectionBody.run.stream, `agents/coding-agent/runs/${continuationExecutionId}`);
  assert.equal(
    secondProjectionBody.run.conversationStream,
    `agents/coding-agent/runs/${startedBody.conversationId}`,
  );
  assert.equal(secondProjectionBody.outputs.first_execution_only, undefined);
  assert.equal(secondProjectionBody.outputs.second_execution_only !== undefined, true);
  const retainedDelivery = secondProjectionBody.conversation.messages.find((message) =>
    message.messageId === priorDeliveryMessage.messageId)?.delivery;
  assert.equal(retainedDelivery?.state, "consumed");
  assert.equal(retainedDelivery?.runId, startedBody.conversationId);

  const missingApiJob = await app.request(
    `/api/v2/coding/runs/${startedBody.conversationId}?job=missing-job`,
  );
  const missingReviewJob = await app.request(
    `/coding/runs/${startedBody.conversationId}/review?job=missing-job`,
  );
  const missingPageJob = await app.request(
    `/coding?run=${startedBody.conversationId}&job=missing-job`,
  );
  const missingStatusJob = await app.request(
    `/coding/status?run=${startedBody.conversationId}&job=missing-job`,
  );
  assert.equal(missingApiJob.status, 404);
  assert.equal(missingReviewJob.status, 404);
  assert.equal(missingPageJob.status, 404);
  assert.equal(missingStatusJob.status, 404);

  const continuationPage = await app.request(
    `/coding?run=${startedBody.conversationId}&job=conversation-job-2`,
  );
  assert.equal(continuationPage.status, 200);
  const continuationPageHtml = await continuationPage.text();
  assert.match(
    continuationPageHtml,
    new RegExp(`run=${startedBody.conversationId}(?:&amp;|&)job=conversation-job-2`),
  );
  assert.doesNotMatch(
    continuationPageHtml,
    new RegExp(`run=${continuationExecutionId}(?:&amp;|&)job=conversation-job-2`),
  );

  const terminalConversationId = "coding-terminal-room";
  const terminalMessage = createCodingConversationMessage({
    conversationId: terminalConversationId,
    workspaceId,
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui", externalId: "terminal-room-initial" },
    text: "Finish the first bounded change.",
  });
  await conversationRuntime.execute(`agents/coding-agent/runs/${terminalConversationId}`, {
    type: "emit",
    eventId: `coding-conversation:${terminalMessage.messageId}`,
    event: codingConversationMessageEvent(terminalMessage),
  });
  jobs.set("terminal-room-job", {
    id: "terminal-room-job",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.run",
      runId: terminalConversationId,
      conversationId: terminalConversationId,
      codingWorkspaceId: workspaceId,
      objective: terminalMessage.text,
      reviewPolicy: "auto",
      workerExecution: testWorkerExecution(),
    },
    status: "completed",
    attempt: 1,
    maxAttempts: 4,
    createdAt: 50,
    updatedAt: 50,
    commands: [],
  });
  const ordinaryTerminalFollowUp = await app.request(
    `/api/v2/coding/runs/${terminalConversationId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, message: "continue" }),
    },
  );
  assert.equal(ordinaryTerminalFollowUp.status, 202);
  const ordinaryTerminalFollowUpBody = await ordinaryTerminalFollowUp.json() as {
    readonly conversationId: string;
    readonly job: { readonly id: string; readonly executionId: string };
  };
  assert.equal(ordinaryTerminalFollowUpBody.conversationId, terminalConversationId);
  assert.equal(ordinaryTerminalFollowUpBody.job.id, "conversation-job-3");
  assert.notEqual(ordinaryTerminalFollowUpBody.job.executionId, terminalConversationId);
  const ordinaryTerminalJob = jobs.get("conversation-job-3");
  assert.equal(ordinaryTerminalJob?.payload.conversationId, terminalConversationId);
  assert.notEqual(ordinaryTerminalJob?.payload.runId, terminalConversationId);
});

test("coding JSON API creates, projects, lists, controls, and summarizes runs", async () => {
  const jobs = new Map<string, QueueJob>();
  const commands: QueueCommandRecord[] = [];
  const roomIntents: Array<{
    readonly roomId: string;
    readonly intentId: string;
    readonly kind: "follow_up" | "steer";
    readonly payloadJson: string;
  }> = [];
  let realtimeSessionCount = 0;
  const realtimeSessionRuns: string[] = [];
  const queue = {
    enqueue: async (input: Parameters<AgentLoaderContext["queue"]["enqueue"]>[0]) => {
      const now = Date.now();
      const job: QueueJob = {
        id: input.jobId ?? `coding-api-job-${jobs.size + 1}`,
        agentId: input.agentId,
        lane: input.lane ?? "collect",
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        ...(input.singletonMode ? { singletonMode: input.singletonMode } : {}),
        payload: input.payload,
        status: "queued",
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 1,
        createdAt: now,
        updatedAt: now,
        commands: [],
      };
      jobs.set(job.id, job);
      return job;
    },
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async (input: Parameters<AgentLoaderContext["queue"]["queueCommand"]>[0]) => {
      if (!jobs.has(input.jobId)) return undefined;
      const command: QueueCommandRecord = {
        id: `command-${commands.length + 1}`,
        command: input.command,
        lane: input.command === "follow_up" ? "follow_up" : "steer",
        ...(input.payload ? { payload: input.payload } : {}),
        ...(input.by ? { by: input.by } : {}),
        createdAt: Date.now(),
      };
      commands.push(command);
      return command;
    },
    consumeCommands: async () => [],
    getJob: async (id: string) => jobs.get(id),
    listJobs: async () => [...jobs.values()],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const projectedState = {
    ...initialOrchestrationState,
    nodes: {
      worker: {
        id: "worker",
        name: "Codex worker",
        capabilities: ["implementation"],
        status: "active" as const,
        updatedAt: 10,
      },
    },
    taskGraph: projectedTaskGraph("coding-api", [{
      taskId: "implementation",
      nodeId: "worker",
      capability: "implementation",
      status: "running",
    }]),
    outputs: {
      patch: {
        outputKey: "patch",
        artifactId: "artifact-patch",
        contentHash: "hash-patch",
        origin: "task" as const,
        taskId: "implementation",
        updatedAt: 12,
      },
    },
  };
  let catalogState = initialOrchestrationState;
  const apiRuntime: CodingAgentRuntime = {
    ...runtime,
    execute: async (stream, command) => {
      if (stream === CODING_WORKSPACE_CATALOG_STREAM) {
        catalogState = reduceOrchestration(catalogState, command.event, Date.now());
      }
      return [command.event];
    },
    state: async (stream) => stream === codingRepositoryWorkspace(process.cwd()).profileStream
      ? savedWorkspaceState()
      : stream === CODING_WORKSPACE_CATALOG_STREAM ? catalogState : projectedState,
    chain: async () => [{
      id: "receipt-1",
      stream: "agents/coding-agent/runs/coding-api",
      sequence: 1,
      timestamp: 11,
      hash: "hash",
      previousHash: "",
      body: {
        type: "task.graph.projected",
        runId: "coding-api",
        graph: {
          ...projectedState.taskGraph,
          updatedAt: undefined,
        },
      },
    }],
  };
  const app = new Hono();
  const apiCodingWorkspaceId = codingRepositoryWorkspace(process.cwd()).id;
  const improvementSnapshotContent = {
    schemaVersion: ACTIVE_IMPROVEMENT_SNAPSHOT_VERSION,
    improvements: [{
      proposalId: "coding-api-policy",
      artifactType: "policy_patch" as const,
      target: "coding.policy",
      artifactHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      epoch: 2,
      patch: { maxParallel: 2 },
    }],
  };
  const improvementSnapshot = {
    ...improvementSnapshotContent,
    snapshotHash: hashCanonical(improvementSnapshotContent),
  };
  const improvementRuntime = createCodingImprovementRuntimePin(improvementSnapshot);
  createCodingRoute({
    runtime: apiRuntime,
    queue,
    rooms: {
      backfill: async () => undefined,
      list: async (workspaceId) => workspaceId === apiCodingWorkspaceId ? [{
        roomId: "room_repository_coding-information-only",
        conversationId: "coding-information-only",
        codingWorkspaceId: apiCodingWorkspaceId,
        streamId: "agents/coding-agent/runs/coding-information-only",
        title: "Explain how this repository team coordinates",
        state: "open",
        firstMessageId: "coding-message-information-only",
        messageCount: 2,
        createdAt: 10,
        updatedAt: 20,
      }] : [],
    },
    conversationPlanner: explicitMutationPlanner,
    roomControl: {
      queueIntent: async (input) => {
        roomIntents.push(input);
      },
    },
    activeImprovementSnapshot: () => improvementRuntime,
    realtime: {
      enabled: true,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
      workspaceId: "workspace-control-plane",
      capabilitySecret: "browser-boot-secret-must-not-be-returned",
    },
    realtimeSession: async (scope) => {
      realtimeSessionRuns.push(scope.executionId);
      return ({
      capabilitySecret: `cli-session-secret-${++realtimeSessionCount}`,
      capabilityId: `cli-session-${realtimeSessionCount}`,
      expiresAt: Date.now() + 600_000,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
      });
    },
    runtimeDiscovery: async () => [{
      id: "codex-cli",
      label: "Codex · Sol high",
      detail: "Installed implementation runtime",
      source: "builtin",
      available: true,
      ready: true,
      readiness: "ready",
      version: "codex-cli 1.2.3",
      access: ["read-only", "workspace-write"],
      mcp: {
        mode: "native",
        readiness: "none",
        servers: [],
        truncated: false,
      },
    }],
  }).register(app);

  const draftedShell = await app.request("/coding?draft=Review%20the%20parser");
  assert.equal(draftedShell.status, 200);
  assert.match(await draftedShell.text(), />Review the parser<\/textarea>/);
  assert.equal((await app.request("/coding?draft=bad%00draft")).status, 400);
  assert.equal((await app.request(`/coding?draft=${"x".repeat(20_001)}`)).status, 400);

  const workspace = await app.request("/api/v2/coding/workspace");
  assert.equal(workspace.status, 200);
  const workspaceBody = await workspace.json() as {
    readonly workspace: { readonly scanned: boolean; readonly nodes: ReadonlyArray<{ readonly id: string }> };
  };
  assert.equal(workspaceBody.workspace.scanned, true);
  assert.ok(workspaceBody.workspace.nodes.some((node) => node.id === "workspace.implementation"));

  const rooms = await app.request(`/api/v2/coding/rooms?workspace=${apiCodingWorkspaceId}`);
  assert.equal(rooms.status, 200);
  const roomsBody = await rooms.json() as {
    readonly rooms: ReadonlyArray<{ readonly conversationId: string; readonly messageCount: number }>;
  };
  assert.deepEqual(roomsBody.rooms.map((room) => ({
    conversationId: room.conversationId,
    messageCount: room.messageCount,
  })), [{ conversationId: "coding-information-only", messageCount: 2 }]);

  const runtimes = await app.request("/api/v2/coding/runtimes");
  assert.equal(runtimes.status, 200);
  assert.equal(runtimes.headers.get("cache-control"), "no-store");
  assert.deepEqual(await runtimes.json(), {
    schema: "roster.coding.v2",
    ok: true,
    runtimes: [{
      id: "codex-cli",
      label: "Codex · Sol high",
      detail: "Installed implementation runtime",
      source: "builtin",
      available: true,
      ready: true,
      readiness: "ready",
      version: "codex-cli 1.2.3",
      access: ["read-only", "workspace-write"],
      mcp: {
        mode: "native",
        readiness: "none",
        servers: [],
        truncated: false,
      },
    }],
  });

  const invalid = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: " " }),
  });
  assert.equal(invalid.status, 400);
  const escapedDirectory = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Do not run", workingDirectory: "/tmp" }),
  });
  assert.equal(escapedDirectory.status, 400);
  const invalidPolicy = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Do not run", reviewPolicy: "many-reviewers" }),
  });
  assert.equal(invalidPolicy.status, 400);
  const invalidRuntime = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Do not run", workerRuntime: "perl" }),
  });
  assert.equal(invalidRuntime.status, 400);

  const created = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Fix a typo in README", reviewPolicy: "fast" }),
  });
  assert.equal(created.status, 202);
  const createdBody = await created.json() as {
    readonly schema: string;
    readonly runId: string;
    readonly workspaceId: string;
    readonly repositoryRoot: string;
    readonly job: {
      readonly id: string;
      readonly executionId: string;
      readonly reviewPolicy: string;
      readonly workerRuntime: string;
      readonly workerModel: string;
      readonly branch: string;
      readonly workerProvider?: string;
      readonly workerPackages?: ReadonlyArray<string>;
      readonly workerSelectionSource?: string;
      readonly improvement: { readonly snapshotHash: string; readonly generationId: string };
    };
    readonly workspace: { readonly scanned: boolean; readonly nodes: ReadonlyArray<{ readonly id: string }> };
  };
  assert.equal(createdBody.schema, "roster.coding.v2");
  assert.equal(createdBody.repositoryRoot, process.cwd());
  assert.equal(createdBody.job.reviewPolicy, "fast");
  assert.equal(createdBody.job.executionId, createdBody.runId);
  assert.equal(createdBody.job.workerRuntime, "pi-agent");
  assert.equal(createdBody.job.workerModel, "openai-codex/gpt-5.6-luna");
  assert.equal(createdBody.job.workerProvider, "openai-codex");
  assert.deepEqual(createdBody.job.workerPackages, ["@cortexkit/aft-pi"]);
  assert.equal(createdBody.job.workerSelectionSource, "product-default");
  assert.deepEqual(createdBody.job.improvement, {
    snapshotHash: improvementSnapshot.snapshotHash,
    generationId: improvementRuntime.generationId,
  });

  const realtimeSession = await app.request("/api/v2/coding/realtime-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: createdBody.workspaceId,
      conversationId: createdBody.runId,
      jobId: createdBody.job.id,
      executionId: createdBody.job.executionId,
    }),
  });
  assert.equal(realtimeSession.status, 200);
  assert.equal(realtimeSession.headers.get("cache-control"), "private, no-store");
  const realtimeSessionBody = await realtimeSession.json() as {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly controlWorkspaceId: string;
    readonly roomId: string;
    readonly conversationId: string;
    readonly executionId: string;
    readonly jobId: string;
    readonly capabilitySecret: string;
  };
  assert.equal(realtimeSessionBody.sessionId, "cli-session-1");
  assert.equal(realtimeSessionBody.workspaceId, createdBody.workspaceId);
  assert.equal(realtimeSessionBody.controlWorkspaceId, "workspace-control-plane");
  assert.equal(realtimeSessionBody.conversationId, createdBody.runId);
  assert.equal(realtimeSessionBody.executionId, createdBody.job.executionId);
  assert.equal(realtimeSessionBody.jobId, createdBody.job.id);
  assert.equal(realtimeSessionBody.capabilitySecret, "cli-session-secret-1");
  assert.notEqual(realtimeSessionBody.capabilitySecret, "browser-boot-secret-must-not-be-returned");
  const unauthenticatedBrowserSession = await app.request("/coding/realtime-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: createdBody.workspaceId,
      conversationId: createdBody.runId,
      jobId: createdBody.job.id,
      executionId: createdBody.job.executionId,
    }),
  });
  assert.equal(unauthenticatedBrowserSession.status, 401);
  assert.equal(unauthenticatedBrowserSession.headers.get("cache-control"), "private, no-store");
  const authorizedPage = await app.request(`/coding?run=${createdBody.runId}&job=${createdBody.job.id}`);
  assert.equal(authorizedPage.status, 200);
  const setCookie = authorizedPage.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /roster_coding_page=/u);
  assert.match(setCookie, /HttpOnly/iu);
  assert.match(setCookie, /SameSite=Strict/iu);
  const pageCookie = setCookie.split(";", 1)[0]!;
  const browserRealtimeSession = await app.request("/coding/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: pageCookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      workspaceId: createdBody.workspaceId,
      conversationId: createdBody.runId,
      jobId: createdBody.job.id,
      executionId: createdBody.job.executionId,
    }),
  });
  assert.equal(browserRealtimeSession.status, 200);
  assert.equal(browserRealtimeSession.headers.get("cache-control"), "private, no-store");
  const browserRealtimeSessionBody = await browserRealtimeSession.json() as {
    readonly ok: boolean;
    readonly workspaceId: string;
    readonly controlWorkspaceId: string;
    readonly capabilitySecret: string;
    readonly expiresAt: number;
    readonly pageSessionExpiresAt: number;
  };
  assert.equal(browserRealtimeSessionBody.ok, true);
  assert.equal(browserRealtimeSessionBody.workspaceId, createdBody.workspaceId);
  assert.equal(browserRealtimeSessionBody.controlWorkspaceId, "workspace-control-plane");
  assert.equal(browserRealtimeSessionBody.capabilitySecret, "cli-session-secret-2");
  assert.ok(browserRealtimeSessionBody.expiresAt > Date.now());
  assert.ok(browserRealtimeSessionBody.pageSessionExpiresAt > Date.now());
  assert.ok(browserRealtimeSessionBody.pageSessionExpiresAt <= Date.now() + 10 * 60_000);
  const rotatedPageCookie = browserRealtimeSession.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.match(rotatedPageCookie, /^roster_coding_page=/u);
  assert.notEqual(rotatedPageCookie, pageCookie);
  assert.equal((await app.request("/coding/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: pageCookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      workspaceId: createdBody.workspaceId,
      conversationId: createdBody.runId,
      jobId: createdBody.job.id,
      executionId: createdBody.job.executionId,
    }),
  })).status, 401, "a successfully rotated page session invalidates its predecessor");
  const renewedBrowserSession = await app.request("/coding/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: rotatedPageCookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      workspaceId: createdBody.workspaceId,
      conversationId: createdBody.runId,
      jobId: createdBody.job.id,
      executionId: createdBody.job.executionId,
    }),
  });
  assert.equal(renewedBrowserSession.status, 200);
  assert.equal(renewedBrowserSession.headers.get("cache-control"), "private, no-store");
  const renewedBrowserBody = await renewedBrowserSession.json() as {
    readonly capabilitySecret: string;
    readonly expiresAt: number;
    readonly pageSessionExpiresAt: number;
  };
  assert.equal(renewedBrowserBody.capabilitySecret, "cli-session-secret-3");
  assert.ok(renewedBrowserBody.expiresAt > browserRealtimeSessionBody.expiresAt - 1_000);
  assert.ok(renewedBrowserBody.pageSessionExpiresAt >= browserRealtimeSessionBody.pageSessionExpiresAt);
  const twiceRotatedPageCookie = renewedBrowserSession.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.match(twiceRotatedPageCookie, /^roster_coding_page=/u);
  assert.notEqual(twiceRotatedPageCookie, rotatedPageCookie);
  assert.equal((await app.request("/coding/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: rotatedPageCookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      workspaceId: createdBody.workspaceId,
      conversationId: createdBody.runId,
      jobId: createdBody.job.id,
      executionId: createdBody.job.executionId,
    }),
  })).status, 401);
  assert.deepEqual(realtimeSessionRuns, [
    createdBody.job.executionId,
    createdBody.job.executionId,
    createdBody.job.executionId,
  ]);
  assert.equal((await app.request("/coding/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: twiceRotatedPageCookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      workspaceId: createdBody.workspaceId,
      conversationId: createdBody.runId,
      jobId: createdBody.job.id,
      executionId: "wrong-execution",
    }),
  })).status, 404);
  assert.equal((await app.request("/coding/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: twiceRotatedPageCookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      workspaceId: `workspace_${"f".repeat(20)}`,
      conversationId: createdBody.runId,
      jobId: createdBody.job.id,
      executionId: createdBody.job.executionId,
    }),
  })).status, 404);
  const partialBrowserSession = await app.request("/coding/realtime-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: twiceRotatedPageCookie,
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ workspaceId: createdBody.workspaceId }),
  });
  assert.equal(partialBrowserSession.status, 400);
  assert.equal(partialBrowserSession.headers.get("cache-control"), "private, no-store");
  const partialApiSession = await app.request("/api/v2/coding/realtime-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: createdBody.runId, jobId: "missing-job" }),
    });
  assert.equal(partialApiSession.status, 400);
  assert.equal(partialApiSession.headers.get("cache-control"), "private, no-store");
  const previousApiToken = process.env.ROSTER_API_TOKEN;
  try {
    process.env.ROSTER_API_TOKEN = "coding-page-operator-one";
    const unauthenticatedPage = await app.request(
      `/coding?run=${createdBody.runId}&job=${createdBody.job.id}`,
    );
    assert.equal(unauthenticatedPage.status, 401);
    assert.equal(unauthenticatedPage.headers.get("set-cookie"), null);

    const authenticatedPage = await app.request(
      `/coding?run=${createdBody.runId}&job=${createdBody.job.id}`,
      { headers: { authorization: "Bearer coding-page-operator-one" } },
    );
    assert.equal(authenticatedPage.status, 200);
    assert.equal(authenticatedPage.headers.get("cache-control"), "private, no-store");
    const authenticatedCookie = authenticatedPage.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    assert.match(authenticatedCookie, /^roster_coding_page=/u);

    process.env.ROSTER_API_TOKEN = "coding-page-operator-two";
    const rotatedAuthorityMint = await app.request("/coding/realtime-session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: authenticatedCookie,
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        workspaceId: createdBody.workspaceId,
        conversationId: createdBody.runId,
        jobId: createdBody.job.id,
        executionId: createdBody.job.executionId,
      }),
    });
    assert.equal(rotatedAuthorityMint.status, 401);
    assert.equal(rotatedAuthorityMint.headers.get("cache-control"), "no-store");

    const spoofedOriginMint = await app.request("/coding/realtime-session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: authenticatedCookie,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        workspaceId: createdBody.workspaceId,
        conversationId: createdBody.runId,
        jobId: createdBody.job.id,
        executionId: createdBody.job.executionId,
      }),
    });
    assert.equal(spoofedOriginMint.status, 403);
  } finally {
    if (previousApiToken === undefined) delete process.env.ROSTER_API_TOKEN;
    else process.env.ROSTER_API_TOKEN = previousApiToken;
  }
  assert.deepEqual(jobs.get(createdBody.job.id)?.payload.improvementRuntime, improvementRuntime);
  assert.equal(createdBody.job.branch, gitRoomBranchName(codingRepositoryRoomId(createdBody.runId)));
  assert.equal(createdBody.workspace.scanned, true);
  assert.ok(createdBody.workspace.nodes.some((node) => node.id === "workspace.implementation"));
  assert.match(createdBody.runId, /^coding_/);
  assert.match(created.headers.get("location") ?? "", /^\/api\/v2\/coding\/runs\/coding_/);

  const listed = await app.request("/api/v2/coding/runs?limit=10");
  assert.equal(listed.status, 200);
  const listedBody = await listed.json() as { readonly runs: ReadonlyArray<{ readonly id: string }> };
  assert.deepEqual(listedBody.runs.map((run) => run.id), [createdBody.runId]);

  const projection = await app.request(`/api/v2/coding/runs/${createdBody.runId}?job=${createdBody.job.id}`);
  assert.equal(projection.status, 200);
  const projectionBody = await projection.json() as {
    readonly tasks: Record<string, unknown>;
    readonly nodes: Record<string, unknown>;
    readonly outputs: Record<string, unknown>;
    readonly events: ReadonlyArray<{ readonly type: string }>;
    readonly receiptCount: number;
    readonly run: {
      readonly repositoryRoot: string;
      readonly branch: string;
      readonly improvement: { readonly snapshotHash: string; readonly generationId: string };
    };
    readonly job: {
      readonly status: string;
      readonly branch: string;
      readonly workerModel: string;
      readonly workerProvider?: string;
      readonly workerPackages?: ReadonlyArray<string>;
    };
    readonly collaboration: {
      readonly phase: string;
      readonly conflictCount: number;
      readonly durableStore: string;
      readonly topologyId: string | null;
      readonly resolution: null | {
        readonly status: string;
        readonly unresolved: ReadonlyArray<{
          readonly subjectId: string;
          readonly candidateSummaries: ReadonlyArray<string>;
        }>;
      };
    };
  };
  assert.equal(projectionBody.job.status, "queued");
  assert.deepEqual(projectionBody.run.improvement, createdBody.job.improvement);
  assert.ok(projectionBody.tasks.implementation);
  assert.ok(projectionBody.nodes.worker);
  assert.ok(projectionBody.outputs.patch);
  assert.equal(projectionBody.events[0]?.type, "task.graph.projected");
  assert.equal(projectionBody.receiptCount, 1);
  assert.equal(projectionBody.run.repositoryRoot, process.cwd());
  assert.equal(projectionBody.run.branch, gitRoomBranchName(codingRepositoryRoomId(createdBody.runId)));
  assert.equal(projectionBody.job.branch, projectionBody.run.branch);
  assert.equal(projectionBody.job.workerModel, "openai-codex/gpt-5.6-luna");
  assert.equal(projectionBody.job.workerProvider, "openai-codex");
  assert.deepEqual(projectionBody.job.workerPackages, ["@cortexkit/aft-pi"]);
  assert.equal(projectionBody.collaboration.durableStore, "spacetimedb");
  assert.equal(projectionBody.collaboration.conflictCount, 0);
  assert.equal(projectionBody.collaboration.topologyId, null);
  assert.equal(projectionBody.collaboration.resolution, null);

  const workspaceId = codingRepositoryWorkspace(process.cwd()).id;
  const savePiDefault = await app.request("/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      workspaceId,
      workerRuntime: "pi-agent",
      codexModel: "gpt-5.6-terra",
      piModel: "openai-codex/gpt-5.6-terra",
    }).toString(),
  });
  assert.equal(savePiDefault.status, 303);
  const preferred = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Use the workspace runtime" }),
  });
  assert.equal(preferred.status, 202);
  const preferredBody = await preferred.json() as {
    readonly job: { readonly id: string; readonly workerRuntime: string; readonly workerModel: string };
  };
  assert.equal(preferredBody.job.workerRuntime, "pi-agent");
  assert.equal(preferredBody.job.workerModel, "openai-codex/gpt-5.6-terra");
  const overridden = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Use the explicit API runtime", workerRuntime: "claude-code" }),
  });
  assert.equal(overridden.status, 202);
  const overriddenBody = await overridden.json() as { readonly job: { readonly workerRuntime: string } };
  assert.equal(overriddenBody.job.workerRuntime, "claude-code");
  const saveCodexDefault = await app.request("/coding/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      workspaceId,
      workerRuntime: "codex-cli",
      codexModel: "gpt-5.6-luna",
      piModel: "openai-codex/gpt-5.6-sol",
    }).toString(),
  });
  assert.equal(saveCodexDefault.status, 303);
  const preferredExecution = jobs.get(preferredBody.job.id)?.payload.workerExecution as CodingWorkerExecution | undefined;
  assert.equal(preferredExecution?.runtime, "pi-agent");
  assert.equal(preferredExecution?.model, "openai-codex/gpt-5.6-terra");
  assert.equal(jobs.get(preferredBody.job.id)?.payload.workerRuntime, undefined);
  assert.equal(jobs.get(preferredBody.job.id)?.payload.workerModel, undefined);

  const activeExport = await app.request(`/api/v2/coding/runs/${createdBody.runId}/collaboration.md?job=${createdBody.job.id}`);
  assert.equal(activeExport.status, 409);
  const invalidExport = await app.request("/api/v2/coding/runs/-bad/collaboration.md");
  assert.equal(invalidExport.status, 400);
  const missingExportJob = await app.request(`/api/v2/coding/runs/${createdBody.runId}/collaboration.md?job=missing-job`);
  assert.equal(missingExportJob.status, 404);

  const followUp = await app.request(`/api/v2/coding/runs/${createdBody.runId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Also document the endpoint" }),
  });
  assert.equal(followUp.status, 202);
  const activeJob = jobs.get(createdBody.job.id);
  assert.ok(activeJob);
  assert.equal(typeof activeJob.payload.branch, "string");
  const expectedRoomId = codingRoomProjection({
    conversationId: createdBody.runId,
    job: {
      id: activeJob.id,
      status: activeJob.status,
      branch: activeJob.payload.branch as string,
      objective: activeJob.payload.objective as string,
    },
    nodes: [],
  }).roomId;
  assert.equal(expectedRoomId, codingRepositoryRoomId(createdBody.runId));
  assert.equal(roomIntents.length, 1);
  assert.equal(roomIntents[0]?.roomId, expectedRoomId);
  assert.equal(roomIntents[0]?.kind, "follow_up");
  const intentPayload = JSON.parse(roomIntents[0]?.payloadJson ?? "{}") as {
    readonly messageId?: string;
    readonly problem?: string;
  };
  assert.equal(intentPayload.problem, "Also document the endpoint");
  assert.equal(intentPayload.messageId, roomIntents[0]?.intentId);
  assert.equal(commands[0]?.command, "steer");
  assert.equal(commands[0]?.payload?.problem, "Also document the endpoint");

  const statusQuestion = await app.request(`/api/v2/coding/runs/${createdBody.runId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "What is the current status? Keep working." }),
  });
  assert.equal(statusQuestion.status, 200);
  const statusQuestionBody = await statusQuestion.json() as {
    readonly disposition: string;
    readonly duplicate: boolean;
    readonly message: { readonly messageId: string; readonly text: string; readonly tags: ReadonlyArray<string> };
    readonly route: { readonly answer?: string; readonly tags: ReadonlyArray<string> };
  };
  assert.equal(statusQuestionBody.disposition, "informational");
  assert.equal(statusQuestionBody.duplicate, false);
  assert.equal(statusQuestionBody.message.text, "What is the current status? Keep working.");
  assert.ok(statusQuestionBody.message.tags.includes("delivery:queued"));
  assert.ok(statusQuestionBody.route.tags.includes("intent:status"));
  assert.ok(statusQuestionBody.route.tags.includes("disposition:informational"));
  assert.match(statusQuestionBody.route.answer ?? "", /tasks are accepted/);
  assert.equal(roomIntents.length, 1, "a live status answer does not queue a control intent");
  assert.equal(commands.length, 1, "a live status answer does not wake or retry the worker");

  const steer = await app.request(`/api/v2/coding/runs/${createdBody.runId}/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: createdBody.job.id, message: "Also update the route docs" }),
  });
  assert.equal(steer.status, 202);
  assert.equal(commands[1]?.command, "steer");
  assert.equal(commands[1]?.payload?.schema, "coding-control-command/v1");
  assert.equal(commands[1]?.payload?.problem, "Also update the route docs");
  assert.equal((commands[1]?.payload?.message as { readonly text?: string } | undefined)?.text, "Also update the route docs");

  const abort = await app.request(`/api/v2/coding/runs/${createdBody.runId}/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: createdBody.job.id, reason: "stop now" }),
  });
  assert.equal(abort.status, 202);
  assert.equal(commands[2]?.command, "abort");
  assert.deepEqual(commands[2]?.payload, { reason: "stop now" });

  const diff = await app.request("/api/v2/coding/diff");
  assert.equal(diff.status, 200);
  const diffBody = await diff.json() as {
    readonly schema: string;
    readonly scope: string;
    readonly dirty: boolean;
    readonly files: ReadonlyArray<unknown>;
    readonly patch: { readonly text: string; readonly bytes: number; readonly maxBytes: number; readonly truncated: boolean };
  };
  assert.equal(diffBody.schema, "roster.coding.v2");
  assert.equal(diffBody.scope, "checkout");
  assert.equal(typeof diffBody.dirty, "boolean");
  assert.ok(Array.isArray(diffBody.files));
  assert.equal(typeof diffBody.patch.text, "string");
  assert.ok(diffBody.patch.bytes <= diffBody.patch.maxBytes);
  assert.equal(typeof diffBody.patch.truncated, "boolean");

  const invalidRunDiff = await app.request("/api/v2/coding/diff?runId=bad/run");
  assert.equal(invalidRunDiff.status, 400);

  const runDiff = await app.request(`/api/v2/coding/diff?runId=${createdBody.runId}`);
  assert.equal(runDiff.status, 200);
  const runDiffBody = await runDiff.json() as { readonly scope: string; readonly runId: string; readonly patch: { readonly text: string } };
  assert.equal(runDiffBody.scope, "run");
  assert.equal(runDiffBody.runId, createdBody.runId);
  assert.equal(typeof runDiffBody.patch.text, "string");

  const reviewedOverride = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      objective: "Planner recommends fast: clarify one documentation sentence",
      reviewPolicy: "reviewed",
    }),
  });
  assert.equal(reviewedOverride.status, 200);
  const reviewedOverrideBody = await reviewedOverride.json() as {
    readonly disposition: string;
    readonly activation: string;
    readonly route: {
      readonly questions: ReadonlyArray<string>;
      readonly selectedNodeIds: ReadonlyArray<string>;
    };
    readonly job: unknown;
  };
  assert.equal(reviewedOverrideBody.disposition, "needs_clarification");
  assert.equal(reviewedOverrideBody.activation, "none");
  assert.equal(reviewedOverrideBody.job, null);
  assert.deepEqual(reviewedOverrideBody.route.selectedNodeIds, ["human.operator"]);
  assert.match(
    reviewedOverrideBody.route.questions.join(" "),
    /enable or select a saved review-capable workspace node/i,
  );

  const reviewedInvestigation = await app.request("/api/v2/coding/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      objective: "Planner reviewed investigation: map the repository execution paths",
      reviewPolicy: "auto",
    }),
  });
  assert.equal(reviewedInvestigation.status, 200);
  const reviewedInvestigationBody = await reviewedInvestigation.json() as {
    readonly disposition: string;
    readonly activation: string;
    readonly route: {
      readonly disposition: string;
      readonly questions: ReadonlyArray<string>;
      readonly selectedNodeIds: ReadonlyArray<string>;
    };
    readonly job: unknown;
  };
  assert.equal(reviewedInvestigationBody.disposition, "needs_clarification");
  assert.equal(reviewedInvestigationBody.activation, "none");
  assert.equal(reviewedInvestigationBody.route.disposition, "needs_clarification");
  assert.equal(reviewedInvestigationBody.job, null);
  assert.deepEqual(reviewedInvestigationBody.route.selectedNodeIds, ["human.operator"]);
  assert.match(
    reviewedInvestigationBody.route.questions.join(" "),
    /enable or select a saved review-capable workspace node/i,
  );

  const previousToken = process.env.ROSTER_API_TOKEN;
  process.env.ROSTER_API_TOKEN = "coding-api-secret";
  try {
    const unauthorized = await app.request("/api/v2/coding/runs");
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");
    const authorized = await app.request("/api/v2/coding/runs", {
      headers: { authorization: "Bearer coding-api-secret" },
    });
    assert.equal(authorized.status, 200);
    const browserRequiresAuthentication = await app.request("/coding");
    assert.equal(browserRequiresAuthentication.status, 401);
  } finally {
    if (previousToken === undefined) delete process.env.ROSTER_API_TOKEN;
    else process.env.ROSTER_API_TOKEN = previousToken;
  }
});

test("completed continuation executions integrate only their own certified stream and commit", async () => {
  const sourceCommit = "a".repeat(40);
  const baselineCommit = "b".repeat(40);
  const job: QueueJob = {
    id: "integration-job",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.run",
      runId: "coding-integration-execution-2",
      conversationId: "coding-integration",
      branch: gitRoomBranchName(codingRepositoryRoomId("coding-integration")),
      objective: "Add the certified result",
      workerExecution: testWorkerExecution(),
    },
    status: "completed",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 2,
    commands: [],
    result: {
      commit: sourceCommit,
      baselineBranch: "main",
      baselineCommit,
    },
  };
  const completedState = {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph("coding-integration-execution-2", [
      {
        taskId: "coding-coordinate",
        nodeId: "coordinator",
        capability: "coordinate",
        status: "waiting",
      },
      {
        taskId: "coding-review-gate",
        nodeId: "coordinator",
        capability: "coordinate",
        status: "skipped",
      },
      {
        taskId: "implement",
        nodeId: "workspace.implementation",
        capability: "implement",
        status: "accepted",
      },
      {
        taskId: "certify-workspace-quality",
        nodeId: "workspace.quality",
        capability: "certify",
        status: "accepted",
      },
      {
        taskId: "coding-finalize",
        nodeId: "coordinator",
        capability: "coordinate",
        status: "accepted",
      },
    ]),
  };
  const tiedLaterListedJob: QueueJob = {
    ...job,
    id: "z-integration-job",
    payload: { ...job.payload, objective: "This tied job must not win the stable ID tie-breaker" },
  };
  const detachedSourceJob: QueueJob = {
    ...job,
    id: "detached-source-job",
    payload: {
      ...job.payload,
      runId: "coding-detached-execution",
      conversationId: "coding-detached",
      branch: gitRoomBranchName(codingRepositoryRoomId("coding-detached")),
      objective: "Certify work from a detached source checkout",
    },
    result: {
      commit: sourceCommit,
      baselineCommit,
    },
  };
  const emitted: OrchestrationEvent[] = [];
  const emittedStreams: string[] = [];
  const observedStateAtCounts: number[] = [];
  const integrationRuntime: CodingAgentRuntime = {
    ...runtime,
    state: async () => completedState,
    stateAt: async (_stream, receiptCount) => {
      observedStateAtCounts.push(receiptCount);
      return emitted.slice(0, receiptCount).reduce(reduceOrchestration, completedState);
    },
    chain: async (stream) => emitted.map((body, index) => ({
      id: `integration-receipt-${index}`,
      ts: index + 1,
      stream,
      ...(index > 0 ? { prev: `integration-hash-${index - 1}` } : {}),
      body,
      hash: `integration-hash-${index}`,
    })),
    execute: async (stream, command) => {
      emittedStreams.push(stream);
      emitted.push(command.event);
      return [];
    },
  };
  const queue = {
    enqueue: async () => job,
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (id: string) => id === job.id
      ? job
      : id === tiedLaterListedJob.id
        ? tiedLaterListedJob
        : id === detachedSourceJob.id
          ? detachedSourceJob
          : undefined,
    listJobs: async () => [tiedLaterListedJob, job],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  let integratedInput: Readonly<Record<string, unknown>> | undefined;
  let integrationApplied = false;
  const app = new Hono();
  createCodingRoute({
    runtime: integrationRuntime,
    queue,
    acceptedOutputs: async (runId) => ({
      outputs: [{
        runId,
        taskId: "certify-workspace-quality",
        nodeId: "workspace.quality",
        outcomeId: "outcome-certify-workspace-quality",
        artifactId: "artifact-certify-workspace-quality",
        projectionKey: codingAcceptedOutputProjectionKey(
          "collaboration_endorsement_quality",
          "certify-workspace-quality",
        ),
        outputKey: "collaboration_endorsement_quality",
        kind: "json",
        contentHash: "certification-output-hash",
        mediaType: "application/json",
        byteLength: 160,
        value: JSON.stringify({
          verdict: "approve",
          frontierHash: "frontier-certified",
          summary: "The exact implementation frontier passed quality review.",
          evidence: ["targeted tests passed"],
        }),
      }],
      omittedCount: 0,
    }),
    integrationStatus: async (input) => ({
      runId: input.runId,
      branchName: input.branchName ?? `roster/${input.runId}`,
      commit: input.expectedCommit,
      currentBranch: "main",
      integrated: integrationApplied,
      canIntegrate: !integrationApplied,
    }),
    runBranchExists: async () => true,
    branchExists: async () => true,
    integrateRun: async (input) => {
      integratedInput = input;
      integrationApplied = true;
      return {
        runId: input.runId,
        branchName: input.branchName ?? `roster/${input.runId}`,
        commit: input.expectedCommit,
        currentBranch: input.baselineBranch,
        integrated: true,
        canIntegrate: false,
        alreadyIntegrated: false,
      };
    },
  }).register(app);

  const beforeIntegrationRecord = await app.request(`/api/v2/coding/runs/coding-integration/collaboration.md?job=${job.id}`);
  assert.equal(beforeIntegrationRecord.status, 200);
  const beforeIntegrationBody = await beforeIntegrationRecord.text();
  assert.equal(observedStateAtCounts.at(-1), 0);
  assert.match(beforeIntegrationBody, /Record basis: durable receipt replay head with 0 receipts/);
  assert.match(beforeIntegrationBody, /No structured integration result recorded at this replay head\./);

  const closeResponse = await app.request("/api/v2/coding/runs/coding-integration/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.id }),
  });
  assert.equal(closeResponse.status, 200);
  const closeBody = await closeResponse.json() as {
    readonly disposition: { readonly action: string; readonly branch: string };
    readonly duplicate: boolean;
  };
  assert.equal(closeBody.disposition.action, "keep-branch");
  assert.equal(closeBody.disposition.branch, gitRoomBranchName(codingRepositoryRoomId("coding-integration")));
  assert.equal(closeBody.duplicate, false);
  const duplicateCloseResponse = await app.request("/api/v2/coding/runs/coding-integration/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.id }),
  });
  assert.equal(duplicateCloseResponse.status, 200);
  assert.equal((await duplicateCloseResponse.json() as { readonly duplicate: boolean }).duplicate, true);
  assert.equal(emitted.length, 1);

  const response = await app.request("/api/v2/coding/runs/coding-integration/integrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.id, commit: "f".repeat(40) }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(integratedInput, {
    repositoryRoot: process.cwd(),
    runId: "coding-integration-execution-2",
    expectedCommit: sourceCommit,
    baselineBranch: "main",
    baselineCommit,
    branchName: gitRoomBranchName(codingRepositoryRoomId("coding-integration")),
    keepBranch: true,
  });
  const responseBody = await response.json() as { readonly integration: { readonly status: string } };
  assert.equal(responseBody.integration.status, "integrated");
  assert.deepEqual(emitted.map((event) => event.type), ["artifact.published", "artifact.published", "artifact.published"]);
  assert.deepEqual(emitted.map((event) => event.type === "artifact.published" ? event.origin : undefined), ["input", "input", "input"]);
  assert.deepEqual(emitted.map((event) => event.runId), [
    "coding-integration-execution-2",
    "coding-integration-execution-2",
    "coding-integration-execution-2",
  ]);
  assert.deepEqual(emittedStreams, [
    "agents/coding-agent/runs/coding-integration-execution-2",
    "agents/coding-agent/runs/coding-integration-execution-2",
    "agents/coding-agent/runs/coding-integration-execution-2",
  ]);
  const replayed = emitted.reduce(reduceOrchestration, completedState);
  assert.equal(replayed.outputs.integration_result?.artifactId.startsWith("integration-result-"), true);

  const forgedTaskResult = emitted[2];
  assert.ok(forgedTaskResult?.type === "artifact.published");
  assert.throws(
    () => reduceOrchestration(completedState, { ...forgedTaskResult, origin: "task" }, 3),
    /has no taskId/,
  );

  const apiRecord = await app.request(`/api/v2/coding/runs/coding-integration/collaboration.md?job=${job.id}`);
  assert.equal(apiRecord.status, 200);
  assert.equal(apiRecord.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(apiRecord.headers.get("content-disposition"), "attachment; filename=\"roster-collaboration-coding-integration-integration-job.md\"");
  assert.equal(apiRecord.headers.get("cache-control"), "no-store");
  assert.equal(apiRecord.headers.get("x-content-type-options"), "nosniff");
  const apiRecordBody = await apiRecord.text();
  assert.equal(observedStateAtCounts.at(-1), 3);
  assert.match(apiRecordBody, /# Roster coding collaboration record/);
  assert.match(apiRecordBody, /## Objective/);
  assert.match(apiRecordBody, /Add the certified result/);
  assert.match(apiRecordBody, /## Certification/);
  assert.match(apiRecordBody, /Endorsement by workspace\\\.quality: approve/);
  assert.doesNotMatch(apiRecordBody, /No certification evidence recorded at this replay head\./);
  assert.match(apiRecordBody, /Record basis: durable receipt replay head with 3 receipts plus an authoritative accepted-output snapshot with 1 output/);
  assert.match(apiRecordBody, /## Current\-head integration/);
  assert.match(apiRecordBody, /Status: integrated/);
  assert.match(apiRecordBody, new RegExp(sourceCommit));
  assert.notEqual(apiRecordBody, beforeIntegrationBody);

  const runResponse = await app.request(`/api/v2/coding/runs/coding-integration?job=${job.id}`);
  assert.equal(runResponse.status, 200);
  const runBody = await runResponse.json() as {
    readonly acceptedOutputCount: number;
    readonly collaboration: { readonly endorsementCount: number };
    readonly tasks: Readonly<Record<string, { readonly outputKeys: ReadonlyArray<string> }>>;
  };
  assert.equal(runBody.acceptedOutputCount, 1);
  assert.equal(runBody.collaboration.endorsementCount, 1);
  assert.deepEqual(
    runBody.tasks["certify-workspace-quality"]?.outputKeys,
    [
      "accepted-output/25:certify-workspace-quality/33:collaboration_endorsement_quality",
      "collaboration_endorsement_quality",
    ],
  );

  const detachedSourceResponse = await app.request(
    `/api/v2/coding/runs/coding-detached?job=${detachedSourceJob.id}`,
  );
  assert.equal(detachedSourceResponse.status, 200);
  const detachedSourceBody = await detachedSourceResponse.json() as {
    readonly job: { readonly capabilities: { readonly integratable: boolean } };
  };
  assert.equal(detachedSourceBody.job.capabilities.integratable, false);

  const browserRecord = await app.request(`/coding/runs/coding-integration/collaboration.md?job=${job.id}`);
  assert.equal(browserRecord.status, 200);
  assert.equal(await browserRecord.text(), apiRecordBody);
  const implicitLatestRecord = await app.request("/api/v2/coding/runs/coding-integration/collaboration.md");
  assert.equal(implicitLatestRecord.status, 200);
  assert.equal(await implicitLatestRecord.text(), apiRecordBody);
  assert.equal((await app.request("/api/v2/coding/runs/coding-integration/collaboration.md?job=")).status, 400);
  assert.equal((await app.request("/api/v2/coding/runs/coding-integration/collaboration.md?job=integration-job&job=integration-job")).status, 400);
  assert.equal((await app.request("/coding/runs/coding-integration/collaboration.md?job=")).status, 400);
  assert.equal((await app.request("/coding/runs/coding-integration/collaboration.md?job=integration-job&job=integration-job")).status, 400);

  const previousToken = process.env.ROSTER_API_TOKEN;
  process.env.ROSTER_API_TOKEN = "record-api-secret";
  try {
    const unauthorizedRecord = await app.request(`/api/v2/coding/runs/coding-integration/collaboration.md?job=${job.id}`);
    assert.equal(unauthorizedRecord.status, 401);
    const authorizedRecord = await app.request(`/api/v2/coding/runs/coding-integration/collaboration.md?job=${job.id}`, {
      headers: { authorization: "Bearer record-api-secret" },
    });
    assert.equal(authorizedRecord.status, 200);
    assert.equal(await authorizedRecord.text(), apiRecordBody);
    const publicRecord = await app.request(`/coding/runs/coding-integration/collaboration.md?job=${job.id}`);
    assert.equal(publicRecord.status, 401);
  } finally {
    if (previousToken === undefined) delete process.env.ROSTER_API_TOKEN;
    else process.env.ROSTER_API_TOKEN = previousToken;
  }

  const reviewPage = await app.request(`/coding/runs/coding-integration/review?job=${job.id}`);
  assert.equal(reviewPage.status, 200);
  const reviewCsp = reviewPage.headers.get("content-security-policy") ?? "";
  assert.match(reviewCsp, /script-src 'self' 'nonce-[^']+'/);
  assert.match(reviewCsp, /style-src 'self' 'nonce-[^']+'/);
  const reviewBody = await reviewPage.text();
  assert.match(reviewBody, /Review changes/);
  assert.match(reviewBody, /Certified &amp; merged/);
  assert.match(reviewBody, /Present on main/);

  const unavailableApp = new Hono();
  createCodingRoute({
    runtime: { ...integrationRuntime, chain: async () => { throw new Error("replay unavailable"); } },
    queue,
  }).register(unavailableApp);
  const unavailableApi = await unavailableApp.request(`/api/v2/coding/runs/coding-integration/collaboration.md?job=${job.id}`);
  assert.equal(unavailableApi.status, 503);
  assert.deepEqual(await unavailableApi.json(), {
    schema: "roster.coding.v2",
    ok: false,
    error: "coding collaboration replay is unavailable",
  });
  const unavailableBrowser = await unavailableApp.request(`/coding/runs/coding-integration/collaboration.md?job=${job.id}`);
  assert.equal(unavailableBrowser.status, 503);
  assert.equal(await unavailableBrowser.text(), "Coding collaboration replay is unavailable.");

  const unavailableOutputsApp = new Hono();
  createCodingRoute({
    runtime: integrationRuntime,
    queue,
    acceptedOutputs: async () => {
      throw new Error("accepted body unavailable");
    },
  }).register(unavailableOutputsApp);
  const unavailableRun = await unavailableOutputsApp.request(
    `/api/v2/coding/runs/coding-integration?job=${job.id}`,
  );
  assert.equal(unavailableRun.status, 503);
  assert.deepEqual(await unavailableRun.json(), {
    schema: "roster.coding.v2",
    ok: false,
    error: "coding accepted output projection is unavailable",
  });
  const unavailableRecord = await unavailableOutputsApp.request(
    `/api/v2/coding/runs/coding-integration/collaboration.md?job=${job.id}`,
  );
  assert.equal(unavailableRecord.status, 503);
  assert.deepEqual(await unavailableRecord.json(), {
    schema: "roster.coding.v2",
    ok: false,
    error: "coding accepted output projection is unavailable",
  });

  const forgedOutputsApp = new Hono();
  createCodingRoute({
    runtime: integrationRuntime,
    queue,
    acceptedOutputs: async () => ({
      outputs: [{
        runId: "another-execution",
        taskId: "forged-task",
        nodeId: "forged-node",
        outcomeId: "forged-outcome",
        artifactId: "forged-artifact",
        projectionKey: codingAcceptedOutputProjectionKey("coding_result", "forged-task"),
        outputKey: "coding_result",
        kind: "application/json",
        contentHash: "forged-content",
        mediaType: "application/json",
        byteLength: 2,
        value: "{}",
      }],
      omittedCount: 0,
    }),
  }).register(forgedOutputsApp);
  const forgedRun = await forgedOutputsApp.request(
    `/api/v2/coding/runs/coding-integration?job=${job.id}`,
  );
  assert.equal(forgedRun.status, 503);
  assert.deepEqual(await forgedRun.json(), {
    schema: "roster.coding.v2",
    ok: false,
    error: "coding accepted output projection is unavailable",
  });
});

test("coding run panel surfaces only the bounded accepted final summary", () => {
  const finalReport = JSON.stringify({
    status: "verified",
    summary: "Created contributor-facing repository documentation.",
    changedFiles: ["docs/README.md", "docs/repository-guide.md"],
    validation: ["docs-only targeted check"],
    frontierHash: "frontier-docs",
  });
  const artifact = inlineArtifactPublishedEvent({
    runId: "coding-result",
    artifactId: "artifact-final",
    origin: "task",
    outputKey: "final_report",
    taskId: "implement",
    nodeId: "worker",
    kind: "final_report",
    inputVersions: {},
  }, finalReport);
  const state = {
    ...initialOrchestrationState,
    nodes: {
      worker: {
        id: "worker",
        name: "Implementation Engineer",
        capabilities: ["implement", "remediate"],
        runtime: { kind: "pi-agent", metadata: { model: "openai-codex/gpt-5.6-luna" } },
        status: "active" as const,
        updatedAt: 1,
      },
      reviewer: {
        id: "reviewer",
        name: "Quality Steward",
        capabilities: ["review", "certify"],
        runtime: { kind: "claude-code", metadata: { model: "opus" } },
        status: "active" as const,
        updatedAt: 1,
      },
    },
    nodeBindings: {
      worker: {
        bindingId: "binding-worker-epoch-2",
        nodeId: "worker",
        runtime: { kind: "pi-agent", metadata: { model: "openai-codex/gpt-5.6-luna" } },
        epoch: 2,
        topologyVersion: "coding-topology",
        sessionId: "pi-session-7",
        updatedAt: 2,
      },
    },
    taskGraph: projectedTaskGraph("coding-result", [{
      taskId: "implement",
      nodeId: "worker",
      capability: "implement",
      status: "accepted",
    }, {
      taskId: "review",
      nodeId: "reviewer",
      capability: "review",
      status: "accepted",
      dependencies: [{ taskId: "implement", condition: "accepted" }],
    }]),
    artifacts: {
      [artifact.artifactId]: { ...artifact, updatedAt: 1 },
    },
    outputs: {
      final_report: {
        outputKey: "final_report",
        artifactId: artifact.artifactId,
        contentHash: artifact.contentHash,
        origin: "task" as const,
        taskId: "implement",
        updatedAt: 1,
      },
    },
  };

  const html = codingRunPanelHtml({
    state,
    events: [artifact],
    runId: "coding-result",
    job: {
      id: "coding-result-job",
      executionId: "coding-result-execution",
      status: "completed",
      objective: "Create contributor-facing repository documentation and independently review it.",
      branch: "roster/coding-result",
      commit: "a".repeat(40),
      baselineBranch: "main",
      baselineCommit: "b".repeat(40),
      integration: { integrated: false, canIntegrate: true, currentBranch: "main" },
      improvement: {
        snapshotHash: "c".repeat(64),
        generationId: "runtime_generation_1234567890abcdef123456789abc",
      },
    },
    repository: {
      path: "/workspace/theorem",
      remote: "git@github.com:example/theorem.git",
      account: "example",
      branch: "main",
      headCommit: "b".repeat(40),
      workingTree: "clean",
      changedFiles: 0,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
    },
    runtimeLogs: [{
      runId: "coding-result",
      nodeId: "worker",
      taskId: "implement",
      runtime: "pi-agent",
      stream: "stdout",
      text: "Tool edit: docs/repository-guide.md\n",
      sequence: 7,
      at: Date.UTC(2026, 6, 13, 12, 30),
      truncated: false,
    }],
  });
  const timelineStart = html.indexOf('data-slot="room-timeline"');
  const contextCastStart = html.indexOf('data-slot="context-cast"');
  const resultStart = html.indexOf("Created contributor-facing repository documentation.");
  assert.ok(timelineStart > 0);
  assert.ok(contextCastStart > timelineStart);
  assert.ok(
    resultStart > timelineStart && resultStart < contextCastStart,
    "the final result belongs inline in the collaboration timeline",
  );
  assert.match(html, /data-conversation-kind="artifact-card"[^>]*aria-label="Coding run result"/);
  assert.match(html, /Created contributor-facing repository documentation/);
  assert.match(html, /class="coding-mission-bar" data-coding-team-brief data-run-presentation data-state="done"/);
  assert.match(html, /Repository collaboration/);
  assert.doesNotMatch(html, /Create contributor-facing repository documentation and independently review it\./);
  assert.match(html, /role="list" aria-label="Specialists selected for this run"/);
  assert.match(html, /Implementation Engineer[\s\S]*Accepted[\s\S]*Quality Steward[\s\S]*Accepted/);
  assert.match(html, /Every assigned contribution is accepted and attached to this run\./);
  assert.match(html, /class="coding-mission-action coding-mission-action-primary" href="\/coding\/runs\/coding-result\/review\?job=coding-result-job">Review Changes/);
  assert.match(html, /data-coding-task-outcome><b>Outcome<\/b>Created contributor-facing repository documentation\./);
  assert.match(html, /data-coding-task-outcome><b>Outcome<\/b>Accepted outcome recorded\./);
  assert.match(html, /data-workbench-target="files"[^>]*>Delivery<\/button>/);
  assert.doesNotMatch(html, /docs\/repository-guide\.md/);
  assert.doesNotMatch(html, /docs-only targeted check/);
  assert.doesNotMatch(html, /data-details-key="result-(?:files|validation)"/);
  assert.match(html, /Review changes/);
  assert.match(html, /class="coding-review-action"/);
  assert.match(html, /\/coding\/runs\/coding-result\/review\?job=coding-result-job/);
  assert.match(html, />Export record<\/a>/);
  assert.match(html, /\/coding\/runs\/coding-result\/collaboration\.md\?job=coding-result-job/);
  assert.doesNotMatch(html, /Propose runtime improvement|\/improvements\?run=/);
  assert.match(html, /Admission-pinned/);
  assert.match(html, /cccccccccccc/);
  assert.match(html, /data-slot="git-handoff" data-state="ready"/);
  assert.match(html, /Git handoff/);
  assert.match(html, /git@github.com:example\/theorem.git/);
  assert.match(html, /0 ahead · 0 behind/);
  assert.match(html, /Merge certified code into main/);
  assert.match(html, /explicit local fast-forward/);
  assert.match(html, /never force-pushes/);
  assert.match(html, /Implementation Engineer/);
  assert.match(html, /Pi Code · GPT-5\.6 Luna/);
  assert.match(html, /Quality Steward/);
  assert.doesNotMatch(html, /\b(?:Kai|Mira|Rowan)\b/);
  assert.match(html, /Claude Code · Opus/);
  assert.match(html, /1 update/);
  assert.match(html, /<button type="button" class="coding-agent-link" data-coding-agent-trigger/);
  assert.match(html, /aria-controls="coding-agent-detail-worker" aria-expanded="false"/);
  assert.match(html, /id="coding-agent-detail-worker"/);
  assert.match(html, /data-coding-agent-layout="inspector-v2"/);
  assert.match(html, /data-coding-agent-close[^>]+aria-label="Close Implementation Engineer, Specialist details"/);
  assert.match(html, /Receipt history/);
  assert.match(html, /Process logs/);
  assert.doesNotMatch(html, /Tool edit: docs\/repository-guide\.md/);
  assert.match(html, /Live|Retained/);
  assert.doesNotMatch(html, /pi-session-7/);
  assert.match(html, /final_report published by worker/i);
  assert.match(html, /Terminal output is bounded and process-local/);
  assert.match(html, /aria-label="Inspect Implementation Engineer, Specialist"/);
  assert.match(html, /Active peers/);
  assert.match(html, /Logs ›/);
  assert.match(html, /refreshes every ~1s/);
  assert.match(html, /data-agent-tone="quality"/);

  const parallelHtml = codingRunPanelHtml({
    state: {
      ...state,
      taskGraph: projectedTaskGraph("coding-parallel", [{
        taskId: "implement",
        nodeId: "worker",
        capability: "implement",
        status: "running",
      }, {
        taskId: "review-security",
        nodeId: "reviewer",
        capability: "review",
        status: "running",
      }]),
      outputs: {},
    },
    events: [],
    runId: "coding-parallel",
    job: {
      id: "coding-parallel-job",
      status: "running",
      objective: "Implement and review independent repository concerns in parallel.",
    },
  });
  assert.match(parallelHtml, /class="coding-mission-bar" data-coding-team-brief data-run-presentation data-state="working"/);
  assert.match(parallelHtml, /2 steps are running independently in parallel\./);
  assert.match(parallelHtml, /Open Work/);
  assert.match(parallelHtml, /aria-controls="coding-context-cast"/);

  const queuedHtml = codingRunPanelHtml({
    state: {
      ...state,
      taskGraph: projectedTaskGraph("coding-queued-specialists", [{
        taskId: "investigate-runtime",
        nodeId: "worker",
        capability: "investigate",
        status: "ready",
      }, {
        taskId: "investigate-api",
        nodeId: "reviewer",
        capability: "investigate",
        status: "ready",
      }]),
      outputs: {},
    },
    events: [],
    runId: "coding-queued-specialists",
    job: {
      id: "coding-queued-specialists-job",
      status: "running",
      objective: "Inspect two repository concerns.",
    },
  });
  assert.match(queuedHtml, /2 steps are queued and waiting for runtime capacity\./);
  assert.doesNotMatch(queuedHtml, /working independently in parallel/);

  const activeHandoff = codingRunPanelHtml({
    state,
    events: [artifact],
    runId: "coding-result",
    job: { id: "coding-result-job", status: "running", branch: "roster/coding-result" },
  });
  assert.doesNotMatch(activeHandoff, /Export record/);

  const noChangeHandoff = codingRunPanelHtml({
    state,
    events: [artifact],
    runId: "coding-result",
    job: {
      id: "coding-result-noop-job",
      status: "completed",
      branch: "roster/coding-result-noop",
      commit: "b".repeat(40),
      baselineBranch: "main",
      baselineCommit: "b".repeat(40),
      noChanges: true,
      gitOutcome: "no_changes",
    },
  });
  assert.match(noChangeHandoff, /data-slot="git-handoff" data-state="no-changes"/);
  assert.match(noChangeHandoff, /Nothing to integrate/);
  assert.doesNotMatch(noChangeHandoff, /data-focus-key="git-integrate"/);
  assert.doesNotMatch(noChangeHandoff, /data-focus-key="git-review"/);

  const review = codingReviewShell({
    showGlobalNavigation: false,
    state,
    runId: "coding-result",
    workspaceId: "workspace_0123456789abcdef0123",
    job: {
      id: "coding-result-job",
      status: "completed",
      branch: "roster/coding-result",
      commit: "a".repeat(40),
      baselineBranch: "codex/coding-run-branches",
      baselineCommit: "b".repeat(40),
      integration: { integrated: true, canIntegrate: false, currentBranch: "main" },
    },
    diff: {
      summary: "1 file changed",
      files: [{ status: "M", path: "docs/README.md" }],
      truncated: false,
      patch: {
        text: [
          "diff --git a/docs/README.md b/docs/README.md",
          "index 1111111..2222222 100644",
          "--- a/docs/README.md",
          "+++ b/docs/README.md",
          "@@ -1,2 +1,2 @@",
          " # Guide",
          "-Old guidance",
          "+New guidance",
        ].join("\n"),
        bytes: 180,
        truncated: false,
      },
    },
    nonce: "review-test",
  });
  assert.match(review, /Certified &amp; merged/);
  assert.doesNotMatch(review, /aria-label="Primary navigation"/);
  assert.doesNotMatch(review, /class="top-navbar-brand" href="\/monitor"/);
  assert.match(review, /Every executable task completed/);
  assert.match(review, /Present on main/);
  assert.match(review, /docs\/README\.md/);
  assert.match(review, /data-kind="addition"/);
  assert.match(review, /data-kind="deletion"/);
  assert.match(review, /Back to conversation/);
  assert.match(review, /href="\/coding\?workspace=workspace_0123456789abcdef0123&amp;run=coding-result&amp;job=coding-result-job"/);
  assert.match(review, /class="coding-review-file-rail"/);
  assert.match(review, /data-layout="coding-review"/);
  assert.match(review, /data-ui-family="roster-agent"/);
  assert.match(review, /aria-label="Changed files"/);
  assert.match(review, /data-review-summary/);
  assert.match(review, /data-review-details/);
  assert.match(review, /href="#coding-review-file-1"/);
  assert.match(review, /id="coding-review-file-1"/);
  assert.match(review, /class="coding-review-diff-scroll"/);
  assert.match(review, /class="coding-review-details"/);
  assert.match(review, /data-coding-task-outcome><b>Outcome<\/b>Created contributor-facing repository documentation\./);
  assert.match(review, /data-coding-task-outcome><b>Outcome<\/b>Accepted outcome recorded\./);
  assert.match(review, /data-review-progress/);
  assert.match(review, /<progress class="coding-review-progress" data-review-progress-bar/);
  assert.doesNotMatch(review, /\sstyle="/);
  assert.match(review, /data-review-filter/);
  assert.match(review, /data-review-next/);
  assert.match(review, /data-review-viewed/);
  assert.match(review, /data-review-changes-only/);
  assert.match(review, /data-review-wrap/);
  assert.match(review, /roster\.review\.viewed\.v1:/);
  assert.match(review, /content-visibility:auto/);
  assert.doesNotMatch(review, /class="coding-review-integrate"/);

  const readyReview = codingReviewShell({
    state,
    runId: "coding-result",
    job: {
      id: "coding-result-job",
      status: "completed",
      branch: "roster/coding-result",
      commit: "a".repeat(40),
      baselineBranch: "main",
      baselineCommit: "b".repeat(40),
      integration: { integrated: false, canIntegrate: true },
    },
    diff: {
      summary: "1 file changed",
      files: [{ status: "M", path: "docs/README.md" }],
      truncated: false,
      patch: { text: "diff --git a/docs/README.md b/docs/README.md", bytes: 51, truncated: false },
    },
    nonce: "ready-review-test",
  });
  assert.match(readyReview, /class="coding-review-integrate" action="\/coding\/runs\/coding-result\/integrate" method="post"/);
  assert.match(readyReview, /data-review-primary-action/);
  assert.match(readyReview, /name="jobId" value="coding-result-job"/);
  assert.match(readyReview, />Merge into main <span aria-hidden="true">→<\/span><\/button>/);

  const mobileBranch = "release/certified-customer-migration-with-a-valid-and-deliberately-long-target-name";
  const mobileReview = codingReviewShell({
    state,
    runId: "coding-result",
    job: {
      id: "coding-result-job",
      status: "completed",
      branch: "roster/coding-result",
      commit: "a".repeat(40),
      baselineBranch: mobileBranch,
      baselineCommit: "b".repeat(40),
      integration: { integrated: false, canIntegrate: true },
    },
    diff: {
      summary: "1 file changed",
      files: [{ status: "M", path: "docs/README.md" }],
      truncated: false,
      patch: { text: "diff --git a/docs/README.md b/docs/README.md", bytes: 51, truncated: false },
    },
    nonce: "mobile-review-test",
  });
  assert.match(mobileReview, /data-review-primary-action/);
  assert.match(mobileReview, new RegExp(`Merge into ${mobileBranch}`));
  assert.match(mobileReview, /@media\(max-width:639px\)\{\.coding-review-page\{grid-template-rows:auto auto minmax\(0,1fr\)!important\}/);
  assert.match(mobileReview, /\.coding-review-toolbar\{height:auto;min-height:56px;flex-wrap:wrap/);
  assert.match(mobileReview, /\.coding-review-details\{display:block!important;grid-column:2/);
  assert.match(mobileReview, /\.coding-review-integrate\{min-width:0;width:100%;grid-column:1\/-1/);
  assert.match(mobileReview, /\.coding-review-integrate button\{width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis/);
  assert.match(mobileReview, /\.coding-review-back\{width:44px;height:44px/);
  assert.match(mobileReview, /\.coding-review-details summary,\.coding-review-context button,\.coding-review-integrate button\{min-height:44px!important/);
  assert.match(mobileReview, /@media\(pointer:coarse\)\{\.coding-review-back\{min-width:44px;min-height:44px\}/);
  assert.match(review, /--surface-canvas:#11120f/);
  assert.match(review, /--radius-control:7px;--radius-card:10px;--radius-overlay:14px/);
  assert.doesNotMatch(review, /coding-review-card|coding-review-sidebar|coding-review-summary/);
  assert.match(review, /@media\(max-width:900px\)\{/);
  assert.match(review, /body\{min-width:0\}/);
  assert.match(review, /@media\(max-width:640px\)\{/);
  assert.match(review, /\.coding-review-file-rail\{display:none\}/);
  assert.match(review, /<script nonce="review-test">/);
  assert.match(review, /roster\.theme\.preference\.v2/);
  assert.match(review, /class="coding-review-page" data-layout="coding-review" data-slot="agent-shell"/);
  assert.match(review, /\.coding-review-page\{width:100vw;max-width:none;height:100dvh;display:grid;grid-template-rows:56px 44px minmax\(0,1fr\);border-radius:0;background:var\(--surface-canvas\)\}/);
  assert.match(review, /\.coding-review-code\{font-size:12px;line-height:1\.55\}/);
  assert.match(review, /\.coding-review-toolbar\{height:56px;padding:0 16px\}/);
  assert.match(review, /\.coding-review-context\{height:44px;padding:0 16px\}/);
  assert.match(review, /\.coding-review-workspace\{grid-template-columns:240px minmax\(0,1fr\)\}/);
  assert.match(review, /@media\(max-width:639px\)\{\.coding-review-workspace\{grid-template-columns:minmax\(0,1fr\)\}\.coding-review-file-rail\{display:none\}/);
  assert.doesNotMatch(review, /border-radius:var\(--radius-overlay\)[^}]*coding-review-page/);
  assert.match(review, /data-slot="review-toolbar"/);
  assert.match(review, /data-slot="agent-main"/);
  assert.match(review, /<select[^>]+aria-label="Theme"/);

  const interruptedState = {
    ...withGraphStatus(state, "running"),
  };
  const interruptedHtml = codingRunPanelHtml({
    state: interruptedState,
    events: [artifact],
    runId: "coding-result",
    job: { id: "coding-job", status: "failed", error: "worker lease expired" },
  });
  assert.match(interruptedHtml, /The team stopped before this change could be certified/);
  assert.match(interruptedHtml, /Not certified/);
  assert.match(interruptedHtml, /without an accepted certified frontier/);
  assert.match(interruptedHtml, /Some work may be saved, but it has not been accepted as a finished change/);
  assert.match(interruptedHtml, /Human action/);
  assert.match(interruptedHtml, /No human answer is requested\./);
  assert.doesNotMatch(interruptedHtml, /worker lease expired/);
  assert.match(interruptedHtml, /Review the retained details if needed/);
  assert.match(interruptedHtml, /retry from the repository’s current state/);
  assert.match(interruptedHtml, />Retry Run<\/button>/);
  assert.doesNotMatch(interruptedHtml, /data-coding-human-reply/);
});

test("planner recovery and peer proposal questions do not request a human reply", () => {
  const plannerMessage = createCodingConversationMessage({
    conversationId: "coding-planner-recovery",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Fix the repository",
    createdAt: 9,
  });
  const plannerRoute = createCodingConversationRoute({
    conversationId: "coding-planner-recovery",
    inReplyTo: plannerMessage.messageId,
    disposition: "needs_clarification",
    selectedNodeIds: ["human.operator"],
    tags: ["intent:clarification", "risk:planner-unavailable"],
    questions: ["Retry after checking model connectivity."],
    rationale: "The conversation planner is unavailable.",
    confidence: 0,
    createdAt: 10,
  });
  const recoveryHtml = codingRunPanelHtml({
    state: initialOrchestrationState,
    events: [codingConversationRouteEvent(plannerRoute)],
    runId: "coding-planner-recovery",
  });
  assert.match(recoveryHtml, /Human action/);
  assert.match(recoveryHtml, /No human answer is requested\./);
  assert.match(recoveryHtml, /Retry after checking model connectivity\./);
  assert.doesNotMatch(recoveryHtml, /The conversation planner is unavailable\./);
  assert.doesNotMatch(recoveryHtml, /data-coding-human-reply/);
  assert.doesNotMatch(recoveryHtml, /Needs your answer/);
  const recoveryProgress = codingRunProgress({
    state: initialOrchestrationState,
    events: [
      codingConversationMessageEvent(plannerMessage),
      codingConversationRouteEvent(plannerRoute),
    ],
    runId: "coding-planner-recovery",
  });
  assert.equal(recoveryProgress?.state, "failed");
  assert.equal(recoveryProgress?.label, "Needs attention");
  assert.match(recoveryProgress?.headline ?? "", /No work started/);

  const reviewerMessage = createCodingConversationMessage({
    conversationId: "coding-reviewer-recovery",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Make this reviewed change",
    createdAt: 11,
  });
  const reviewerRoute = createCodingConversationRoute({
    conversationId: "coding-reviewer-recovery",
    inReplyTo: reviewerMessage.messageId,
    disposition: "needs_clarification",
    selectedNodeIds: ["human.operator"],
    tags: ["intent:clarification", "risk:reviewer-unavailable"],
    questions: ["Enable or select a saved review-capable workspace node, then retry this request."],
    rationale: "Reviewed coding requires an explicitly selected saved reviewer.",
    confidence: 1,
    createdAt: 12,
  });
  const reviewUnavailableHtml = codingRunPanelHtml({
    state: initialOrchestrationState,
    events: [
      codingConversationMessageEvent(reviewerMessage),
      codingConversationRouteEvent(reviewerRoute),
    ],
    runId: "coding-reviewer-recovery",
  });
  assert.match(reviewUnavailableHtml, /data-state="requested"/);
  assert.match(reviewUnavailableHtml, /data-coding-workbench-shortcut="team"/);
  assert.doesNotMatch(reviewUnavailableHtml, /Stopped before the first step[\s\S]*Retry Run/);

  const verboseProposalSummary = `The peer needs repository evidence from another specialist. ${"Supporting context belongs in the expandable record. ".repeat(8)}End of exact proposal.`;
  const proposalEvent = inlineArtifactPublishedEvent({
    runId: "coding-peer-question",
    artifactId: "artifact-peer-question",
    origin: "input",
    outputKey: "collaboration_proposal_workspace-quality",
    nodeId: "workspace.quality",
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "proposal",
    summary: verboseProposalSummary,
    recommendations: [{
      subjectId: "validation",
      recommendation: "Ask the runtime peer for the existing smoke contract.",
      rationale: "This remains peer-scoped.",
      evidence: ["tests/smoke/runtime.test.ts"],
      confidence: 0.9,
    }],
    questions: ["Which existing runtime smoke covers this boundary?"],
  }));
  const proposalState = reduceOrchestration(initialOrchestrationState, proposalEvent, 20);
  const proposalHtml = codingRunPanelHtml({
    state: proposalState,
    events: [proposalEvent],
    runId: "coding-peer-question",
  });
  assert.doesNotMatch(proposalHtml, /data-generative-ui-kind|data-source-kind="accepted-summary"/);
  assert.doesNotMatch(proposalHtml, /The peer needs repository evidence from another specialist/);
  assert.doesNotMatch(proposalHtml, /tests\/smoke\/runtime\.test\.ts/);
  assert.doesNotMatch(proposalHtml, /Human action/);
  assert.doesNotMatch(proposalHtml, /data-coding-human-reply/);
});

test("coding work feed keeps the artifact-time model identity and surfaces reported token coverage", () => {
  const runId = "coding-runtime-history";
  const workerId = "workspace.implementation";
  const pack: DomainPack = {
    id: "coding-runtime-history",
    version: "1",
    policyVersion: "coding-runtime-history-v1",
    coordinatorId: "coordinator",
    capabilities: [
      { id: "coordinate", description: "Coordinate the run." },
      { id: "propose", description: "Propose the implementation." },
    ],
    nodes: [
      {
        id: "coordinator",
        name: "Roster, Collaboration Facilitator",
        capabilities: ["coordinate"],
        runtime: { kind: "roster-native", profile: "coding.coordinator" },
      },
      {
        id: workerId,
        name: "Kai, Implementation Engineer",
        capabilities: ["propose"],
        runtime: {
          kind: "codex-cli",
          metadata: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        },
      },
    ],
    limits: { maxNodes: 4, maxTasks: 8, maxParallel: 2, maxDepth: 2 },
  };
  const configured = orchestrationConfiguredEvent(runId, pack);
  const codexBinding = nodeRuntimeBoundEvent({
    runId,
    nodeId: workerId,
    runtime: {
      kind: "codex-cli",
      metadata: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    },
    epoch: 1,
    topologyVersion: "topology-runtime-history",
  });
  const graph: OrchestrationEvent = {
    type: "task.graph.projected",
    runId,
    graph: {
      ...projectedTaskGraph(runId, [
        { taskId: "propose-implementation", nodeId: workerId, capability: "propose", status: "accepted" },
        { taskId: "peer-response", nodeId: workerId, capability: "propose", status: "accepted" },
      ]),
      acceptedTokens: 350,
    },
  };
  const proposal = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-runtime-history-proposal",
    origin: "task",
    outputKey: "collaboration_proposal_workspace-implementation",
    taskId: "propose-implementation",
    nodeId: workerId,
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "proposal",
    summary: "Use the bounded implementation path.",
    recommendations: [{
      subjectId: "implementation-approach",
      recommendation: "Keep the change inside the existing runtime boundary.",
      rationale: "The repository already owns the surrounding contract.",
      evidence: ["src/engine/runtime/node-runtime.ts"],
      confidence: 0.98,
    }],
    questions: [],
  }));
  const shellBinding = nodeRuntimeBoundEvent({
    runId,
    nodeId: workerId,
    runtime: { kind: "shell", command: ["npm", "run", "verify"] },
    epoch: 2,
    topologyVersion: "topology-runtime-history",
  });
  const events = [
    configured,
    codexBinding,
    graph,
    proposal,
    shellBinding,
  ];
  let state = [configured, codexBinding]
    .reduce((current, event, index) => reduceOrchestration(current, event, index + 1), initialOrchestrationState);
  state = {
    ...state,
    taskGraph: {
      ...projectedTaskGraph(runId, [
        { taskId: "propose-implementation", nodeId: workerId, capability: "propose", status: "accepted" },
        { taskId: "peer-response", nodeId: workerId, capability: "propose", status: "accepted" },
      ]),
      acceptedTokens: 350,
    },
  };
  state = reduceOrchestration(state, proposal, 3);
  state = reduceOrchestration(state, shellBinding, 4);
  const html = codingRunPanelHtml({ state, events, runId });

  assert.match(html, /data-coding-social-row[^>]*data-source-kind="accepted-summary"[^>]*data-author-node-id="workspace\.implementation"[^>]*data-task-id="propose-implementation"/);
  assert.match(html, /<strong>Kai<\/strong><span class="coding-agent-role">Implementation Engineer<\/span>/);
  assert.match(html, /<dt>Source<\/dt><dd>accepted-summary<\/dd>/);
  assert.match(html, /<dt>Durability<\/dt><dd>durable<\/dd>/);
  assert.match(html, /<strong>350 budget tokens<\/strong> · cached input excluded/);
  assert.match(html, /350 budgeted tokens · cached input excluded/);
  assert.match(html, /Host validation · No LLM/);
  assert.doesNotMatch(html, /<dt>Runtime<\/dt><dd>Host validation<\/dd>/);
  assert.match(html, /<div class="coding-run-team-label"><span>Active peers<\/span><strong>1<\/strong><\/div>/);
  assert.doesNotMatch(html, /Inspect Roster|Roster, Collaboration Facilitator/);
});

test("coding center pane keeps durable chat visible and moves operational updates into optional activity", () => {
  const message = createCodingConversationMessage({
    conversationId: "coding-work-feed",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui", externalId: "work-feed-message" },
    text: "Group this work once.",
    createdAt: 10,
  });
  const duplicateDelivery = createCodingConversationMessage({
    conversationId: "coding-work-feed",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui", externalId: "work-feed-delivery-copy" },
    text: "Group this work once.",
    tags: ["delivery:queued"],
    createdAt: 11,
  });
  const uniqueDelivery = createCodingConversationMessage({
    conversationId: "coding-work-feed",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui", externalId: "work-feed-unique-delivery" },
    text: "Keep this distinct follow-up visible.",
    tags: ["delivery:queued"],
    createdAt: 12,
  });
  const worker = {
    id: "workspace.quality",
    name: "Mira, Quality Reviewer",
    capabilities: ["review"],
    status: "active" as const,
    updatedAt: 11,
    metadata: { specialty: "quality" },
  };
  const messageEvent = codingConversationMessageEvent(message);
  const internalFrontier = inlineArtifactPublishedEvent({
    runId: "coding-work-feed",
    artifactId: "artifact-room-frontier",
    origin: "input",
    outputKey: "room_git_frontier_1",
    nodeId: "coordinator",
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    schema: "roster.coding-room-git-frontier.v1",
    branch: "roster/rooms/example",
    commit: "a".repeat(40),
  }));
  const events: ReadonlyArray<OrchestrationEvent> = [
    ...Array.from({ length: 14 }, () => messageEvent),
    codingConversationMessageEvent(duplicateDelivery),
    codingConversationMessageEvent(uniqueDelivery),
    internalFrontier,
    { type: "node.spawned", runId: "coding-work-feed", node: worker, reason: "objective demand" },
    {
      type: "task.graph.projected",
      runId: "coding-work-feed",
      graph: projectedTaskGraph("coding-work-feed", [{
        taskId: "review-workspace-quality",
        nodeId: worker.id,
        capability: "review",
        status: "running",
      }]),
    },
  ];
  const viewState = reduceOrchestration({
      ...initialOrchestrationState,
      nodes: { ...initialOrchestrationState.nodes, [worker.id]: worker },
      taskGraph: projectedTaskGraph("coding-work-feed", [{
        taskId: "review-workspace-quality",
        nodeId: worker.id,
        capability: "review",
        status: "running",
      }]),
    }, internalFrontier, events.length + 1);
  const html = codingRunPanelHtml({
    state: viewState,
    events,
    runId: "coding-work-feed",
  });
  assert.match(html, /aria-label="Room conversation"/);
  assert.match(html, /data-coding-social-row[^>]*data-source-kind="message"[^>]*data-author-node-id="human\.operator"/);
  assert.doesNotMatch(html, /data-coding-external-id="artifact-room-frontier"/,
    "internal accepted artifacts stay in Evidence instead of impersonating chat messages");
  assert.equal(html.match(/Group this work once\./g)?.length, 2, "each distinct durable message identity renders once");
  assert.equal(html.match(/Keep this distinct follow-up visible\./g)?.length, 1, "a unique queued follow-up remains visible");
  assert.match(html, /Message queued for the next safe handoff/);
  assert.match(html, /data-coding-island="team-activity"[\s\S]*aria-label="Team activity log"/);
  assert.match(html, /<strong>Team activity<\/strong>/);
  const shell = codingShell({
    state: initialOrchestrationState,
    events: [],
    nonce: "team-activity-spacing",
    repositoryPath: process.cwd(),
    gitRemote: "",
    gitAccount: "",
    workspaceProfile: reviewCodingWorkspaceSnapshot({
      repositoryRoot: process.cwd(),
      files: ["package.json"],
      manifests: [{ path: "package.json", content: "{}" }],
      reviewedAt: 1,
    }),
  });
  assert.match(shell, /\.coding-page \.coding-workbench-panel>\.coding-team-activity\{grid-column:1;margin:0\}/,
    "the Team activity card drops page-level side margins inside the Workbench panel");
  assert.match(shell, /\.coding-page \.coding-workbench-panel>\.coding-coordination\{max-height:none;grid-auto-rows:max-content;align-content:start;overflow:visible;box-shadow:none\}/,
    "the Plan card keeps its natural height so the Workbench scrolls without clipping the task DAG");
  assert.match(shell, /\[data-coding-room-transcript\]/);
  assert.match(shell, /\.coding-page \.coding-social-row\{/);
  assert.doesNotMatch(html, /data-conversation-kind="artifact-card"/);
  assert.doesNotMatch(html, /Technical details/);
  assert.match(html, /data-slot="context-cast"/);
  assert.ok(html.indexOf('data-coding-island="team-activity"') > html.indexOf('data-slot="context-cast"'),
    "operational activity stays behind Evidence instead of interrupting chat history");
  assert.match(html, /Node Spawned/);
  assert.match(html, /Review Workspace Quality/);
  assert.match(html, /Report and receipts · 19/);
  assert.match(html, /#1 · artifact\.published/);
  assert.match(html, /#19 · task\.graph\.projected/);
  assert.doesNotMatch(html, /I’m joining as the Quality specialist/);
  assert.doesNotMatch(html, /I’m independently inspecting the objective/);
});

test("coding conversation makes parallel ownership and handoffs visible without opening Work", () => {
  const implementer = {
    id: "workspace.implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["implement"],
    runtime: { kind: "codex-cli" as const, metadata: { model: "gpt-5.6-sol" } },
    status: "active" as const,
    updatedAt: 10,
    metadata: { givenName: "Kai", displayRole: "Implementation Engineer" },
  };
  const reviewer = {
    id: "workspace.quality",
    name: "Mira, Quality Reviewer",
    capabilities: ["review"],
    runtime: { kind: "claude-code" as const, metadata: { model: "opus" } },
    status: "active" as const,
    updatedAt: 10,
    metadata: { givenName: "Mira", displayRole: "Quality Reviewer" },
  };
  const taskGraph = projectedTaskGraph("coding-visible-coordination", [
    {
      taskId: "implement-change",
      nodeId: implementer.id,
      capability: "implement",
      status: "running",
    },
    {
      taskId: "review-change",
      nodeId: reviewer.id,
      capability: "review",
      status: "pending",
      dependencies: [{ taskId: "implement-change", condition: "accepted" }],
    },
  ]);
  const html = codingRunPanelHtml({
    state: {
      ...initialOrchestrationState,
      nodes: {
        [implementer.id]: implementer,
        [reviewer.id]: reviewer,
      },
      taskGraph,
    },
    events: [{
      type: "task.graph.projected",
      runId: taskGraph.runId,
      graph: taskGraph,
    }],
    runId: taskGraph.runId,
    job: {
      id: "job-visible-coordination",
      status: "running",
      branch: "roster/visible-coordination",
    },
  });

  const messagePanel = html.indexOf('data-slot="room-timeline"');
  const coordination = html.indexOf('data-coding-island="coordination-dock"');
  const workPanel = html.indexOf('data-slot="context-cast"');
  assert.ok(messagePanel > 0 && workPanel > messagePanel && coordination > workPanel,
    "the operational work record lives inside optional run details, after the chat timeline");
  assert.doesNotMatch(html.slice(messagePanel, workPanel), /data-coding-team-snapshot/);
  assert.doesNotMatch(html.slice(messagePanel, workPanel), /I’m ready to review the work/);
  assert.doesNotMatch(html.slice(messagePanel, workPanel), /Collaboration plan/);
  assert.match(html, /Run details/);
  assert.match(html, /Collaboration plan/);
  assert.match(html, /aria-label="Collaboration plan ordered by task dependencies"/);
  assert.match(html, /data-coding-coordination-dag/);
  assert.match(html, /aria-label="Live dynamic task DAG"/);
  assert.match(html, /2 tasks · 1 edges/);
  assert.match(html, /data-task-id="implement-change" data-state="running"/);
  assert.match(html, /data-task-id="review-change" data-state="pending"/);
  assert.match(html, /<span>From<\/span>Implement Change/);
  assert.match(html, /data-stage="1"><span>Step 1<\/span><small>Starting work<\/small>/);
  assert.match(html, /data-stage="2"><span>Step 2<\/span><small>After accepted handoff<\/small>/);
  assert.match(html, /1 working now/);
  assert.match(html, /Each agent keeps its own context; accepted outputs become the next agent’s input\./);
  assert.match(html, /data-coding-coordination-count="working">1<\/b> working/);
  assert.match(html, /data-coding-coordination-count="waiting">1<\/b> waiting/);
  assert.match(html, /Kai/);
  assert.match(html, /is implementing the change/);
  assert.match(html, /Implementation Engineer<\/small><span class="coding-coordination-execution" data-coding-agent="Codex CLI" data-coding-model="GPT-5\.6 Sol">/);
  assert.match(html, /Quality Reviewer<\/small><span class="coding-coordination-execution" data-coding-agent="Claude Code" data-coding-model="Opus">/);
  assert.doesNotMatch(html, /class="coding-coordination-context"/);
  assert.match(html, /Next Mira/);
  assert.match(html, /Waiting for Kai/);
  assert.match(html, /Waiting on accepted work from Kai/);
  assert.match(html, /data-coding-coordination-agent="coding-agent-detail-workspace-implementation"/);
  assert.match(html, /View details/);
  assert.match(html.slice(workPanel), /data-coding-island="coordination-dock"/);
  assert.match(html, /Identity, memory &amp; placement/);
  assert.match(html, /<dt>Context boundary<\/dt><dd>Own task inputs · accepted dependency outputs<\/dd>/);
  assert.match(html, /<dt>Memory scopes<\/dt><dd>Role profile · room history · workspace memory · run history<\/dd>/);

  const acceptedInputGraph = projectedTaskGraph("coding-visible-coordination-ready", [
    {
      taskId: "implement-change",
      nodeId: implementer.id,
      capability: "implement",
      status: "accepted",
    },
    {
      taskId: "review-change",
      nodeId: reviewer.id,
      capability: "review",
      status: "ready",
      dependencies: [{ taskId: "implement-change", condition: "accepted" }],
    },
  ]);
  const readyHtml = codingRunPanelHtml({
    state: {
      ...initialOrchestrationState,
      nodes: {
        [implementer.id]: implementer,
        [reviewer.id]: reviewer,
      },
      taskGraph: acceptedInputGraph,
    },
    events: [],
    runId: acceptedInputGraph.runId,
    job: { id: "job-visible-coordination-ready", status: "running" },
  });
  assert.match(readyHtml, /Queued to Review/);
  assert.doesNotMatch(readyHtml, /Waiting for Kai/);
  const readyPlan = readyHtml.slice(readyHtml.indexOf('data-coding-island="coordination-dock"'));
  assert.ok(readyPlan.indexOf('data-node-id="workspace.implementation"')
    < readyPlan.indexOf('data-node-id="workspace.quality"'),
    "live status changes do not reorder the dependency plan");
  assert.match(readyPlan, /Ordered by handoff · live status does not reorder steps/);
});

test("focused UI work shows interface direction before implementation", () => {
  const interfaceDesigner = {
    id: "workspace.ui",
    name: "Sora, Interface Designer",
    capabilities: ["review", "propose"],
    runtime: { kind: "pi-agent" as const, metadata: { model: "gpt-5.6-luna" } },
    status: "active" as const,
    updatedAt: 10,
    metadata: { givenName: "Sora", displayRole: "Interface Designer", specialty: "ui" },
  };
  const implementer = {
    id: "workspace.implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["implement"],
    runtime: { kind: "pi-agent" as const, metadata: { model: "gpt-5.6-luna" } },
    status: "active" as const,
    updatedAt: 10,
    metadata: { givenName: "Kai", displayRole: "Implementation Engineer" },
  };
  const graph = projectedTaskGraph("coding-interface-first", [
    {
      taskId: "propose-workspace-ui",
      nodeId: interfaceDesigner.id,
      capability: "propose",
      status: "running",
    },
    {
      taskId: "implement",
      nodeId: implementer.id,
      capability: "implement",
      status: "pending",
      dependencies: [{ taskId: "propose-workspace-ui", condition: "accepted" }],
    },
  ]);
  const html = codingRunPanelHtml({
    state: {
      ...initialOrchestrationState,
      nodes: {
        [interfaceDesigner.id]: interfaceDesigner,
        [implementer.id]: implementer,
      },
      taskGraph: graph,
    },
    events: [],
    runId: graph.runId,
    job: { id: "job-interface-first", status: "running" },
  });

  const sora = html.indexOf('data-node-id="workspace.ui"');
  const kai = html.indexOf('data-node-id="workspace.implementation"');
  assert.ok(sora > 0 && kai > sora, "the visible plan follows the dependency order");
  assert.match(html, /Sora[\s\S]*is shaping the design direction/);
  assert.match(html, /Kai[\s\S]*Waiting for Sora/);
});

test("live Coding mutation room shows an addressed peer proposal and response", () => {
  const runId = "coding-visible-peer-chat";
  const implementer = {
    id: "workspace.implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["propose", "implement"],
    runtime: { kind: "pi-agent" as const, metadata: { model: "gpt-5.6-luna" } },
    status: "active" as const,
    updatedAt: 1,
    metadata: { givenName: "Kai", displayRole: "Implementation Engineer" },
  };
  const reviewer = {
    id: "workspace.quality",
    name: "Mira, Quality Reviewer",
    capabilities: ["respond", "review"],
    runtime: { kind: "pi-agent" as const, metadata: { model: "gpt-5.6-luna" } },
    status: "active" as const,
    updatedAt: 1,
    metadata: { givenName: "Mira", displayRole: "Quality Reviewer" },
  };
  const graph = projectedTaskGraph(runId, [{
    taskId: "propose-kai",
    nodeId: implementer.id,
    capability: "propose",
    status: "accepted",
  }, {
    taskId: "respond-mira",
    nodeId: reviewer.id,
    capability: "respond",
    status: "accepted",
    dependencies: [{ taskId: "propose-kai", condition: "accepted" }],
  }]);
  const proposal = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-visible-proposal",
    origin: "task",
    outputKey: "collaboration_proposal_implementation",
    taskId: "propose-kai",
    nodeId: implementer.id,
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "proposal",
    summary: "Keep the change inside the existing room boundary.",
    recommendations: [{
      subjectId: "room-boundary",
      recommendation: "Project accepted peer turns into the conversation.",
      rationale: "The task graph already records the exchange.",
      evidence: ["src/browser/coding-client.ts"],
      confidence: 0.97,
    }],
    questions: [],
  }));
  const response = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-visible-response",
    origin: "task",
    outputKey: "collaboration_response_quality",
    taskId: "respond-mira",
    nodeId: reviewer.id,
    kind: "application/json",
    inputVersions: { collaboration_proposal_implementation: proposal.contentHash },
  }, JSON.stringify({
    status: "response",
    summary: "Agreed; keep raw task telemetry in Team activity.",
    answers: [{
      subjectId: "room-boundary",
      response: "Render only accepted semantic summaries in chat.",
      rationale: "This keeps process logs out of the social transcript.",
      evidence: ["docs/workspace-nodes.md"],
      confidence: 0.96,
    }],
    openQuestions: [],
  }));
  const base: OrchestrationState = {
    ...initialOrchestrationState,
    nodes: {
      [implementer.id]: implementer,
      [reviewer.id]: reviewer,
    },
    taskGraph: graph,
  };
  const state = reduceOrchestration(reduceOrchestration(base, proposal, 2), response, 3);
  const html = codingRunPanelHtml({
    state,
    events: [{ type: "task.graph.projected", runId, graph }, proposal, response],
    eventTimestamps: [
      Date.UTC(2026, 7, 26, 21, 45),
      Date.UTC(2026, 7, 26, 21, 46),
      Date.UTC(2026, 7, 26, 21, 47),
    ],
    runId,
    job: { id: "job-visible-peer-chat", status: "running" },
    roomUpdates: [{
      schema: "roster.node-room-update.v1",
      updateId: "update-mira-review",
      runId,
      taskId: "respond-mira",
      executionId: "execution-mira-review",
      nodeId: reviewer.id,
      updateKey: "reviewing",
      text: "I’m checking the accepted room boundary now.",
      intent: "acknowledgement",
      recipientNodeIds: [implementer.id],
      sequence: 1,
      at: "2026-08-26T21:46:30.000Z",
      settled: false,
    }, {
      schema: "roster.node-room-update.v1",
      updateId: "update-mira-question",
      runId,
      taskId: "respond-mira",
      executionId: "execution-mira-review",
      nodeId: reviewer.id,
      updateKey: "clarification",
      text: "Should this question remain visible after the task settles?",
      intent: "question",
      recipientNodeIds: [implementer.id],
      sequence: 2,
      at: "2026-08-26T21:46:40.000Z",
      settled: true,
    }, {
      schema: "roster.node-room-update.v1",
      updateId: "update-mira-followup",
      runId,
      taskId: "respond-mira",
      executionId: "execution-mira-review",
      nodeId: reviewer.id,
      updateKey: "clarification-followup",
      text: "Can you confirm the final interaction boundary?",
      intent: "question",
      recipientNodeIds: [implementer.id],
      sequence: 3,
      at: "2026-08-26T21:46:50.000Z",
      settled: false,
    }],
  });

  assert.match(html, /<ol[^>]*data-coding-room-transcript[^>]*>/u);
  assert.ok(directChildTagNames(html, "data-coding-room-transcript").every((tagName) => tagName === "li"), "the transcript ol has only li direct children");
  const rows = codingSocialRows(html);
  const acceptedProposalRow = codingSocialRow(rows, {
    "data-source-kind": "accepted-summary",
    "data-author-node-id": "workspace.implementation",
    "data-task-id": "propose-kai",
  });
  assert.equal(acceptedProposalRow.attributes["data-message-group"], "start");
  assert.match(parsedTextContent(acceptedProposalRow), /Kai/u);
  assert.match(parsedTextContent(acceptedProposalRow), /Implementation Engineer/u);
  assert.match(parsedTextContent(acceptedProposalRow), /21:46/u);
  assert.match(parsedTextContent(acceptedProposalRow), /Keep the change inside the existing room boundary\./u);
  assert.match(parsedTextContent(acceptedProposalRow), /Details/u);
  assert.deepEqual(codingRowRecipients(acceptedProposalRow), ["@Mira"]);
  assert.equal(parsedDescendants(acceptedProposalRow, (node) => node.tagName === "details").length, 1);

  const liveReviewRow = codingSocialRow(rows, {
    "data-source-kind": "live-update",
    "data-author-node-id": "workspace.quality",
    "data-task-id": "respond-mira",
    "data-update-id": "update-mira-review",
  });
  assert.equal(liveReviewRow.attributes["data-message-group"], "start");
  assert.equal(liveReviewRow.attributes["aria-live"], "polite");
  assert.match(parsedTextContent(liveReviewRow), /Mira/u);
  assert.match(parsedTextContent(liveReviewRow), /Quality Reviewer/u);
  assert.match(parsedTextContent(liveReviewRow), /21:46/u);
  assert.match(parsedTextContent(liveReviewRow), /Live/u);
  assert.match(parsedTextContent(liveReviewRow), /I’m checking the accepted room boundary now\./u);
  assert.deepEqual(codingRowRecipients(liveReviewRow), ["@Kai"]);

  const settledQuestionRow = codingSocialRow(rows, { "data-row-id": "update-mira-question" });
  assert.equal(settledQuestionRow.attributes["data-update-intent"], "question");
  assert.equal(settledQuestionRow.attributes["data-update-sequence"], "2");
  assert.equal(settledQuestionRow.attributes["data-update-settled"], "true");
  assert.match(parsedTextContent(settledQuestionRow), /Settled/u);
  assert.match(parsedTextContent(settledQuestionRow), /Should this question remain visible after the task settles\?/u);
  assert.deepEqual(codingRowRecipients(settledQuestionRow), ["@Kai"]);

  const followupRow = codingSocialRow(rows, { "data-row-id": "update-mira-followup" });
  assert.equal(followupRow.attributes["data-message-group"], "continuation");
  assert.equal(followupRow.attributes["aria-label"], "Mira continued message");
  assert.match(parsedTextContent(followupRow), /Mira/u);
  assert.match(parsedTextContent(followupRow), /Can you confirm the final interaction boundary\?/u);
  assert.deepEqual(codingRowRecipients(followupRow), ["@Kai"]);

  const acceptedReviewRow = codingSocialRow(rows, {
    "data-source-kind": "accepted-summary",
    "data-author-node-id": "workspace.quality",
    "data-task-id": "respond-mira",
  });
  assert.match(parsedTextContent(acceptedReviewRow), /Mira/u);
  assert.match(parsedTextContent(acceptedReviewRow), /Quality Reviewer/u);
  assert.match(parsedTextContent(acceptedReviewRow), /Agreed; keep raw task telemetry in Team activity\./u);
  assert.match(parsedTextContent(acceptedReviewRow), /Details/u);
  assert.deepEqual(codingRowRecipients(acceptedReviewRow), ["@Kai"]);
  assert.equal(parsedDescendants(acceptedReviewRow, (node) => node.tagName === "details").length, 1);

  const workspaceAuthoredRows = rows.filter((row) =>
    ["live-update", "accepted-summary"].includes(row.attributes["data-source-kind"] ?? "")
    && (row.attributes["data-author-node-id"] ?? "").startsWith("workspace."));
  assert.ok(workspaceAuthoredRows.length >= 3);
  for (const row of workspaceAuthoredRows) {
    assert.ok(codingRowRecipients(row).some((recipient) => recipient.startsWith("@")),
      `workspace-authored row ${row.attributes["data-row-id"] ?? "unknown"} owns an addressed recipient`);
  }

  assertSystemRowsAreNotAuthoredSpeech(rows);
  const nestedFirstPersonSystemFixture = `<ol data-coding-room-transcript><li><article data-coding-social-row data-row-id="nested-system-speech" data-source-kind="system-activity"><div class="coding-message-body"><p><span>I am presenting fabricated teammate speech.</span></p></div></article></li></ol>`;
  assert.throws(
    () => assertSystemRowsAreNotAuthoredSpeech(codingSocialRows(nestedFirstPersonSystemFixture)),
    /system-activity row nested-system-speech contains first-person authored speech/u,
  );
  assert.doesNotMatch(html, /class="coding-message-recipient"[^>]*tabindex=/u);
  assert.doesNotMatch(html, /data-coding-social-row[^>]*[\s\S]{0,600}data-conversation-kind="artifact-card"/u);
  for (const scriptedCopy of [
    "I’m joining as",
    "I’m ready to implement",
    "Started the assigned repository step.",
    "Running relevant repository checks.",
    "Inspecting the repository and will return an evidence-backed answer.",
    "steps are in progress now",
  ]) {
    assert.doesNotMatch(html, new RegExp(scriptedCopy.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("Coding social rows render authored markup as inert text without selector or URL injection", () => {
  const runId = "coding-authored-body-safety";
  const implementer = {
    id: "workspace.implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["propose"],
    status: "active" as const,
    updatedAt: 1,
    metadata: { givenName: "Kai", displayRole: "Implementation Engineer" },
  };
  const graph = projectedTaskGraph(runId, [{
    taskId: "propose-kai",
    nodeId: implementer.id,
    capability: "propose",
    status: "accepted",
  }]);
  const authoredAttack = "**Accepted words.** <form id=\"coding-conversation-feed\"><input autofocus onfocus=\"alert(1)\"><img src=\"x\" onerror=\"alert(1)\"></form><article id=\"spoof\" data-coding-social-row data-row-id=\"spoof-row\"><script>alert(1)</script></article> [unsafe](javascript:alert(1)) ![payload](data:image/svg+xml,onload=alert(1)) [safe](https://example.com/review)";
  const liveAttack = "_Live words._ <input id=\"spoof-live\" autofocus><img src=\"javascript:alert(1)\" onerror=\"alert(1)\"><section data-coding-social-row data-row-id=\"live-spoof\"></section> [unsafe](data:text/html,payload)";
  const durableAttack = createCodingConversationMessage({
    conversationId: runId,
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Durable words. <form><input autofocus></form> [unsafe](javascript:alert(1))",
    createdAt: 1,
  });
  const accepted = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-authored-body-safety",
    origin: "task",
    outputKey: "collaboration_proposal_implementation",
    taskId: "propose-kai",
    nodeId: implementer.id,
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "proposal",
    summary: authoredAttack,
    recommendations: [{
      subjectId: "body-safety",
      recommendation: "Keep authored content inert.",
      rationale: "The public transcript must not accept authored DOM.",
      evidence: [],
      confidence: 1,
    }],
    questions: [],
  }));
  const state = reduceOrchestration({
    ...initialOrchestrationState,
    nodes: { [implementer.id]: implementer },
    taskGraph: graph,
  }, accepted, 2);
  const html = codingRunPanelHtml({
    state,
    events: [
      { type: "task.graph.projected", runId, graph },
      codingConversationMessageEvent(durableAttack),
      accepted,
    ],
    eventTimestamps: [0, 1, 2],
    runId,
    job: { id: "job-authored-body-safety", status: "running" },
    roomUpdates: [{
      schema: "roster.node-room-update.v1",
      updateId: "update-authored-body-safety",
      runId,
      taskId: "propose-kai",
      executionId: "execution-authored-body-safety",
      nodeId: implementer.id,
      updateKey: "unsafe-authored-body",
      text: liveAttack,
      intent: "question",
      recipientNodeIds: ["human.operator"],
      sequence: 1,
      at: "2026-08-26T21:46:30.000Z",
      settled: false,
    }],
  });

  const bodies = [
    socialRowBody(html, "message", "human.operator"),
    socialRowBody(html, "accepted-summary", implementer.id),
    socialRowBody(html, "live-update", implementer.id),
  ];
  assert.match(bodies[1]!, /<strong>Accepted words\.<\/strong>/u);
  assert.match(bodies[2]!, /<em>Live words\.<\/em>/u);
  for (const body of bodies) {
    assert.match(body, /&lt;(?:form|input|img|article|section)/u);
    assert.doesNotMatch(body, /<(?:form|input|img|article|section|script)\b/iu);
    for (const renderedTag of body.match(/<[a-z][^>]*>/giu) ?? []) {
      assert.doesNotMatch(renderedTag, /\s(?:autofocus|on\w+|id|data-coding-social-row|data-row-id)=/iu);
    }
    assert.doesNotMatch(body, /(?:href|src)=["']?(?:javascript:|data:)/iu);
  }
  for (const renderedTag of bodies.flatMap((body) => body.match(/<[a-z][^>]*>/giu) ?? [])) {
    assert.doesNotMatch(renderedTag, /(?:data-row-id="(?:spoof-row|live-spoof)"|id="spoof(?:-live)?")/u);
  }
});

test("public Coding shell keeps private task, tool, reasoning, runtime, and capability material out of HTML and boot JSON", () => {
  const runId = "coding-public-privacy";
  const privateCommand = "git --no-pager diff --cached --binary --full-index HEAD --";
  const privateStageCommand = "git add -A -- .";
  const privateJobObjective = `PRIVATE_JOB_OBJECTIVE=${privateCommand}`;
  const privateInbox = "PRIVATE_INBOX_BODY=release credentials";
  const privateReasoning = "PRIVATE_REASONING=chain-of-thought";
  const privateCredential = "AWS_SECRET_ACCESS_KEY=must-not-render";
  const privateCapability = "browser-capability-must-not-render";
  const privateSession = "provider-session-must-not-render";
  const privateSandbox = "sandbox-placement-must-not-render";
  const privateReportValidation = "REPORT_VALIDATION=git show --raw --no-abbrev HEAD";
  const privateReportRationale = "REPORT_RATIONALE=OPENAI_API_KEY=must-not-render";
  const privateReportFrontier = "REPORT_FRONTIER=tool_input:{\"cmd\":\"git status --porcelain\"}";
  const privateReportAnswer = "REPORT_ANSWER=hidden chain-of-thought";
  const privateReportFile = "/private/runtime/sandbox/session.json";
  const implementer = {
    id: "workspace.implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["propose"],
    status: "active" as const,
    updatedAt: 1,
    metadata: { givenName: "Kai", displayRole: "Implementation Engineer" },
  };
  const graph = projectedTaskGraph(runId, [{
    taskId: "continue_implementation",
    nodeId: implementer.id,
    capability: "propose",
    status: "accepted",
    objective: `Inspect privately with ${privateCommand}; then ${privateStageCommand}; ${privateInbox}`,
    error: privateCredential,
  }, {
    taskId: "remediate-after-review",
    nodeId: implementer.id,
    capability: "remediate",
    status: "accepted",
    objective: `Privately remediate with ${privateReportValidation}`,
    dependencies: ["continue_implementation"],
  }, {
    taskId: "coding-finalize",
    nodeId: "coordinator",
    capability: "coordinate",
    status: "failed",
    objective: "Finalize only after the accepted remediation is certified.",
    dependencies: ["remediate-after-review"],
  }]);
  const accepted = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-public-privacy",
    origin: "task",
    outputKey: "collaboration_proposal_implementation",
    taskId: "continue_implementation",
    nodeId: implementer.id,
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "proposal",
    summary: "The bounded public implementation summary is accepted.",
    recommendations: [{
      subjectId: "public-boundary",
      recommendation: "Project only the bounded public summary.",
      rationale: "Private execution material stays behind the server boundary.",
      evidence: [],
      confidence: 1,
    }],
    questions: [],
  }));
  const acceptedFinalReport = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-private-final-report",
    origin: "task",
    outputKey: "final_report",
    taskId: "remediate-after-review",
    nodeId: implementer.id,
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "remediated",
    summary: "The bounded public remediation summary is accepted.",
    answer: privateReportAnswer,
    changedFiles: [privateReportFile],
    validation: [privateReportValidation],
    validationRationale: privateReportRationale,
    frontierHash: privateReportFrontier,
  }));
  const reducedState = [accepted, acceptedFinalReport].reduce((current, event, index) => reduceOrchestration(
    current,
    event,
    index + 2,
  ), {
    ...initialOrchestrationState,
    nodes: { [implementer.id]: implementer },
    taskGraph: graph,
  });
  const state: OrchestrationState = {
    ...reducedState,
    nodeBindings: {
      [implementer.id]: {
        bindingId: "binding-public-privacy",
        nodeId: implementer.id,
        runtime: { kind: "codex-cli", profile: "gpt-5.6-luna" },
        epoch: 1,
        topologyVersion: "topology-public-privacy",
        sessionId: privateSession,
        sandboxId: privateSandbox,
        updatedAt: 2,
      },
    },
  };
  const html = codingShell({
    state,
    events: [{ type: "task.graph.projected", runId, graph }, accepted, acceptedFinalReport],
    eventTimestamps: [1, 2, 3],
    runId,
    job: {
      id: "job-public-privacy",
      status: "failed",
      objective: privateJobObjective,
      branch: "roster/public-privacy",
      commit: "a".repeat(40),
      baselineBranch: "main",
      baselineCommit: "b".repeat(40),
      integration: {
        integrated: false,
        canIntegrate: false,
        currentBranch: "main",
        reason: `${privateCommand}; ${privateCredential}`,
      },
      error: `${privateReasoning}; ${privateCredential}`,
    },
    nonce: "public-privacy",
    repositoryPath: "/workspace/theorem",
    gitRemote: "",
    gitAccount: "",
    workspaceId: "workspace-public-privacy",
    workspaceProfile: reviewCodingWorkspaceSnapshot({
      repositoryRoot: "/workspace/theorem",
      files: ["package.json"],
      manifests: [{ path: "package.json", content: "{}" }],
      reviewedAt: 1,
    }),
    runtimeLogs: [{
      runId,
      nodeId: implementer.id,
      taskId: "continue_implementation",
      runtime: "codex-cli",
      stream: "stdout",
      text: `${privateCommand}\n${privateCredential}`,
      sequence: 1,
      at: 1,
      truncated: false,
    }],
    realtime: {
      enabled: true,
      uri: "http://127.0.0.1:3000",
      database: "roster-test",
      confirmedReads: true,
      workspaceId: "workspace-public-privacy",
      activeRunId: runId,
      capabilitySecret: privateCapability,
    },
  });
  const bootText = html.match(/<script id="coding-realtime-boot"[^>]*>([^<]+)<\/script>/u)?.[1] ?? "";
  const boot = JSON.parse(bootText) as Readonly<Record<string, unknown>>;

  assert.match(html, /data-coding-social-row[^>]*data-source-kind="accepted-summary"[^>]*data-author-node-id="workspace\.implementation"[^>]*data-task-id="continue_implementation"/u);
  assert.match(html, /data-coding-social-row[^>]*data-source-kind="accepted-summary"[^>]*data-author-node-id="workspace\.implementation"[^>]*data-task-id="remediate-after-review"/u);
  assert.match(html, /The bounded public implementation summary is accepted\./u);
  assert.match(html, /The bounded public remediation summary is accepted\./u);
  assert.match(html, /<summary>Details<\/summary>/u);
  for (const privateValue of [
    privateCommand,
    privateStageCommand,
    privateJobObjective,
    privateInbox,
    privateReasoning,
    privateCredential,
    privateCapability,
    privateSession,
    privateSandbox,
    privateReportValidation,
    privateReportRationale,
    privateReportFrontier,
    privateReportAnswer,
    privateReportFile,
  ]) {
    assert.doesNotMatch(html, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(bootText, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.equal("capabilitySecret" in boot, false);
  assert.deepEqual(Object.keys(boot).sort(), [
    "activeRunId",
    "codingWorkspaceId",
    "committedUsageNote",
    "conversationId",
    "delivery",
    "job",
    "realtime",
    "workspaceId",
  ]);
});

test("Coding authored rows preserve safe Markdown through a strict rendered-element allowlist", () => {
  const markdown = [
    "> Preserve this review note.",
    "",
    "Use `const input = '<input autofocus>';` inline.",
    "",
    "```ts",
    "const form = '<form id=\"spoof\">';",
    "```",
    "",
    "- [x] Sanitizer reviewed",
    "- [ ] Follow-up pending",
    "",
    "[Open the HTTPS review](https://example.com/review?from=room&safe=1)",
    "[Unsafe JavaScript](javascript:alert(1))",
    "[Unsafe data](data:text/html,payload)",
    "[Unsafe file](file:///etc/passwd)",
    "![Remote image](https://example.com/image.png)",
    "![Data image](data:image/svg+xml,onload=alert(1))",
  ].join("\n");
  const message = createCodingConversationMessage({
    conversationId: "coding-authored-markdown-allowlist",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: markdown,
    createdAt: 1,
  });
  const html = codingRunPanelHtml({
    state: initialOrchestrationState,
    events: [codingConversationMessageEvent(message)],
    runId: message.conversationId,
  });
  const body = socialRowBody(html, "message", "human.operator");

  assert.match(body, /<blockquote>Preserve this review note\.<\/blockquote>/u);
  assert.match(body, /<code>[^<]*input[^<]*&lt;input autofocus&gt;[^<]*<\/code>/u);
  assert.match(body, /<pre(?: lang="ts")?><code>[^<]*const form = [\s\S]*&lt;form id=[\s\S]*spoof[\s\S]*<\/code><\/pre>/u);
  assert.match(body, /<input type="checkbox" checked disabled>/u);
  assert.match(body, /<input type="checkbox" disabled>/u);
  assert.doesNotMatch(body, /<input(?! type="checkbox"(?: checked)? disabled>)/u);
  assert.match(body, /<a href="https:\/\/example\.com\/review\?from=room&amp;safe=1" rel="noopener noreferrer">Open the HTTPS review<\/a>/u);
  assert.doesNotMatch(body, /<a[^>]+href="(?:javascript:|data:|file:)/iu);
  assert.doesNotMatch(body, /<img\b/iu);
  assert.match(body, /Unsafe JavaScript/u);
  assert.match(body, /Unsafe data/u);
  assert.match(body, /Unsafe file/u);
  assert.match(body, /\[Image: Remote image\]/u);
  assert.match(body, /\[Image: Data image\]/u);
  for (const renderedTag of body.match(/<[a-z][^>]*>/giu) ?? []) {
    assert.doesNotMatch(renderedTag, /\s(?:id|data-[\w-]+|style|on\w+|autofocus)=/iu);
  }
});

test("Coding authored formatting closes inside its message body under malformed cross-nesting", () => {
  const conversationId = "coding-authored-markdown-containment";
  const malformed = createCodingConversationMessage({
    conversationId,
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "[**x](https://example.com)** and **[crossed**](https://example.com/review)",
    createdAt: 1,
  });
  const later = createCodingConversationMessage({
    conversationId,
    author: { kind: "agent", id: "coordinator", name: "Roster" },
    source: { kind: "agent" },
    text: "Later row remains independent.",
    createdAt: 2,
  });
  const html = codingRunPanelHtml({
    state: initialOrchestrationState,
    events: [
      codingConversationMessageEvent(malformed),
      codingConversationMessageEvent(later),
    ],
    runId: conversationId,
  });
  const transcriptStart = html.indexOf("<ol", html.indexOf("data-coding-room-transcript") - 200);
  const transcriptEnd = html.indexOf("</ol>", transcriptStart);
  assert.ok(transcriptStart >= 0 && transcriptEnd > transcriptStart);
  const parsed = parseStrictHtmlFragment(html.slice(transcriptStart, transcriptEnd + "</ol>".length));
  const transcript = parsedDescendants(parsed, (node) => "data-coding-room-transcript" in node.attributes);
  assert.equal(transcript.length, 1);
  const rows = parsedDescendants(transcript[0]!, (node) => "data-coding-social-row" in node.attributes);
  assert.equal(rows.length, 2, "malformed formatting cannot duplicate or absorb a social row");
  const firstBody = parsedDescendants(rows[0]!, (node) => node.attributes.class === "coding-message-body");
  const firstDetails = parsedDescendants(rows[0]!, (node) => node.attributes.class === "coding-message-evidence");
  assert.equal(firstBody.length, 1);
  assert.equal(firstDetails.length, 1);
  assert.equal(firstBody[0]!.parent, firstDetails[0]!.parent, "Details remains a sibling of the authored body");
  assert.ok(!parsedDescendants(firstBody[0]!, (node) => node.tagName === "details").length);
  assert.ok(!["a", "strong", "em", "del", "code"].includes(firstDetails[0]!.parent?.tagName ?? ""));
  assert.equal(rows[1]!.attributes["data-author-node-id"], "coordinator");
  assert.match(socialRowBody(html, "message", "coordinator"), /Later row remains independent\./u);
});

test("Coding shell gives the transcript and composer full-width responsive gutters", () => {
  const shell = codingShell({
    state: initialOrchestrationState,
    events: [],
    runId: "composer-live-edge",
    job: { id: "composer-live-edge-job", status: "running" },
    nonce: "full-width-room",
    repositoryPath: process.cwd(),
    gitRemote: "",
    gitAccount: "",
    workspaceProfile: reviewCodingWorkspaceSnapshot({
      repositoryRoot: process.cwd(),
      files: ["package.json"],
      manifests: [{ path: "package.json", content: "{}" }],
      reviewedAt: 1,
    }),
  });

  assert.equal((shell.match(/data-slot="workspace-composer"/g) ?? []).length, 1);
  assert.equal((shell.match(/data-coding-composer-input/g) ?? []).length, 1);
  assert.match(shell, /data-coding-composer-draft="composer-live-edge"/);
  assert.match(shell, /data-coding-new-messages/);
  assert.match(shell, /Add context while the team works/);
  assert.doesNotMatch(shell, /\.coding-composer-help\{display:none\}/);
  assert.match(shell, /roster\.coding\.draft\.v1:/u);
  assert.match(shell, /item\.confirmed=true;\s*clearSentDraft\(item\)/u);
  assert.match(shell, /const draftRevision=draftRevisionState\.revision/u);
  assert.match(shell, /const user=appendMessage\('You','user',objective,'Sending…',externalId,images,false\)/u);
  assert.match(shell, /newMessages\?\.addEventListener\('click',[\s\S]*scroller\.focus\(\{preventScroll:true\}\)/u);
  assert.match(shell, /\.coding-page \[data-coding-room-transcript\]\{width:100%;max-width:none;margin:0;padding:12px 0 24px;list-style:none\}/u);
  assert.match(shell, /\.coding-page \.coding-composer-wrap\{[^}]*width:100%[^}]*padding-inline:clamp\(16px,2vw,32px\)/u);
  assert.match(shell, /\.coding-page \.coding-social-row\{width:100%;display:grid;grid-template-columns:32px minmax\(0,1fr\);gap:10px;padding:5px 20px\}/u);
  assert.match(shell, /\.coding-page \.coding-social-row \.coding-message-body\{max-width:880px;margin-top:2px;font-size:14px;line-height:1\.45\}/u);
  assert.match(shell, /\.coding-page \.coding-message-evidence>summary\{opacity:0\}/u);
  assert.match(shell, /\.coding-page \.coding-social-row:hover \.coding-message-evidence>summary,\.coding-page \.coding-social-row:focus-within \.coding-message-evidence>summary\{opacity:1\}/u);
  assert.match(shell, /@media\(max-width:719px\)[\s\S]*\.coding-page \.coding-social-row \.coding-message-avatar\{width:32px/u);
  assert.match(shell, /@media\(max-width:719px\)[\s\S]*scroll-padding-bottom:var\(--coding-composer-mobile-height\)/u);
  assert.match(shell, /\.coding-page \.coding-composer\{min-height:76px;padding:8px 10px;border:1px solid var\(--border-strong\);border-radius:10px;background:var\(--surface-raised\);box-shadow:none\}/u);
  assert.match(shell, /\.coding-page \.coding-new-messages\{position:relative;z-index:25;grid-column:1;grid-row:1;align-self:end;justify-self:end;margin:0 20px 12px\}/u);
  assert.doesNotMatch(shell, /\.coding-page \.coding-new-messages\{[^}]*\bbottom:/u);
  assert.doesNotMatch(shell, /\.coding-conversation-column\{[^}]*max-width:(?:760|800|880|920)px/u);
});

test("completed Coding investigation room preserves accepted authored findings across server render", () => {
  const runId = "coding-visible-investigation-chat";
  const lead = {
    id: "workspace.implementation",
    name: "Kai, Implementation Engineer",
    capabilities: ["investigate"],
    runtime: { kind: "pi-agent" as const, metadata: { model: "gpt-5.6-luna" } },
    status: "active" as const,
    updatedAt: 1,
    metadata: { givenName: "Kai", displayRole: "Implementation Engineer" },
  };
  const peer = {
    id: "workspace.runtime",
    name: "Owen, Runtime Engineer",
    capabilities: ["investigate"],
    runtime: { kind: "pi-agent" as const, metadata: { model: "gpt-5.6-luna" } },
    status: "active" as const,
    updatedAt: 1,
    metadata: { givenName: "Owen", displayRole: "Runtime Engineer" },
  };
  const graph = projectedTaskGraph(runId, [{
    taskId: "investigate-implementation",
    nodeId: lead.id,
    capability: "investigate",
    status: "accepted",
  }, {
    taskId: "investigate-runtime",
    nodeId: peer.id,
    capability: "investigate",
    status: "accepted",
  }, {
    taskId: "synthesize-investigation",
    nodeId: lead.id,
    capability: "investigate",
    status: "accepted",
    dependencies: [
      { taskId: "investigate-implementation", condition: "accepted" },
      { taskId: "investigate-runtime", condition: "accepted" },
    ],
  }, {
    taskId: "coding-finalize",
    nodeId: "coordinator",
    capability: "coordinate.finalize",
    status: "accepted",
    dependencies: [
      { taskId: "investigate-implementation", condition: "accepted" },
      { taskId: "investigate-runtime", condition: "accepted" },
      { taskId: "synthesize-investigation", condition: "accepted" },
    ],
  }]);
  const finding = (options: {
    artifactId: string;
    outputKey: string;
    taskId: string;
    nodeId: string;
    summary: string;
  }) => inlineArtifactPublishedEvent({
    runId,
    artifactId: options.artifactId,
    origin: "task",
    outputKey: options.outputKey,
    taskId: options.taskId,
    nodeId: options.nodeId,
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "completed",
    summary: options.summary,
    findings: [],
    files: [],
    limitations: [],
  }));
  const leadFinding = finding({
    artifactId: "artifact-investigation-kai",
    outputKey: "investigation_implementation_report",
    taskId: "investigate-implementation",
    nodeId: lead.id,
    summary: "Owen, I traced the room projection to accepted task references.",
  });
  const peerFinding = finding({
    artifactId: "artifact-investigation-owen",
    outputKey: "investigation_runtime_report",
    taskId: "investigate-runtime",
    nodeId: peer.id,
    summary: "Kai, I confirmed the runtime publishes bounded presentation text.",
  });
  const synthesis = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-investigation-synthesis",
    origin: "task",
    outputKey: "final_report",
    taskId: "synthesize-investigation",
    nodeId: lead.id,
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "completed",
    summary: "Owen, your runtime evidence confirms the missing projection boundary.",
    answer: "Accepted investigation summaries must be projected as peer turns.",
    findings: [],
    files: [],
    limitations: [],
    specialistReports: [],
  }));
  const finalOutcome = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-coding-final-outcome",
    origin: "task",
    outputKey: "coding_result",
    taskId: "coding-finalize",
    nodeId: "coordinator",
    kind: "application/json",
    inputVersions: { final_report: synthesis.contentHash },
  }, JSON.stringify({
    status: "completed",
    summary: "Accepted investigation summaries must be projected as peer turns.",
    outputKeys: ["final_report"],
  }));
  const rawReport = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-arbitrary-report",
    origin: "input",
    outputKey: "raw_frontier_report",
    nodeId: peer.id,
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({ summary: "This raw receipt must remain outside chat." }));
  const base: OrchestrationState = {
    ...initialOrchestrationState,
    nodes: { [lead.id]: lead, [peer.id]: peer },
    taskGraph: graph,
  };
  const events = [leadFinding, peerFinding, synthesis, finalOutcome, rawReport];
  const state = events.reduce((current, event, index) =>
    reduceOrchestration(current, event, index + 2), base);
  const html = codingRunPanelHtml({
    state,
    events: [{ type: "task.graph.projected", runId, graph }, ...events],
    runId,
    job: {
      id: "job-visible-investigation-chat",
      runKind: "investigation",
      readOnly: true,
      status: "completed",
      noChanges: true,
      commit: "a".repeat(40),
      objective: "Explain how accepted investigation messages reach the room.",
    },
  });

  assert.match(html, /data-coding-social-row[^>]*data-source-kind="accepted-summary"[^>]*data-task-id="investigate-implementation"/);
  assert.match(html, /data-coding-social-row[^>]*data-source-kind="accepted-summary"[^>]*data-task-id="investigate-runtime"/);
  assert.match(html, /data-coding-social-row[^>]*data-source-kind="accepted-summary"[^>]*data-task-id="synthesize-investigation"/);
  assert.doesNotMatch(html, /data-coding-external-id="artifact-coding-final-outcome"/);
  assert.match(html, /data-coding-social-row[^>]*data-source-kind="accepted-summary"[^>]*data-author-node-id="coordinator"[^>]*data-task-id="coding-finalize"/);
  const transcript = html.match(/<ol class="coding-thread coding-timeline"[\s\S]*?<\/ol>/)?.[0] ?? "";
  assert.equal(transcript.match(/Accepted investigation summaries must be projected as peer turns\./g)?.length, 1);
  assert.doesNotMatch(html, /class="coding-result coding-final-report"|data-conversation-kind="artifact-card"/);
  assert.match(html, /data-coding-run-panel data-state="success"/);
  assert.doesNotMatch(html, /Investigation stopped|Retry Run/);
  assert.doesNotMatch(html, /This raw receipt must remain outside chat/);

  const legacyHtml = codingRunPanelHtml({
    state: {
      ...state,
      domain: {
        id: "coding-investigation",
        version: "3",
        policyVersion: "coding-investigation-v3",
        coordinatorId: "coordinator",
        capabilities: [],
        limits: { maxNodes: 16, maxTasks: 32, maxParallel: 8, maxDepth: 6 },
      },
    },
    events: [{ type: "task.graph.projected", runId, graph }, ...events],
    runId,
  });
  assert.match(legacyHtml, /data-task-id="coding-finalize"/);
  assert.doesNotMatch(legacyHtml, /class="coding-result coding-final-report"|data-conversation-kind="artifact-card"/);
});

test("investigation details remain private until the exact finalizer succeeds", () => {
  const runId = "coding-investigation-private-until-finalized";
  const synthesis = inlineArtifactPublishedEvent({
    runId,
    artifactId: "artifact-private-investigation-synthesis",
    origin: "task",
    outputKey: "final_report",
    taskId: "synthesize-investigation",
    nodeId: "workspace.investigator",
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "completed",
    summary: "The bounded investigation synthesis is awaiting finalization.",
    answer: "PRIVATE_ANSWER git reset --hard hidden-branch Bearer private-credential <img src=x onerror=alert(1)>",
    findings: [{
      claim: "PRIVATE_FINDING providerSession=hidden-session",
      evidence: ["PRIVATE_EVIDENCE toolInput={secret:true}", "PRIVATE_REASONING chain-of-thought"],
    }],
    files: ["PRIVATE_FILE/.env.production"],
    limitations: ["PRIVATE_LIMITATION sandboxId=hidden-sandbox"],
    specialistReports: ["PRIVATE_SPECIALIST raw transcript"],
  }));
  const graph = (finalizer: "failed" | "accepted" | "missing") => projectedTaskGraph(runId, [
    {
      taskId: "synthesize-investigation",
      nodeId: "workspace.investigator",
      capability: "investigate",
      status: "accepted",
    },
    ...(finalizer === "missing" ? [] : [{
      taskId: "coding-finalize",
      nodeId: "coordinator",
      capability: "coordinate.finalize",
      status: finalizer,
      dependencies: [{ taskId: "synthesize-investigation", condition: "accepted" as const }],
      ...(finalizer === "failed" ? { error: "PRIVATE_FINALIZER git status --porcelain" } : {}),
    }]),
  ]);
  const render = (finalizer: "failed" | "accepted" | "missing") => {
    const taskGraph = graph(finalizer);
    const state = reduceOrchestration({
      ...initialOrchestrationState,
      taskGraph,
    }, synthesis, 2);
    return codingRunPanelHtml({
      state,
      events: [{ type: "task.graph.projected", runId, graph: taskGraph }, synthesis],
      runId,
      job: {
        id: `job-private-investigation-${finalizer}`,
        runKind: "investigation",
        readOnly: true,
        status: finalizer === "accepted" ? "completed" : "failed",
        noChanges: true,
      },
    });
  };

  for (const finalizer of ["failed", "missing"] as const) {
    const html = render(finalizer);
    assert.match(html, /The bounded investigation synthesis is awaiting finalization\./u);
    assert.doesNotMatch(html, /PRIVATE_(?:ANSWER|FINDING|EVIDENCE|REASONING|FILE|LIMITATION|SPECIALIST|FINALIZER)/u);
    assert.doesNotMatch(html, /git reset|git status|Bearer private|providerSession|toolInput|chain-of-thought|\.env\.production|sandboxId|onerror/iu);
    assert.doesNotMatch(html, /<h3>Final answer<\/h3>|Findings and evidence|Relevant files|Specialist reports consulted/u);
  }

  const finalizedHtml = render("accepted");
  assert.match(finalizedHtml, /<h3>Final answer<\/h3>/u);
  assert.match(finalizedHtml, /PRIVATE_ANSWER/u);
  assert.match(finalizedHtml, /PRIVATE_FINDING/u);
  assert.match(finalizedHtml, /PRIVATE_FILE\/\.env\.production/u);
  assert.match(finalizedHtml, /&lt;img src=x onerror=alert\(1\)>/u);
  assert.doesNotMatch(finalizedHtml, /<img\b/iu, "finalized Markdown must remain escaped and sanitized");
});

test("accepted investigation output renders as a bounded Markdown document", () => {
  const report = parseCodingInvestigationReport(JSON.stringify({
    status: "completed",
    summary: "The job state machine is the integration boundary.",
    answer: "Start with the ingest, dispatcher, and inference execution paths.",
    findings: [{
      claim: "Dispatch is asynchronous.",
      evidence: ["src/dispatcher.ts:42", "src/jobs.ts:88"],
    }],
    files: ["src/dispatcher.ts", "src/jobs.ts"],
    limitations: ["Deployment configuration was not inspected."],
    specialistReports: ["Runtime specialist", "Data specialist"],
  }));
  assert.ok(report);
  const markdown = renderCodingInvestigationReport({
    runId: "coding-architecture-report",
    objective: "Map the architecture and identify where to start.",
    report,
  });
  assert.match(markdown, /^# Repository investigation report/m);
  assert.match(markdown, /## Objective[\s\S]*Map the architecture/);
  assert.match(markdown, /## Final answer[\s\S]*Start with the ingest/);
  assert.match(markdown, /## Findings and evidence[\s\S]*Dispatch is asynchronous/);
  assert.match(markdown, /src\/dispatcher\.ts:42/);
  assert.match(markdown, /## Relevant files[\s\S]*src\/jobs\.ts/);
  assert.match(markdown, /## Limitations[\s\S]*Deployment configuration/);
  assert.equal(
    codingInvestigationReportFilename("coding-architecture-report"),
    "roster-investigation-coding-architecture-report.md",
  );
});

test("coding work feed excludes unaccepted peer evidence from the public room", () => {
  const response = inlineArtifactPublishedEvent({
    runId: "coding-evidence-cards",
    artifactId: "artifact-response-card",
    origin: "input",
    outputKey: "collaboration_response_workspace-runtime",
    nodeId: "workspace.runtime",
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    status: "response",
    summary: "Runtime evidence supports the proposed validation boundary.",
    answers: [{
      subjectId: "validation",
      response: "Run the focused smoke before repository verification.",
      rationale: "The focused test gives faster boundary feedback.",
      evidence: ["tests/smoke/coding-demo.test.ts"],
      confidence: 0.94,
    }],
    openQuestions: [{
      subjectId: "validation",
      question: "Does the full gate mutate generated assets?",
      reason: "Generated output belongs to the final verification boundary.",
    }],
  }));
  const endorsement = inlineArtifactPublishedEvent({
    runId: "coding-evidence-cards",
    artifactId: "artifact-endorsement-card",
    origin: "input",
    outputKey: "collaboration_endorsement_workspace-runtime",
    nodeId: "workspace.runtime",
    kind: "application/json",
    inputVersions: {},
  }, JSON.stringify({
    verdict: "approve",
    frontierHash: "frontier-card",
    summary: "The implementation matches the accepted runtime boundary.",
    evidence: ["npm run verify"],
  }));
  const responseState = reduceOrchestration(initialOrchestrationState, response, 10);
  const state = reduceOrchestration(responseState, endorsement, 20);
  const html = codingRunPanelHtml({ state, events: [response, endorsement], runId: "coding-evidence-cards" });
  assert.doesNotMatch(html, /data-generative-ui-kind|data-source-kind="accepted-summary"/);
  assert.doesNotMatch(html, /Runtime evidence supports the proposed validation boundary/);
  assert.doesNotMatch(html, /The implementation matches the accepted runtime boundary/);
  assert.doesNotMatch(html, /npm run verify/);
});

const exhaustedAmbiguityFixture = () => {
  const proposal = inlineArtifactPublishedEvent({
    runId: "coding-human-escalation",
    artifactId: "artifact-proposal",
    origin: "task",
    outputKey: "collaboration_proposal_workspace-quality",
    taskId: "propose-workspace-quality",
    nodeId: "workspace.quality",
    kind: "application/json",
    inputVersions: { request: "request-v1" },
  }, JSON.stringify({
    status: "proposal",
    summary: "The public delivery contract remains ambiguous.",
    recommendations: [{
      subjectId: "public-contract",
      recommendation: "Use attachment delivery.",
      rationale: "Either contract fits the repository.",
      evidence: [],
      confidence: 0.6,
    }],
    questions: [],
  }));
  const resolution = JSON.stringify({
    status: "ambiguous",
    summary: "Repository evidence does not establish the product policy.",
    decisions: [],
    unresolved: [{
      subjectId: "public-contract",
      reason: "Both authenticated delivery contracts are repository-compatible.",
      candidateSummaries: ["attachment", "inline"],
    }, {
      subjectId: "delivery",
      reason: "The repository cannot establish which rollout is intended.",
      candidateSummaries: ["staged rollout", "single release"],
    }],
  });
  const event = inlineArtifactPublishedEvent({
    runId: "coding-human-escalation",
    artifactId: "artifact-resolution",
    origin: "task",
    outputKey: "collaboration_resolution",
    taskId: "resolve-collaboration",
    nodeId: "coding.resolution.dynamic",
    kind: "application/json",
    inputVersions: { collaboration_proposal_workspace_quality: proposal.contentHash },
  }, resolution);
  const state: OrchestrationState = {
    ...initialOrchestrationState,
    nodes: {
      "workspace.quality": {
        id: "workspace.quality",
        name: "Mira, Quality Reviewer",
        capabilities: ["propose"],
        status: "active",
        updatedAt: 20,
        metadata: { givenName: "Mira", displayRole: "Quality Reviewer" },
      },
      "coding.resolution.dynamic": {
        id: "coding.resolution.dynamic",
        name: "Resolution Reviewer",
        capabilities: ["resolve"],
        status: "active",
        updatedAt: 30,
        metadata: { givenName: "Resolver", displayRole: "Resolution Reviewer" },
      },
      "workspace.implementation": {
        id: "workspace.implementation",
        name: "Kai, Implementation Engineer",
        capabilities: ["implement"],
        status: "active",
        updatedAt: 20,
        metadata: { givenName: "Kai", displayRole: "Implementation Engineer" },
      },
    },
    taskGraph: projectedTaskGraph("coding-human-escalation", [
      {
        taskId: "propose-workspace-quality",
        nodeId: "workspace.quality",
        capability: "propose",
        status: "accepted",
      },
      {
        taskId: "resolve-collaboration",
        nodeId: "coding.resolution.dynamic",
        capability: "resolve",
        status: "accepted",
        dependencies: [{ taskId: "propose-workspace-quality", condition: "accepted" }],
      },
      {
        taskId: "implement",
        nodeId: "workspace.implementation",
        capability: "implement",
        status: "pending",
        dependencies: [{ taskId: "resolve-collaboration", condition: "accepted" }],
      },
    ]),
    artifacts: {
      [proposal.artifactId]: { ...proposal, updatedAt: 20 },
      [event.artifactId]: { ...event, updatedAt: 30 },
    },
    outputs: {
      "collaboration_proposal_workspace-quality": {
        outputKey: "collaboration_proposal_workspace-quality",
        artifactId: proposal.artifactId,
        contentHash: proposal.contentHash,
        origin: "task",
        taskId: "propose-workspace-quality",
        updatedAt: 20,
      },
      collaboration_resolution: {
        outputKey: "collaboration_resolution",
        artifactId: event.artifactId,
        contentHash: event.contentHash,
        origin: "task",
        taskId: "resolve-collaboration",
        updatedAt: 30,
      },
    },
  };
  return { state, proposal, resolution: event };
};

test("ambiguous peer resolution is presented as human continuation, not a failed hierarchy", () => {
  const { state, proposal, resolution: event } = exhaustedAmbiguityFixture();
  const html = codingRunPanelHtml({
    state,
    events: [proposal, event],
    runId: "coding-human-escalation",
    workspaceId: "workspace_0123456789abcdef0123",
    job: { id: "job-human-escalation", status: "failed", error: "human context required" },
  });
  assert.match(html, /Needs your answer/);
  assert.match(html, /Human action/);
  assert.match(html, /data-coding-social-row[^>]*data-source-kind="accepted-summary"[^>]*data-author-node-id="coding\.resolution\.dynamic"[^>]*data-task-id="resolve-collaboration"/);
  assert.doesNotMatch(html, /data-generative-ui-kind|data-conversation-kind="artifact-card"/);
  assert.match(html, /Repository evidence does not establish the product policy\./);
  assert.match(html, /public-contract/);
  assert.match(html, /Both authenticated delivery contracts are repository-compatible\./);
  assert.match(html, /Candidate positions/);
  assert.match(html, /attachment/);
  assert.match(html, /inline/);
  assert.match(html, /delivery/);
  assert.match(html, /The repository cannot establish which rollout is intended\./);
  assert.match(html, /staged rollout/);
  assert.match(html, /single release/);
  assert.match(html, /The repository and peer discussion could not safely resolve these subjects/);
  assert.match(html, /data-coding-human-reply aria-controls="coding-objective">Reply/);
  assert.match(html, /data-generative-ui-reply-form/);
  assert.match(html, /Resolve the Remaining Decision/);
  assert.match(html, /name="workspaceId" value="workspace_0123456789abcdef0123"/);
  assert.match(html, /name="conversationId" value="coding-human-escalation"/);
  assert.match(html, /name="objective" maxlength="20000" required/);
  assert.match(html, /Reply Inline/);
  assert.doesNotMatch(html, /Rowan|Engineering Lead/);

  const activeContinuationHtml = codingRunPanelHtml({
    state,
    events: [proposal, event],
    runId: "coding-human-escalation",
    job: { id: "job-human-continuation", status: "running" },
  });
  assert.doesNotMatch(activeContinuationHtml, /class="coding-human-action"/);
  assert.doesNotMatch(activeContinuationHtml, /data-coding-human-reply/);
  assert.doesNotMatch(activeContinuationHtml, /data-generative-ui-reply-form/);
  assert.doesNotMatch(activeContinuationHtml, /Needs your answer/);
});

test("human action follows receipt order and requires exhausted resolver provenance", () => {
  const { state, proposal, resolution } = exhaustedAmbiguityFixture();
  const clarification = createCodingConversationRoute({
    conversationId: "coding-human-escalation",
    inReplyTo: "message-after-ambiguity",
    disposition: "needs_clarification",
    selectedNodeIds: ["human.operator"],
    tags: ["intent:clarification"],
    questions: ["Should the follow-up preserve attachment compatibility?"],
    rationale: "The newer continuation introduced a distinct compatibility choice.",
    confidence: 0.9,
    createdAt: 40,
  });
  const clarificationEvent = codingConversationRouteEvent(clarification);
  const clarificationHtml = codingRunPanelHtml({
    state,
    events: [proposal, resolution, clarificationEvent],
    runId: "coding-human-escalation",
  });
  assert.match(clarificationHtml, /Should the follow-up preserve attachment compatibility/);
  assert.doesNotMatch(clarificationHtml, /newer continuation introduced a distinct compatibility choice/);
  assert.match(clarificationHtml, /data-generative-ui-reply-form/);
  assert.match(clarificationHtml, /Answer Roster/);
  const clarificationAction = clarificationHtml.match(/<section class="coding-human-action"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.doesNotMatch(clarificationAction, /Both authenticated delivery contracts are repository-compatible/);

  const informational = createCodingConversationRoute({
    conversationId: "coding-human-escalation",
    inReplyTo: "message-after-ambiguity",
    disposition: "informational",
    selectedNodeIds: [],
    tags: ["intent:informational"],
    questions: [],
    answer: "The saved team remains available.",
    rationale: "The latest turn only requested information.",
    confidence: 0.95,
    createdAt: 50,
  });
  const informationalHtml = codingRunPanelHtml({
    state,
    events: [proposal, resolution, codingConversationRouteEvent(informational)],
    runId: "coding-human-escalation",
  });
  assert.doesNotMatch(informationalHtml, /class="coding-human-action"/);

  const humanReply = createCodingConversationMessage({
    conversationId: "coding-human-escalation",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Use attachment compatibility.",
    createdAt: 60,
  });
  const ready = createCodingConversationRoute({
    conversationId: "coding-human-escalation",
    inReplyTo: humanReply.messageId,
    disposition: "ready",
    selectedNodeIds: ["workspace.implementation"],
    primaryNodeId: "workspace.implementation",
    coordination: { reviewMode: "fast", validationScope: "focused" },
    tags: ["intent:human-resolution"],
    questions: [],
    rationale: "The human reply resolved the earlier ambiguity.",
    confidence: 0.95,
    createdAt: 61,
  });
  const failedContinuationHtml = codingRunPanelHtml({
    state,
    events: [proposal, resolution, codingConversationMessageEvent(humanReply), codingConversationRouteEvent(ready)],
    runId: "coding-human-escalation",
    job: { id: "continuation-job", status: "failed", error: "worker runtime exited" },
  });
  assert.match(failedContinuationHtml, /No human answer is requested/);
  assert.match(failedContinuationHtml, /The bounded run stopped before certification/);
  assert.doesNotMatch(failedContinuationHtml, /worker runtime exited/);
  const failedContinuationAction = failedContinuationHtml.match(/<section class="coding-human-action"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.doesNotMatch(failedContinuationAction, /Both authenticated delivery contracts are repository-compatible/);
  assert.doesNotMatch(failedContinuationHtml, /data-coding-human-reply/);

  const injected = inlineArtifactPublishedEvent({
    runId: "coding-injected-ambiguity",
    artifactId: "artifact-injected-resolution",
    origin: "input",
    outputKey: "collaboration_resolution",
    nodeId: "coding.resolution.dynamic",
    kind: "application/json",
    inputVersions: {},
  }, resolution.payload.storage === "inline" ? resolution.payload.value : "");
  const injectedState = reduceOrchestration(initialOrchestrationState, injected, 10);
  const injectedHtml = codingRunPanelHtml({
    state: injectedState,
    events: [injected],
    runId: "coding-injected-ambiguity",
    job: { id: "injected-job", status: "failed", error: "invalid peer route" },
  });
  assert.match(injectedHtml, /No human answer is requested/);
  assert.doesNotMatch(injectedHtml, /data-coding-human-reply/);
});

test("an answered historical ambiguity links to and follows the bounded continuation", () => {
  const { state, proposal, resolution } = exhaustedAmbiguityFixture();
  const humanReply = createCodingConversationMessage({
    conversationId: "coding-human-escalation",
    author: { kind: "user", id: "human.operator", name: "You" },
    source: { kind: "ui" },
    text: "Use attachment compatibility.",
    tags: ["intent:human-resolution"],
    createdAt: 40,
  });
  const route = createCodingConversationRoute({
    conversationId: "coding-human-escalation",
    inReplyTo: humanReply.messageId,
    disposition: "ready",
    selectedNodeIds: ["workspace.implementation"],
    primaryNodeId: "workspace.implementation",
    coordination: { reviewMode: "fast", validationScope: "focused" },
    tags: ["intent:implementation"],
    questions: [],
    rationale: "The human answer supplied the missing product intent.",
    confidence: 0.95,
    createdAt: 41,
  });
  const html = codingRunPanelHtml({
    state,
    events: [
      proposal,
      resolution,
      codingConversationMessageEvent(humanReply),
      codingConversationRouteEvent(route),
    ],
    runId: "coding-human-escalation",
    workspaceId: "workspace_0123456789abcdef0123",
    job: {
      id: "historical-job",
      status: "failed",
      error: "Peer collaboration remains explicitly conflicted after temporary resolution",
    },
    conversationJob: {
      id: "continuation-job",
      status: "running",
      reviewPolicy: "reviewed",
      workerRuntime: "codex-cli",
    },
  });

  assert.match(html, /Answer received/);
  assert.match(html, /Your answer was recorded/);
  assert.match(html, /new bounded continuation is working/);
  assert.match(html, /intentional ambiguity stop is not a runtime or repository failure/);
  assert.match(html, /workspace=workspace_0123456789abcdef0123&amp;run=coding-human-escalation&amp;job=continuation-job/);
  assert.match(html, /Roster is continuing with your answer/);
  assert.match(html, /data-coding-social-row[^>]*data-source-kind="message"[^>]*data-author-node-id="human\.operator"/);
  assert.doesNotMatch(html, /data-coding-run-progress/);
  assert.doesNotMatch(html, /No human answer is requested/);
  assert.doesNotMatch(html, /correct the runtime or repository condition/);
});

test("recovery uses the current dynamic graph failure and accepted work clears it", () => {
  const runningFailureState: OrchestrationState = {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph("coding-running-failure", [{
      taskId: "implement",
      nodeId: "workspace.implementation",
      capability: "implement",
      status: "failed",
      error: "current worker task failed",
    }]),
  };
  const runningFailureHtml = codingRunPanelHtml({
    state: runningFailureState,
    events: [],
    runId: "coding-running-failure",
    job: { id: "running-job", status: "running" },
  });
  assert.match(runningFailureHtml, /No human answer is requested/);
  assert.match(runningFailureHtml, /The bounded run stopped before certification\./);
  assert.doesNotMatch(runningFailureHtml, /current worker task failed/);

  const completedState: OrchestrationState = {
    ...withGraphStatus(runningFailureState, "accepted"),
  };
  const completedHtml = codingRunPanelHtml({
    state: completedState,
    events: [],
    runId: "coding-completed",
    job: { id: "completed-job", status: "completed", noChanges: true },
  });
  assert.doesNotMatch(completedHtml, /class="coding-human-action"/);
  assert.doesNotMatch(completedHtml, /No human answer is requested/);
  assert.match(completedHtml, /The team completed and certified this change/);
});

test("v2 status and collaboration routes preserve every accepted continuation peer response", async () => {
  const fixture = await codingAcceptedContinuationFixture();
  const conversationId = "coding-route-continuation";
  const job: QueueJob = {
    id: "coding-route-continuation-job",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.run",
      runId: fixture.runId,
      conversationId,
      objective: "Preserve every accepted peer response",
      workerExecution: testWorkerExecution(),
    },
    status: "completed",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 2,
    commands: [],
    result: {},
  };
  const routeState: OrchestrationState = {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph(fixture.runId, fixture.snapshot.tasks.map((task) => ({
      taskId: task.definition.taskId,
      nodeId: task.definition.nodeId,
      capability: task.definition.capability,
      status: task.status,
      attempt: task.attempt,
      objective: task.definition.objective,
      dependencies: task.definition.dependencies.map((dependency) => dependency.taskId),
      ...(task.continuationTaskId ? { continuationTaskId: task.continuationTaskId } : {}),
    }))),
  };
  const routeRuntime: CodingAgentRuntime = {
    ...runtime,
    state: async () => routeState,
    stateAt: async () => routeState,
  };
  const queue = {
    enqueue: async () => job,
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (id: string) => id === job.id ? job : undefined,
    listJobs: async () => [job],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const app = new Hono();
  createCodingRoute({
    runtime: routeRuntime,
    queue,
    acceptedOutputs: async (runId) => {
      assert.equal(runId, fixture.runId);
      return projectCodingAcceptedOutputs(fixture.snapshot, fixture.store);
    },
  }).register(app);

  const response = await app.request(`/api/v2/coding/runs/${conversationId}?job=${job.id}`);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    readonly acceptedOutputCount: number;
    readonly outputs: Readonly<Record<string, {
      readonly outputKey: string;
      readonly taskId?: string;
      readonly artifactId: string;
    }>>;
    readonly tasks: Readonly<Record<string, { readonly outputKeys: ReadonlyArray<string> }>>;
  };
  const dataKey = "accepted-output/12:consult_data/13:peer_response";
  const securityKey = "accepted-output/16:consult_security/13:peer_response";
  assert.equal(body.acceptedOutputCount, 7);
  assert.deepEqual([body.outputs[dataKey]?.outputKey, body.outputs[securityKey]?.outputKey], [
    "peer_response",
    "peer_response",
  ]);
  assert.notEqual(body.outputs[dataKey]?.artifactId, body.outputs[securityKey]?.artifactId);
  assert.deepEqual(body.tasks.consult_data?.outputKeys, [dataKey]);
  assert.deepEqual(body.tasks.consult_security?.outputKeys, [securityKey]);
  assert.equal(body.outputs.implementation_report?.taskId, "continue_implementation");
  assert.equal(body.outputs.implementation_report?.artifactId, "artifact-continue_implementation");

  const collaboration = await app.request(
    `/api/v2/coding/runs/${conversationId}/collaboration.md?job=${job.id}`,
  );
  assert.equal(collaboration.status, 200);
  const record = await collaboration.text();
  assert.match(record, /authoritative accepted-output snapshot with 7 outputs/);
  assert.match(record, /consult\\_data — accepted/);
  assert.match(record, /consult\\_security — accepted/);
});

test("v2 status hydrates one immutable accepted-output snapshot per request", async () => {
  const fixture = await codingAcceptedContinuationFixture();
  const conversationId = "coding-route-immutable-accepted-output";
  const job: QueueJob = {
    id: "coding-route-immutable-accepted-output-job",
    agentId: "coding-agent",
    lane: "collect",
    payload: {
      kind: "coding-agent.run",
      runId: fixture.runId,
      conversationId,
      objective: "Project one immutable accepted-output snapshot",
      workerExecution: testWorkerExecution(),
    },
    status: "completed",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 2,
    commands: [],
    result: {},
  };
  const routeState: OrchestrationState = {
    ...initialOrchestrationState,
    taskGraph: projectedTaskGraph(fixture.runId, fixture.snapshot.tasks.map((task) => ({
      taskId: task.definition.taskId,
      nodeId: task.definition.nodeId,
      capability: task.definition.capability,
      status: task.status,
      attempt: task.attempt,
      objective: task.definition.objective,
      dependencies: task.definition.dependencies.map((dependency) => dependency.taskId),
      ...(task.continuationTaskId ? { continuationTaskId: task.continuationTaskId } : {}),
    }))),
  };
  const routeRuntime: CodingAgentRuntime = {
    ...runtime,
    state: async () => routeState,
    stateAt: async () => routeState,
  };
  const queue = {
    enqueue: async () => job,
    leaseNext: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
    queueCommand: async () => undefined,
    consumeCommands: async () => [],
    getJob: async (id: string) => id === job.id ? job : undefined,
    listJobs: async () => [job],
    waitForJob: async () => undefined,
  } as AgentLoaderContext["queue"];
  const projected = await projectCodingAcceptedOutputs(fixture.snapshot, fixture.store);
  const peerOutputs = projected.outputs.filter((output) => output.outputKey === "peer_response");
  const dataOutput = peerOutputs.find((output) => output.taskId === "consult_data")!;
  const singleton = { outputs: [dataOutput], omittedCount: 0 } as const;
  const multiple = { outputs: peerOutputs, omittedCount: 0 } as const;
  const dataKey = "accepted-output/12:consult_data/13:peer_response";
  const securityKey = "accepted-output/16:consult_security/13:peer_response";

  const requestWithStatefulLoader = async (
    sequence: readonly [typeof singleton | typeof multiple, typeof singleton | typeof multiple],
  ) => {
    let calls = 0;
    const app = new Hono();
    createCodingRoute({
      runtime: routeRuntime,
      queue,
      acceptedOutputs: async (runId) => {
        assert.equal(runId, fixture.runId);
        const selected = sequence[Math.min(calls, sequence.length - 1)]!;
        calls += 1;
        return selected;
      },
    }).register(app);
    const response = await app.request(`/api/v2/coding/runs/${conversationId}?job=${job.id}`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      readonly acceptedOutputCount: number;
      readonly outputs: Readonly<Record<string, {
        readonly outputKey: string;
        readonly taskId?: string;
        readonly artifactId: string;
      }>>;
      readonly tasks: Readonly<Record<string, { readonly outputKeys: ReadonlyArray<string> }>>;
    };
    assert.equal(calls, 1, "one status response must use one accepted-output read");
    return body;
  };

  const singletonFirst = await requestWithStatefulLoader([singleton, multiple]);
  assert.equal(singletonFirst.acceptedOutputCount, 1);
  assert.equal(singletonFirst.outputs[dataKey]?.artifactId, dataOutput.artifactId);
  assert.equal(singletonFirst.outputs.peer_response?.artifactId, dataOutput.artifactId);
  assert.equal(singletonFirst.outputs[securityKey], undefined);
  assert.deepEqual(singletonFirst.tasks.consult_data?.outputKeys, [dataKey, "peer_response"]);
  assert.deepEqual(singletonFirst.tasks.consult_security?.outputKeys, []);

  const multipleFirst = await requestWithStatefulLoader([multiple, singleton]);
  assert.equal(multipleFirst.acceptedOutputCount, 2);
  assert.equal(multipleFirst.outputs[dataKey]?.taskId, "consult_data");
  assert.equal(multipleFirst.outputs[securityKey]?.taskId, "consult_security");
  assert.equal(multipleFirst.outputs.peer_response, undefined);
  assert.deepEqual(multipleFirst.tasks.consult_data?.outputKeys, [dataKey]);
  assert.deepEqual(multipleFirst.tasks.consult_security?.outputKeys, [securityKey]);
});
