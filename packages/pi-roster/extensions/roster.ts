import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { RosterClient, rosterClientFromEnvironment } from "../src/client.js";
import {
  ROSTER_CONTROL_API_VERSION,
  terminalRosterRunStatus,
  type RosterReviewPolicy,
  type RosterRunSummary,
  type RosterSessionAttachment,
  type RosterWorkerRuntime,
  type RosterWorkspaceSummary,
} from "../src/contracts.js";
import { formatRunList, formatRunResult, projectRosterRun } from "../src/projection.js";

const ATTACHMENT_ENTRY = "roster.pi.attachment.v1";
const OUTPUT_ENTRY = "roster.pi.output.v1";
const POLL_MS = 2_000;

const parseRosterCodeArgs = (args: string): {
  readonly objective: string;
  readonly reviewPolicy: RosterReviewPolicy;
  readonly workerRuntime: RosterWorkerRuntime;
} => {
  let remaining = args.trim();
  let reviewPolicy: RosterReviewPolicy = "auto";
  let workerRuntime: RosterWorkerRuntime = "pi-agent";
  const flags: ReadonlyArray<{
    readonly flag: string;
    readonly apply: () => void;
  }> = [
    { flag: "--fast", apply: () => { reviewPolicy = "fast"; } },
    { flag: "--reviewed", apply: () => { reviewPolicy = "reviewed"; } },
    { flag: "--auto", apply: () => { reviewPolicy = "auto"; } },
    { flag: "--pi", apply: () => { workerRuntime = "pi-agent"; } },
    { flag: "--codex", apply: () => { workerRuntime = "codex-cli"; } },
    { flag: "--claude", apply: () => { workerRuntime = "claude-code"; } },
    { flag: "--hermes", apply: () => { workerRuntime = "hermes-agent"; } },
  ];
  let consumed = true;
  while (consumed) {
    consumed = false;
    for (const { flag, apply } of flags) {
      if (remaining === flag) {
        apply();
        remaining = "";
        consumed = true;
        break;
      }
      if (remaining.startsWith(`${flag} `)) {
        apply();
        remaining = remaining.slice(flag.length).trimStart();
        consumed = true;
        break;
      }
    }
  }
  return { objective: remaining, reviewPolicy, workerRuntime };
};

const attachmentFrom = (value: unknown): RosterSessionAttachment | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<RosterSessionAttachment>;
  return candidate.apiVersion === ROSTER_CONTROL_API_VERSION
    && typeof candidate.runId === "string"
    && typeof candidate.baseUrl === "string"
    ? candidate as RosterSessionAttachment
    : undefined;
};

export default function rosterExtension(pi: ExtensionAPI): void {
  let client: RosterClient = rosterClientFromEnvironment();
  let attachedRunId: string | undefined;
  let pollController: AbortController | undefined;
  const reportedTerminalRuns = new Set<string>();

  const workspaceText = (workspace: RosterWorkspaceSummary): string => workspace.scanned
    ? [
        `Repository: ${workspace.repositoryRoot}`,
        `Reviewed: ${workspace.fileCount ?? 0} files`,
        workspace.technologies?.length ? `Technologies: ${workspace.technologies.join(", ")}` : undefined,
        "Saved agents:",
        ...(workspace.nodes ?? []).map((node) => `  - ${node.name}${node.specialty ? ` · ${node.specialty}` : ""}`),
      ].filter((line): line is string => Boolean(line)).join("\n")
    : `Repository: ${workspace.repositoryRoot}\nNo saved Roster agents yet.`;

  const offerWorkspaceSetup = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return;
    try {
      const workspace = await client.getWorkspace();
      if (workspace.scanned) return;
      const approved = await ctx.ui.confirm(
        "Create a Roster team?",
        "Scan this repository and save a small specialist agent team for future change conversations?",
      );
      if (!approved) return;
      const saved = await client.scanWorkspace();
      pi.appendEntry(OUTPUT_ENTRY, { title: "Roster workspace team", text: workspaceText(saved) });
      ctx.ui.notify(`${saved.nodes?.length ?? 0} workspace agents saved`, "info");
    } catch {
      // Roster may not be running when a Pi session opens. Commands surface errors explicitly.
    }
  };

  const render = (run: RosterRunSummary, ctx: ExtensionContext): void => {
    const projection = projectRosterRun(run);
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("roster", projection.status);
    ctx.ui.setWidget("roster", [...projection.widget], { placement: "aboveEditor" });
  };

  const appendTerminalResult = (run: RosterRunSummary, ctx: ExtensionContext): void => {
    if (!terminalRosterRunStatus(run.status) || reportedTerminalRuns.has(run.id)) return;
    reportedTerminalRuns.add(run.id);
    pi.appendEntry(OUTPUT_ENTRY, {
      title: `Roster result · ${run.id}`,
      text: formatRunResult(run),
    });
    if (ctx.hasUI) ctx.ui.notify(`Roster run ${run.id} ${run.status}`, run.status === "completed" ? "info" : "warning");
  };

  const clearPoll = (): void => {
    pollController?.abort();
    pollController = undefined;
  };

  const persistAttachment = (runId: string): void => {
    attachedRunId = runId;
    pi.appendEntry(ATTACHMENT_ENTRY, {
      apiVersion: ROSTER_CONTROL_API_VERSION,
      runId,
      baseUrl: client.baseUrl,
    } satisfies RosterSessionAttachment);
  };

  const requireAttached = (ctx: ExtensionContext): string | undefined => {
    if (attachedRunId) return attachedRunId;
    if (ctx.hasUI) ctx.ui.notify("No run attached. Use /roster-code or /roster-attach.", "warning");
    return undefined;
  };

  const refresh = async (ctx: ExtensionContext): Promise<RosterRunSummary | undefined> => {
    const runId = requireAttached(ctx);
    if (!runId) return undefined;
    try {
      const run = await client.getRun(runId);
      render(run, ctx);
      appendTerminalResult(run, ctx);
      return run;
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return undefined;
    }
  };

  const beginPolling = (ctx: ExtensionContext): void => {
    clearPoll();
    const controller = new AbortController();
    pollController = controller;
    void (async () => {
      while (!controller.signal.aborted) {
        const run = await refresh(ctx);
        if (!run || terminalRosterRunStatus(run.status)) break;
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, POLL_MS);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      }
      if (pollController === controller) pollController = undefined;
    })();
  };

  const attach = async (runId: string, ctx: ExtensionContext): Promise<void> => {
    try {
      const run = await client.getRun(runId);
      persistAttachment(run.id);
      render(run, ctx);
      appendTerminalResult(run, ctx);
      if (!terminalRosterRunStatus(run.status)) beginPolling(ctx);
      if (ctx.hasUI) ctx.ui.notify(`Attached to Roster run ${run.id}`, "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.registerEntryRenderer(OUTPUT_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { readonly title?: unknown; readonly text?: unknown };
    const title = typeof data.title === "string" ? data.title : "Roster";
    const body = typeof data.text === "string" ? data.text : "";
    return new Text(`${theme.bold(title)}\n${body}`, 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    clearPoll();
    attachedRunId = undefined;
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== ATTACHMENT_ENTRY) continue;
      const attachment = attachmentFrom(entry.data);
      if (!attachment) continue;
      client = rosterClientFromEnvironment();
      if (!process.env.ROSTER_API_URL) client = new RosterClient({ baseUrl: attachment.baseUrl });
      attachedRunId = attachment.runId;
      const run = await refresh(ctx);
      if (run && !terminalRosterRunStatus(run.status)) beginPolling(ctx);
      break;
    }
    await offerWorkspaceSetup(ctx);
  });

  pi.on("session_shutdown", () => clearPoll());

  pi.registerCommand("roster-code", {
    description: "Start a Roster-managed coding run; supports --fast, --reviewed, --auto, --pi, --codex, --claude, and --hermes",
    handler: async (args, ctx) => {
      const { objective, reviewPolicy, workerRuntime } = parseRosterCodeArgs(args);
      if (!objective) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /roster-code [--fast|--reviewed|--auto] [--pi|--codex|--claude|--hermes] <objective>", "warning");
        return;
      }
      try {
        const run = await client.startRun({ objective, workingDirectory: ctx.cwd, reviewPolicy, workerRuntime });
        persistAttachment(run.id);
        render(run, ctx);
        beginPolling(ctx);
        if (!pi.getSessionName()) pi.setSessionName(`Roster: ${objective.slice(0, 60)}`);
        if (ctx.hasUI) ctx.ui.notify(`Roster run ${run.id} started (${reviewPolicy}, ${workerRuntime})`, "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("roster-scan", {
    description: "Scan this repository and save its Roster specialist team",
    handler: async (_args, ctx) => {
      try {
        const saved = await client.scanWorkspace();
        pi.appendEntry(OUTPUT_ENTRY, { title: "Roster workspace team", text: workspaceText(saved) });
        if (ctx.hasUI) ctx.ui.notify(`${saved.nodes?.length ?? 0} workspace agents saved`, "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("roster-runs", {
    description: "List recent Roster coding runs",
    handler: async (_args, ctx) => {
      try {
        const result = await client.listRuns();
        pi.appendEntry(OUTPUT_ENTRY, { title: "Roster runs", text: formatRunList(result.runs) });
        if (ctx.hasUI) ctx.ui.notify(`${result.runs.length} Roster run${result.runs.length === 1 ? "" : "s"}`, "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("roster-attach", {
    description: "Attach this Pi session to a Roster run",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /roster-attach <run-id>", "warning");
        return;
      }
      await attach(runId, ctx);
    },
  });

  pi.registerCommand("roster-steer", {
    description: "Send a durable steering command to the attached Roster run",
    handler: async (args, ctx) => {
      const runId = requireAttached(ctx);
      const message = args.trim();
      if (!runId || !message) {
        if (runId && ctx.hasUI) ctx.ui.notify("Usage: /roster-steer <message>", "warning");
        return;
      }
      try {
        const receipt = await client.steer(runId, message);
        if (ctx.hasUI) ctx.ui.notify(receipt.ok ? `Steering accepted for job ${receipt.jobId}` : "Steering rejected", receipt.ok ? "info" : "warning");
        await refresh(ctx);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("roster-diff", {
    description: "Show the attached run's current Git frontier diff",
    handler: async (_args, ctx) => {
      const runId = requireAttached(ctx);
      if (!runId) return;
      try {
        const diff = await client.getDiff(runId);
        pi.appendEntry(OUTPUT_ENTRY, {
          title: `Roster diff · ${runId}`,
          text: [
            diff.summary || (diff.dirty ? "Working tree has changes." : "Working tree is clean."),
            ...diff.files.map((file) => `${file.status} ${file.path}`),
            ...(diff.truncated ? ["… file list truncated by Roster"] : []),
            "",
            diff.patch.text || "No tracked diff at the current checkout frontier.",
            ...(diff.patch.truncated ? [`… patch truncated at ${diff.patch.maxBytes} bytes`] : []),
          ].filter(Boolean).join("\n"),
        });
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("roster-abort", {
    description: "Request cancellation of the attached Roster run",
    handler: async (args, ctx) => {
      const runId = requireAttached(ctx);
      if (!runId) return;
      const assumeYes = args.trim() === "--yes";
      if (!ctx.hasUI && !assumeYes) return;
      if (ctx.hasUI && !assumeYes && !await ctx.ui.confirm("Abort Roster run?", `Request cancellation of ${runId}?`)) return;
      try {
        const receipt = await client.abort(runId);
        if (ctx.hasUI) ctx.ui.notify(receipt.ok ? `Abort accepted for job ${receipt.jobId}` : "Abort rejected", receipt.ok ? "warning" : "error");
        await refresh(ctx);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
