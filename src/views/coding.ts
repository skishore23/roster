import { MiniGFM } from "@oblivionocean/minigfm";

import { codingSlackWorkspaceCss } from "./coding-workspace-style.js";

import { readCodingBuildManifest } from "../runtime/coding-build.js";
import type { JobStatus } from "../modules/job.js";
import type { CodingWorkerRuntime } from "../domains/coding.js";
import type { CodingMcpDiscovery } from "../engine/runtime/coding-mcp-discovery.js";
import { DEFAULT_OPENAI_MODEL } from "../models.js";
import {
  CODING_WORKSPACE_CODEX_MODELS,
  CODING_WORKSPACE_CLAUDE_MODELS,
  CODING_WORKSPACE_HERMES_MODELS,
  CODING_WORKSPACE_PI_MODELS,
  DEFAULT_CODING_WORKSPACE_CODEX_MODEL,
  DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL,
  DEFAULT_CODING_WORKSPACE_HERMES_MODEL,
  DEFAULT_CODING_WORKSPACE_PI_MODEL,
  DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME,
  CODING_HUMAN_NODE_ID,
  codingCoordinatorWorkspaceNode,
  codingHumanWorkspaceNode,
  codingWorkspaceNodePreference,
  codingWorkspaceSelectedModel,
  type CodingWorkspaceClaudeModel,
  type CodingWorkspaceCodexModel,
  type CodingWorkspaceHermesModel,
  type CodingWorkspaceSettings,
  type CodingWorkspacePiModel,
  type CodingWorkspaceWorkerModel,
  type CodingWorkspaceProfile,
  type CodingWorkspaceWorkerRuntime,
} from "../domains/coding-workspace.js";
import {
  CODING_ROOM_REACTION_KIND,
  codingRoomProjection,
  type CodingDeliveryDisposition,
  type CodingDurableRoom,
} from "../domains/coding-room.js";
import {
  codingDeliveryState,
  codingRunDeliveryState as resolveCodingRunDeliveryState,
  codingTerminalOutcome,
  type CodingDeliveryState,
} from "../domains/coding-terminal.js";
import {
  CODING_CONVERSATION_MESSAGE_KIND,
  CODING_CONVERSATION_ROUTE_KIND,
  codingConversationFromEvents,
  type CodingConversationRoute,
} from "../domains/coding-conversation.js";
import { codingControlDeliveriesFromEvents } from "../domains/coding-control-ingress.js";
import {
  CODING_COLLABORATION_RESOLUTION_OUTPUT,
  codingCollaborationStatus,
  parseCodingPeerEndorsement,
  parseCodingPeerProposal,
  parseCodingPeerResponse,
  parseCodingPeerResolution,
  type CodingPeerEndorsement,
  type CodingPeerProposal,
  type CodingPeerResponse,
  type CodingPeerResolution,
} from "../domains/coding-collaboration.js";
import {
  orchestrationOutputValues,
  type OrchestrationEvent,
  type OrchestrationState,
} from "../modules/orchestration.js";
import { hashCanonical } from "../core/canonical.js";
import { esc, truncate } from "./agent-framework.js";
import {
  generativeUiCss,
  generativeUiReplyHtml,
  type GenerativeUiReply,
} from "./generative-ui.js";
import { themeBootstrapScript, themeCss } from "./theme.js";
import {
  agentShellChromeCss,
  agentShellFrameHtml,
  agentTopNavHtml,
  agentWorkspaceThemeTokens,
} from "./agent-shell.js";
import type { StoredNodeRuntimeLog } from "../engine/runtime/node-runtime-log.js";
import type { NodeRoomUpdate } from "../engine/runtime/node-room-updates.js";
import {
  projectCodingSocialRows,
  type CodingSocialAcceptedSummaryInput,
  type CodingSocialMessageInput,
  type CodingSocialParticipant,
  type CodingSocialRow,
} from "../browser/coding-social-transcript.js";
import { codingRunAttentionDetail, isCodingUserVisibleTask } from "../browser/coding-presentation.js";
import { projectRoomRoster } from "../engine/workspace/room.js";
import type { WorkspaceNode, WorkspaceNodeRuntime } from "../engine/orchestration/types.js";
import type { NodeContinuitySummary } from "../engine/workspace/node-continuity.js";
import { roomRosterCss, roomRosterHtml } from "./room-roster.js";
import { parseCodingInvestigationReport } from "./coding-investigation-report.js";
import {
  participantProfileAttributes,
  participantProfileCss,
  participantProfileDialogHtml,
  type ParticipantContinuitySeed,
} from "./participant-profile.js";

const codingThemeTokens = agentWorkspaceThemeTokens;

const codingMarkdown = new MiniGFM();
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export type CodingRealtimeConfig = {
  readonly enabled: boolean;
  readonly uri: string;
  readonly database: string;
  readonly confirmedReads: boolean;
  readonly workspaceId: string;
  readonly capabilitySecret?: string;
  readonly activeRunId?: string;
};

const codingMarkdownHtml = (value: string): string => {
  const content = value.trim();
  return content
    ? codingMarkdown.parse(content)
      .replace(/(?:<li>[\s\S]*?<\/li>\s*)+/gu, (items) => `<ul>${items.trim()}</ul>`)
      .replace(/<br \/>\s*<ul>/gu, "<ul>")
      .replace(/<\/ul>\s*<br \/>/gu, "</ul>")
    : "<p>No response content.</p>";
};

const codingAuthoredSafeHref = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
};

const codingAuthoredMarkdownHtml = (value: string): string => {
  const rendered = codingMarkdownHtml(value.replace(/</gu, "&lt;"));
  const tagPattern = /<\/?([A-Za-z][A-Za-z0-9]*)\b[^>]*>/gu;
  const stack: Array<{ readonly name: string; readonly rendered: boolean }> = [];
  const safeElements = new Set(["p", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li"]);
  const safeText = (text: string): string => text
    .replace(/&#38;?lt;/gu, "&lt;")
    .replace(/&#62;?/gu, "&gt;")
    .replace(/&#39;?/gu, "&#39;");
  let output = "";
  let cursor = 0;
  for (let match = tagPattern.exec(rendered); match; match = tagPattern.exec(rendered)) {
    output += safeText(rendered.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const raw = match[0];
    const name = match[1]!.toLowerCase();
    if (raw.startsWith("</")) {
      let matchingIndex = -1;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]!.name === name) {
          matchingIndex = index;
          break;
        }
      }
      if (matchingIndex < 0) {
        output += esc(raw);
        continue;
      }
      while (stack.length > matchingIndex) {
        const opened = stack.pop()!;
        if (opened.rendered) output += `</${opened.name}>`;
      }
      continue;
    }
    if (name === "br") {
      output += /^<br\s*\/>$/u.test(raw) || raw === "<br>" ? "<br>" : esc(raw);
      continue;
    }
    if (name === "img") {
      const alt = /\salt="([^"]*)"/u.exec(raw)?.[1]?.trim();
      output += `[Image${alt ? `: ${alt}` : ""}]`;
      continue;
    }
    if (name === "input") {
      const checkbox = /^<input\s+type="checkbox"\s*(checked\s*)?disabled>$/u.exec(raw);
      output += checkbox ? `<input type="checkbox"${checkbox[1] ? " checked" : ""} disabled>` : esc(raw);
      continue;
    }
    if (name === "a") {
      const href = /^<a href="([^"]*)">$/u.exec(raw)?.[1];
      const safeHref = href === undefined ? undefined : codingAuthoredSafeHref(href);
      stack.push({ name, rendered: safeHref !== undefined });
      if (safeHref !== undefined) {
        output += `<a href="${esc(safeHref)}" rel="noopener noreferrer">`;
      }
      continue;
    }
    if (name === "pre") {
      const language = /^<pre lang="([A-Za-z0-9_-]{1,40})">$/u.exec(raw)?.[1];
      const allowed = raw === "<pre>" || language !== undefined;
      stack.push({ name, rendered: allowed });
      output += allowed ? `<pre${language ? ` lang="${esc(language)}"` : ""}>` : esc(raw);
      continue;
    }
    if (name === "code") {
      const allowed = raw === "<code>" || /^<code class="hljs [A-Za-z0-9_-]+ lang-[A-Za-z0-9_-]+">$/u.test(raw);
      stack.push({ name, rendered: allowed });
      output += allowed ? "<code>" : esc(raw);
      continue;
    }
    const allowed = safeElements.has(name) && raw === `<${name}>`;
    stack.push({ name, rendered: allowed });
    output += allowed ? raw : esc(raw);
  }
  output += safeText(rendered.slice(cursor));
  while (stack.length > 0) {
    const opened = stack.pop()!;
    if (opened.rendered) output += `</${opened.name}>`;
  }
  return output;
};

const codingAuthoredMessageBodyHtml = (value: string): string =>
  `<div class="coding-message-body">${codingAuthoredMarkdownHtml(value)}</div>`;

export type CodingDemoJob = {
  readonly id: string;
  readonly executionId?: string;
  readonly runKind?: "coding" | "investigation" | "workspace-rescan";
  readonly readOnly?: boolean;
  readonly integratable?: boolean;
  readonly status: JobStatus;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly updatedAt?: number;
  readonly leaseUntil?: number;
  readonly reviewPolicy?: "auto" | "fast" | "reviewed";
  readonly coordination?: {
    readonly reviewMode: "fast" | "reviewed";
    readonly validationScope: "focused" | "repository-wide";
  };
  readonly workerRuntime?: CodingWorkerRuntime;
  readonly workerModel?: string;
  readonly workerProvider?: string;
  readonly workerPackages?: ReadonlyArray<string>;
  readonly workerSelectionSource?: "api-override" | "node-preference" | "workspace-default" | "product-default";
  readonly improvement?: {
    readonly snapshotHash: string;
    readonly generationId: string;
  } | null;
  readonly objective?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly baselineBranch?: string;
  readonly baselineCommit?: string;
  readonly sourceCheckoutDirty?: boolean;
  readonly noChanges?: boolean;
  readonly gitOutcome?: "committed" | "no_changes";
  readonly integration?: {
    readonly integrated: boolean;
    readonly canIntegrate: boolean;
    readonly currentBranch?: string;
    readonly reason?: string;
  };
  readonly deliveryDisposition?: CodingDeliveryDisposition;
  readonly error?: string;
};

const codingHasCertifiedDelivery = (job?: CodingDemoJob): boolean =>
  Boolean(job?.commit && (job.integration || job.deliveryDisposition));

export type CodingWorkerRuntimeOption = {
  readonly value: CodingWorkerRuntime;
  readonly label: string;
  readonly detail: string;
  readonly mcp?: CodingMcpDiscovery;
};

export const DEFAULT_CODING_WORKER_RUNTIME_OPTIONS: ReadonlyArray<CodingWorkerRuntimeOption> = [
  { value: "pi-agent", label: "Pi Code · AFT", detail: "Pi with curated AST, search, and LSP extensions" },
  { value: "hermes-agent", label: "Hermes Agent", detail: "Nous Hermes in quiet one-shot mode" },
  { value: "claude-code", label: "Claude Code", detail: "Installed implementation runtime" },
  { value: "codex-cli", label: "Codex CLI", detail: "Native OpenAI Codex CLI" },
];

export type CodingRecentRun = CodingDemoJob & {
  readonly runId: string;
  readonly executionId?: string;
  readonly conversationId?: string;
  readonly objective?: string;
  readonly terminal: boolean;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly canceledReason?: string;
};

export type CodingAttentionItem = {
  readonly id: string;
  readonly kind: "needs-input" | "failed" | "merge-ready" | "merge-blocked";
  readonly title: string;
  readonly detail: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly conversationId: string;
  readonly jobId: string;
  readonly updatedAt: number;
  readonly targetBranch?: string;
};

export type CodingWorkspaceOption = {
  readonly id: string;
  readonly name: string;
  readonly repositoryPath: string;
  readonly selected: boolean;
  readonly scanned: boolean;
};

export type CodingRepositoryGitState = {
  readonly path: string;
  readonly remote: string;
  readonly account: string;
  readonly branch: string;
  readonly headCommit: string;
  readonly workingTree: "clean" | "dirty" | "unknown";
  readonly changedFiles: number;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
};

export type CodingReviewDiff = {
  readonly summary: string;
  readonly files: ReadonlyArray<{ readonly status: string; readonly path: string }>;
  readonly truncated: boolean;
  readonly patch: {
    readonly text: string;
    readonly bytes: number;
    readonly truncated: boolean;
  };
};

type CodingReviewLine = {
  readonly kind: "addition" | "deletion" | "context" | "meta";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
};

type CodingReviewFile = {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly lines: ReadonlyArray<CodingReviewLine>;
};

const MAX_REVIEW_LINES = 2_000;

const titleCase = (value: string): string => value
  .replace(/[-_.]+/g, " ")
  .replace(/\b\w/g, (character) => character.toUpperCase())
  .replace(/\b(Api|Ui|Cli|Ci|Pr|Id|Url|Http|Rpc|Sql|A2a)\b/g, (word) => ({
    Api: "API",
    Ui: "UI",
    Cli: "CLI",
    Ci: "CI",
    Pr: "PR",
    Id: "ID",
    Url: "URL",
    Http: "HTTP",
    Rpc: "RPC",
    Sql: "SQL",
    A2a: "A2A",
  } as Readonly<Record<string, string>>)[word] ?? word);

const repositoryName = (repositoryPath: string): string => {
  const parts = repositoryPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? repositoryPath;
};

type CodingAgentTone = "lead" | "product" | "build" | "quality" | "interface" | "api" | "data" | "docs" | "security" | "runtime" | "ml" | "experiment";

type CodingAgentIdentityInput = {
  readonly id?: string;
  readonly name: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

type CodingAgentVisual = {
  readonly name: string;
  readonly role: string;
  readonly tone: CodingAgentTone;
};

const codingAgentVisual = (node: CodingAgentIdentityInput): CodingAgentVisual => {
  const specialty = typeof node.metadata?.specialty === "string" ? node.metadata.specialty : "";
  const givenName = typeof node.metadata?.givenName === "string" ? node.metadata.givenName : undefined;
  const displayRole = typeof node.metadata?.displayRole === "string" ? node.metadata.displayRole : undefined;
  const resolutionReviewer = node.metadata?.collaborationRole === "temporary-resolver";
  const context = [node.id, node.name, specialty, ...(node.capabilities ?? [])].filter(Boolean).join(" ").toLowerCase();
  const [fallbackName, ...fallbackRole] = node.name.split(",").map((value) => value.trim()).filter(Boolean);
  const tone: CodingAgentTone = /temporary-resolver|\bresolve\b|coordinat|facilitator/.test(context)
    ? "lead"
    : /participantkind human|product-context|workspace operator/.test(context)
      ? "product"
      : /security/.test(context)
        ? "security"
        : /machine-learning|ml systems|model architecture/.test(context)
          ? "ml"
          : /experiment|evaluation|reproducibility/.test(context)
            ? "experiment"
            : /runtime|infrastructure|deploy/.test(context)
              ? "runtime"
              : /document|technical writer|\bdocs?\b/.test(context)
                ? "docs"
                : /interface|\bui\b|\bux\b|designer/.test(context)
                  ? "interface"
                  : /\bapi\b|service architect/.test(context)
                    ? "api"
                    : /\bdata\b|database|schema/.test(context)
                      ? "data"
                      : /quality|reviewer|validation|\bqa\b/.test(context)
                        ? "quality"
                        : "build";
  return {
    name: resolutionReviewer ? "Resolution Reviewer" : givenName ?? fallbackName ?? node.name,
    role: resolutionReviewer
      ? "Run-scoped conflict review"
      : (displayRole ?? fallbackRole.join(", ")) || "Specialist",
    tone,
  };
};

const codingAgentGlyphs: Readonly<Record<CodingAgentTone, string>> = {
  lead: '<path d="M8 3v3m0 0L4 9m4-3 4 3"/><circle cx="8" cy="2.5" r="1.5"/><circle cx="4" cy="11" r="1.5"/><circle cx="12" cy="11" r="1.5"/>',
  product: '<path d="m8 2 4.5 4.5L8 14 3.5 6.5 8 2Z"/><path d="m6.5 9.5 1-3 2-1-1 3-2 1Z"/>',
  build: '<path d="m5.5 4-3 4 3 4M10.5 4l3 4-3 4M9 2.5 7 13.5"/>',
  quality: '<circle cx="8" cy="8" r="5.5"/><path d="m5.2 8.1 1.8 2 3.8-4.2"/>',
  interface: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6h11M6 6v7"/>',
  api: '<circle cx="3.5" cy="8" r="1.5"/><circle cx="12.5" cy="4" r="1.5"/><circle cx="12.5" cy="12" r="1.5"/><path d="m5 7.4 6-2.8M5 8.6l6 2.8"/>',
  data: '<ellipse cx="8" cy="4" rx="4.5" ry="2"/><path d="M3.5 4v4c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4M3.5 8v4c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V8"/>',
  docs: '<path d="M4 2.5h5l3 3v8H4v-11Z"/><path d="M9 2.5v3h3M6 8h4M6 10.5h4"/>',
  security: '<path d="M8 2.2 12.5 4v3.5c0 3-1.8 5.2-4.5 6.3-2.7-1.1-4.5-3.3-4.5-6.3V4L8 2.2Z"/><path d="m5.8 8 1.4 1.5 3-3.2"/>',
  runtime: '<path d="M9 1.8 4.5 8H8l-1 6.2L11.5 8H8l1-6.2Z"/>',
  ml: '<circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4"/>',
  experiment: '<path d="M6 2.5h4M7 2.5v3l-3.5 6a1.3 1.3 0 0 0 1.1 2h6.8a1.3 1.3 0 0 0 1.1-2L9 5.5v-3M5.2 9h5.6"/>',
};

const codingAgentSymbolHtml = (visual: CodingAgentVisual, className = ""): string =>
  `<span class="coding-agent-symbol${className ? ` ${className}` : ""}" data-agent-tone="${visual.tone}" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${codingAgentGlyphs[visual.tone]}</svg></span>`;

const parsedReport = (value: string | undefined): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

const reportString = (value: unknown, max = 1_000): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

const reportStringArray = (value: unknown, max = 12): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 1_000))
    .slice(0, max);
  return strings.length > 0 ? strings : undefined;
};

type CodingDisplayResult = {
  readonly status?: string;
  readonly summary?: string;
  /** Only the validated read-only investigation report has public detail fields. */
  readonly answer?: string;
  readonly findings?: ReadonlyArray<{
    readonly claim: string;
    readonly evidence: ReadonlyArray<string>;
  }>;
  readonly files?: ReadonlyArray<string>;
  readonly limitations?: ReadonlyArray<string>;
  readonly specialistReports?: ReadonlyArray<string>;
};

const displayResult = (
  outputs: Readonly<Record<string, string>>,
  investigation = false,
): CodingDisplayResult | undefined => {
  const workspaceRescan = parsedReport(outputs.workspace_rescan_result);
  if (workspaceRescan) {
    const specialistCount = typeof workspaceRescan.specialistCount === "number" ? workspaceRescan.specialistCount : 0;
    const conflictCount = typeof workspaceRescan.conflictCount === "number" ? workspaceRescan.conflictCount : 0;
    const enrichmentStatus = reportString(workspaceRescan.enrichmentStatus, 40) ?? "complete";
    return {
      status: enrichmentStatus,
      summary: `${specialistCount} specialist profile${specialistCount === 1 ? "" : "s"} published for future conversations${conflictCount ? ` with ${conflictCount} visible dependency conflict${conflictCount === 1 ? "" : "s"}` : ""}. Existing runs keep their original roster; no source branch was created.`,
    };
  }
  const rawReport = outputs.final_report ?? outputs.review_report ?? outputs.implementation_report;
  const report = parsedReport(rawReport);
  if (!report) return undefined;
  const investigationReport = investigation ? parseCodingInvestigationReport(rawReport) : undefined;
  const status = reportString(report.status, 120);
  const summary = reportString(report.summary, 1_000);
  if (!status && !summary && !investigationReport) return undefined;
  return {
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
    ...(investigationReport ? {
      answer: investigationReport.answer,
      findings: investigationReport.findings,
      files: investigationReport.files,
      limitations: investigationReport.limitations,
      specialistReports: investigationReport.specialistReports,
    } : {}),
  };
};

const workspaceRescanOutcomeMap = (outputs: Readonly<Record<string, string>>): ReadonlyMap<string, string> => {
  const result = parsedReport(outputs.workspace_rescan_result);
  if (!Array.isArray(result?.specialistOutcomes)) return new Map();
  return new Map(result.specialistOutcomes.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const row = candidate as Record<string, unknown>;
    const nodeId = reportString(row.nodeId, 200);
    const state = reportString(row.state, 80);
    return nodeId && state ? [[nodeId, state] as const] : [];
  }));
};

const timeAgoLabel = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown";
  const seconds = Math.floor(Math.max(0, Date.now() - timestamp) / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const recentRunTone = (status: JobStatus): "active" | "success" | "failed" | "idle" => {
  if (["queued", "leased", "running"].includes(status)) return "active";
  if (status === "completed") return "success";
  if (status === "failed" || status === "canceled") return "failed";
  return "idle";
};

const codingModelLabel = (model: string): string => model
  .replace(/^openai(?:-codex)?\//, "")
  .replace("gpt-5.6-sol", "GPT-5.6 Sol")
  .replace("gpt-5.6-terra", "GPT-5.6 Terra")
  .replace("gpt-5.6-luna", "GPT-5.6 Luna")
  .replace(/^opus$/u, "Opus")
  .replace(/^sonnet$/u, "Sonnet")
  .replace(/^haiku$/u, "Haiku")
  .replace(/^default$/u, "Provider default");

const codingModelDescription = (model: string): string => model.endsWith("sol")
  ? "Frontier reasoning for complex repository work"
  : model.endsWith("terra")
    ? "Balanced capability and latency"
    : model === "opus"
      ? "Claude's most capable model alias"
      : model === "sonnet"
        ? "Claude's balanced model alias"
        : model === "haiku"
          ? "Claude's fastest model alias"
          : model === "default"
            ? "Use the Hermes provider's configured default"
            : "Fast, economical execution";

const codingModelOptionsHtml = (
  models: ReadonlyArray<string>,
  selected: string,
): string => models.map((model) => `<option value="${esc(model)}" data-description="${esc(codingModelDescription(model))}"${model === selected ? " selected" : ""}>${esc(codingModelLabel(model))}</option>`).join("");

const codingRuntimeOption = (runtime: CodingWorkspaceWorkerRuntime): CodingWorkerRuntimeOption =>
  DEFAULT_CODING_WORKER_RUNTIME_OPTIONS.find((option) => option.value === runtime) ?? {
    value: runtime,
    label: runtime,
    detail: "Saved runtime preference",
  };

const codingRuntimeOptionsHtml = (
  available: ReadonlyArray<CodingWorkerRuntimeOption>,
  selected?: CodingWorkspaceWorkerRuntime,
  preserved: ReadonlyArray<CodingWorkspaceWorkerRuntime> = [],
): string => {
  const availableIds = new Set(available.map((option) => option.value));
  const ids = [...new Set([
    ...available.map((option) => option.value),
    ...preserved,
    ...(selected ? [selected] : []),
  ])];
  return ids.map((runtime) => {
    const option = available.find((candidate) => candidate.value === runtime) ?? codingRuntimeOption(runtime);
    const unavailable = !availableIds.has(runtime);
    const mcpNames = option.mcp?.servers.map((server) => server.name) ?? [];
    const mcpDetail = option.mcp?.readiness === "discovered"
      ? ` · MCP discovered: ${mcpNames.slice(0, 3).join(", ")}${mcpNames.length > 3 || option.mcp.truncated ? ` +${Math.max(1, mcpNames.length - 3)} more` : ""}`
      : option.mcp?.readiness === "probe-failed"
        ? " · MCP discovery unavailable"
        : option.mcp?.readiness === "extension-managed"
          ? " · MCP is extension-managed"
          : "";
    const detail = `${option.detail}${mcpDetail}${unavailable ? " · currently unavailable" : ""}`;
    const mcpAttributes = option.mcp
      ? ` data-mcp-readiness="${esc(option.mcp.readiness)}" data-mcp-count="${String(option.mcp.servers.length)}"`
      : "";
    return `<option value="${esc(runtime)}" data-description="${esc(detail)}"${mcpAttributes}${runtime === selected ? " selected" : ""}>${esc(option.label)}${unavailable ? " · unavailable" : ""}</option>`;
  }).join("");
};

const codingParticipantRuntimeEditorHtml = (options: {
  readonly runtimeOptions: ReadonlyArray<CodingWorkerRuntimeOption>;
  readonly workspaceSettings?: CodingWorkspaceSettings;
}): string => {
  const preserved = options.workspaceSettings
    ? [options.workspaceSettings.workerRuntime, ...options.workspaceSettings.nodePreferences.map((preference) => preference.workerRuntime)]
    : [];
  return `<details class="participant-profile-editor participant-runtime-editor" data-participant-runtime-editor hidden>
  <summary>Change agent or model</summary>
  <form action="/coding/workspace/settings" method="post" data-participant-runtime-form>
    <input type="hidden" name="workspaceId"/>
    <input type="hidden" name="nodeId"/>
    <label><span>Agent</span><select name="workerRuntime" data-participant-runtime-select>${codingRuntimeOptionsHtml(options.runtimeOptions, undefined, preserved)}</select></label>
    <label data-participant-model-field="pi-agent"><span>Model</span><select name="piModel">${codingModelOptionsHtml(CODING_WORKSPACE_PI_MODELS, DEFAULT_CODING_WORKSPACE_PI_MODEL)}</select></label>
    <label data-participant-model-field="codex-cli"><span>Model</span><select name="codexModel">${codingModelOptionsHtml(CODING_WORKSPACE_CODEX_MODELS, DEFAULT_CODING_WORKSPACE_CODEX_MODEL)}</select></label>
    <label data-participant-model-field="claude-code"><span>Model</span><select name="claudeModel">${codingModelOptionsHtml(CODING_WORKSPACE_CLAUDE_MODELS, DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL)}</select></label>
    <label data-participant-model-field="hermes-agent"><span>Model</span><select name="hermesModel">${codingModelOptionsHtml(CODING_WORKSPACE_HERMES_MODELS, DEFAULT_CODING_WORKSPACE_HERMES_MODEL)}</select></label>
    <p class="participant-runtime-note">Applies to this teammate’s future mutation assignments. Active and historical runs keep their recorded binding.</p>
    <footer><p data-participant-runtime-status role="status" aria-live="polite" aria-atomic="true"></p><button type="submit">Save agent &amp; model</button></footer>
  </form>
</details>`;
};

const codingAgentModelHtml = (
  agent: string,
  model: string,
  className = "coding-agent-model",
): string => {
  const pendingAgent = agent === "Agent binding pending";
  const pendingModel = model === "Model pending";
  if (pendingAgent && pendingModel) return "";
  return `<span class="${esc(className)}" data-coding-agent="${esc(agent)}" data-coding-model="${esc(model)}">${pendingAgent ? "" : `<span><b>Agent</b> ${esc(agent)}</span>`}${pendingModel ? "" : `<span><b>Model</b> ${esc(model)}</span>`}</span>`;
};

const codingProjectRailHtml = (options: {
  readonly profile: CodingWorkspaceProfile;
  readonly repositoryPath: string;
  readonly recentRuns: ReadonlyArray<CodingRecentRun>;
  readonly rooms: ReadonlyArray<CodingDurableRoom>;
  readonly currentRunId?: string;
  readonly currentJobId?: string;
  readonly workspaceId: string;
  readonly workspaces: ReadonlyArray<CodingWorkspaceOption>;
  readonly runtimeOptions: ReadonlyArray<CodingWorkerRuntimeOption>;
  readonly workspaceWorkerRuntime: CodingWorkspaceWorkerRuntime;
  readonly workspaceWorkerModel: CodingWorkspaceWorkerModel;
  readonly workspaceSettings?: CodingWorkspaceSettings;
  readonly teamRefreshNotice?: string;
  readonly attentionItems: ReadonlyArray<CodingAttentionItem>;
  readonly rescanRequestId: string;
  readonly continuitySummaries?: Readonly<Record<string, NodeContinuitySummary>>;
}): string => {
  const technologies = options.profile.technologies.length
    ? options.profile.technologies
    : ["Repository structure"];
  const visibleRooms = options.rooms.slice(0, 12);
  const roomRows = visibleRooms.map((room) => {
    const run = options.recentRuns.find((candidate) =>
      (candidate.conversationId ?? candidate.runId) === room.conversationId);
    const params = new URLSearchParams({
      workspace: options.workspaceId,
      run: room.conversationId,
    });
    if (run) params.set("job", run.id);
    const href = `/coding?${params.toString()}`;
    const active = options.currentRunId === room.conversationId;
    const attention = run
      ? options.attentionItems.find((item) => item.jobId === run.id)
      : undefined;
    const continuity = Object.entries(options.continuitySummaries ?? {}).flatMap(([nodeId, summary]) =>
      summary.lanes
        .filter((lane) => lane.roomId === room.conversationId)
        .map((lane) => ({ nodeId, summary, lane })),
    )[0];
    const roomSummary = attention
      ? attention.kind === "merge-ready" ? "Complete" : "Waiting for you"
      : continuity?.lane.active
        ? "Working"
        : run && ["queued", "leased", "running"].includes(run.status)
          ? "Working"
          : run?.status === "completed"
            ? "Complete"
            : room.state === "waiting"
              ? "Waiting for you"
              : room.messageCount > 0
                ? `${room.messageCount} messages`
                : "New room";
    const tone = attention
      ? attention.kind === "merge-ready" ? "active" : "failed"
      : run ? recentRunTone(run.status) : continuity ? "active" : room.state === "waiting" ? "active" : "idle";
    return `<li data-room-search-entry data-state="${tone}"${run ? ` data-coding-room-job="${esc(run.id)}"` : ""}><a href="${esc(href)}"${active ? " aria-current=\"page\"" : ""}><span class="coding-project-run-state" aria-hidden="true"></span><span><strong>${esc(truncate(room.title, 52))}</strong><small data-coding-room-activity>${esc(roomSummary)}</small></span></a></li>`;
  }).join("");
  const specialistNodes = options.profile.nodes.filter((node) => node.metadata?.participantKind !== "human");
  const fallbackWorkerPreference = {
    workerRuntime: options.workspaceWorkerRuntime,
    codexModel: options.workspaceWorkerRuntime === "codex-cli"
      ? options.workspaceWorkerModel as CodingWorkspaceCodexModel
      : DEFAULT_CODING_WORKSPACE_CODEX_MODEL,
    piModel: options.workspaceWorkerRuntime === "pi-agent"
      ? options.workspaceWorkerModel as CodingWorkspacePiModel
      : DEFAULT_CODING_WORKSPACE_PI_MODEL,
    claudeModel: options.workspaceWorkerRuntime === "claude-code"
      ? options.workspaceWorkerModel as CodingWorkspaceClaudeModel
      : DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL,
    hermesModel: options.workspaceWorkerRuntime === "hermes-agent"
      ? options.workspaceWorkerModel as CodingWorkspaceHermesModel
      : DEFAULT_CODING_WORKSPACE_HERMES_MODEL,
  };
  const specialistRows = specialistNodes.map((node) => {
    const visual = codingAgentVisual(node);
    const reason = typeof node.metadata?.repositoryReason === "string"
      ? node.metadata.repositoryReason
      : node.id === "coordinator"
        ? "Routes each request through the smallest useful subset of the saved team."
        : "Saved repository responsibility.";
    const preference = options.workspaceSettings
      ? codingWorkspaceNodePreference(options.workspaceSettings, node.id)
      : { nodeId: node.id, ...fallbackWorkerPreference };
    const preferredRuntimeLabel = codingRuntimeLabel(preference.workerRuntime);
    const preferredModel = codingModelLabel(codingWorkspaceSelectedModel(preference));
    const skills = Array.isArray(node.metadata?.specialistSkills)
      ? node.metadata.specialistSkills.flatMap((skill) => skill && typeof skill === "object" && !Array.isArray(skill) && typeof skill.name === "string" ? [skill.name] : [])
      : [];
    const dependencyNames = Array.isArray(node.metadata?.dependsOnNodeIds)
      ? node.metadata.dependsOnNodeIds.flatMap((nodeId) => typeof nodeId === "string"
        ? [codingAgentVisual(specialistNodes.find((candidate) => candidate.id === nodeId) ?? { id: nodeId, name: nodeId, capabilities: [] }).name]
        : [])
      : [];
    const dependencyConflictCount = Array.isArray(node.metadata?.dependencyConflicts)
      ? node.metadata.dependencyConflicts.length
      : 0;
    const detail = [
      reason,
      skills.length ? `Skills: ${skills.join(", ")}` : "",
      dependencyNames.length ? `Consumes context from: ${dependencyNames.join(", ")}` : "",
      dependencyConflictCount ? `${dependencyConflictCount} dependency proposal conflict${dependencyConflictCount === 1 ? "" : "s"}; no cyclic edge was silently accepted.` : "",
    ].filter(Boolean).join("\n");
    const continuity = options.continuitySummaries?.[node.id]
      ? codingParticipantContinuitySeed(options.continuitySummaries[node.id]!, options.rooms)
      : node.continuity?.mode === "workspace"
        ? {
            status: "dormant" as const,
            pendingItemCount: 0,
            pendingLaneCount: 0,
            activeCommitmentCount: 0,
            lanes: [],
          }
        : undefined;
    const profileSeed = codingParticipantProfileSeed({
      node,
      nodeId: node.id,
      name: visual.name,
      role: visual.role,
      kind: "agent",
      agent: preferredRuntimeLabel,
      model: preferredModel,
      executionScope: "preference",
      ...(continuity ? { continuity } : {}),
    });
    return `<li title="${esc(detail)}" data-coding-agent-node="${esc(node.id)}">${codingAgentSymbolHtml(visual, "coding-project-agent-mark")}<span><button type="button" class="coding-project-agent-profile participant-profile-trigger" ${participantProfileAttributes(profileSeed)}>${esc(visual.name)}</button><small class="coding-project-agent-role">${esc(visual.role)}</small>${codingAgentModelHtml(preferredRuntimeLabel, preferredModel, "coding-project-agent-execution")}</span><button type="button" class="coding-project-agent-change participant-profile-trigger" ${participantProfileAttributes(profileSeed)} aria-label="Open ${esc(visual.name)} profile and change agent or model">Change</button></li>`;
  }).join("");
  const workspaceRows = options.workspaces.map((workspace) => `<li><a href="/coding?workspace=${encodeURIComponent(workspace.id)}"${workspace.selected ? " aria-current=\"page\"" : ""}><span class="coding-workspace-mark" aria-hidden="true">${esc(workspace.name.slice(0, 1).toUpperCase())}</span><span><strong>${esc(workspace.name)}</strong><small title="${esc(workspace.repositoryPath)}">${esc(workspace.repositoryPath)}</small></span><i aria-hidden="true">${workspace.selected ? "✓" : workspace.scanned ? "" : "○"}</i></a></li>`).join("");
  const workspaceSwitcher = `<details class="coding-workspace-switcher" data-workspace-switcher data-disclosure-key="workspace-switcher">
    <summary class="coding-project-identity" aria-label="Switch workspace, ${esc(repositoryName(options.repositoryPath))} selected"><div><em>Workspace</em><strong translate="no">${esc(repositoryName(options.repositoryPath))}</strong><small title="${esc(options.repositoryPath)}" translate="no">${esc(options.repositoryPath)}</small></div><i aria-hidden="true">›</i></summary>
    <div class="coding-workspace-switcher-panel"><header><strong>Workspaces</strong><span>${options.workspaces.length}</span></header><nav aria-label="Git repository workspaces"><ul>${workspaceRows}</ul></nav><button type="button" class="coding-add-workspace-trigger" aria-haspopup="dialog" aria-controls="coding-workspace-picker"><span aria-hidden="true">＋</span><span>Add Workspace</span></button></div>
  </details>
  <dialog class="coding-workspace-picker" id="coding-workspace-picker" data-workspace-picker aria-labelledby="coding-workspace-picker-title">
    <div class="coding-workspace-picker-surface">
      <div class="coding-workspace-add-progress" data-workspace-add-progress role="status" aria-live="polite" aria-atomic="true" tabindex="-1" hidden>
        <span class="coding-workspace-add-spinner" aria-hidden="true"></span>
        <strong>Reading repository</strong>
        <p data-workspace-add-progress-message>Indexing tracked files and assembling a repository-specific team.</p>
        <progress aria-label="Adding repository and creating its agent team"></progress>
        <small data-workspace-add-progress-elapsed>Starting…</small>
      </div>
      <header class="coding-workspace-picker-header"><span class="coding-workspace-picker-mark" aria-hidden="true">⌘</span><div><h2 id="coding-workspace-picker-title" tabindex="-1">Add a Repository</h2><p>Choose a local Git repository for your Roster workspace.</p></div><form method="dialog"><button type="submit" class="coding-icon-button" aria-label="Close repository picker">×</button></form></header>
      <div class="coding-workspace-picker-body">
        <aside aria-label="Quick locations"><h3>Locations</h3><nav data-workspace-picker-locations></nav><p>Roster reads the repository to create a bounded specialist team. Nothing is pushed.</p></aside>
        <section class="coding-workspace-browser" aria-label="Folder browser">
          <nav class="coding-workspace-breadcrumbs" aria-label="Current folder" data-workspace-picker-breadcrumbs></nav>
          <div class="coding-workspace-current"><div><span>Current Folder</span><strong data-workspace-picker-current>Choose a folder</strong></div><span data-workspace-picker-repo-state></span></div>
          <div class="coding-workspace-folder-list" data-workspace-picker-entries aria-busy="false"></div>
          <p class="coding-workspace-picker-status" role="status" aria-live="polite" data-workspace-picker-status></p>
        </section>
      </div>
      <form class="coding-workspace-picker-footer" action="/coding/workspaces" method="post" data-workspace-picker-form>
        <input name="repositoryPath" type="hidden" data-workspace-picker-path/>
        <div><span>Selected Repository</span><strong data-workspace-picker-selection>Choose a Git repository</strong></div>
        <button type="button" class="coding-button coding-button-secondary" data-workspace-picker-cancel>Cancel</button>
        <button type="submit" class="coding-button coding-button-primary" aria-disabled="true" data-workspace-picker-submit>Add Repository</button>
      </form>
    </div>
  </dialog>`;
  const dependencyConflictCount = options.profile.dependencyConflicts?.length ?? 0;
  const teamState = dependencyConflictCount
    ? `${dependencyConflictCount} unresolved link conflict${dependencyConflictCount === 1 ? "" : "s"}`
    : options.profile.enrichmentEpoch
      ? `evolved ${options.profile.enrichmentEpoch}`
      : options.profile.packageManifestCount
        ? `${options.profile.packageManifestCount} manifests`
      : "ready";
  const returnTo = new URLSearchParams({ workspace: options.workspaceId });
  if (options.currentRunId) returnTo.set("run", options.currentRunId);
  if (options.currentJobId) returnTo.set("job", options.currentJobId);
  const visibleAttentionItems = options.attentionItems.slice(0, 6);
  const newRoomHref = `/coding?workspace=${encodeURIComponent(options.workspaceId)}`;
  const attentionRows = visibleAttentionItems.map((item) => {
    const href = `/coding?workspace=${encodeURIComponent(item.workspaceId)}&run=${encodeURIComponent(item.conversationId)}&job=${encodeURIComponent(item.jobId)}`;
    const action = item.kind === "merge-ready"
      ? `<form action="/coding/runs/${encodeURIComponent(item.conversationId)}/integrate" method="post"><input type="hidden" name="jobId" value="${esc(item.jobId)}"/><button type="submit">Merge into ${esc(item.targetBranch ?? "target")}</button></form>`
      : item.kind === "failed"
        ? `<form action="/coding/runs/${encodeURIComponent(item.conversationId)}/retry" method="post"><input type="hidden" name="jobId" value="${esc(item.jobId)}"/><button type="submit">Retry safely</button></form>`
        : `<a href="${esc(href)}">${item.kind === "needs-input" ? "Open and answer" : "Resolve block"}</a>`;
    return `<li data-state="${item.kind}" data-slot="attention-item" data-coding-attention-job="${esc(item.jobId)}"><span class="coding-attention-state" aria-hidden="true"></span><div><strong>${esc(item.title)}</strong><small>${esc(item.workspaceName)} · ${esc(timeAgoLabel(item.updatedAt))}</small><p>${esc(truncate(item.detail, 140))}</p>${action}</div></li>`;
  }).join("");
  const roomSearch = `<label class="coding-sidebar-search" for="coding-room-search"><span aria-hidden="true">⌕</span><span class="sr-only">Search rooms</span><input id="coding-room-search" type="search" name="room-search" autocomplete="off" placeholder="Search rooms…" data-coding-room-search aria-describedby="coding-room-search-status"/></label><span class="sr-only" id="coding-room-search-status" role="status" aria-live="polite" data-coding-room-search-status></span>`;
  return `<aside class="sidebar agent-sidebar coding-project-rail" id="coding-project-rail" data-coding-project-rail data-slot="workspace-rail" aria-label="Repository rooms and team" data-workspace-region="rail">
    <button class="coding-rail-close" type="button" data-coding-rail-close aria-label="Close repository navigation"><span aria-hidden="true">×</span></button>
    ${workspaceSwitcher}
    ${roomSearch}
    <a class="coding-new-room" href="${esc(newRoomHref)}"${options.currentRunId ? "" : " aria-current=\"page\""} data-new-room><span aria-hidden="true">＋</span><span><strong>New room</strong><small>Start a fresh conversation</small></span></a>
    <details class="coding-project-section coding-project-runs coding-sidebar-section" data-disclosure-key="recent-rooms" open><summary><i aria-hidden="true">›</i><h2 id="coding-project-runs-title">Rooms</h2><span>${options.rooms.length}</span></summary><nav class="coding-sidebar-section-body" aria-labelledby="coding-project-runs-title"><ol>${roomRows || `<li class="coding-project-empty">No conversations yet. Start a new room.</li>`}</ol>${options.rooms.length > visibleRooms.length ? `<p>Showing the ${visibleRooms.length} most recent rooms.</p>` : ""}</nav></details>
    <details class="coding-project-section coding-project-team coding-sidebar-section" data-disclosure-key="specialists"><summary><i aria-hidden="true">›</i><h2 id="coding-project-team-title">Agents</h2><span>${specialistNodes.length}</span></summary><div class="coding-sidebar-section-body" aria-labelledby="coding-project-team-title"><ul>${specialistRows}</ul></div></details>
    <details class="coding-project-section coding-attention coding-sidebar-section" data-slot="attention-center" data-disclosure-key="attention"><summary><span><h2 id="coding-attention-title">Needs attention</h2><small>${options.attentionItems.length === 0 ? "All clear" : "Review when ready"}</small></span><strong data-attention-count>${options.attentionItems.length}</strong><i aria-hidden="true">›</i></summary><div class="coding-attention-body"><div class="coding-attention-controls"><button type="button" data-enable-notifications>Enable notifications</button><span role="status" aria-live="polite" data-notification-status></span></div><ol aria-labelledby="coding-attention-title">${attentionRows || `<li class="coding-project-empty">Nothing needs attention.</li>`}</ol>${options.attentionItems.length > visibleAttentionItems.length ? `<p class="coding-attention-overflow">Showing the ${visibleAttentionItems.length} newest of ${options.attentionItems.length}. Older items remain available in their rooms.</p>` : ""}</div></details>
    <details class="coding-project-section coding-sidebar-section" data-disclosure-key="project-scope"><summary><i aria-hidden="true">›</i><h2 id="coding-project-scope-title">Project scope</h2><span>${new Intl.NumberFormat("en-US").format(options.profile.fileCount)} files${options.profile.filesTruncated ? "+" : ""}</span></summary><div class="coding-sidebar-section-body" aria-labelledby="coding-project-scope-title"><ul class="coding-project-technologies">${technologies.map((technology) => `<li>${esc(technology)}</li>`).join("")}</ul><div class="coding-project-scan" data-state="${dependencyConflictCount ? "conflicted" : "ready"}"><span>Saved team · ${esc(teamState)}</span><form action="/coding/workspace/scan" method="post" data-coding-team-refresh aria-describedby="coding-team-refresh-status"><input type="hidden" name="workspaceId" value="${esc(options.workspaceId)}"/><input type="hidden" name="requestId" value="${esc(options.rescanRequestId)}"/><input type="hidden" name="returnTo" value="/coding?${esc(returnTo.toString())}"/><button type="submit">Rescan team</button></form><p id="coding-team-refresh-status" role="status" aria-live="polite" aria-atomic="true" data-coding-team-refresh-status${options.teamRefreshNotice ? " data-state=\"success\"" : ""}>${esc(options.teamRefreshNotice ?? "")}</p></div></div></details>
  </aside>`;
};

type CodingContribution =
  | { readonly kind: "proposal"; readonly value: CodingPeerProposal }
  | { readonly kind: "response"; readonly value: CodingPeerResponse }
  | { readonly kind: "resolution"; readonly value: CodingPeerResolution }
  | { readonly kind: "endorsement"; readonly value: CodingPeerEndorsement };

type CodingAuthoredArtifactTurn = {
  readonly kind:
    | "announcement"
    | "implementation"
    | "review-report"
    | "remediation"
    | "investigation-report"
    | "investigation-synthesis"
    | "final-result";
  readonly summary: string;
};


type CodingStateNode = OrchestrationState["nodes"][string];
type CodingRuntimeNode = { readonly runtime: WorkspaceNodeRuntime };
type CodingRuntimeBinding = { readonly runtime: WorkspaceNodeRuntime };

const codingRuntimeLabel = (kind: string): string => {
  if (kind === "codex-cli") return "Codex CLI";
  if (kind === "claude-code") return "Claude Code";
  if (kind === "pi-agent") return "Pi Code";
  if (kind === "roster-native") return "Roster native";
  if (kind === "shell") return "Host validation";
  return titleCase(kind);
};

const runtimeModelLabel = (model: string): string => {
  const label = codingModelLabel(model);
  return /^[a-z][a-z0-9-]*$/u.test(label) ? titleCase(label) : label;
};

const runtimeIdentity = (node: CodingRuntimeNode | undefined, binding?: CodingRuntimeBinding): {
  readonly runtime?: string;
  readonly model?: string;
} => {
  const runtime = binding?.runtime ?? node?.runtime;
  if (!runtime) return {};
  const model = typeof runtime.metadata?.model === "string" ? runtime.metadata.model : undefined;
  const reasoningEffort = typeof runtime.metadata?.reasoningEffort === "string"
    ? titleCase(runtime.metadata.reasoningEffort)
    : undefined;
  return {
    runtime: codingRuntimeLabel(runtime.kind),
    ...(runtime.kind === "shell"
      ? { model: "No LLM" }
      : model
        ? { model: `${runtimeModelLabel(model)}${reasoningEffort ? ` · ${reasoningEffort} reasoning` : ""}` }
        : {}),
  };
};

const visibleRuntimeIdentity = (
  node: CodingRuntimeNode | undefined,
  binding?: CodingRuntimeBinding,
): { readonly agent: string; readonly model: string } => {
  const identity = runtimeIdentity(node, binding);
  return {
    agent: identity.runtime ?? "Agent binding pending",
    model: identity.model ?? "Model pending",
  };
};

const nodeTaskState = (
  state: OrchestrationState,
  nodeId: string,
  runTone: "idle" | "active" | "success" | "failed",
): string => {
  const graphTasks = (state.taskGraph?.tasks ?? [])
    .filter((task) => task.capability !== "coordinate.graph" && task.nodeId === nodeId);
  if (graphTasks.length > 0) {
    const statuses = graphTasks.map((task) => task.status);
    if (runTone === "failed" && statuses.some((status) =>
      status === "running" || status === "leased" || status === "ready" || status === "pending")) {
      return "stopped";
    }
    if (statuses.some((status) => status === "running" || status === "leased")) return "working";
    if (statuses.some((status) => status === "failed" || status === "canceled")) return "needs-attention";
    if (statuses.every((status) => status === "accepted" || status === "skipped")) return "done";
    return "waiting";
  }
  return "active";
};

const activityDescription = (event: OrchestrationEvent): string => {
  if (event.type === "function.activity.recorded") {
    const target = event.activity.pipelineId ?? event.activity.functionId ?? "worker catalog";
    return `${event.activity.operation} · ${target}`;
  }
  if (event.type === "task.graph.projected") {
    const running = event.graph.tasks.filter((task) =>
      task.status === "leased" || task.status === "running").length;
    const accepted = event.graph.tasks.filter((task) => task.status === "accepted").length;
    return `Dynamic DAG projected: ${event.graph.tasks.length} tasks, ${running} active, ${accepted} accepted`;
  }
  if (event.type === "reflection.recorded") return "Adaptive orchestration decision recorded";
  if (event.type === "node.spawned") return `${codingAgentVisual(event.node).name} joined the conversation`;
  if (event.type === "node.retired") return `${event.nodeId} retired after the frontier settled`;
  if (event.type === "node.runtime.bound") return `${event.binding.nodeId} bound to ${codingRuntimeLabel(event.binding.runtime.kind)} epoch ${event.binding.epoch}`;
  if (event.type === "artifact.published") return `${event.outputKey} published by ${event.nodeId}`;
  return event.type.replaceAll(".", " ");
};

const isCodingRoomReactionEvent = (event: OrchestrationEvent): boolean =>
  event.type === "artifact.published" && event.kind === CODING_ROOM_REACTION_KIND;

export type CodingRunProgress = {
  readonly state: "working" | "waiting" | "completed" | "failed";
  readonly label: string;
  readonly message: string;
  readonly headline: string;
  readonly latestUpdate: string;
  readonly activity: string;
  readonly announcementKey: string;
};

type CodingGraphTask = NonNullable<OrchestrationState["taskGraph"]>["tasks"][number];

const codingGraphTasks = (state: OrchestrationState): ReadonlyArray<CodingGraphTask> =>
  (state.taskGraph?.tasks ?? []).filter((task) => task.capability !== "coordinate.graph");

const codingGraphTask = (
  state: OrchestrationState,
  taskId: string | undefined,
): CodingGraphTask | undefined =>
  taskId ? state.taskGraph?.tasks.find((task) => task.taskId === taskId) : undefined;

const effectiveCodingGraphTask = (
  state: OrchestrationState,
  task: CodingGraphTask,
): CodingGraphTask | undefined => {
  const seen = new Set<string>();
  let current: CodingGraphTask | undefined = task;
  while (current?.continuationTaskId) {
    if (seen.has(current.taskId)) return undefined;
    seen.add(current.taskId);
    current = codingGraphTask(state, current.continuationTaskId);
  }
  return current;
};

const codingGraphTaskAccepted = (
  state: OrchestrationState,
  task: CodingGraphTask,
): boolean => effectiveCodingGraphTask(state, task)?.status === "accepted";

const codingGraphComplete = (state: OrchestrationState): boolean => {
  const tasks = codingGraphTasks(state);
  const finalizer = tasks.find((task) => task.taskId === "coding-finalize");
  const executableTasks = tasks.filter((task) => task.capability !== "coordinate");
  return executableTasks.length > 0
    && executableTasks.every((task) => codingGraphTaskAccepted(state, task))
    && (!finalizer || codingGraphTaskAccepted(state, finalizer));
};

const codingReadOnlyOutcomeComplete = (
  state: OrchestrationState,
  job?: CodingDemoJob,
): boolean => codingGraphComplete(state)
  && Boolean(parseCodingInvestigationReport(orchestrationOutputValues(state).final_report))
  && (job?.runKind === "investigation" || job?.readOnly === true || state.domain?.id === "coding-investigation");

const codingInvestigationReportFinalized = (
  state: OrchestrationState,
  job?: CodingDemoJob,
): boolean => {
  const investigation = job?.runKind === "investigation"
    || job?.readOnly === true
    || state.domain?.id === "coding-investigation";
  const finalizer = codingGraphTasks(state).find((task) => task.taskId === "coding-finalize");
  return investigation
    && Boolean(finalizer && codingGraphTaskAccepted(state, finalizer))
    && codingGraphComplete(state)
    && Boolean(parseCodingInvestigationReport(orchestrationOutputValues(state).final_report))
    && (!job || job.status === "completed");
};

/** A settled graph without its queue/delivery record is a projection fault, not live work. */
export const codingRunDeliveryState = (
  state: OrchestrationState,
  job?: CodingDemoJob,
  now?: number,
): CodingDeliveryState => resolveCodingRunDeliveryState(
  codingGraphComplete(state),
  job,
  codingReadOnlyOutcomeComplete(state, job),
  now,
);

const codingUnavailableDeliveryReason = (job?: CodingDemoJob): string => job
  ? "The execution wrapper completed without the validated commit and baseline metadata required for integration."
  : "The task graph is complete, but its durable job and delivery record are unavailable. Reload the room or inspect the run before taking action.";

const codingPublicFailureReason = (input: {
  readonly canceled?: boolean;
  readonly certified?: boolean;
  readonly error?: string;
}): string => input.certified
  ? "The certified handoff needs attention before integration can continue."
  : input.canceled
    ? "The bounded run was canceled before certification."
    : /worker lease expired|lease expired|timed out|timeout|wall-time/iu.test(input.error ?? "")
      ? "The assigned runtime stopped responding before it returned an accepted result."
      : /budget|usage limit|execution policy/iu.test(input.error ?? "")
        ? "The run reached its execution budget before the unfinished step returned an accepted result."
        : /validation|test failed|verify failed/iu.test(input.error ?? "")
          ? "Validation did not pass for the unfinished step."
          : /runtime|provider|model|authentication|authorization/iu.test(input.error ?? "")
            ? "The assigned runtime was unavailable before the unfinished step returned an accepted result."
            : "The bounded run stopped before certification.";

const codingGraphFailure = (state: OrchestrationState): CodingGraphTask | undefined =>
  codingGraphTasks(state).find((task) => task.status === "failed" || task.status === "canceled");

const codingAttentionDetail = (
  state: OrchestrationState,
  job?: CodingDemoJob,
) => codingRunAttentionDetail(codingGraphTasks(state).map((task) => ({
  taskId: task.taskId,
  nodeId: task.nodeId,
  capability: task.capability,
  status: task.status,
  displayName: task.nodeId === "coordinator"
    ? "Roster"
    : state.nodes[task.nodeId]
      ? codingAgentVisual(state.nodes[task.nodeId]!).name
      : task.nodeId,
  ...(task.error ? {
    failureCategory: /worker lease expired|lease expired|timed out|timeout|wall-time/iu.test(task.error)
      ? "worker-timeout" as const
      : /budget|usage limit|execution policy/iu.test(task.error)
        ? "budget-exhausted" as const
        : /validation|test failed|verify failed/iu.test(task.error)
          ? "validation-failed" as const
          : /runtime|provider|model|authentication|authorization/iu.test(task.error)
            ? "runtime-unavailable" as const
            : "task-failed" as const,
    failureReason: codingPublicFailureReason({ error: task.error }),
  } : {}),
})), /budget|usage limit|execution policy/iu.test(job?.error ?? "")
  ? "budget-exhausted"
  : codingGraphFailure(state)?.error ?? job?.error ?? "");

/** A committed job can retain an older canceled coordinator finalizer after usage settlement. */
const codingCommittedUsageNote = (
  state: OrchestrationState,
  job: CodingDemoJob | undefined,
): CodingGraphTask | undefined => {
  if (job?.status !== "completed" || !job.commit) return undefined;
  const failure = codingGraphFailure(state);
  if (
    !failure
    || failure.nodeId !== "coordinator"
    || failure.taskId !== "coding-finalize"
    || !/(budget|usage|execution policy)/iu.test(failure.error ?? "")
  ) return undefined;
  return failure;
};

const codingGraphTaskStatuses = (state: OrchestrationState): Readonly<Record<string, string>> =>
  Object.fromEntries(codingGraphTasks(state).map((task) => [
    task.taskId,
    effectiveCodingGraphTask(state, task)?.status ?? task.status,
  ]));

const codingGraphDisplayStatus = (
  task: CodingGraphTask,
): "waiting" | "running" | "completed" | "failed" | "blocked" | "canceled" => {
  if (task.status === "accepted") return "completed";
  if (task.status === "running" || task.status === "leased") return "running";
  if (task.status === "failed") return "failed";
  if (task.status === "canceled") return "canceled";
  if (task.status === "skipped") return "completed";
  return "waiting";
};

const codingTaskOutputSummary = (
  outputKey: string,
  value: string,
): string | undefined => {
  const parsed = parsedReport(value);
  if (!parsed) return undefined;
  const enveloped = parsed[outputKey];
  const report = enveloped !== null && typeof enveloped === "object" && !Array.isArray(enveloped)
    ? enveloped as Record<string, unknown>
    : parsed;
  for (const candidate of [
    report.summary,
    report.answer,
    report.message,
    report.result,
    report.decision,
  ]) {
    const summary = reportString(candidate, 420);
    if (summary) return truncate(summary, 300);
  }
  const changedFiles = reportStringArray(report.changedFiles ?? report.changed_files);
  if (changedFiles?.length) {
    return `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}: ${truncate(changedFiles.join(", "), 240)}`;
  }
  const findings = Array.isArray(report.findings) ? report.findings.length : 0;
  if (findings > 0) return `${findings} accepted finding${findings === 1 ? "" : "s"}.`;
  return undefined;
};

const codingTaskVisibleOutcome = (
  state: OrchestrationState,
  task: CodingGraphTask,
): string => {
  const effective = effectiveCodingGraphTask(state, task) ?? task;
  const taskIds = new Set([task.taskId, effective.taskId]);
  const outputs = orchestrationOutputValues(state);
  const acceptedOutputs = Object.values(state.outputs)
    .filter((binding) => binding.origin === "task" && binding.taskId && taskIds.has(binding.taskId))
    .sort((left, right) => left.outputKey.localeCompare(right.outputKey));
  for (const binding of acceptedOutputs) {
    const summary = codingTaskOutputSummary(binding.outputKey, outputs[binding.outputKey] ?? "");
    if (summary) return summary;
  }
  if (acceptedOutputs.length > 0) {
    return `Accepted ${acceptedOutputs.map((binding) => titleCase(binding.outputKey)).join(", ")}.`;
  }
  if (task.status === "skipped" && task.continuationTaskId) {
    const continuation = codingGraphTask(state, task.continuationTaskId);
    return continuation?.status === "accepted"
      ? `Completed through ${titleCase(continuation.taskId)}; its accepted outcome is preserved.`
      : `Continued through ${titleCase(task.continuationTaskId)}.`;
  }
  if (effective.status === "accepted") return "Accepted outcome recorded.";
  if (effective.status === "failed" || effective.status === "canceled") return "The task stopped before acceptance.";
  if (effective.status === "running" || effective.status === "leased") {
    return "Outcome pending · work is currently in progress.";
  }
  if (effective.status === "ready") return "Outcome pending · ready to start.";
  return "Outcome pending · waiting for prerequisites.";
};

const taskProgress = (state: OrchestrationState): {
  readonly completed: number;
  readonly total: number;
  readonly activeNames: ReadonlyArray<string>;
} => {
  const graphTasks = codingGraphTasks(state).filter(isCodingUserVisibleTask);
  const activeNames = [...new Set(graphTasks
    .filter((task) => task.status === "running" || task.status === "leased")
    .map((task) => state.nodes[task.nodeId])
    .filter((node) => node !== undefined && node.id !== "coordinator" && node.metadata?.participantKind !== "human")
    .map((node) => codingAgentVisual(node).name))];
  return {
    completed: graphTasks.filter((task) => codingGraphTaskAccepted(state, task)).length,
    total: graphTasks.length,
    activeNames,
  };
};

const quietTime = (elapsedMs: number): string => {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < 60_000) return "less than a minute";
  if (elapsed < 3_600_000) {
    const minutes = Math.max(1, Math.floor(elapsed / 60_000));
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.max(1, Math.floor(elapsed / 3_600_000));
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
};

const meaningfulEvent = (event: OrchestrationEvent): boolean => {
  if (isCodingRoomReactionEvent(event)) return false;
  if (event.type === "prompt.compiled"
    || event.type === "reflection.recorded"
    || event.type === "topology.selected"
    || event.type === "node.runtime.bound"
    || event.type === "node.retired") return false;
  if (event.type !== "artifact.published") return true;
  if (event.kind === CODING_CONVERSATION_MESSAGE_KIND || event.outputKey === "request") return false;
  return true;
};

const taskMilestone = (
  capability: string,
  completed: boolean,
): string => {
  const normalized = capability.toLowerCase();
  if (normalized.includes("investigat")) return completed ? "finished the investigation" : "is investigating the repository";
  if (normalized.includes("implement")) return completed ? "finished implementation" : "is implementing the change";
  if (normalized.includes("propos")) return completed ? "shared the design direction" : "is shaping the design direction";
  if (normalized.includes("review")) return completed ? "finished review" : "is reviewing the work";
  if (normalized.includes("validat") || normalized.includes("test")) {
    return completed ? "finished validation" : "is running validation";
  }
  if (normalized.includes("certif")) return completed ? "finished the final checks" : "is checking the final result";
  if (normalized.includes("resolv")) return completed ? "resolved the open decisions" : "is resolving open decisions";
  if (normalized.includes("respond")) return completed ? "answered a peer question" : "is answering a peer question";
  if (normalized.includes("coordinat") || normalized.includes("plan")) {
    return completed ? "finished coordinating this step" : "is coordinating the next step";
  }
  return completed ? "finished their step" : "is working on their step";
};

const meaningfulDescription = (state: OrchestrationState, event: OrchestrationEvent): string => {
  if (event.type === "artifact.published" && event.kind === CODING_CONVERSATION_ROUTE_KIND) {
    const route = codingConversationFromEvents([event]).routes[0];
    if (route?.disposition === "needs_clarification") return "Roster needs one detail before work can continue.";
    if (route?.disposition === "informational") return "Roster answered the question.";
    if (route?.disposition === "operational") return "Roster explained the local operation boundary.";
    if (route?.disposition === "declined") return "Roster could not start this request.";
    if (route) return "Roster is choosing the right teammates.";
  }
  if (event.type === "node.spawned") return `${codingAgentVisual(event.node).name} joined the work.`;
  if (event.type === "task.graph.projected") {
    if (event.graph.tasks.some((task) => task.status === "failed" || task.status === "canceled")) {
      return "The team hit a problem while working on this graph.";
    }
    const work = event.graph.tasks.filter((task) => task.capability !== "coordinate.graph");
    if (work.length > 0 && work.every((task) => codingGraphTaskAccepted(state, task))) {
      return state.outputs.workspace_rescan_result
        ? "The updated team is ready."
        : "The team finished and certified the work.";
    }
    const active = work.find((task) => task.status === "running" || task.status === "leased");
    if (active) {
      const node = state.nodes[active.nodeId];
      const name = node ? codingAgentVisual(node).name : active.nodeId;
      return `${name} ${taskMilestone(active.capability, false)}.`;
    }
    return "The team graph was updated.";
  }
  if (event.type === "artifact.published") {
    const node = state.nodes[event.nodeId];
    const name = node ? codingAgentVisual(node).name : "A teammate";
    if (/implementation[_-]report/i.test(event.outputKey)) return `${name} shared the implementation update.`;
    if (/review[_-]report|endorsement/i.test(event.outputKey)) return `${name} shared the review update.`;
    if (/validation[_-]report/i.test(event.outputKey)) return `${name} shared the validation results.`;
    if (/final[_-]report/i.test(event.outputKey)) return "Roster is preparing the final result.";
    return `${name} shared an update.`;
  }
  return activityDescription(event);
};

export const codingRunProgress = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly eventTimestamps?: ReadonlyArray<number>;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
  readonly now?: number;
}): CodingRunProgress | undefined => {
  const now = options.now ?? Date.now();
  const conversation = codingConversationFromEvents(options.events);
  const latestRoute = conversation.routes.at(-1);
  const accepted = Boolean(
    latestRoute && conversation.messages.some((message) => message.messageId === latestRoute.inReplyTo),
  ) || options.job?.runKind === "workspace-rescan";
  if (!accepted) return undefined;
  const collaboration = codingCollaborationStatus({
    outputs: orchestrationOutputValues(options.state),
    taskStatuses: codingGraphTaskStatuses(options.state),
    peerCount: Object.values(options.state.nodes).filter((node) => node.id !== "coordinator").length,
    certified: codingGraphComplete(options.state),
  });
  const progress = taskProgress(options.state);
  const activeLease = Boolean(options.job && ["leased", "running"].includes(options.job.status)
    && options.job.leaseUntil !== undefined && options.job.leaseUntil > now);
  const leaseOverdue = Boolean(options.job && ["leased", "running"].includes(options.job.status)
    && options.job.leaseUntil !== undefined && options.job.leaseUntil <= now);
  const jobWorking = Boolean(options.job && ["queued", "leased", "running"].includes(options.job.status));
  const meaningful = options.events
    .map((event, index) => ({ event, at: options.eventTimestamps?.[index] }))
    .filter((entry): entry is { readonly event: OrchestrationEvent; readonly at: number } =>
      meaningfulEvent(entry.event) && typeof entry.at === "number" && Number.isFinite(entry.at))
    .at(-1);
  const latestUpdate = meaningful
    ? meaningfulDescription(options.state, meaningful.event)
    : "Roster is choosing the right teammates.";
  const quiet = meaningful ? quietTime(now - meaningful.at) : undefined;
  const activeNames = progress.activeNames.length < 2
    ? progress.activeNames[0] ?? "Getting started"
    : `${progress.activeNames.slice(0, -1).join(", ")} and ${progress.activeNames.at(-1)}`;
  const taskCount = `${progress.completed} of ${progress.total} steps`;
  const humanAction = codingHumanActionProjection(options);
  const humanWaiting = humanAction.kind === "ambiguity" || humanAction.kind === "clarification";
  if (!options.job && (
    latestRoute?.disposition === "informational"
    || latestRoute?.disposition === "operational"
    || latestRoute?.disposition === "declined"
  )) return undefined;
  if (humanWaiting) {
    const detail = collaboration.resolutionStatus === "ambiguous"
      ? "The team could not resolve this from the repository and peer discussion; reply with the product decision."
      : latestRoute?.questions.join(" ") || "Reply with the requested clarification.";
    return {
      state: "waiting",
      label: "Waiting for you",
      message: detail,
      headline: `${taskCount} complete`,
      latestUpdate,
      activity: detail,
      announcementKey: `waiting:${latestRoute?.routeId ?? collaboration.resolutionStatus}:${latestUpdate}`,
    };
  }
  if (humanAction.kind === "continuation") {
    const active = ["queued", "leased", "running"].includes(humanAction.status);
    const completed = humanAction.status === "completed";
    return {
      state: active ? "working" : completed ? "completed" : "failed",
      label: active ? "Working" : completed ? "Completed" : "Needs attention",
      message: active
        ? "Roster is continuing with your answer."
        : completed
          ? "The continuation is complete."
          : "The continuation stopped and needs attention.",
      headline: active
        ? "Your answer was received · continuation active"
        : completed
          ? "Your answer was received · continuation complete"
          : "Your answer was received · continuation stopped",
      latestUpdate,
      activity: active
        ? "The selected historical attempt remains immutable while the new execution handles your answer."
        : completed
          ? "The selected historical attempt remains immutable; open the continuation for its certified result."
          : "The selected historical attempt remains immutable; open the continuation to inspect what happened.",
      announcementKey: `continuation:${humanAction.jobId}:${humanAction.status}`,
    };
  }
  if (humanAction.kind === "recovery" && !options.job) {
    return {
      state: "failed",
      label: "Needs attention",
      message: humanAction.summary,
      headline: `No work started · ${taskCount}`,
      latestUpdate,
      activity: `${humanAction.summary} No human answer is requested; retry after correcting the runtime condition.`,
      announcementKey: `recovery:${latestRoute?.routeId ?? "run"}:${humanAction.summary}`,
    };
  }
  if (options.job?.status === "queued") {
    const attempt = options.job.attempt && options.job.maxAttempts
      ? ` at attempt ${options.job.attempt} of ${options.job.maxAttempts}`
      : "";
    return {
      state: "waiting",
      label: "Queued",
      message: options.job.attempt && options.job.attempt > 1
        ? "Roster queued the next bounded attempt."
        : "Waiting for an available workspace agent.",
      headline: `${taskCount} complete · queued`,
      latestUpdate,
      activity: options.job.attempt && options.job.maxAttempts
        ? `Bounded recovery is queued${attempt}; no agent is presented as working until a task lease starts.`
        : "The run is queued; no agent is presented as working until a task lease starts.",
      announcementKey: `queued:${options.job.id}:${options.job.attempt ?? 0}:${progress.completed}:${progress.total}`,
    };
  }
  const committedUsageNote = codingCommittedUsageNote(options.state, options.job);
  if ((codingGraphComplete(options.state) || committedUsageNote || codingHasCertifiedDelivery(options.job)) && !(
    options.job?.runKind === "workspace-rescan" && options.job.status !== "completed"
  )) {
    if (options.job?.runKind === "workspace-rescan") {
      return {
        state: "completed",
        label: "Team updated",
        message: "The updated team is ready for future conversations.",
        headline: `${progress.completed} of ${progress.total} steps complete`,
        latestUpdate,
        activity: "The new specialist profile is saved for future conversations. Existing runs retain their original roster, and no source branch or integration action was created.",
        announcementKey: `completed:workspace-rescan:${latestUpdate}`,
      };
    }
    const terminal = codingTerminalOutcome({
      graphComplete: codingGraphComplete(options.state),
      graphFailed: Boolean(codingGraphFailure(options.state)),
      certified: true,
      readOnlyComplete: codingReadOnlyOutcomeComplete(options.state, options.job),
      job: options.job,
      now,
    });
    if (!terminal) throw new Error("Certified Coding state did not produce a terminal projection");
    const { delivery, handoff } = terminal;
    const activity = delivery === "no-changes"
      ? "The certified execution required no repository delta, so there is nothing to integrate."
      : delivery === "integrated"
      ? "The certified commit is integrated; its temporary run branch has been cleaned up."
      : delivery === "kept-branch"
        ? `The room is closed without merging. The certified commit remains on ${options.job?.deliveryDisposition?.branch ?? options.job?.branch ?? "the run branch"} for later.`
      : delivery === "ready"
        ? `@You can merge the exact certified commit into ${options.job?.baselineBranch ?? "the target branch"} now.${committedUsageNote ? " Roster kept the earlier final-accounting overage in the run details; it does not invalidate the certified result." : ""}`
        : delivery === "blocked"
          ? (leaseOverdue
              ? "The worker lease expired after certification before the validated Git delivery was recorded."
              : options.job?.status === "canceled"
                ? "The execution wrapper was canceled after certification; bounded handoff recovery ended."
                : codingPublicFailureReason({ certified: true }))
        : delivery === "unavailable"
          ? codingUnavailableDeliveryReason(options.job)
          : "Certification is complete while Roster prepares the validated Git delivery.";
    if (committedUsageNote && (delivery === "integrated" || delivery === "no-changes" || delivery === "kept-branch")) {
      return {
        state: "completed",
        label: delivery === "integrated" ? "Merged" : delivery === "kept-branch" ? "Closed" : "Completed",
        message: delivery === "integrated"
          ? `The certified change is now on ${options.job?.integration?.currentBranch ?? options.job?.baselineBranch ?? "the target branch"}.`
          : delivery === "kept-branch"
            ? `The room is closed. The certified code remains on ${options.job?.deliveryDisposition?.branch ?? options.job?.branch ?? "the run branch"}.`
          : "The reviewed work needed no repository changes. No action is required.",
        headline: `Accepted work ${delivery === "integrated" ? "merged" : "completed"} · usage note kept in Details`,
        latestUpdate,
        activity: "Roster kept the earlier final-accounting overage in the run details; it does not invalidate the certified result.",
        announcementKey: `completed:usage-note:${delivery}:${options.job?.commit ?? "commit"}`,
      };
    }
    return {
      state: terminal.state,
      label: terminal.label,
      message: delivery === "no-changes"
        ? "The team finished. No repository changes were needed."
        : delivery === "integrated"
          ? `The certified change is now on ${options.job?.integration?.currentBranch ?? options.job?.baselineBranch ?? "the target branch"}.`
          : delivery === "kept-branch"
            ? `The room is closed without merging. The certified code remains on ${options.job?.deliveryDisposition?.branch ?? options.job?.branch ?? "the run branch"}.`
          : delivery === "ready"
            ? `@You, the change is certified. Merge it into ${options.job?.baselineBranch ?? "the target branch"} to finish this run.`
            : delivery === "blocked"
              ? `@You, the work is certified, but the merge is blocked: ${activity}`
              : delivery === "unavailable"
                ? `@You, the work is certified, but Roster could not create a merge handoff: ${activity}`
                : "The work is certified. Roster is preparing the merge handoff.",
      headline: `${progress.completed} of ${progress.total} steps complete · ${handoff}`,
      latestUpdate,
      activity,
      announcementKey: `completed:${handoff}:${latestUpdate}`,
    };
  }
  const graphFailure = codingGraphFailure(options.state);
  const terminalFailure = !jobWorking && (
    graphFailure !== undefined
    || options.job?.status === "failed" || options.job?.status === "canceled"
  );
  if (terminalFailure) {
    const terminal = codingTerminalOutcome({
      graphComplete: false,
      graphFailed: Boolean(graphFailure),
      certified: false,
      job: options.job,
      now,
    });
    const attempts = options.job?.attempt !== undefined && options.job.maxAttempts !== undefined
      ? ` after ${options.job.attempt} of ${options.job.maxAttempts} attempts`
      : "";
    const reason = codingPublicFailureReason({
      canceled: options.job?.status === "canceled" || graphFailure?.status === "canceled",
      error: graphFailure?.error ?? options.job?.error,
    });
    const attention = codingAttentionDetail(options.state, options.job);
    const publicReason = attention ? `${attention.headline} ${attention.explanation}` : reason;
    return {
      state: terminal?.state ?? "failed",
      label: terminal?.label ?? "Failed",
      message: publicReason,
      headline: `${progress.completed} of ${progress.total} steps complete${attempts}`,
      latestUpdate,
      activity: `${publicReason} No human answer is requested; start a new bounded run when recovery is appropriate.`,
      announcementKey: `failed:${options.job?.status ?? graphFailure?.status}:${publicReason}`,
    };
  }
  const leaseActivity = leaseOverdue
    ? "Lease renewal is overdue; bounded recovery is pending a durable scheduler transition."
    : activeLease
      ? `No new durable update for ${quiet ?? "less than a minute"}; the worker lease heartbeat remains active.`
      : `Quiet for ${quiet ?? "less than a minute"}; waiting for the next durable Roster update.`;
  return {
    state: "working",
    label: "Working",
    message: leaseOverdue
      ? "Status is delayed while Roster checks the worker."
      : latestUpdate,
    headline: `${taskCount} complete · ${activeNames}`,
    latestUpdate,
    activity: leaseActivity,
    announcementKey: `working:${collaboration.phase}:${progress.completed}:${progress.total}:${activeNames}:${latestUpdate}:${quiet ?? "initial"}:${leaseOverdue}`,
  };
};

const codingAgentDetailId = (nodeId: string): string =>
  `coding-agent-detail-${nodeId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "node"}`;

const eventBelongsToNode = (event: OrchestrationEvent, nodeId: string): boolean => {
  if (event.type === "node.spawned") return event.node.id === nodeId;
  if (event.type === "node.runtime.bound") return event.binding.nodeId === nodeId;
  if ("nodeId" in event && typeof event.nodeId === "string") return event.nodeId === nodeId;
  return nodeId === "coordinator"
    && (event.type === "reflection.recorded" || event.type === "task.graph.projected");
};

const codingAgentDetailsHtml = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly runtimeLogs?: ReadonlyArray<StoredNodeRuntimeLog>;
  readonly node: CodingStateNode;
}): string => {
  const binding = options.state.nodeBindings[options.node.id];
  const runtime = binding?.runtime ?? options.node.runtime;
  const identity = runtimeIdentity(options.node, binding);
  const identitySummary = [codingAgentVisual(options.node).role, identity.runtime, identity.model]
    .filter((value): value is string => Boolean(value));
  const tasks = codingGraphTasks(options.state).filter((task) => task.nodeId === options.node.id);
  const logs = options.events
    .map((event, index) => ({ event, sequence: index + 1 }))
    .filter(({ event }) => !isCodingRoomReactionEvent(event) && eventBelongsToNode(event, options.node.id))
    .slice(-50);
  // Raw process output is fetched lazily by the exact authorized run stream;
  // it is never serialized into the public page document.
  const runtimeLogs: ReadonlyArray<StoredNodeRuntimeLog> = [];
  const live = tasks.some((task) => task.status === "running");
  const detailId = codingAgentDetailId(options.node.id);
  const visual = codingAgentVisual(options.node);
  const specialization = typeof options.node.metadata?.specializationSummary === "string"
    ? options.node.metadata.specializationSummary
    : undefined;
  const skills = Array.isArray(options.node.metadata?.specialistSkills)
    ? options.node.metadata.specialistSkills.flatMap((skill) => typeof skill === "string"
      ? [skill]
      : skill && typeof skill === "object" && !Array.isArray(skill) && typeof skill.name === "string"
        ? [skill.name]
        : [])
    : [];
  const tools = Array.isArray(options.node.metadata?.toolRequirements)
    ? options.node.metadata.toolRequirements.filter((tool): tool is string => typeof tool === "string")
    : [];
  const dependencyNames = Array.isArray(options.node.metadata?.dependsOnNodeIds)
    ? options.node.metadata.dependsOnNodeIds.flatMap((nodeId) => {
        if (typeof nodeId !== "string") return [];
        const dependency = options.state.nodes[nodeId];
        return [dependency ? codingAgentVisual(dependency).name : nodeId];
      })
    : [];
  return `<section class="coding-agent-detail" id="${esc(detailId)}" data-coding-agent-detail data-node-id="${esc(options.node.id)}" data-coding-agent-layout="inspector-v2" aria-labelledby="${esc(detailId)}-title" aria-describedby="${esc(detailId)}-summary" hidden>
    <header class="coding-agent-detail-header"><div class="coding-agent-detail-identity">${codingAgentSymbolHtml(visual, "coding-agent-detail-avatar")}<span><small>Agent inspector</small><h2 id="${esc(detailId)}-title">${esc(visual.name)}</h2><p id="${esc(detailId)}-summary">${esc(identitySummary.join(" · "))}</p></span></div><button type="button" data-coding-agent-close data-focus-key="close-${esc(detailId)}" aria-label="Close ${esc(visual.name)}, ${esc(visual.role)} details"><span aria-hidden="true">←</span><span>Run overview</span></button></header>
    <section class="coding-agent-overview coding-agent-detail-card"><header><h3>Identity, memory &amp; placement</h3><span>${live ? "Working now" : binding ? "Bound" : "Awaiting runtime"}</span></header><dl><div><dt>Logical node</dt><dd><code>${esc(options.node.id)}</code></dd></div><div><dt>Role</dt><dd>${esc(visual.role)}</dd></div><div><dt>Capabilities</dt><dd>${esc(options.node.capabilities.map(titleCase).join(" · ") || "None")}</dd></div><div><dt>Context boundary</dt><dd>Own task inputs · accepted dependency outputs</dd></div><div><dt>Memory scopes</dt><dd>Role profile · room history · workspace memory · run history</dd></div>${specialization ? `<div><dt>Specialization</dt><dd>${esc(specialization)}</dd></div>` : ""}${skills.length ? `<div><dt>Learned skills</dt><dd>${esc(skills.join(" · "))}</dd></div>` : ""}${tools.length ? `<div><dt>Tools</dt><dd>${esc(tools.map(titleCase).join(" · "))}</dd></div>` : ""}${dependencyNames.length ? `<div><dt>Consumes context from</dt><dd>${esc(dependencyNames.join(" · "))}</dd></div>` : ""}<div><dt>Runtime profile</dt><dd>${esc(runtime?.profile ?? "Default")}</dd></div><div><dt>Binding epoch</dt><dd>${binding ? String(binding.epoch) : "Not bound"}</dd></div></dl></section>
    <section class="coding-agent-tasks coding-agent-detail-card"><header><h3>Assigned tasks</h3><span>${tasks.length}</span></header><ul>${tasks.map((task) => `<li data-state="${esc(task.status)}"><span>${esc(titleCase(task.taskId))}</span><small>${esc(titleCase(task.status))} · ${esc(titleCase(task.capability))}</small></li>`).join("") || `<li><span>No task assigned yet.</span></li>`}</ul></section>
    <section class="coding-agent-terminal coding-agent-detail-card" data-coding-agent-terminal data-node-id="${esc(options.node.id)}" data-entry-count="${runtimeLogs.length}"><header><h3>Process logs</h3><span>${live ? "Live" : runtimeLogs.length ? "Retained" : "Waiting"} · ${runtimeLogs.length}</span></header><ol role="log" aria-live="off">${runtimeLogs.map((entry) => `<li data-stream="${entry.stream}"><span><time datetime="${new Date(entry.at).toISOString()}">${esc(new Date(entry.at).toLocaleTimeString("en-US", { hour12: false }))}</time><code>${String(entry.sequence).padStart(3, "0")}</code></span><pre>${esc(entry.text)}${entry.truncated ? "\n… output chunk truncated" : ""}</pre></li>`).join("") || `<li class="coding-agent-terminal-empty">${live ? "Waiting for the agent process to emit output…" : "No ephemeral process output is retained for this agent."}</li>`}</ol></section>
    <section class="coding-agent-log coding-agent-detail-card"><header><h3>Receipt history</h3><span>${logs.length} event${logs.length === 1 ? "" : "s"}</span></header><ol>${logs.map(({ event, sequence }) => `<li><code>${String(sequence).padStart(3, "0")}</code><span><strong>${esc(titleCase(event.type))}</strong><small>${esc(activityDescription(event))}</small></span></li>`).join("") || `<li class="coding-agent-log-empty">No durable activity recorded yet.</li>`}</ol></section>
    <footer><strong>About these logs</strong><span>Terminal output is bounded and process-local; a server restart clears it. Roster receipts remain the durable run record.</span></footer>
  </section>`;
};

type CodingHumanAction =
  | {
      readonly kind: "ambiguity";
      readonly summary: string;
      readonly unresolved: CodingPeerResolution["unresolved"];
    }
  | {
      readonly kind: "clarification";
      readonly rationale: string;
      readonly questions: CodingConversationRoute["questions"];
      readonly target?: "team";
    }
  | {
      readonly kind: "recovery";
      readonly summary: string;
    }
  | {
      readonly kind: "continuation";
      readonly jobId: string;
      readonly status: JobStatus;
    }
  | { readonly kind: "none" };

const latestReceiptIndex = (
  events: ReadonlyArray<OrchestrationEvent>,
  artifactIds: ReadonlySet<string>,
): number => {
  let latest = -1;
  for (const [index, event] of events.entries()) {
    if (event.type === "artifact.published" && artifactIds.has(event.artifactId)) latest = index;
  }
  return latest;
};

const validatedCodingAmbiguity = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
}): { readonly resolution: CodingPeerResolution; readonly receipt: number } | undefined => {
  const binding = options.state.outputs[CODING_COLLABORATION_RESOLUTION_OUTPUT];
  const artifact = binding ? options.state.artifacts[binding.artifactId] : undefined;
  const resolution = artifact?.payload.storage === "inline"
    ? parseCodingPeerResolution(artifact.payload.value)
    : undefined;
  const task = codingGraphTask(options.state, artifact?.taskId);
  if (resolution?.status !== "ambiguous"
    || binding?.origin !== "task"
    || artifact?.origin !== "task"
    || artifact.outputKey !== CODING_COLLABORATION_RESOLUTION_OUTPUT
    || artifact.taskId !== "resolve-collaboration"
    || task?.taskId !== "resolve-collaboration"
    || task.nodeId !== artifact.nodeId
    || task.capability !== "resolve"
    || task.status !== "accepted"
    || task.dependencies.length === 0
    || !task.dependencies.every((dependency) =>
      codingGraphTask(options.state, dependency.taskId)?.status === "accepted")) return undefined;

  return {
    resolution,
    receipt: latestReceiptIndex(options.events, new Set([artifact.artifactId])),
  };
};

const actionableCodingAmbiguity = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly latestRoute?: CodingConversationRoute;
}): CodingPeerResolution | undefined => {
  const ambiguity = validatedCodingAmbiguity(options);
  if (!ambiguity) return undefined;
  const conversation = codingConversationFromEvents(options.events);
  const latestRouteReceipt = options.latestRoute
    ? latestReceiptIndex(options.events, new Set([options.latestRoute.routeId]))
    : -1;
  const userMessageReceipts = new Set(conversation.messages
    .filter((message) => message.author.kind === "user")
    .map((message) => message.messageId));
  const latestUserMessageReceipt = latestReceiptIndex(options.events, userMessageReceipts);
  return ambiguity.receipt > latestRouteReceipt && ambiguity.receipt > latestUserMessageReceipt
    ? ambiguity.resolution
    : undefined;
};

const codingHumanActionProjection = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
}): CodingHumanAction => {
  const conversation = codingConversationFromEvents(options.events);
  const routeReceiptIndexes = new Map(options.events.flatMap((event, index) =>
    event.type === "artifact.published" && event.kind === CODING_CONVERSATION_ROUTE_KIND
      ? [[event.artifactId, index] as const]
      : []));
  const latestRoute = conversation.routes.reduce<CodingConversationRoute | undefined>((latest, route) =>
    !latest || (routeReceiptIndexes.get(route.routeId) ?? -1) > (routeReceiptIndexes.get(latest.routeId) ?? -1)
      ? route
      : latest, undefined);
  const resolution = actionableCodingAmbiguity({ ...options, ...(latestRoute ? { latestRoute } : {}) });
  const activeJob = Boolean(options.job && ["queued", "leased", "running"].includes(options.job.status));
  const completedCurrentAttempt = options.job?.status === "completed" || codingGraphComplete(options.state);
  if (resolution && !activeJob && !completedCurrentAttempt) {
    return { kind: "ambiguity", summary: resolution.summary, unresolved: resolution.unresolved };
  }
  const historicalAmbiguity = validatedCodingAmbiguity(options);
  const answeredAfterAmbiguity = historicalAmbiguity !== undefined && conversation.messages.some((message) =>
    message.author.kind === "user"
    && message.tags.includes("intent:human-resolution")
    && latestReceiptIndex(options.events, new Set([message.messageId])) > historicalAmbiguity.receipt);
  if (answeredAfterAmbiguity && options.conversationJob && options.conversationJob.id !== options.job?.id) {
    return {
      kind: "continuation",
      jobId: options.conversationJob.id,
      status: options.conversationJob.status,
    };
  }
  const plannerUnavailable = latestRoute?.tags.includes("risk:planner-unavailable") ?? false;
  const failedTask = codingGraphFailure(options.state);
  const terminalJobFailure = options.job?.status === "failed" || options.job?.status === "canceled";
  if (!completedCurrentAttempt && (plannerUnavailable || terminalJobFailure || failedTask)) {
    return {
      kind: "recovery",
      summary: truncate(
        plannerUnavailable
          ? "The bounded planner was unavailable before certification."
          : codingPublicFailureReason({
              canceled: options.job?.status === "canceled" || failedTask?.status === "canceled",
            }),
        600,
      ),
    };
  }
  if (activeJob) return { kind: "none" };
  if (latestRoute?.disposition === "needs_clarification" && !options.job) {
    return {
      kind: "clarification",
      rationale: "Roster needs a bounded product decision before work can start.",
      questions: latestRoute.questions,
      ...(latestRoute.tags.includes("risk:reviewer-unavailable") ? { target: "team" as const } : {}),
    };
  }
  return { kind: "none" };
};

const codingRetryFormHtml = (options: {
  readonly runId?: string;
  readonly job?: CodingDemoJob;
}, compact = false): string => {
  if (!options.runId || !options.job || !["completed", "failed", "canceled"].includes(options.job.status)) return "";
  return `<form class="coding-retry-action${compact ? " coding-retry-action-compact" : ""}" action="/coding/runs/${encodeURIComponent(options.runId)}/retry" method="post">
    <input type="hidden" name="jobId" value="${esc(options.job.id)}"/>
    <button type="submit">Retry Run</button>
    ${compact ? "" : "<small>Starts a fresh bounded attempt from the repository’s current state. This failed execution remains unchanged.</small>"}
  </form>`;
};

const codingHumanActionHtml = (action: CodingHumanAction, options?: {
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly job?: CodingDemoJob;
}): string => {
  if (action.kind === "none") return "";
  if (action.kind === "continuation") {
    const active = ["queued", "leased", "running"].includes(action.status);
    const completed = action.status === "completed";
    const href = options?.runId
      ? `/coding?${options.workspaceId ? `workspace=${encodeURIComponent(options.workspaceId)}&` : ""}run=${encodeURIComponent(options.runId)}&job=${encodeURIComponent(action.jobId)}`
      : undefined;
    return `<section class="coding-human-action" data-state="continued" role="status" aria-live="polite" aria-atomic="true" aria-labelledby="coding-human-action-title">
      <header><strong id="coding-human-action-title">Human action</strong><small>Answer received</small></header>
      <p><strong>Your answer was recorded.</strong> ${active
        ? "A new bounded continuation is working on it."
        : completed
          ? "The bounded continuation has finished."
          : "The bounded continuation stopped; its details are still here."}</p>
      <p>This historical attempt remains unchanged; its intentional ambiguity stop is not a runtime or repository failure.</p>
      ${href ? `<a href="${esc(href)}">Open continuation</a>` : ""}
    </section>`;
  }
  if (action.kind === "recovery") {
    return `<section class="coding-human-action" data-state="recovery" role="status" aria-live="polite" aria-atomic="true" aria-labelledby="coding-human-action-title">
      <header><strong id="coding-human-action-title">Human action</strong><small>No reply requested</small></header>
      <p><strong>No human answer is requested.</strong> ${esc(action.summary)}</p>
      <p>This attempt stopped before certification. Review the retained details if needed, then retry from the repository’s current state.</p>
      ${codingRetryFormHtml(options ?? {})}
    </section>`;
  }
  if (action.kind === "clarification") {
    return `<section class="coding-human-action" data-state="requested" role="status" aria-live="polite" aria-atomic="true" aria-labelledby="coding-human-action-title">
      <header><strong id="coding-human-action-title">Human action</strong><small>Reply requested</small></header>
      <p>${esc(action.rationale)}</p>
      <ol>${action.questions.map((question) => `<li>${esc(question)}</li>`).join("")}</ol>
      ${action.target === "team" ? `<button type="button" data-coding-workbench-shortcut="team" data-coding-open-work data-workbench-target="team" aria-controls="coding-context-cast">Open Team</button>` : ""}
      <button type="button" data-coding-human-reply aria-controls="coding-objective">Reply</button>
    </section>`;
  }
  return `<section class="coding-human-action" data-state="requested" role="status" aria-live="polite" aria-atomic="true" aria-labelledby="coding-human-action-title">
    <header><strong id="coding-human-action-title">Human action</strong><small>Reply requested</small></header>
    <p>${esc(action.summary)}</p>
    <p>The repository and peer discussion could not safely resolve these subjects; your product context is needed.</p>
    <ol>${action.unresolved.map((subject) => `<li><strong>${esc(subject.subjectId)}</strong><p>${esc(subject.reason)}</p><span>Candidate positions</span><ul>${subject.candidateSummaries.map((candidate) => `<li>${esc(candidate)}</li>`).join("")}</ul></li>`).join("")}</ol>
    <button type="button" data-coding-human-reply aria-controls="coding-objective">Reply</button>
  </section>`;
};

const codingInlineReplyHtml = (action: CodingHumanAction, options: {
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
}): string => {
  if (!options.runId || (action.kind !== "clarification" && action.kind !== "ambiguity")) return "";
  const interactionJob = options.conversationJob ?? options.job;
  const reply: GenerativeUiReply = {
    id: `reply-${hashCanonical({ runId: options.runId, kind: action.kind }).slice(0, 16)}`,
    action: "/coding/run",
    title: action.kind === "clarification" ? "Answer Roster" : "Resolve the Remaining Decision",
    description: action.kind === "clarification"
      ? action.rationale
      : "The repository and peer discussion could not safely choose between the remaining product positions.",
    prompts: action.kind === "clarification"
      ? action.questions
      : action.unresolved.map((subject) => `${titleCase(subject.subjectId)}: ${subject.reason}`),
    inputLabel: "Your reply",
    placeholder: action.kind === "clarification"
      ? "Answer the requested question…"
      : "State the intended product decision…",
    submitLabel: "Reply Inline",
    help: action.kind === "ambiguity"
      ? "Your answer becomes durable collaboration context before a new bounded execution starts."
      : "Roster records the answer before creating an execution lease or Git branch.",
    hiddenFields: [
      ...(options.workspaceId ? [{ name: "workspaceId", value: options.workspaceId }] : []),
      { name: "conversationId", value: options.runId },
      { name: "reviewPolicy", value: interactionJob?.reviewPolicy ?? "auto" },
    ],
  };
  return `<li class="coding-inline-reply">${generativeUiReplyHtml(reply)}</li>`;
};

type CodingRunTokenUsage = {
  readonly totalTokens: number;
  readonly completedModelTasks: number;
  readonly startedModelTasks: number;
};

const CODING_MODEL_RUNTIME_KINDS = new Set(["codex-cli", "claude-code", "pi-agent", "hermes-agent"]);

const codingRunTokenUsage = (
  state: OrchestrationState,
  _events: ReadonlyArray<OrchestrationEvent>,
): CodingRunTokenUsage => {
  const modelTasks = codingGraphTasks(state).filter((task) => {
    const declaredKind = state.nodes[task.nodeId]?.runtime?.kind;
    const boundKind = state.nodeBindings[task.nodeId]?.runtime.kind;
    return Boolean(
      (declaredKind && CODING_MODEL_RUNTIME_KINDS.has(declaredKind))
      || (boundKind && CODING_MODEL_RUNTIME_KINDS.has(boundKind)),
    );
  });
  const completedModelTasks = modelTasks.filter((task) => task.status === "accepted");
  const startedModelTasks = modelTasks.filter((task) =>
    task.attempt > 0 || task.status === "leased" || task.status === "running" || task.status === "accepted");
  return {
    totalTokens: state.taskGraph?.acceptedTokens ?? 0,
    completedModelTasks: completedModelTasks.length,
    startedModelTasks: startedModelTasks.length,
  };
};

const codingRunTokenUsageHtml = (usage: CodingRunTokenUsage): string => {
  if (usage.startedModelTasks === 0) return "";
  const number = new Intl.NumberFormat("en-US");
  if (usage.completedModelTasks === 0) {
    return `<span class="coding-token-usage" data-state="pending" title="Provider usage is recorded after a model task completes.">Agent token usage pending</span>`;
  }
  if (usage.totalTokens === 0) {
    return `<span class="coding-token-usage" data-state="unavailable" title="This run has no provider-reported agent token receipts. Historical runs are not estimated.">Agent token usage not recorded · 0/${usage.completedModelTasks}</span>`;
  }
  const coverage = `${usage.completedModelTasks} accepted model task${usage.completedModelTasks === 1 ? "" : "s"}`;
  const title = `${number.format(usage.totalTokens)} budgeted tokens · cached input excluded · ${coverage}. Provider-reported totals remain in run details.`;
  return `<span class="coding-token-usage" data-state="complete" title="${esc(title)}"><strong>${number.format(usage.totalTokens)} budget tokens</strong> · cached input excluded</span>`;
};

type CodingCoordinationState = "working" | "waiting" | "done" | "blocked";

const codingCoordinationTaskState = (task: CodingGraphTask): CodingCoordinationState => {
  if (task.status === "running" || task.status === "leased") return "working";
  if (task.status === "accepted" || task.status === "skipped") return "done";
  if (task.status === "failed" || task.status === "canceled") return "blocked";
  return "waiting";
};

const codingCoordinationTask = (
  tasks: ReadonlyArray<CodingGraphTask>,
): CodingGraphTask | undefined => {
  const rank: Readonly<Record<CodingCoordinationState, number>> = {
    blocked: 0,
    working: 1,
    waiting: 2,
    done: 3,
  };
  return [...tasks].sort((left, right) =>
    rank[codingCoordinationTaskState(left)] - rank[codingCoordinationTaskState(right)])[0];
};

const codingCoordinationTaskStages = (
  tasks: ReadonlyArray<CodingGraphTask>,
): ReadonlyMap<string, number> => {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const stages = new Map<string, number>();
  const visiting = new Set<string>();
  const stageFor = (taskId: string): number => {
    const known = stages.get(taskId);
    if (known !== undefined) return known;
    if (visiting.has(taskId)) return 0;
    const task = taskById.get(taskId);
    if (!task) return 0;
    visiting.add(taskId);
    const dependencyStages = task.dependencies.flatMap((dependency) =>
      taskById.has(dependency.taskId) ? [stageFor(dependency.taskId)] : []);
    visiting.delete(taskId);
    const stage = dependencyStages.length > 0 ? Math.max(...dependencyStages) + 1 : 0;
    stages.set(taskId, stage);
    return stage;
  };
  for (const task of tasks) stageFor(task.taskId);
  return stages;
};

const codingCoordinationDagHtml = (
  tasks: ReadonlyArray<CodingGraphTask>,
  nodeName: (nodeId: string) => string,
  taskStages: ReadonlyMap<string, number>,
): string => {
  const statusLabel = (status: CodingGraphTask["status"]): string => {
    if (status === "running" || status === "leased") return "In progress";
    if (status === "accepted") return "Accepted";
    if (status === "failed" || status === "canceled") return "Needs attention";
    if (status === "ready") return "Ready";
    if (status === "skipped") return "Skipped";
    return "Waiting";
  };
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const stages = new Map<number, CodingGraphTask[]>();
  for (const task of tasks) {
    const stage = taskStages.get(task.taskId) ?? 0;
    stages.set(stage, [...(stages.get(stage) ?? []), task]);
  }
  const stageRows = [...stages.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, stageTasks], index) => {
      const orderedTasks = [...stageTasks].sort((left, right) => left.taskId.localeCompare(right.taskId));
      const taskRows = orderedTasks.map((task) => {
        const dependencies = task.dependencies.flatMap((dependency) => {
          const prerequisite = taskById.get(dependency.taskId);
          return prerequisite ? [titleCase(prerequisite.taskId)] : [];
        });
        return `<li class="coding-dag-task" data-task-id="${esc(task.taskId)}" data-state="${esc(task.status)}">
          <header><strong>${esc(titleCase(task.taskId))}</strong><span>${esc(statusLabel(task.status))}</span></header>
          <small>${esc(nodeName(task.nodeId))} · ${esc(titleCase(task.capability))}</small>
          <p><span>${dependencies.length > 0 ? "From" : "Entry"}</span>${esc(dependencies.length > 0 ? dependencies.join(" + ") : "No prerequisites")}</p>
        </li>`;
      }).join("");
      return `<li class="coding-dag-stage" data-stage="${index + 1}">
        <header><span>Step ${index + 1}</span><small>${orderedTasks.length > 1 ? `${orderedTasks.length} parallel tasks` : "1 task"}</small></header>
        <ul>${taskRows}</ul>
      </li>`;
    }).join("");
  return `<details class="coding-coordination-dag" data-coding-coordination-dag data-details-key="coordination-dag" open>
    <summary><span><strong>Live task DAG</strong><small data-coding-dag-summary>${tasks.length > 0 ? "Durable dependency path" : "Waiting for durable graph"}</small></span><em data-coding-dag-meta>${tasks.length} tasks · ${tasks.reduce((count, task) => count + task.dependencies.length, 0)} edges</em></summary>
    <div data-coding-dag-body>${stageRows ? `<ol class="coding-dag-stages" aria-label="Live dynamic task DAG">${stageRows}</ol>` : `<p class="coding-dag-empty">The task graph will appear when Roster materializes the run.</p>`}</div>
    <footer aria-label="Task status legend"><span data-state="running">Working</span><span data-state="ready">Ready</span><span data-state="accepted">Accepted</span><span data-state="failed">Attention</span></footer>
  </details>`;
};

const codingCoordinationDockHtml = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly job?: CodingDemoJob;
  readonly workspaceProfile?: CodingWorkspaceProfile;
}): string => {
  const tasks = codingGraphTasks(options.state).filter(isCodingUserVisibleTask);
  const taskNodeIds = [...new Set(tasks.map((task) => task.nodeId))];
  const spawnedNodeIds = new Set(options.events.flatMap((event) =>
    event.type === "node.spawned" ? [event.node.id] : []));
  const profileNodes = new Map((options.workspaceProfile?.nodes ?? []).map((node) => [node.id, node]));
  const nodeFor = (
    nodeId: string,
  ): CodingStateNode | CodingWorkspaceProfile["nodes"][number] | undefined =>
    options.state.nodes[nodeId] ?? profileNodes.get(nodeId);
  const nodeIds = taskNodeIds.length > 0
    ? taskNodeIds
    : [...spawnedNodeIds].filter((nodeId) => {
      const node = nodeFor(nodeId);
      return node?.metadata?.participantKind !== "human" && nodeId !== "coordinator";
    });
  const nodes = nodeIds.flatMap((nodeId) => {
    const node = nodeFor(nodeId);
    return node && node.id !== "coordinator" && node.metadata?.participantKind !== "human"
      ? [node]
      : [];
  });
  const jobActive = Boolean(options.job && ["queued", "leased", "running"].includes(options.job.status));
  if (nodes.length === 0 && !jobActive) return "";

  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const taskStages = codingCoordinationTaskStages(tasks);
  const stateCounts: Record<CodingCoordinationState, number> = {
    working: 0,
    waiting: 0,
    done: 0,
    blocked: 0,
  };
  const coordinationStage = (node: CodingStateNode | CodingWorkspaceProfile["nodes"][number]): number => {
    const nodeStages = tasks
      .filter((task) => task.nodeId === node.id)
      .map((task) => taskStages.get(task.taskId) ?? 0);
    return nodeStages.length > 0 ? Math.min(...nodeStages) : Number.MAX_SAFE_INTEGER;
  };
  const coordinationFirstTaskId = (node: CodingStateNode | CodingWorkspaceProfile["nodes"][number]): string => {
    const nodeTaskIds = tasks
      .filter((task) => task.nodeId === node.id)
      .map((task) => task.taskId)
      .sort((left, right) => left.localeCompare(right));
    return nodeTaskIds[0] ?? "\uffff";
  };
  const orderedNodes = [...nodes].sort((left, right) =>
    coordinationStage(left) - coordinationStage(right)
    || coordinationFirstTaskId(left).localeCompare(coordinationFirstTaskId(right))
    || left.name.localeCompare(right.name));
  const assignedStages = [...new Set(orderedNodes
    .map(coordinationStage)
    .filter((stage) => stage !== Number.MAX_SAFE_INTEGER))].sort((left, right) => left - right);
  const stageOrdinal = new Map(assignedStages.map((stage, index) => [stage, index + 1]));
  const stageCounts = new Map<number, number>();
  for (const node of orderedNodes) {
    const stage = coordinationStage(node);
    stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
  }
  let previousStage: number | undefined;
  const nodeRows = orderedNodes.map((node) => {
    const nodeTasks = tasks.filter((task) => task.nodeId === node.id);
    const task = codingCoordinationTask(nodeTasks);
    const stage = coordinationStage(node);
    const ordinal = stageOrdinal.get(stage);
    const stageSize = stageCounts.get(stage) ?? 1;
    const stageHeader = stage !== previousStage
      ? `<li class="coding-coordination-stage" data-stage="${ordinal ?? "unassigned"}"><span>${ordinal ? `Step ${ordinal}` : "Unassigned"}</span><small>${ordinal === undefined ? "Awaiting task ownership" : ordinal === 1 ? stageSize > 1 ? `${stageSize} agents start in parallel` : "Starting work" : stageSize > 1 ? `${stageSize} agents after accepted handoffs` : "After accepted handoff"}</small></li>`
      : "";
    previousStage = stage;
    const state: CodingCoordinationState = task ? codingCoordinationTaskState(task) : "waiting";
    stateCounts[state] += 1;
    const visual = codingAgentVisual(node);
    const identity = visibleRuntimeIdentity(
      options.state.nodes[node.id],
      options.state.nodeBindings[node.id],
    );
    const usesPrimaryCodingAgent = task
      ? ["implement", "remediate", "mutate", "propose"].some((capability) =>
          task.capability.toLowerCase().includes(capability))
      : false;
    const runtimeLabel = identity.agent === "Agent binding pending" && usesPrimaryCodingAgent && options.job?.workerRuntime
      ? codingRuntimeLabel(options.job.workerRuntime)
      : identity.agent;
    const modelLabel = identity.model === "Model pending" && usesPrimaryCodingAgent && options.job?.workerModel
      ? runtimeModelLabel(options.job.workerModel)
      : identity.model;
    const upstreamNames = task
      ? [...new Set(task.dependencies.flatMap((dependency) => {
          const dependencyTask = taskById.get(dependency.taskId);
          const dependencyNode = dependencyTask ? nodeFor(dependencyTask.nodeId) : undefined;
          return dependencyNode && dependencyNode.id !== node.id
            ? [codingAgentVisual(dependencyNode).name]
            : [];
        }))]
      : [];
    const blockingDependencyNames = task
      ? [...new Set(task.dependencies.flatMap((dependency) => {
          const dependencyTask = taskById.get(dependency.taskId);
          if (!dependencyTask) return [];
          const satisfied = dependency.condition === "accepted"
            ? dependencyTask.status === "accepted"
            : ["accepted", "failed", "canceled", "skipped"].includes(dependencyTask.status);
          if (satisfied) return [];
          const dependencyNode = nodeFor(dependencyTask.nodeId);
          return dependencyNode && dependencyNode.id !== node.id
            ? [codingAgentVisual(dependencyNode).name]
            : [];
        }))]
      : [];
    const downstreamNames = [...new Set(tasks.flatMap((candidate) => {
      if (candidate.nodeId === node.id || !candidate.dependencies.some((dependency) =>
        nodeTasks.some((nodeTask) => nodeTask.taskId === dependency.taskId))) return [];
      const downstreamNode = nodeFor(candidate.nodeId);
      return downstreamNode ? [codingAgentVisual(downstreamNode).name] : [];
    }))];
    const otherWorking = orderedNodes.some((candidate) =>
      candidate.id !== node.id
      && tasks.some((candidateTask) =>
        candidateTask.nodeId === candidate.id
        && codingCoordinationTaskState(candidateTask) === "working"));
    const statusLabel = state === "done"
      ? "Complete"
      : state === "blocked"
        ? "Needs attention"
        : titleCase(state);
    const taskSummary = !task
      ? "Waiting for Roster to assign a bounded task"
      : state === "working"
        ? taskMilestone(task.capability, false)
        : state === "done"
          ? taskMilestone(task.capability, true)
          : state === "blocked"
            ? `${titleCase(task.capability)} stopped before acceptance`
            : blockingDependencyNames.length > 0
              ? `Waiting for ${blockingDependencyNames.join(" and ")}`
              : `Queued to ${titleCase(task.capability)}`;
    const handoff = state === "blocked"
      ? "Roster has preserved the last accepted frontier"
      : blockingDependencyNames.length > 0 && state !== "done"
        ? `Waiting on accepted work from ${blockingDependencyNames.join(" and ")}`
        : upstreamNames.length > 0 && state === "working"
          ? `Working from accepted input by ${upstreamNames.join(" and ")}`
        : downstreamNames.length > 0
          ? `${state === "done" ? "Handed off to" : "Next"} ${downstreamNames.join(" and ")}`
          : state === "working" && otherWorking
            ? "Working independently in parallel"
            : state === "done"
              ? "Contribution accepted"
              : "Owns this bounded step";
    const detailId = codingAgentDetailId(node.id);
    return `${stageHeader}<li data-state="${state}" data-node-id="${esc(node.id)}"${ordinal ? ` data-step="${ordinal}"` : ""}>
      <div class="coding-coordination-person">${codingAgentSymbolHtml(visual, "coding-coordination-avatar")}<span><strong>${esc(visual.name)}</strong><small>${esc(visual.role)}</small>${codingAgentModelHtml(runtimeLabel, modelLabel, "coding-coordination-execution")}</span></div>
      <span class="coding-coordination-state"><i aria-hidden="true"></i>${esc(statusLabel)}</span>
      <p>${esc(taskSummary)}</p>
      <span class="coding-coordination-handoff"><span aria-hidden="true">↳</span>${esc(handoff)}</span>
      <a href="#${esc(detailId)}" data-coding-coordination-agent="${esc(detailId)}" aria-label="View ${esc(visual.name)} details">View details <span aria-hidden="true">→</span></a>
    </li>`;
  }).join("");
  const total = orderedNodes.length;
  const runNeedsAttention = options.job?.status === "failed"
    || (codingGraphFailure(options.state) !== undefined
      && !codingCommittedUsageNote(options.state, options.job));
  const attentionCount = stateCounts.blocked > 0 ? stateCounts.blocked : runNeedsAttention ? 1 : 0;
  const activeLabel = stateCounts.working > 0
    ? `${stateCounts.working} working now`
    : attentionCount > 0
      ? `${attentionCount} ${attentionCount === 1 ? "needs" : "need"} attention`
      : stateCounts.done === total && total > 0
        ? "All contributions accepted"
        : total > 0
          ? `${stateCounts.waiting} ready`
          : "Preparing team";
  const summary = stateCounts.working > 1
    ? "Named agents keep separate task context while working in parallel."
    : tasks.some((task) => task.dependencies.length > 0)
      ? "Each agent keeps its own context; accepted outputs become the next agent’s input."
      : jobActive
        ? "Connecting the selected coding agent and assigning the first task."
        : "Each role, context, memory trail, and accepted contribution remains attached to the run.";
  const dagHtml = codingCoordinationDagHtml(
    tasks,
    (nodeId) => {
      const node = nodeFor(nodeId);
      return node ? codingAgentVisual(node).name : nodeId === "coordinator" ? "Roster" : titleCase(nodeId);
    },
    taskStages,
  );
  return `<aside class="coding-coordination" data-coding-island="coordination-dock" data-state="${attentionCount > 0 ? "blocked" : stateCounts.working > 0 ? "working" : stateCounts.done === total && total > 0 ? "done" : "waiting"}" aria-labelledby="coding-coordination-title">
    <header><span><small>Run details</small><strong id="coding-coordination-title">Collaboration plan</strong></span><em data-coding-coordination-label data-run-presentation-label>${esc(activeLabel)}</em></header>
    <p class="coding-coordination-summary" data-coding-coordination-summary data-run-presentation-summary role="status" aria-live="polite" aria-atomic="true">${esc(summary)}</p>
    <div class="coding-coordination-counts" aria-label="Coordination status"><span><b data-coding-coordination-count="working">${stateCounts.working}</b> working</span><span><b data-coding-coordination-count="waiting">${stateCounts.waiting}</b> waiting</span><span><b data-coding-coordination-count="done">${stateCounts.done}</b> done</span><span><b data-coding-coordination-count="blocked">${attentionCount}</b> attention</span></div>
    ${dagHtml}
    <div data-coding-coordination-body>${nodeRows ? `<ol aria-label="Collaboration plan ordered by task dependencies">${nodeRows}</ol>` : `<div class="coding-coordination-assembling"><i aria-hidden="true"></i><span><strong>Starting the coding team</strong><small>The selected coding agent is connected; named roles will appear as tasks are assigned.</small></span></div>`}</div>
    <footer><span>Ordered by handoff · live status does not reorder steps</span><button type="button" data-coding-open-work>See details <span aria-hidden="true">→</span></button></footer>
  </aside>`;
};

const liveRunHtml = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly runId?: string;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
  readonly runtimeLogs?: ReadonlyArray<StoredNodeRuntimeLog>;
}): string => {
  const conversation = codingConversationFromEvents(options.events);
  const latestRoute = conversation.routes.at(-1);
  const latestDisposition = latestRoute?.disposition;
  const directReply = latestRoute
    ? conversation.messages.find((message) =>
        message.replyTo === latestRoute.inReplyTo
        && message.author.kind === "agent"
        && message.tags.includes("routing:direct-mention"))
    : undefined;
  const directReplyName = directReply
    ? codingAgentVisual({ name: directReply.author.name }).name
    : undefined;
  const humanAction = codingHumanActionProjection(options);
  const committedUsageNote = codingCommittedUsageNote(options.state, options.job);
  const awaitingAnswer = humanAction.kind === "ambiguity" || humanAction.kind === "clarification";
  const informational = latestDisposition === "informational" && !options.job;
  const status = informational
    ? { tone: "idle" as const, label: "Answered" }
    : awaitingAnswer
    ? { tone: "idle" as const, label: "Needs your answer" }
    : humanAction.kind === "recovery" && !committedUsageNote
    ? { tone: "failed" as const, label: "Needs attention" }
    : humanAction.kind === "continuation"
    ? ["queued", "leased", "running"].includes(humanAction.status)
      ? { tone: "active" as const, label: "Continuation active" }
      : humanAction.status === "completed"
        ? { tone: "success" as const, label: "Continuation complete" }
        : { tone: "failed" as const, label: "Continuation stopped" }
    : overallStatus(options.state, options.job);
  const activeTask = codingGraphTasks(options.state).find((task) =>
    task.status === "running" || task.status === "leased");
  const managementRun = options.job?.runKind === "workspace-rescan";
  const activeNode = activeTask ? options.state.nodes[activeTask.nodeId] : undefined;
  const activeNodeName = activeNode ? codingAgentVisual(activeNode).name : undefined;
  const summary = informational
    ? `${directReplyName ?? "Roster"} answered directly; no branch or execution lease was created`
    : managementRun && status.tone === "failed"
    ? "The branchless team rescan stopped; the previously selected profile remains active"
    : managementRun && activeTask
    ? `${activeNodeName ?? activeTask.nodeId} is updating the workspace profile`
    : managementRun && status.tone === "success"
    ? "The updated team profile is published for future conversations"
    : managementRun
    ? "Roster is preparing the branchless team rescan"
    : awaitingAnswer
    ? humanAction.kind === "ambiguity"
      ? "The team could not resolve the remaining product decision and asked you"
      : "Roster paused before creating a branch or taking an execution lease"
    : status.label === "Ready to merge"
    ? `The change is certified and waiting for you to merge it into ${options.job?.baselineBranch ?? "the target branch"}`
    : status.label === "Finalizing delivery"
    ? "The team certified the change and is preparing the exact commit for merge"
    : status.label === "Merged"
    ? `The certified change is now on ${options.job?.integration?.currentBranch ?? options.job?.baselineBranch ?? "the target branch"}`
    : status.tone === "failed"
    ? codingGraphComplete(options.state) || codingHasCertifiedDelivery(options.job)
      ? "The change is certified, but its merge needs attention"
      : "The team stopped before this change could be certified"
    : activeTask
      ? `${activeNodeName ?? activeTask.nodeId} ${taskMilestone(activeTask.capability, false)}`
      : status.tone === "success"
      ? "The team completed and certified this change"
      : options.job
          ? "Roster is preparing the peer graph"
          : "Your repository team is ready";
  const participantIds = new Set(options.events.flatMap((event) => event.type === "node.spawned" ? [event.node.id] : []));
  const nodes = Object.values(options.state.nodes)
    .filter((node) => node.id !== "coordinator" && (node.status === "active" || participantIds.has(node.id)));
  const agentRows = nodes.map((node) => {
    const visual = codingAgentVisual(node);
    const identity = visibleRuntimeIdentity(node, options.state.nodeBindings[node.id]);
    const state = nodeTaskState(options.state, node.id, status.tone);
    const detailId = codingAgentDetailId(node.id);
    const runtimeLogCount = (options.runtimeLogs ?? []).filter((entry) => entry.nodeId === node.id).length;
    const detailLabel = `${runtimeLogCount ? `${runtimeLogCount} · ` : ""}Logs ›`;
    return `<li class="coding-agent-row" data-node-id="${esc(node.id)}" data-state="${esc(state)}"><button type="button" class="coding-agent-link" data-coding-agent-trigger data-focus-key="inspect-${esc(detailId)}" aria-label="Inspect ${esc(visual.name)}, ${esc(visual.role)}" aria-controls="${esc(detailId)}" aria-expanded="false">${codingAgentSymbolHtml(visual, "coding-agent-avatar")}<span><strong>${esc(visual.name)}</strong><small>${esc(visual.role)}</small>${codingAgentModelHtml(identity.agent, identity.model, "coding-run-agent-execution")}</span><span class="coding-agent-row-meta"><em>${esc(titleCase(state))}</em><small data-runtime-log-label>${detailLabel}</small></span></button></li>`;
  }).join("");
  const agentDetails = nodes.map((node) => codingAgentDetailsHtml({ ...options, node })).join("");
  const tokenUsage = codingRunTokenUsage(options.state, options.events);
  return `<section class="coding-live" id="coding-run-agents" data-coding-island="work-presence" data-run-presentation data-state="${awaitingAnswer ? "awaiting-answer" : status.tone}">
    <header><span class="coding-live-copy"><i aria-hidden="true"></i><span><strong data-run-presentation-label>${esc(status.label)}</strong><small data-run-presentation-summary>${esc(summary)}</small></span></span><span class="coding-live-metrics"><span class="coding-update-count" data-run-presentation-progress>${options.events.length} update${options.events.length === 1 ? "" : "s"}</span>${codingRunTokenUsageHtml(tokenUsage)}</span></header>
    ${agentRows ? `<div class="coding-run-team-label"><span>${managementRun ? "Team review tasks" : "Active peers"}</span><strong>${nodes.length}</strong></div><p class="coding-run-team-help">${managementRun ? "Open a specialist to inspect its bounded profile task · live status refreshes every ~1s · task receipts are durable in SpacetimeDB" : "Open a peer to inspect its specialization, model, tasks, and live process logs · live status refreshes every ~1s · collaboration frontiers are durable in SpacetimeDB"}</p><ul aria-label="${managementRun ? "Specialists in this team rescan" : "Active peers for this run"}">${agentRows}</ul>${agentDetails}` : ""}
  </section>`;
};

const parseCodingContribution = (value: string): CodingContribution | undefined => {
  const proposal = parseCodingPeerProposal(value);
  if (proposal) return { kind: "proposal", value: proposal };
  const response = parseCodingPeerResponse(value);
  if (response) return { kind: "response", value: response };
  const resolution = parseCodingPeerResolution(value);
  if (resolution) return { kind: "resolution", value: resolution };
  const endorsement = parseCodingPeerEndorsement(value);
  return endorsement ? { kind: "endorsement", value: endorsement } : undefined;
};

const parseCodingAuthoredArtifactTurn = (
  value: string,
  outputKey: string,
  task: CodingGraphTask | undefined,
): CodingAuthoredArtifactTurn | undefined => {
  if (!task) return undefined;
  const kind = task.taskId === "coding-finalize"
      && (outputKey === "coding_result" || outputKey === "final_report")
    ? "final-result"
    : task.capability === "room" && task.taskId.startsWith("announce-")
        && outputKey.startsWith("room_announcement_")
      ? "announcement"
    : task.capability === "implement"
        && (outputKey === "implementation_report" || outputKey === "final_report")
      ? "implementation"
    : /review|certif/iu.test(task.capability)
        && (outputKey === "review_report" || /^review_.+_report$/u.test(outputKey))
      ? "review-report"
    : task.capability === "remediate" && outputKey === "final_report"
      ? "remediation"
    : task.capability === "investigate"
        && task.taskId === "synthesize-investigation"
        && outputKey === "final_report"
    ? "investigation-synthesis"
    : task.capability === "investigate"
        && task.taskId.startsWith("investigate-")
        && outputKey.startsWith("investigation_")
        && outputKey.endsWith("_report")
      ? "investigation-report"
      : undefined;
  if (!kind) return undefined;
  const parsed = parsedReport(value);
  const enveloped = parsed?.[outputKey];
  const report = enveloped !== null && typeof enveloped === "object" && !Array.isArray(enveloped)
    ? enveloped as Record<string, unknown>
    : parsed;
  const summary = reportString(report?.summary, 1_600);
  return summary ? { kind, summary } : undefined;
};

const codingRoomHtml = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly job?: CodingDemoJob;
  readonly runId?: string;
  readonly workspaceProfile?: CodingWorkspaceProfile;
  readonly repository?: CodingRepositoryGitState;
  readonly conversationJob?: CodingDemoJob;
}): string => {
  const nodes = new Map([
    codingHumanWorkspaceNode(),
    codingCoordinatorWorkspaceNode(),
    ...(options.workspaceProfile?.nodes ?? []),
    ...Object.values(options.state.nodes),
  ].map((node) => [node.id, node]));
  const humanAction = codingHumanActionProjection(options);
  const roomJob = options.job ?? options.conversationJob;
  const room = codingRoomProjection({
    conversationId: options.runId ?? "repository",
    repositoryName: options.repository?.path.split(/[\\/]/).filter(Boolean).at(-1),
    ...(roomJob ? { job: roomJob } : {}),
    nodes: [...nodes.values()],
    tasks: codingGraphTasks(options.state).map((task) => ({
      nodeId: task.nodeId,
      status: codingGraphDisplayStatus(task),
    })),
    waitingForHuman: humanAction.kind === "ambiguity" || humanAction.kind === "clarification",
  });
  const workingNames = room.participants
    .filter((participant) => participant.presence === "working")
    .map((participant) => participant.displayName);
  const presenceSummary = workingNames.length > 0
    ? `${workingNames.slice(0, 2).join(" and ")}${workingNames.length > 2 ? ` +${workingNames.length - 2}` : ""} working now`
    : room.participants.length === 1
      ? "1 person here"
      : `${room.participants.length} people and agents here`;
  const continuity = room.kind === "branch"
    ? room.state === "archived"
      ? "Conversation and decisions remain in the repository room."
      : "Branch-scoped · conversation continues across runs."
    : "Durable repository conversation · branches open rooms without resetting it.";
  const roster = projectRoomRoster({
    roomId: room.roomId,
    label: room.title,
    summary: presenceSummary,
    context: continuity,
    members: room.participants.map((participant) => ({
      participant,
      presence: {
        state: participant.presence,
        label: titleCase(participant.presence),
      },
    })),
  });
  return `<header class="coding-room" data-coding-island="room-header" data-room-id="${esc(room.roomId)}" data-room-kind="${esc(room.kind)}" data-room-state="${esc(room.state)}" data-slot="room-header">
    <div class="coding-room-heading"><span class="coding-room-orb" data-thinking-orb data-orb-state="${room.state === "waiting" ? "listening" : room.state === "archived" ? "solving" : workingNames.length > 0 ? "working" : "listening"}" data-orb-size="20" data-orb-paused="${room.state === "archived"}" aria-label="${esc(room.stateLabel)}"></span><span class="coding-room-kind">${room.kind === "branch" ? "Branch room" : "Repository room"}</span><h2>${esc(room.title)}</h2><span class="coding-room-state"><i aria-hidden="true"></i><span data-run-presentation-label>${esc(room.stateLabel)}</span></span></div>
    ${room.topic && !options.job ? `<p class="coding-room-topic">${esc(truncate(room.topic, 240))}</p>` : ""}
    <div class="coding-room-social" data-coding-island="room-roster" data-slot="room-participants"><button class="coding-rail-toggle" type="button" aria-label="Open repository navigation" aria-controls="coding-project-rail" aria-expanded="false" data-coding-rail-toggle><span aria-hidden="true">☰</span></button>${roomRosterHtml(roster, { id: `${room.roomId}-coding-roster`, compact: true })}<button class="coding-command-trigger" type="button" data-coding-command-trigger aria-label="Open command palette" aria-haspopup="dialog" aria-controls="coding-command-dialog" aria-keyshortcuts="Meta+K Control+K"><span>Commands</span><kbd>⌘K</kbd></button><button class="coding-room-details-toggle" type="button" aria-controls="coding-context-cast" aria-expanded="false" aria-keyshortcuts="Meta+J Control+J" data-coding-context-toggle><span aria-hidden="true">☷</span><span>Workbench</span></button></div>
    ${room.branch ? `<div class="coding-room-branch"><span>Branch</span><code>${esc(room.branch)}</code></div>` : ""}
    <p class="coding-room-live sr-only" data-coding-live-status data-state="connecting" role="status" aria-live="polite" aria-atomic="true">Connecting</p>
  </header>`;
};

type CodingConversationOptions = {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly job?: CodingDemoJob;
  readonly eventTimestamps?: ReadonlyArray<number>;
  readonly conversationJob?: CodingDemoJob;
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly workspaceProfile?: CodingWorkspaceProfile;
  readonly workspaceSettings?: CodingWorkspaceSettings;
  readonly chatModel?: string;
  readonly roomUpdates?: ReadonlyArray<NodeRoomUpdate>;
};


const codingNodeProfileSkills = (node: WorkspaceNode | undefined): ReadonlyArray<string> => {
  const configured = Array.isArray(node?.metadata?.profileSkills)
    ? node.metadata.profileSkills
    : Array.isArray(node?.metadata?.specialistSkills)
      ? node.metadata.specialistSkills
      : [];
  return configured.flatMap((skill) => {
    if (typeof skill === "string" && skill.trim()) return [skill.trim()];
    if (skill && typeof skill === "object" && !Array.isArray(skill)
      && typeof skill.name === "string" && skill.name.trim()) return [skill.name.trim()];
    return [];
  });
};

const codingParticipantProfileSeed = (input: {
  readonly node?: WorkspaceNode;
  readonly nodeId: string;
  readonly name: string;
  readonly role: string;
  readonly kind: "human" | "agent" | "system";
  readonly agent?: string;
  readonly model?: string;
  readonly executionScope?: "message" | "active" | "preference";
  readonly continuity?: ParticipantContinuitySeed;
}) => ({
  nodeId: input.node?.id ?? input.nodeId,
  displayName: input.name,
  role: input.role,
  kind: input.kind,
  bio: typeof input.node?.metadata?.profileBio === "string"
    ? input.node.metadata.profileBio
    : typeof input.node?.metadata?.repositoryReason === "string"
      ? input.node.metadata.repositoryReason
      : "",
  skills: codingNodeProfileSkills(input.node),
  capabilities: input.node?.capabilities ?? [],
  ...(input.agent ? { agent: input.agent } : {}),
  ...(input.model ? { model: input.model } : {}),
  ...(input.executionScope ? { executionScope: input.executionScope } : {}),
  ...(input.continuity ? { continuity: input.continuity } : {}),
});

const codingParticipantContinuitySeed = (
  summary: NodeContinuitySummary,
  rooms: ReadonlyArray<CodingDurableRoom>,
): ParticipantContinuitySeed => {
  const visibleRoomIds = new Set(rooms.map((room) => room.conversationId));
  const roomLabel = (roomId: string | undefined, laneId: string): string => {
    const room = rooms.find((candidate) => candidate.conversationId === roomId);
    return room?.title ?? (roomId ? "Another workspace" : `Lane ${laneId.slice(-8)}`);
  };
  return {
    status: summary.status,
    pendingItemCount: summary.pendingItemCount,
    pendingLaneCount: summary.pendingLaneCount,
    activeCommitmentCount: summary.activeCommitmentCount,
    ...(summary.activeLaneId ? {
      activeRoomLabel: roomLabel(summary.activeRoomId, summary.activeLaneId),
    } : {}),
    ...(summary.memoryUpdatedAt !== undefined ? { memoryUpdatedAt: summary.memoryUpdatedAt } : {}),
    lanes: summary.lanes.filter((lane) => lane.roomId && visibleRoomIds.has(lane.roomId)).map((lane) => ({
      laneId: lane.laneId,
      roomLabel: roomLabel(lane.roomId, lane.laneId),
      pendingItemCount: lane.pendingItemCount,
      active: lane.active,
    })),
  };
};

const codingTeamActivityHtml = (): string => `<details class="coding-team-activity" data-coding-island="team-activity" data-details-key="team-activity" hidden>
  <summary data-focus-key="team-activity"><span><strong>Team activity</strong><small data-coding-activity-summary>Live task handoffs</small></span><b data-coding-activity-count>0</b><i aria-hidden="true">⌄</i></summary>
  <ol data-realtime-timeline aria-label="Team activity log"></ol>
</details>`;

const codingSocialParticipant = (node: WorkspaceNode): CodingSocialParticipant => {
  const visual = codingAgentVisual(node);
  const human = node.metadata?.participantKind === "human" || node.id === CODING_HUMAN_NODE_ID;
  const system = node.metadata?.participantKind === "system" || node.id === "coordinator";
  const displayName = human ? "You" : system ? "Roster" : visual.name;
  return {
    nodeId: node.id,
    displayName,
    role: human ? "Workspace participant" : system ? "System Facilitator" : visual.role,
    avatarLabel: displayName.slice(0, 1).toUpperCase(),
    human,
  };
};

const codingSocialProjection = (options: CodingConversationOptions): ReadonlyArray<CodingSocialRow> => {
  const nodes = new Map([
    codingHumanWorkspaceNode(),
    codingCoordinatorWorkspaceNode(),
    ...(options.workspaceProfile?.nodes ?? []),
    ...Object.values(options.state.nodes),
  ].map((node) => [node.id, node]));
  const participants = [...nodes.values()].map(codingSocialParticipant);
  const participantIdByLabel = new Map(participants.flatMap((participant) => [
    [participant.nodeId.toLocaleLowerCase(), participant.nodeId],
    [participant.displayName.toLocaleLowerCase(), participant.nodeId],
    [`@${participant.displayName.toLocaleLowerCase()}`, participant.nodeId],
  ]));
  const resolveParticipantId = (value: string): string | undefined =>
    participantIdByLabel.get(value.trim().toLocaleLowerCase());
  const authored = codingConversationFromEvents(options.events);
  const sourceByArtifactId = new Map(options.events.flatMap((event, index) =>
    event.type === "artifact.published" ? [[event.artifactId, { event, index }]] : []));
  const messagesById = new Map(authored.messages.map((message) => [message.messageId, message]));
  const messages: CodingSocialMessageInput[] = authored.messages.map((message) => {
    const source = sourceByArtifactId.get(message.messageId);
    const replyTarget = message.replyTo ? messagesById.get(message.replyTo) : undefined;
    const recipientNodeIds = (message.mentions.length > 0
      ? message.mentions
      : replyTarget ? [replyTarget.author.id] : [])
      .flatMap((recipient) => resolveParticipantId(recipient) ?? []);
    return {
      sourceId: message.messageId,
      sourceSequence: String((source?.index ?? authored.messages.indexOf(message)) + 1),
      at: new Date(message.createdAt).toISOString(),
      authorNodeId: resolveParticipantId(message.author.id) ?? message.author.id,
      recipientNodeIds,
      body: message.text,
    };
  });
  const authoredReplyIds = new Set(authored.messages.flatMap((message) =>
    message.author.kind !== "user" && message.replyTo ? [message.replyTo] : []));
  for (const route of authored.routes) {
    if (authoredReplyIds.has(route.inReplyTo)
      || !["informational", "operational", "needs_clarification", "declined"].includes(route.disposition)) continue;
    const source = sourceByArtifactId.get(route.routeId);
    const body = route.disposition === "needs_clarification"
      ? route.questions.join("\n")
      : route.answer ?? "";
    if (!body.trim()) continue;
    messages.push({
      sourceId: route.routeId,
      sourceSequence: String((source?.index ?? options.events.length) + 1),
      at: new Date(route.createdAt).toISOString(),
      authorNodeId: "coordinator",
      recipientNodeIds: [CODING_HUMAN_NODE_ID],
      body,
    });
  }
  const tasks = codingGraphTasks(options.state).map((task) => ({
    taskId: task.taskId,
    nodeId: task.nodeId,
    state: task.status === "accepted" || task.status === "skipped"
      ? "accepted" as const
      : task.status === "failed" || task.status === "canceled"
        ? "failed" as const
        : task.status === "running" || task.status === "leased"
          ? "running" as const
          : "pending" as const,
  }));
  const edges = codingGraphTasks(options.state).flatMap((task) => task.dependencies.map((dependency) => ({
    taskId: task.taskId,
    prerequisiteTaskId: dependency.taskId,
  })));
  const acceptedSummaries: CodingSocialAcceptedSummaryInput[] = [];
  const finalTaskIds = new Set<string>();
  for (const [index, event] of options.events.entries()) {
    if (event.type !== "artifact.published"
      || event.origin !== "task"
      || !event.taskId
      || event.payload.storage !== "inline") continue;
    const task = codingGraphTask(options.state, event.taskId);
    if (task?.status !== "accepted") continue;
    const contribution = parseCodingContribution(event.payload.value);
    const authoredTurn = contribution
      ? undefined
      : parseCodingAuthoredArtifactTurn(event.payload.value, event.outputKey, task);
    const body = contribution?.value.summary ?? authoredTurn?.summary;
    if (!body) continue;
    if (authoredTurn?.kind === "final-result" || authoredTurn?.kind === "investigation-synthesis") {
      finalTaskIds.add(event.taskId);
    }
    acceptedSummaries.push({
      artifactId: event.artifactId,
      outputReference: event.artifactId,
      sourceSequence: String(index + 1),
      at: new Date(options.eventTimestamps?.[index] ?? options.state.artifacts[event.artifactId]?.updatedAt ?? index).toISOString(),
      taskId: event.taskId,
      authorNodeId: event.nodeId,
      body,
    });
  }
  for (const finalTaskId of finalTaskIds) {
    const deliveryTaskId = `social-delivery:${finalTaskId}`;
    tasks.push({ taskId: deliveryTaskId, nodeId: CODING_HUMAN_NODE_ID, state: "pending" });
    edges.push({ taskId: deliveryTaskId, prerequisiteTaskId: finalTaskId });
  }
  return projectCodingSocialRows({
    participants,
    messages,
    acceptedSummaries,
    tasks,
    edges,
    systemActivities: [],
    roomUpdates: options.roomUpdates ?? [],
  });
};

const codingSocialTime = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "—";
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
};

const codingSocialMessageImagesHtml = (
  sourceId: string,
  options: CodingConversationOptions,
): string => {
  const authored = codingConversationFromEvents(options.events);
  const message = authored.messages.find((candidate) => candidate.messageId === sourceId);
  if (!message?.attachments.length) return "";
  const images = new Map(authored.images.map((image) => [image.artifactId, image]));
  return `<div class="coding-message-images" data-slot="chat-image-gallery">${message.attachments.flatMap((attachment) => {
    const image = images.get(attachment.artifactId);
    return image ? [`<figure><img src="${esc(image.dataUrl)}" alt="${esc(`Attached image: ${image.name}`)}"${image.width ? ` width="${image.width}"` : ""}${image.height ? ` height="${image.height}"` : ""} loading="lazy"/><figcaption>${esc(image.name)}</figcaption></figure>`] : [];
  }).join("")}</div>`;
};

const codingSocialDeliveryHtml = (
  sourceId: string,
  options: CodingConversationOptions,
): string => {
  const authored = codingConversationFromEvents(options.events);
  const message = authored.messages.find((candidate) => candidate.messageId === sourceId);
  if (!message || message.author.kind !== "user" || !message.tags.includes("delivery:queued")) return "";
  const delivery = codingControlDeliveriesFromEvents(options.events).get(message.messageId);
  const terminalJob = Boolean(options.job && ["completed", "failed", "canceled"].includes(options.job.status));
  const recipientCompleted = codingGraphTask(options.state, delivery?.recipientTaskId)?.status === "accepted";
  const consumedByCurrentAttempt = delivery?.state === "consumed"
    && delivery.jobId === options.job?.id
    && delivery.jobAttempt === options.job?.attempt
    && !terminalJob;
  const state = delivery?.state === "consumed" && (recipientCompleted || consumedByCurrentAttempt)
    ? "consumed"
    : terminalJob ? "superseded" : "queued";
  const recipient = delivery?.recipientNodeId ? options.state.nodes[delivery.recipientNodeId] : undefined;
  const label = state === "consumed"
    ? `Read by ${recipient?.name ?? delivery?.recipientNodeId ?? "agent"}`
    : state === "queued"
      ? "Message queued for the next safe handoff"
      : "Run ended before this message was delivered";
  return `<small class="coding-message-delivery" data-delivery-state="${state}" role="status" aria-live="polite">${esc(label)}</small>`;
};

const codingSocialRowHtml = (
  row: CodingSocialRow,
  options: CodingConversationOptions,
): string => {
  const continuation = row.cluster === "continuation";
  const recipients = row.recipients.map((recipient) =>
    `<span class="coding-message-recipient">@${esc(recipient.displayName)}</span>`).join("");
  const live = row.state === "live";
  const liveStatus = row.settled ? "Settled" : row.intent === "question" ? "Waiting" : "Live";
  return `<li class="coding-social-item"><article class="coding-social-row${continuation ? " coding-social-row-continuation" : ""}" data-coding-social-row data-message-group="${row.cluster}" data-cluster-boundary="${String(Boolean(row.clusterBoundary))}" data-row-id="${esc(row.rowId)}" data-source-id="${esc(row.sourceId)}" data-source-kind="${esc(row.sourceKind)}" data-author-node-id="${esc(row.author.nodeId)}" data-recipient-node-ids="${esc(encodeURIComponent(JSON.stringify(row.recipients.map((recipient) => recipient.nodeId))))}" data-task-id="${esc(row.taskId ?? "")}"${row.updateId ? ` data-update-id="${esc(row.updateId)}"` : ""}${row.intent ? ` data-update-intent="${esc(row.intent)}" data-update-sequence="${esc(String(row.sequence ?? 0))}" data-update-settled="${esc(String(Boolean(row.settled)))}" data-room-connection="live"` : ""} data-durability="${esc(row.durability)}" data-state="${esc(row.state)}"${live ? " aria-live=\"polite\" aria-atomic=\"true\"" : ""} aria-label="${esc(`${row.author.displayName}${continuation ? " continued" : ""} message`)}">
    <div class="coding-message-avatar" aria-hidden="true">${continuation ? "" : esc(row.author.avatarLabel)}</div>
    <div class="coding-message-content">
      <header class="coding-message-meta"><strong${continuation ? " class=\"sr-only\"" : ""}>${esc(row.author.displayName)}</strong>${continuation ? "" : `<span class="coding-agent-role">${esc(row.author.role)}</span><time datetime="${esc(row.at)}">${esc(codingSocialTime(row.at))}</time>`}${live ? `<span class="coding-live-label">${row.settled ? "" : `<i class="coding-live-dot" aria-hidden="true"></i>`}${liveStatus}</span>` : ""}${recipients ? `<span class="coding-message-recipients">to ${recipients}</span>` : ""}</header>
      ${codingAuthoredMessageBodyHtml(row.body)}
      ${codingSocialMessageImagesHtml(row.sourceId, options)}
      ${codingSocialDeliveryHtml(row.sourceId, options)}
      <details class="coding-message-evidence" data-details-key="coding-social-${esc(row.rowId)}"><summary>Details</summary><div><dl><div><dt>Source</dt><dd>${esc(row.sourceKind)}</dd></div><div><dt>Durability</dt><dd>${esc(row.durability)}</dd></div><div><dt>State</dt><dd>${esc(live ? liveStatus : row.state)}</dd></div>${row.intent ? `<div><dt>Intent</dt><dd>${esc(row.intent)}</dd></div>` : ""}${row.taskId ? `<div><dt>Task</dt><dd>${esc(row.taskId)}</dd></div>` : ""}</dl></div></details>
    </div>
  </article></li>`;
};

const codingConversationHtml = (options: CodingConversationOptions): string => {
  const rows = codingSocialProjection(options);
  const roomName = codingRoomProjection({
    conversationId: options.runId ?? "repository",
    ...(options.job ?? options.conversationJob ? { job: options.job ?? options.conversationJob } : {}),
    nodes: [],
  }).title.replace(/^#/, "");
  const empty = rows.length === 0 ? `<li class="coding-room-empty" data-room-empty>
  <span class="coding-room-empty-mark" aria-hidden="true">R</span>
  <div><h3>Start in #${esc(roomName)}</h3><p>Ask the repository team a question or describe the outcome you want.</p>
  <div aria-label="Suggested prompts">
    <button type="button" data-room-suggestion="understand">Understand this repository</button>
    <button type="button" data-room-suggestion="plan">Plan a change</button>
    <button type="button" data-room-suggestion="fix">Fix a problem</button>
  </div></div>
</li>` : "";
  const humanAction = codingHumanActionProjection(options);
  const merge = options.runId && options.job && codingDeliveryState(options.job) === "ready"
    ? `<form class="coding-run-merge-action" action="/coding/runs/${encodeURIComponent(options.runId)}/integrate" method="post"><input type="hidden" name="jobId" value="${esc(options.job.id)}"/><button type="submit">Merge into ${esc(options.job.baselineBranch ?? "target branch")}</button><small>Fast-forwards the exact certified commit. Nothing is pushed.</small></form>`
    : "";
  const close = options.runId && options.job?.commit && options.job.integration
    && !options.job.integration.integrated && !options.job.deliveryDisposition
    ? `<form class="coding-run-close-action" action="/coding/runs/${encodeURIComponent(options.runId)}/close" method="post"><input type="hidden" name="jobId" value="${esc(options.job.id)}"/><button type="submit">Close &amp; keep branch</button><small>Removes this from Needs attention. Nothing is merged or deleted.</small></form>`
    : "";
  const deliveryActions = merge || close
    ? `<li class="coding-room-delivery" id="coding-run-status" aria-label="Delivery actions"><div class="coding-run-delivery-actions">${merge}${close}</div></li>`
    : "";
  const retry = codingRunProgress(options)?.state === "failed" && !codingHasCertifiedDelivery(options.job)
    ? `<li class="coding-room-delivery" id="coding-run-status" aria-label="Recovery actions">${codingRetryFormHtml(options, true)}</li>`
    : "";
  return `<ol class="coding-thread coding-timeline" id="coding-conversation-feed" data-coding-room-transcript data-coding-island="conversation-feed" data-slot="timeline-list" aria-label="Room conversation">
    ${empty}
    ${rows.map((row) => codingSocialRowHtml(row, options)).join("")}
    ${codingInlineReplyHtml(humanAction, options)}
    ${deliveryActions || retry}
  </ol>`;
};

const overallStatus = (state: OrchestrationState, job?: CodingDemoJob): {
  readonly tone: "idle" | "active" | "success" | "failed";
  readonly label: string;
} => {
  const graphComplete = codingGraphComplete(state);
  const graphFailed = Boolean(codingGraphFailure(state));
  const terminal = codingTerminalOutcome({
    graphComplete,
    graphFailed,
    certified: graphComplete || Boolean(codingCommittedUsageNote(state, job)) || codingHasCertifiedDelivery(job),
    readOnlyComplete: codingReadOnlyOutcomeComplete(state, job),
    job,
    now: Date.now(),
  });
  if (terminal) {
    const label = terminal.label === "Team updated" || terminal.label === "Completed"
      ? "Complete"
      : terminal.label;
    const tone = terminal.state === "completed"
      ? "success"
      : terminal.state === "failed"
        ? "failed"
        : terminal.state === "working"
          ? "active"
          : "idle";
    return { tone, label };
  }
  if (job && ["queued", "leased", "running"].includes(job.status)) return { tone: "active", label: "Working" };
  return { tone: "idle", label: "Ready" };
};

const runDetailsHtml = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly eventTimestamps?: ReadonlyArray<number>;
  readonly runId?: string;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
  readonly workspaceId?: string;
}): string => {
  const outputs = orchestrationOutputValues(options.state);
  const tasks = codingGraphTasks(options.state)
    .filter(isCodingUserVisibleTask)
    .map((task) => ({
      taskId: task.taskId,
      nodeId: task.nodeId,
      capability: task.capability,
      status: codingGraphDisplayStatus(task),
      outcome: codingTaskVisibleOutcome(options.state, task),
    }));
  const collaboration = codingCollaborationStatus({
    outputs,
    taskStatuses: codingGraphTaskStatuses(options.state),
    peerCount: Object.values(options.state.nodes).filter((node) => node.id !== "coordinator").length,
    certified: codingGraphComplete(options.state),
  });
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const progress = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0;
  const latestDisposition = codingConversationFromEvents(options.events).routes.at(-1)?.disposition;
  const humanAction = codingHumanActionProjection(options);
  const awaitingAnswer = humanAction.kind === "ambiguity" || humanAction.kind === "clarification";
  const informational = latestDisposition === "informational" && !options.job;
  const status = informational
    ? { tone: "idle" as const, label: "No execution needed" }
    : awaitingAnswer
    ? { tone: "idle" as const, label: "Needs your answer" }
    : humanAction.kind === "recovery"
    ? { tone: "failed" as const, label: "Needs attention" }
    : humanAction.kind === "continuation"
    ? ["queued", "leased", "running"].includes(humanAction.status)
      ? { tone: "active" as const, label: "Continuation active" }
      : humanAction.status === "completed"
        ? { tone: "success" as const, label: "Continuation complete" }
        : { tone: "failed" as const, label: "Continuation stopped" }
    : overallStatus(options.state, options.job);
  const report = outputs.workspace_rescan_result ?? outputs.final_report ?? outputs.review_report ?? outputs.implementation_report;
  const runProgress = codingRunProgress(options);
  const managementRun = options.job?.runKind === "workspace-rescan";
  const specialistOutcomes = managementRun ? workspaceRescanOutcomeMap(outputs) : new Map<string, string>();
  const taskRows = tasks.length
    ? tasks.map((task) => {
      const node = options.state.nodes[task.nodeId];
      const taskState = task.status;
      const agent = node ? codingAgentVisual(node) : undefined;
      const agentLabel = agent ? `${agent.name} · ${agent.role}` : task.nodeId;
      const outcome = managementRun && task.nodeId !== "coordinator"
        ? specialistOutcomes.get(task.nodeId)
        : undefined;
      const visibleState = outcome ?? taskState;
      return `<li><span data-state="${esc(visibleState)}"></span><strong>${esc(titleCase(task.taskId))}</strong><small>${esc(agentLabel)} · ${esc(titleCase(visibleState))}</small><p data-coding-task-outcome><b>Outcome</b>${esc(task.outcome)}</p></li>`;
    }).join("")
    : `<li class="coding-details-empty">${informational ? "Conversation answer · no branch or worker created." : "No execution has started."}</li>`;
  const receiptEntries = options.events
    .map((event, index) => ({ event, index, at: options.eventTimestamps?.[index] }))
    .filter(({ event }) => !isCodingRoomReactionEvent(event))
    .reverse();
  const eventRows = receiptEntries.map(({ event, index, at }) =>
    `<li><strong>#${index + 1} · ${esc(event.type)}</strong><span>${esc(truncate(activityDescription(event), 300))}${typeof at === "number" ? ` · ${esc(new Date(at).toISOString())}` : ""}</span></li>`).join("");
  return `<section class="coding-run-details" data-state="${awaitingAnswer ? "awaiting-answer" : status.tone}" aria-labelledby="coding-run-details-title">
    <header><span><i data-state="${status.tone}" aria-hidden="true"></i><strong id="coding-run-details-title">${informational ? "Conversation" : "Run"}</strong></span><small>${esc(status.label)}</small></header>
    <div class="coding-run-details-body">
      ${options.runId ? `<p class="coding-run-id"><span>Conversation</span><code>${esc(options.runId)}</code></p>` : ""}
      ${informational || managementRun ? "" : `<div class="coding-collaboration-frontier" data-state="${esc(collaboration.phase)}"><span><i aria-hidden="true"></i><strong>${esc(titleCase(collaboration.phase))}</strong></span><small>${collaboration.peerCount} peers · <span data-coding-proposal-count>${collaboration.proposalCount}</span> proposals · <span data-coding-response-count>${collaboration.responseCount}</span> responses · <span data-coding-endorsement-count>${collaboration.endorsementCount}</span> endorsements · ${collaboration.conflictCount} conflicts</small>${collaboration.summary ? `<p title="${esc(collaboration.summary)}">${esc(truncate(collaboration.summary, 180))}</p>` : ""}<code title="SpacetimeDB topology frontier">${esc(options.state.topologyId?.slice(0, 16) ?? "topology pending")}</code></div>`}
      ${options.state.taskGraph ? `<section class="coding-dynamic-graph" aria-label="Dynamic execution graph"><header><strong>Dynamic DAG</strong><span>${options.state.taskGraph.expansions.length} expansions</span></header><dl><div><dt>Materialized</dt><dd>${options.state.taskGraph.tasks.length} durable tasks</dd></div><div><dt>Accepted</dt><dd>${options.state.taskGraph.tasks.filter((task) => task.status === "accepted").length}</dd></div><div><dt>Active</dt><dd>${options.state.taskGraph.tasks.filter((task) => task.status === "running" || task.status === "leased").length}</dd></div><div><dt>Worker plane</dt><dd>2 RLM functions · ${options.state.functionActivities.length} content-free activity receipts</dd></div></dl>${options.state.functionActivities.at(-1) ? `<p>Latest worker activity · ${esc(options.state.functionActivities.at(-1)!.operation)}${options.state.functionActivities.at(-1)!.pipelineId ? ` · ${esc(options.state.functionActivities.at(-1)!.pipelineId!)}` : ""}</p>` : ""}<code>${esc(options.state.taskGraph.projectionVersion.slice(0, 24))}</code></section>` : ""}
      ${codingHumanActionHtml(humanAction, { runId: options.runId, workspaceId: options.workspaceId, job: options.job })}
      ${runProgress ? `<section class="coding-work-status" data-state="${esc(runProgress.state)}"><header><strong>Current status</strong><span>${esc(runProgress.label)}</span></header><p>${esc(runProgress.message)}</p><dl><div><dt>Latest milestone</dt><dd>${esc(runProgress.latestUpdate)}</dd></div><div><dt>Runtime detail</dt><dd>${esc(runProgress.activity)}</dd></div></dl></section>` : ""}
      ${informational ? "" : `<div class="coding-progress-copy"><span>${managementRun ? "Team rescan progress" : "Coding run progress"}</span><strong>${completedTasks} / ${tasks.length} tasks</strong></div>
      <progress class="coding-progress" aria-label="${managementRun ? "Team rescan progress" : "Coding run progress"}" value="${progress}" max="100">${progress}%</progress>`}
      <ol class="coding-task-list">${taskRows}</ol>
      <details class="coding-receipts" data-details-key="run-receipts"><summary data-focus-key="run-receipts">Report and receipts · ${receiptEntries.length}</summary><div><pre>${esc(report ? "Accepted report recorded. Public summaries appear in the conversation." : "No accepted report summary yet.")}</pre><ol>${eventRows || "<li><span>No receipts yet.</span></li>"}</ol></div></details>
    </div>
  </section>`;
};

const resultSummaryHtml = (
  result: CodingDisplayResult | undefined,
  runTone: "idle" | "active" | "success" | "failed",
  job: CodingDemoJob | undefined,
  runId?: string,
  investigationDomain = false,
  finalizedInvestigation = false,
): string => {
  if (!result) return "";
  const failed = runTone === "failed";
  const investigation = job?.runKind === "investigation" || investigationDomain;
  if (investigation && !failed && finalizedInvestigation) {
    const reportUrl = runId
      ? `/coding/runs/${encodeURIComponent(runId)}/report.md${job ? `?job=${encodeURIComponent(job.id)}` : ""}`
      : undefined;
    const findings = result.findings?.map((finding) => `<li><strong>${esc(finding.claim)}</strong>${finding.evidence.length > 0 ? `<ul>${finding.evidence.map((evidence) => `<li>${esc(evidence)}</li>`).join("")}</ul>` : ""}</li>`).join("") ?? "";
    return `<article class="coding-result coding-final-report" id="coding-final-report" data-conversation-kind="artifact-card" data-state="${runTone}" aria-labelledby="coding-final-report-title">
      <span class="coding-result-mark" aria-hidden="true">✓</span><div><header><strong id="coding-final-report-title">Repository investigation report</strong><span>Final outcome</span></header>
      <section><h3>Executive summary</h3><p>${esc(result.summary ?? "The team returned an evidence-backed repository report.")}</p></section>
      ${result.answer ? `<section><h3>Final answer</h3>${codingAuthoredMessageBodyHtml(result.answer)}</section>` : ""}
      ${findings ? `<section><h3>Findings and evidence</h3><ol class="coding-report-findings">${findings}</ol></section>` : ""}
      ${result.files?.length ? `<section><h3>Relevant files</h3><ul class="coding-report-files">${result.files.map((file) => `<li><code>${esc(file)}</code></li>`).join("")}</ul></section>` : ""}
      ${result.limitations?.length ? `<section><h3>Limitations</h3><ul>${result.limitations.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>` : ""}
      ${result.specialistReports?.length ? `<details data-details-key="result-specialists"><summary data-focus-key="result-specialists">Specialist reports consulted</summary><ul>${result.specialistReports.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></details>` : ""}
      ${reportUrl ? `<a class="coding-report-download" href="${esc(reportUrl)}" download>Download Markdown report</a>` : ""}
      </div>
    </article>`;
  }
  return `<section class="coding-result" data-conversation-kind="artifact-card" data-state="${runTone}" aria-label="Coding run result">
    <span class="coding-result-mark" aria-hidden="true">${failed ? "!" : "✓"}</span><div><header><strong>${failed ? investigation ? "Investigation stopped" : "Not certified" : esc(result.status ? titleCase(result.status) : "Completed")}</strong><span>${failed ? investigation ? "Investigation output" : "Implementation output" : investigation ? "Investigation" : "Result"}</span></header><p>${esc(result.summary ?? (investigation ? "The team returned an evidence-backed repository report." : "The team returned a verified final report."))}</p>
    ${result.answer ? codingAuthoredMessageBodyHtml(result.answer) : ""}
    ${failed ? `<p class="coding-result-warning">The run ended without an accepted certified frontier. Some work may be saved, but it has not been accepted as a finished change.</p>` : job?.noChanges ? `<p class="coding-result-branch">No repository changes were required. There is no commit or branch handoff to integrate.</p>` : job?.branch ? `<p class="coding-result-branch">Committed to <code>${esc(job.branch)}</code>. ${job.integration?.integrated ? "The temporary run branch was cleaned up after integration." : job.deliveryDisposition ? "The room is closed and the certified branch is being kept for later." : "The certified commit is unchanged until you integrate it."}</p>` : ""}
    </div>
  </section>`;
};

const codingGitHandoffHtml = (options: {
  readonly repository?: CodingRepositoryGitState;
  readonly runId?: string;
  readonly job?: CodingDemoJob;
}): string => {
  const { repository, job, runId } = options;
  if (job?.readOnly) return "";
  const complete = job?.status === "completed" && Boolean(job.commit);
  const state = job?.noChanges
    ? "no-changes"
    : job?.integration?.integrated
    ? "integrated"
    : job?.deliveryDisposition?.action === "keep-branch"
      ? "kept-branch"
    : job?.integration?.canIntegrate
      ? "ready"
      : complete && job?.integration?.reason
        ? "blocked"
        : job && ["queued", "leased", "running"].includes(job.status)
          ? "working"
          : "local";
  const label = state === "no-changes"
    ? "No changes"
    : state === "integrated"
    ? "Integrated"
    : state === "kept-branch"
      ? "Closed · branch kept"
    : state === "ready"
      ? "Ready"
      : state === "blocked"
        ? "Needs attention"
        : state === "working"
          ? "Run active"
          : "Local workspace";
  const workingTree = repository?.workingTree === "dirty"
    ? `${repository.changedFiles} changed file${repository.changedFiles === 1 ? "" : "s"}`
    : repository?.workingTree === "clean" ? "Clean" : "Unknown";
  const remote = repository?.remote === "No origin configured" ? repository.remote : truncate(repository?.remote ?? "Unknown", 46);
  const targetBranch = job?.baselineBranch ?? repository?.branch ?? "current branch";
  const reviewUrl = runId && !job?.noChanges
    ? `/coding/runs/${encodeURIComponent(runId)}/review${job ? `?job=${encodeURIComponent(job.id)}` : ""}`
    : undefined;
  const exportUrl = runId && job && ["completed", "failed", "canceled"].includes(job.status)
    ? `/coding/runs/${encodeURIComponent(runId)}/collaboration.md?job=${encodeURIComponent(job.id)}`
    : undefined;
  const divergence = repository?.upstream
    ? `${repository.ahead ?? 0} ahead · ${repository.behind ?? 0} behind`
    : "No upstream tracking branch";
  return `<section class="coding-git-handoff" data-coding-island="git-handoff" data-slot="git-handoff" data-state="${state}" aria-labelledby="coding-git-handoff-title">
    <header><span><i aria-hidden="true"></i><strong id="coding-git-handoff-title">Git handoff</strong></span><small>${esc(label)}</small></header>
    <div class="coding-git-handoff-body">
      <dl>
        <div><dt>Repository</dt><dd title="${esc(repository?.path ?? "Repository unavailable")}"><strong>${esc(repositoryName(repository?.path ?? "Repository"))}</strong><small>${esc(workingTree)}</small></dd></div>
        <div><dt>Current</dt><dd><code translate="no">${esc(repository?.branch ?? "Unknown")}</code><small>${esc(repository?.headCommit?.slice(0, 12) ?? "No commit")}</small></dd></div>
        ${job?.branch && !job.noChanges ? `<div><dt>Run branch</dt><dd><code translate="no">${esc(job.branch)}</code><small>${job.commit ? esc(job.commit.slice(0, 12)) : "Awaiting certification"}</small></dd></div>` : ""}
        ${job?.baselineBranch ? `<div><dt>Target</dt><dd><code translate="no">${esc(job.baselineBranch)}</code><small>${esc(job.baselineCommit?.slice(0, 12) ?? "Recorded baseline")}${job.sourceCheckoutDirty ? " · local edits excluded" : ""}</small></dd></div>` : ""}
        ${job?.improvement ? `<div><dt>Improvement</dt><dd><code translate="no">${esc(job.improvement.snapshotHash.slice(0, 12))}</code><small>Admission-pinned · ${esc(job.improvement.generationId.slice(0, 18))}</small></dd></div>` : ""}
        <div><dt>Origin</dt><dd title="${esc(repository?.remote ?? "Unknown")}"><span>${esc(remote)}</span><small>${esc(divergence)}</small></dd></div>
      </dl>
      ${job?.integration?.reason && state === "blocked" ? `<p class="coding-git-handoff-note" role="status">${esc(codingPublicFailureReason({ certified: true }))}</p>` : ""}
      ${state === "no-changes" ? `<p class="coding-git-handoff-note" role="status">The certified execution produced no Git delta. Nothing needs integration.</p>` : ""}
      ${state === "kept-branch" ? `<p class="coding-git-handoff-note" role="status">This room is closed without merging. The exact certified commit remains on <code>${esc(job?.deliveryDisposition?.branch ?? job?.branch ?? "the run branch")}</code>.</p>` : ""}
      <div class="coding-git-actions">
        ${reviewUrl ? `<a class="coding-review-action" data-focus-key="git-review" href="${esc(reviewUrl)}"><span>Review changes</span><span aria-hidden="true">↗</span></a>` : ""}
        ${exportUrl ? `<a class="coding-export-action" data-focus-key="git-export" href="${esc(exportUrl)}">Export record</a>` : ""}
        ${state === "ready" && runId && job ? `<form action="/coding/runs/${encodeURIComponent(runId)}/integrate" method="post"><input type="hidden" name="jobId" value="${esc(job.id)}"/><button type="submit" data-focus-key="git-integrate">Merge certified code into ${esc(targetBranch)}</button></form>` : ""}
        ${runId && job?.commit && job.integration && !job.integration.integrated && !job.deliveryDisposition ? `<form class="coding-git-close-action" action="/coding/runs/${encodeURIComponent(runId)}/close" method="post"><input type="hidden" name="jobId" value="${esc(job.id)}"/><button type="submit" data-focus-key="git-close">Close &amp; keep branch</button></form>` : ""}
        ${state === "integrated" ? `<span>Fast-forward complete</span>` : ""}
        ${state === "no-changes" ? `<span>Nothing to integrate</span>` : ""}
        ${state === "kept-branch" ? `<span>Certified branch kept</span>` : ""}
      </div>
      <details class="coding-git-policy" data-details-key="git-delivery-rules"><summary data-focus-key="git-delivery-rules">Delivery rules</summary><div><p><strong>Merge certified code</strong> is an explicit local fast-forward of the exact certified commit. If the target moved or has local changes, Roster blocks the action.</p><p><strong>Remote publishing</strong> stays manual. Roster never force-pushes, rebases, creates merge commits, or pushes <code>${esc(targetBranch)}</code>. After integration, it removes only the exact temporary run branch.</p><p>Each connected repository keeps an independent team, run history, branch frontier, origin, and integration state.</p></div></details>
    </div>
  </section>`;
};

type CodingRunPanelOptions = {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly eventTimestamps?: ReadonlyArray<number>;
  readonly runId?: string;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
  readonly workspaceProfile?: CodingWorkspaceProfile;
  readonly runtimeLogs?: ReadonlyArray<StoredNodeRuntimeLog>;
  readonly roomUpdates?: ReadonlyArray<NodeRoomUpdate>;
  readonly repository?: CodingRepositoryGitState;
  readonly workspaceId?: string;
  readonly chatModel?: string;
  /** The full shell renders Context & Cast as a sibling rail outside the conversation scroller. */
  readonly detachedContextCast?: boolean;
};

const codingTeamBriefHtml = (options: CodingRunPanelOptions): string => {
  const tasks = codingGraphTasks(options.state).filter((task) => task.capability !== "room");
  if (!options.job && tasks.length === 0) return "";

  const profileNodes = new Map((options.workspaceProfile?.nodes ?? []).map((node) => [node.id, node]));
  const nodeFor = (nodeId: string): WorkspaceNode | undefined =>
    options.state.nodes[nodeId] ?? profileNodes.get(nodeId);
  const team = [...new Set(tasks.map((task) => task.nodeId))].flatMap((nodeId) => {
    const node = nodeFor(nodeId);
    return node && node.id !== "coordinator" && node.metadata?.participantKind !== "human"
      ? [{
          node,
          task: codingCoordinationTask(tasks.filter((candidate) => candidate.nodeId === nodeId)),
        }]
      : [];
  });
  const status = overallStatus(options.state, options.job);
  const progress = codingRunProgress(options);
  const tone = progress?.state === "waiting"
    ? "waiting"
    : progress?.state === "working" || status.tone === "active"
    ? "working"
    : progress?.state === "failed" || status.tone === "failed"
      ? "blocked"
      : progress?.state === "completed" || status.tone === "success" || codingDeliveryState(options.job) === "ready"
        ? "done"
        : "waiting";
  const publicRunTitle = options.job?.runKind === "investigation"
    ? "Repository investigation"
    : options.job?.runKind === "workspace-rescan"
      ? "Team profile refresh"
      : "Repository collaboration";
  const states = team.map(({ task }) => task ? codingCoordinationTaskState(task) : "waiting" as const);
  const doneCount = states.filter((state) => state === "done").length;
  const blockedCount = states.filter((state) => state === "blocked").length;
  const activeTaskCount = tasks.filter((task) => task.status === "running" || task.status === "leased").length;
  const readyTaskCount = tasks.filter((task) => task.status === "ready").length;
  const taskStages = codingCoordinationTaskStages(tasks);
  const stageCounts = new Map<number, number>();
  for (const task of tasks) {
    const stage = taskStages.get(task.taskId) ?? 0;
    stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
  }
  const parallelCount = Math.max(0, ...stageCounts.values());
  const hasDependencies = tasks.some((task) => task.dependencies.length > 0);
  const attention = codingAttentionDetail(options.state, options.job);
  const handoff = blockedCount > 0
    ? `${attention ? `${attention.headline} ${attention.explanation}` : "A specialist needs attention."} Roster preserved every accepted contribution.`
    : status.tone === "failed" && attention
      ? `${attention.headline} ${attention.explanation} Roster preserved every accepted contribution.`
    : team.length > 0 && doneCount === team.length
      ? "Every assigned contribution is accepted and attached to this run."
      : activeTaskCount > 1
        ? `${activeTaskCount} steps are running independently in parallel.`
        : activeTaskCount === 1
          ? "One step is running now."
          : readyTaskCount > 1
            ? `${readyTaskCount} steps are queued and waiting for runtime capacity.`
            : readyTaskCount === 1
              ? "One step is queued and waiting for runtime capacity."
        : hasDependencies
          ? "Accepted handoffs unlock the next specialist without sharing private task context."
          : parallelCount > 1
            ? `${parallelCount} specialists can start in parallel.`
            : team.length > 0
              ? "Each specialist owns one bounded contribution to the shared result."
              : "Roster is selecting the smallest useful specialist team.";
  const cast = team.map(({ node, task }) => {
    const visual = codingAgentVisual(node);
    const state = task ? codingCoordinationTaskState(task) : "waiting";
    const detailId = codingAgentDetailId(node.id);
    const stateLabel = state === "done" ? "Accepted" : state === "blocked" ? "Attention" : titleCase(state);
    return `<a href="#${esc(detailId)}" data-coding-coordination-agent="${esc(detailId)}" data-state="${state}" role="listitem" aria-label="Open ${esc(visual.name)}, ${esc(visual.role)} — ${esc(stateLabel)}">${codingAgentSymbolHtml(visual, "coding-team-brief-avatar")}<span><strong>${esc(visual.name)}</strong><small>${esc(visual.role)}</small></span><em>${esc(stateLabel)}</em></a>`;
  }).join("");
  const reviewUrl = options.runId && options.job && options.job.status === "completed" && !options.job.noChanges
    ? `/coding/runs/${encodeURIComponent(options.runId)}/review?job=${encodeURIComponent(options.job.id)}`
    : undefined;
  const primaryAction = codingDeliveryState(options.job) === "ready" && reviewUrl
    ? `<a class="coding-mission-action coding-mission-action-primary" href="${esc(reviewUrl)}">Review Changes <span aria-hidden="true">→</span></a>`
    : status.tone === "failed"
      ? `<a class="coding-mission-action coding-mission-action-primary" href="#coding-run-status">Review Blocker <span aria-hidden="true">↓</span></a>`
      : `<button class="coding-mission-action coding-mission-action-primary" type="button" data-coding-open-work data-workbench-target="work" aria-controls="coding-context-cast">Open Work <span aria-hidden="true">→</span></button>`;
  const progressLabel = tasks.length > 0
    ? `${doneCount} of ${team.length} contributions accepted`
    : "Assembling team";
  const branch = options.job?.branch ?? options.repository?.branch;

  return `<section class="coding-mission-bar" data-coding-team-brief data-run-presentation data-state="${tone}" aria-labelledby="coding-mission-title">
    <div class="coding-mission-copy">
      <span class="coding-mission-state"><i aria-hidden="true"></i><span data-run-presentation-label>${esc(progress?.label ?? status.label)}</span></span>
      <h3 id="coding-mission-title">${publicRunTitle}</h3>
      <span class="coding-mission-meta"><span data-run-presentation-progress>${esc(progressLabel)}</span>${branch ? `<span aria-hidden="true">·</span><code translate="no">${esc(branch)}</code>` : ""}</span>
    </div>
    <div class="coding-mission-cast" data-coding-team-brief-cast role="list" aria-label="Specialists selected for this run">${cast || `<span class="coding-team-brief-assembling" role="listitem"><i aria-hidden="true"></i> Selecting specialists…</span>`}</div>
    <div class="coding-mission-pulse" role="status" aria-live="polite" aria-atomic="true"><strong data-coding-team-brief-handoff>${esc(handoff)}</strong></div>
    <div class="coding-mission-actions">${primaryAction}<button class="coding-mission-action" type="button" data-coding-open-work data-workbench-target="${codingDeliveryState(options.job) === "ready" ? "files" : "team"}" aria-controls="coding-context-cast">${codingDeliveryState(options.job) === "ready" ? "Delivery" : "Team"}</button></div>
  </section>`;
};

const codingContextCastHtml = (
  options: CodingRunPanelOptions,
  layout: "embedded" | "rail" = "embedded",
): string => {
  const status = overallStatus(options.state, options.job);
  const repositoryNameValue = repositoryName(options.repository?.path ?? "Repository");
  const frontierBranch = options.job?.branch ?? options.repository?.branch ?? "Awaiting run branch";
  const frontierCommit = options.job?.commit ?? options.repository?.headCommit ?? "No certified commit";
  const delivery = codingRunDeliveryState(options.state, options.job);
  const defaultTab = (delivery === "ready" || delivery === "blocked"
    ? "files"
    : codingGraphTasks(options.state).length > 0
      ? "work"
      : "team") as "work" | "files" | "team" | "details";
  const frontier = `<section class="coding-context-frontier" data-slot="context-frontier" data-state="${options.job?.commit ? "certified" : "working"}" aria-labelledby="coding-context-frontier-title">
      <header><strong id="coding-context-frontier-title">Repository</strong><span data-execution-summary data-run-presentation-label>${esc(status.label)}</span></header>
      <dl>
        <div><dt>Repository</dt><dd data-frontier-repository>${esc(repositoryNameValue)}</dd></div>
        <div><dt>Branch</dt><dd><code data-frontier-branch>${esc(frontierBranch)}</code></dd></div>
        <div><dt>Commit</dt><dd><code data-frontier-commit>${esc(frontierCommit.slice(0, 16))}</code></dd></div>
        <div><dt>Context</dt><dd><code data-frontier-context>${esc(options.state.topologyId?.slice(0, 16) ?? "pending")}</code></dd></div>
      </dl>
    </section>`;
  const operations = `<details class="coding-operations" data-coding-island="execution-details" data-details-key="coding-operations">
      <summary data-focus-key="coding-operations"><span><strong>Execution details</strong><small>Tasks, receipts, and certification</small></span><i aria-hidden="true">⌄</i></summary>
      <div>${runDetailsHtml(options)}</div>
    </details>`;
  const outputs = orchestrationOutputValues(options.state);
  const acceptedArtifacts = Object.values(options.state.outputs)
    .filter((binding) => binding.origin === "task")
    .sort((left, right) => right.updatedAt - left.updatedAt || left.outputKey.localeCompare(right.outputKey))
    .slice(0, 16);
  const artifacts = `<section class="coding-artifact-index" data-coding-artifact-index aria-labelledby="coding-artifact-index-title">
      <header><span><small>Accepted output</small><strong id="coding-artifact-index-title">Artifacts</strong></span><em>${acceptedArtifacts.length}</em></header>
      ${acceptedArtifacts.length > 0
        ? `<ol>${acceptedArtifacts.map((binding) => {
          const summary = codingTaskOutputSummary(binding.outputKey, outputs[binding.outputKey] ?? "");
          return `<li><span><strong>${esc(titleCase(binding.outputKey))}</strong><small>${esc(binding.taskId ? titleCase(binding.taskId) : "Accepted result")}</small></span>${summary ? `<p>${esc(summary)}</p>` : ""}<code title="${esc(binding.contentHash)}">${esc(binding.contentHash.slice(0, 12))}</code></li>`;
        }).join("")}</ol>`
        : `<p class="coding-workbench-empty">Accepted results will collect here as the team finishes work.</p>`}
    </section>`;
  return `<aside class="coding-inspector coding-context-cast" id="coding-context-cast" data-slot="context-cast" data-default-tab="${defaultTab}" aria-labelledby="coding-context-cast-title"${layout === "rail" ? " data-layout=\"rail\" hidden" : ""} data-workspace-region="context">
    <header class="coding-room-context-head"><span><strong id="coding-context-cast-title">Workbench</strong><small>Work, delivery, team, and details</small></span><button type="button" data-coding-context-close aria-label="Close Workbench" title="Close Workbench"><span aria-hidden="true">×</span></button></header>
    <nav class="coding-workbench-tabs" role="tablist" aria-label="Workbench views">
      <button class="coding-workbench-tab" type="button" id="coding-workbench-work-tab" role="tab" aria-selected="${defaultTab === "work"}" aria-controls="coding-workbench-work" aria-keyshortcuts="Alt+1" tabindex="${defaultTab === "work" ? "0" : "-1"}" data-coding-workbench-tab="work">Work</button>
      <button class="coding-workbench-tab" type="button" id="coding-workbench-files-tab" role="tab" aria-selected="${defaultTab === "files"}" aria-controls="coding-workbench-files" aria-keyshortcuts="Alt+2" tabindex="${defaultTab === "files" ? "0" : "-1"}" data-coding-workbench-tab="files">Files</button>
      <button class="coding-workbench-tab" type="button" id="coding-workbench-team-tab" role="tab" aria-selected="${defaultTab === "team"}" aria-controls="coding-workbench-team" aria-keyshortcuts="Alt+3" tabindex="${defaultTab === "team" ? "0" : "-1"}" data-coding-workbench-tab="team">Team</button>
      <button class="coding-workbench-tab" type="button" id="coding-workbench-details-tab" role="tab" aria-selected="${defaultTab === "details"}" aria-controls="coding-workbench-details" aria-keyshortcuts="Alt+4" tabindex="${defaultTab === "details" ? "0" : "-1"}" data-coding-workbench-tab="details">Details</button>
    </nav>
    <section class="coding-workbench-panel" id="coding-workbench-work" role="tabpanel" aria-labelledby="coding-workbench-work-tab" data-coding-workbench-panel="work" data-workbench-panel="work"${defaultTab === "work" ? "" : " hidden"}>${codingCoordinationDockHtml(options)}</section>
    <section class="coding-workbench-panel" id="coding-workbench-files" role="tabpanel" aria-labelledby="coding-workbench-files-tab" data-coding-workbench-panel="files" data-workbench-panel="files"${defaultTab === "files" ? "" : " hidden"}>${codingGitHandoffHtml(options)}${artifacts}</section>
    <section class="coding-workbench-panel" id="coding-workbench-team" role="tabpanel" aria-labelledby="coding-workbench-team-tab" data-coding-workbench-panel="team" data-workbench-panel="team"${defaultTab === "team" ? "" : " hidden"}>${liveRunHtml(options)}${codingTeamActivityHtml()}<ul class="coding-realtime-cast" data-realtime-cast data-slot="cast-list" aria-label="Room cast"></ul></section>
    <section class="coding-workbench-panel" id="coding-workbench-details" role="tabpanel" aria-labelledby="coding-workbench-details-tab" data-coding-workbench-panel="details" data-workbench-panel="details"${defaultTab === "details" ? "" : " hidden"}>${frontier}${operations}</section>
  </aside>`;
};

export const codingRunPanelHtml = (options: CodingRunPanelOptions): string => {
  const outputs = orchestrationOutputValues(options.state);
  const status = overallStatus(options.state, options.job);
  const progress = codingRunProgress(options);
  const finalizedInvestigation = codingInvestigationReportFinalized(options.state, options.job);
  const hasFinalSocialAnswer = codingSocialProjection(options).some((row) =>
    row.sourceKind === "accepted-summary" && row.taskId === "coding-finalize");
  const panelTone = progress?.state === "working" ? "active" : progress?.state === "completed" ? "success" : progress?.state === "failed" ? "failed" : status.tone;
  return `<section class="coding-run-panel" data-coding-run-panel data-state="${panelTone}" data-update-count="${options.events.length}" aria-busy="false">
    <div class="coding-run-main${options.detachedContextCast ? " coding-run-main-detached" : ""}">
      <div class="coding-error-island" data-coding-island="run-error"></div>
      ${codingRoomHtml(options)}
      ${codingTeamBriefHtml(options)}
      <section class="coding-room-timeline" data-slot="room-timeline" aria-labelledby="coding-timeline-title">
        <h3 class="sr-only" id="coding-timeline-title">Room conversation</h3>
        ${codingConversationHtml(options)}
        <div class="coding-result-island" data-coding-island="run-result">${hasFinalSocialAnswer ? "" : resultSummaryHtml(displayResult(outputs, finalizedInvestigation), status.tone, options.job, options.runId, options.state.domain?.id === "coding-investigation", finalizedInvestigation)}</div>
      </section>
      ${options.detachedContextCast ? "" : codingContextCastHtml(options)}
    </div>
  </section>`;
};

const onboardingHtml = (workspaceId?: string): string => `<section class="coding-onboarding" aria-labelledby="coding-onboarding-title">
  <span class="coding-onboarding-mark" aria-hidden="true">R</span>
  <p>Prepare the room</p>
  <h2 id="coding-onboarding-title">Assemble a roster for this repository</h2>
  <span>Roster maps the codebase read-only, then proposes named specialists with clear ownership, focused skills, and collaboration links. Review the team once; future change conversations reopen the same durable room.</span>
  <form action="/coding/workspace/scan" method="post" data-coding-workspace-scan aria-describedby="coding-workspace-scan-status">${workspaceId ? `<input type="hidden" name="workspaceId" value="${esc(workspaceId)}"/>` : ""}<button type="submit">Scan repository and assemble roster</button></form>
  <p class="coding-onboarding-status" id="coding-workspace-scan-status" role="status" aria-live="polite" aria-atomic="true" data-coding-workspace-scan-status></p>
  <small>Read-only structural discovery · source files stay untouched</small>
</section>`;

const codingCommandPaletteHtml = (options: {
  readonly runId?: string;
  readonly job?: CodingDemoJob;
  readonly buildFingerprint: string;
}): string => {
  const reviewUrl = options.runId && options.job?.status === "completed" && !options.job.noChanges
    ? `/coding/runs/${encodeURIComponent(options.runId)}/review?job=${encodeURIComponent(options.job.id)}`
    : undefined;
  return `<dialog class="coding-command-dialog" id="coding-command-dialog" data-coding-command-dialog aria-labelledby="coding-command-title">
    <form method="dialog" class="coding-command-surface">
      <header><span><strong id="coding-command-title">Command Palette</strong><small>Move through the workspace without leaving the keyboard</small></span><button type="submit" value="close" aria-label="Close Command Palette"><span aria-hidden="true">×</span></button></header>
      <label class="coding-command-search" for="coding-command-search"><span class="sr-only">Search commands</span><span aria-hidden="true">⌕</span><input id="coding-command-search" name="command" type="search" placeholder="Search commands…" autocomplete="off" spellcheck="false" data-coding-command-search/></label>
      <div class="coding-command-list" aria-label="Coding commands" data-coding-command-list>
        <button type="button" data-coding-command-action="focus-composer" data-command-keywords="prompt message ask chat"><span><strong>Focus Prompt</strong><small>Ask the team or give a new direction</small></span><kbd>/</kbd></button>
        <button type="button" data-coding-command-action="workbench-work" data-command-keywords="plan tasks progress work"><span><strong>Open Work</strong><small>See active tasks, dependencies, and receipts</small></span><kbd>⌥1</kbd></button>
        <button type="button" data-coding-command-action="workbench-files" data-command-keywords="files changes diff git branch merge delivery artifacts outputs evidence"><span><strong>Open Files</strong><small>Inspect delivery and accepted outputs</small></span><kbd>⌥2</kbd></button>
        <button type="button" data-coding-command-action="workbench-team" data-command-keywords="team nodes specialists people activity inbox"><span><strong>Open Team</strong><small>Inspect specialists and accepted contributions</small></span><kbd>⌥3</kbd></button>
        <button type="button" data-coding-command-action="workbench-details" data-command-keywords="details runtime receipts topology repository certification"><span><strong>Open Details</strong><small>Inspect repository and execution metadata</small></span><kbd>⌥4</kbd></button>
        ${reviewUrl ? `<a href="${esc(reviewUrl)}" data-command-keywords="review diff patch files certified"><span><strong>Review Certified Changes</strong><small>Open the exact stored patch</small></span><kbd>↗</kbd></a>` : ""}
      </div>
      <p data-coding-command-status role="status" aria-live="polite" aria-atomic="true"></p>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Run</span><span><kbd>Esc</kbd> Close</span><span class="coding-command-build">Build <code data-coding-build-short>${esc(options.buildFingerprint.slice(0, 12))}</code></span></footer>
    </form>
  </dialog>`;
};

const codingComposerPresenceHtml = (options: {
  readonly state: OrchestrationState;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
  readonly workspaceProfile?: CodingWorkspaceProfile;
  readonly workspaceWorkerRuntime?: CodingWorkspaceWorkerRuntime;
  readonly workspaceWorkerModel?: CodingWorkspaceWorkerModel;
  readonly composerDraft?: string;
}): string => {
  const activeTask = codingGraphTasks(options.state).find((task) =>
    task.status === "running" || task.status === "leased");
  const selectedNode = activeTask
    ? options.state.nodes[activeTask.nodeId]
      ?? options.workspaceProfile?.nodes.find((node) => node.id === activeTask.nodeId)
    : options.workspaceProfile?.nodes.find((node) =>
        node.metadata?.participantKind !== "human"
        && node.capabilities.some((capability) => /implement|code|build|mutate/iu.test(capability)))
      ?? options.workspaceProfile?.nodes.find((node) => node.metadata?.participantKind !== "human");
  const visual = selectedNode ? codingAgentVisual(selectedNode) : undefined;
  const identity = runtimeIdentity(
    selectedNode ? options.state.nodes[selectedNode.id] ?? selectedNode : undefined,
    selectedNode ? options.state.nodeBindings[selectedNode.id] : undefined,
  );
  const interactionJob = options.conversationJob ?? options.job;
  const active = Boolean(interactionJob && ["queued", "leased", "running"].includes(interactionJob.status));
  const runtime = identity.runtime
    ?? (interactionJob?.workerRuntime ? codingRuntimeLabel(interactionJob.workerRuntime) : undefined)
    ?? (options.workspaceWorkerRuntime ? codingRuntimeLabel(options.workspaceWorkerRuntime) : undefined);
  const model = identity.model
    ?? (interactionJob?.workerModel ? runtimeModelLabel(interactionJob.workerModel) : undefined)
    ?? (options.workspaceWorkerModel ? runtimeModelLabel(options.workspaceWorkerModel) : undefined);
  const state = activeTask
    ? "Working"
    : active
      ? "Starting"
      : interactionJob?.status === "failed"
        ? "Needs attention"
        : "Ready";
  const tone = state === "Working" || state === "Starting"
    ? "working"
    : state === "Needs attention"
      ? "blocked"
      : "ready";
  const execution = [runtime, model].filter((value): value is string => Boolean(value));
  return `<div class="coding-composer-presence" data-run-presence data-state="${tone}" role="status" aria-live="polite" aria-atomic="true"><span><i aria-hidden="true"></i><strong data-run-presence-name>${esc(visual?.name ?? "Team")}</strong><span data-run-presence-status>· ${esc(state)}</span></span>${execution.length ? `<span class="coding-composer-runtime">${execution.map((value, index) => `${index > 0 ? `<span aria-hidden="true">·</span>` : ""}<span>${esc(value)}</span>`).join("")}</span>` : ""}</div>`;
};

const composerHtml = (options: {
  readonly state: OrchestrationState;
  readonly runId?: string;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly workspaceId?: string;
  readonly workspaceProfile?: CodingWorkspaceProfile;
  readonly runtimeOptions?: ReadonlyArray<CodingWorkerRuntimeOption>;
  readonly chatModel?: string;
  readonly workspaceWorkerRuntime?: CodingWorkspaceWorkerRuntime;
  readonly workspaceWorkerModel?: CodingWorkspaceWorkerModel;
  readonly composerDraft?: string;
}): string => {
  const conversation = codingConversationFromEvents(options.events);
  const latestDisposition = conversation.routes.at(-1)?.disposition;
  const interactionJob = options.conversationJob ?? options.job;
  const active = Boolean(interactionJob && ["queued", "leased", "running"].includes(interactionJob.status));
  const humanAction = codingHumanActionProjection(options);
  const humanEscalation = humanAction.kind === "ambiguity";
  const awaitingAnswer = humanAction.kind === "clarification" || humanEscalation;
  const informational = latestDisposition === "informational" && !options.job;
  const mentionOptions = (options.workspaceProfile?.nodes ?? [])
    .filter((node) => node.metadata?.participantKind !== "human")
    .map((node) => {
      const visual = codingAgentVisual(node);
      const mention = `@${visual.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;
      const optionId = `coding-mention-${node.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;
      return `<button class="coding-mention-option" id="${esc(optionId)}" type="button" role="option" aria-selected="false" data-coding-mention="${esc(mention)}">${codingAgentSymbolHtml(visual)}<span><strong>${esc(visual.name)}</strong><small>${esc(visual.role)}</small></span></button>`;
    }).join("");
  const mentionMenu = mentionOptions ? `<details class="coding-mention-menu" data-coding-mention-menu><summary aria-label="Mention someone" aria-controls="coding-mention-options" aria-expanded="false" title="Mention someone">@</summary><div class="coding-mention-panel"><header><span><strong>Mention a Specialist or teammate</strong><small>Optional routing input · bring a repository peer into the room</small></span></header><div id="coding-mention-options" role="listbox" aria-label="Repository teammates">${mentionOptions}</div><p data-coding-mention-empty hidden>No teammates match that mention.</p><p>Mentions are social routing requests. Roster still validates the bounded work graph from skills and dependencies.</p></div></details>` : "";
  const mentionTextareaAttributes = mentionOptions
    ? ` aria-controls="coding-mention-options" aria-haspopup="listbox" aria-expanded="false"`
    : "";
  const imagePicker = `<label class="coding-image-picker" for="coding-image-input" title="Add images" aria-label="Add images"><span aria-hidden="true">＋</span><input id="coding-image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple data-coding-image-input/></label>`;
  const runtimeOptions = options.runtimeOptions ?? DEFAULT_CODING_WORKER_RUNTIME_OPTIONS;
  const reviewRuntimeLabel = runtimeOptions.some((runtime) => runtime.value === "codex-cli")
    ? "Codex Sol/high review"
    : runtimeOptions.some((runtime) => runtime.value === "claude-code")
      ? "Claude plan review"
      : "No review runtime detected";
  const chatModelLabel = runtimeModelLabel(options.chatModel?.trim() || DEFAULT_OPENAI_MODEL);
  const roomLabel = `#${(interactionJob?.branch ?? "repository-room")
    .replace(/^refs\/heads\//, "")
    .replace(/^agent\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "repository-room"}`;
  const placeholder = awaitingAnswer
    ? `Reply in ${roomLabel}…`
    : active
      ? "Add context while the team works…"
      : `Message ${roomLabel}…`;
  const controls = awaitingAnswer || active
    ? `<input type="hidden" name="reviewPolicy" value="${esc(interactionJob?.reviewPolicy ?? "auto")}"/><span class="coding-composer-context" data-state="${awaitingAnswer ? "answer" : "follow-up"}">${awaitingAnswer ? "Replying in the room" : "Message to the working team · delivered at the next safe handoff"}</span>`
    : `<div class="coding-composer-options" aria-label="Run settings">
      <span class="coding-composer-select"><label class="sr-only" for="coding-review-policy">Review mode</label><select id="coding-review-policy" name="reviewPolicy" data-ui-select aria-label="Review mode"><option value="auto" data-description="Roster chooses the safe validation scope" selected>Auto review</option><option value="fast" data-description="Only retained for narrow low-risk work">Fast pass</option><option value="reviewed" data-description="Independent peer review and certification">Full review</option></select></span>
    </div>`;
  const sendLabel = awaitingAnswer ? "Reply" : active ? "Send message" : "Send to team";
  return `<form class="coding-composer" action="/coding/run" method="post" data-slot="workspace-composer" data-composer-kind="workspace" data-coding-form data-coding-active="${active}" data-coding-composer-draft="${esc(options.runId ?? options.workspaceId ?? "repository")}">
  ${options.workspaceId ? `<input type="hidden" name="workspaceId" value="${esc(options.workspaceId)}"/>` : ""}
  ${options.runId ? `<input type="hidden" name="conversationId" value="${esc(options.runId)}"/>` : ""}
  <span class="sr-only">You are messaging ${esc(roomLabel)}</span>
  <div class="coding-image-previews" data-coding-image-previews data-state="empty" aria-label="Attached images" hidden></div>
  <p class="coding-image-status" id="coding-image-status" role="status" aria-live="polite" aria-atomic="true" data-coding-image-status></p>
  <label class="sr-only" for="coding-objective">Chat with your repository team</label>
  <textarea id="coding-objective" name="objective" maxlength="20000" rows="1" autocomplete="off" aria-describedby="coding-image-status"${mentionTextareaAttributes} placeholder="${esc(placeholder)}" data-slot="composer-input" data-coding-composer-input>${esc(options.composerDraft ?? "")}</textarea>
  <div class="coding-composer-footer" data-slot="composer-footer">
    <div class="coding-composer-tools" data-slot="composer-tools"><details class="coding-composer-advanced" data-composer-advanced data-details-key="composer-tools"><summary aria-label="Open composer tools" title="Attachments, mentions, and run settings"><span aria-hidden="true">＋</span><span>Tools</span></summary><div class="coding-composer-advanced-panel">${imagePicker}${mentionMenu}${controls}</div></details></div>
    <button type="submit" aria-label="${esc(sendLabel)}" data-slot="composer-submit"><span class="coding-submit-idle">${awaitingAnswer ? "Reply" : "↑"}</span></button>
  </div>
  <p class="coding-composer-help" data-slot="composer-help"><span>${awaitingAnswer ? humanEscalation ? "Your reply continues the same room." : "The team is waiting for your answer." : active ? "Saved in the room now; the working team receives it at the next safe boundary." : informational ? "The repository room stays open." : `Runs stay local until you merge · ${reviewRuntimeLabel}`} · Routing: ${esc(chatModelLabel)}</span><span>Enter to send · Shift+Enter for a new line · ⌘&nbsp;K commands</span></p>
  ${codingComposerPresenceHtml(options)}
</form>`;
};

const reviewStatusLabel = (status: string): string => {
  const normalized = status.trim();
  if (normalized === "A" || normalized === "??") return "Added";
  if (normalized === "D") return "Deleted";
  if (normalized === "R") return "Renamed";
  return "Modified";
};

const parseCodingReviewFiles = (diff: CodingReviewDiff): {
  readonly files: ReadonlyArray<CodingReviewFile>;
  readonly truncated: boolean;
} => {
  const declaredStatus = new Map(diff.files.map((file) => [file.path, file.status]));
  const files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    lines: CodingReviewLine[];
  }> = [];
  let current: (typeof files)[number] | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let lineCount = 0;
  let truncated = diff.truncated || diff.patch.truncated;

  for (const line of diff.patch.text.split("\n")) {
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileHeader) {
      const path = fileHeader[2] ?? fileHeader[1] ?? "Patch";
      current = {
        path,
        status: declaredStatus.get(path) ?? "M",
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(current);
      oldLine = undefined;
      newLine = undefined;
      continue;
    }
    if (!current) {
      if (!line) continue;
      const declared = diff.files[0];
      current = {
        path: declared?.path ?? "Patch",
        status: declared?.status ?? "M",
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(current);
    }
    if (lineCount >= MAX_REVIEW_LINES) {
      truncated = true;
      break;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ kind: "meta", text: line });
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push({ kind: "addition", ...(newLine !== undefined ? { newLine } : {}), text: line });
      current.additions += 1;
      if (newLine !== undefined) newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.lines.push({ kind: "deletion", ...(oldLine !== undefined ? { oldLine } : {}), text: line });
      current.deletions += 1;
      if (oldLine !== undefined) oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({
        kind: "context",
        ...(oldLine !== undefined ? { oldLine } : {}),
        ...(newLine !== undefined ? { newLine } : {}),
        text: line,
      });
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
    } else {
      current.lines.push({ kind: "meta", text: line });
    }
    lineCount += 1;
  }
  return { files, truncated };
};

type CodingReviewFiles = ReturnType<typeof parseCodingReviewFiles>;

const codingBrandThemeCss = `
.coding-page .agent-top-nav,.coding-review-page>.agent-top-nav{border-bottom-color:var(--border-subtle);background:color-mix(in srgb,var(--surface-sidebar) 94%,transparent);box-shadow:0 10px 34px rgba(0,0,0,.14)}
.coding-page .coding-project-rail,.coding-review-page .coding-review-file-rail{background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 3%,var(--surface-sidebar)),var(--surface-sidebar) 28%)}
.coding-page .coding-conversation{background:radial-gradient(circle at 18% 8%,color-mix(in srgb,var(--accent) 7%,transparent),transparent 30rem),radial-gradient(circle at 82% 72%,color-mix(in srgb,var(--accent) 4%,transparent),transparent 26rem),var(--surface-canvas)}
.coding-page .coding-room{background:color-mix(in srgb,var(--surface-canvas) 92%,transparent);box-shadow:0 12px 34px rgba(0,0,0,.08)}
.coding-page .coding-composer{border-color:color-mix(in srgb,var(--accent) 18%,var(--border-strong));background:color-mix(in srgb,var(--surface-raised) 94%,var(--accent));box-shadow:0 18px 54px rgba(0,0,0,.32)}
.coding-page .coding-composer:focus-within{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 13%,transparent),0 18px 54px rgba(0,0,0,.36)}
.coding-page .coding-room-tabs button[aria-selected="true"],.coding-review-page .coding-review-file-rail a:hover,.coding-review-page .coding-review-file-rail a:focus-visible{border-color:var(--accent)}
.coding-review-page{background:var(--surface-canvas)}
.coding-review-page .coding-review-toolbar,.coding-review-page .coding-review-file>header{background:color-mix(in srgb,var(--surface-panel) 96%,transparent)}
.coding-review-page .coding-review-file{background:var(--surface-inset)}
.coding-review-page .coding-review-diff-scroll{background:radial-gradient(circle at 80% 12%,color-mix(in srgb,var(--accent) 4%,transparent),transparent 32rem),var(--surface-inset)}
`;

const codingTypographyCss = `html body{font-family:var(--font-ui);font-synthesis:none;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.coding-page.coding-page{font-family:var(--font-ui);font-size:13px;line-height:1.5}.coding-page.coding-page code,.coding-page.coding-page pre{font-family:var(--font-mono)}
.coding-page .agent-top-nav{height:44px;min-height:44px;padding:5px 14px}.coding-page .coding-workbench{height:calc(100vh - 44px)}.coding-page .coding-empty-workspace{min-height:calc(100vh - 44px)}
.coding-page .coding-menu>summary{font-size:10px;font-weight:600}.coding-page .coding-project-identity strong{font-size:11px;font-weight:650}.coding-page .coding-project-section h2{font-size:9px;font-weight:650;letter-spacing:.065em}.coding-page .coding-project-section>header>span,.coding-page .coding-project-section>p{font-size:8px}.coding-page .coding-project-technologies li{font-family:var(--font-mono);font-size:8px}.coding-page .coding-project-runs strong,.coding-page .coding-project-team strong{font-size:9px;font-weight:600}.coding-page .coding-project-runs small,.coding-page .coding-project-team small{font-size:8px}
.coding-page .coding-message article header strong,.coding-page .coding-result header strong{font-size:11px;font-weight:650}.coding-page .coding-message article header span,.coding-page .coding-result header span{font-size:9px}.coding-page .coding-message article header .coding-runtime{font-family:var(--font-mono);font-size:8px;font-weight:500}.coding-page .coding-message article p,.coding-page .coding-result p{font-size:13px;line-height:1.6;text-wrap:pretty}.coding-page .coding-live-copy strong,.coding-page .coding-run-details>header strong{font-size:11px;font-weight:650}.coding-page .coding-live li strong,.coding-page .coding-task-list strong{font-size:10px;font-weight:600}.coding-page .coding-live li small,.coding-page .coding-task-list small{font-family:var(--font-mono);font-size:8px}.coding-page .coding-composer textarea{font-size:13px;line-height:1.55}
.coding-review-page.coding-review-page{font-family:var(--font-ui)}.coding-review-page.coding-review-page code,.coding-review-page.coding-review-page pre,.coding-review-page .coding-review-toolbar-meta{font-family:var(--font-mono);font-variant-numeric:tabular-nums}.coding-review-page .coding-review-title h1{font-size:12px;font-weight:650;line-height:1.15;letter-spacing:-.015em;text-wrap:balance}.coding-review-page .coding-review-details summary{font-weight:600}`;

const codingAgentDetailsCss = `.coding-page .coding-inspector>.coding-live{padding:18px 16px}
.coding-page .coding-live[data-agent-detail-open="true"]{min-height:100%;padding:0!important}.coding-page .coding-live[data-agent-detail-open="true"]>header,.coding-page .coding-live[data-agent-detail-open="true"]>.coding-run-team-label,.coding-page .coding-live[data-agent-detail-open="true"]>.coding-run-team-help,.coding-page .coding-live[data-agent-detail-open="true"]>ul{display:none}
.coding-page .coding-agent-detail:not([hidden]){min-height:calc(100vh - 44px);display:flex;flex-direction:column;gap:0;margin:0;padding:0;border:0;scroll-margin-top:0}.coding-page .coding-agent-detail-header{position:sticky;z-index:3;top:0;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px;border-bottom:1px solid var(--border-subtle);background:color-mix(in srgb,var(--surface-sidebar) 94%,transparent);backdrop-filter:blur(14px)}
.coding-page .coding-agent-detail-identity{min-width:0;display:grid;grid-template-columns:38px minmax(0,1fr);gap:12px;align-items:center}.coding-page .coding-agent-detail-avatar{width:38px;height:38px;border-radius:10px}.coding-page .coding-agent-detail-avatar svg{width:18px;height:18px}.coding-page .coding-agent-detail-identity>span{min-width:0}.coding-page .coding-agent-detail-identity small{display:block;margin:0 0 3px;color:var(--text-tertiary);font-size:8px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.coding-page .coding-agent-detail-identity h2{display:block;overflow:hidden;margin:0;color:var(--text-primary);font-size:15px;line-height:1.25;letter-spacing:-.015em;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-agent-detail-identity p{overflow:hidden;margin:4px 0 0;color:var(--text-secondary);font:9px/1.4 var(--font-mono);text-overflow:ellipsis;white-space:nowrap}
.coding-page .coding-agent-detail-header>button{min-height:32px;width:auto;display:inline-flex;align-items:center;gap:6px;flex:none;padding:0 10px;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-raised);cursor:pointer;font-size:9px;font-weight:650}.coding-page .coding-agent-detail-header>button:hover{color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-agent-detail-header>button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-page .coding-agent-detail-header>button>span:first-child{font-size:12px}
.coding-page .coding-agent-detail-card{margin:16px 18px 0;padding:0 15px 4px;border:1px solid var(--border-subtle);border-radius:var(--radius-card);background:var(--surface-panel)}.coding-page .coding-agent-detail-card>header{min-height:42px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-agent-detail-card>header h3{margin:0;color:var(--text-primary);font-size:10px;font-weight:650;letter-spacing:0;text-transform:none}.coding-page .coding-agent-detail-card>header>span{color:var(--text-tertiary);font:8px/1.2 var(--font-mono);white-space:nowrap}
.coding-page .coding-agent-detail dl{display:grid;gap:0;margin:0}.coding-page .coding-agent-detail dl>div{min-width:0;display:grid;grid-template-columns:112px minmax(0,1fr);gap:14px;padding:10px 0;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-agent-detail dl>div:last-child{border-bottom:0}.coding-page .coding-agent-detail dt{color:var(--text-tertiary);font-size:8px;font-weight:700;letter-spacing:.055em;text-transform:uppercase}.coding-page .coding-agent-detail dd{min-width:0;margin:0;color:var(--text-secondary);font-size:10px;line-height:1.5;overflow-wrap:anywhere}.coding-page .coding-agent-detail code{color:var(--accent-strong);font:9px/1.45 var(--font-mono)}
.coding-page .coding-agent-detail ul,.coding-page .coding-agent-detail ol{margin:0;padding:0;list-style:none}.coding-page .coding-live .coding-agent-detail-card li{min-width:0;border:0;border-bottom:1px solid var(--border-subtle);border-radius:0;background:transparent}.coding-page .coding-live .coding-agent-detail-card li:last-child{border-bottom:0}.coding-page .coding-agent-tasks li{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;gap:12px!important;align-items:center;padding:10px 0!important}.coding-page .coding-agent-tasks li span{font-size:10px}.coding-page .coding-agent-tasks li small{color:var(--text-tertiary);font:8px/1.35 var(--font-mono)}
.coding-page .coding-agent-terminal ol{max-height:360px;overflow:auto;overscroll-behavior:contain;margin:12px 0 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset);scrollbar-width:thin}.coding-page .coding-live .coding-agent-terminal li{display:grid;grid-template-columns:72px minmax(0,1fr);gap:12px;align-items:start;padding:9px 10px}.coding-page .coding-agent-terminal li>span{display:grid;gap:3px}.coding-page .coding-agent-terminal time,.coding-page .coding-agent-terminal li>span code{color:var(--text-tertiary);font:8px/1.35 var(--font-mono)}.coding-page .coding-agent-terminal pre{min-width:0;overflow-wrap:anywhere;margin:0;color:var(--accent-strong);font:10px/1.55 var(--font-mono);white-space:pre-wrap}.coding-page .coding-agent-terminal li[data-stream="stderr"] pre{color:var(--danger)}.coding-page .coding-live .coding-agent-terminal li.coding-agent-terminal-empty{display:block;padding:12px;color:var(--text-tertiary);font-size:9px;line-height:1.5}
.coding-page .coding-agent-log ol{max-height:300px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.coding-page .coding-agent-log li{display:grid!important;grid-template-columns:38px minmax(0,1fr)!important;gap:12px!important;align-items:start!important;padding:10px 0!important}.coding-page .coding-agent-log li>code{color:var(--text-tertiary);font-size:8px}.coding-page .coding-agent-log li>span{min-width:0}.coding-page .coding-agent-log li strong,.coding-page .coding-agent-log li small{display:block;overflow-wrap:anywhere}.coding-page .coding-agent-log li strong{color:var(--text-primary);font-size:9px;font-weight:650}.coding-page .coding-agent-log li small{margin-top:3px;color:var(--text-secondary);font-size:9px;line-height:1.45}.coding-page .coding-live .coding-agent-log li.coding-agent-log-empty{display:block!important;color:var(--text-tertiary);font-size:9px}
.coding-page .coding-agent-detail>footer{display:grid;gap:4px;margin-top:auto;padding:20px 20px 24px;color:var(--text-tertiary);font-size:8px;line-height:1.5}.coding-page .coding-agent-detail>footer strong{color:var(--text-secondary);font-size:8px}.coding-page .coding-agent-detail>footer span{max-width:52ch}
`;

const codingAgentIdentityCss = `.coding-page .coding-agent-symbol{--agent-color:#82acff;width:24px;height:24px;display:grid;place-items:center;flex:none;border:1px solid color-mix(in srgb,var(--agent-color) 34%,var(--border-subtle));border-radius:var(--radius-control);color:var(--agent-color);background:color-mix(in srgb,var(--agent-color) 9%,var(--surface-inset));font-size:0}
.coding-page .coding-agent-symbol svg{width:12px;height:12px;overflow:visible}.coding-page .coding-agent-avatar{width:29px;height:29px}.coding-page .coding-agent-avatar svg{width:14px;height:14px}.coding-page .coding-message-avatar{width:30px;height:30px}.coding-page .coding-message-avatar svg{width:14px;height:14px}
.coding-page .coding-run-team-label{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 1px 0;color:var(--text-tertiary);font-size:8px;font-weight:650;letter-spacing:.055em;text-transform:uppercase}.coding-page .coding-run-team-label strong{color:var(--text-tertiary);font:8px/1 var(--font-mono)}.coding-page .coding-message article header .coding-agent-role{color:var(--text-secondary);font-weight:550}
.coding-page .coding-message-execution{max-width:220px;overflow:hidden;padding:3px 7px;border:1px solid var(--border-subtle);border-radius:999px;color:var(--accent-strong);background:var(--surface-inset);cursor:pointer;font:650 8px/1.2 var(--font-mono);text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-message-execution:hover{border-color:var(--accent);background:var(--surface-hover);text-decoration:none}.coding-page .coding-message-execution:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-page .coding-project-agent-profile{max-width:100%;overflow:hidden;color:var(--text-primary);font:600 9px/1.2 var(--font-ui);text-align:left;text-overflow:ellipsis;white-space:nowrap}.coding-page .participant-runtime-editor>form{grid-template-columns:repeat(2,minmax(0,1fr))}.coding-page .participant-runtime-editor label{grid-column:auto!important}.coding-page .participant-runtime-editor [data-participant-model-field][hidden]{display:none}.coding-page .participant-runtime-note{grid-column:1/-1;margin:0;color:var(--text-tertiary);font-size:8px;line-height:1.45}
.coding-page .coding-project-agent-execution,.coding-page .coding-run-agent-execution,.coding-page .coding-coordination-execution{min-width:0;display:flex;gap:3px 8px;margin-top:3px;color:var(--accent-strong);font:650 7px/1.3 var(--font-mono)}.coding-page .coding-project-agent-execution{display:grid;gap:1px}.coding-page .coding-project-agent-execution>span,.coding-page .coding-run-agent-execution>span,.coding-page .coding-coordination-execution>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-project-agent-execution b,.coding-page .coding-run-agent-execution b,.coding-page .coding-coordination-execution b{color:var(--text-tertiary);font:inherit;text-transform:uppercase;letter-spacing:.045em}.coding-page .coding-project-agent-role{color:var(--text-secondary)!important}
.coding-page .coding-project-team li[data-coding-agent-node]{grid-template-columns:24px minmax(0,1fr) auto}.coding-page .coding-project-agent-change{align-self:center;padding:4px 0 4px 6px;border:0;color:var(--text-tertiary);background:transparent;cursor:pointer;font:650 7px/1.2 var(--font-ui)}.coding-page .coding-project-agent-change:hover{color:var(--accent-strong);text-decoration:underline;text-underline-offset:3px}.coding-page .coding-project-agent-change:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.coding-page [data-agent-tone="lead"]{--agent-color:#79dacb}.coding-page [data-agent-tone="product"]{--agent-color:#f4ce71}.coding-page [data-agent-tone="build"]{--agent-color:#82acff}.coding-page [data-agent-tone="quality"]{--agent-color:#91d46d}.coding-page [data-agent-tone="interface"]{--agent-color:#c795ff}.coding-page [data-agent-tone="api"]{--agent-color:#72c5f5}.coding-page [data-agent-tone="data"]{--agent-color:#ff9275}.coding-page [data-agent-tone="docs"]{--agent-color:#ef7aa7}.coding-page [data-agent-tone="security"]{--agent-color:#79dacb}.coding-page [data-agent-tone="runtime"]{--agent-color:#f4ce71}.coding-page [data-agent-tone="ml"]{--agent-color:#b99cff}.coding-page [data-agent-tone="experiment"]{--agent-color:#ffad72}
.coding-page .coding-collaboration-frontier{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-collaboration-frontier>span{display:flex;align-items:center;gap:6px}.coding-page .coding-collaboration-frontier i{width:6px;height:6px;border-radius:50%;background:var(--accent)}.coding-page .coding-collaboration-frontier[data-state="certified"] i{background:var(--success)}.coding-page .coding-collaboration-frontier[data-state="conflicted"] i{background:var(--danger)}.coding-page .coding-collaboration-frontier strong{font-size:9px}.coding-page .coding-collaboration-frontier small{color:var(--text-tertiary);font:8px/1.3 var(--font-mono)}.coding-page .coding-collaboration-frontier p{grid-column:1/-1;margin:2px 0;color:var(--text-secondary);font-size:8px;line-height:1.4}.coding-page .coding-collaboration-frontier code{grid-column:1/-1;color:var(--text-tertiary);font:7px/1.3 var(--font-mono)}.coding-page .coding-human-action{display:grid;gap:7px;margin:0;padding:9px;border:1px solid var(--warning-border);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--warning-surface);font-size:8px;line-height:1.5}.coding-page .coding-human-action[data-state="recovery"]{border-color:var(--danger-border);background:var(--danger-surface)}.coding-page .coding-human-action[data-state="continued"]{border-color:var(--success-border);background:var(--success-surface)}.coding-page .coding-human-action>header{display:flex;align-items:center;justify-content:space-between;gap:8px}.coding-page .coding-human-action>header strong{color:var(--warning);font-size:9px}.coding-page .coding-human-action[data-state="recovery"]>header strong,.coding-page .coding-human-action[data-state="recovery"]>p>strong{color:var(--danger)}.coding-page .coding-human-action[data-state="continued"]>header strong,.coding-page .coding-human-action[data-state="continued"]>p>strong{color:var(--success)}.coding-page .coding-human-action>header small,.coding-page .coding-human-action li>span{color:var(--text-tertiary);font:7px/1.3 var(--font-mono)}.coding-page .coding-human-action p{margin:0}.coding-page .coding-human-action ol,.coding-page .coding-human-action ul{display:grid;gap:5px;margin:0;padding-left:16px}.coding-page .coding-human-action ol>li>p{margin:2px 0}.coding-page .coding-human-action button,.coding-page .coding-human-action>a{justify-self:start;min-height:26px;display:inline-flex;align-items:center;padding:0 9px;border:1px solid var(--warning-border);border-radius:var(--radius-control);color:var(--text-primary);background:var(--surface-raised);cursor:pointer;font-size:8px;font-weight:700;text-decoration:none}.coding-page .coding-human-action[data-state="continued"]>a{border-color:var(--success-border)}.coding-page .coding-project-scan[data-state="conflicted"]>span{color:var(--warning)}`;

const codingTeamBriefCss = `.coding-page .coding-team-brief{margin:2px clamp(18px,4vw,52px) 8px;overflow:hidden;border:1px solid color-mix(in srgb,var(--accent) 20%,var(--border-default));border-radius:var(--radius-card);background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 7%,var(--surface-panel)),var(--surface-panel) 58%);box-shadow:0 16px 48px rgba(0,0,0,.16)}
.coding-page .coding-team-brief>header{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:start;padding:16px 17px 14px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-team-brief>header>div{min-width:0}.coding-page .coding-team-brief>header span{display:block;margin-bottom:4px;color:var(--accent-strong);font:750 8px/1.2 var(--font-mono);letter-spacing:.08em;text-transform:uppercase}.coding-page .coding-team-brief>header h3{max-width:72ch;margin:0;color:var(--text-primary);font-size:14px;font-weight:650;line-height:1.4;letter-spacing:-.01em;overflow-wrap:anywhere;text-wrap:pretty}.coding-page .coding-team-brief>header>strong{max-width:180px;padding:5px 9px;border:1px solid var(--border-strong);border-radius:var(--radius-pill);color:var(--text-secondary);background:var(--surface-inset);font:650 8px/1.2 var(--font-mono);text-align:center;white-space:nowrap}.coding-page .coding-team-brief[data-state="working"]>header>strong{border-color:color-mix(in srgb,var(--accent) 44%,var(--border-strong));color:var(--accent-strong);background:color-mix(in srgb,var(--accent) 9%,var(--surface-inset))}.coding-page .coding-team-brief[data-state="blocked"]>header>strong{border-color:var(--danger-border);color:var(--danger);background:var(--danger-surface)}.coding-page .coding-team-brief[data-state="done"]>header>strong{border-color:var(--success-border);color:var(--success);background:var(--success-surface)}
.coding-page .coding-team-brief-body{min-width:0;display:grid;grid-template-columns:minmax(0,1.45fr) minmax(220px,.75fr);gap:14px;padding:14px 17px}.coding-page .coding-team-brief-cast{min-width:0;display:flex;align-items:stretch;gap:7px;overflow-x:auto;padding:1px 1px 5px;overscroll-behavior-inline:contain;scrollbar-width:thin}.coding-page .coding-team-brief-cast>:is(a,button){min-width:172px;max-width:230px;display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 9px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);color:inherit;background:var(--surface-inset);font:inherit;text-align:left;text-decoration:none;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}.coding-page .coding-team-brief-cast>:is(a,button):hover{border-color:var(--border-strong);background:var(--surface-hover)}.coding-page .coding-team-brief-cast>:is(a,button):focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-page .coding-team-brief-avatar{width:30px;height:30px}.coding-page .coding-team-brief-avatar svg{width:14px;height:14px}.coding-page .coding-team-brief-cast>:is(a,button)>span{min-width:0}.coding-page .coding-team-brief-cast strong,.coding-page .coding-team-brief-cast small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-team-brief-cast strong{font-size:10px}.coding-page .coding-team-brief-cast small{margin-top:2px;color:var(--text-tertiary);font-size:8px}.coding-page .coding-team-brief-cast em{align-self:start;color:var(--text-tertiary);font:650 7px/1.2 var(--font-mono);font-style:normal}.coding-page .coding-team-brief-cast>:is(a,button)[data-state="working"] em{color:var(--accent-strong)}.coding-page .coding-team-brief-cast>:is(a,button)[data-state="done"] em{color:var(--success)}.coding-page .coding-team-brief-cast>:is(a,button)[data-state="blocked"] em{color:var(--danger)}.coding-page .coding-team-brief-assembling{min-height:48px;display:flex;align-items:center;gap:8px;padding:8px 10px;color:var(--text-secondary);font-size:9px}.coding-page .coding-team-brief-assembling i{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:coding-pulse 1.8s ease-in-out infinite}
.coding-page .coding-team-brief-pulse{min-width:0;align-self:stretch;display:flex;flex-direction:column;justify-content:center;gap:5px;padding:10px 12px;border-left:1px solid var(--border-subtle)}.coding-page .coding-team-brief-pulse strong{color:var(--text-secondary);font-size:10px;font-weight:600;line-height:1.45;overflow-wrap:anywhere;text-wrap:pretty}.coding-page .coding-team-brief-pulse span{color:var(--text-tertiary);font:8px/1.35 var(--font-mono);font-variant-numeric:tabular-nums}
.coding-page .coding-team-brief>footer{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px 10px 17px;border-top:1px solid var(--border-subtle);background:var(--surface-inset)}.coding-page .coding-team-brief>footer>span{color:var(--text-tertiary);font-size:8px;line-height:1.4;text-wrap:pretty}.coding-page .coding-team-brief-action{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:none;padding:0 12px;border:1px solid color-mix(in srgb,var(--accent) 42%,var(--border-strong));border-radius:var(--radius-control);color:var(--text-primary);background:color-mix(in srgb,var(--accent) 11%,var(--surface-raised));cursor:pointer;font:650 9px/1.2 var(--font-ui);text-decoration:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent}.coding-page .coding-team-brief-action:hover{border-color:var(--accent);color:var(--accent-strong);background:var(--surface-hover)}.coding-page .coding-team-brief-action:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
@media(max-width:820px){.coding-page .coding-team-brief{margin-inline:18px}.coding-page .coding-team-brief-body{grid-template-columns:minmax(0,1fr)}.coding-page .coding-team-brief-pulse{border-top:1px solid var(--border-subtle);border-left:0;padding-inline:2px}}
@media(max-width:520px){.coding-page .coding-team-brief{margin-inline:14px}.coding-page .coding-team-brief>header{grid-template-columns:minmax(0,1fr);gap:10px;padding-inline:13px}.coding-page .coding-team-brief>header>strong{justify-self:start}.coding-page .coding-team-brief-body{padding-inline:13px}.coding-page .coding-team-brief-cast>:is(a,button){min-width:158px}.coding-page .coding-team-brief>footer{align-items:stretch;flex-direction:column;padding:11px 13px}.coding-page .coding-team-brief-action{width:100%;min-height:44px}}
@media(prefers-reduced-motion:reduce){.coding-page .coding-team-brief-assembling i{animation:none}}`;

const codingDailyDriverCss = `.coding-page .coding-mission-bar{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"copy actions" "cast cast" "pulse pulse";gap:10px 14px;margin:12px clamp(18px,4vw,52px);padding:14px 15px;border:1px solid color-mix(in srgb,var(--accent) 19%,var(--border-default));border-radius:var(--radius-card);background:linear-gradient(115deg,color-mix(in srgb,var(--accent) 6%,var(--surface-panel)),var(--surface-panel) 52%);box-shadow:var(--shadow-card)}
.coding-page .coding-final-report{padding:18px;border:1px solid var(--border-default);border-radius:var(--radius-card);background:var(--surface-panel);box-shadow:var(--shadow-card)}.coding-page .coding-final-report>div{display:grid;gap:16px}.coding-page .coding-final-report>div>header{padding-bottom:12px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-final-report>div>header strong{font-size:15px}.coding-page .coding-final-report section{display:grid;gap:7px}.coding-page .coding-final-report h3{margin:0;color:var(--text-tertiary);font:750 8px/1.2 var(--font-mono);letter-spacing:.07em;text-transform:uppercase}.coding-page .coding-final-report section>p{margin:0}.coding-page .coding-final-report .coding-message-body{padding:0;border:0;background:transparent}.coding-page .coding-final-report .coding-message-body>:first-child{margin-top:0}.coding-page .coding-final-report .coding-message-body>:last-child{margin-bottom:0}.coding-page .coding-report-findings{display:grid;gap:10px;margin:0;padding:0;list-style:none}.coding-page .coding-report-findings>li{padding:10px 11px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-page .coding-report-findings>li>strong{font-size:10px;line-height:1.45}.coding-page .coding-report-findings ul{margin-top:6px}.coding-page .coding-report-files{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));padding:0;list-style:none}.coding-page .coding-report-files li{min-width:0;padding:7px 8px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-page .coding-report-files code{overflow-wrap:anywhere}.coding-page .coding-final-report .coding-report-download{width:max-content;min-height:34px;display:inline-flex;align-items:center;padding:0 10px;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--text-primary);background:var(--surface-raised);font-weight:650}.coding-page .coding-final-report .coding-report-download:hover{border-color:var(--accent);text-decoration:none}
.coding-page .coding-mission-copy{grid-area:copy;min-width:0;display:grid;gap:4px}.coding-page .coding-mission-state{display:inline-flex;align-items:center;gap:6px;width:max-content;max-width:100%;color:var(--text-secondary);font:700 8px/1.2 var(--font-mono);letter-spacing:.045em;text-transform:uppercase}.coding-page .coding-mission-state>i{width:7px;height:7px;flex:none;border-radius:50%;background:var(--text-tertiary)}.coding-page .coding-mission-bar[data-state="working"] .coding-mission-state>i{background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent)}.coding-page .coding-mission-bar[data-state="done"] .coding-mission-state>i{background:var(--success)}.coding-page .coding-mission-bar[data-state="blocked"] .coding-mission-state>i{background:var(--danger)}.coding-page .coding-mission-copy h3{max-width:74ch;margin:0;color:var(--text-primary);font-size:14px;font-weight:650;line-height:1.38;letter-spacing:-.012em;overflow-wrap:anywhere;text-wrap:pretty}.coding-page .coding-mission-meta{min-width:0;display:flex;align-items:center;gap:6px;color:var(--text-tertiary);font:8px/1.3 var(--font-mono);font-variant-numeric:tabular-nums}.coding-page .coding-mission-meta code{min-width:0;overflow:hidden;color:var(--accent-strong);text-overflow:ellipsis;white-space:nowrap}
.coding-page .coding-mission-actions{grid-area:actions;display:flex;align-items:flex-start;justify-content:flex-end;gap:7px}.coding-page .coding-mission-action{min-height:36px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:0 11px;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-raised);cursor:pointer;font:650 9px/1.2 var(--font-ui);text-decoration:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent}.coding-page .coding-mission-action:hover{border-color:var(--accent);color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-mission-action-primary{border-color:var(--action-primary);color:var(--action-primary-foreground);background:var(--action-primary)}.coding-page .coding-mission-action-primary:hover{border-color:var(--action-primary-hover);color:var(--action-primary-foreground);background:var(--action-primary-hover)}.coding-page .coding-mission-action:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.coding-page .coding-mission-cast{grid-area:cast;min-width:0;display:flex;align-items:center;gap:6px;overflow-x:auto;padding:1px 0 2px;overscroll-behavior-inline:contain;scrollbar-width:thin}.coding-page .coding-mission-cast>:is(a,button){min-width:144px;max-width:190px;display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:7px;align-items:center;padding:5px 7px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);color:inherit;background:var(--surface-inset);font:inherit;text-align:left;text-decoration:none;cursor:pointer;touch-action:manipulation}.coding-page .coding-mission-cast>:is(a,button):hover{border-color:var(--border-strong);background:var(--surface-hover)}.coding-page .coding-mission-cast>:is(a,button):focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-page .coding-mission-cast .coding-team-brief-avatar{width:26px;height:26px}.coding-page .coding-mission-cast .coding-team-brief-avatar svg{width:13px;height:13px}.coding-page .coding-mission-cast>:is(a,button)>span{min-width:0}.coding-page .coding-mission-cast strong,.coding-page .coding-mission-cast small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-mission-cast strong{font-size:9px}.coding-page .coding-mission-cast small{color:var(--text-tertiary);font-size:7px}.coding-page .coding-mission-cast em{align-self:start;color:var(--text-tertiary);font:650 7px/1.2 var(--font-mono);font-style:normal}.coding-page .coding-mission-cast>:is(a,button)[data-state="working"] em{color:var(--accent-strong)}.coding-page .coding-mission-cast>:is(a,button)[data-state="done"] em{color:var(--success)}.coding-page .coding-mission-cast>:is(a,button)[data-state="blocked"] em{color:var(--danger)}
.coding-page .coding-mission-pulse{grid-area:pulse;min-width:0;max-width:none;display:flex;align-items:center;padding-top:9px;border-top:1px solid var(--border-subtle)}.coding-page .coding-mission-pulse strong{color:var(--text-secondary);font-size:9px;font-weight:550;line-height:1.45;overflow-wrap:anywhere;text-wrap:pretty}
.coding-page .coding-context-cast>.coding-room-context-head{min-height:55px;display:flex;align-items:center;justify-content:space-between;gap:12px}.coding-page .coding-room-context-head>span{min-width:0}.coding-page .coding-room-context-head strong,.coding-page .coding-room-context-head small{display:block}.coding-page .coding-room-context-head strong{color:var(--text-primary);font-size:12px;font-weight:650}.coding-page .coding-room-context-head small{margin-top:2px}.coding-page .coding-room-context-head>button{width:32px;height:32px;display:grid;place-items:center;flex:none;border:1px solid var(--border-subtle);border-radius:var(--radius-control);color:var(--text-secondary);background:transparent;cursor:pointer;font-size:18px}.coding-page .coding-room-context-head>button:hover{color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-room-context-head>button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.coding-page .coding-workbench-tabs{position:sticky;z-index:4;top:55px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));padding:0 6px;border-bottom:1px solid var(--border-subtle);background:color-mix(in srgb,var(--surface-sidebar) 96%,transparent);backdrop-filter:blur(14px)}.coding-page .coding-workbench-tabs button{min-width:0;min-height:40px;border:0;border-bottom:2px solid transparent;padding:0 4px;color:var(--text-tertiary);background:transparent;cursor:pointer;font-size:8px;font-weight:650}.coding-page .coding-workbench-tabs button:hover{color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-workbench-tabs button[aria-selected="true"]{border-bottom-color:var(--accent);color:var(--text-primary)}.coding-page .coding-workbench-tabs button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-3px}.coding-page .coding-workbench-panel{min-width:0;display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:12px;padding:12px}.coding-page .coding-workbench-panel[hidden]{display:none}.coding-page .coding-workbench-panel>.coding-live,.coding-page .coding-workbench-panel>.coding-git-handoff,.coding-page .coding-workbench-panel>.coding-coordination,.coding-page .coding-workbench-panel>.coding-operations,.coding-page .coding-workbench-panel>.coding-context-frontier,.coding-page .coding-workbench-panel>.coding-artifact-index{position:static;grid-column:auto;grid-row:auto;width:auto;max-width:none;margin:0}.coding-page .coding-workbench-panel>.coding-operations>summary{min-height:44px}
.coding-page .coding-artifact-index{overflow:hidden;border:1px solid var(--border-subtle);border-radius:var(--radius-card);background:var(--surface-panel)}.coding-page .coding-artifact-index>header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 13px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-artifact-index>header span,.coding-page .coding-artifact-index>header small,.coding-page .coding-artifact-index>header strong{display:block}.coding-page .coding-artifact-index>header small{margin-bottom:3px;color:var(--text-tertiary);font:7px/1.2 var(--font-mono);letter-spacing:.06em;text-transform:uppercase}.coding-page .coding-artifact-index>header strong{font-size:11px}.coding-page .coding-artifact-index>header em{min-width:24px;height:24px;display:grid;place-items:center;border-radius:999px;color:var(--accent-strong);background:var(--surface-inset);font:650 8px/1 var(--font-mono);font-style:normal}.coding-page .coding-artifact-index ol{display:grid;margin:0;padding:0;list-style:none}.coding-page .coding-artifact-index li{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:11px 13px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-artifact-index li:last-child{border-bottom:0}.coding-page .coding-artifact-index li span,.coding-page .coding-artifact-index li strong,.coding-page .coding-artifact-index li small{min-width:0;display:block}.coding-page .coding-artifact-index li strong{overflow:hidden;color:var(--text-primary);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-artifact-index li small{margin-top:2px;color:var(--text-tertiary);font-size:8px}.coding-page .coding-artifact-index li p{grid-column:1/-1;margin:2px 0 0;color:var(--text-secondary);font-size:8px;line-height:1.45}.coding-page .coding-artifact-index li code{align-self:start;color:var(--text-tertiary);font:7px/1.3 var(--font-mono)}.coding-page .coding-workbench-empty{margin:0;padding:18px 13px;color:var(--text-tertiary);font-size:9px;line-height:1.5}
.coding-page .coding-workbench-panel>.coding-coordination{max-height:none;grid-auto-rows:max-content;align-content:start;overflow:visible;box-shadow:none}.coding-page .coding-workbench-panel>.coding-coordination>header{position:static}
.coding-page .coding-command-trigger{min-height:30px;display:inline-flex;align-items:center;gap:8px;padding:0 8px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-inset);cursor:pointer;font:600 9px/1 var(--font-ui)}.coding-page .coding-command-trigger:hover{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-command-trigger:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-page .coding-command-trigger kbd{padding:3px 5px;border:1px solid var(--border-subtle);border-radius:5px;color:var(--text-tertiary);background:var(--surface-raised);font:7px/1 var(--font-mono)}
.coding-command-dialog{width:min(620px,calc(100vw - 28px));max-height:min(680px,calc(100dvh - 40px));overflow:hidden;border:1px solid var(--border-strong);border-radius:var(--radius-overlay);padding:0;color:var(--text-primary);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.coding-command-dialog::backdrop{background:rgba(5,7,8,.68);backdrop-filter:blur(5px)}.coding-command-surface{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto auto}.coding-command-surface>header{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 16px;border-bottom:1px solid var(--border-subtle)}.coding-command-surface>header strong,.coding-command-surface>header small{display:block}.coding-command-surface>header strong{font-size:13px}.coding-command-surface>header small{margin-top:3px;color:var(--text-tertiary);font-size:9px}.coding-command-surface>header button{width:34px;height:34px;display:grid;place-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-control);color:var(--text-secondary);background:transparent;cursor:pointer;font-size:19px}.coding-command-search{height:54px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--border-subtle);color:var(--text-tertiary)}.coding-command-search:focus-within{color:var(--accent-strong)}.coding-command-search input{min-width:0;width:100%;height:40px;border:0;outline:0;color:var(--text-primary);background:transparent;font:13px/1.3 var(--font-ui)}.coding-command-search input::placeholder{color:var(--text-tertiary)}.coding-command-list{min-height:0;max-height:430px;display:grid;gap:3px;overflow:auto;padding:8px;overscroll-behavior:contain}.coding-command-list>:is(button,a){min-width:0;min-height:54px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 10px;border:1px solid transparent;border-radius:var(--radius-control);color:var(--text-primary);background:transparent;cursor:pointer;font:inherit;text-align:left;text-decoration:none}.coding-command-list>:is(button,a):hover,.coding-command-list>:is(button,a):focus-visible{border-color:var(--border-subtle);background:var(--surface-hover);outline:none}.coding-command-list>:is(button,a)>span{min-width:0}.coding-command-list strong,.coding-command-list small{display:block}.coding-command-list strong{font-size:10px}.coding-command-list small{margin-top:3px;color:var(--text-tertiary);font-size:9px}.coding-command-list kbd,.coding-command-surface>footer kbd{min-width:25px;padding:4px 6px;border:1px solid var(--border-subtle);border-radius:5px;color:var(--text-tertiary);background:var(--surface-inset);font:7px/1 var(--font-mono);text-align:center}.coding-command-surface>[role="status"]{min-height:0;margin:0;padding:0 16px;color:var(--text-tertiary);font-size:8px}.coding-command-surface>footer{min-height:38px;display:flex;align-items:center;gap:16px;padding:0 16px;border-top:1px solid var(--border-subtle);color:var(--text-tertiary);font-size:8px}.coding-command-surface>footer span{display:inline-flex;align-items:center;gap:4px}.coding-command-surface>footer .coding-command-build{margin-left:auto}.coding-command-build code{color:var(--accent-strong);font:8px/1 var(--font-mono)}
.coding-page .coding-room-context-head>button,.coding-command-surface>header button{width:44px;height:44px;touch-action:manipulation}.coding-page .coding-workbench-tabs button{min-height:44px;touch-action:manipulation}
@media(max-width:1099px){.coding-page .coding-mission-bar{grid-template-columns:minmax(0,1fr);grid-template-areas:"copy" "cast" "pulse" "actions"}.coding-page .coding-mission-actions{justify-content:flex-start}.coding-page .coding-command-trigger>span{display:none}}
@media(max-width:620px){.coding-page .coding-mission-bar{gap:10px;margin:9px 12px;padding:12px}.coding-page .coding-mission-copy h3{font-size:13px}.coding-page .coding-mission-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.coding-page .coding-mission-action{min-height:44px}.coding-page .coding-mission-cast>:is(a,button){min-width:138px}.coding-command-dialog{width:calc(100vw - 16px);max-height:calc(100dvh - 16px)}.coding-command-surface>footer{justify-content:space-between;gap:6px}.coding-command-surface>footer span:last-child{display:none}}
@media(prefers-reduced-motion:reduce){.coding-command-dialog::backdrop{backdrop-filter:none}}`;

const codingComposerCss = `.coding-page .coding-composer{position:relative;padding:10px 12px 8px}.coding-page .coding-composer-speaker{display:flex;align-items:center;gap:8px;margin:0 1px 4px}.coding-page .coding-composer-speaker>span{width:23px;height:23px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:50%;color:var(--text-primary);background:var(--surface-inset);font-size:8px;font-weight:750}.coding-page .coding-composer-speaker p{min-width:0;margin:0}.coding-page .coding-composer-speaker strong,.coding-page .coding-composer-speaker small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-composer-speaker strong{font-size:9px}.coding-page .coding-composer-speaker small{margin-top:1px;color:var(--text-tertiary);font:7px/1.25 var(--font-mono)}.coding-page .coding-composer-tools{min-width:0;display:flex;align-items:center;gap:6px}.coding-page .coding-composer-advanced{position:relative}.coding-page .coding-composer-advanced>summary{min-height:40px;display:inline-flex;align-items:center;gap:7px;padding:0 11px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-secondary);background:var(--surface-inset);cursor:pointer;font-size:10px;font-weight:650;list-style:none}.coding-page .coding-composer-advanced>summary::-webkit-details-marker{display:none}.coding-page .coding-composer-advanced>summary:hover,.coding-page .coding-composer-advanced[open]>summary{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-composer-advanced-panel{position:absolute;z-index:32;left:0;bottom:calc(100% + 8px);min-width:min(360px,calc(100vw - 52px));display:flex;align-items:center;gap:8px;padding:11px;border:1px solid var(--border-strong);border-radius:var(--radius-overlay);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.coding-page .coding-composer-options{display:flex;align-items:center;gap:6px}.coding-page .coding-composer-select{min-width:0;display:flex;align-items:center;padding:0}.coding-page .coding-composer-select select{height:30px;max-width:122px;font-size:9px;font-weight:600}.coding-page .coding-composer-select .ui-select-trigger{min-height:36px;max-width:154px;border-color:var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-secondary);background:var(--surface-inset);box-shadow:none;font-size:9px;font-weight:600}.coding-page .coding-composer-select .ui-select-trigger:hover{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}
.coding-page .coding-image-picker{position:relative;width:40px;height:40px;display:grid;place-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-secondary);background:var(--surface-inset);cursor:pointer;font-size:18px;line-height:1}.coding-page .coding-image-picker:hover{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-image-picker:focus-within{outline:2px solid var(--accent-strong);outline-offset:3px}.coding-page .coding-image-picker input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}.coding-page .coding-image-previews{display:flex;gap:8px;overflow-x:auto;margin:7px 0 5px;padding:2px 1px 4px}.coding-page .coding-image-preview{position:relative;flex:0 0 104px;margin:0}.coding-page .coding-image-preview img{width:104px;height:78px;display:block;object-fit:cover;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface-inset)}.coding-page .coding-image-preview figcaption{overflow:hidden;margin-top:3px;color:var(--text-tertiary);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-image-preview button{position:absolute;top:4px;right:4px;width:28px;min-width:28px;height:28px;min-height:28px;padding:0;border:1px solid rgba(255,255,255,.3);border-radius:50%;color:#fff;background:rgba(12,13,11,.84);font-size:15px}.coding-page .coding-image-preview button:focus-visible{outline:2px solid #fff;outline-offset:2px}.coding-page .coding-image-status{min-height:0;margin:0;color:var(--text-tertiary);font-size:9px}.coding-page .coding-image-status:not(:empty){min-height:16px;margin:3px 1px}.coding-page .coding-image-status[data-state="error"]{color:var(--danger)}
.coding-page .coding-mention-menu{position:relative}.coding-page .coding-mention-menu>summary{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-secondary);background:var(--surface-inset);cursor:pointer;font:650 13px/1 var(--font-ui);list-style:none}.coding-page .coding-mention-menu>summary::-webkit-details-marker{display:none}.coding-page .coding-mention-menu>summary:hover,.coding-page .coding-mention-menu[open]>summary{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-mention-panel{position:absolute;z-index:30;left:0;bottom:calc(100% + 8px);width:292px;max-height:min(420px,55vh);overflow:auto;overscroll-behavior:contain;padding:7px;border:1px solid var(--border-strong);border-radius:var(--radius-overlay);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.coding-page .coding-mention-panel>header{padding:7px 8px 9px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-mention-panel>header strong,.coding-page .coding-mention-panel>header small{display:block}.coding-page .coding-mention-panel>header strong{font-size:10px;text-wrap:balance}.coding-page .coding-mention-panel>header small{margin-top:2px;color:var(--text-tertiary);font-size:8px}.coding-page .coding-mention-panel>div{display:grid;gap:2px;padding:5px 0}.coding-page .coding-composer .coding-mention-option{width:100%;height:auto;min-width:0;display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;align-items:center;justify-items:start;padding:6px 7px;border:0;border-radius:var(--radius-control);color:var(--text-primary);background:transparent;cursor:pointer;text-align:left}.coding-page .coding-composer .coding-mention-option[hidden]{display:none}.coding-page .coding-composer .coding-mention-option:hover,.coding-page .coding-composer .coding-mention-option[data-active="true"]{background:var(--surface-hover)}.coding-page .coding-mention-option>span{min-width:0}.coding-page .coding-mention-option strong,.coding-page .coding-mention-option small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-mention-option strong{font-size:9px;font-weight:650}.coding-page .coding-mention-option small{margin-top:1px;color:var(--text-tertiary);font-size:8px}.coding-page .coding-mention-panel>p{margin:4px 7px 5px;color:var(--text-tertiary);font-size:8px;line-height:1.45}.coding-page .coding-mention-panel>[data-coding-mention-empty]{padding:7px;border:1px dashed var(--border-subtle);border-radius:var(--radius-control);text-align:center}.coding-page .coding-mention-panel>[hidden]{display:none}
.coding-page .coding-composer-select select{max-width:154px}.coding-page .coding-composer-help{display:flex;align-items:center;justify-content:space-between;gap:12px}.coding-page .coding-composer-help span:last-child{flex:none;color:var(--text-tertiary);font-family:var(--font-mono)}.coding-page .coding-run-team-help{margin:5px 1px 0;color:var(--text-tertiary);font-size:8px;line-height:1.45}.coding-page .coding-agent-row-meta{display:grid;justify-items:end;gap:2px}.coding-page .coding-agent-row-meta em{font-style:normal}.coding-page .coding-agent-row-meta small{color:var(--accent-strong);font:7px/1.2 var(--font-mono);white-space:nowrap}@media(max-width:560px){.coding-page .coding-composer-help span:last-child{display:none}}`;

const codingWorkspaceCss = `
:root{--workspace-rail-width:248px}
body{min-width:0}.coding-page.agent-app{min-width:0;grid-template-rows:48px minmax(0,1fr)}.coding-page .agent-main{height:calc(100vh - 48px)}
.coding-page{font-family:var(--font-ui);font-size:14px}
.coding-page .agent-top-nav{height:48px;min-height:48px;padding:0 16px;gap:16px;border-bottom-color:var(--border-subtle);box-shadow:none}
.coding-page .agent-top-nav-actions{margin-left:auto}
.coding-page .top-navbar-brand{gap:10px}.coding-page .top-navbar-brand strong{font-size:15px}.coding-page .top-navbar-brand small{font-size:9px}
.coding-page .top-navbar-status{font-size:10px;letter-spacing:.04em;text-transform:none}
.coding-page .coding-workbench{height:calc(100dvh - 48px);grid-template-columns:var(--workspace-rail-width) minmax(0,1fr)}
.coding-page .coding-project-rail{border-right:1px solid var(--border-subtle);background:var(--surface-sidebar)}
.coding-page .coding-workspace-switcher>summary{min-height:72px;padding:14px 16px}.coding-page .coding-workspace-switcher-panel{background:color-mix(in srgb,var(--surface-sidebar) 86%,var(--surface-panel))}.coding-page .coding-project-identity>span{width:36px;height:36px;font-size:13px}
.coding-page .coding-project-identity>div>em{font-size:9px}.coding-page .coding-project-identity strong{font-size:15px}.coding-page .coding-project-identity small{font-size:10px}
.coding-page .coding-sidebar-search{height:34px;display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:4px;margin:8px 12px 6px;padding:0 8px;border:1px solid var(--border-subtle);border-radius:8px;color:var(--text-tertiary);background:var(--surface-inset)}.coding-page .coding-sidebar-search:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}.coding-page .coding-sidebar-search>span:first-child{font-size:15px}.coding-page .coding-sidebar-search input{min-width:0;width:100%;height:30px;padding:0;border:0;outline:0;color:var(--text-primary);background:transparent;font-size:11px}.coding-page .coding-sidebar-search input::placeholder{color:var(--text-tertiary)}
.coding-page .coding-new-room{min-height:52px;display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;align-items:center;margin:8px 12px 12px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--accent) 32%,var(--border-strong));border-radius:var(--radius-control);color:var(--text-primary);background:color-mix(in srgb,var(--accent) 7%,var(--surface-raised));text-decoration:none}.coding-page .coding-new-room>span:first-child{width:30px;height:30px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--accent) 42%,var(--border-strong));border-radius:var(--radius-control);color:var(--accent-strong);background:var(--surface-inset);font-size:16px;line-height:1}.coding-page .coding-new-room strong,.coding-page .coding-new-room small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-new-room strong{font-size:12px;font-weight:650}.coding-page .coding-new-room small{margin-top:1px;color:var(--text-tertiary);font-size:9px}.coding-page .coding-new-room:hover,.coding-page .coding-new-room[aria-current="page"]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--surface-raised))}.coding-page .coding-new-room:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.coding-page .coding-project-section{padding:0;border-top:0}.coding-page .coding-sidebar-section>summary{min-height:44px;display:grid;grid-template-columns:12px minmax(0,1fr) auto;align-items:center;padding:8px 16px;gap:8px;color:var(--text-secondary);cursor:pointer;list-style:none}.coding-page .coding-sidebar-section>summary::-webkit-details-marker{display:none}.coding-page .coding-sidebar-section>summary:hover{color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-sidebar-section>summary>i{display:block;color:var(--text-tertiary);font-size:15px;font-style:normal;transition:transform .14s ease}.coding-page .coding-sidebar-section[open]>summary>i{transform:rotate(90deg)}.coding-page .coding-sidebar-section>summary h2{overflow:hidden;margin:0;color:inherit;font-weight:650;letter-spacing:0;text-overflow:ellipsis;text-transform:none;white-space:nowrap}.coding-page .coding-sidebar-section>summary h2,.coding-page .coding-attention>summary h2{font-size:12px}.coding-page .coding-sidebar-section>summary>span{font-size:10px}
.coding-page .coding-sidebar-section-body{padding:4px 12px 12px}.coding-page .coding-project-runs a{min-height:42px;padding:9px 12px;border-radius:6px}
.coding-page .coding-project-runs a[aria-current="page"]{box-shadow:inset 2px 0 var(--accent);background:var(--surface-hover)}
.coding-page .coding-project-runs strong,.coding-page .coding-project-team strong{font-size:13px}.coding-page .coding-project-runs small,.coding-page .coding-project-team small{font-size:10px}
.coding-page .coding-project-team li{min-height:38px;padding:7px 9px}.coding-page .coding-project-empty{font-size:11px;line-height:1.45}
.coding-page .coding-attention{border:0;background:transparent}.coding-page .coding-attention>summary{grid-template-columns:minmax(0,1fr) auto 12px}.coding-page .coding-attention>summary>span{grid-column:1}.coding-page .coding-attention>summary>strong{grid-column:2}.coding-page .coding-attention>summary>i{grid-column:3;display:block}.coding-page .coding-attention>summary small{display:none}.coding-page .coding-attention-body{padding:4px 12px 12px}
.coding-page .coding-conversation{position:relative;grid-template-columns:minmax(0,1fr) minmax(300px,360px);grid-template-rows:minmax(0,1fr) auto;padding-right:0;background:var(--surface-canvas);transition:grid-template-columns .18s ease}.coding-page .coding-conversation::after{display:none}:root[data-coding-context-cast="closed"] .coding-page .coding-conversation{grid-template-columns:minmax(0,1fr) 0}.coding-page .coding-conversation-scroll{z-index:1;grid-column:1;grid-row:1}.coding-page .coding-conversation-column{width:100%;padding:0}.coding-page .coding-run-panel{display:block}.coding-page .coding-run-main{gap:0}.coding-page .coding-room-panel:focus-visible{outline:2px solid var(--focus-ring);outline-offset:-2px}.coding-page .coding-room-messages{min-width:0}.coding-page .coding-room-messages-coordinating{display:grid;grid-template-columns:minmax(0,1fr) 340px;align-items:start}.coding-page .coding-room-messages-coordinating>.coding-thread{grid-column:1;grid-row:1}.coding-page .coding-error-island:empty,.coding-page .coding-result-island:empty{display:none}.coding-page .coding-error-island:not(:empty),.coding-page .coding-result-island:not(:empty){padding:12px clamp(22px,4vw,52px)}
.coding-page .coding-coordination{position:sticky;z-index:3;top:130px;grid-column:2;grid-row:1;min-width:0;max-height:clamp(280px,calc(100dvh - 470px),560px);display:grid;margin:18px 24px 34px 0;overflow:auto;overscroll-behavior:contain;border:1px solid var(--border-default);border-radius:14px;background:color-mix(in srgb,var(--surface-panel) 96%,var(--accent));box-shadow:0 18px 54px rgba(0,0,0,.28);scrollbar-width:thin}.coding-page .coding-coordination>header{position:sticky;z-index:2;top:0;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 15px 12px;border-bottom:1px solid var(--border-subtle);background:color-mix(in srgb,var(--surface-panel) 97%,var(--accent))}.coding-page .coding-coordination>header>span{min-width:0}.coding-page .coding-coordination>header small,.coding-page .coding-coordination>header strong{display:block}.coding-page .coding-coordination>header small{margin-bottom:3px;color:var(--accent-strong);font:750 8px/1.2 var(--font-mono);letter-spacing:.075em;text-transform:uppercase}.coding-page .coding-coordination>header strong{overflow:hidden;font-size:14px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-coordination>header em{flex:none;padding:5px 8px;border:1px solid var(--border-strong);border-radius:var(--radius-pill);color:var(--text-secondary);background:var(--surface-inset);font:650 8px/1.2 var(--font-mono);font-style:normal}.coding-page .coding-coordination[data-state="working"]>header em{border-color:color-mix(in srgb,var(--accent) 42%,var(--border-strong));color:var(--accent-strong);background:color-mix(in srgb,var(--accent) 8%,var(--surface-inset))}.coding-page .coding-coordination[data-state="blocked"]>header em{border-color:var(--danger-border);color:var(--danger);background:var(--danger-surface)}.coding-page .coding-coordination[data-state="done"]>header em{border-color:var(--success-border);color:var(--success);background:var(--success-surface)}
.coding-page .coding-coordination-runtime{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 15px 8px;border-bottom:1px solid var(--border-subtle);background:var(--surface-inset)}.coding-page .coding-coordination-runtime span{color:var(--text-tertiary);font:650 7px/1.2 var(--font-mono);letter-spacing:.055em;text-transform:uppercase}.coding-page .coding-coordination-runtime strong{min-width:0;overflow:hidden;color:var(--text-primary);font:650 8px/1.3 var(--font-mono);text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-coordination-summary{margin:0;padding:10px 15px 9px;color:var(--text-secondary);font-size:10px;line-height:1.45;text-wrap:pretty}.coding-page .coding-coordination-counts{display:flex;flex-wrap:wrap;gap:7px;padding:0 15px 11px}.coding-page .coding-coordination-counts span{padding:4px 7px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-tertiary);background:var(--surface-inset);font:7px/1 var(--font-mono)}.coding-page .coding-coordination-counts b{color:var(--text-primary);font:inherit}.coding-page [data-coding-coordination-body]>ol{display:grid;margin:0;padding:0 10px 4px;list-style:none}.coding-page [data-coding-coordination-body]>ol>li:not(.coding-coordination-stage){position:relative;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 9px;padding:11px 7px 12px 12px;border-top:1px solid var(--border-subtle)}.coding-page [data-coding-coordination-body]>ol>li:not(.coding-coordination-stage)::before{position:absolute;left:0;top:17px;width:6px;height:6px;border-radius:50%;background:var(--text-tertiary);content:""}.coding-page [data-coding-coordination-body]>ol>li[data-state="working"]::before{background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 10%,transparent);animation:coding-pulse 1.8s ease-in-out infinite}.coding-page [data-coding-coordination-body]>ol>li[data-state="done"]::before{background:var(--success)}.coding-page [data-coding-coordination-body]>ol>li[data-state="blocked"]::before{background:var(--danger)}.coding-page [data-coding-coordination-body]>ol>li[data-state="waiting"]::before{background:var(--warning)}.coding-page .coding-coordination-stage{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 7px 5px 2px;color:var(--text-tertiary);font:700 7px/1.25 var(--font-mono);letter-spacing:.065em;text-transform:uppercase}.coding-page .coding-coordination-stage:not(:first-child){margin-top:3px;border-top:1px solid var(--border-default)}.coding-page .coding-coordination-stage span{color:var(--accent-strong)}.coding-page .coding-coordination-stage small{font:inherit;letter-spacing:.02em;text-align:right;text-transform:none}.coding-page .coding-coordination-person{min-width:0;display:grid;grid-template-columns:30px minmax(0,1fr);gap:8px;align-items:center}.coding-page .coding-coordination-avatar{width:30px;height:30px}.coding-page .coding-coordination-avatar svg{width:14px;height:14px}.coding-page .coding-coordination-live-avatar{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--accent-strong);background:var(--surface-inset);font:700 10px/1 var(--font-ui)}.coding-page .coding-coordination-person>span{min-width:0}.coding-page .coding-coordination-person strong,.coding-page .coding-coordination-person small,.coding-page .coding-coordination-person em{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-coordination-person strong{font-size:11px}.coding-page .coding-coordination-person small{margin-top:1px;color:var(--text-secondary);font-size:8px}.coding-page .coding-coordination-person em{margin-top:2px;color:var(--accent-strong);font:650 7px/1.25 var(--font-mono);font-style:normal}.coding-page .coding-coordination-state{align-self:start;display:inline-flex;align-items:center;gap:5px;padding-top:3px;color:var(--text-secondary);font:650 7px/1.2 var(--font-mono);white-space:nowrap}.coding-page .coding-coordination-state i{width:5px;height:5px;border-radius:50%;background:var(--text-tertiary)}.coding-page .coding-coordination li[data-state="working"] .coding-coordination-state{color:var(--accent-strong)}.coding-page .coding-coordination li[data-state="working"] .coding-coordination-state i{background:var(--accent)}.coding-page .coding-coordination li[data-state="done"] .coding-coordination-state{color:var(--success)}.coding-page .coding-coordination li[data-state="done"] .coding-coordination-state i{background:var(--success)}.coding-page .coding-coordination li[data-state="blocked"] .coding-coordination-state{color:var(--danger)}.coding-page .coding-coordination li[data-state="blocked"] .coding-coordination-state i{background:var(--danger)}.coding-page .coding-coordination li[data-state="waiting"] .coding-coordination-state{color:var(--warning)}.coding-page .coding-coordination li[data-state="waiting"] .coding-coordination-state i{background:var(--warning)}.coding-page .coding-coordination li>p{grid-column:1/-1;margin:1px 0 0;color:var(--text-primary);font-size:10px;line-height:1.4}.coding-page .coding-coordination-context{grid-column:1/-1;min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin:1px 0 0}.coding-page .coding-coordination-context>div{min-width:0;padding:6px 7px;border:1px solid var(--border-subtle);border-radius:6px;background:var(--surface-inset)}.coding-page .coding-coordination-context dt,.coding-page .coding-coordination-context dd{display:block;overflow:hidden;margin:0;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-coordination-context dt{color:var(--text-tertiary);font:650 6px/1.2 var(--font-mono);letter-spacing:.055em;text-transform:uppercase}.coding-page .coding-coordination-context dd{margin-top:2px;color:var(--text-secondary);font-size:7px;line-height:1.3}.coding-page .coding-coordination-handoff{grid-column:1;min-width:0;display:flex;align-items:flex-start;gap:5px;color:var(--text-tertiary);font-size:8px;line-height:1.35}.coding-page .coding-coordination-handoff>span{color:var(--accent);font:10px/1 var(--font-mono)}.coding-page .coding-coordination li>button{align-self:end;padding:0;border:0;color:var(--accent-strong);background:transparent;cursor:pointer;font:650 8px/1.2 var(--font-ui);white-space:nowrap}.coding-page .coding-coordination li>button:hover{text-decoration:underline;text-underline-offset:3px}.coding-page .coding-coordination li>button span{margin-left:3px}.coding-page .coding-coordination-assembling{display:grid;grid-template-columns:8px minmax(0,1fr);gap:10px;align-items:start;margin:0 12px 10px;padding:12px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-page .coding-coordination-assembling>i{width:7px;height:7px;margin-top:4px;border-radius:50%;background:var(--accent);animation:coding-pulse 1.8s ease-in-out infinite}.coding-page .coding-coordination-assembling strong,.coding-page .coding-coordination-assembling small{display:block}.coding-page .coding-coordination-assembling strong{font-size:10px}.coding-page .coding-coordination-assembling small{margin-top:3px;color:var(--text-tertiary);font-size:8px;line-height:1.45}.coding-page .coding-coordination>footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;border-top:1px solid var(--border-subtle);background:var(--surface-inset)}.coding-page .coding-coordination>footer>span{color:var(--text-tertiary);font:7px/1.3 var(--font-mono)}.coding-page .coding-coordination>footer button{flex:none;padding:0;border:0;color:var(--text-primary);background:transparent;cursor:pointer;font-size:8px;font-weight:650}.coding-page .coding-coordination>footer button:hover{color:var(--accent-strong)}.coding-page .coding-coordination>footer button span{margin-left:3px}
.coding-page .coding-coordination-dag{margin:0 10px 8px;overflow:hidden;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-page .coding-coordination-dag>summary{min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;color:var(--text-primary);cursor:pointer;list-style:none}.coding-page .coding-coordination-dag>summary::-webkit-details-marker{display:none}.coding-page .coding-coordination-dag>summary::after{margin-left:2px;color:var(--text-tertiary);content:"⌄";font-size:11px;transition:transform .15s ease}.coding-page .coding-coordination-dag:not([open])>summary::after{transform:rotate(-90deg)}.coding-page .coding-coordination-dag>summary>span{min-width:0}.coding-page .coding-coordination-dag>summary strong,.coding-page .coding-coordination-dag>summary small{display:block}.coding-page .coding-coordination-dag>summary strong{font-size:10px}.coding-page .coding-coordination-dag>summary small{margin-top:2px;color:var(--text-tertiary);font-size:7px}.coding-page .coding-coordination-dag>summary em{margin-left:auto;color:var(--accent-strong);font:650 7px/1.25 var(--font-mono);font-style:normal;white-space:nowrap}.coding-page [data-coding-dag-body]{padding:0 8px 8px}.coding-page .coding-dag-stages{display:grid;gap:0;margin:0;padding:0;list-style:none}.coding-page .coding-dag-stage{position:relative;display:grid;gap:6px;padding:7px 0 5px}.coding-page .coding-dag-stage+.coding-dag-stage{margin-top:11px;border-top:1px solid var(--border-subtle)}.coding-page .coding-dag-stage+.coding-dag-stage::before{position:absolute;left:50%;top:-10px;width:1px;height:9px;background:var(--border-strong);content:""}.coding-page .coding-dag-stage+.coding-dag-stage::after{position:absolute;left:calc(50% - 3px);top:-4px;width:5px;height:5px;border-right:1px solid var(--accent);border-bottom:1px solid var(--accent);content:"";transform:rotate(45deg)}.coding-page .coding-dag-stage>header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 2px}.coding-page .coding-dag-stage>header span{color:var(--accent-strong);font:750 7px/1.2 var(--font-mono);letter-spacing:.06em;text-transform:uppercase}.coding-page .coding-dag-stage>header small{color:var(--text-tertiary);font:7px/1.2 var(--font-mono)}.coding-page .coding-dag-stage>ul{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:6px;margin:0;padding:0;list-style:none}.coding-page .coding-dag-task{min-width:0;display:grid;gap:4px;padding:8px;border:1px solid var(--border-subtle);border-left:2px solid var(--text-tertiary);border-radius:6px;background:var(--surface-panel)}.coding-page .coding-dag-task>header{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:7px}.coding-page .coding-dag-task>header strong{min-width:0;overflow:hidden;font-size:8px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-dag-task>header span{flex:none;color:var(--text-tertiary);font:650 6px/1.2 var(--font-mono);text-transform:uppercase}.coding-page .coding-dag-task>small{overflow:hidden;color:var(--text-secondary);font-size:7px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-dag-task>p{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px;margin:1px 0 0;color:var(--text-tertiary);font-size:7px;line-height:1.35}.coding-page .coding-dag-task>p span{color:var(--text-secondary);font:650 6px/1.35 var(--font-mono);text-transform:uppercase}.coding-page .coding-dag-task[data-state="running"],.coding-page .coding-dag-task[data-state="leased"]{border-left-color:var(--accent);background:color-mix(in srgb,var(--accent) 7%,var(--surface-panel))}.coding-page .coding-dag-task[data-state="ready"]{border-left-color:var(--warning)}.coding-page .coding-dag-task[data-state="accepted"],.coding-page .coding-dag-task[data-state="skipped"]{border-left-color:var(--success)}.coding-page .coding-dag-task[data-state="failed"],.coding-page .coding-dag-task[data-state="canceled"]{border-left-color:var(--danger)}.coding-page .coding-dag-task[data-state="running"]>header span,.coding-page .coding-dag-task[data-state="leased"]>header span{color:var(--accent-strong)}.coding-page .coding-dag-task[data-state="ready"]>header span{color:var(--warning)}.coding-page .coding-dag-task[data-state="accepted"]>header span,.coding-page .coding-dag-task[data-state="skipped"]>header span{color:var(--success)}.coding-page .coding-dag-task[data-state="failed"]>header span,.coding-page .coding-dag-task[data-state="canceled"]>header span{color:var(--danger)}.coding-page .coding-coordination-dag>footer{display:flex;flex-wrap:wrap;gap:5px;padding:7px 9px;border-top:1px solid var(--border-subtle)}.coding-page .coding-coordination-dag>footer span{display:inline-flex;align-items:center;gap:4px;color:var(--text-tertiary);font:6px/1.2 var(--font-mono);text-transform:uppercase}.coding-page .coding-coordination-dag>footer span::before{width:5px;height:5px;border-radius:50%;background:var(--text-tertiary);content:""}.coding-page .coding-coordination-dag>footer span[data-state="running"]::before{background:var(--accent)}.coding-page .coding-coordination-dag>footer span[data-state="ready"]::before{background:var(--warning)}.coding-page .coding-coordination-dag>footer span[data-state="accepted"]::before{background:var(--success)}.coding-page .coding-coordination-dag>footer span[data-state="failed"]::before{background:var(--danger)}.coding-page .coding-dag-empty{margin:0;padding:9px;color:var(--text-tertiary);font-size:8px;line-height:1.4;text-align:center}
.coding-page .coding-room{position:sticky;z-index:5;top:0;min-height:68px;display:grid;grid-template-columns:minmax(0,1fr) auto;padding:11px clamp(22px,4vw,52px);gap:4px 18px;border-bottom:1px solid var(--border-subtle);background:color-mix(in srgb,var(--surface-canvas) 96%,transparent);backdrop-filter:blur(16px)}
.coding-page .coding-room-heading{min-width:0;display:flex;align-items:center;gap:9px}.coding-page .coding-room-orb{width:20px;height:20px;display:grid;place-items:center;flex:none;border:1px solid var(--border-subtle);border-radius:50%;background:var(--surface-inset)}.coding-page .coding-room-orb canvas{width:20px;height:20px;display:block}.coding-page .coding-room-kind{display:none}.coding-page .coding-room h2{min-width:0;overflow:hidden;margin:0;font-size:20px;line-height:1.25;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-room-state{display:inline-flex;align-items:center;gap:6px;font-size:11px;white-space:nowrap}.coding-page .coding-room-state i{width:7px;height:7px;border-radius:50%;background:var(--success)}.coding-page .coding-room[data-room-state="waiting"] .coding-room-state i{background:var(--warning)}.coding-page .coding-room[data-room-state="archived"] .coding-room-state i{background:var(--text-tertiary)}
.coding-page .coding-room-topic{grid-column:1;max-width:72ch;overflow:hidden;margin:0;color:var(--text-secondary);font-size:11px;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-room-social{grid-column:2;grid-row:1/3;display:flex;align-items:center;justify-content:flex-end;gap:8px}.coding-page .coding-room-social>ul{display:flex;align-items:center;margin:0;padding-left:6px;list-style:none}.coding-page .coding-room-social li{display:flex;align-items:center;margin-left:-6px}.coding-page .coding-room-social li>span:last-child{display:none}.coding-page .coding-room-social>p{max-width:180px;margin:0;font-size:10px}.coding-page .coding-room-social>p strong,.coding-page .coding-room-social>p span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-room-details-toggle{min-height:34px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:1px solid var(--border-subtle);border-radius:8px;color:var(--text-secondary);background:var(--surface-raised);cursor:pointer;font-size:10px;font-weight:650}.coding-page .coding-room-details-toggle:hover,.coding-page .coding-room-details-toggle[aria-expanded="true"]{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-room-details-toggle:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.coding-page .coding-room-avatar{width:30px;height:30px;border:2px solid var(--surface-canvas);border-radius:50%}.coding-page .coding-room-branch{grid-column:1;min-width:0;display:flex;align-items:center;gap:7px;font-size:11px}.coding-page .coding-room-branch code{min-width:0;overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.coding-page .coding-room-tabs{grid-column:1/-1;height:42px;display:flex;align-items:flex-end;gap:24px;margin-top:5px}.coding-page .coding-room-tabs button{height:42px;min-width:64px;display:inline-flex;align-items:center;padding:0;border:0;border-bottom:2px solid transparent;color:var(--text-secondary);background:transparent;cursor:pointer;font-size:13px}.coding-page .coding-room-tabs button:hover{color:var(--text-primary)}.coding-page .coding-room-tabs button[aria-selected="true"]{border-bottom-color:var(--accent);color:var(--text-primary)}
.coding-page .coding-thread{display:grid;gap:0;margin:0;padding:14px 0 30px;list-style:none;scroll-margin-top:72px}
.coding-page .coding-message,.coding-page .coding-message.user{display:grid;grid-template-columns:40px minmax(0,1fr);gap:12px;align-items:start;padding:9px clamp(22px,4vw,52px)}.coding-page .coding-message:hover{background:color-mix(in srgb,var(--surface-hover) 52%,transparent)}
.coding-page .coding-message-avatar,.coding-page .coding-message.user .coding-message-avatar{width:40px;height:40px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:9px;color:var(--text-primary);background:var(--surface-raised);font-size:13px;font-weight:700}
.coding-page .coding-message article,.coding-page .coding-message.user article{width:min(900px,100%);max-width:100%;padding:0;border:0;border-radius:0;background:transparent}
.coding-page .coding-message article{min-width:0}.coding-page .coding-message article header{min-height:20px;display:flex;align-items:center;gap:8px}.coding-page .coding-message article header strong{font-size:14px}.coding-page .coding-message article header span{color:var(--text-tertiary);font-size:11px}
.coding-page .coding-message[data-conversation-kind="human-message"]{padding-block:12px}.coding-page .coding-message[data-conversation-kind="human-message"]>article{width:min(780px,100%);padding:13px 15px;border:1px solid color-mix(in srgb,var(--accent) 18%,var(--border-subtle));border-radius:12px;background:color-mix(in srgb,var(--accent) 4%,var(--surface-panel));box-shadow:0 1px 0 rgba(255,255,255,.025)}.coding-page .coding-message[data-conversation-kind="human-message"]>.coding-message-avatar{border-color:color-mix(in srgb,var(--accent) 34%,var(--border-strong));color:var(--accent-strong);background:color-mix(in srgb,var(--accent) 8%,var(--surface-raised))}
.coding-page .coding-message[data-conversation-kind="node-message"]{padding-block:11px}.coding-page .coding-message[data-conversation-kind="node-message"]>article{width:min(820px,100%)}
.coding-page .coding-message[data-conversation-kind="activity-event"]{margin:6px clamp(22px,4vw,52px);padding:10px 12px!important;border:1px solid var(--border-subtle)!important;border-radius:10px!important;background:color-mix(in srgb,var(--surface-inset) 72%,transparent)!important}.coding-page .coding-message[data-conversation-kind="activity-event"]>.coding-message-avatar{width:32px;height:32px;border-radius:8px;background:var(--surface-panel)}.coding-page .coding-message[data-conversation-kind="activity-event"]>article{align-self:center}.coding-page .coding-message[data-conversation-kind="activity-event"] article>p{font-size:13px;line-height:1.45}.coding-page .coding-message[data-conversation-kind="activity-event"] article>small{color:var(--text-tertiary)}
.coding-page .coding-message[data-conversation-kind="artifact-card"]>article{padding:14px 15px;border:1px solid var(--border-default);border-radius:12px;background:var(--surface-panel);box-shadow:var(--shadow-card)}.coding-page [data-conversation-kind="artifact-card"].coding-result{border-color:color-mix(in srgb,var(--accent) 18%,var(--border-default));background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 4%,var(--surface-panel)),var(--surface-panel))}
.coding-page .coding-message article header .coding-runtime{margin-left:4px;padding:2px 7px;font-size:10px}
.coding-page .coding-message-address{display:inline-flex;align-items:center;gap:4px;color:var(--text-tertiary)!important;font-family:var(--font-mono);font-size:10px!important}.coding-page .coding-message-address>span[aria-hidden]{color:var(--text-tertiary)}.coding-page .coding-message-tags{display:flex;flex-wrap:wrap;gap:4px;margin:5px 0 1px;padding:0;list-style:none}.coding-page .coding-message-tags li{max-width:210px;overflow:hidden;padding:2px 6px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-tertiary);background:var(--surface-inset);font:9px/1.35 var(--font-mono);text-overflow:ellipsis;white-space:nowrap}
.coding-page .coding-message-author-link{padding:0;border:0;color:inherit;background:transparent;cursor:pointer;font:inherit;text-decoration:none}.coding-page .coding-message-author-link:hover{text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:3px}.coding-page .coding-message-author-link:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;border-radius:3px}.coding-page [data-coding-team-snapshot][data-state="blocked"] article{border-color:var(--danger-border);background:color-mix(in srgb,var(--danger-surface) 48%,var(--surface-panel))}
.coding-page .coding-message article p,.coding-page .coding-message-body{max-width:80ch;margin:4px 0 0;color:var(--text-primary);font-size:15px;line-height:1.55;overflow-wrap:anywhere}.coding-page .coding-message article p{white-space:pre-wrap}
.coding-page .coding-message-run-status-link{width:max-content;max-width:100%;display:inline-flex;align-items:center;margin-top:9px;color:var(--accent-strong);font-size:11px;font-weight:700;text-decoration:none;text-underline-offset:3px}.coding-page .coding-message-run-status-link:hover{text-decoration:underline}.coding-page .coding-message-run-status-link:focus-visible{outline:2px solid var(--focus-ring);outline-offset:3px;border-radius:3px}.coding-page #coding-run-status{scroll-margin-top:84px}
.coding-page .coding-message-images{max-width:720px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:7px 0 6px}.coding-page .coding-message-images figure{min-width:0;margin:0}.coding-page .coding-message-images img{width:100%;max-height:420px;display:block;object-fit:contain;border:1px solid var(--border-subtle);border-radius:10px;background:var(--surface-inset)}.coding-page .coding-message-images figcaption{overflow:hidden;margin-top:3px;color:var(--text-tertiary);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-message-images:has(figure:only-child){grid-template-columns:minmax(0,560px)}
.coding-page .coding-message-body{margin-top:4px;overflow-wrap:anywhere;text-wrap:pretty}.coding-page .coding-message-body>:first-child{margin-top:0}.coding-page .coding-message-body>:last-child{margin-bottom:0}.coding-page .coding-message-body p{margin:0 0 9px;white-space:normal}.coding-page .coding-message-body ul,.coding-page .coding-message-body ol{display:grid;gap:5px;margin:9px 0 12px;padding-left:21px}.coding-page .coding-message-body li{padding-left:2px}.coding-page .coding-message-body li::marker{color:var(--text-tertiary)}.coding-page .coding-message-body code{padding:1px 4px;border:1px solid var(--border-subtle);border-radius:4px;color:var(--accent-strong);background:var(--surface-inset);font-size:.9em}.coding-page .coding-message-body pre{max-width:100%;overflow:auto;margin:10px 0;padding:11px 12px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-page .coding-message-body pre code{padding:0;border:0;background:transparent}.coding-page .coding-message-body blockquote{margin:10px 0;padding-left:12px;border-left:2px solid var(--border-strong);color:var(--text-secondary)}.coding-page .coding-message-body a{color:var(--accent-strong);text-underline-offset:2px}.coding-page .coding-message-body h1,.coding-page .coding-message-body h2,.coding-page .coding-message-body h3{margin:14px 0 6px;font-size:15px;line-height:1.35}.coding-page .coding-mermaid-diagram{max-width:100%;display:grid;gap:5px;margin:12px 0;padding:14px;border:1px solid var(--border-subtle);border-radius:var(--radius-card);background:var(--surface-inset)}.coding-page .coding-mermaid-canvas{min-width:0;overflow:auto;text-align:center}.coding-page .coding-mermaid-canvas svg{max-width:100%;height:auto}.coding-page .coding-mermaid-source{justify-self:start}.coding-page .coding-mermaid-source>summary{color:var(--text-tertiary);cursor:pointer;font-size:9px}.coding-page .coding-mermaid-source>pre{max-height:240px;margin:6px 0 0}
.coding-page .coding-message-thinking:hover{background:transparent}.coding-page .coding-message-thinking .coding-message-thinking-orb{width:40px;height:40px;display:grid;place-items:center;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--accent) 12%,transparent),transparent 68%);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 18%,transparent)}.coding-page .coding-message-thinking-orb canvas{width:34px;height:34px}.coding-page .coding-message-thinking article{align-self:center}
.coding-page .coding-message-delivery{margin-top:5px;font-size:11px}
.coding-page .coding-message-evidence{max-width:720px;margin-top:8px;color:var(--text-tertiary);font-size:10px}.coding-page .coding-message-evidence>summary{width:max-content;max-width:100%;display:flex;align-items:center;gap:5px;padding:3px 0;color:var(--text-tertiary);cursor:pointer;font-size:10px;font-weight:650;list-style:none}.coding-page .coding-message-evidence>summary::-webkit-details-marker{display:none}.coding-page .coding-message-evidence>summary:hover,.coding-page .coding-message-evidence[open]>summary{color:var(--accent-strong)}.coding-page .coding-message-evidence>summary:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;border-radius:3px}.coding-page .coding-message-evidence>div{display:grid;gap:7px;margin-top:5px;padding:9px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-page .coding-message-evidence dl{display:grid;gap:5px;margin:0}.coding-page .coding-message-evidence dl>div{min-width:0;display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px}.coding-page .coding-message-evidence dt{color:var(--text-tertiary);font:700 8px/1.4 var(--font-mono);text-transform:uppercase}.coding-page .coding-message-evidence dd{min-width:0;margin:0;color:var(--text-secondary);font:9px/1.45 var(--font-mono);overflow-wrap:anywhere}.coding-page .coding-message-evidence a{width:max-content;max-width:100%;color:var(--accent-strong);font-size:9px;font-weight:650;text-decoration:none}.coding-page .coding-message-evidence a:hover{text-decoration:underline;text-underline-offset:3px}.coding-page .coding-message-evidence a:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px;border-radius:3px}
.coding-page .coding-progress-post article{padding-block:3px}.coding-page .coding-progress-post footer{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:7px;color:var(--text-tertiary);font:9px/1.35 var(--font-mono)}.coding-page .coding-progress-post footer time{margin-right:2px;font-variant-numeric:tabular-nums}.coding-page .coding-progress-post-label,.coding-page .coding-progress-post-live{display:inline-flex;align-items:center;min-height:18px;padding:1px 6px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);background:var(--surface-inset);font:700 8px/1 var(--font-ui)}.coding-page .coding-progress-post-label{color:var(--text-secondary)}.coding-page .coding-progress-post-live{gap:4px;color:var(--accent-strong);cursor:help}.coding-page .coding-progress-post-live::before{width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 13%,transparent);content:""}
.coding-page .coding-run-progress.coding-message{grid-template-columns:40px minmax(0,1fr);gap:12px;padding:10px clamp(22px,4vw,52px);border:0;border-radius:0;background:transparent}
.coding-page .coding-run-progress.coding-message:hover{background:color-mix(in srgb,var(--surface-hover) 52%,transparent)}.coding-page .coding-run-progress .coding-run-progress-avatar{display:grid;place-items:center}.coding-page .coding-run-progress-mark{display:block;width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 14%,transparent)}.coding-page .coding-run-progress[data-state="working"] .coding-run-progress-mark{animation:coding-pulse 1.8s ease-in-out infinite}.coding-page .coding-run-progress[data-state="waiting"] .coding-run-progress-mark{background:var(--warning)}.coding-page .coding-run-progress[data-state="completed"] .coding-run-progress-mark{background:var(--success)}.coding-page .coding-run-progress[data-state="failed"] .coding-run-progress-mark,.coding-page .coding-run-progress[data-connection="stale"] .coding-run-progress-mark{background:var(--danger);animation:none}.coding-page .coding-run-progress article>p{margin:2px 0 0;font-size:14px}.coding-page .coding-run-progress article>small{display:block;margin-top:3px;font-size:11px}.coding-page .coding-run-live-clock{width:max-content;max-width:100%;align-items:center;gap:6px;margin-top:7px!important;padding:4px 8px;border:1px solid color-mix(in srgb,var(--accent) 28%,var(--border-subtle));border-radius:999px;color:var(--accent-strong);background:color-mix(in srgb,var(--accent) 7%,transparent);font:10px/1.2 var(--font-mono)!important}.coding-page .coding-run-live-clock:not([hidden]){display:inline-flex}.coding-page .coding-run-live-clock>i{width:6px;height:6px;flex:none;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 13%,transparent);animation:coding-pulse 1.8s ease-in-out infinite}.coding-page .coding-run-progress[data-connection="stale"] .coding-run-live-clock{border-color:var(--danger-border);color:var(--danger);background:var(--danger-surface)}.coding-page .coding-run-progress[data-connection="stale"] .coding-run-live-clock>i{background:var(--danger);box-shadow:none;animation:none}
.coding-page .coding-run-progress article>p.coding-run-recovery-copy{max-width:68ch;margin-top:10px;color:var(--text-secondary);font-size:11px}.coding-page .coding-retry-action{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 10px;align-items:center;margin-top:9px}.coding-page .coding-retry-action button{min-height:32px;padding:0 11px;border:1px solid var(--danger-border);border-radius:var(--radius-control);color:var(--text-primary);background:var(--surface-raised);cursor:pointer;font-size:9px;font-weight:700}.coding-page .coding-retry-action button:hover{border-color:var(--danger);background:var(--surface-hover)}.coding-page .coding-retry-action button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-page .coding-retry-action small{color:var(--text-tertiary);font-size:8px;line-height:1.4}.coding-page .coding-retry-action-compact{display:block}.coding-page .coding-retry-action-compact button{min-height:34px}
.coding-page .coding-run-delivery-actions{display:grid;gap:8px;margin-top:11px;padding:10px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-page .coding-run-merge-action,.coding-page .coding-run-close-action{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:9px}.coding-page .coding-run-merge-action button,.coding-page .coding-run-close-action button{min-height:36px;padding:0 13px;border-radius:var(--radius-control);cursor:pointer;font-size:10px;font-weight:750}.coding-page .coding-run-merge-action button{border:1px solid var(--action-primary);color:var(--action-primary-foreground);background:var(--action-primary)}.coding-page .coding-run-merge-action button:hover{background:var(--action-primary-hover)}.coding-page .coding-run-close-action button{border:1px solid var(--border-strong);color:var(--text-primary);background:var(--surface-raised)}.coding-page .coding-run-close-action button:hover{border-color:var(--text-secondary);background:var(--surface-hover)}.coding-page .coding-run-merge-action button:focus-visible,.coding-page .coding-run-close-action button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-page .coding-run-merge-action small,.coding-page .coding-run-close-action small{color:var(--text-tertiary);font-size:9px}
.coding-page .coding-inline-reply{margin-inline:clamp(22px,4vw,52px)}
.coding-page .coding-new-messages{position:relative;z-index:7;grid-column:1;grid-row:1;align-self:end;justify-self:end;margin:0 20px 12px;min-height:36px;display:inline-flex;align-items:center;gap:7px;padding:0 12px;border:1px solid color-mix(in srgb,var(--accent) 32%,var(--border-strong));border-radius:var(--radius-pill);color:var(--text-primary);background:var(--surface-overlay);box-shadow:var(--shadow-overlay);cursor:pointer;font-size:11px;font-weight:700}.coding-page .coding-new-messages[hidden]{display:none}.coding-page .coding-new-messages:hover{border-color:var(--accent);background:var(--surface-hover)}.coding-page .coding-new-messages:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.coding-page .coding-composer-wrap{z-index:2;grid-column:1;grid-row:2;min-width:0;padding:10px clamp(22px,4vw,52px) 22px;background:linear-gradient(180deg,transparent,var(--surface-canvas) 20%)}.coding-page .coding-conversation[data-room-view="work"]{grid-template-rows:minmax(0,1fr)}.coding-page .coding-conversation[data-room-view="work"] .coding-composer-wrap{display:none}.coding-page .coding-composer-grid{width:100%;max-width:none;margin:0;grid-template-columns:minmax(0,1fr);gap:0}
.coding-page .coding-composer{padding:11px 13px 9px;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18)}
.coding-page .coding-composer-speaker{margin-bottom:5px}.coding-page .coding-composer-speaker>span{width:28px;height:28px;font-size:10px}.coding-page .coding-composer-speaker strong{font-size:12px}.coding-page .coding-composer-speaker small{font-size:9px}
.coding-page .coding-composer textarea{min-height:48px;padding:5px 1px;font-size:15px;line-height:1.45}
.coding-page .coding-composer-help{margin-top:8px}.coding-page .coding-composer-help span{font-size:10px}
.coding-page .coding-composer-presence{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px -13px -9px;padding:8px 13px;border-top:1px solid var(--border-subtle);color:var(--text-tertiary);font-size:10px}.coding-page .coding-composer-presence>span{min-width:0;display:flex;align-items:center;gap:5px}.coding-page .coding-composer-presence i{width:7px;height:7px;flex:none;border-radius:50%;background:var(--success)}.coding-page .coding-composer-presence[data-state="working"] i{background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent);animation:coding-pulse 1.8s ease-in-out infinite}.coding-page .coding-composer-presence[data-state="blocked"] i{background:var(--danger)}.coding-page .coding-composer-presence strong{overflow:hidden;color:var(--text-primary);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-composer-runtime{justify-content:flex-end;overflow:hidden;font-family:var(--font-mono);font-size:9px}.coding-page .coding-composer-runtime span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.coding-page .coding-composer-select .ui-select-trigger,.coding-page .coding-composer-select select{min-height:34px;font-size:11px}
.coding-page .coding-composer button[type="submit"]{min-width:40px;min-height:36px;font-size:12px}
.coding-page .coding-inspector{position:static;z-index:auto;top:auto;right:auto;width:auto;height:auto;max-height:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;overflow:visible;padding:24px clamp(22px,4vw,52px) 40px;border:0;background:var(--surface-canvas);transition:none}.coding-page .coding-inspector[hidden]{display:none}
.coding-page .coding-room-context-head{grid-column:1/-1;display:grid;gap:2px;padding:0 0 4px;border:0}.coding-page .coding-room-context-head span{font-size:20px;font-weight:650}.coding-page .coding-room-context-head small{font-size:12px}
.coding-page .coding-inspector>.coding-result-island{grid-column:1/-1}.coding-page .coding-inspector>.coding-result-island:empty{display:none}
.coding-page .coding-inspector>.coding-result-island .coding-result{margin:0}
.coding-page .coding-inspector>.coding-git-handoff,.coding-page .coding-inspector>.coding-live,.coding-page .coding-work-updates,.coding-page .coding-inspector>.coding-operations{border:1px solid var(--border-subtle);border-radius:12px;background:var(--surface-panel);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.coding-page .coding-work-updates{grid-column:1/-1;overflow:hidden}
.coding-page .coding-work-updates>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border-bottom:1px solid var(--border-subtle)}
.coding-page .coding-work-updates>header span{min-width:0}.coding-page .coding-work-updates>header strong,.coding-page .coding-work-updates>header small{display:block}
.coding-page .coding-work-updates>header strong{font-size:14px}.coding-page .coding-work-updates>header small{margin-top:2px;color:var(--text-tertiary);font-size:11px}
.coding-page .coding-work-updates>header em{min-width:24px;height:24px;display:grid;place-items:center;border-radius:999px;color:var(--text-secondary);background:var(--surface-inset);font-size:11px;font-style:normal}
.coding-page .coding-work-thread{padding:8px 0 12px}.coding-page .coding-work-thread .coding-message{padding:10px 16px}.coding-page .coding-work-thread .coding-message article{width:100%}
.coding-page .coding-work-updates-empty{margin:0;padding:18px 16px;color:var(--text-tertiary);font-size:12px}
.coding-page .coding-inspector>.coding-operations{grid-column:1/-1}.coding-page .coding-operations>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--text-secondary);cursor:pointer;list-style:none}.coding-page .coding-operations>summary::-webkit-details-marker{display:none}.coding-page .coding-operations>summary:hover,.coding-page .coding-operations[open]>summary{color:var(--text-primary);background:var(--surface-hover)}.coding-page .coding-operations>summary strong,.coding-page .coding-operations>summary small{display:block}.coding-page .coding-operations>summary i{font-style:normal;transition:transform .14s ease}.coding-page .coding-operations[open]>summary i{transform:rotate(180deg)}
.coding-page .coding-git-handoff>header,.coding-page .coding-live>header{min-height:48px;padding:12px 14px}.coding-page .coding-git-handoff>header strong,.coding-page .coding-live-copy strong{font-size:13px}.coding-page .coding-git-handoff>header small,.coding-page .coding-live-copy small,.coding-page .coding-live-metrics{font-size:10px}
.coding-page .coding-git-handoff-body{padding:10px 14px 14px}.coding-page .coding-git-handoff dl>div{grid-template-columns:84px minmax(0,1fr);padding:9px 0}.coding-page .coding-git-handoff dt{font-size:9px}.coding-page .coding-git-handoff dd,.coding-page .coding-git-handoff dd strong,.coding-page .coding-git-handoff dd code{font-size:11px}.coding-page .coding-git-handoff dd small{font-size:10px}
.coding-page .coding-git-handoff-note{font-size:11px}.coding-page .coding-git-actions a,.coding-page .coding-git-actions button,.coding-page .coding-git-actions>span{min-height:34px;font-size:11px}.coding-page .coding-git-actions .coding-git-close-action button{border-color:var(--border-strong);color:var(--text-primary);background:var(--surface-raised)}
.coding-page .coding-run-team-label span,.coding-page .coding-run-team-label strong{font-size:11px}.coding-page .coding-run-team-help{font-size:10px}
.coding-page .coding-agent-link{grid-template-columns:34px minmax(0,1fr) auto;padding:9px}.coding-page .coding-agent-link strong{font-size:12px}.coding-page .coding-agent-link small,.coding-page .coding-agent-row-meta em,.coding-page .coding-agent-row-meta small{font-size:10px}
.coding-page .coding-operations>summary{min-height:54px;padding:12px 14px}.coding-page .coding-operations>summary strong{font-size:13px}.coding-page .coding-operations>summary small{font-size:10px}
.coding-page .coding-work-status{display:grid;gap:8px;padding:14px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-page .coding-work-status>header{display:flex;justify-content:space-between;gap:12px}.coding-page .coding-work-status>header strong{font-size:13px}.coding-page .coding-work-status>header span{font-size:11px}.coding-page .coding-work-status>p{margin:0;font-size:13px}.coding-page .coding-work-status dl{display:grid;gap:7px;margin:0}.coding-page .coding-work-status dl>div{display:grid;grid-template-columns:92px minmax(0,1fr);gap:9px}.coding-page .coding-work-status dt{font-size:10px}.coding-page .coding-work-status dd{margin:0;font-size:11px}
.coding-page .coding-workspace-loading{display:grid;gap:8px;padding:12px}
.coding-page .coding-workspace-loading>span{height:36px;border-radius:7px;background:linear-gradient(90deg,var(--surface-inset),var(--surface-hover),var(--surface-inset));background-size:220% 100%;animation:coding-workspace-shimmer 1.3s ease-in-out infinite}
.coding-page .coding-workspace-loading>span:nth-child(2){width:88%}.coding-page .coding-workspace-loading>span:nth-child(3){width:94%}.coding-page .coding-workspace-loading>span:nth-child(4){width:78%}
.coding-page .coding-run-main{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,360px);align-items:start}.coding-page .coding-run-main-detached{grid-template-columns:minmax(0,1fr)}.coding-page .coding-error-island,.coding-page .coding-room{grid-column:1/-1}.coding-page .coding-room{min-height:68px}.coding-page .coding-room-live{grid-column:1;margin:0;color:var(--text-tertiary);font:9px/1.3 var(--font-mono)}.coding-page .coding-room-live[data-state="live"]{color:var(--success)}.coding-page .coding-room-live[data-state="paused"],.coding-page .coding-room-live[data-state="reconnecting"],.coding-page .coding-room-live[data-state="error"]{color:var(--warning)}
.coding-page .coding-room-timeline{min-width:0;border-right:1px solid var(--border-subtle)}.coding-page .coding-room-timeline>.coding-room-context-head{position:sticky;z-index:4;top:82px;padding:16px clamp(22px,4vw,52px) 8px;background:color-mix(in srgb,var(--surface-canvas) 96%,transparent);backdrop-filter:blur(14px)}.coding-page .coding-room-timeline>.coding-room-context-head span{font-size:14px}.coding-page .coding-room-timeline>.coding-room-context-head small{font-size:9px}.coding-page .coding-room-timeline>.coding-result-island{padding:0 clamp(22px,4vw,52px) 28px}.coding-page .coding-room-timeline-coordinating{display:grid;grid-template-columns:minmax(0,1fr)}.coding-page .coding-room-timeline-coordinating>.coding-coordination{position:static;grid-column:1;grid-row:auto;max-height:none;margin:0 clamp(22px,4vw,52px) 18px}
.coding-page .coding-context-cast.coding-inspector{position:sticky;top:0;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;max-height:calc(100dvh - 190px);overflow:auto;padding:16px 16px 20px;border-left:0;background:var(--surface-sidebar);scrollbar-width:thin}.coding-page .coding-context-cast>.coding-room-context-head{position:sticky;z-index:5;top:-16px;grid-column:1;margin:-16px -16px 0;padding:16px 16px 10px;border-bottom:1px solid var(--border-subtle);background:color-mix(in srgb,var(--surface-sidebar) 96%,transparent);backdrop-filter:blur(14px)}.coding-page .coding-context-cast>.coding-room-context-head span{font-size:15px}.coding-page .coding-context-cast>.coding-room-context-head small{font-size:9px;line-height:1.4}.coding-page .coding-context-cast>.coding-live,.coding-page .coding-context-cast>.coding-git-handoff,.coding-page .coding-context-cast>.coding-operations{grid-column:1;margin:0}.coding-page .coding-context-cast>.coding-live{padding:14px}
.coding-page .coding-context-cast>.coding-coordination{position:static;grid-column:1;grid-row:auto;max-height:none;margin:0;overflow:visible;box-shadow:none}.coding-page .coding-context-cast>.coding-coordination>header{position:static}.coding-page .coding-context-cast>.coding-coordination>footer{display:none}
.coding-page .coding-workbench-panel>.coding-team-activity{grid-column:1;margin:0}
.coding-page .coding-context-cast[data-layout="rail"]{z-index:3;grid-column:2;grid-row:1/-1;align-self:stretch;position:relative;top:auto;min-height:0;height:auto;max-height:none;margin-top:0;overflow:auto;border-left:1px solid var(--border-subtle)}.coding-page .coding-context-cast[data-layout="rail"][hidden]{display:none}
.coding-page .coding-context-frontier{padding:14px;border:1px solid var(--border-default);border-radius:var(--radius-card);background:var(--surface-panel)}.coding-page .coding-context-frontier>header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-context-frontier>header strong{font-size:11px}.coding-page .coding-context-frontier>header span{color:var(--text-tertiary);font:8px/1.2 var(--font-mono)}.coding-page .coding-context-frontier[data-state="certified"]>header span{color:var(--success)}.coding-page .coding-context-frontier dl{display:grid;gap:0;margin:0}.coding-page .coding-context-frontier dl>div{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;padding:8px 0;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-context-frontier dl>div:last-child{border-bottom:0}.coding-page .coding-context-frontier dt{color:var(--text-tertiary);font-size:8px}.coding-page .coding-context-frontier dd{min-width:0;overflow:hidden;margin:0;color:var(--text-secondary);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-context-frontier code{color:var(--accent-strong);font:8px/1.3 var(--font-mono)}
.coding-page .coding-context-cast .coding-collaboration-frontier{grid-template-columns:minmax(0,1fr);gap:4px;padding:8px 0 12px}.coding-page .coding-context-cast .coding-collaboration-frontier>span,.coding-page .coding-context-cast .coding-collaboration-frontier>small,.coding-page .coding-context-cast .coding-collaboration-frontier>p,.coding-page .coding-context-cast .coding-collaboration-frontier>code{grid-column:1;min-width:0}.coding-page .coding-context-cast .coding-collaboration-frontier>small{overflow-wrap:anywhere;line-height:1.45}
.coding-page .coding-realtime-cast{display:grid;gap:6px;margin:0;padding:0;list-style:none}.coding-page .coding-realtime-cast:empty{display:none}.coding-page .coding-realtime-cast>li{border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-panel)}.coding-page .coding-realtime-cast button{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:10px;border:0;color:var(--text-primary);background:transparent;cursor:pointer;text-align:left}.coding-page .coding-realtime-cast button:hover{background:var(--surface-hover)}.coding-page .coding-realtime-cast button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-page .coding-realtime-cast button strong,.coding-page .coding-realtime-cast button span,.coding-page .coding-realtime-cast button em{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-realtime-cast button strong{font-size:10px}.coding-page .coding-realtime-cast button span{grid-column:1;color:var(--text-secondary);font-size:8px}.coding-page .coding-realtime-cast button em{grid-column:1;color:var(--accent-strong);font:650 7px/1.3 var(--font-mono);font-style:normal}.coding-page .coding-realtime-cast button small{grid-column:2;grid-row:1/4;color:var(--text-tertiary);font:8px/1.3 var(--font-mono)}.coding-page [data-slot="cast-member-technical"]{padding:0 10px 9px}.coding-page [data-slot="cast-member-technical"] dl{margin:0}.coding-page [data-slot="cast-member-technical"] dl>div{display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px;padding:5px 0;border-top:1px solid var(--border-subtle)}.coding-page [data-slot="cast-member-technical"] dt{color:var(--text-tertiary);font-size:7px}.coding-page [data-slot="cast-member-technical"] dd{overflow:hidden;margin:0;color:var(--text-secondary);font:8px/1.3 var(--font-mono);text-overflow:ellipsis;white-space:nowrap}
.coding-page .coding-team-activity{margin:6px clamp(22px,4vw,52px) 16px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset);overflow:hidden}.coding-page .coding-team-activity[hidden]{display:none}.coding-page .coding-team-activity>summary{min-height:42px;display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:8px 11px;cursor:pointer;list-style:none}.coding-page .coding-team-activity>summary::-webkit-details-marker{display:none}.coding-page .coding-team-activity>summary>span{min-width:0;display:grid;gap:2px}.coding-page .coding-team-activity>summary strong{font-size:10px}.coding-page .coding-team-activity>summary small{overflow:hidden;color:var(--text-tertiary);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-team-activity>summary>b{min-width:24px;padding:4px 6px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--text-secondary);font:7px/1 var(--font-mono);text-align:center}.coding-page .coding-team-activity>summary>i{color:var(--text-tertiary);font-style:normal;transition:transform .16s ease}.coding-page .coding-team-activity[open]>summary>i{transform:rotate(180deg)}.coding-page .coding-team-activity>ol{max-height:360px;overflow:auto;margin:0;padding:2px 0 7px;border-top:1px solid var(--border-subtle);list-style:none;overscroll-behavior:contain}.coding-page [data-slot="timeline-entry"]{display:grid;grid-template-columns:10px minmax(0,1fr);gap:8px;padding:8px 11px;list-style:none}.coding-page [data-slot="timeline-marker"]{width:6px;height:6px;margin-top:5px;border-radius:50%;background:var(--accent)}.coding-page [data-slot="timeline-entry"][data-kind="attention"] [data-slot="timeline-marker"]{background:var(--warning)}.coding-page [data-slot="timeline-entry"][data-kind="checkpoint"] [data-slot="timeline-marker"]{background:var(--success)}.coding-page [data-slot="timeline-card"]{min-width:0}.coding-page [data-slot="timeline-card"]>header{display:flex;align-items:center;gap:7px}.coding-page [data-slot="timeline-card"]>header strong{font-size:9px}.coding-page [data-slot="timeline-card"]>header span,.coding-page [data-slot="timeline-card"]>header time{color:var(--text-tertiary);font:7px/1.2 var(--font-mono)}.coding-page [data-slot="timeline-card"]>header time{margin-left:auto}.coding-page [data-slot="timeline-card"]>p{margin:3px 0 0;color:var(--text-secondary);font-size:9px;line-height:1.45;white-space:pre-wrap}.coding-page [data-slot="timeline-card"]>a{display:inline-block;margin-top:4px;color:var(--accent-strong);font-size:8px;text-decoration:none}.coding-page [data-slot="timeline-card"]>a:hover{text-decoration:underline;text-underline-offset:2px}.coding-page [data-slot="timeline-history"]{display:grid;place-items:center;padding:8px}.coding-page [data-slot="timeline-history"] button{min-height:30px;padding:0 9px;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-raised);cursor:pointer;font-size:8px}
.coding-page .coding-context-cast.coding-inspector{grid-auto-rows:max-content;align-content:start;overscroll-behavior:contain}
.coding-page .coding-context-cast[data-layout="rail"]{height:100%;max-height:100%}
.coding-page .coding-room-empty{display:grid;gap:5px;margin:22px clamp(22px,4vw,52px);padding:22px;border:1px dashed var(--border-default);border-radius:var(--radius-card);color:var(--text-secondary);background:var(--surface-inset);text-align:center;list-style:none}.coding-page .coding-room-empty strong{color:var(--text-primary);font-size:13px}.coding-page .coding-room-empty span{font-size:10px;line-height:1.5}
@keyframes coding-workspace-shimmer{to{background-position:-220% 0}}
.coding-page .coding-coordination li>a{align-self:end;padding:0;color:var(--accent-strong);font:650 8px/1.2 var(--font-ui);text-decoration:none;white-space:nowrap}.coding-page .coding-coordination li>a:hover{text-decoration:underline;text-underline-offset:3px}.coding-page .coding-coordination li>a span{margin-left:3px}
.coding-page .coding-conversation:has(>.coding-context-cast[hidden]){grid-template-columns:minmax(0,1fr) 0}
.coding-page .coding-room[data-run-state="queued"] .coding-room-state i,.coding-page .coding-room[data-run-state="waiting"] .coding-room-state i{background:var(--warning)}.coding-page .coding-room[data-run-state="working"] .coding-room-state i{background:var(--accent)}.coding-page .coding-room[data-run-state="needs-attention"] .coding-room-state i,.coding-page .coding-room[data-run-state="stopped"] .coding-room-state i{background:var(--danger)}.coding-page .coding-room[data-run-state="preparing"] .coding-room-state i{background:var(--text-tertiary)}
.coding-page .coding-live[data-state="working"] .coding-live-copy>i{background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 10%,transparent);animation:coding-pulse 1.8s ease-in-out infinite}.coding-page .coding-live[data-state="complete"] .coding-live-copy>i{background:var(--success)}.coding-page .coding-live[data-state="needs-attention"] .coding-live-copy>i,.coding-page .coding-live[data-state="stopped"] .coding-live-copy>i{background:var(--danger)}
@media(max-width:1120px){.coding-page .coding-room-messages-coordinating{grid-template-columns:minmax(0,1fr)}.coding-page .coding-room-messages-coordinating>.coding-thread{grid-column:1;grid-row:2}.coding-page .coding-coordination{position:static;grid-column:1;grid-row:1;max-height:none;margin:16px 18px 0;overflow:hidden}.coding-page .coding-coordination>header{position:static}.coding-page .coding-coordination>ol{grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:0 12px}}
@media(max-width:820px){:root{--workspace-rail-width:224px}.coding-page .coding-room{padding-inline:18px}.coding-page .coding-message,.coding-page .coding-message.user,.coding-page .coding-run-progress.coding-message{padding-inline:18px}.coding-page .coding-composer-wrap,.coding-page .coding-inspector{padding-inline:18px}}
@media(max-width:700px){.coding-page .coding-workbench{grid-template-columns:minmax(0,1fr)}.coding-page .coding-project-rail{display:none}.coding-page .coding-room{min-height:auto}.coding-page .coding-room-social{display:none}.coding-page .coding-coordination{margin-inline:14px}.coding-page .coding-coordination>ol{grid-template-columns:minmax(0,1fr)}.coding-page .coding-inspector{grid-template-columns:minmax(0,1fr)}.coding-page .coding-inspector>.coding-result-island,.coding-page .coding-work-updates,.coding-page .coding-inspector>.coding-operations{grid-column:1}}
@media(max-width:920px){.coding-page .coding-conversation{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(180px,40dvh) auto}:root[data-coding-context-cast="closed"] .coding-page .coding-conversation{grid-template-rows:minmax(0,1fr) auto}.coding-page .coding-run-main{grid-template-columns:minmax(0,1fr)}.coding-page .coding-room-timeline{border-right:0}.coding-page .coding-context-cast.coding-inspector{position:static;max-height:none;border-top:1px solid var(--border-subtle)}.coding-page .coding-context-cast[data-layout="rail"]{grid-column:1;grid-row:2;min-height:0;margin-top:0;overflow:auto;border-left:0}.coding-page .coding-composer-wrap{grid-row:3}:root[data-coding-context-cast="closed"] .coding-page .coding-composer-wrap{grid-row:2}}
@media(max-width:520px){.coding-page .agent-top-nav{padding-inline:12px}.coding-page .top-navbar-status{display:none}.coding-page .coding-room{padding-inline:14px}.coding-page .coding-message,.coding-page .coding-message.user,.coding-page .coding-run-progress.coding-message{grid-template-columns:34px minmax(0,1fr);gap:10px;padding-inline:14px}.coding-page .coding-message-avatar,.coding-page .coding-message.user .coding-message-avatar{width:34px;height:34px}.coding-page .coding-composer-wrap,.coding-page .coding-inspector{padding-inline:14px}}
@media(pointer:coarse){.coding-page :is(button,summary,a.coding-mission-action){min-height:44px}.coding-page .coding-workbench-tab{padding-inline:12px}.coding-page .coding-room-empty{margin-inline:14px}}
@media(prefers-reduced-motion:reduce){.coding-page .coding-workspace-loading>span,.coding-page .coding-workspace-add-spinner,.coding-page .coding-run-progress[data-state="working"] .coding-run-progress-mark,.coding-page .coding-run-live-clock>i,.coding-page .coding-coordination>ol>li[data-state="working"]::before,.coding-page .coding-coordination-assembling>i{animation:none}.coding-page *{scroll-behavior:auto!important;transition-duration:.001ms!important;animation-duration:.001ms!important;animation-iteration-count:1!important}}
.coding-page .coding-composer-presence{display:none}
.coding-page [data-coding-room-transcript]{width:100%;max-width:none;margin:0;padding-block:12px 24px;padding-inline:clamp(16px,2vw,32px);list-style:none}
.coding-page .coding-social-row{width:100%;min-width:0;display:grid;grid-template-columns:40px minmax(0,1fr);gap:12px;align-items:start;padding:8px 0}
.coding-page .coding-social-row:hover{background:color-mix(in srgb,var(--surface-hover) 44%,transparent)}
.coding-page .coding-social-row .coding-message-avatar{width:40px;height:40px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:9px;color:var(--text-primary);background:var(--surface-raised);font-size:11px;font-weight:750}
.coding-page .coding-social-row-continuation .coding-message-avatar{visibility:hidden}.coding-page .coding-message-content{min-width:0;width:100%}
.coding-page .coding-message-meta{min-height:20px;display:flex;align-items:baseline;gap:7px}.coding-page .coding-message-meta strong{color:var(--text-primary);font-size:12px;font-weight:700}.coding-page .coding-message-meta>span,.coding-page .coding-message-meta time{color:var(--text-tertiary);font-size:10px}.coding-page .coding-message-meta time{font-variant-numeric:tabular-nums}
.coding-page .coding-message-recipients{display:flex;align-items:center;gap:5px;margin-top:1px;color:var(--text-tertiary);font-size:9px}.coding-page .coding-message-recipient{border-radius:3px;color:var(--accent-strong)}.coding-page .coding-message-evidence>summary:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.coding-page .coding-social-row .coding-message-body{max-width:90ch;margin-top:4px;color:var(--text-primary);font-size:14px;line-height:1.55;overflow-wrap:anywhere}.coding-page .coding-social-row .coding-message-body>:first-child{margin-top:0}.coding-page .coding-social-row .coding-message-body>:last-child{margin-bottom:0}
.coding-page .coding-social-row .coding-message-evidence{max-width:none;margin-top:5px}.coding-page .coding-social-row .coding-message-evidence>summary{width:max-content;border-radius:3px;color:var(--text-tertiary);cursor:pointer;font-size:9px;list-style:none}.coding-page .coding-social-row .coding-message-evidence>summary::-webkit-details-marker{display:none}.coding-page .coding-social-row .coding-message-evidence>div{max-width:none}.coding-page .coding-social-row .coding-message-evidence dl{margin:0}
.coding-page .coding-live-label{display:inline-flex;align-items:center;gap:5px;color:var(--accent-strong)!important;font-weight:650}.coding-page .coding-live-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:coding-social-presence 1.8s ease-in-out infinite}
.coding-page .coding-live-activity-item{margin:5px clamp(16px,2vw,32px);list-style:none}.coding-page .coding-live-activity{max-width:100%;overflow:hidden;border:1px solid var(--border-subtle);border-radius:10px;background:color-mix(in srgb,var(--surface-inset) 76%,transparent)}.coding-page .coding-live-activity>header{min-height:34px;display:flex;align-items:center;gap:7px;padding:7px 11px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-live-activity>header>i{width:7px;height:7px;flex:none;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 13%,transparent);animation:coding-social-presence 1.8s ease-in-out infinite}.coding-page .coding-live-activity>header>strong{font-size:10px}.coding-page .coding-live-activity>header>span{color:var(--text-tertiary);font-size:8px}.coding-page .coding-live-activity>ul{display:grid;margin:0;padding:0;list-style:none}.coding-page .coding-live-activity>ul>li{min-width:0;display:grid;grid-template-columns:minmax(80px,140px) minmax(150px,1fr) auto;gap:9px;align-items:center;padding:8px 11px;border-bottom:1px solid var(--border-subtle)}.coding-page .coding-live-activity>ul>li:last-child{border-bottom:0}.coding-page .coding-live-activity li>strong{overflow:hidden;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.coding-page .coding-live-activity li>span{color:var(--text-secondary);font-size:9px}.coding-page .coding-live-activity li>small{color:var(--text-tertiary);font:8px/1.3 var(--font-mono);white-space:nowrap}.coding-page .coding-live-activity time{font:inherit}
@keyframes coding-social-presence{50%{opacity:.35;transform:scale(.82)}}
.coding-page .coding-room{padding-inline:clamp(16px,2vw,32px)}.coding-page .coding-mission-bar,.coding-page .coding-team-brief{margin-inline:clamp(16px,2vw,32px)}
.coding-page .coding-composer-wrap{width:100%;padding-inline:clamp(16px,2vw,32px)}.coding-page .coding-composer-grid{width:100%;max-width:none}.coding-page .coding-conversation-scroll{scroll-padding-bottom:24px}
@media(min-width:900px){.coding-page .coding-mission-bar{grid-template-columns:minmax(0,.8fr) minmax(0,1.4fr) max-content;grid-template-areas:"copy pulse actions";align-items:center;gap:10px 14px;margin-block:8px;padding:10px 12px}.coding-page .coding-mission-cast{display:none}.coding-page .coding-mission-pulse{align-self:stretch;padding:0 14px;border-top:0;border-left:1px solid var(--border-subtle)}.coding-page .coding-mission-copy h3{font-size:12px}.coding-page .coding-mission-actions{align-items:center}}
@media(max-width:719px){.coding-page .coding-social-row{grid-template-columns:32px minmax(0,1fr);gap:10px}.coding-page .coding-social-row .coding-message-avatar{width:32px;height:32px}.coding-page .coding-message-meta{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px}.coding-page .coding-message-meta strong{grid-column:1}.coding-page .coding-message-meta .coding-agent-role{grid-column:1;grid-row:2}.coding-page .coding-message-meta time{grid-column:2;grid-row:2}.coding-page .coding-live-label{grid-column:2;grid-row:1}.coding-page .coding-live-activity>ul>li{grid-template-columns:minmax(0,1fr)}.coding-page .coding-live-activity li>small{white-space:normal}.coding-page .coding-conversation{--coding-composer-mobile-height:104px}.coding-page .coding-conversation-scroll{scroll-padding-bottom:var(--coding-composer-mobile-height)}.coding-page [data-coding-room-transcript]{padding-bottom:calc(var(--coding-composer-mobile-height) + 16px)}.coding-page .coding-composer-wrap{position:sticky;z-index:20;bottom:0;min-height:var(--coding-composer-mobile-height);padding-bottom:max(10px,env(safe-area-inset-bottom));background:var(--surface-canvas)}}
@media(prefers-reduced-motion:reduce){.coding-page .coding-live-dot,.coding-page .coding-live-activity>header>i{animation:none}}
`;

const codingReviewFileId = (index: number): string => `coding-review-file-${index + 1}`;

const codingReviewFileRailHtml = (parsed: CodingReviewFiles): string => `<nav class="coding-review-file-rail" aria-label="Changed files">
  <header><span><strong>Changed files</strong><small data-review-progress role="status" aria-live="polite">0 of ${new Intl.NumberFormat("en-US").format(parsed.files.length)} viewed</small></span><button type="button" data-review-next>Next unviewed <span aria-hidden="true">↓</span></button></header>
  <label class="coding-review-filter"><span class="sr-only">Filter changed files</span><span aria-hidden="true">⌕</span><input type="search" placeholder="Filter files" autocomplete="off" data-review-filter/></label>
  <progress class="coding-review-progress" data-review-progress-bar aria-hidden="true" value="0" max="${parsed.files.length}"></progress>
  <p class="coding-review-filter-empty" data-review-filter-empty hidden>No matching files</p>
  <ol>${parsed.files.map((file, index) => `<li data-review-file-item data-file-id="${codingReviewFileId(index)}" data-file-path="${esc(file.path.toLowerCase())}"><a href="#${codingReviewFileId(index)}" data-review-file-link aria-current="false"><span translate="no">${esc(file.path)}</span><small><em>${esc(reviewStatusLabel(file.status))}</em><span><b>+${file.additions}</b> <i>−${file.deletions}</i></span></small></a></li>`).join("")}</ol>
</nav>`;

const codingReviewPatchHtml = (parsed: CodingReviewFiles): string => {
  if (parsed.files.length === 0) {
    return `<section class="coding-review-empty"><strong>No stored patch</strong><p>The run has no reviewable patch in local storage.</p></section>`;
  }
  const files = parsed.files.map((file, index) => `<section class="coding-review-file" id="${codingReviewFileId(index)}" data-review-file-section>
    <header><span><strong translate="no">${esc(file.path)}</strong><small>${esc(reviewStatusLabel(file.status))}</small></span><span class="coding-review-file-actions"><span class="coding-review-counts"><b>+${file.additions}</b><i>−${file.deletions}</i></span><label class="coding-review-viewed"><input type="checkbox" data-review-viewed data-file-id="${codingReviewFileId(index)}"/><span>Viewed</span></label></span></header>
    <table class="coding-review-code"><caption class="sr-only">Diff for ${esc(file.path)}</caption><thead class="sr-only"><tr><th scope="col">Old line</th><th scope="col">New line</th><th scope="col">Change</th></tr></thead><tbody>${file.lines.map((line) => `<tr data-kind="${line.kind}"><td>${line.oldLine ?? ""}</td><td>${line.newLine ?? ""}</td><td><code>${esc(line.text || " ")}</code></td></tr>`).join("")}</tbody></table>
  </section>`).join("");
  return `${parsed.truncated ? `<p class="coding-review-notice">Showing the first ${MAX_REVIEW_LINES.toLocaleString("en-US")} patch lines. The stored patch is larger.</p>` : ""}${files}`;
};

const codingReviewExperienceCss = `.coding-review-page{width:100vw;max-width:none;height:100dvh;display:grid;grid-template-rows:56px 44px minmax(0,1fr);border-radius:0;background:var(--surface-canvas)}
.coding-review-toolbar{height:56px;gap:14px;padding:0 16px;background:color-mix(in srgb,var(--surface-panel) 96%,transparent);backdrop-filter:blur(14px)}.coding-review-back{width:32px;height:32px;font-size:14px}.coding-review-title{min-width:0;display:grid;gap:3px;align-items:center}.coding-review-title h1{font-size:14px!important}.coding-review-title span{max-width:42vw;font-size:9px}.coding-review-toolbar-meta{gap:10px}.coding-review-state,.coding-review-handoff{min-height:24px;display:inline-flex!important;align-items:center;padding:0 8px;border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--surface-inset)}.coding-review-state:before{width:5px;height:5px}.coding-review-state[data-tone="complete"]{border-color:var(--success-border);background:var(--success-surface)}.coding-review-state[data-tone="failed"]{border-color:var(--danger-border);background:var(--danger-surface)}.coding-review-handoff[data-tone="complete"]{border-color:var(--success-border)}.coding-review-handoff[data-tone="blocked"]{border-color:var(--warning-border)}
.coding-review-context{height:44px;gap:18px;padding:0 16px;background:var(--surface-sidebar)}.coding-review-context-copy{min-width:0;display:grid;gap:2px}.coding-review-context-copy strong{color:var(--ink);font-size:10px;font-weight:650}.coding-review-context-copy>span{overflow:hidden;color:var(--faint);font-size:8px;text-overflow:ellipsis;white-space:nowrap}.coding-review-context-stats{display:flex;align-items:center;gap:7px;margin-left:auto}.coding-review-stat{min-height:28px;display:inline-flex;align-items:center;gap:5px;padding:0 9px;border:1px solid var(--line-soft);border-radius:var(--radius-control);color:var(--muted);background:var(--surface-inset);font:8px/1 var(--font-mono);white-space:nowrap}.coding-review-stat b{color:var(--green)}.coding-review-stat i{color:var(--red);font-style:normal}.coding-review-context button{min-height:28px;padding:0 9px;border:1px solid var(--line);border-radius:var(--radius-control);color:var(--muted);background:var(--surface-raised);cursor:pointer;font:650 8px/1 var(--font-ui)}.coding-review-context button:hover,.coding-review-context button[aria-pressed="true"]{border-color:var(--border-strong);color:var(--ink);background:var(--surface-hover)}
.coding-review-workspace{grid-template-columns:240px minmax(0,1fr)}
.coding-review-file-rail{display:grid;grid-template-rows:auto auto 2px auto minmax(0,1fr);overflow:hidden}.coding-review-file-rail>header{position:static;height:auto;min-height:54px;padding:9px 10px}.coding-review-file-rail>header>span{min-width:0;display:grid;gap:3px}.coding-review-file-rail>header strong{font-size:10px}.coding-review-file-rail>header small{color:var(--faint);font:8px/1.2 var(--font-mono)}.coding-review-file-rail>header button{min-height:28px;padding:0 8px;border:1px solid var(--line);border-radius:var(--radius-control);color:var(--muted);background:var(--surface-raised);cursor:pointer;font:650 8px/1 var(--font-ui);white-space:nowrap}.coding-review-file-rail>header button:hover{color:var(--ink);background:var(--surface-hover)}.coding-review-file-rail>header button:disabled{opacity:.45;cursor:default}.coding-review-filter{height:40px;display:flex;align-items:center;gap:7px;margin:0;padding:0 10px;border-bottom:1px solid var(--line-soft);color:var(--faint);background:var(--surface-sidebar)}.coding-review-filter:focus-within{color:var(--blue)}.coding-review-filter input{min-width:0;width:100%;height:28px;padding:0;border:0;outline:0;color:var(--ink);background:transparent;font:9px/1 var(--font-ui)}.coding-review-filter input::placeholder{color:var(--faint)}.coding-review-progress{width:100%;height:2px;display:block;overflow:hidden;border:0;appearance:none;background:var(--surface-inset)}.coding-review-progress::-webkit-progress-bar{background:var(--surface-inset)}.coding-review-progress::-webkit-progress-value{background:var(--green);transition:width .18s ease}.coding-review-progress::-moz-progress-bar{background:var(--green);transition:width .18s ease}.coding-review-filter-empty{margin:0;padding:14px 10px;color:var(--faint);font-size:9px}.coding-review-file-rail ol{min-height:0;overflow:auto;margin:0;padding:5px 0;scrollbar-width:thin}.coding-review-file-rail li[data-viewed="true"] a{color:var(--faint)}.coding-review-file-rail li[data-viewed="true"] a:after{content:"✓";position:absolute;right:10px;top:12px;color:var(--green);font-size:9px}.coding-review-file-rail a{position:relative;padding:8px 28px 8px 10px}.coding-review-file-rail a[aria-current="true"]{border-left-color:var(--blue);color:var(--ink);background:var(--raised)}.coding-review-file-rail a>small{display:flex;align-items:center;justify-content:space-between;gap:8px}.coding-review-file-rail small em{overflow:hidden;color:var(--faint);font-style:normal;text-overflow:ellipsis}.coding-review-file-rail small span{flex:none}
.coding-review-file>header{left:0;width:calc(100vw - var(--rail));min-width:calc(100vw - var(--rail));max-width:calc(100vw - var(--rail));height:42px;padding:0 14px;background:color-mix(in srgb,var(--surface-panel) 96%,transparent);backdrop-filter:blur(10px)}.coding-review-file>header>span:first-child{display:flex;align-items:center;min-width:0}.coding-review-file strong{min-width:0;display:block;overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.coding-review-file small{flex:none;padding:2px 5px;border:1px solid var(--line);border-radius:var(--radius-pill);font-size:7px}.coding-review-file-actions{display:flex;align-items:center;gap:13px}.coding-review-viewed{min-height:26px;display:inline-flex;align-items:center;gap:6px;padding:0 8px;border:1px solid var(--line);border-radius:var(--radius-control);color:var(--muted);background:var(--surface-inset);cursor:pointer;font:650 8px/1 var(--font-ui)}.coding-review-viewed:hover{color:var(--ink);background:var(--surface-hover)}.coding-review-viewed input{width:12px;height:12px;margin:0;accent-color:var(--success)}.coding-review-file[data-viewed="true"]>.coding-review-file-actions,.coding-review-file[data-viewed="true"]>header{border-color:var(--success-border)}.coding-review-code{font-size:12px;line-height:1.55}.coding-review-code td{height:18px}.coding-review-code td:nth-child(1),.coding-review-code td:nth-child(2){position:sticky;z-index:1;background:inherit}.coding-review-code td:nth-child(1){left:0}.coding-review-code td:nth-child(2){left:42px}.coding-review-code td:nth-child(3){padding-inline:14px}.coding-review-code tr:hover{filter:brightness(1.16)}
:root[data-review-changes-only="true"] .coding-review-code tr[data-kind="context"]{display:none}:root[data-review-wrap="true"] .coding-review-file{min-width:0}:root[data-review-wrap="true"] .coding-review-code td:nth-child(3){min-width:0}:root[data-review-wrap="true"] .coding-review-code code{white-space:pre-wrap;overflow-wrap:anywhere}
.coding-review-details-panel [data-coding-task-outcome]{grid-column:1/-1;display:grid;gap:3px;margin:0;color:var(--muted)}.coding-review-details-panel [data-coding-task-outcome] b{color:var(--faint);font:700 7px/1.2 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase}
.coding-review-file-rail a{min-height:36px;padding:7px 10px}
.coding-review-page>.agent-top-nav{display:none}.coding-review-toolbar{height:56px;padding:0 16px}.coding-review-context{height:44px;padding:0 16px}
@media(min-width:640px){.coding-review-page{grid-template-rows:56px 44px minmax(0,1fr)!important}.coding-review-workspace{grid-template-columns:240px minmax(0,1fr)!important}.coding-review-file-rail{display:grid!important}.coding-review-code{font-size:12px!important}.coding-review-file>header{width:calc(100vw - 240px);min-width:calc(100vw - 240px);max-width:calc(100vw - 240px)}}@media(max-width:639px){.coding-review-workspace{grid-template-columns:minmax(0,1fr)}.coding-review-file-rail{display:none}}@media(max-width:639px){.coding-review-page{grid-template-rows:56px 44px minmax(0,1fr)!important}.coding-review-code{font-size:12px!important}}
@media(max-width:639px){.coding-review-page{grid-template-rows:auto auto minmax(0,1fr)!important}.coding-review-toolbar{height:auto;min-height:56px;flex-wrap:wrap;align-content:center;padding:8px 10px!important}.coding-review-back{width:44px;height:44px}.coding-review-title{flex:1 1 calc(100% - 56px)}.coding-review-toolbar-meta{display:grid;grid-template-columns:minmax(0,1fr) auto;width:100%;margin-left:56px;gap:6px;justify-content:normal}.coding-review-state{grid-column:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-review-details{display:block!important;grid-column:2;grid-row:1}.coding-review-details summary,.coding-review-context button,.coding-review-integrate button{min-height:44px!important}.coding-review-context{height:auto;min-height:44px;padding-block:4px}.coding-review-integrate{min-width:0;width:100%;grid-column:1/-1}.coding-review-integrate button{width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;justify-content:center;white-space:nowrap}}
@media(pointer:coarse){.coding-review-back{min-width:44px;min-height:44px}.coding-review-details summary,.coding-review-context button,.coding-review-integrate button{min-height:44px!important}}
button:focus-visible,input:focus-visible{outline:2px solid var(--blue);outline-offset:2px}@media(prefers-reduced-motion:reduce){.coding-review-progress::-webkit-progress-value,.coding-review-progress::-moz-progress-bar{transition:none}}`;

const codingReviewScript = (nonce: string, runId: string, commit: string | undefined): string => `<script nonce="${esc(nonce)}">(()=>{
  const root=document.documentElement;
  const scroll=document.querySelector('.coding-review-diff-scroll');
  const sections=Array.from(document.querySelectorAll('[data-review-file-section]'));
  const links=Array.from(document.querySelectorAll('[data-review-file-link]'));
  const checks=Array.from(document.querySelectorAll('[data-review-viewed]'));
  const progress=document.querySelector('[data-review-progress]');
  const progressBar=document.querySelector('[data-review-progress-bar]');
  const next=document.querySelector('[data-review-next]');
  const filter=document.querySelector('[data-review-filter]');
  const filterEmpty=document.querySelector('[data-review-filter-empty]');
  const storageKey='roster.review.viewed.v1:${esc(runId)}:${esc(commit ?? "uncommitted")}';
  let viewed=new Set();
  try{viewed=new Set(JSON.parse(localStorage.getItem(storageKey)||'[]'));}catch{}
  const syncViewed=()=>{
    for(const check of checks){
      const id=check.getAttribute('data-file-id')||'';
      if(check instanceof HTMLInputElement)check.checked=viewed.has(id);
      document.getElementById(id)?.setAttribute('data-viewed',String(viewed.has(id)));
      document.querySelector('[data-review-file-item][data-file-id="'+CSS.escape(id)+'"]')?.setAttribute('data-viewed',String(viewed.has(id)));
    }
    const count=sections.filter((section)=>viewed.has(section.id)).length;
    if(progress)progress.textContent=count+' of '+sections.length+' viewed';
    if(progressBar instanceof HTMLProgressElement)progressBar.value=count;
    if(next instanceof HTMLButtonElement){next.disabled=count===sections.length;next.textContent=count===sections.length?'All reviewed ✓':'Next unviewed ↓';}
    try{localStorage.setItem(storageKey,JSON.stringify(Array.from(viewed)));}catch{}
  };
  for(const check of checks)check.addEventListener('change',()=>{
    const id=check.getAttribute('data-file-id')||'';
    if(check instanceof HTMLInputElement&&check.checked)viewed.add(id);else viewed.delete(id);
    syncViewed();
  });
  const setActive=(id)=>{for(const link of links)link.setAttribute('aria-current',String(link.getAttribute('href')==='#'+id));};
  if(scroll&&sections.length){
    const observer=new IntersectionObserver((entries)=>{
      const visible=entries.filter((entry)=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);
      if(visible[0])setActive(visible[0].target.id);
    },{root:scroll,rootMargin:'-42px 0px -72% 0px',threshold:0});
    for(const section of sections)observer.observe(section);
  }
  for(const link of links)link.addEventListener('click',()=>setActive((link.getAttribute('href')||'').slice(1)));
  if(next)next.addEventListener('click',()=>{
    const target=sections.find((section)=>!viewed.has(section.id));
    if(target){target.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});setActive(target.id);target.querySelector('[data-review-viewed]')?.focus({preventScroll:true});}
  });
  if(filter)filter.addEventListener('input',()=>{
    const query=filter instanceof HTMLInputElement?filter.value.trim().toLowerCase():'';
    let matches=0;
    document.querySelectorAll('[data-review-file-item]').forEach((item)=>{const show=!query||(item.getAttribute('data-file-path')||'').includes(query);if(item instanceof HTMLElement)item.hidden=!show;if(show)matches+=1;});
    if(filterEmpty instanceof HTMLElement)filterEmpty.hidden=matches!==0;
  });
  document.querySelector('[data-review-changes-only]')?.addEventListener('click',(event)=>{
    const button=event.currentTarget;if(!(button instanceof HTMLButtonElement))return;
    const pressed=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(pressed));root.dataset.reviewChangesOnly=String(pressed);
  });
  document.querySelector('[data-review-wrap]')?.addEventListener('click',(event)=>{
    const button=event.currentTarget;if(!(button instanceof HTMLButtonElement))return;
    const pressed=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(pressed));root.dataset.reviewWrap=String(pressed);
  });
  setActive(location.hash.slice(1)||sections[0]?.id||'');syncViewed();
})();</script>`;

const codingReviewShellMarkup = (options: {
  readonly state: OrchestrationState;
  readonly runId: string;
  readonly workspaceId?: string;
  readonly job?: CodingDemoJob;
  readonly diff: CodingReviewDiff;
  readonly nonce: string;
  readonly showGlobalNavigation?: boolean;
}): string => {
  const outputs = orchestrationOutputValues(options.state);
  const result = displayResult(outputs);
  const tasks = codingGraphTasks(options.state);
  const complete = codingGraphComplete(options.state) && (!options.job || options.job.status === "completed");
  const delivery = codingRunDeliveryState(options.state, options.job);
  const failed = !codingCommittedUsageNote(options.state, options.job) && (
    Boolean(codingGraphFailure(options.state))
    || options.job?.status === "failed"
    || options.job?.status === "canceled"
  );
  const delivered = complete && (delivery === "integrated" || delivery === "no-changes" || delivery === "kept-branch");
  const ready = complete && delivery === "ready";
  const tone = delivered ? "complete" : failed ? "failed" : "active";
  const status = delivered
    ? delivery === "integrated" ? "Certified & merged" : delivery === "kept-branch" ? "Certified · branch kept" : "Certified · no changes"
    : ready
      ? "Certified · ready to merge"
      : complete
        ? "Certified · delivery pending"
        : failed ? "Certification not accepted" : "Still working";
  const statusDetail = delivered
    ? delivery === "integrated"
      ? `Every executable task completed and the exact certified commit is on ${options.job?.integration?.currentBranch ?? options.job?.baselineBranch ?? "the target branch"}.`
      : delivery === "kept-branch"
        ? `Every executable task completed. The room was closed without merging and ${options.job?.deliveryDisposition?.branch ?? options.job?.branch ?? "the run branch"} remains available.`
      : "Every executable task completed and no repository delta was required."
    : ready
      ? `Every executable task completed. Return to the room to merge the exact certified commit into ${options.job?.baselineBranch ?? "the target branch"}.`
    : complete
      ? "Every executable task completed; Roster is still closing the Git delivery handoff."
    : failed
      ? "This run ended without an accepted certified frontier. Some work may be saved, but the change is not finished."
      : "The run has not reached a terminal certified state yet.";
  const completedTasks = tasks.filter((task) => task.status === "accepted" || task.status === "skipped").length;
  const parsed = parseCodingReviewFiles(options.diff);
  const totalAdditions = parsed.files.reduce((total, file) => total + file.additions, 0);
  const totalDeletions = parsed.files.reduce((total, file) => total + file.deletions, 0);
  const handoff = options.job?.noChanges
    ? {
        label: "No changes",
        detail: "The certified execution produced no Git delta and needs no integration.",
        tone: "complete",
      }
    : options.job?.integration?.integrated
    ? {
        label: `Present on ${options.job.integration.currentBranch ?? options.job.baselineBranch ?? "the current branch"}`,
        detail: "The current branch contains the certified commit.",
        tone: "complete",
      }
    : options.job?.deliveryDisposition?.action === "keep-branch"
      ? {
          label: "Closed · branch kept",
          detail: `The room was closed without merging. ${options.job.deliveryDisposition.branch} remains available.`,
          tone: "complete",
        }
    : options.job?.integration?.canIntegrate
      ? {
          label: `Ready to integrate into ${options.job.baselineBranch ?? "the target branch"}`,
          detail: "Review the patch, then merge the exact certified commit from this workspace.",
          tone: "ready",
        }
      : {
          label: "Not integrated",
          detail: options.job?.integration?.reason
            ? codingPublicFailureReason({ certified: true })
            : "No integration state is available for this run.",
          tone: "blocked",
        };
  const backParams = new URLSearchParams({
    ...(options.workspaceId ? { workspace: options.workspaceId } : {}),
    run: options.runId,
    ...(options.job ? { job: options.job.id } : {}),
  });
  const backUrl = `/coding?${backParams.toString()}`;
  const taskRows = tasks.map((task) => {
    const taskState = codingGraphDisplayStatus(task);
    const node = options.state.nodes[task.nodeId];
    const agent = node ? codingAgentVisual(node) : undefined;
    const agentLabel = agent ? `${agent.name} · ${agent.role}` : task.nodeId;
    const outcome = codingTaskVisibleOutcome(options.state, task);
    return `<li data-state="${esc(taskState)}"><span>${esc(titleCase(task.taskId))}</span><small>${esc(agentLabel)} · ${esc(titleCase(taskState))}</small><p data-coding-task-outcome><b>Outcome</b>${esc(outcome)}</p></li>`;
  }).join("") || `<li><span>No execution tasks were recorded.</span></li>`;
  const details = `<details class="coding-review-details" data-review-details><summary>Run details <span>${completedTasks}/${tasks.length}</span></summary><div class="coding-review-details-panel">
    <dl><div><dt>Run</dt><dd><code translate="no">${esc(options.runId)}</code></dd></div><div><dt>Certified commit</dt><dd><code translate="no">${esc(options.job?.commit ?? "Unavailable")}</code></dd></div><div><dt>Run branch</dt><dd><code translate="no">${esc(options.job?.branch ?? "Unavailable")}</code></dd></div><div><dt>Handoff</dt><dd>${esc(handoff.detail)}</dd></div></dl>
    <section><h2>Tasks</h2><ol>${taskRows}</ol></section>
  </div></details>`;
  const deliveryAction = ready && options.job
    ? `<form class="coding-review-integrate" action="/coding/runs/${encodeURIComponent(options.runId)}/integrate" method="post" data-review-primary-action><input type="hidden" name="jobId" value="${esc(options.job.id)}"/><button type="submit">Merge into ${esc(options.job.baselineBranch ?? "target branch")} <span aria-hidden="true">→</span></button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="theme-color" content="#11120f"/><title>Review changes · Coding Roster</title>${themeBootstrapScript(options.nonce)}<style nonce="${esc(options.nonce)}">
  ${codingTypographyCss}
  :root{color-scheme:dark;${codingThemeTokens};--bg:var(--surface-canvas);--panel:var(--surface-panel);--raised:var(--surface-raised);--line:var(--border-default);--line-soft:var(--border-subtle);--ink:var(--text-primary);--muted:var(--text-secondary);--faint:var(--text-tertiary);--green:var(--success);--red:var(--danger);--amber:var(--warning);--blue:var(--accent);--agent-accent:var(--accent-strong);--agent-accent-soft:rgba(182,207,251,.1);--radius-sm:var(--radius-control);--shell-bar:44px;--rail:238px}*{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{min-width:1024px;overflow:hidden}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}${agentShellChromeCss()}.coding-review-page{height:100vh;display:grid;grid-template-rows:44px 50px 34px minmax(0,1fr)}.coding-review-page>.agent-top-nav{height:44px;min-height:44px;padding-block:5px;background:var(--surface-panel)}.coding-review-toolbar{position:relative;z-index:4;min-width:0;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--line);background:var(--panel)}.coding-review-back{width:28px;height:28px;display:grid;place-items:center;flex:none;border:1px solid var(--line);border-radius:var(--radius-control);color:var(--muted);text-decoration:none}.coding-review-back:hover{color:var(--ink);background:var(--raised)}.coding-review-title{min-width:160px;display:flex;align-items:baseline;gap:9px}.coding-review-title h1{margin:0;font-size:13px;letter-spacing:-.01em}.coding-review-title span{max-width:36vw;overflow:hidden;color:var(--faint);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.coding-review-toolbar-meta{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-left:auto;color:var(--muted);font:9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}.coding-review-toolbar-meta>span,.coding-review-toolbar-meta>code{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-review-state{display:inline-flex;align-items:center;gap:6px;color:var(--blue)}.coding-review-state:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.coding-review-state[data-tone="complete"]{color:var(--green)}.coding-review-state[data-tone="failed"]{color:var(--red)}.coding-review-handoff[data-tone="complete"]{color:var(--green)}.coding-review-handoff[data-tone="blocked"]{color:var(--amber)}.coding-review-details{position:relative;flex:none;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.coding-review-details summary{min-height:28px;display:flex;align-items:center;gap:7px;padding:0 8px;border:1px solid var(--line);border-radius:var(--radius-control);color:var(--muted);background:var(--bg);cursor:pointer;font-size:9px;font-weight:650;list-style:none}.coding-review-details summary::-webkit-details-marker{display:none}.coding-review-details summary span{color:var(--faint);font:8px/1 ui-monospace,monospace}.coding-review-details[open] summary,.coding-review-details summary:hover{color:var(--ink);background:var(--raised)}.coding-review-details-panel{position:absolute;top:34px;right:0;width:390px;max-height:calc(100vh - 100px);overflow:auto;padding:14px;border:1px solid var(--border-strong);border-radius:var(--radius-overlay);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.coding-review-details-panel dl{display:grid;gap:7px;margin:0}.coding-review-details-panel dl>div{display:grid;grid-template-columns:92px minmax(0,1fr);gap:10px;padding-bottom:7px;border-bottom:1px solid var(--line-soft)}.coding-review-details-panel dt,.coding-review-details-panel h2{color:var(--faint);font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.07em}.coding-review-details-panel dd{min-width:0;margin:0;color:var(--muted);font-size:9px;line-height:1.45;overflow-wrap:anywhere}.coding-review-details-panel code{color:var(--accent-strong)}.coding-review-details-panel section{margin-top:14px}.coding-review-details-panel h2{margin:0 0 7px}.coding-review-details-panel ol,.coding-review-details-panel ul{display:grid;gap:0;margin:0;padding:0;list-style:none}.coding-review-details-panel li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:6px 0;border-bottom:1px solid var(--line-soft);color:var(--muted);font-size:9px;line-height:1.4}.coding-review-details-panel li small{color:var(--faint)}.coding-review-context{min-width:0;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--line-soft);color:var(--muted);background:var(--surface-sidebar);font-size:9px}.coding-review-context>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-review-context code{margin-left:auto;color:var(--faint);font:8px/1.2 ui-monospace,monospace;white-space:nowrap}.coding-review-workspace{min-height:0;display:grid;grid-template-columns:var(--rail) minmax(0,1fr)}.coding-review-file-rail{min-height:0;overflow:auto;border-right:1px solid var(--line);background:var(--surface-sidebar);scrollbar-width:thin}.coding-review-file-rail>header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;height:34px;padding:0 10px;border-bottom:1px solid var(--line-soft);background:var(--surface-sidebar)}.coding-review-file-rail>header strong{font-size:9px}.coding-review-file-rail>header span{color:var(--faint);font:8px/1 ui-monospace,monospace}.coding-review-file-rail ol{margin:0;padding:4px 0;list-style:none}.coding-review-file-rail a{min-width:0;display:block;padding:7px 10px;border-left:2px solid transparent;color:var(--muted);text-decoration:none}.coding-review-file-rail a:hover,.coding-review-file-rail a:focus-visible{border-left-color:var(--blue);color:var(--ink);background:var(--raised)}.coding-review-file-rail a>span{display:block;overflow:hidden;font:9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.coding-review-file-rail small{display:block;margin-top:2px;color:var(--faint);font:7px/1.3 ui-monospace,monospace}.coding-review-file-rail small b{color:var(--green)}.coding-review-file-rail small i{color:var(--red);font-style:normal}.coding-review-diff-scroll{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scroll-behavior:smooth;background:var(--surface-inset)}.coding-review-file{min-width:max-content;border-bottom:1px solid var(--line);background:#101010;content-visibility:auto;contain-intrinsic-size:auto 520px;scroll-margin-top:33px}.coding-review-file>header{position:sticky;top:0;z-index:2;min-width:100%;display:flex;align-items:center;justify-content:space-between;gap:16px;height:34px;padding:0 12px;border-bottom:1px solid var(--line);background:rgba(21,21,21,.97)}.coding-review-file>header>span:first-child{min-width:0}.coding-review-file strong{display:inline;font:600 9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.coding-review-file small{margin-left:8px;color:var(--faint);font-size:7px}.coding-review-counts{display:flex;gap:8px;font:8px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.coding-review-counts b{color:var(--green)}.coding-review-counts i{color:var(--red);font-style:normal}.coding-review-code{width:100%;border-collapse:collapse;font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}.coding-review-code td{height:16px;padding:0;vertical-align:top}.coding-review-code td:nth-child(1),.coding-review-code td:nth-child(2){width:42px;padding:0 7px;border-right:1px solid #252525;color:#5f5f5f;text-align:right;user-select:none}.coding-review-code td:nth-child(3){min-width:760px;padding:0 12px}.coding-review-code code{white-space:pre}.coding-review-code tr[data-kind="addition"]{background:rgba(66,135,84,.16)}.coding-review-code tr[data-kind="addition"] td:nth-child(3){color:#c5e8ce}.coding-review-code tr[data-kind="deletion"]{background:rgba(154,70,70,.14)}.coding-review-code tr[data-kind="deletion"] td:nth-child(3){color:#edc0c0}.coding-review-code tr[data-kind="meta"] td:nth-child(3){color:#9fb6dd;background:rgba(75,105,145,.11)}.coding-review-notice,.coding-review-empty{margin:0;padding:9px 12px;border-bottom:1px solid var(--warning-border);color:var(--warning);background:var(--warning-surface);font-size:9px;line-height:1.5}.coding-review-empty p{display:inline;margin-left:7px;color:var(--muted)}a:focus-visible,summary:focus-visible{outline:2px solid var(--blue);outline-offset:2px}@media(prefers-reduced-motion:reduce){.coding-review-diff-scroll{scroll-behavior:auto}}
  ${codingBrandThemeCss}
  ${themeCss()}</style><style nonce="${esc(options.nonce)}">${codingReviewExperienceCss}.coding-review-skip{position:fixed;z-index:20;left:12px;top:8px;transform:translateY(-150%);padding:7px 10px;border-radius:var(--radius-control);color:var(--bg);background:var(--ink);font-size:10px}.coding-review-skip:focus{transform:none}.coding-review-details-panel{width:min(390px,calc(100vw - 20px));overscroll-behavior:contain}.coding-review-integrate{margin:0}.coding-review-integrate button{min-height:32px;display:inline-flex;align-items:center;gap:8px;padding:0 11px;border:1px solid var(--action-primary);border-radius:var(--radius-control);color:var(--action-primary-foreground);background:var(--action-primary);cursor:pointer;font:700 9px/1 var(--font-ui);white-space:nowrap}.coding-review-integrate button:hover{background:var(--action-primary-hover)}.coding-review-details summary,.coding-review-file-rail a,.coding-review-file-rail button,.coding-review-viewed,.coding-review-context button,.coding-review-integrate button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}.coding-review-file-rail li{content-visibility:auto;contain-intrinsic-size:38px}@media(max-width:900px){:root{--rail:clamp(190px,32vw,238px)}body{min-width:0}.coding-review-title span,.coding-review-toolbar-meta>span:not(.coding-review-state),.coding-review-toolbar-meta>code{display:none}.coding-review-workspace{grid-template-columns:var(--rail) minmax(0,1fr)}.coding-review-context-copy>span,.coding-review-stat:first-child{display:none}}@media(max-width:640px){:root{--rail:0px}.coding-review-page{grid-template-rows:44px 52px 44px minmax(0,1fr)}.coding-review-toolbar{padding-inline:10px}.coding-review-handoff,.coding-review-context-copy{display:none!important}.coding-review-context{height:44px;padding-inline:10px}.coding-review-context-stats{width:100%;justify-content:flex-end}.coding-review-file-rail{display:none}.coding-review-workspace{grid-template-columns:minmax(0,1fr)}.coding-review-file>header{height:38px}.coding-review-code{font-size:10px}.coding-review-code td:nth-child(1),.coding-review-code td:nth-child(2){width:36px}.coding-review-code td:nth-child(2){left:36px}.coding-review-viewed{padding-inline:6px}.coding-review-viewed span{display:none}.coding-review-integrate button{min-height:36px;padding-inline:9px}}</style></head><body><a class="coding-review-skip" href="#coding-review-diff">Skip to diff</a><div class="coding-review-page" data-slot="agent-shell" data-ui-family="roster-agent">${agentTopNavHtml({ active: "coding", showNavigation: options.showGlobalNavigation, statusLabel: tone === "complete" ? "Review ready" : "Review active" })}<header class="coding-review-toolbar" data-slot="review-toolbar"><a class="coding-review-back" href="${esc(backUrl)}" aria-label="Back to conversation">←</a><div class="coding-review-title"><h1>Review Changes</h1><span>${esc(result?.summary ?? options.diff.summary ?? "Certified Git patch")}</span></div><div class="coding-review-toolbar-meta"><span class="coding-review-state" data-tone="${tone}" role="status">${esc(status)}</span><code title="Certified commit" translate="no">${esc(options.job?.commit?.slice(0,12) ?? "No commit")}</code><span class="coding-review-handoff" data-tone="${handoff.tone}">${esc(handoff.label)}</span>${details}${deliveryAction}</div></header><div class="coding-review-context" data-review-summary><div class="coding-review-context-copy"><strong>${esc(handoff.label)}</strong><span>${esc(statusDetail)}</span></div><div class="coding-review-context-stats"><span class="coding-review-stat">${new Intl.NumberFormat("en-US").format(parsed.files.length)} files · ${new Intl.NumberFormat("en-US").format(options.diff.patch.bytes)} bytes</span><span class="coding-review-stat"><b>+${new Intl.NumberFormat("en-US").format(totalAdditions)}</b><i>−${new Intl.NumberFormat("en-US").format(totalDeletions)}</i></span><button type="button" aria-pressed="false" data-review-changes-only>Changes only</button><button type="button" aria-pressed="false" data-review-wrap>Wrap lines</button></div></div><main class="coding-review-workspace" data-slot="agent-main">${codingReviewFileRailHtml(parsed)}<section class="coding-review-diff-scroll" id="coding-review-diff" aria-label="File diffs" tabindex="-1">${codingReviewPatchHtml(parsed)}</section></main></div>${codingReviewScript(options.nonce, options.runId, options.job?.commit)}</body></html>`;
};

export const codingReviewShell = (options: Parameters<typeof codingReviewShellMarkup>[0]): string => codingReviewShellMarkup(options).replace(
  '<div class="coding-review-page" data-slot="agent-shell" data-ui-family="roster-agent">',
  '<div class="coding-review-page" data-layout="coding-review" data-slot="agent-shell" data-ui-family="roster-agent">',
);

const codingAgentDetailsScript = (nonce: string): string => `<script nonce="${esc(nonce)}">(()=>{
  const detailPrefix='coding-agent-detail-';
  let selectedId=location.hash.slice(1).startsWith(detailPrefix)?location.hash.slice(1):'';
  let focusedControl;
  const updateUrl=()=>{const url=new URL(location.href);url.hash=selectedId?'#'+selectedId:'';history.replaceState(history.state,'',url);};
  const sync=(scroll=false)=>{
    const details=Array.from(document.querySelectorAll('[data-coding-agent-detail]'));
    if(selectedId&&!details.some((detail)=>detail.id===selectedId))selectedId='';
    for(const detail of details){if(detail instanceof HTMLElement)detail.hidden=detail.id!==selectedId;}
    document.querySelectorAll('[data-coding-agent-trigger][aria-controls]').forEach((trigger)=>{
      if(trigger instanceof HTMLButtonElement)trigger.setAttribute('aria-expanded',String(trigger.getAttribute('aria-controls')===selectedId));
    });
    document.querySelectorAll('.coding-live').forEach((panel)=>{
      if(panel instanceof HTMLElement)panel.dataset.agentDetailOpen=String(Boolean(selectedId&&panel.querySelector('#'+CSS.escape(selectedId))));
    });
    const selected=selectedId?document.getElementById(selectedId):undefined;
    if(scroll&&selected instanceof HTMLElement)selected.scrollIntoView({block:'nearest'});
    if(focusedControl&&document.activeElement===document.body){
      const replacement=document.querySelector(focusedControl);
      if(replacement instanceof HTMLElement)replacement.focus({preventScroll:true});
    }
  };
  const select=(nextId,scroll=true)=>{selectedId=nextId;updateUrl();sync(scroll);};
  const triggerFor=(target)=>target instanceof Element?target.closest('[data-coding-agent-trigger]'):null;
  const closeFor=(target)=>target instanceof Element?target.closest('[data-coding-agent-close]'):null;
  const focusTrigger=(detailId)=>{
    const trigger=document.querySelector('[data-coding-agent-trigger][aria-controls="'+CSS.escape(detailId)+'"]');
    if(trigger instanceof HTMLElement)trigger.focus();
  };
  const closeSelected=()=>{
    if(!selectedId)return;
    const previousId=selectedId;
    select('',false);
    focusTrigger(previousId);
  };
  document.addEventListener('pointerdown',(event)=>{
    const trigger=triggerFor(event.target);
    const close=closeFor(event.target);
    if(trigger||close){
      document.documentElement.dataset.codingAgentPointerActive='true';
      setTimeout(()=>{delete document.documentElement.dataset.codingAgentPointerActive;},500);
    }
  });
  const endPointerInteraction=()=>setTimeout(()=>{delete document.documentElement.dataset.codingAgentPointerActive;},80);
  document.addEventListener('pointerup',endPointerInteraction);
  document.addEventListener('pointercancel',endPointerInteraction);
  document.addEventListener('click',(event)=>{
    const trigger=triggerFor(event.target);
    if(trigger){
      const detailId=trigger.getAttribute('aria-controls')||'';
      if(!detailId)return;
      event.preventDefault();
      const nextId=selectedId===detailId?'':detailId;
      select(nextId);
      if(nextId){
        const close=document.querySelector('#'+CSS.escape(nextId)+' [data-coding-agent-close]');
        if(close instanceof HTMLElement)close.focus({preventScroll:true});
      }
      return;
    }
    const close=closeFor(event.target);
    if(!close)return;
    event.preventDefault();
    closeSelected();
  });
  document.addEventListener('focusin',(event)=>{
    const control=event.target instanceof Element?event.target.closest('[data-coding-agent-trigger],[data-coding-agent-close]'):null;
    if(control?.hasAttribute('data-coding-agent-trigger'))focusedControl='[data-coding-agent-trigger][aria-controls="'+CSS.escape(control.getAttribute('aria-controls')||'')+'"]';
    else if(control?.hasAttribute('data-coding-agent-close')&&selectedId)focusedControl='#'+CSS.escape(selectedId)+' [data-coding-agent-close]';
    else if(event.target!==document.body&&event.target!==document.documentElement)focusedControl=undefined;
  });
  document.addEventListener('keydown',(event)=>{
    if(event.key!=='Escape'||!selectedId)return;
    closeSelected();
  });
  const restoreFromUrl=()=>{selectedId=location.hash.slice(1).startsWith(detailPrefix)?location.hash.slice(1):'';sync();};
  const boot=()=>{sync();const main=document.getElementById('main');if(main)new MutationObserver(()=>sync()).observe(main,{childList:true,subtree:true});};
  addEventListener('hashchange',restoreFromUrl);
  addEventListener('popstate',restoreFromUrl);
  document.addEventListener('coding:run-panel-updated',()=>sync());
  if(document.readyState==='loading')addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();</script>`;

const codingWorkspacePickerScript = (nonce: string): string => `<script nonce="${esc(nonce)}">(()=>{
  const dialog=document.querySelector('[data-workspace-picker]');
  const trigger=document.querySelector('.coding-add-workspace-trigger');
  if(!(dialog instanceof HTMLDialogElement)||!(trigger instanceof HTMLButtonElement))return;
  const title=dialog.querySelector('#coding-workspace-picker-title');
  const locations=dialog.querySelector('[data-workspace-picker-locations]');
  const breadcrumbs=dialog.querySelector('[data-workspace-picker-breadcrumbs]');
  const entries=dialog.querySelector('[data-workspace-picker-entries]');
  const current=dialog.querySelector('[data-workspace-picker-current]');
  const repoState=dialog.querySelector('[data-workspace-picker-repo-state]');
  const status=dialog.querySelector('[data-workspace-picker-status]');
  const selection=dialog.querySelector('[data-workspace-picker-selection]');
  const pathInput=dialog.querySelector('[data-workspace-picker-path]');
  const submit=dialog.querySelector('[data-workspace-picker-submit]');
  const cancel=dialog.querySelector('[data-workspace-picker-cancel]');
  const form=dialog.querySelector('[data-workspace-picker-form]');
  const addProgress=dialog.querySelector('[data-workspace-add-progress]');
  const addProgressMessage=dialog.querySelector('[data-workspace-add-progress-message]');
  const addProgressElapsed=dialog.querySelector('[data-workspace-add-progress-elapsed]');
  let activePath='';let request;
  const button=(className,label,activate)=>{const control=document.createElement('button');control.type='button';control.className=className;control.addEventListener('click',activate);const text=document.createElement('span');text.textContent=label;control.append(text);return control;};
  const announce=(message,state)=>{if(!(status instanceof HTMLElement))return;status.textContent=message;status.dataset.state=state||'';};
  const choose=(data)=>{const ready=data.gitRepository===true;if(pathInput instanceof HTMLInputElement)pathInput.value=ready?data.path:'';if(submit instanceof HTMLButtonElement)submit.setAttribute('aria-disabled',String(!ready));if(selection instanceof HTMLElement)selection.textContent=ready?data.path:'Choose a Git repository';if(repoState instanceof HTMLElement){repoState.textContent=ready?'Git repository · ready to add':'Not a Git repository';repoState.dataset.state=ready?'ready':'idle';}};
  const renderLocations=(data)=>{if(!(locations instanceof HTMLElement))return;locations.replaceChildren();for(const location of data.locations||[]){const control=button('coding-workspace-location',location.label,()=>load(location.path));control.title=location.path;control.setAttribute('aria-current',String(location.path===data.path));const icon=document.createElement('span');icon.setAttribute('aria-hidden','true');icon.textContent=location.label==='Home'?'⌂':location.label==='Documents'?'▤':'G';control.prepend(icon);locations.append(control);}};
  const renderBreadcrumbs=(data)=>{if(!(breadcrumbs instanceof HTMLElement))return;breadcrumbs.replaceChildren();for(const crumb of data.breadcrumbs||[]){const control=button('',crumb.label,()=>load(crumb.path));control.title=crumb.path;breadcrumbs.append(control);}};
  const renderEntries=(data)=>{if(!(entries instanceof HTMLElement))return;entries.replaceChildren();entries.setAttribute('aria-busy','false');if(!data.entries?.length){const empty=document.createElement('div');empty.className='coding-workspace-picker-empty';empty.textContent='No visible folders here.';entries.append(empty);return;}for(const folder of data.entries){const control=button('coding-workspace-folder',folder.name,()=>load(folder.path));control.title=folder.path;const icon=document.createElement('span');icon.className='coding-workspace-folder-icon';icon.setAttribute('aria-hidden','true');icon.textContent='▰';control.prepend(icon);if(folder.gitRepository){const badge=document.createElement('em');badge.textContent='Git';control.append(badge);}entries.append(control);}};
  const load=async(path)=>{if(request)request.abort();request=new AbortController();if(entries instanceof HTMLElement){entries.setAttribute('aria-busy','true');const loading=document.createElement('div');loading.className='coding-workspace-loading';loading.setAttribute('aria-hidden','true');for(let index=0;index<4;index+=1){const row=document.createElement('span');loading.append(row);}entries.replaceChildren(loading);}announce('Loading folders…');try{const response=await fetch('/coding/workspaces/browse?path='+encodeURIComponent(path||''),{headers:{accept:'application/json'},signal:request.signal});const data=await response.json();if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Could not open this folder.');activePath=data.path;if(current instanceof HTMLElement){current.textContent=data.name;current.title=data.path;}renderLocations(data);renderBreadcrumbs(data);renderEntries(data);choose(data);announce((data.entries?.length||0)+' folders'+(data.truncated?' · showing the first 160':'')+'.');}catch(error){if(error instanceof DOMException&&error.name==='AbortError')return;if(entries instanceof HTMLElement)entries.setAttribute('aria-busy','false');choose({gitRepository:false});announce(error instanceof Error?error.message:'Could not open this folder.','error');}};
  trigger.addEventListener('click',()=>{const switcher=document.querySelector('[data-workspace-switcher]');if(switcher instanceof HTMLDetailsElement)switcher.open=false;if(!dialog.open)dialog.showModal();if(title instanceof HTMLElement)title.focus();load(activePath);});
  cancel?.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',(event)=>{if(event.target===dialog)dialog.close();});
  form?.addEventListener('submit',async(event)=>{
    event.preventDefault();
    if(dialog.dataset.state==='busy')return;
    if(!(pathInput instanceof HTMLInputElement)||!pathInput.value){announce('Choose a Git repository before adding this workspace.','error');submit?.focus();return;}
    dialog.dataset.state='busy';dialog.setAttribute('aria-busy','true');form.setAttribute('aria-busy','true');
    for(const region of dialog.querySelectorAll('.coding-workspace-picker-header,.coding-workspace-picker-body,.coding-workspace-picker-footer'))region.inert=true;
    if(submit instanceof HTMLButtonElement){submit.disabled=true;submit.textContent='Adding…';}
    if(addProgress instanceof HTMLElement){addProgress.removeAttribute('hidden');addProgress.focus({preventScroll:true});}
    if(addProgressMessage instanceof HTMLElement)addProgressMessage.textContent='Indexing tracked files and assembling a repository-specific team.';
    const startedAt=Date.now();
    const timer=setInterval(()=>{const elapsed=Math.max(1,Math.floor((Date.now()-startedAt)/1000));if(addProgressElapsed instanceof HTMLElement)addProgressElapsed.textContent=elapsed+'s elapsed · large repositories can take a few minutes';},1000);
    announce('Adding repository and building its team…','pending');
    try{
      const response=await fetch(form.action,{method:'POST',headers:{accept:'application/json'},body:new URLSearchParams(new FormData(form)),credentials:'same-origin'});
      const contentType=response.headers.get('content-type')||'';
      const payload=contentType.includes('application/json')?await response.json():{error:await response.text()};
      if(!response.ok||payload.ok!==true||typeof payload.destination!=='string')throw new Error(typeof payload.error==='string'&&payload.error?payload.error:'Could not add this Git repository.');
      if(addProgressMessage instanceof HTMLElement)addProgressMessage.textContent='Repository ready. Opening its workspace…';
      location.assign(payload.destination);
    }catch(error){
      clearInterval(timer);dialog.dataset.state='';dialog.removeAttribute('aria-busy');form.removeAttribute('aria-busy');
      for(const region of dialog.querySelectorAll('.coding-workspace-picker-header,.coding-workspace-picker-body,.coding-workspace-picker-footer'))region.inert=false;
      if(submit instanceof HTMLButtonElement){submit.disabled=false;submit.textContent='Add Repository';}
      if(addProgress instanceof HTMLElement)addProgress.setAttribute('hidden','');
      announce(error instanceof Error?error.message:'Could not add this Git repository.','error');submit?.focus();
    }
  });
  dialog.addEventListener('cancel',(event)=>{if(dialog.dataset.state==='busy')event.preventDefault();});
  dialog.addEventListener('close',()=>{if(dialog.dataset.state==='busy')return;dialog.dataset.state='';dialog.removeAttribute('aria-busy');request?.abort();for(const region of dialog.querySelectorAll('.coding-workspace-picker-header,.coding-workspace-picker-body,.coding-workspace-picker-footer'))region.inert=false;choose({gitRepository:false});if(submit instanceof HTMLButtonElement){submit.disabled=false;submit.textContent='Add Repository';}if(addProgress instanceof HTMLElement)addProgress.setAttribute('hidden','');});
})();</script>`;

const codingWorkspaceScanScript = (nonce: string): string => `<script nonce="${esc(nonce)}">document.addEventListener('DOMContentLoaded',()=>{
  const forms=[...document.querySelectorAll('[data-coding-workspace-scan],[data-coding-team-refresh]')];
  for(const form of forms){
    if(!(form instanceof HTMLFormElement))continue;
    const initial=form.matches('[data-coding-workspace-scan]');
    const status=document.querySelector(initial?'[data-coding-workspace-scan-status]':'[data-coding-team-refresh-status]');
    if(!(status instanceof HTMLElement))continue;
    if(status.dataset.state==='success'&&status.textContent){
      const announcement=status.textContent;
      status.textContent='';
      queueMicrotask(()=>{status.textContent=announcement;});
    }
    form.addEventListener('submit',async(event)=>{
      if(form.dataset.state==='pending'){event.preventDefault();return;}
      event.preventDefault();
      const submit=form.querySelector('[type="submit"]');
      const idleLabel=submit instanceof HTMLButtonElement?submit.textContent:'';
      form.dataset.state='pending';
      form.setAttribute('aria-busy','true');
      if(submit instanceof HTMLButtonElement){submit.disabled=true;submit.textContent=initial?'Scanning…':'Refreshing…';}
      status.dataset.state='pending';
      status.textContent=initial
        ?'Building your team…'
        :'Updating your team…';
      let navigating=false;
      try{
        const body=new URLSearchParams(new FormData(form));
        body.set('returnTo',location.pathname+location.search);
        const selectedDetail=document.querySelector('[data-coding-agent-detail]:not([hidden])');
        if(selectedDetail instanceof HTMLElement)body.set('selectedAgent',selectedDetail.id);
        const response=await fetch(form.action,{method:'POST',headers:{accept:'application/json'},body,credentials:'same-origin'});
        const contentType=response.headers.get('content-type')||'';
        const payload=contentType.includes('application/json')?await response.json():{error:await response.text()};
        if(!response.ok||payload.ok!==true||typeof payload.destination!=='string')throw new Error(typeof payload.error==='string'&&payload.error?payload.error:'Repository scan failed.');
        navigating=true;
        location.assign(payload.destination);
      }catch(error){
        status.dataset.state='error';
        status.textContent=error instanceof Error?error.message:'Repository scan failed.';
      }finally{
        if(!navigating){
          delete form.dataset.state;
          form.removeAttribute('aria-busy');
          if(submit instanceof HTMLButtonElement){submit.disabled=false;submit.textContent=idleLabel;}
        }
      }
    });
  }
});</script>`;

export const codingComposerClientPrelude = String.raw`
  const codingComposerRevisionState=()=>({revision:0});
  const codingComposerRecordInput=(state)=>{state.revision+=1;return state.revision;};
  const codingComposerCanClearDraft=(state,submittedRevision,confirmed)=>confirmed===true&&state.revision===submittedRevision;
  const codingComposerLiveEdgeAfterAppend=(input)=>{
    const followEnd=Number.isFinite(input.distanceFromBottom)&&input.distanceFromBottom<=80;
    const unreadCount=Number.isFinite(input.unreadCount)?Math.max(0,Math.floor(input.unreadCount)):0;
    return {
      followEnd,
      scrollTop:followEnd?Math.max(0,input.scrollHeight):Math.max(0,input.scrollTop),
      unreadCount:followEnd?0:unreadCount+1,
    };
  };
`;

const codingConversationStreamScript = (nonce: string, conversationAgent: string): string => `<script nonce="${esc(nonce)}">document.addEventListener('DOMContentLoaded',()=>{
  ${codingComposerClientPrelude}
  const form=document.querySelector('[data-coding-form]');
  const textarea=form?.querySelector('textarea');
  const submit=form?.querySelector('button[type="submit"]');
  const imageInput=form?.querySelector('[data-coding-image-input]');
  const imagePreviews=form?.querySelector('[data-coding-image-previews]');
  const imageStatus=form?.querySelector('[data-coding-image-status]');
  const thread=document.querySelector('.coding-thread');
  const newMessages=document.querySelector('[data-coding-new-messages]');
  if(!(form instanceof HTMLFormElement)||!(textarea instanceof HTMLTextAreaElement)||typeof ReadableStream==='undefined')return;
  const draftIdentity=form.dataset.codingComposerDraft||'repository';
  const draftStorageKey='roster.coding.draft.v1:'+draftIdentity;
  const persistDraft=()=>{try{if(textarea.value)localStorage.setItem(draftStorageKey,textarea.value);else localStorage.removeItem(draftStorageKey);}catch{}};
  try{const storedDraft=localStorage.getItem(draftStorageKey);if(storedDraft!==null)textarea.value=storedDraft;else if(textarea.value)persistDraft();}catch{}
  const draftRevisionState=codingComposerRevisionState();
  textarea.addEventListener('input',()=>{codingComposerRecordInput(draftRevisionState);persistDraft();});
  const clearSentDraft=(item)=>{if(!codingComposerCanClearDraft(draftRevisionState,item.draftRevision,item.confirmed))return;textarea.value='';textarea.dispatchEvent(new Event('input',{bubbles:true}));};
  const statusAnchor=()=>thread instanceof HTMLOListElement?thread.querySelector('[data-coding-live-attention],.coding-inline-reply,[data-coding-run-progress]'):null;
  const queue=[];let draining=false;let inFlight=0;let latestLocation='';let shouldNavigate=false;
  let conversationId=form.querySelector('input[name="conversationId"]')?.value||'';let conversationModel='';const conversationAgent=${JSON.stringify(conversationAgent)};
  form.__codingImages=[];
  const announceImages=(message,state='ready')=>{if(!(imageStatus instanceof HTMLElement))return;imageStatus.textContent=message;imageStatus.dataset.state=state;};
  const renderImagePreviews=()=>{if(!(imagePreviews instanceof HTMLElement))return;imagePreviews.replaceChildren();const images=Array.isArray(form.__codingImages)?form.__codingImages:[];imagePreviews.hidden=images.length===0;imagePreviews.dataset.state=images.length?'ready':'empty';images.forEach((image,index)=>{const figure=document.createElement('figure');figure.className='coding-image-preview';const preview=document.createElement('img');preview.src=image.dataUrl;preview.alt='';const caption=document.createElement('figcaption');caption.textContent=image.name;const remove=document.createElement('button');remove.type='button';remove.setAttribute('aria-label','Remove '+image.name);remove.textContent='×';remove.addEventListener('click',()=>{form.__codingImages=images.filter((_,candidate)=>candidate!==index);renderImagePreviews();announceImages(form.__codingImages.length?form.__codingImages.length+' image'+(form.__codingImages.length===1?'':'s')+' attached':'Image removed.');textarea.focus();});figure.append(preview,caption,remove);imagePreviews.append(figure);});};
  const fileDataUrl=(file)=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>typeof reader.result==='string'?resolve(reader.result):reject(new Error('Could not read image.'));reader.onerror=()=>reject(new Error('Could not read image.'));reader.readAsDataURL(file);});
  const imageElement=(dataUrl)=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Could not decode image.'));image.src=dataUrl;});
  const prepareImage=async(file)=>{const allowed=new Set(['image/png','image/jpeg','image/webp','image/gif']);if(!allowed.has(file.type))throw new Error(file.name+' is not a supported image.');const original=await fileDataUrl(file);const decoded=await imageElement(original);if(original.length<=110000)return{name:file.name||'Attached image',mediaType:file.type,dataUrl:original,width:decoded.naturalWidth,height:decoded.naturalHeight};let width=decoded.naturalWidth;let height=decoded.naturalHeight;const initialScale=Math.min(1,1600/Math.max(width,height));width=Math.max(1,Math.round(width*initialScale));height=Math.max(1,Math.round(height*initialScale));const canvas=document.createElement('canvas');const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('Image processing is unavailable.');let quality=.82;let dataUrl='';for(let attempt=0;attempt<8;attempt+=1){canvas.width=width;canvas.height=height;context.fillStyle='#ffffff';context.fillRect(0,0,width,height);context.drawImage(decoded,0,0,width,height);dataUrl=canvas.toDataURL('image/webp',quality);if(dataUrl.length<=110000)break;if(attempt%2===0)quality=Math.max(.45,quality-.12);else{width=Math.max(1,Math.round(width*.82));height=Math.max(1,Math.round(height*.82));}}if(dataUrl.length>120000)throw new Error(file.name+' is too detailed to attach. Try a smaller crop.');return{name:file.name||'Attached image',mediaType:'image/webp',dataUrl,width,height};};
  const addImageFiles=async(files)=>{const current=Array.isArray(form.__codingImages)?form.__codingImages:[];const available=4-current.length;const selected=[...files].slice(0,Math.max(0,available));if(!selected.length){announceImages('You can attach up to 4 images.','error');return;}announceImages('Preparing '+selected.length+' image'+(selected.length===1?'':'s')+'…');try{const prepared=[];for(const file of selected)prepared.push(await prepareImage(file));form.__codingImages=[...current,...prepared];renderImagePreviews();announceImages(form.__codingImages.length+' image'+(form.__codingImages.length===1?'':'s')+' attached.');}catch(error){announceImages(error instanceof Error?error.message:'Could not attach image.','error');}finally{if(imageInput instanceof HTMLInputElement)imageInput.value='';}};
  imageInput?.addEventListener('change',()=>{if(imageInput instanceof HTMLInputElement&&imageInput.files)void addImageFiles(imageInput.files);});
  textarea.addEventListener('paste',(event)=>{const files=[...(event.clipboardData?.files||[])].filter((file)=>file.type.startsWith('image/'));if(!files.length)return;event.preventDefault();void addImageFiles(files);});
  const appendMessage=(author,role,body,meta,externalId,images=[],thinking=false)=>{if(!(thread instanceof HTMLOListElement))return undefined;const scroller=thread.closest('.coding-conversation-scroll');const distanceFromBottom=scroller instanceof HTMLElement?scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight:Number.POSITIVE_INFINITY;const savedScrollTop=scroller instanceof HTMLElement?scroller.scrollTop:0;const item=document.createElement('li');item.className='coding-message '+role+' coding-message-pending'+(thinking?' coding-message-thinking':'');item.dataset.conversationKind=role==='user'?'human-message':'node-message';item.dataset.messageCluster=role==='user'?'human.operator':role==='system'?'coordinator':author;if(thinking){item.dataset.streamPhase='thinking';item.setAttribute('aria-busy','true');}const avatar=document.createElement('span');if(thinking){avatar.className='coding-message-thinking-orb';avatar.dataset.thinkingOrb='';avatar.dataset.orbState='working';avatar.dataset.orbSize='32';avatar.setAttribute('aria-label','Roster is thinking');}else{avatar.className='coding-message-avatar';avatar.setAttribute('aria-hidden','true');avatar.textContent=author.slice(0,1).toUpperCase();}const article=document.createElement('article');if(externalId)article.dataset.codingExternalId=externalId;const header=document.createElement('header');const name=document.createElement('strong');name.textContent=author;header.append(name);article.append(header);if(images.length){const gallery=document.createElement('div');gallery.className='coding-message-images';gallery.dataset.slot='chat-image-gallery';for(const image of images){const figure=document.createElement('figure');const preview=document.createElement('img');preview.src=image.dataUrl;preview.alt='Attached image: '+image.name;const caption=document.createElement('figcaption');caption.textContent=image.name;figure.append(preview,caption);gallery.append(figure);}article.append(gallery);}const copy=document.createElement('p');copy.textContent=body;article.append(copy);let state;if(meta){state=document.createElement('small');state.className='coding-message-delivery';state.setAttribute('role','status');state.setAttribute('aria-live','polite');state.textContent=meta;article.append(state);}item.append(avatar,article);thread.insertBefore(item,statusAnchor());if(scroller instanceof HTMLElement&&newMessages instanceof HTMLButtonElement){const liveEdge=codingComposerLiveEdgeAfterAppend({distanceFromBottom,scrollTop:savedScrollTop,scrollHeight:scroller.scrollHeight,unreadCount:Number(newMessages.dataset.count||'0')});scroller.scrollTop=liveEdge.scrollTop;if(liveEdge.followEnd){newMessages.hidden=true;delete newMessages.dataset.count;const label=newMessages.querySelector('span:last-child');if(label)label.textContent='New messages';}else{newMessages.dataset.count=String(liveEdge.unreadCount);const label=newMessages.querySelector('span:last-child');if(label)label.textContent=liveEdge.unreadCount===1?'New message':liveEdge.unreadCount+' new messages';newMessages.hidden=false;}}return{item,article,state,copy,avatar,name};};
  const annotateMessage=(entry,{tags=[],recipients=[],runtime='',model=''}={})=>{if(!entry)return;const header=entry.article.querySelector('header');if(!(header instanceof HTMLElement))return;if(recipients.length&&!header.querySelector('.coding-message-address')){const address=document.createElement('span');address.className='coding-message-address';address.setAttribute('aria-label','Sent to');const arrow=document.createElement('span');arrow.setAttribute('aria-hidden','true');arrow.textContent='→';address.append(arrow);for(const recipient of recipients){const mention=document.createElement('button');const known=[...document.querySelectorAll('[data-participant-profile][data-profile-name]')].find((candidate)=>candidate instanceof HTMLElement&&candidate.dataset.profileName?.toLowerCase()===recipient.toLowerCase());mention.type='button';mention.className='participant-mention';mention.dataset.participantProfile=recipient==='You'?'human.operator':recipient==='Roster'?'coordinator':known instanceof HTMLElement?known.dataset.participantProfile||recipient:recipient;mention.dataset.profileName=recipient;mention.dataset.profileRole=known instanceof HTMLElement?known.dataset.profileRole||'Agent':recipient==='You'?'Workspace participant':'Agent';mention.dataset.profileKind=recipient==='You'?'human':recipient==='Roster'?'system':'agent';mention.dataset.profileBio=known instanceof HTMLElement?known.dataset.profileBio||'':'';mention.dataset.profileSkills=known instanceof HTMLElement?known.dataset.profileSkills||'[]':'[]';mention.dataset.profileCapabilities=known instanceof HTMLElement?known.dataset.profileCapabilities||'[]':'[]';if(known instanceof HTMLElement&&known.dataset.profileContinuity)mention.dataset.profileContinuity=known.dataset.profileContinuity;mention.setAttribute('aria-haspopup','dialog');mention.setAttribute('aria-controls','participant-profile-dialog');mention.textContent='@'+recipient;address.append(mention);}header.append(address);}const technicalPrefixes=['delivery:','disposition:','intent:','protocol:','routing:','source:','thread:','turn:'];const technicalTags=tags.filter((tag)=>technicalPrefixes.some((prefix)=>tag.startsWith(prefix)));const conversationalTags=tags.filter((tag)=>!technicalPrefixes.some((prefix)=>tag.startsWith(prefix)));if((runtime||model||technicalTags.length)&&!entry.article.querySelector('.coding-message-evidence')){const evidence=document.createElement('details');evidence.className='coding-message-evidence';const summary=document.createElement('summary');summary.textContent='↳ Details';const body=document.createElement('div');const list=document.createElement('dl');for(const [label,value] of [['Runtime',runtime],['Model',model],['Receipts',technicalTags.join(' · ')]]){if(!value)continue;const row=document.createElement('div');const term=document.createElement('dt');const detail=document.createElement('dd');term.textContent=label;detail.textContent=value;row.append(term,detail);list.append(row);}body.append(list);evidence.append(summary,body);entry.article.append(evidence);}if(conversationalTags.length&&!entry.article.querySelector('.coding-message-tags')){const list=document.createElement('ul');list.className='coding-message-tags';list.setAttribute('aria-label','Conversation tags');for(const tag of conversationalTags.slice(0,6)){const chip=document.createElement('li');chip.textContent='#'+tag;list.append(chip);}entry.article.insertBefore(list,entry.article.children[1]||null);}};
  const applyAssistantAuthor=(entry,author)=>{if(!entry||!author||typeof author.name!=='string')return;entry.name.textContent=author.name;entry.item.dataset.messageCluster=typeof author.id==='string'?author.id:author.name;entry.item.classList.remove('system','coding-message-thinking');entry.item.classList.add('agent');entry.item.removeAttribute('aria-busy');entry.avatar.className='coding-message-avatar';entry.avatar.removeAttribute('data-thinking-orb');entry.avatar.removeAttribute('data-orb-state');entry.avatar.removeAttribute('data-orb-size');entry.avatar.removeAttribute('aria-label');entry.avatar.setAttribute('aria-hidden','true');entry.avatar.textContent=author.name.slice(0,1).toUpperCase();annotateMessage(entry,{tags:['source:agent','author:agent','thread:reply','intent:informational','routing:direct-mention'],recipients:['You'],runtime:conversationAgent,model:conversationModel});};
  const updatePending=()=>{const count=queue.length+inFlight;form.dataset.pendingMessages=String(count);if(submit instanceof HTMLButtonElement){submit.disabled=false;submit.title=count?count+' message'+(count===1?'':'s')+' sending or queued':'Send message';}};
  const send=async(item)=>{
    inFlight=1;
    updatePending();
    if(item.user?.state)item.user.state.textContent='Sending…';
    let assistant=appendMessage('Roster','system',item.active?'Checking the live run…':'Working on it…',undefined,undefined,[],true);
    let receivedDelta=false;
    let assistantAuthorId='coordinator';
    const payload=new URLSearchParams(item.fields);
    payload.set('objective',item.objective);
    if(item.images.length)payload.set('images',JSON.stringify(item.images));
    payload.set('externalId',item.externalId);
    if(conversationId)payload.set('conversationId',conversationId);
    try{
      const response=await fetch(form.action,{method:'POST',headers:{Accept:'application/x-ndjson','X-Requested-With':'fetch'},body:payload});
      if(!response.ok||!response.body)throw new Error((await response.text())||'Could not send this message.');
      const reader=response.body.getReader();
      const decoder=new TextDecoder();
      let buffer='';
      const consume=(line)=>{
        if(!line.trim())return;
        const update=JSON.parse(line);
        if(update.type==='accepted'){
          if(typeof update.conversationId==='string')conversationId=update.conversationId;
          if(typeof update.model==='string')conversationModel=update.model;
          item.confirmed=true;
          clearSentDraft(item);
          if(item.user?.state)item.user.state.textContent='Sent';
        }else if(update.type==='progress'&&assistant&&typeof update.message==='string'&&!receivedDelta){
          assistant.avatar.dataset.orbState='searching';
          assistant.copy.textContent=update.message;
        }else if(update.type==='delta'&&typeof update.delta==='string'){
          const nextAuthorId=update.author&&typeof update.author.id==='string'?update.author.id:'coordinator';
          if(receivedDelta&&nextAuthorId!==assistantAuthorId){if(assistant){assistant.item.setAttribute('aria-busy','false');assistant.avatar.dataset.orbPaused='true';}assistant=appendMessage(update.author?.name||'Roster',update.author?'agent':'system','',undefined,undefined,[],false);receivedDelta=false;}
          assistantAuthorId=nextAuthorId;
          applyAssistantAuthor(assistant,update.author);
          if(assistant){if(!receivedDelta){assistant.copy.textContent='';assistant.item.dataset.streamPhase='responding';if(!update.author)assistant.avatar.dataset.orbState='composing';receivedDelta=true;}assistant.copy.append(document.createTextNode(update.delta));}
        }else if(update.type==='error'){
          throw new Error(typeof update.error==='string'?update.error:'Could not send this message.');
        }else if(update.type==='result'&&typeof update.location==='string'){
          latestLocation=update.location;
          shouldNavigate=shouldNavigate||!item.active;
          applyAssistantAuthor(assistant,update.author);
          if(item.active&&item.user?.state)item.user.state.textContent=update.disposition==='running'?'Queued for next safe handoff':update.disposition==='informational'?'Answered live':'Received';
          if(assistant&&!receivedDelta){
            if(update.disposition==='running'){
              assistant.copy.textContent='Your message is in the room and queued for the working team.';
            }else if(update.disposition==='informational'&&typeof update.answer==='string'){
              assistant.copy.textContent=update.answer;
            }else if(update.disposition==='ready'){
              assistant.copy.textContent='Work started.';
            }else if(update.disposition==='needs_clarification'){
              assistant.copy.textContent='I need one detail before execution can start.';
            }
          }
        }
      };
      while(true){
        const next=await reader.read();
        if(next.done)break;
        buffer+=decoder.decode(next.value,{stream:true});
        const lines=buffer.split('\\n');
        buffer=lines.pop()||'';
        for(const line of lines)consume(line);
      }
      buffer+=decoder.decode();
      if(buffer.trim())consume(buffer);
    }catch(error){
      if(item.user?.state)item.user.state.textContent='Needs attention';
      if(assistant){
        assistant.item.dataset.streamPhase='error';
        assistant.item.setAttribute('aria-busy','false');
        assistant.avatar.dataset.orbPaused='true';
        if(assistant.state)assistant.state.textContent='Needs attention';
        assistant.copy.textContent=error instanceof Error?error.message:'Could not send this message.';
      }
    }finally{
      if(assistant){assistant.item.setAttribute('aria-busy','false');assistant.avatar.dataset.orbPaused='true';}
      inFlight=0;
      updatePending();
    }
  };
  const suggestedPrompts={understand:'Understand this repository',plan:'Plan a change',fix:'Fix a problem'};
  for(const suggestion of document.querySelectorAll('[data-room-suggestion]'))suggestion.addEventListener('click',()=>{if(!(suggestion instanceof HTMLButtonElement))return;const prompt=suggestedPrompts[suggestion.dataset.roomSuggestion];if(!prompt)return;textarea.value=prompt;textarea.dispatchEvent(new Event('input',{bubbles:true}));textarea.focus();form.requestSubmit();});
  const drain=async()=>{if(draining)return;draining=true;form.dataset.streamState='draining';try{while(queue.length){const item=queue.shift();if(item)await send(item);}}finally{draining=false;delete form.dataset.streamState;updatePending();textarea.focus();if(latestLocation&&shouldNavigate)location.assign(latestLocation);}};
  form.addEventListener('submit',(event)=>{event.preventDefault();event.stopImmediatePropagation();const images=Array.isArray(form.__codingImages)?[...form.__codingImages]:[];const typed=textarea.value.trim();const objective=typed||(images.length?'Please review the attached image'+(images.length===1?'.':'s.'):'');if(!objective)return;const draftRevision=draftRevisionState.revision;const fields=[];new FormData(form).forEach((value,key)=>{if(typeof value==='string'&&key!=='objective'&&key!=='conversationId'&&key!=='externalId')fields.push([key,value]);});const externalId='ui_'+(globalThis.crypto?.randomUUID?.()||String(Date.now())+'_'+Math.random().toString(36).slice(2));const active=form.dataset.codingActive==='true';const user=appendMessage('You','user',objective,'Sending…',externalId,images,false);const recipients=[...new Set([...objective.matchAll(/(?:^|\\s)@([A-Za-z0-9._-]+)/g)].map((match)=>match[1]))];const inlineTags=[...new Set([...objective.matchAll(/(?:^|\\s)#([a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._-]{0,63})/g)].map((match)=>match[1].toLocaleLowerCase()))];const tags=['source:ui','author:user',...(recipients.length?['routing:mention']:[]),...(images.length?['content:image']:[]),...inlineTags];annotateMessage(user,{tags,recipients});form.__codingImages=[];renderImagePreviews();announceImages('');delete form.dataset.state;queue.push({objective,draftRevision,images,fields,user,externalId,active,confirmed:false});updatePending();queueMicrotask(()=>{delete form.dataset.state;updatePending();});void drain();},true);
});</script>`;

const codingRunLiveClockScript = (nonce: string): string => `<script nonce="${esc(nonce)}">(()=>{
  const elapsedLabel=(elapsedMs)=>{
    const seconds=Math.max(0,Math.floor(elapsedMs/1000));
    if(seconds<5)return 'Live · worker active now';
    if(seconds<60)return 'Live · worker active '+seconds+'s ago';
    const minutes=Math.floor(seconds/60);
    return 'Live · worker active '+minutes+'m ago';
  };
  const update=()=>{
    const row=document.querySelector('[data-coding-run-progress]');
    const clock=row?.querySelector('[data-coding-live-clock]');
    const copy=clock?.querySelector('span');
    if(!(row instanceof HTMLElement)||!(clock instanceof HTMLElement)||!(copy instanceof HTMLElement))return;
    const working=row.dataset.state==='working';
    clock.hidden=!working;
    if(!working)return;
    if(row.dataset.connection==='stale'){
      copy.textContent=row.dataset.connectionLabel||'Updates paused · reconnecting';
      return;
    }
    const runtimeSignal=Number(row.dataset.runtimeSignalAt||'0');
    const durableActivity=Number(row.dataset.lastActivityAt||'0');
    const last=Math.max(
      Number.isFinite(runtimeSignal)?runtimeSignal:0,
      Number.isFinite(durableActivity)?durableActivity:0,
    );
    copy.textContent=last>0&&Number.isFinite(last)
      ?elapsedLabel(Date.now()-last)
      :'Live';
  };
  update();
  const timer=window.setInterval(update,1000);
  document.addEventListener('coding:realtime-applied',update);
  document.addEventListener('coding:runtime-heartbeat',update);
  window.addEventListener('pagehide',()=>window.clearInterval(timer),{once:true});
})();</script>`;

export const codingWorkbenchClientPrelude = String.raw`
  const workbenchTabs=['work','files','team','details'];
  const canonicalWorkbenchTab=(url)=>{
    const requested=url.searchParams.getAll('workbench');
    const selected=requested.find((value)=>workbenchTabs.includes(value));
    if(requested.length!==1||requested[0]!==selected){
      url.searchParams.delete('workbench');
      if(selected)url.searchParams.set('workbench',selected);
    }
    return selected;
  };
  const workbenchEscapeCloses=(overlay)=>overlay;
`;

const codingWorkspaceInteractionScript = (nonce: string): string => `<script nonce="${esc(nonce)}">(()=>{
  const form=document.querySelector('[data-coding-form]');
  const textarea=form?.querySelector('textarea');
  const scrollUrl=new URL(location.href);
  ${codingWorkbenchClientPrelude}
  const scrollWorkspace=scrollUrl.searchParams.get('workspace')||location.pathname;
  const scrollRoom=scrollUrl.searchParams.get('run')||'repository';
  const scrollStorageKey='roster:coding-scroll:v1:'+encodeURIComponent(scrollWorkspace)+':'+encodeURIComponent(scrollRoom);
  const railStorageKey='roster:coding-rail-scroll:v1:'+encodeURIComponent(scrollWorkspace);
  const safeScroll=(value)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
  let storedScroll={messages:0,work:0,inspector:0,openDetails:[]};
  try{
    const parsed=JSON.parse(sessionStorage.getItem(scrollStorageKey)||'{}');
    storedScroll={
      messages:safeScroll(parsed.messages),
      work:safeScroll(parsed.work),
      inspector:safeScroll(parsed.inspector),
      openDetails:Array.isArray(parsed.openDetails)?parsed.openDetails.filter((key)=>typeof key==='string'):[],
    };
  }catch{}
  let roomView=scrollUrl.searchParams.get('view')==='work'?'work':'messages';
  const roomScroll={messages:storedScroll.messages,work:storedScroll.work};
  let roomViewReady=false;
  let saveFrame=0;
  const persistScroll=()=>{
    saveFrame=0;
    try{sessionStorage.setItem(scrollStorageKey,JSON.stringify({...roomScroll,inspector:storedScroll.inspector,openDetails:storedScroll.openDetails}));}catch{}
  };
  const scheduleScrollSave=()=>{
    if(!saveFrame)saveFrame=requestAnimationFrame(persistScroll);
  };
  const scroller=document.querySelector('.coding-conversation-scroll');
  const newMessages=document.querySelector('[data-coding-new-messages]');
  const inspector=document.querySelector('.coding-inspector');
  const projectRail=document.querySelector('.coding-project-rail');
  const atConversationEnd=()=>scroller instanceof HTMLElement&&scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<=80;
  const dismissNewMessages=()=>{if(newMessages instanceof HTMLButtonElement){newMessages.hidden=true;delete newMessages.dataset.count;const label=newMessages.querySelector('span:last-child');if(label)label.textContent='New messages';}};
  newMessages?.addEventListener('click',()=>{if(scroller instanceof HTMLElement){scroller.scrollTo({top:scroller.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});scroller.focus({preventScroll:true});}dismissNewMessages();});
  const roomSearch=document.querySelector('[data-coding-room-search]');
  const roomSearchStatus=document.querySelector('[data-coding-room-search-status]');
  roomSearch?.addEventListener('input',()=>{
    if(!(roomSearch instanceof HTMLInputElement))return;
    const query=roomSearch.value.trim().toLocaleLowerCase();
    let visible=0;
    for(const row of document.querySelectorAll('[data-room-search-entry]')){
      if(!(row instanceof HTMLElement))continue;
      const match=!query||(row.textContent||'').toLocaleLowerCase().includes(query);
      row.hidden=!match;
      if(match)visible+=1;
    }
    if(roomSearchStatus instanceof HTMLElement)roomSearchStatus.textContent=query?visible+' matching room'+(visible===1?'':'s'):'';
  });
  for(const detail of document.querySelectorAll('details[data-details-key]')){
    if(detail instanceof HTMLDetailsElement&&storedScroll.openDetails.includes(detail.dataset.detailsKey))detail.open=true;
  }
  document.addEventListener('toggle',(event)=>{
    const detail=event.target;
    if(!(detail instanceof HTMLDetailsElement)||!detail.dataset.detailsKey)return;
    storedScroll.openDetails=[...document.querySelectorAll('details[data-details-key][open]')]
      .flatMap((candidate)=>candidate instanceof HTMLElement&&candidate.dataset.detailsKey?[candidate.dataset.detailsKey]:[]);
    scheduleScrollSave();
  },true);
  scroller?.addEventListener('scroll',()=>{
    if(!(scroller instanceof HTMLElement)||!roomViewReady)return;
    roomScroll[roomView]=scroller.scrollTop;
    if(atConversationEnd())dismissNewMessages();
    scheduleScrollSave();
  },{passive:true});
  inspector?.addEventListener('scroll',()=>{
    if(!(inspector instanceof HTMLElement)||!roomViewReady)return;
    storedScroll.inspector=inspector.scrollTop;
    scheduleScrollSave();
  },{passive:true});
  if(projectRail instanceof HTMLElement){
    try{projectRail.scrollTop=safeScroll(Number(sessionStorage.getItem(railStorageKey)));}catch{}
    projectRail.addEventListener('scroll',()=>{
      try{sessionStorage.setItem(railStorageKey,String(projectRail.scrollTop));}catch{}
    },{passive:true});
  }
  addEventListener('pagehide',()=>{
    if(scroller instanceof HTMLElement)roomScroll[roomView]=scroller.scrollTop;
    if(inspector instanceof HTMLElement)storedScroll.inspector=inspector.scrollTop;
    persistScroll();
    if(projectRail instanceof HTMLElement)try{sessionStorage.setItem(railStorageKey,String(projectRail.scrollTop));}catch{}
  });
  const setRoomView=(requested,{updateUrl=false}={})=>{
    const view=requested==='work'?'work':'messages';
    const conversation=document.querySelector('.coding-conversation');
    if(conversation instanceof HTMLElement){
      if(roomViewReady&&scroller instanceof HTMLElement)roomScroll[roomView]=scroller.scrollTop;
      if(roomViewReady&&roomView==='work'&&inspector instanceof HTMLElement)storedScroll.inspector=inspector.scrollTop;
      roomView=view;
      conversation.dataset.roomView=view;
      for(const tab of conversation.querySelectorAll('[data-coding-room-tab]')){
        const selected=tab.getAttribute('data-coding-room-tab')===view;
        tab.setAttribute('aria-selected',String(selected));
        if(tab instanceof HTMLButtonElement)tab.tabIndex=selected?0:-1;
      }
      for(const panel of conversation.querySelectorAll('[data-coding-room-panel]')){
        if(panel instanceof HTMLElement)panel.hidden=panel.dataset.codingRoomPanel!==view;
      }
      queueMicrotask(()=>{
        if(scroller instanceof HTMLElement)scroller.scrollTop=roomScroll[view]||0;
        if(view==='work'&&inspector instanceof HTMLElement)inspector.scrollTop=storedScroll.inspector;
        roomViewReady=true;
        scheduleScrollSave();
      });
    }
    if(updateUrl){
      const url=new URL(location.href);
      if(view==='work')url.searchParams.set('view','work');else url.searchParams.delete('view');
      if(url.href!==location.href)history.pushState(history.state,'',url);
    }
  };
  document.addEventListener('click',(event)=>{
    const agentShortcut=event.target instanceof Element?event.target.closest('[data-coding-coordination-agent]'):null;
    if(agentShortcut instanceof HTMLAnchorElement){
      document.dispatchEvent(new CustomEvent('coding:open-workbench',{detail:{tab:'team'}}));
      const detailId=agentShortcut.dataset.codingCoordinationAgent;
      queueMicrotask(()=>{
        const trigger=detailId?document.querySelector('.coding-live [data-coding-agent-trigger][aria-controls="'+CSS.escape(detailId)+'"]'):null;
        if(trigger instanceof HTMLButtonElement&&trigger.getAttribute('aria-expanded')!=='true')trigger.click();
        if(detailId)document.getElementById(detailId)?.scrollIntoView({block:'center'});
      });
      return;
    }
    const workShortcut=event.target instanceof Element?event.target.closest('[data-coding-open-work]'):null;
    if(workShortcut instanceof HTMLButtonElement){
      event.preventDefault();
      document.dispatchEvent(new CustomEvent('coding:open-workbench',{detail:{tab:workShortcut.dataset.workbenchTarget||'work'}}));
      queueMicrotask(()=>document.querySelector('[data-slot="context-cast"]')?.scrollIntoView({block:'start'}));
      return;
    }
    const tab=event.target instanceof Element?event.target.closest('[data-coding-room-tab]'):null;
    if(!(tab instanceof HTMLButtonElement))return;
    setRoomView(tab.dataset.codingRoomTab,{updateUrl:true});
  });
  document.addEventListener('keydown',(event)=>{
    if(event.key==='Escape'){
      const advanced=document.querySelector('[data-composer-advanced][open]');
      if(advanced instanceof HTMLDetailsElement){event.preventDefault();advanced.open=false;advanced.querySelector('summary')?.focus();return;}
    }
    const tab=event.target instanceof HTMLButtonElement&&event.target.matches('[data-coding-room-tab]')?event.target:undefined;
    if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=[...document.querySelectorAll('[data-coding-room-tab]')].filter((candidate)=>candidate instanceof HTMLButtonElement);
    const index=tabs.indexOf(tab);
    if(index<0)return;
    event.preventDefault();
    const nextIndex=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    const next=tabs[nextIndex];
    if(next instanceof HTMLButtonElement){next.focus();setRoomView(next.dataset.codingRoomTab,{updateUrl:true});}
  });
  window.addEventListener('popstate',()=>{
    const url=new URL(location.href);
    setRoomView(url.searchParams.get('view'));
  });
  document.addEventListener('coding:run-panel-updated',()=>setRoomView(roomView));
  setRoomView(roomView);
  const commandDialog=document.querySelector('[data-coding-command-dialog]');
  const commandTrigger=document.querySelector('[data-coding-command-trigger]');
  const commandSearch=document.querySelector('[data-coding-command-search]');
  const commandStatus=document.querySelector('[data-coding-command-status]');
  const commandItems=()=>[...document.querySelectorAll('[data-coding-command-list]>:is(button,a)')]
    .filter((item)=>item instanceof HTMLElement&&!item.hidden);
  const openCommands=()=>{
    if(!(commandDialog instanceof HTMLDialogElement))return;
    if(!commandDialog.open)commandDialog.showModal();
    if(commandSearch instanceof HTMLInputElement){commandSearch.value='';commandSearch.dispatchEvent(new Event('input'));queueMicrotask(()=>commandSearch.focus());}
  };
  commandTrigger?.addEventListener('click',openCommands);
  commandSearch?.addEventListener('input',()=>{
    if(!(commandSearch instanceof HTMLInputElement))return;
    const query=commandSearch.value.trim().toLocaleLowerCase();
    let visible=0;
    for(const item of document.querySelectorAll('[data-coding-command-list]>:is(button,a)')){
      if(!(item instanceof HTMLElement))continue;
      const search=(item.textContent||'')+' '+(item.dataset.commandKeywords||'');
      item.hidden=Boolean(query)&&!search.toLocaleLowerCase().includes(query);
      if(!item.hidden)visible+=1;
    }
    if(commandStatus instanceof HTMLElement)commandStatus.textContent=query?(visible+' command'+(visible===1?'':'s')):'';
  });
  const runCommand=(action)=>{
    if(action==='focus-composer'){
      commandDialog instanceof HTMLDialogElement&&commandDialog.close();
      if(textarea instanceof HTMLTextAreaElement){textarea.scrollIntoView({block:'center'});textarea.focus();}
      return;
    }
    const workbench=/^workbench-(work|files|team|details)$/.exec(action||'');
    if(workbench){
      commandDialog instanceof HTMLDialogElement&&commandDialog.close();
      document.dispatchEvent(new CustomEvent('coding:open-workbench',{detail:{tab:workbench[1]}}));
      return;
    }
  };
  commandDialog?.addEventListener('click',(event)=>{
    if(event.target===commandDialog&&commandDialog instanceof HTMLDialogElement)commandDialog.close();
    const action=event.target instanceof Element?event.target.closest('[data-coding-command-action]'):null;
    if(action instanceof HTMLElement)runCommand(action.dataset.codingCommandAction);
  });
  commandDialog?.addEventListener('keydown',(event)=>{
    if(!['ArrowDown','ArrowUp','Enter'].includes(event.key))return;
    const items=commandItems();
    if(!items.length)return;
    const current=items.indexOf(document.activeElement);
    if(event.key==='Enter'&&document.activeElement===commandSearch){event.preventDefault();items[0]?.click();return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      const delta=event.key==='ArrowDown'?1:-1;
      const next=current<0?(delta>0?0:items.length-1):(current+delta+items.length)%items.length;
      items[next]?.focus();
    }
  });
  document.addEventListener('keydown',(event)=>{
    const key=event.key.toLocaleLowerCase();
    const editable=event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLElement&&event.target.isContentEditable;
    if((event.metaKey||event.ctrlKey)&&key==='k'){
      event.preventDefault();
      openCommands();
      return;
    }
    if(!editable&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&event.key==='/'){
      event.preventDefault();
      if(textarea instanceof HTMLTextAreaElement){textarea.scrollIntoView({block:'center'});textarea.focus();}
    }
  });
  document.querySelectorAll('[data-coding-node-settings]').forEach((settingsForm)=>{
    const workspaceRuntime=settingsForm.querySelector('[data-coding-workspace-runtime]');
    const syncWorkspaceModels=()=>{
      if(!(workspaceRuntime instanceof HTMLSelectElement))return;
      settingsForm.querySelectorAll('[data-coding-workspace-model]').forEach((field)=>{
        if(field instanceof HTMLElement)field.hidden=field.dataset.codingWorkspaceModel!==workspaceRuntime.value;
      });
      const model=settingsForm.querySelector('[data-coding-workspace-model="'+CSS.escape(workspaceRuntime.value)+'"] select');
      model?.dispatchEvent(new Event('ui-select-sync'));
    };
    workspaceRuntime?.addEventListener('change',syncWorkspaceModels);
    syncWorkspaceModels();
  });
  textarea?.addEventListener('keydown',(event)=>{
    if(event.key!=='Enter'||event.shiftKey||event.isComposing)return;
    event.preventDefault();
    if(textarea.value.trim()||(form instanceof HTMLFormElement&&Array.isArray(form.__codingImages)&&form.__codingImages.length))form?.requestSubmit();
  });
  document.addEventListener('keydown',(event)=>{
    const input=event.target instanceof HTMLTextAreaElement&&event.target.matches('[data-generative-ui-reply-input]')?event.target:undefined;
    if(!input||event.key!=='Enter'||event.shiftKey||event.isComposing)return;
    event.preventDefault();
    if(input.value.trim())input.form?.requestSubmit();
  });
  document.addEventListener('submit',(event)=>{
    const inlineForm=event.target instanceof HTMLFormElement&&event.target.matches('[data-generative-ui-reply-form]')?event.target:undefined;
    if(!inlineForm||!(form instanceof HTMLFormElement)||!(textarea instanceof HTMLTextAreaElement))return;
    const input=inlineForm.querySelector('[data-generative-ui-reply-input]');
    if(!(input instanceof HTMLTextAreaElement)||!input.value.trim())return;
    event.preventDefault();
    const reply=inlineForm.closest('[data-generative-ui-reply]');
    const status=inlineForm.querySelector('[data-generative-ui-reply-status]');
    const submit=inlineForm.querySelector('button[type="submit"]');
    if(reply instanceof HTMLElement)reply.dataset.state='sending';
    if(status instanceof HTMLElement)status.textContent='Sending…';
    if(submit instanceof HTMLButtonElement)submit.disabled=true;
    textarea.value=input.value;
    input.value='';
    textarea.dispatchEvent(new Event('input',{bubbles:true}));
    form.requestSubmit();
  });
  addEventListener('beforeunload',(event)=>{
    const unsaved=[...document.querySelectorAll('#coding-objective,[data-generative-ui-reply-input]')]
      .some((input)=>input instanceof HTMLTextAreaElement&&input.value.trim())
      ||(form instanceof HTMLFormElement&&Array.isArray(form.__codingImages)&&form.__codingImages.length>0);
    if(!unsaved)return;
    event.preventDefault();
    event.returnValue='';
  });
  const switcher=document.querySelector('[data-workspace-switcher]');
  const addTrigger=switcher?.querySelector('.coding-add-workspace-trigger');
  const addForm=switcher?.querySelector('#coding-add-workspace');
  addTrigger?.addEventListener('click',()=>{
    if(!(addForm instanceof HTMLFormElement))return;
    const opening=addForm.hidden;
    addForm.hidden=!opening;
    addTrigger.setAttribute('aria-expanded',String(opening));
    if(opening)addForm.querySelector('input')?.focus();
  });
  switcher?.addEventListener('keydown',(event)=>{
    if(event.key!=='Escape')return;
    if(addForm instanceof HTMLFormElement&&!addForm.hidden){
      event.preventDefault();
      addForm.hidden=true;
      addTrigger?.setAttribute('aria-expanded','false');
      addTrigger?.focus();
    }else if(switcher instanceof HTMLDetailsElement&&switcher.open){
      event.preventDefault();
      switcher.open=false;
      switcher.querySelector('summary')?.focus();
    }
  });
  document.addEventListener('click',(event)=>{
    const reply=event.target instanceof Element?event.target.closest('[data-coding-human-reply]'):null;
    if(reply&&textarea instanceof HTMLTextAreaElement){textarea.scrollIntoView({block:'center',behavior:'smooth'});textarea.focus();}
    const configure=event.target instanceof Element?event.target.closest('[data-coding-configure-node]'):null;
    if(configure instanceof HTMLButtonElement){
      event.preventDefault();
      const nodeId=configure.dataset.codingConfigureNode||'';
      const repositoryMenu=document.querySelector('.coding-repository-menu');
      const setting=nodeId?document.querySelector('[data-coding-node-setting="'+CSS.escape(nodeId)+'"]'):null;
      if(repositoryMenu instanceof HTMLDetailsElement&&setting instanceof HTMLElement){
        document.querySelectorAll('.coding-menu[open],.coding-workspace-switcher[open],.coding-mention-menu[open]').forEach((menu)=>{
          if(menu!==repositoryMenu)menu.removeAttribute('open');
        });
        repositoryMenu.open=true;
        const status=repositoryMenu.querySelector('#coding-workspace-settings-status');
        const agentName=setting.querySelector('header strong')?.textContent?.trim()||'this agent';
        if(status instanceof HTMLElement){status.textContent='Editing '+agentName+'. Saved changes apply to future assignments.';delete status.dataset.state;}
        queueMicrotask(()=>{
          setting.scrollIntoView({block:'nearest'});
          const control=setting.querySelector('.ui-select-trigger,[data-coding-workspace-runtime]');
          if(control instanceof HTMLElement)control.focus({preventScroll:true});
        });
      }
      return;
    }
    document.querySelectorAll('.coding-menu[open],.coding-workspace-switcher[open],.coding-mention-menu[open]').forEach((menu)=>{
      if(event.target instanceof Node&&!menu.contains(event.target))menu.removeAttribute('open');
    });
  });
  const pageUrl=new URL(location.href);
  const selectedAgent=pageUrl.searchParams.get('selectedAgent');
  if(selectedAgent){
    const trigger=[...document.querySelectorAll('[data-coding-agent-trigger]')].find((candidate)=>candidate.getAttribute('aria-controls')===selectedAgent);
    if(trigger instanceof HTMLButtonElement)queueMicrotask(()=>trigger.click());
  }
  if(pageUrl.searchParams.has('teamRefresh')||pageUrl.searchParams.has('selectedAgent')){
    pageUrl.searchParams.delete('teamRefresh');
    pageUrl.searchParams.delete('selectedAgent');
    history.replaceState(history.state,'',pageUrl);
  }
})();</script>`;

const codingDisclosureStateScript = (nonce: string): string => `<script nonce="${esc(nonce)}">document.addEventListener('DOMContentLoaded',()=>{
  const storageKey='roster.coding.disclosures.v1';
  const read=()=>{try{const value=JSON.parse(localStorage.getItem(storageKey)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
  const state=read();
  const apply=(root=document)=>{for(const detail of root.querySelectorAll('details[data-disclosure-key]')){if(!(detail instanceof HTMLDetailsElement))continue;const key=detail.dataset.disclosureKey;if(key&&typeof state[key]==='boolean')detail.open=state[key];detail.dataset.state=detail.open?'open':'closed';}};
  const save=(detail)=>{const key=detail.dataset.disclosureKey;if(!key)return;state[key]=detail.open;detail.dataset.state=detail.open?'open':'closed';try{localStorage.setItem(storageKey,JSON.stringify(state));}catch{}};
  apply();
  document.addEventListener('toggle',(event)=>{if(event.target instanceof HTMLDetailsElement&&event.target.matches('[data-disclosure-key]'))save(event.target);},true);
  document.addEventListener('coding:run-panel-updated',()=>apply());
});</script>`;

export const codingShell = (options: {
  readonly state: OrchestrationState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly eventTimestamps?: ReadonlyArray<number>;
  readonly runId?: string;
  readonly job?: CodingDemoJob;
  readonly conversationJob?: CodingDemoJob;
  readonly nonce: string;
  readonly repositoryPath: string;
  readonly gitRemote: string;
  readonly gitAccount: string;
  readonly repository?: CodingRepositoryGitState;
  readonly recentRuns?: ReadonlyArray<CodingRecentRun>;
  readonly rooms?: ReadonlyArray<CodingDurableRoom>;
  readonly workspaceProfile?: CodingWorkspaceProfile;
  readonly runtimeLogs?: ReadonlyArray<StoredNodeRuntimeLog>;
  readonly roomUpdates?: ReadonlyArray<NodeRoomUpdate>;
  readonly workspaceId?: string;
  readonly workspaces?: ReadonlyArray<CodingWorkspaceOption>;
  readonly runtimeOptions?: ReadonlyArray<CodingWorkerRuntimeOption>;
  readonly workspaceWorkerRuntime?: CodingWorkspaceWorkerRuntime;
  readonly workspaceCodexModel?: CodingWorkspaceCodexModel;
  readonly workspacePiModel?: CodingWorkspacePiModel;
  readonly workspaceClaudeModel?: CodingWorkspaceClaudeModel;
  readonly workspaceHermesModel?: CodingWorkspaceHermesModel;
  readonly workspaceSettings?: CodingWorkspaceSettings;
  readonly workspaceSettingsNotice?: string;
  readonly workspaceSettingsNoticeNodeId?: string;
  readonly chatModel?: string;
  readonly teamRefreshNotice?: string;
  readonly attentionItems?: ReadonlyArray<CodingAttentionItem>;
  readonly rescanRequestId?: string;
  readonly realtime?: CodingRealtimeConfig;
  readonly continuitySummaries?: Readonly<Record<string, NodeContinuitySummary>>;
  readonly composerDraft?: string;
  readonly showGlobalNavigation?: boolean;
}): string => {
  const codingBuild = readCodingBuildManifest();
  const codingBuildFingerprint = esc(codingBuild.fingerprint);
  const recentRuns = options.recentRuns ?? [];
  const profile = options.workspaceProfile;
  const workspaceWorkerRuntime = options.workspaceWorkerRuntime ?? DEFAULT_CODING_WORKSPACE_WORKER_RUNTIME;
  const workspaceWorkerModel: CodingWorkspaceWorkerModel = options.workspaceSettings
    ? codingWorkspaceSelectedModel(options.workspaceSettings)
    : workspaceWorkerRuntime === "pi-agent"
      ? options.workspacePiModel ?? DEFAULT_CODING_WORKSPACE_PI_MODEL
      : workspaceWorkerRuntime === "claude-code"
        ? options.workspaceClaudeModel ?? DEFAULT_CODING_WORKSPACE_CLAUDE_MODEL
        : workspaceWorkerRuntime === "hermes-agent"
          ? options.workspaceHermesModel ?? DEFAULT_CODING_WORKSPACE_HERMES_MODEL
          : options.workspaceCodexModel ?? DEFAULT_CODING_WORKSPACE_CODEX_MODEL;
  const shellScripts = `${codingDisclosureStateScript(options.nonce)}${codingAgentDetailsScript(options.nonce)}${codingWorkspaceScanScript(options.nonce)}${codingConversationStreamScript(
    options.nonce,
    codingRuntimeLabel(workspaceWorkerRuntime),
  )}${codingRunLiveClockScript(options.nonce)}`;
  const content = profile
    ? `<section class="coding-workbench" aria-label="Coding workspace" data-workspace-shell data-layout="slack-workspace" data-slot="workspace-shell">${codingProjectRailHtml({
        profile,
        repositoryPath: options.repositoryPath,
        recentRuns,
        rooms: options.rooms ?? [],
        currentRunId: options.runId,
        ...(options.job ? { currentJobId: options.job.id } : {}),
        workspaceId: options.workspaceId ?? "",
        workspaces: options.workspaces ?? [],
        runtimeOptions: options.runtimeOptions ?? DEFAULT_CODING_WORKER_RUNTIME_OPTIONS,
        workspaceWorkerRuntime,
        workspaceWorkerModel,
        ...(options.workspaceSettings ? { workspaceSettings: options.workspaceSettings } : {}),
        ...(options.teamRefreshNotice ? { teamRefreshNotice: options.teamRefreshNotice } : {}),
        attentionItems: options.attentionItems ?? [],
        rescanRequestId: options.rescanRequestId ?? "workspace-rescan-request",
        continuitySummaries: options.continuitySummaries,
      })}<section class="coding-conversation" aria-label="Repository conversation" data-slot="workspace-conversation" data-workspace-region="conversation"><div class="coding-conversation-scroll" data-slot="conversation-feed" tabindex="-1"><div class="coding-conversation-column">${codingRunPanelHtml({ ...options, detachedContextCast: true })}</div></div><button class="coding-new-messages" type="button" data-coding-new-messages hidden><span aria-hidden="true">↓</span><span>New messages</span></button>${codingContextCastHtml(options, "rail")}<button class="coding-overlay-scrim" type="button" aria-label="Close Workbench" aria-hidden="true" tabindex="-1" data-coding-overlay-scrim hidden></button><div class="coding-composer-wrap" data-slot="composer-dock"><div class="coding-composer-grid">${composerHtml({
        ...options,
        workspaceWorkerRuntime,
        workspaceWorkerModel,
        })}</div></div></section></section>${codingWorkspacePickerScript(options.nonce)}`
    : `<section class="coding-empty-workspace" id="coding-workspace">${onboardingHtml(options.workspaceId)}</section>`;
  const realtimeBoot = options.realtime
    ? `<script id="coding-realtime-boot" type="application/json" nonce="${esc(options.nonce)}">${scriptJson({
        workspaceId: options.realtime.workspaceId,
        codingWorkspaceId: options.workspaceId,
        activeRunId: options.realtime.activeRunId,
        conversationId: options.runId,
        job: options.job ? {
          id: options.job.id,
          status: options.job.status,
          runKind: options.job.runKind,
        } : undefined,
        committedUsageNote: Boolean(codingCommittedUsageNote(options.state, options.job)),
        delivery: options.job || (options.runId && codingGraphComplete(options.state)) ? {
          status: codingRunDeliveryState(options.state, options.job),
          certified: Boolean(options.job?.commit),
          branch: options.job?.deliveryDisposition?.branch ?? options.job?.branch,
          targetBranch: options.job?.integration?.currentBranch ?? options.job?.baselineBranch,
          reason: codingRunDeliveryState(options.state, options.job) === "blocked"
            ? codingPublicFailureReason({ certified: Boolean(options.job?.commit) })
            : codingUnavailableDeliveryReason(options.job),
        } : undefined,
        realtime: {
          enabled: options.realtime.enabled,
          uri: options.realtime.uri,
          database: options.realtime.database,
          confirmedReads: options.realtime.confirmedReads,
        },
      })}</script><script type="module" src="/assets/coding-client.js?v=${codingBuildFingerprint}" nonce="${esc(options.nonce)}"></script>`
    : "";
  const roomUpdatesModel = options.roomUpdates
    ? `<script id="coding-room-updates-model" type="application/json" nonce="${esc(options.nonce)}">${scriptJson({
        updates: options.roomUpdates,
      })}</script>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="theme-color" content="#11120f"/><title>Roster - Coding Roster</title>
<meta name="roster-coding-build" content="${codingBuildFingerprint}"><script type="importmap" nonce="${esc(options.nonce)}">${scriptJson({ imports: { "/assets/coding-mermaid-renderer.js": `/assets/coding-mermaid-renderer.js?v=${codingBuildFingerprint}` } })}</script>
${themeBootstrapScript(options.nonce)}<style nonce="${esc(options.nonce)}">
  ${codingTypographyCss}
  .coding-attention{border-color:var(--warning-border);background:var(--warning-surface)}.coding-attention>header span{color:var(--warning)}.coding-attention-controls{display:grid;gap:4px;padding:0 0 8px}.coding-attention-controls button{min-height:30px;border:1px solid var(--warning-border);border-radius:var(--radius-control);color:var(--text-primary);background:var(--surface-raised);cursor:pointer;font-size:9px;font-weight:700}.coding-attention-controls button:focus-visible,.coding-attention form button:focus-visible,.coding-attention a:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-attention-controls span{min-height:12px;color:var(--text-tertiary);font-size:8px;line-height:1.4}.coding-attention ol{display:grid;gap:7px;margin:0;padding:0;list-style:none}.coding-attention li{display:grid;grid-template-columns:7px minmax(0,1fr);gap:8px;padding:6px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-attention-state{width:7px;height:7px;margin-top:4px;border-radius:50%;background:var(--danger)}.coding-attention li[data-state="merge-ready"] .coding-attention-state{background:var(--success)}.coding-attention li[data-state="needs-input"] .coding-attention-state,.coding-attention li[data-state="merge-blocked"] .coding-attention-state{background:var(--warning)}.coding-attention li strong,.coding-attention li small{display:block}.coding-attention li strong{font-size:9px}.coding-attention li small{margin-top:2px;color:var(--text-tertiary);font-size:7px}.coding-attention li p{margin:5px 0;color:var(--text-secondary);font-size:8px;line-height:1.4}.coding-attention li form{margin:0}.coding-attention li button,.coding-attention li a{min-height:28px;display:inline-flex;align-items:center;padding:0 8px;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--text-primary);background:var(--surface-raised);cursor:pointer;font-size:8px;font-weight:700;text-decoration:none}.coding-attention li[data-state="merge-ready"] button{border-color:var(--success-border);color:var(--success)}
  .coding-attention{padding:0}.coding-attention>summary{min-height:56px;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:9px 12px;color:var(--text-secondary);cursor:pointer;list-style:none}.coding-attention>summary::-webkit-details-marker{display:none}.coding-attention>summary:hover,.coding-attention[open]>summary{color:var(--text-primary);background:color-mix(in srgb,var(--warning) 5%,transparent)}.coding-attention>summary span{min-width:0}.coding-attention>summary h2,.coding-attention>summary small{display:block}.coding-attention>summary h2{color:inherit}.coding-attention>summary small{margin-top:3px;color:var(--text-tertiary);font-size:7px}.coding-attention>summary strong{min-width:22px;padding:4px 6px;border:1px solid var(--warning-border);border-radius:999px;color:var(--warning);background:var(--surface-raised);font:8px/1 var(--font-mono);text-align:center}.coding-attention>summary i{font-style:normal;transition:transform .15s ease}.coding-attention[open]>summary i{transform:rotate(180deg)}.coding-attention-body{padding:0 8px 10px}.coding-attention-overflow{margin:8px 2px 0;color:var(--text-tertiary);font-size:7px;line-height:1.45}
  .coding-attention>summary{grid-template-columns:minmax(0,1fr) auto}.coding-attention>summary i{display:none}
  :root{color-scheme:dark;${codingThemeTokens};--bg:var(--surface-canvas);--panel:var(--surface-panel);--panel-2:var(--surface-inset);--raised:var(--surface-raised);--line:var(--border-strong);--line-soft:var(--border-subtle);--ink:var(--text-primary);--muted:var(--text-secondary);--faint:var(--text-tertiary);--blue:var(--accent-strong);--green:var(--success);--shell-bar:44px;--radius-sm:var(--radius-control);--radius-md:var(--radius-card);--radius-lg:var(--radius-overlay);--agent-accent:var(--accent-strong);--agent-accent-soft:rgba(185,246,124,.1);--coding-bg:var(--surface-canvas);--coding-panel:var(--surface-panel);--coding-raised:var(--surface-raised);--coding-line:var(--border-subtle);--coding-ink:var(--text-primary);--coding-muted:var(--text-secondary);--coding-faint:var(--text-tertiary);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}html,body{height:100%;height:100dvh;margin:0;background:var(--coding-bg);color:var(--coding-ink);font-family:inherit;overscroll-behavior:none}body{min-width:0;overflow:hidden}button,input,textarea,select{font:inherit}button,a,input,textarea,select,summary{touch-action:manipulation;-webkit-tap-highlight-color:rgba(185,246,124,.12)}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.skip-link{position:fixed;z-index:100;left:12px;top:8px;transform:translateY(-160%);padding:7px 10px;border-radius:var(--radius-control);color:var(--coding-bg);background:var(--coding-ink);font-size:10px;text-decoration:none}.skip-link:focus{transform:none}
  ${agentShellChromeCss()}
  .coding-page.agent-app{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:44px minmax(0,1fr);min-width:0;height:100dvh;overflow:hidden}.coding-page .agent-main{grid-column:1;grid-row:2;width:100%;max-width:none;height:calc(100dvh - 44px);min-height:0;padding:0;background:var(--coding-bg)}
  .coding-build-notice{position:fixed;z-index:30;right:18px;bottom:18px;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 36px);padding:9px 11px;border:1px solid var(--border-strong);border-radius:var(--radius-card);color:var(--text-secondary);background:var(--surface-raised);box-shadow:var(--shadow-card);font-size:10px}.coding-build-notice[hidden]{display:none}.coding-build-notice button{min-height:28px;border:1px solid var(--border-strong);border-radius:var(--radius-control);padding:0 9px;color:var(--text-primary);background:var(--surface-inset);cursor:pointer;font-size:9px;font-weight:700}.coding-build-notice button:hover{background:var(--surface-hover)}.coding-build-notice button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
  .coding-page .agent-top-nav{position:relative;z-index:12;height:44px;min-height:44px;gap:12px;padding:5px 14px;border-color:var(--coding-line);background:rgba(13,13,13,.94)}.coding-page .agent-top-nav-actions,.coding-page .agent-top-nav-actions nav{display:flex;align-items:center;gap:3px}
  .coding-repo-mark,.coding-onboarding-mark{display:grid;place-items:center;border:1px solid #373737;background:#222;color:var(--coding-ink);font-weight:700}.coding-repo-mark{width:28px;height:28px;border-radius:7px;font-size:13px}
  .coding-menu{position:relative}.coding-menu>summary{min-height:34px;display:flex;align-items:center;gap:7px;padding:0 9px;border:1px solid transparent;border-radius:7px;color:var(--coding-muted);cursor:pointer;font-size:10px;font-weight:650;list-style:none}.coding-menu>summary::-webkit-details-marker{display:none}.coding-menu>summary:hover,.coding-menu[open]>summary{border-color:var(--coding-line);color:var(--coding-ink);background:var(--coding-panel)}.coding-menu-panel{position:absolute;top:calc(100% + 7px);right:0;width:min(390px,calc(100vw - 28px));max-height:min(520px,70vh);overflow:auto;padding:8px;border:1px solid #343434;border-radius:11px;background:#181818;box-shadow:0 20px 60px rgba(0,0,0,.5)}.coding-menu-panel>header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 8px 10px;border-bottom:1px solid var(--coding-line)}.coding-menu-panel>header strong{display:block;font-size:11px}.coding-menu-panel>header span,.coding-menu-panel>header small{color:var(--coding-muted);font-size:9px}.coding-menu-panel>header small{display:block;margin-top:3px}.coding-history-list,.coding-team-list{margin:0;padding:5px 0;list-style:none}.coding-history-list li a{display:grid;grid-template-columns:7px minmax(0,1fr);gap:9px;align-items:start;padding:8px;border-radius:7px;color:inherit;text-decoration:none}.coding-history-list li a:hover,.coding-history-list li[aria-current="page"] a{background:var(--coding-raised)}.coding-history-dot{width:6px;height:6px;margin-top:5px;border-radius:50%;background:var(--coding-faint)}.coding-history-list li[data-state="active"] .coding-history-dot{background:#b6cffb}.coding-history-list li[data-state="success"] .coding-history-dot{background:#74c991}.coding-history-list li[data-state="failed"] .coding-history-dot{background:#e48383}.coding-history-list strong{display:block;overflow:hidden;text-overflow:ellipsis;font-size:10px;line-height:1.4;white-space:nowrap}.coding-history-list small{display:block;margin-top:2px;color:var(--coding-faint);font-size:8px}.coding-menu-empty{margin:0;padding:18px 8px;color:var(--coding-muted);font-size:10px;text-align:center}
  .coding-agent-avatar{width:29px;height:29px;display:grid;place-items:center;border-radius:8px;color:var(--coding-ink);background:#303030;font-size:9px;font-weight:700}
  .coding-repository-panel{width:min(460px,calc(100vw - 28px));padding:15px}.coding-repository-panel>strong{display:block;overflow-wrap:anywhere;font-size:10px}.coding-repository-panel dl{display:grid;gap:7px;margin:13px 0}.coding-repository-panel dl>div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px;padding-top:7px;border-top:1px solid var(--coding-line)}.coding-repository-panel dt{color:var(--coding-faint);font-size:8px}.coding-repository-panel dd{margin:0;color:var(--coding-muted);font-size:9px;overflow-wrap:anywhere}.coding-repository-panel p{margin:0;padding:10px;border-radius:7px;color:var(--coding-muted);background:#111;font-size:9px;line-height:1.5}.coding-repository-panel p strong{color:var(--coding-ink)}.coding-workspace-settings{margin:13px 0;padding:11px;border:1px solid var(--border-subtle,var(--coding-line));border-radius:var(--radius-card,9px);color:var(--text-primary,var(--coding-ink));background:var(--surface-inset,#111)}.coding-workspace-settings h2{margin:0 0 5px;color:var(--text-primary,var(--coding-ink));font-size:10px}.coding-workspace-agent-settings{display:grid;gap:6px;margin:9px 0;padding:0;list-style:none}.coding-workspace-agent-setting{display:grid;grid-template-columns:112px minmax(0,1fr);gap:8px;align-items:end;padding:7px;border:1px solid var(--border-subtle,var(--coding-line));border-radius:var(--radius-control,7px);background:var(--surface-panel,var(--coding-panel))}.coding-workspace-agent-setting[data-state="saved"]{border-color:var(--success-border,var(--success))}.coding-workspace-agent-setting>header{min-width:0;display:grid;grid-template-columns:24px minmax(0,1fr);gap:7px;align-items:center;padding-bottom:5px}.coding-workspace-agent-mark{width:24px;height:24px}.coding-workspace-agent-setting>header strong,.coding-workspace-agent-setting>header small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-workspace-agent-setting>header strong{font-size:9px}.coding-workspace-agent-setting>header small{margin-top:2px;color:var(--text-tertiary,var(--coding-faint));font-size:7px}.coding-workspace-settings form{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) 42px;gap:6px;align-items:end}.coding-workspace-settings-fields{min-width:0;display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:6px}.coding-workspace-setting{min-width:0;display:grid;gap:3px}.coding-workspace-setting>label{color:var(--text-tertiary,var(--coding-faint));font-size:7px}.coding-workspace-setting[hidden]{display:none}.coding-workspace-settings select{width:100%;height:30px;color:var(--text-primary,var(--coding-ink));background:var(--surface-raised,#181818);font-size:8px}.coding-workspace-settings .ui-select-trigger{min-height:30px;font-size:8px}.coding-workspace-settings button[type="submit"]{height:30px;padding:0 8px;border:1px solid var(--action-primary,var(--text-primary));border-radius:var(--radius-control,7px);color:var(--action-primary-foreground,#161616);background:var(--action-primary,#ececec);font-size:8px;font-weight:650;cursor:pointer}.coding-workspace-settings button[type="submit"]:hover{border-color:var(--action-primary-hover,var(--action-primary));background:var(--action-primary-hover,#fff)}.coding-repository-panel .coding-workspace-settings p{margin:7px 0 0;padding:0;color:var(--text-tertiary,var(--coding-faint));background:transparent;font-size:8px}.coding-repository-panel .coding-workspace-settings p:empty{display:none}.coding-repository-panel .coding-workspace-settings p[data-state="success"]{color:var(--success)}
  .coding-empty-workspace{min-height:calc(100vh - 48px);display:grid;place-items:center;padding:48px 20px}.coding-onboarding{width:min(520px,100%);display:flex;align-items:center;flex-direction:column;text-align:center}.coding-onboarding-mark{width:44px;height:44px;margin-bottom:22px;border-radius:12px;font-size:14px}.coding-onboarding>p{margin:0 0 9px;color:var(--coding-muted);font-size:10px}.coding-onboarding h2{margin:0;color:var(--coding-ink);font-size:24px;line-height:1.2;letter-spacing:-.035em}.coding-onboarding>span{max-width:460px;margin-top:12px;color:var(--coding-muted);font-size:12px;line-height:1.65}.coding-onboarding form{margin-top:24px}.coding-onboarding button{min-width:218px;min-height:42px;padding:0 17px;border:1px solid #ebebeb;border-radius:9px;color:#111;background:#f2f2f2;cursor:pointer;font-size:11px;font-weight:700}.coding-onboarding button:hover{background:#fff}.coding-onboarding button:disabled{cursor:wait;opacity:.72}.coding-onboarding .coding-onboarding-status{min-height:32px;margin:12px 0 0;max-width:460px;color:var(--coding-muted);font-size:9px;line-height:1.5}.coding-onboarding .coding-onboarding-status[data-state="pending"]{color:var(--accent-strong)}.coding-onboarding .coding-onboarding-status[data-state="error"]{color:var(--danger)}.coding-onboarding small{margin-top:7px;color:var(--coding-faint);font-size:8px}
  .coding-workbench{height:calc(100vh - 48px);min-height:0;display:grid;grid-template-columns:224px minmax(0,1fr)}.coding-project-rail{min-height:0;overflow:auto;overscroll-behavior:contain;border-right:1px solid var(--coding-line);background:#111;scrollbar-width:thin}.coding-project-identity{min-width:0;display:grid;grid-template-columns:28px minmax(0,1fr);gap:9px;align-items:center;padding:14px 12px}.coding-project-identity>span{width:28px;height:28px;display:grid;place-items:center;border:1px solid #343434;border-radius:6px;color:var(--coding-ink);background:#202020;font-size:9px;font-weight:750}.coding-project-identity>div{min-width:0}.coding-project-identity strong,.coding-project-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-project-identity strong{font-size:10px}.coding-project-identity small{margin-top:2px;color:var(--coding-faint);font:7px/1.35 ui-monospace,monospace}.coding-project-section{padding:11px 8px;border-top:1px solid var(--coding-line)}.coding-project-section>header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 4px 7px}.coding-project-section h2{margin:0;color:var(--coding-muted);font-size:8px;font-weight:750;text-transform:uppercase;letter-spacing:.07em}.coding-project-section>header>span{color:var(--coding-faint);font:7px/1.2 ui-monospace,monospace}.coding-project-section>p{margin:7px 4px 0;color:var(--coding-faint);font-size:7px;line-height:1.45}.coding-project-technologies{display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:0 4px;list-style:none}.coding-project-technologies li{padding:3px 5px;border:1px solid #2f2f2f;border-radius:4px;color:#aebbd0;background:#171717;font:7px/1.2 ui-monospace,monospace}.coding-project-scan{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:8px 4px 0;color:var(--coding-faint);font:7px/1.3 ui-monospace,monospace}.coding-project-scan button{padding:0;border:0;color:var(--coding-muted);background:transparent;font:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer}.coding-project-scan button:hover{color:var(--coding-ink)}.coding-project-runs ol,.coding-project-team ul{margin:0;padding:0;list-style:none}.coding-project-runs a{min-width:0;display:grid;grid-template-columns:6px minmax(0,1fr);gap:8px;align-items:start;padding:7px 5px;border-radius:5px;color:inherit;text-decoration:none}.coding-project-runs a:hover,.coding-project-runs a[aria-current="page"]{background:var(--coding-raised)}.coding-project-run-state{width:5px;height:5px;margin-top:4px;border-radius:50%;background:var(--coding-faint)}.coding-project-runs li[data-state="active"] .coding-project-run-state{background:#b6cffb}.coding-project-runs li[data-state="success"] .coding-project-run-state{background:#74c991}.coding-project-runs li[data-state="failed"] .coding-project-run-state{background:#e48383}.coding-project-runs strong,.coding-project-runs small,.coding-project-team strong,.coding-project-team small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-project-runs strong{font-size:8px;line-height:1.35}.coding-project-runs small{margin-top:2px;color:var(--coding-faint);font-size:7px}.coding-project-empty{padding:9px 5px;color:var(--coding-faint);font-size:8px;line-height:1.45}.coding-project-team li{min-width:0;display:grid;grid-template-columns:24px minmax(0,1fr);gap:7px;align-items:center;padding:6px 5px}.coding-project-agent-mark{width:24px;height:24px;display:grid;place-items:center;border-radius:6px;color:#ddd;background:#292929;font-size:8px;font-weight:700}.coding-project-team strong{font-size:8px}.coding-project-team small{margin-top:2px;color:var(--coding-faint);font:7px/1.3 ui-monospace,monospace}.coding-project-rail>footer{display:grid;gap:3px;padding:10px 12px;border-top:1px solid var(--coding-line);color:var(--coding-faint);font:7px/1.35 ui-monospace,monospace}.coding-project-rail>footer span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .coding-project-scan{flex-wrap:wrap}.coding-project-scan form[aria-busy="true"] button{cursor:wait;opacity:.55}.coding-project-scan button:disabled{cursor:wait;opacity:.55}.coding-project-scan>p{flex-basis:100%;min-height:0;margin:0;color:var(--coding-faint);font-size:7px;line-height:1.45}.coding-project-scan>p:empty{display:none}.coding-project-scan>p[data-state="success"]{color:var(--success)}.coding-project-scan>p[data-state="error"]{color:var(--danger)}
  .coding-workspace-switcher{border-bottom:1px solid var(--coding-line)}.coding-workspace-switcher>summary{grid-template-columns:28px minmax(0,1fr) 12px;cursor:pointer;list-style:none}.coding-workspace-switcher>summary::-webkit-details-marker{display:none}.coding-workspace-switcher>summary>i{color:var(--coding-faint);font-size:16px;font-style:normal;transition:transform .14s ease}.coding-workspace-switcher[open]>summary{background:#181818}.coding-workspace-switcher[open]>summary>i{transform:rotate(90deg)}.coding-workspace-switcher-panel{padding:6px 7px 8px;border-top:1px solid #242424;background:#151515}.coding-workspace-switcher-panel>header{display:flex;align-items:center;justify-content:space-between;padding:5px 5px 6px}.coding-workspace-switcher-panel>header strong{color:var(--coding-muted);font-size:8px;text-transform:uppercase;letter-spacing:.07em}.coding-workspace-switcher-panel>header span{color:var(--coding-faint);font:7px/1 ui-monospace,monospace}.coding-workspace-switcher-panel ul{max-height:220px;overflow:auto;margin:0;padding:0;list-style:none;scrollbar-width:thin}.coding-workspace-switcher-panel li a{min-width:0;display:grid;grid-template-columns:24px minmax(0,1fr) 12px;gap:7px;align-items:center;padding:6px 5px;border-radius:6px;color:inherit;text-decoration:none}.coding-workspace-switcher-panel li a:hover,.coding-workspace-switcher-panel li a[aria-current="page"]{background:var(--coding-raised)}.coding-workspace-mark{width:24px;height:24px;display:grid;place-items:center;border:1px solid #343434;border-radius:6px;background:#252525;font-size:8px;font-weight:750}.coding-workspace-switcher-panel li a>span:nth-child(2){min-width:0}.coding-workspace-switcher-panel li strong,.coding-workspace-switcher-panel li small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-workspace-switcher-panel li strong{font-size:8px}.coding-workspace-switcher-panel li small{margin-top:2px;color:var(--coding-faint);font:7px/1.3 ui-monospace,monospace}.coding-workspace-switcher-panel li i{color:#8fbda0;font-size:9px;font-style:normal}.coding-add-workspace-trigger{width:100%;margin-top:5px;padding:7px 6px;border:0;border-top:1px solid #292929;color:var(--coding-muted);background:transparent;cursor:pointer;text-align:left;font-size:8px}.coding-add-workspace-trigger:hover{color:var(--coding-ink);background:#1b1b1b}.coding-workspace-switcher form{display:grid;gap:6px;padding:8px 5px 3px}.coding-workspace-switcher form[hidden]{display:none}.coding-workspace-switcher label{color:var(--coding-muted);font-size:8px;font-weight:700}.coding-workspace-switcher input{width:100%;height:30px;padding:0 7px;border:1px solid #3a3a3a;border-radius:6px;color:var(--coding-ink);background:#0e0e0e;font:8px/1.2 ui-monospace,monospace;outline:0}.coding-workspace-switcher input:focus{border-color:#7184a3}.coding-workspace-switcher form>span{color:var(--coding-faint);font-size:7px;line-height:1.4}.coding-workspace-switcher form>button{justify-self:start;padding:6px 8px;border:1px solid #d8d8d8;border-radius:6px;color:#111;background:#e8e8e8;cursor:pointer;font-size:8px;font-weight:750}.coding-workspace-switcher form>button:hover{background:#fff}
  .coding-workspace-picker{width:min(920px,calc(100vw - 32px));max-width:none;max-height:min(720px,calc(100vh - 32px));margin:auto;padding:0;overflow:hidden;border:1px solid var(--border-strong);border-radius:var(--radius-lg);color:var(--text-primary);background:transparent;box-shadow:var(--shadow-overlay)}.coding-workspace-picker::backdrop{background:rgba(3,4,6,.72);backdrop-filter:blur(8px)}.coding-workspace-picker-surface{position:relative;height:min(680px,calc(100vh - 34px));display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;background:var(--surface-overlay)}.coding-workspace-add-progress{position:absolute;inset:0;z-index:10;display:none;place-content:center;justify-items:center;gap:12px;padding:28px;text-align:center;background:rgba(10,12,16,.94);backdrop-filter:blur(10px)}.coding-workspace-picker[data-state="busy"] .coding-workspace-add-progress{display:grid}.coding-workspace-add-spinner{width:42px;height:42px;border:3px solid var(--border-strong);border-top-color:var(--accent-strong);border-radius:50%;animation:coding-workspace-spin .85s linear infinite}.coding-workspace-add-progress strong{font-size:18px}.coding-workspace-add-progress p{max-width:430px;margin:0;color:var(--text-secondary);font-size:12px;line-height:1.55}.coding-workspace-add-progress progress{width:min(360px,70vw);height:6px;accent-color:var(--accent-strong)}.coding-workspace-add-progress small{color:var(--text-tertiary);font:9px/1.4 ui-monospace,monospace}@keyframes coding-workspace-spin{to{transform:rotate(360deg)}}.coding-workspace-picker-header{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:12px;align-items:center;padding:18px 20px;border-bottom:1px solid var(--border-subtle);background:linear-gradient(180deg,#1a1d24,var(--surface-overlay))}.coding-workspace-picker-mark{width:40px;height:40px;display:grid;place-items:center;border:1px solid #3d4758;border-radius:11px;color:var(--accent-strong);background:#202734;font-size:15px;font-weight:800}.coding-workspace-picker-header h2{margin:0;font-size:16px;line-height:1.25;letter-spacing:-.015em;text-wrap:balance}.coding-workspace-picker-header p{margin:4px 0 0;color:var(--text-secondary);font-size:11px;line-height:1.45}.coding-workspace-picker-header form{margin:0}.coding-icon-button{width:32px;height:32px;display:grid;place-items:center;padding:0;border:1px solid transparent;border-radius:var(--radius-sm);color:var(--text-secondary);background:transparent;cursor:pointer;font-size:20px;line-height:1}.coding-icon-button:hover{border-color:var(--border-subtle);color:var(--text-primary);background:var(--surface-raised)}.coding-workspace-picker-body{min-height:0;display:grid;grid-template-columns:190px minmax(0,1fr)}.coding-workspace-picker-body>aside{min-height:0;padding:18px 12px;border-right:1px solid var(--border-subtle);background:#101217}.coding-workspace-picker-body>aside h3{margin:0 8px 10px;color:var(--text-tertiary);font-size:9px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.coding-workspace-picker-body>aside nav{display:grid;gap:3px}.coding-workspace-location{min-width:0;display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;align-items:center;width:100%;min-height:36px;padding:0 9px;border:1px solid transparent;border-radius:var(--radius-sm);color:var(--text-secondary);background:transparent;cursor:pointer;text-align:left;font-size:11px}.coding-workspace-location>span:first-child{color:var(--text-tertiary);font-size:12px}.coding-workspace-location>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-workspace-location:hover,.coding-workspace-location[aria-current="true"]{border-color:var(--border-subtle);color:var(--text-primary);background:var(--surface-raised)}.coding-workspace-picker-body>aside p{margin:18px 8px 0;color:var(--text-tertiary);font-size:9px;line-height:1.55}.coding-workspace-browser{min-width:0;min-height:0;display:grid;grid-template-rows:42px auto minmax(0,1fr) auto}.coding-workspace-breadcrumbs{min-width:0;display:flex;align-items:center;gap:2px;overflow:auto;padding:6px 14px;border-bottom:1px solid var(--border-subtle);scrollbar-width:none}.coding-workspace-breadcrumbs::-webkit-scrollbar{display:none}.coding-workspace-breadcrumbs button{min-width:0;display:inline-flex;align-items:center;gap:5px;flex:none;padding:5px 7px;border:0;border-radius:6px;color:var(--text-tertiary);background:transparent;cursor:pointer;font-size:10px}.coding-workspace-breadcrumbs button:not(:last-child)::after{content:"/";margin-left:5px;color:#4f5662}.coding-workspace-breadcrumbs button:last-child{max-width:220px;color:var(--text-primary);background:var(--surface-raised)}.coding-workspace-breadcrumbs button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-workspace-breadcrumbs button:hover{color:var(--text-primary);background:var(--surface-raised)}.coding-workspace-current{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px 12px}.coding-workspace-current>div{min-width:0}.coding-workspace-current span,.coding-workspace-picker-footer span{display:block;color:var(--text-tertiary);font-size:8px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}.coding-workspace-picker-footer span[hidden]{display:none}.coding-workspace-current strong{display:block;overflow:hidden;margin-top:4px;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.coding-workspace-current>span{flex:none;padding:5px 8px;border:1px solid var(--border-subtle);border-radius:999px;color:var(--text-tertiary);background:#111318;font-size:8px;letter-spacing:0}.coding-workspace-current>span[data-state="ready"]{border-color:#315942;color:var(--success);background:#111c16}.coding-workspace-folder-list{min-height:0;overflow:auto;overscroll-behavior:contain;margin:0 12px;padding:4px;border:1px solid var(--border-subtle);border-radius:var(--radius-md);background:#0e1014;scrollbar-width:thin}.coding-workspace-folder{width:100%;min-width:0;display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:10px;align-items:center;min-height:44px;padding:5px 9px;border:1px solid transparent;border-radius:var(--radius-sm);color:var(--text-secondary);background:transparent;cursor:pointer;text-align:left}.coding-workspace-folder:hover{border-color:var(--border-subtle);color:var(--text-primary);background:var(--surface-raised)}.coding-workspace-folder-icon{width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:#95a0b2;background:#1b1f27;font-size:13px}.coding-workspace-folder strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:620}.coding-workspace-folder em{padding:4px 7px;border:1px solid #315942;border-radius:999px;color:var(--success);background:#111c16;font-size:8px;font-style:normal}.coding-workspace-picker-empty{display:grid;place-items:center;min-height:160px;color:var(--text-tertiary);font-size:11px;text-align:center}.coding-workspace-picker-status{min-height:30px;margin:0;padding:8px 18px;color:var(--text-tertiary);font-size:9px;line-height:1.45}.coding-workspace-picker-status[data-state="error"]{color:var(--danger)}.coding-workspace-picker-footer{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:9px;align-items:center;min-height:68px;margin:0;padding:12px 16px 12px 20px;border-top:1px solid var(--border-subtle);background:#121419}.coding-workspace-picker-footer>div{min-width:0}.coding-workspace-picker-footer strong{display:block;overflow:hidden;margin-top:4px;color:var(--text-secondary);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.coding-button{min-height:36px;padding:0 13px;border-radius:var(--radius-sm);cursor:pointer;font-size:10px;font-weight:700}.coding-button-secondary{border:1px solid var(--border-strong);color:var(--text-secondary);background:var(--surface-raised)}.coding-button-secondary:hover{color:var(--text-primary);background:#222630}.coding-button-primary{border:1px solid var(--accent-strong);color:#10151e;background:var(--accent-strong)}.coding-button-primary:hover{background:#edf3ff}.coding-button:disabled{cursor:not-allowed;opacity:.42}.coding-workspace-picker[data-state="busy"] .coding-button-primary span:first-child{display:none}.coding-workspace-picker[data-state="busy"] .coding-button-primary span:last-child{display:block}.coding-workspace-picker button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
  .coding-page .agent-top-nav{height:44px;min-height:44px;padding-inline:18px;background:rgba(11,12,15,.9)}.coding-repo-mark{border-color:var(--border-strong);background:var(--surface-raised)}.coding-workbench{height:calc(100vh - 44px);grid-template-columns:264px minmax(0,1fr)}.coding-project-rail{background:#0e1014}.coding-project-identity{padding:15px 14px}.coding-project-identity strong{font-size:12px}.coding-project-identity small{font-size:9px}.coding-project-section{padding:14px 10px}.coding-project-section h2,.coding-workspace-switcher-panel>header strong{font-size:9px}.coding-project-section>header>span,.coding-workspace-switcher-panel>header span{font-size:8px}.coding-project-section>p,.coding-project-rail>footer{font-size:9px}.coding-project-technologies li{padding:4px 7px;border-color:var(--border-subtle);border-radius:6px;background:var(--surface-panel);font-size:9px}.coding-project-runs a{padding:9px 7px;border-radius:var(--radius-sm)}.coding-project-runs strong,.coding-project-team strong,.coding-workspace-switcher-panel li strong{font-size:10px}.coding-project-runs small,.coding-project-team small,.coding-workspace-switcher-panel li small{font-size:8px}.coding-project-team li{padding:7px}.coding-add-workspace-trigger{min-height:38px;display:flex;align-items:center;gap:8px;margin-top:7px;padding:0 8px;border-top-color:var(--border-subtle);border-radius:var(--radius-sm);font-size:10px;font-weight:650}.coding-add-workspace-trigger>span:first-child{font-size:14px}.coding-add-workspace-trigger:hover{background:var(--surface-raised)}
  .coding-conversation{min-width:0;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto}.coding-conversation-scroll{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-color:#333 transparent}.coding-conversation-column{width:min(1240px,100%);margin:0 auto;padding:32px 28px 26px}.coding-run-panel{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:28px;align-items:start}.coding-run-main{min-width:0;display:grid;gap:30px}.coding-inspector{position:sticky;top:0;min-width:0;display:grid;gap:12px;max-height:calc(100vh - 120px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.coding-error{margin:0;padding:10px 12px;border:1px solid #603737;border-radius:9px;color:#f0a1a1;background:#261717;font-size:10px}
  .coding-live{display:grid;gap:12px;padding:14px;border:1px solid var(--coding-line);border-radius:12px;background:#141414}.coding-live>header{display:grid;gap:7px}.coding-live-copy{min-width:0;display:flex;align-items:center;gap:9px}.coding-live-copy>i{width:7px;height:7px;flex:none;border-radius:50%;background:var(--coding-faint)}.coding-live[data-state="active"] .coding-live-copy>i{background:#b6cffb;box-shadow:0 0 0 4px rgba(182,207,251,.08);animation:coding-live-pulse 1.8s ease-in-out infinite}.coding-live[data-state="awaiting-answer"]{border-color:#554925;background:#17150f}.coding-live[data-state="awaiting-answer"] .coding-live-copy>i{background:#e2b967;box-shadow:0 0 0 4px rgba(226,185,103,.08)}.coding-live[data-state="awaiting-answer"] .coding-live-copy strong{color:#f0d79e}.coding-live[data-state="success"] .coding-live-copy>i{background:#74c991}.coding-live[data-state="failed"] .coding-live-copy>i{background:#e48383}.coding-live-copy>span{min-width:0}.coding-live-copy strong{display:block;font-size:11px}.coding-live-copy small{display:block;margin-top:3px;color:var(--coding-muted);font-size:9px;line-height:1.45}.coding-live-metrics{min-width:0;display:grid;gap:3px;justify-items:start}.coding-update-count,.coding-token-usage{color:var(--coding-faint);font:8px/1.3 ui-monospace,monospace;overflow-wrap:anywhere}.coding-token-usage strong{color:var(--coding-muted);font:inherit;font-weight:650}.coding-token-usage[data-state="complete"] strong{color:#74c991}.coding-token-usage[data-state="partial"] strong{color:#e2b967}.coding-live ul{display:grid;gap:5px;margin:0;padding:0;list-style:none}.coding-live li{min-width:0;display:grid;grid-template-columns:29px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px;border:1px solid #292929;border-radius:9px;background:#101010}.coding-live li .coding-agent-avatar{width:29px;height:29px}.coding-live li strong{display:block;overflow:hidden;text-overflow:ellipsis;font-size:9px;white-space:nowrap}.coding-live li small{display:block;overflow:hidden;text-overflow:ellipsis;margin-top:3px;color:var(--coding-muted);font:8px/1.3 ui-monospace,monospace;white-space:nowrap}.coding-live li em{color:var(--coding-faint);font-size:8px;font-style:normal}.coding-live li[data-state="working"] em{color:#b6cffb}.coding-live li[data-state="done"] em{color:#74c991}.coding-live li[data-state="needs-attention"] em,.coding-live li[data-state="stopped"] em{color:#e48383}@keyframes coding-live-pulse{0%,100%{opacity:.55}50%{opacity:1}}
  .coding-result{display:grid;grid-template-columns:30px minmax(0,1fr);gap:12px}.coding-result-mark{width:30px;height:30px;display:grid;place-items:center;border:1px solid #365b43;border-radius:8px;color:#bce5ca;background:#18261d;font-size:10px}.coding-result[data-state="failed"] .coding-result-mark{border-color:#603737;color:#f0a1a1;background:#261717}.coding-result>div{min-width:0;padding-top:3px}.coding-result header{display:flex;align-items:center;gap:8px}.coding-result header strong{font-size:10px}.coding-result header span{color:var(--coding-faint);font-size:8px}.coding-result p{margin:7px 0;color:#d2d2d2;font-size:12px;line-height:1.65}.coding-result .coding-result-warning{padding:8px 10px;border-left:2px solid #8c4a4a;color:#c8a0a0;background:#171010;font-size:9px}.coding-result .coding-result-branch{color:var(--coding-muted);font-size:9px}.coding-result code,.coding-run-branch code,.coding-run-id code,.coding-composer code,.coding-repository-panel code{font-family:ui-monospace,monospace;color:#c7d8f7}.coding-result details{margin-top:8px;color:var(--coding-muted);font-size:9px}.coding-result details summary{cursor:pointer}.coding-result ul{display:grid;gap:4px;margin:7px 0 0;padding-left:18px}.coding-result a{display:inline-block;margin-top:9px;color:#b6cffb;font-size:9px;text-decoration:none}.coding-result a:hover{text-decoration:underline}.coding-result>div>small{display:block;margin-top:6px;color:var(--coding-faint);font:8px/1.4 ui-monospace,monospace;overflow-wrap:anywhere}
  .coding-run-details{padding:14px;border:1px solid var(--coding-line);border-radius:12px;background:#121212}.coding-run-details[data-state="awaiting-answer"]{border-color:#40391f}.coding-run-details[data-state="awaiting-answer"]>header small{color:#e2b967}.coding-run-details>header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:1px solid #252525;color:var(--coding-muted)}.coding-run-details>header>span{display:flex;align-items:center;gap:8px}.coding-run-details>header strong{color:var(--coding-ink);font-size:10px}.coding-run-details>header i{width:6px;height:6px;border-radius:50%;background:var(--coding-faint)}.coding-run-details>header i[data-state="active"]{background:#b6cffb}.coding-run-details>header i[data-state="success"]{background:#74c991}.coding-run-details>header i[data-state="failed"]{background:#e48383}.coding-run-details[data-state="awaiting-answer"]>header i{background:#e2b967}.coding-run-details>header small{color:var(--coding-faint);font-size:8px}.coding-run-details-body{display:grid;gap:12px;padding-top:12px}.coding-dynamic-graph{display:grid;gap:8px;padding:10px;border:1px solid #29384e;border-radius:8px;background:#0d1219}.coding-dynamic-graph>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.coding-dynamic-graph>header strong{font-size:10px}.coding-dynamic-graph>header span,.coding-dynamic-graph>code{color:#8eadd7;font:8px/1.4 ui-monospace,monospace}.coding-dynamic-graph dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0}.coding-dynamic-graph dl>div{display:grid;gap:2px}.coding-dynamic-graph dt{color:var(--coding-faint);font-size:7px;text-transform:uppercase}.coding-dynamic-graph dd{margin:0;color:var(--coding-muted);font-size:8px;line-height:1.4}.coding-dynamic-graph>p{margin:0;color:var(--coding-muted);font-size:8px}.coding-run-id,.coding-run-branch{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;margin:0;padding:8px 9px;border:1px solid var(--coding-line);border-radius:7px;background:#0e0e0e;font-size:8px}.coding-run-id span,.coding-run-branch span{color:var(--coding-faint)}.coding-run-id code,.coding-run-branch code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-run-branch small{grid-column:2;color:var(--coding-faint);font-family:ui-monospace,monospace}.coding-progress-copy{display:flex;justify-content:space-between;color:var(--coding-faint);font-size:8px}.coding-progress{width:100%;height:3px;display:block;overflow:hidden;border:0;border-radius:999px;appearance:none;background:#292929}.coding-progress::-webkit-progress-bar{background:#292929}.coding-progress::-webkit-progress-value{border-radius:inherit;background:#b6cffb;transition:width .25s ease}.coding-progress::-moz-progress-bar{border-radius:inherit;background:#b6cffb;transition:width .25s ease}.coding-task-list{display:grid;gap:0;margin:0;padding:0;list-style:none}.coding-task-list>li{display:grid;grid-template-columns:7px minmax(0,1fr);gap:9px;align-items:center;padding:8px 0;border-bottom:1px solid #232323}.coding-task-list>li>span{width:6px;height:6px;border-radius:50%;background:var(--coding-faint)}.coding-task-list>li>span[data-state="running"]{background:#b6cffb}.coding-task-list>li>span[data-state="completed"]{background:#74c991}.coding-task-list>li>span[data-state="failed"]{background:#e48383}.coding-task-list strong{font-size:9px}.coding-task-list small{grid-column:2;color:var(--coding-faint);font-size:8px}.coding-details-empty{display:block!important;color:var(--coding-faint);font-size:9px}.coding-receipts>summary{padding:7px 0;color:var(--coding-muted);cursor:pointer;font-size:9px}.coding-receipts>div{display:grid;gap:10px}.coding-receipts pre{max-height:260px;overflow:auto;margin:0;padding:10px;border:1px solid var(--coding-line);border-radius:8px;color:#cfcfcf;background:#090909;font:8px/1.55 ui-monospace,monospace;white-space:pre-wrap}.coding-receipts ol{max-height:220px;overflow:auto;margin:0;padding:0;list-style:none}.coding-receipts li{display:grid;gap:3px;padding:7px 0;border-bottom:1px solid #232323}.coding-receipts li strong{font-size:8px}.coding-receipts li span{color:var(--coding-muted);font-size:8px;line-height:1.4}
  .coding-composer-wrap{position:relative;padding:14px 24px 18px;background:linear-gradient(180deg,transparent,var(--coding-bg) 22%)}.coding-composer-grid{width:100%;margin:0;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px}.coding-composer{grid-column:1;width:100%;padding:10px 11px 8px;border:1px solid #3b3b3b;border-radius:14px;background:#1d1d1d;box-shadow:0 12px 40px rgba(0,0,0,.35)}.coding-composer:focus-within{border-color:#555}.coding-composer textarea{width:100%;min-height:48px;max-height:180px;field-sizing:content;resize:none;overflow:auto;border:0;padding:5px 4px;color:var(--coding-ink);background:transparent;font-size:12px;line-height:1.55;outline:0}.coding-composer textarea::placeholder{color:#777}.coding-composer-footer{display:flex;align-items:flex-end;justify-content:space-between;gap:10px}.coding-composer-options{display:flex;align-items:center;gap:3px}.coding-composer-options label{display:flex;align-items:center;gap:5px;padding:0 4px}.coding-composer-options label>span{color:var(--coding-faint);font-size:8px}.coding-composer select{height:28px;border:0;color:var(--coding-muted);background:transparent;font-size:9px;cursor:pointer}.coding-composer-context{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 8px;border:1px solid #363636;border-radius:999px;color:var(--coding-muted);font-size:8px}.coding-composer-context:before{content:"";width:6px;height:6px;border-radius:50%;background:#b6cffb}.coding-composer-context[data-state="answer"]{color:#e7ca8b;border-color:#554925}.coding-composer-context[data-state="answer"]:before{background:#e2b967}.coding-composer button[type="submit"]{min-width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:9px;padding:0 9px;color:#161616;background:#ececec;cursor:pointer;font-size:17px;font-weight:700}.coding-composer button[type="submit"]:hover{background:#fff}.coding-composer button[type="submit"][aria-label="Reply"]{font-size:9px}.coding-composer>p{margin:7px 4px 0;color:var(--coding-faint);font-size:8px}.coding-submit-busy{display:none}.coding-composer[data-state="busy"] .coding-submit-idle{display:none}.coding-composer[data-state="busy"] .coding-submit-busy{display:inline}.coding-composer[data-state="busy"] button[type="submit"]{opacity:.55;cursor:wait}
  .coding-page button:focus-visible,.coding-page a:focus-visible,.coding-page summary:focus-visible,.coding-page select:focus-visible{outline:2px solid #b6cffb;outline-offset:2px}.coding-composer:focus-within{box-shadow:0 0 0 2px rgba(182,207,251,.15),0 12px 40px rgba(0,0,0,.35)}
  .coding-page button:focus-visible,.coding-page a:focus-visible,.coding-page summary:focus-visible,.coding-page select:focus-visible{outline-color:var(--focus-ring)}.coding-composer-grid{width:min(1240px,100%);margin:0 auto;grid-template-columns:minmax(0,1fr) 320px;gap:28px}.coding-composer{border-color:var(--border-strong);background:var(--surface-raised);box-shadow:0 16px 50px rgba(0,0,0,.32)}.coding-composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px rgba(182,207,251,.12),0 16px 50px rgba(0,0,0,.36)}.coding-composer textarea{font-size:13px}.coding-composer textarea::placeholder{color:var(--text-tertiary)}.coding-composer select{color:var(--text-secondary);background-color:transparent}.coding-composer button[type="submit"]{color:var(--action-primary-foreground);background:var(--action-primary)}
  .coding-page .agent-top-nav{border-color:var(--border-subtle);background:var(--surface-panel)}.coding-project-rail{border-color:var(--border-subtle);background:var(--surface-sidebar)}.coding-workspace-switcher,.coding-project-section,.coding-project-rail>footer{border-color:var(--border-subtle)}.coding-workspace-switcher-panel,.coding-project-rail>footer{background:var(--surface-panel)}.coding-workspace-switcher[open]>summary{background:var(--surface-hover)}
  .coding-menu>summary,.coding-project-runs a,.coding-workspace-switcher-panel li a,.coding-agent-link,.coding-add-workspace-trigger{border-radius:var(--radius-control)}.coding-menu>summary:hover,.coding-menu[open]>summary,.coding-project-runs a:hover,.coding-project-runs a[aria-current="page"],.coding-workspace-switcher-panel li a:hover,.coding-workspace-switcher-panel li a[aria-current="page"],.coding-agent-link:hover,.coding-add-workspace-trigger:hover{color:var(--text-primary);background:var(--surface-hover)}.coding-menu-panel,.coding-repository-panel{border-color:var(--border-strong);border-radius:var(--radius-overlay);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.coding-menu-panel>header{border-color:var(--border-subtle)}
  .coding-repo-mark,.coding-onboarding-mark,.coding-project-identity>span,.coding-workspace-mark,.coding-project-agent-mark,.coding-agent-avatar,.coding-message-avatar,.coding-result-mark,.coding-coordinator-avatar{border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--text-primary);background:var(--surface-raised)}.coding-project-technologies li{border-color:var(--border-subtle);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-inset)}
  .coding-live,.coding-run-details,.coding-git-handoff{border:1px solid var(--border-subtle);border-radius:var(--radius-card);background:var(--surface-panel)}.coding-live li{border-color:var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-live li.coding-agent-row{background:var(--surface-inset)}.coding-agent-detail,.coding-live li,.coding-task-list>li,.coding-receipts li{border-color:var(--border-subtle)}.coding-agent-terminal ol,.coding-receipts pre{border-color:var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-live .coding-agent-terminal li{border-color:var(--border-subtle);background:transparent}
  .coding-git-handoff>header{height:36px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 11px;border-bottom:1px solid var(--border-subtle)}.coding-git-handoff>header>span{display:flex;align-items:center;gap:7px}.coding-git-handoff>header i{width:6px;height:6px;border-radius:50%;background:var(--text-tertiary)}.coding-git-handoff>header strong{font-size:9px}.coding-git-handoff>header small{color:var(--text-tertiary);font-size:8px}.coding-git-handoff[data-state="working"]>header i{background:var(--accent)}.coding-git-handoff[data-state="ready"]>header i,.coding-git-handoff[data-state="integrated"]>header i{background:var(--success)}.coding-git-handoff[data-state="blocked"]>header i{background:var(--warning)}.coding-git-handoff-body{padding:7px 11px 10px}.coding-git-handoff dl{display:grid;margin:0}.coding-git-handoff dl>div{min-width:0;display:grid;grid-template-columns:70px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid var(--border-subtle)}.coding-git-handoff dt{color:var(--text-tertiary);font-size:7px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.coding-git-handoff dd{min-width:0;margin:0;color:var(--text-secondary);font-size:8px;overflow:hidden}.coding-git-handoff dd strong,.coding-git-handoff dd span,.coding-git-handoff dd code,.coding-git-handoff dd small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-git-handoff dd strong{color:var(--text-primary);font-size:8px}.coding-git-handoff dd code{color:var(--accent-strong);font:8px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}.coding-git-handoff dd small{margin-top:2px;color:var(--text-tertiary);font:7px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}.coding-git-handoff-note{margin:8px 0 0;padding:8px;border:1px solid var(--warning-border);border-radius:var(--radius-control);color:var(--warning);background:var(--warning-surface);font-size:8px;line-height:1.45}.coding-git-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:9px}.coding-git-actions form{margin:0}.coding-git-actions a,.coding-git-actions button{min-height:28px;display:inline-flex;align-items:center;padding:0 9px;border:1px solid var(--border-strong);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-raised);font-size:8px;font-weight:700;text-decoration:none;cursor:pointer}.coding-git-actions a:hover{color:var(--text-primary);background:var(--surface-hover)}.coding-git-actions .coding-review-action{min-height:34px;flex:1 0 100%;justify-content:center;gap:8px;padding:0 12px;border-color:var(--action-primary);color:var(--action-primary-foreground);background:var(--action-primary);box-shadow:0 5px 16px rgba(0,0,0,.24);font-size:9px;letter-spacing:.005em}.coding-git-actions .coding-review-action:hover{border-color:var(--action-primary-hover);color:var(--action-primary-foreground);background:var(--action-primary-hover);transform:translateY(-1px)}.coding-git-actions .coding-review-action>span:last-child{font-size:11px;font-weight:500}.coding-git-actions button{border-color:var(--action-primary);color:var(--action-primary-foreground);background:var(--action-primary)}.coding-git-actions button:hover{background:var(--action-primary-hover)}.coding-git-actions>span{color:var(--success);font-size:8px;font-weight:700}.coding-git-policy{margin-top:8px}.coding-git-policy>summary{color:var(--text-tertiary);cursor:pointer;font-size:8px;list-style-position:inside}.coding-git-policy>div{display:grid;gap:7px;margin-top:8px;padding:8px;border-radius:var(--radius-control);background:var(--surface-inset)}.coding-git-policy p{margin:0;color:var(--text-tertiary);font-size:8px;line-height:1.5}.coding-git-policy strong{color:var(--text-secondary)}.coding-git-policy code{color:var(--accent-strong)}
  .coding-live[data-state="awaiting-answer"],.coding-run-details[data-state="awaiting-answer"]{border-color:var(--warning-border);background:var(--warning-surface)}.coding-live[data-state="awaiting-answer"] .coding-live-copy>i,.coding-run-details[data-state="awaiting-answer"]>header i{background:var(--warning)}.coding-live[data-state="success"] .coding-live-copy>i,.coding-run-details>header i[data-state="success"]{background:var(--success)}.coding-live[data-state="failed"] .coding-live-copy>i,.coding-run-details>header i[data-state="failed"]{background:var(--danger)}.coding-error{border-color:var(--danger-border);border-radius:var(--radius-control);color:var(--danger);background:var(--danger-surface)}
  .coding-message.user article{border-radius:var(--radius-card);background:var(--surface-raised)}.coding-message article p,.coding-result p{color:var(--text-primary)}.coding-message article header span,.coding-result header span,.coding-result .coding-result-branch{color:var(--text-tertiary)}.coding-message article header .coding-runtime,.coding-composer-context{border-color:var(--border-strong);border-radius:var(--radius-pill);color:var(--text-secondary);background:var(--surface-inset)}.coding-result-warning{border:1px solid var(--danger-border)!important;border-radius:var(--radius-control);color:var(--danger)!important;background:var(--danger-surface)!important}.coding-result code,.coding-run-branch code,.coding-run-id code,.coding-composer code,.coding-repository-panel code{color:var(--accent-strong)}
  .coding-run-details>header{border-color:var(--border-subtle)}.coding-run-id,.coding-run-branch{border-color:var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-progress,.coding-progress::-webkit-progress-bar{background:var(--surface-hover)}.coding-progress::-webkit-progress-value,.coding-progress::-moz-progress-bar{background:var(--accent)}.coding-task-list>li>span[data-state="running"]{background:var(--accent)}.coding-task-list>li>span[data-state="completed"]{background:var(--success)}.coding-task-list>li>span[data-state="failed"]{background:var(--danger)}
  .coding-composer{border-color:var(--border-strong);border-radius:var(--radius-card);background:var(--surface-raised);box-shadow:var(--shadow-card)}.coding-composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px rgba(182,207,251,.14),var(--shadow-card)}.coding-composer button[type="submit"]{border-radius:var(--radius-control);color:var(--action-primary-foreground);background:var(--action-primary)}.coding-composer button[type="submit"]:hover{background:var(--action-primary-hover)}.coding-composer select{color:var(--text-secondary);background-color:var(--surface-raised)}
  .coding-workspace-picker{border-color:var(--border-strong);border-radius:var(--radius-overlay)}.coding-workspace-picker-header{border-color:var(--border-subtle);background:var(--surface-overlay)}.coding-workspace-picker-mark{border-color:var(--border-strong);border-radius:var(--radius-card);color:var(--accent-strong);background:var(--surface-raised)}.coding-workspace-picker-body>aside{border-color:var(--border-subtle);background:var(--surface-sidebar)}.coding-workspace-location,.coding-workspace-breadcrumbs button,.coding-workspace-folder,.coding-icon-button,.coding-button{border-radius:var(--radius-control)}.coding-workspace-location:hover,.coding-workspace-location[aria-current="true"],.coding-workspace-breadcrumbs button:hover,.coding-workspace-breadcrumbs button:last-child,.coding-workspace-folder:hover,.coding-icon-button:hover{border-color:var(--border-subtle);color:var(--text-primary);background:var(--surface-hover)}.coding-workspace-folder-list{border-color:var(--border-subtle);border-radius:var(--radius-card);background:var(--surface-inset)}.coding-workspace-folder-icon{border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-raised)}.coding-workspace-current>span{border-color:var(--border-subtle);border-radius:var(--radius-pill);background:var(--surface-inset)}.coding-workspace-current>span[data-state="ready"],.coding-workspace-folder em{border-color:var(--success-border);border-radius:var(--radius-pill);color:var(--success);background:var(--success-surface)}.coding-workspace-picker-footer{border-color:var(--border-subtle);background:var(--surface-panel)}.coding-button-secondary{border-color:var(--border-strong);color:var(--text-secondary);background:var(--surface-raised)}.coding-button-secondary:hover{color:var(--text-primary);background:var(--surface-hover)}.coding-button-primary{border-color:var(--action-primary);color:var(--action-primary-foreground);background:var(--action-primary)}.coding-button-primary:hover{background:var(--action-primary-hover)}
  .coding-live li.coding-agent-row{display:block;padding:0}.coding-agent-link{min-width:0;display:grid;grid-template-columns:29px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px;border-radius:8px;color:inherit;text-decoration:none}.coding-agent-link:hover{background:#181818}.coding-agent-link:focus-visible{outline:2px solid #b6cffb;outline-offset:-2px}.coding-agent-link>span:nth-child(2){min-width:0}.coding-agent-detail{display:none;gap:12px;margin-top:4px;padding:12px 0 0;border-top:1px solid var(--coding-line);scroll-margin-top:8px}.coding-agent-detail:target{display:grid}.coding-agent-detail>header{display:flex;align-items:start;justify-content:space-between;gap:10px}.coding-agent-detail>header>span{min-width:0}.coding-agent-detail>header strong,.coding-agent-detail>header small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.coding-agent-detail>header strong{font-size:10px}.coding-agent-detail>header small{margin-top:3px;color:var(--coding-muted);font:8px/1.3 ui-monospace,monospace}.coding-agent-detail dl{display:grid;gap:0;margin:0}.coding-agent-detail dl>div{min-width:0;display:grid;grid-template-columns:86px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid #232323}.coding-agent-detail dt,.coding-agent-detail h3{color:var(--coding-faint);font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.coding-agent-detail dd{min-width:0;margin:0;color:var(--coding-muted);font-size:8px;line-height:1.4;overflow-wrap:anywhere}.coding-agent-detail code{color:#c7d8f7;font-family:ui-monospace,monospace}.coding-agent-detail h3{margin:0 0 6px}.coding-agent-detail ul,.coding-agent-detail ol{margin:0;padding:0;list-style:none}.coding-live .coding-agent-detail li{min-width:0;border:0;border-bottom:1px solid #232323;border-radius:0;background:transparent}.coding-agent-tasks li{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;gap:8px!important;padding:6px 0!important}.coding-agent-tasks li span{font-size:8px}.coding-agent-tasks li small{color:var(--coding-faint);font:7px/1.3 ui-monospace,monospace}.coding-agent-log>header{display:flex;align-items:center;justify-content:space-between;gap:8px}.coding-agent-log>header span{color:var(--coding-faint);font:7px/1.2 ui-monospace,monospace}.coding-agent-log ol{max-height:240px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.coding-agent-log li{display:grid!important;grid-template-columns:30px minmax(0,1fr)!important;gap:8px!important;align-items:start!important;padding:6px 0!important}.coding-agent-log li>code{color:var(--coding-faint);font-size:7px}.coding-agent-log li>span{min-width:0}.coding-agent-log li strong,.coding-agent-log li small{display:block;overflow-wrap:anywhere}.coding-agent-log li strong{font-size:8px}.coding-agent-log li small{margin-top:2px;color:var(--coding-muted);font-size:8px;line-height:1.35}.coding-live .coding-agent-log li.coding-agent-log-empty{display:block!important;color:var(--coding-faint);font-size:8px}.coding-agent-detail>footer{color:var(--coding-faint);font-size:7px;line-height:1.45}.coding-agent-detail:target~.coding-agent-detail{display:none}
  .coding-agent-terminal>header{display:flex;align-items:center;justify-content:space-between;gap:8px}.coding-agent-terminal>header span{color:#8aa5d2;font:7px/1.2 ui-monospace,monospace}.coding-agent-terminal ol{max-height:280px;overflow:auto;overscroll-behavior:contain;margin:0;border:1px solid #292929;border-radius:7px;background:#090909;scrollbar-width:thin}.coding-live .coding-agent-terminal li{display:grid;grid-template-columns:66px minmax(0,1fr);gap:8px;align-items:start;padding:6px 8px;border:0;border-bottom:1px solid #1f1f1f;border-radius:0;background:transparent}.coding-agent-terminal li>span{display:grid;gap:2px}.coding-agent-terminal time,.coding-agent-terminal li>span code{color:#666;font:7px/1.3 ui-monospace,monospace}.coding-agent-terminal pre{min-width:0;overflow-wrap:anywhere;margin:0;color:#c9d5e8;font:8px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.coding-agent-terminal li[data-stream="stderr"] pre{color:#e7a1a1}.coding-live .coding-agent-terminal li.coding-agent-terminal-empty{display:block;color:var(--coding-faint);font-size:8px;line-height:1.5}
  .coding-agent-detail>header h2{display:block;overflow:hidden;margin:0;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:1.3}
  .coding-agent-link{width:100%;border:0;background:transparent;cursor:pointer;text-align:left;font:inherit}.coding-agent-detail:not([hidden]){display:grid}.coding-agent-detail>header>button{width:24px;height:24px;display:grid;place-items:center;flex:none;border:1px solid var(--border-strong);border-radius:var(--radius-control);padding:0;color:var(--text-secondary);background:transparent;cursor:pointer}.coding-agent-detail>header>button:hover{color:var(--text-primary);background:var(--surface-hover)}.coding-agent-detail>header>button:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}.coding-live[data-agent-detail-open="true"]>.coding-run-team-label,.coding-live[data-agent-detail-open="true"]>.coding-run-team-help,.coding-live[data-agent-detail-open="true"]>ul{display:none}
  .coding-agent-link:hover{background:var(--surface-hover)}.coding-agent-link:focus-visible{outline-color:var(--focus-ring)}.coding-agent-detail dl>div,.coding-live .coding-agent-detail li,.coding-live .coding-agent-terminal li{border-color:var(--border-subtle)}.coding-agent-detail code,.coding-agent-terminal pre{color:var(--accent-strong)}.coding-agent-terminal ol{border-color:var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-inset)}.coding-workspace-picker-header h2{width:max-content;max-width:100%}.coding-workspace-picker-header h2:focus-visible{outline:none;box-shadow:inset 0 -2px var(--focus-ring)}.coding-workspace-switcher>summary:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--focus-ring)}.coding-button[aria-disabled="true"]{cursor:not-allowed;opacity:.42}.coding-button-primary[aria-disabled="true"]:hover{background:var(--action-primary)}.coding-workspace-folder{content-visibility:auto;contain-intrinsic-size:44px}
  ${codingAgentIdentityCss}
  ${codingTeamBriefCss}
  ${codingDailyDriverCss}
  ${generativeUiCss()}
  ${roomRosterCss()}
  ${participantProfileCss()}
  ${codingComposerCss}
  ${codingAgentDetailsCss}
  .coding-task-list>li{row-gap:5px;padding-block:9px}.coding-task-list [data-coding-task-outcome]{grid-column:2;display:grid;gap:3px;margin:0;color:var(--text-secondary);font:9px/1.45 var(--font-ui)}.coding-task-list [data-coding-task-outcome] b{color:var(--text-tertiary);font:700 7px/1.2 var(--font-mono);letter-spacing:.06em;text-transform:uppercase}
  ${codingWorkspaceCss}
  ${codingSlackWorkspaceCss}
  ${codingBrandThemeCss}
  .coding-project-identity{grid-template-columns:minmax(0,1fr)}
  .coding-workspace-switcher>summary{grid-template-columns:minmax(0,1fr) 12px}
  @media(prefers-reduced-motion:reduce){.coding-live[data-state="active"] .coding-live-copy>i{animation:none}.coding-progress::-webkit-progress-value,.coding-progress::-moz-progress-bar{transition:none}.coding-conversation-scroll{scroll-behavior:auto}}
${themeCss()}</style></head><body data-roster-build="${codingBuildFingerprint}">${agentShellFrameHtml({
    skipHref: "#main",
    skipLabel: "Skip to workspace",
    chromeHtml: "",
    mainHtml: content,
    mainId: "main",
    appClass: "coding-page",
  })}${codingCommandPaletteHtml({ ...options, buildFingerprint: codingBuild.fingerprint })}${participantProfileDialogHtml({ runtimeEditorHtml: codingParticipantRuntimeEditorHtml({
    runtimeOptions: options.runtimeOptions ?? DEFAULT_CODING_WORKER_RUNTIME_OPTIONS,
    workspaceSettings: options.workspaceSettings,
  }) })}<aside class="coding-build-notice" data-coding-build-mismatch hidden role="status"><span>New Roster build available.</span><button type="button" data-coding-build-reload>Reload</button></aside>${roomUpdatesModel}${shellScripts}<script type="module" src="/assets/roster-shell.js" nonce="${esc(options.nonce)}"></script><script type="module" src="/assets/coding-enhancements.js?v=${codingBuildFingerprint}" data-coding-enhancements nonce="${esc(options.nonce)}"></script>${realtimeBoot}${codingWorkspaceInteractionScript(options.nonce)}</body></html>`;
};
