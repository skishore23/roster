import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import chalk from "chalk";

import {
  CodingCliClient,
  codingCliPhase,
  type CodingCliDiff,
  type CodingCliRoom,
  type CodingCliRunSnapshot,
} from "./coding-client.js";
import {
  subscribeCodingRealtime,
  type CodingRealtimeSubscription,
} from "./coding-realtime.js";

export type CodingTuiIdentity = {
  readonly conversationId?: string;
  readonly executionId?: string;
  readonly jobId?: string;
};

export type CodingTuiConfirmation = {
  readonly action: "integrate" | "abort" | "retry" | "close";
  readonly phrase: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly jobId: string;
};

export type CodingTuiNotice = {
  readonly tone: "info" | "success" | "warning" | "error";
  readonly text: string;
};

export type CodingTuiView = {
  readonly identity: CodingTuiIdentity;
  readonly rooms?: ReadonlyArray<CodingCliRoom>;
  readonly selectedRoomIndex?: number;
  readonly snapshot?: CodingCliRunSnapshot;
  readonly diff?: CodingCliDiff;
  readonly showDiff: boolean;
  readonly connected: boolean;
  readonly busy?: "message" | "diff" | "integrate" | "abort" | "retry" | "close";
  readonly confirmation?: CodingTuiConfirmation;
  readonly notice?: CodingTuiNotice;
  readonly viewportRows?: number;
};

export type CodingTuiOptions = {
  readonly client: CodingCliClient;
  /** Stable conversation selector; `runId` is the command-facing alias. */
  readonly conversationId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly workspaceId?: string;
  readonly reviewPolicy?: "auto" | "fast" | "reviewed";
  readonly workerRuntime?: "claude-code" | "codex-cli" | "pi-agent" | "hermes-agent";
  readonly intervalMs?: number;
  /** Injectable for PTY and recording-terminal tests. */
  readonly terminal?: Terminal;
};

export type CodingTuiExit = {
  readonly reason: "detached";
  readonly identity: CodingTuiIdentity;
};

type MutableCodingTuiState = {
  identity: CodingTuiIdentity;
  rooms?: ReadonlyArray<CodingCliRoom>;
  selectedRoomIndex: number;
  snapshot?: CodingCliRunSnapshot;
  diff?: CodingCliDiff;
  showDiff: boolean;
  connected: boolean;
  busy?: "message" | "diff" | "integrate" | "abort" | "retry" | "close";
  confirmation?: CodingTuiConfirmation;
  notice?: CodingTuiNotice;
};

const MAX_RENDERED_MESSAGES = 8;
const MAX_RENDERED_TASKS = 12;
const MAX_RENDERED_NODES = 10;
const MAX_RENDERED_FILES = 24;
const MAX_MESSAGE_PREVIEW = 2_400;

export type CodingTuiLayout = "wide" | "medium" | "narrow" | "compact";

export const codingTuiLayout = (columns: number): CodingTuiLayout => {
  if (columns >= 120) return "wide";
  if (columns >= 88) return "medium";
  if (columns >= 56) return "narrow";
  return "compact";
};

const boundedIdentity = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized)) {
    throw new Error(`Coding TUI ${label} is invalid`);
  }
  return normalized;
};

const tone = (notice: CodingTuiNotice): string => {
  switch (notice.tone) {
    case "success": return chalk.green(notice.text);
    case "warning": return chalk.yellow(notice.text);
    case "error": return chalk.red(notice.text);
    default: return chalk.cyan(notice.text);
  }
};

const phaseLabel = (snapshot: CodingCliRunSnapshot | undefined): string => {
  const phase = codingCliPhase(snapshot);
  switch (phase) {
    case "working": return chalk.cyan("WORKING");
    case "attention": return chalk.yellow("NEEDS ATTENTION");
    case "review": return chalk.magenta("READY FOR REVIEW");
    case "done": return chalk.green("DONE");
    case "failed": return chalk.red("FAILED");
    default: return chalk.dim("IDLE");
  }
};

const statusColor = (status: string): string => {
  switch (status) {
    case "accepted":
    case "completed": return chalk.green(status);
    case "failed":
    case "canceled": return chalk.red(status);
    case "leased":
    case "running":
    case "working": return chalk.cyan(status);
    case "blocked": return chalk.yellow(status);
    default: return chalk.dim(status);
  }
};

const pushWrapped = (lines: string[], value: string, width: number): void => {
  const columns = Math.max(1, Math.floor(width));
  const logicalLines = value.replace(/\r\n?/gu, "\n").split("\n");
  for (const line of logicalLines) {
    if (!line) {
      lines.push("");
      continue;
    }
    lines.push(...wrapTextWithAnsi(line, columns));
  }
};

const pushIdentity = (lines: string[], label: string, value: string | undefined, width: number): void => {
  pushWrapped(lines, `${chalk.dim(`${label}:`)} ${value ?? chalk.dim("not selected")}`, width);
};

const section = (lines: string[], title: string, width: number): void => {
  if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  pushWrapped(lines, chalk.bold(title), width);
};

const renderConversation = (
  lines: string[],
  snapshot: CodingCliRunSnapshot,
  width: number,
  compact: boolean,
): void => {
  section(lines, "Conversation", width);
  const messages = snapshot.conversation.messages;
  const selected = messages.slice(-MAX_RENDERED_MESSAGES);
  if (messages.length > selected.length) {
    pushWrapped(lines, chalk.dim(`… ${messages.length - selected.length} earlier messages`), width);
  }
  if (selected.length === 0) pushWrapped(lines, chalk.dim("No messages yet."), width);
  for (const message of selected) {
    const delivery = message.deliveryState ? ` · ${message.deliveryState}` : "";
    pushWrapped(
      lines,
      `${chalk.bold(message.author.name)} ${chalk.dim(`[${message.author.kind}${delivery}]`)}`,
      width,
    );
    const preview = message.text.length > MAX_MESSAGE_PREVIEW
      ? `${message.text.slice(0, MAX_MESSAGE_PREVIEW)}…`
      : message.text;
    pushWrapped(lines, preview, Math.max(1, width - (compact ? 0 : 2)));
  }
  for (const question of snapshot.conversation.pendingQuestions) {
    pushWrapped(lines, chalk.yellow(`? ${question}`), width);
  }
};

const renderTasks = (lines: string[], snapshot: CodingCliRunSnapshot, width: number, detailed: boolean): void => {
  section(lines, "Execution", width);
  if (snapshot.tasks.length === 0) {
    pushWrapped(lines, chalk.dim("No task graph has been admitted."), width);
    return;
  }
  const counts = new Map<string, number>();
  for (const task of snapshot.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  pushWrapped(
    lines,
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${statusColor(status)} ${count}`)
      .join(chalk.dim(" · ")),
    width,
  );
  for (const task of snapshot.tasks.slice(0, MAX_RENDERED_TASKS)) {
    const node = snapshot.nodes.find((candidate) => candidate.id === task.nodeId);
    const owner = node?.name ?? task.nodeId;
    pushWrapped(lines, `${statusColor(task.status)}  ${task.taskId}  ${chalk.dim(owner)}`, width);
    if (detailed && task.objective) pushWrapped(lines, chalk.dim(`  ${task.objective}`), width);
    if (task.error) pushWrapped(lines, chalk.red(`  ${task.error}`), width);
  }
  if (snapshot.tasks.length > MAX_RENDERED_TASKS) {
    pushWrapped(lines, chalk.dim(`… ${snapshot.tasks.length - MAX_RENDERED_TASKS} more tasks`), width);
  }
};

const renderNodes = (lines: string[], snapshot: CodingCliRunSnapshot, width: number): void => {
  section(lines, "Roster", width);
  if (snapshot.nodes.length === 0) {
    pushWrapped(lines, chalk.dim("No execution nodes projected."), width);
    return;
  }
  for (const node of snapshot.nodes.slice(0, MAX_RENDERED_NODES)) {
    const placement = [node.runtime, node.model].filter(Boolean).join(" / ");
    pushWrapped(
      lines,
      `${statusColor(node.status)}  ${node.name} ${chalk.dim(`(${node.id})${placement ? ` · ${placement}` : ""}`)}`,
      width,
    );
  }
  if (snapshot.nodes.length > MAX_RENDERED_NODES) {
    pushWrapped(lines, chalk.dim(`… ${snapshot.nodes.length - MAX_RENDERED_NODES} more nodes`), width);
  }
};

const diffLine = (line: string): string => {
  if (line.startsWith("+++") || line.startsWith("---")) return chalk.bold(line);
  if (line.startsWith("+")) return chalk.green(line);
  if (line.startsWith("-")) return chalk.red(line);
  if (line.startsWith("@@")) return chalk.cyan(line);
  return line;
};

const renderDiff = (
  lines: string[],
  diff: CodingCliDiff,
  width: number,
  expanded: boolean,
  viewportRows: number,
): void => {
  section(lines, "Review / diff", width);
  const delta = [
    diff.additions === undefined ? undefined : chalk.green(`+${diff.additions}`),
    diff.deletions === undefined ? undefined : chalk.red(`-${diff.deletions}`),
  ].filter(Boolean).join(" ");
  pushWrapped(lines, `${diff.summary}${delta ? ` ${delta}` : ""}`, width);
  for (const file of diff.files.slice(0, MAX_RENDERED_FILES)) {
    pushWrapped(lines, `${chalk.dim(file.status.padEnd(2))} ${file.path}`, width);
  }
  if (diff.files.length > MAX_RENDERED_FILES) {
    pushWrapped(lines, chalk.dim(`… ${diff.files.length - MAX_RENDERED_FILES} more files`), width);
  }
  if (!expanded) {
    pushWrapped(lines, chalk.dim("Alt-D loads or expands the exact selected job diff."), width);
    return;
  }
  if (!diff.patch?.text) {
    pushWrapped(lines, chalk.dim("No patch text returned for this execution."), width);
    return;
  }
  const patchLines = diff.patch.text.replace(/\r\n?/gu, "\n").split("\n");
  const limit = Math.max(8, Math.min(36, Math.floor(viewportRows * 0.45)));
  for (const line of patchLines.slice(0, limit)) pushWrapped(lines, diffLine(line), width);
  if (patchLines.length > limit || diff.patch.truncated) {
    pushWrapped(
      lines,
      chalk.yellow(`… patch ${diff.patch.truncated ? "was truncated by the API" : `continues for ${patchLines.length - limit} lines`}`),
      width,
    );
  }
};

/**
 * Pure adaptive projection used by the interactive host and by snapshot tests.
 * It never sends a command or decides which durable execution is current.
 */
const renderCodingTuiLines = (view: CodingTuiView, requestedWidth: number): string[] => {
  const width = Math.max(1, Math.floor(requestedWidth));
  const layout = codingTuiLayout(width);
  const compact = layout === "compact" || layout === "narrow";
  const detailed = layout === "wide" || layout === "medium";
  const lines: string[] = [];
  pushWrapped(
    lines,
    `${chalk.bold("Roster Coding")} ${phaseLabel(view.snapshot)} ${view.connected ? chalk.green("●") : chalk.red("○")}`,
    width,
  );
  pushIdentity(lines, "conversation", view.identity.conversationId, width);
  pushIdentity(lines, "execution", view.identity.executionId, width);
  pushIdentity(lines, "job", view.identity.jobId, width);

  if (view.snapshot) {
    const snapshot = view.snapshot;
    if (snapshot.run.repositoryRoot) pushIdentity(lines, "repository", snapshot.run.repositoryRoot, width);
    if (snapshot.run.branch) pushIdentity(lines, "branch", snapshot.run.branch, width);
    if (snapshot.run.commit) pushIdentity(lines, "commit", snapshot.run.commit, width);
    if (snapshot.job) {
      pushWrapped(
        lines,
        `${chalk.dim("job state:")} ${statusColor(snapshot.job.status)}`
          + `${snapshot.job.workerRuntime ? ` · ${snapshot.job.workerRuntime}` : ""}`
          + `${snapshot.job.workerModel ? ` · ${snapshot.job.workerModel}` : ""}`,
        width,
      );
    }
    renderConversation(lines, snapshot, width, compact);
    renderTasks(lines, snapshot, width, detailed);
    renderNodes(lines, snapshot, width);
    const diff = view.diff ?? snapshot.frontier;
    if (diff) renderDiff(lines, diff, width, view.showDiff, view.viewportRows ?? 30);
    if (snapshot.resultSummary) {
      section(lines, "Result", width);
      pushWrapped(lines, snapshot.resultSummary, width);
    }
  } else if (!view.identity.conversationId) {
    lines.push("");
    pushWrapped(lines, chalk.bold("Recent rooms"), width);
    const rooms = view.rooms ?? [];
    if (rooms.length === 0) {
      pushWrapped(lines, chalk.dim("No Coding rooms yet. Type an objective below to create one."), width);
    } else {
      const selectedIndex = Math.max(0, Math.min(view.selectedRoomIndex ?? 0, rooms.length - 1));
      for (const [index, room] of rooms.slice(0, 12).entries()) {
        const marker = index === selectedIndex ? chalk.cyan(">") : " ";
        pushWrapped(
          lines,
          `${marker} ${room.title} ${chalk.dim(`(${room.conversationId}) · ${room.state} · ${room.messageCount} messages`)}`,
          width,
        );
      }
      pushWrapped(lines, chalk.dim("Alt-J / Alt-K selects · Alt-O opens · typing creates a new room"), width);
    }
  } else {
    lines.push("");
    pushWrapped(lines, chalk.dim("Loading the exact Coding conversation projection…"), width);
  }

  if (view.notice) {
    section(lines, "Status", width);
    pushWrapped(lines, tone(view.notice), width);
  }
  if (view.confirmation) {
    const label = view.confirmation.action === "integrate"
      ? "Integrate"
      : view.confirmation.action === "abort"
        ? "Abort"
        : view.confirmation.action === "retry" ? "Retry" : "Close and keep branch";
    section(lines, `${label} confirmation`, width);
    pushWrapped(
      lines,
      chalk.yellow("This command targets the identities shown below and cannot be inferred from the newest room activity."),
      width,
    );
    pushIdentity(lines, "execution", view.confirmation.executionId, width);
    pushIdentity(lines, "job", view.confirmation.jobId, width);
    pushWrapped(lines, `Type exactly: ${chalk.bold(view.confirmation.phrase)}`, width);
    pushWrapped(lines, chalk.dim("Escape cancels confirmation."), width);
  }

  section(lines, "Controls", width);
  const controls = [
    "Enter send message via API",
    "Alt-D review diff",
    "Alt-I integrate",
    "Alt-A abort",
    "Alt-T retry failed job",
    "Alt-C close / keep branch",
    "Alt-R rooms · Alt-N new room",
    "Ctrl-C detach (does not abort)",
  ];
  pushWrapped(lines, controls.join(compact ? "\n" : chalk.dim("  ·  ")), width);
  if (view.busy) pushWrapped(lines, chalk.cyan(`Waiting for ${view.busy} API response…`), width);

  return lines.map((line) => visibleWidth(line) <= width ? line : truncateToWidth(line, width, ""));
};

export type CodingTuiRenderOptions = {
  readonly columns: number;
  readonly rows: number;
  readonly color?: boolean;
};

const SGR_PATTERN = /\u001b\[[0-9;]*m/giu;

/** Pure string renderer used by CLI snapshots and non-interactive previews. */
export const renderCodingTui = (
  snapshot: CodingCliRunSnapshot,
  options: CodingTuiRenderOptions,
): string => {
  const frame = renderCodingTuiLines({
    identity: {
      conversationId: snapshot.conversation.id,
      executionId: snapshot.run.executionId,
      ...(snapshot.job?.id ? { jobId: snapshot.job.id } : {}),
    },
    snapshot,
    showDiff: false,
    connected: true,
    viewportRows: options.rows,
  }, options.columns).join("\n");
  return options.color === false ? frame.replace(SGR_PATTERN, "") : frame;
};

const exactSnapshotIdentity = (
  snapshot: CodingCliRunSnapshot,
  conversationId: string,
  selectedJobId: string | undefined,
): CodingTuiIdentity => {
  if (snapshot.run.id !== conversationId || snapshot.conversation.id !== conversationId) {
    throw new Error(
      `Coding TUI identity mismatch: requested conversation ${conversationId}, received run ${snapshot.run.id}`
        + ` and conversation ${snapshot.conversation.id}`,
    );
  }
  if (selectedJobId && snapshot.job?.id !== selectedJobId) {
    throw new Error(
      `Coding TUI identity mismatch: requested job ${selectedJobId}, received ${snapshot.job?.id ?? "no job"}`,
    );
  }
  return {
    conversationId,
    executionId: boundedIdentity(snapshot.run.executionId, "execution id"),
    ...(snapshot.job?.id ? { jobId: boundedIdentity(snapshot.job.id, "job id") } : {}),
  };
};

const responseJobId = (response: Readonly<Record<string, unknown>>): string | undefined => {
  if (typeof response.jobId === "string" && response.jobId.trim()) return response.jobId.trim();
  const job = response.job;
  if (job && typeof job === "object" && !Array.isArray(job)) {
    const id = (job as Readonly<Record<string, unknown>>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return undefined;
};

const responseConversationId = (response: Readonly<Record<string, unknown>>): string | undefined => {
  const value = typeof response.conversationId === "string"
    ? response.conversationId
    : typeof response.runId === "string" ? response.runId : undefined;
  return value?.trim() || undefined;
};

const editorTheme: EditorTheme = {
  borderColor: (value) => chalk.dim(value),
  selectList: {
    selectedPrefix: (value) => chalk.cyan(value),
    selectedText: (value) => chalk.cyan(value),
    description: (value) => chalk.dim(value),
    scrollInfo: (value) => chalk.dim(value),
    noMatch: (value) => chalk.yellow(value),
  },
};

class CodingDashboard implements Component {
  constructor(
    private readonly state: MutableCodingTuiState,
    private readonly rows: () => number,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderCodingTuiLines({ ...this.state, viewportRows: this.rows() }, width);
  }
}

const sameSelection = (left: CodingTuiIdentity, right: CodingTuiIdentity): boolean =>
  left.conversationId === right.conversationId && left.jobId === right.jobId;

/**
 * Runs the Coding daily-driver UI. Ctrl-C only tears down this local terminal
 * attachment; the sole path to a durable abort is the typed confirmation flow.
 */
export const launchCodingTui = async (options: CodingTuiOptions): Promise<CodingTuiExit> => {
  if (options.conversationId && options.runId && options.conversationId !== options.runId) {
    throw new Error("Coding TUI conversationId and runId selectors must match");
  }
  const requestedConversationId = options.conversationId ?? options.runId;
  const conversationId = requestedConversationId
    ? boundedIdentity(requestedConversationId, "conversation id")
    : undefined;
  const initialJobId = options.jobId ? boundedIdentity(options.jobId, "job id") : undefined;
  if (initialJobId && !conversationId) throw new Error("Coding TUI jobId requires runId or conversationId");
  if (!options.terminal && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("Roster Coding TUI requires an interactive terminal");
  }

  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, true);
  const state: MutableCodingTuiState = {
    identity: { ...(conversationId ? { conversationId } : {}), ...(initialJobId ? { jobId: initialJobId } : {}) },
    selectedRoomIndex: 0,
    showDiff: false,
    connected: false,
  };
  const dashboard = new CodingDashboard(state, () => terminal.rows);
  const editor = new Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 6 });
  tui.addChild(dashboard);
  tui.addChild(editor);
  tui.setFocus(editor);

  const lifetime = new AbortController();
  let settled = false;
  let resolveExit!: (exit: CodingTuiExit) => void;
  let rejectExit!: (error: unknown) => void;
  const exit = new Promise<CodingTuiExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });

  const requestRender = (): void => {
    dashboard.invalidate();
    tui.requestRender();
  };

  let liveAttachment: CodingRealtimeSubscription | undefined;
  let attachmentGeneration = 0;
  let settle: (error?: unknown) => Promise<void>;
  const detachLive = (): void => {
    attachmentGeneration += 1;
    liveAttachment?.close();
    liveAttachment = undefined;
  };

  const attachSelection = async (): Promise<void> => {
    const selectedGeneration = ++attachmentGeneration;
    liveAttachment?.close();
    liveAttachment = undefined;
    const selectedConversationId = state.identity.conversationId;
    if (!selectedConversationId) {
      state.connected = false;
      try {
        const rooms = await options.client.rooms(options.workspaceId, lifetime.signal);
        if (lifetime.signal.aborted || selectedGeneration !== attachmentGeneration || state.identity.conversationId) return;
        state.rooms = rooms;
        state.selectedRoomIndex = Math.max(0, Math.min(state.selectedRoomIndex, Math.max(0, rooms.length - 1)));
        state.connected = true;
        requestRender();
      } catch (error) {
        if (!lifetime.signal.aborted && selectedGeneration === attachmentGeneration) {
          state.notice = { tone: "error", text: `Could not load rooms: ${error instanceof Error ? error.message : String(error)}` };
          requestRender();
        }
      }
      return;
    }
    let selectedJobId = state.identity.jobId;
    if (!selectedJobId) {
      try {
        const initial = await options.client.run(selectedConversationId, undefined, lifetime.signal);
        if (lifetime.signal.aborted || selectedGeneration !== attachmentGeneration
          || state.identity.conversationId !== selectedConversationId) return;
        const identity = exactSnapshotIdentity(initial, selectedConversationId, undefined);
        state.identity = identity;
        state.snapshot = initial;
        selectedJobId = identity.jobId;
        requestRender();
      } catch (error) {
        if (!lifetime.signal.aborted && selectedGeneration === attachmentGeneration) {
          state.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
          requestRender();
        }
        return;
      }
    }
    if (!selectedJobId) return;
    const pinnedJobId = selectedJobId;
    liveAttachment = subscribeCodingRealtime({
      client: options.client,
      conversationId: selectedConversationId,
      jobId: pinnedJobId,
      signal: lifetime.signal,
      onState: (liveState, detail) => {
        if (selectedGeneration !== attachmentGeneration) return;
        state.connected = liveState === "live";
        if (liveState === "denied") {
          state.notice = { tone: "error", text: `Realtime access denied${detail ? `: ${detail}` : "."}` };
        } else if (liveState === "paused" && detail) {
          state.notice = { tone: "warning", text: `Live updates paused: ${detail}` };
        } else if (liveState === "live" && state.notice?.text.startsWith("Live updates paused:")) {
          state.notice = undefined;
        }
        requestRender();
      },
      onSnapshot: (snapshot) => {
        if (selectedGeneration !== attachmentGeneration
          || state.identity.conversationId !== selectedConversationId
          || state.identity.jobId !== pinnedJobId) return;
        const identity = exactSnapshotIdentity(snapshot, selectedConversationId, pinnedJobId);
        if (state.identity.executionId && identity.executionId !== state.identity.executionId) {
          void settle(new Error(
            `Coding TUI identity mismatch: job ${pinnedJobId} changed execution from `
              + `${state.identity.executionId} to ${identity.executionId ?? "no execution"}`,
          ));
          return;
        }
        state.identity = identity;
        state.snapshot = snapshot;
        state.connected = true;
        requestRender();
      },
    });
  };

  settle = async (error?: unknown): Promise<void> => {
    if (settled) return;
    settled = true;
    detachLive();
    lifetime.abort();
    editor.disableSubmit = true;
    try {
      await terminal.drainInput(300, 30);
    } catch {
      // Terminal restoration below remains mandatory even if input draining fails.
    }
    try {
      tui.stop();
    } finally {
      if (error) rejectExit(error);
      else resolveExit({ reason: "detached", identity: { ...state.identity } });
    }
  };

  const selectionGuard = (): {
    readonly snapshot: CodingCliRunSnapshot;
    readonly conversationId: string;
    readonly executionId: string;
    readonly jobId: string;
  } | undefined => {
    const snapshot = state.snapshot;
    const selectedConversationId = state.identity.conversationId;
    const jobId = state.identity.jobId;
    const executionId = state.identity.executionId;
    if (!snapshot || !selectedConversationId || !jobId || !executionId || snapshot.job?.id !== jobId
      || snapshot.run.executionId !== executionId || snapshot.conversation.id !== selectedConversationId) {
      state.notice = { tone: "warning", text: "Wait for an exact conversation, execution, and job projection before acting." };
      requestRender();
      return undefined;
    }
    return { snapshot, conversationId: selectedConversationId, executionId, jobId };
  };

  const beginConfirmation = (action: CodingTuiConfirmation["action"]): void => {
    if (state.busy) return;
    const selected = selectionGuard();
    if (!selected) return;
    if (action === "integrate") {
      const integration = selected.snapshot.job?.integration;
      if (codingCliPhase(selected.snapshot) !== "review" || !selected.snapshot.job?.terminal
        || !selected.snapshot.job.commit || integration?.integrated || integration?.canIntegrate === false) {
        state.notice = { tone: "warning", text: integration?.reason ?? "This exact job is not eligible for integration." };
        requestRender();
        return;
      }
    } else if (action === "abort" && selected.snapshot.job?.terminal) {
      state.notice = { tone: "warning", text: "A terminal job cannot be aborted." };
      requestRender();
      return;
    } else if (action === "retry" && (!selected.snapshot.job?.terminal
      || !["failed", "canceled"].includes(selected.snapshot.job.status))) {
      state.notice = { tone: "warning", text: "Only an exact failed or canceled job can be retried." };
      requestRender();
      return;
    } else if (action === "close" && (!selected.snapshot.job?.terminal
      || selected.snapshot.job.status !== "completed" || selected.snapshot.job.integration?.integrated)) {
      state.notice = { tone: "warning", text: "Only an exact completed, unintegrated job can be closed and retained." };
      requestRender();
      return;
    }
    const commit = selected.snapshot.job?.commit;
    const phrase = action === "integrate" && commit
      ? `${action} ${selected.jobId} ${selected.executionId} ${commit}`
      : `${action} ${selected.jobId} ${selected.executionId}`;
    state.confirmation = {
      action,
      phrase,
      conversationId: selected.conversationId,
      executionId: selected.executionId,
      jobId: selected.jobId,
    };
    state.notice = undefined;
    editor.setText("");
    requestRender();
  };

  const runConfirmedAction = async (confirmation: CodingTuiConfirmation): Promise<void> => {
    const selected = selectionGuard();
    if (!selected) return;
    if (confirmation.conversationId !== selected.conversationId
      || confirmation.executionId !== selected.executionId
      || confirmation.jobId !== selected.jobId) {
      state.confirmation = undefined;
      state.notice = { tone: "error", text: "The selected execution changed; confirmation was discarded." };
      requestRender();
      return;
    }
    state.busy = confirmation.action;
    editor.disableSubmit = true;
    requestRender();
    try {
      if (confirmation.action === "integrate") {
        await options.client.integrate(selected.conversationId, selected.jobId, lifetime.signal);
        state.notice = { tone: "success", text: `Integrated exact job ${selected.jobId}.` };
      } else if (confirmation.action === "abort") {
        await options.client.abort(selected.conversationId, {
          jobId: selected.jobId,
          reason: `Roster TUI operator confirmed abort for execution ${selected.executionId}`,
        }, lifetime.signal);
        state.notice = { tone: "warning", text: `Abort requested for exact job ${selected.jobId}.` };
      } else if (confirmation.action === "retry") {
        const response = await options.client.retry(selected.conversationId, selected.jobId, lifetime.signal);
        const nextJobId = responseJobId(response);
        if (!nextJobId) throw new Error("Coding retry response did not include the fresh job identity");
        state.identity = {
          conversationId: selected.conversationId,
          jobId: boundedIdentity(nextJobId, "retry job id"),
        };
        state.snapshot = undefined;
        state.diff = undefined;
        state.showDiff = false;
        state.notice = { tone: "success", text: `Fresh retry admitted as exact job ${nextJobId}.` };
        void attachSelection();
      } else {
        await options.client.close(selected.conversationId, selected.jobId, lifetime.signal);
        state.notice = { tone: "success", text: `Closed exact job ${selected.jobId}; its certified branch is retained.` };
      }
      state.confirmation = undefined;
    } catch (error) {
      if (!lifetime.signal.aborted) {
        state.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      state.busy = undefined;
      editor.disableSubmit = false;
      requestRender();
    }
  };

  const submit = async (raw: string): Promise<void> => {
    const message = raw.trim();
    if (!message || state.busy) return;
    const confirmation = state.confirmation;
    if (confirmation) {
      if (message !== confirmation.phrase) {
        state.notice = { tone: "error", text: "Confirmation did not exactly match the selected execution and job." };
        requestRender();
        return;
      }
      await runConfirmedAction(confirmation);
      return;
    }

    state.busy = "message";
    editor.disableSubmit = true;
    requestRender();
    try {
      const prior = { ...state.identity };
      const response = prior.conversationId
        ? await options.client.message({
            runId: prior.conversationId,
            message,
            ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
            reviewPolicy: options.reviewPolicy ?? "auto",
          }, lifetime.signal)
        : await options.client.create({
            objective: message,
            ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
            reviewPolicy: options.reviewPolicy ?? "auto",
            ...(options.workerRuntime ? { workerRuntime: options.workerRuntime } : {}),
          }, lifetime.signal);
      const returnedConversationId = responseConversationId(response);
      if (prior.conversationId && returnedConversationId && returnedConversationId !== prior.conversationId) {
        throw new Error(
          `Coding TUI identity mismatch: message for ${prior.conversationId} returned ${returnedConversationId}`,
        );
      }
      const nextConversationId = prior.conversationId
        ?? (returnedConversationId ? boundedIdentity(returnedConversationId, "response conversation id") : undefined);
      if (!nextConversationId) throw new Error("Coding create response did not include a conversation identity");
      const nextJobId = responseJobId(response);
      if (!prior.conversationId || (nextJobId && nextJobId !== prior.jobId)) {
        state.identity = {
          conversationId: nextConversationId,
          ...(nextJobId ? { jobId: boundedIdentity(nextJobId, "response job id") } : {}),
        };
        state.snapshot = undefined;
        state.diff = undefined;
        state.showDiff = false;
        void attachSelection();
      }
      state.notice = {
        tone: "success",
        text: prior.conversationId ? "Message accepted by the Coding API." : `Created conversation ${nextConversationId}.`,
      };
      editor.addToHistory(message);
      editor.setText("");
    } catch (error) {
      if (!lifetime.signal.aborted) {
        state.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      state.busy = undefined;
      editor.disableSubmit = false;
      requestRender();
    }
  };

  const toggleDiff = async (): Promise<void> => {
    if (state.busy) return;
    if (state.showDiff) {
      state.showDiff = false;
      requestRender();
      return;
    }
    const selected = selectionGuard();
    if (!selected) return;
    state.busy = "diff";
    editor.disableSubmit = true;
    const requested = { ...state.identity };
    requestRender();
    try {
      const diff = await options.client.diff(selected.conversationId, selected.jobId, lifetime.signal);
      if (!sameSelection(requested, state.identity)) {
        state.notice = { tone: "warning", text: "The selected job changed; discarded the stale diff response." };
      } else {
        state.diff = diff;
        state.showDiff = true;
        state.notice = undefined;
      }
    } catch (error) {
      if (!lifetime.signal.aborted) {
        state.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      state.busy = undefined;
      editor.disableSubmit = false;
      requestRender();
    }
  };

  const moveRoomSelection = (delta: -1 | 1): void => {
    if (state.identity.conversationId || !state.rooms?.length) return;
    state.selectedRoomIndex = Math.max(
      0,
      Math.min(state.rooms.length - 1, state.selectedRoomIndex + delta),
    );
    requestRender();
  };

  const openSelectedRoom = (): void => {
    if (state.identity.conversationId) return;
    const room = state.rooms?.[state.selectedRoomIndex];
    if (!room) {
      state.notice = { tone: "info", text: "Type an objective and press Enter to create the first Coding room." };
      requestRender();
      return;
    }
    const selectedConversationId = boundedIdentity(room.conversationId, "room conversation id");
    state.identity = { conversationId: selectedConversationId };
    state.snapshot = undefined;
    state.diff = undefined;
    state.showDiff = false;
    state.notice = { tone: "info", text: `Opening ${room.title}.` };
    requestRender();
    void attachSelection();
  };

  const showRooms = (newRoom: boolean): void => {
    if (state.busy) return;
    state.identity = {};
    state.snapshot = undefined;
    state.diff = undefined;
    state.showDiff = false;
    state.confirmation = undefined;
    state.notice = newRoom
      ? { tone: "info", text: "Type an objective and press Enter to create a new Coding room." }
      : { tone: "info", text: "Choose a recent room with Alt-J / Alt-K and open it with Alt-O." };
    editor.setText("");
    requestRender();
    void attachSelection();
  };

  editor.onSubmit = (value) => { void submit(value); };
  const removeInputListener = tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      // Detachment only: durable cancellation requires the guarded API path below.
      void settle();
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && state.confirmation) {
      state.confirmation = undefined;
      state.notice = { tone: "info", text: "Confirmation canceled; no command was sent." };
      editor.setText("");
      requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("d"))) {
      void toggleDiff();
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("i"))) {
      beginConfirmation("integrate");
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("a"))) {
      beginConfirmation("abort");
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("t"))) {
      beginConfirmation("retry");
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("c"))) {
      beginConfirmation("close");
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("r"))) {
      showRooms(false);
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("n"))) {
      showRooms(true);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("l"))) {
      requestRender();
      return { consume: true };
    }
    if (!state.identity.conversationId && matchesKey(data, Key.alt("j"))) {
      moveRoomSelection(1);
      return { consume: true };
    }
    if (!state.identity.conversationId && matchesKey(data, Key.alt("k"))) {
      moveRoomSelection(-1);
      return { consume: true };
    }
    if (!state.identity.conversationId && matchesKey(data, Key.alt("o"))) {
      openSelectedRoom();
      return { consume: true };
    }
    return undefined;
  });

  tui.start();
  const watchTask = attachSelection().catch((error: unknown) => settle(error));
  try {
    return await exit;
  } finally {
    lifetime.abort();
    removeInputListener();
    await watchTask;
    if (!settled) await settle();
  }
};

export const runCodingTui = launchCodingTui;
