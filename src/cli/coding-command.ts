import fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import {
  CodingCliClient,
  CodingCliRequestError,
  codingCliPhase,
  type CodingCliDiff,
  type CodingCliRoom,
  type CodingCliRunSnapshot,
} from "./coding-client.js";
import { watchCodingRealtime } from "./coding-realtime.js";

export const CODING_CLI_OUTPUT_SCHEMA = "roster.coding-cli.v1" as const;
export const CODING_CLI_EVENT_SCHEMA = "roster.coding-cli.event.v1" as const;

export type CodingCommandFlags = Readonly<Record<string, string | boolean>>;

export type CodingCommandIo = {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: Pick<NodeJS.WriteStream, "write"> & { readonly isTTY?: boolean; readonly columns?: number; readonly rows?: number };
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
};

export type CodingCommandDependencies = {
  readonly client?: CodingCliClient;
  readonly io?: CodingCommandIo;
  readonly launchTui?: (input: {
    readonly client: CodingCliClient;
    readonly workspaceId?: string;
    readonly runId?: string;
    readonly jobId?: string;
    readonly reviewPolicy?: "auto" | "fast" | "reviewed";
    readonly workerRuntime?: "claude-code" | "codex-cli" | "pi-agent" | "hermes-agent";
  }) => Promise<void>;
  readonly confirm?: (question: string) => Promise<boolean>;
};

export class CodingCommandError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
    this.name = "CodingCommandError";
  }
}

const defaultIo = (): CodingCommandIo => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

const flagString = (flags: CodingCommandFlags, name: string): string | undefined => {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const required = (value: string | undefined, message: string): string => {
  if (!value) throw new CodingCommandError(message);
  return value;
};

const reviewPolicy = (value: string | undefined): "auto" | "fast" | "reviewed" | undefined => {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "fast" || value === "reviewed") return value;
  throw new CodingCommandError("--review must be auto, fast, or reviewed");
};

const workerRuntime = (value: string | undefined): "claude-code" | "codex-cli" | "pi-agent" | "hermes-agent" | undefined => {
  if (value === undefined) return undefined;
  if (value === "claude-code" || value === "codex-cli" || value === "pi-agent" || value === "hermes-agent") return value;
  throw new CodingCommandError("--runtime must be claude-code, codex-cli, pi-agent, or hermes-agent");
};

const positiveInteger = (value: string | undefined, fallback: number, label: string): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CodingCommandError(`${label} must be a positive integer`);
  return parsed;
};

const durationMs = (value: string | undefined): number => {
  if (!value) return 10 * 60_000;
  const match = /^(\d+)(ms|s|m|h)?$/u.exec(value);
  if (!match) throw new CodingCommandError("--timeout must be a duration such as 30s, 10m, or 1h");
  const scalar = Number(match[1]);
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : match[2] === "h" ? 3_600_000 : 60_000;
  const result = scalar * multiplier;
  if (!Number.isSafeInteger(result) || result < 250 || result > 24 * 3_600_000) {
    throw new CodingCommandError("--timeout must be between 250ms and 24h");
  }
  return result;
};

const writeLine = (stream: Pick<NodeJS.WriteStream, "write">, value = ""): void => {
  stream.write(`${value}\n`);
};

const envelope = (command: string, result: unknown): Readonly<Record<string, unknown>> => ({
  schema: CODING_CLI_OUTPUT_SCHEMA,
  ok: true,
  command,
  apiSchema: "roster.coding.v2",
  result,
});

const printJson = (io: CodingCommandIo, command: string, result: unknown): void => {
  writeLine(io.stdout, JSON.stringify(envelope(command, result)));
};

const phaseLabel = (snapshot: CodingCliRunSnapshot): string => {
  const phase = codingCliPhase(snapshot);
  return phase === "attention" ? "Needs attention" : phase[0].toUpperCase() + phase.slice(1);
};

const formatRooms = (rooms: ReadonlyArray<CodingCliRoom>): string => rooms.length === 0
  ? "No Coding conversations yet. Start one with `roster coding ask <objective>`."
  : rooms.map((room) => `${room.conversationId}\t${room.state}\t${room.messageCount} messages\t${room.title}`).join("\n");

const formatSnapshot = (snapshot: CodingCliRunSnapshot): string => [
  `Conversation  ${snapshot.conversation.id}`,
  `Execution     ${snapshot.run.executionId}`,
  `Job           ${snapshot.job?.id ?? "not admitted"}`,
  `State         ${phaseLabel(snapshot)}${snapshot.job ? ` · ${snapshot.job.status}` : ""}`,
  `Repository    ${snapshot.run.repositoryRoot || "unknown"}`,
  `Team          ${snapshot.nodes.length} nodes · ${snapshot.tasks.length} tasks`,
  `Evidence      ${snapshot.acceptedOutputCount} accepted outputs · ${snapshot.receiptCount} receipts`,
  ...(snapshot.conversation.pendingQuestions.length > 0
    ? ["", "Needs your answer:", ...snapshot.conversation.pendingQuestions.map((question) => `  ${question}`)]
    : []),
  ...(snapshot.resultSummary ? ["", snapshot.resultSummary] : []),
].join("\n");

const formatDiff = (diff: CodingCliDiff): string => [
  diff.summary,
  ...diff.files.map((file) => `${file.status.padEnd(3)} ${file.path}`),
  ...(diff.patch?.text ? ["", diff.patch.text] : []),
  ...(diff.patch?.truncated ? ["", "Patch was truncated by the bounded API projection."] : []),
].join("\n");

const readStream = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > 80_000) throw new CodingCommandError("stdin exceeds the 20,000-character Coding input limit");
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  if (value.length > 20_000) throw new CodingCommandError("stdin exceeds the 20,000-character Coding input limit");
  return value;
};

const textInput = async (input: {
  readonly args: ReadonlyArray<string>;
  readonly flags: CodingCommandFlags;
  readonly io: CodingCommandIo;
  readonly name: "objective" | "message";
}): Promise<string> => {
  const direct = flagString(input.flags, input.name);
  const file = flagString(input.flags, `${input.name}-file`);
  if (direct && file) throw new CodingCommandError(`Use only one of --${input.name} and --${input.name}-file`);
  let value: string;
  if (direct === "-") value = await readStream(input.io.stdin);
  else if (direct) value = direct;
  else if (file) value = await fs.readFile(file, "utf8");
  else value = input.args.join(" ");
  value = value.trim();
  if (!value) throw new CodingCommandError(`${input.name} is required`);
  if (value.length > 20_000) throw new CodingCommandError(`${input.name} exceeds 20,000 characters`);
  return value;
};

const requireConfirmed = (flags: CodingCommandFlags, action: string): void => {
  if (flags.yes !== true) throw new CodingCommandError(`${action} requires --yes and an exact --job selector`);
};

const validateFlags = (subcommand: string | undefined, flags: CodingCommandFlags): void => {
  const common = ["api-url", "url", "workspace"];
  const perCommand: Readonly<Record<string, ReadonlyArray<string>>> = {
    interactive: ["run", "job", "review", "runtime"],
    attach: ["job", "review", "runtime"],
    help: [],
    "--help": [],
    "-h": [],
    rooms: ["json"],
    status: ["job", "json"],
    ask: ["objective", "objective-file", "review", "runtime", "json"],
    send: ["message", "message-file", "json"],
    wait: ["job", "until", "timeout", "interval", "json", "jsonl"],
    review: ["job", "json"],
    record: ["job"],
    merge: ["job", "yes", "json"],
    abort: ["job", "reason", "yes", "json"],
    retry: ["job", "yes", "json"],
    close: ["job", "yes", "json"],
  };
  const allowed = new Set([...common, ...(perCommand[subcommand ?? "interactive"] ?? [])]);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new CodingCommandError(`Unknown flag --${key} for roster coding ${subcommand ?? ""}`.trim());
  }
  if (flags.json === true && flags.jsonl === true) throw new CodingCommandError("Use only one of --json and --jsonl");
};

const waitMatches = (snapshot: CodingCliRunSnapshot, until: string): boolean => {
  const phase = codingCliPhase(snapshot);
  if (until === "attention") return phase === "attention";
  if (until === "review") return phase === "review";
  if (until === "done") return phase === "done";
  if (until === "terminal") return phase === "attention" || phase === "review" || phase === "done" || phase === "failed";
  throw new CodingCommandError("--until must be attention, review, done, or terminal");
};

const commandHelp = (): string => `roster coding [--workspace <id>] [--run <conversation-id>] [--job <job-id>]

Interactive daily driver:
  roster coding
  roster coding attach <conversation-id> [--job <job-id>]

The interactive command attaches to or starts the loopback Roster stack. On a
new workspace it offers the existing bounded repository scan before opening.

Conversation commands:
  roster coding rooms [--workspace <id>] [--json]
  roster coding status <conversation-id> [--job <job-id>] [--json]
  roster coding ask <objective> [--workspace <id>] [--json]
  roster coding send <conversation-id> <message> [--json]
  roster coding wait <conversation-id> [--job <job-id>] [--until terminal] [--jsonl]
  roster coding review <conversation-id> --job <job-id> [--json]
  roster coding record <conversation-id> --job <job-id>

Guarded handoff:
  roster coding merge <conversation-id> --job <job-id> --yes [--json]
  roster coding abort <conversation-id> --job <job-id> --reason <text> --yes [--json]
  roster coding retry <conversation-id> --job <job-id> --yes [--json]
  roster coding close <conversation-id> --job <job-id> --yes [--json]

Configuration: ROSTER_API_URL and ROSTER_API_TOKEN. Set ROSTER_CODING_AUTOSTART=0
to require an already-running server. Tokens are never accepted as flags.`;

const confirmWorkspaceScan = async (question: string): Promise<boolean> => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
};

export const executeCodingCommand = async (
  args: ReadonlyArray<string>,
  flags: CodingCommandFlags = {},
  dependencies: CodingCommandDependencies = {},
): Promise<void> => {
  if (flags.token !== undefined || flags["api-token"] !== undefined) {
    throw new CodingCommandError("API tokens are accepted only through ROSTER_API_TOKEN, never command flags");
  }
  const io = dependencies.io ?? defaultIo();
  const [subcommand, ...rest] = args;
  validateFlags(subcommand, flags);
  const client = dependencies.client ?? new CodingCliClient({ baseUrl: flagString(flags, "api-url") ?? flagString(flags, "url") });
  const workspaceId = flagString(flags, "workspace");
  const json = flags.json === true;

  if (!subcommand || subcommand === "attach") {
    if (!io.stdout.isTTY || !(io.stdin as { readonly isTTY?: boolean }).isTTY) {
      throw new CodingCommandError("Interactive Coding requires a TTY. Use a JSON command such as `roster coding rooms --json`.");
    }
    let workspace = await client.workspace(workspaceId);
    if (!workspace.scanned) {
      writeLine(io.stdout, `Repository onboarding is required for ${workspace.repositoryRoot ?? "the selected workspace"}.`);
      writeLine(io.stdout, "Roster will inspect tracked files and create a bounded durable specialist team.");
      const accepted = await (dependencies.confirm ?? confirmWorkspaceScan)("Scan and assemble the workspace team now?");
      if (!accepted) throw new CodingCommandError("Workspace scan canceled; no Coding work was started");
      writeLine(io.stdout, "Scanning the repository and assembling its specialist team…");
      workspace = await client.scanWorkspace(workspace.workspaceId);
      writeLine(io.stdout, "Workspace team is ready. Opening Coding…");
    }
    const launch = dependencies.launchTui ?? (await import("./coding-tui.js")).launchCodingTui;
    const selectedReview = reviewPolicy(flagString(flags, "review"));
    const selectedRuntime = workerRuntime(flagString(flags, "runtime"));
    await launch({
      client,
      workspaceId: workspace.workspaceId,
      ...(subcommand === "attach" && rest[0] ? { runId: rest[0] } : flagString(flags, "run") ? { runId: flagString(flags, "run") } : {}),
      ...(flagString(flags, "job") ? { jobId: flagString(flags, "job") } : {}),
      ...(selectedReview ? { reviewPolicy: selectedReview } : {}),
      ...(selectedRuntime ? { workerRuntime: selectedRuntime } : {}),
    });
    return;
  }

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    writeLine(io.stdout, commandHelp());
    return;
  }

  if (subcommand === "rooms") {
    const rooms = await client.rooms(workspaceId);
    if (json) printJson(io, "rooms", rooms);
    else writeLine(io.stdout, formatRooms(rooms));
    return;
  }

  if (subcommand === "status") {
    const runId = required(rest[0], "status requires a conversation ID");
    const snapshot = await client.run(runId, flagString(flags, "job"));
    if (json) printJson(io, "status", snapshot);
    else writeLine(io.stdout, formatSnapshot(snapshot));
    return;
  }

  if (subcommand === "ask") {
    const objective = await textInput({ args: rest, flags, io, name: "objective" });
    const selectedReview = reviewPolicy(flagString(flags, "review"));
    const selectedRuntime = workerRuntime(flagString(flags, "runtime"));
    const result = await client.create({
      objective,
      ...(workspaceId ? { workspaceId } : {}),
      ...(selectedReview ? { reviewPolicy: selectedReview } : {}),
      ...(selectedRuntime ? { workerRuntime: selectedRuntime } : {}),
    });
    if (json) printJson(io, "ask", result);
    else writeLine(io.stdout, `Coding conversation admitted: ${String(result.conversationId ?? result.runId ?? "unknown")}`);
    return;
  }

  if (subcommand === "send") {
    const runId = required(rest[0], "send requires a conversation ID");
    const message = await textInput({ args: rest.slice(1), flags, io, name: "message" });
    const result = await client.message({ runId, message, ...(workspaceId ? { workspaceId } : {}) });
    if (json) printJson(io, "send", result);
    else writeLine(io.stdout, `Message accepted for conversation ${runId}.`);
    return;
  }

  if (subcommand === "wait") {
    const runId = required(rest[0], "wait requires a conversation ID");
    const jobId = flagString(flags, "job");
    const until = flagString(flags, "until") ?? "terminal";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), durationMs(flagString(flags, "timeout")));
    let finalSnapshot: CodingCliRunSnapshot | undefined;
    try {
      for await (const snapshot of watchCodingRealtime({
        client,
        conversationId: runId,
        ...(jobId ? { jobId } : {}),
        coalesceMs: positiveInteger(flagString(flags, "interval"), 50, "--interval"),
        signal: controller.signal,
      })) {
        finalSnapshot = snapshot;
        if (flags.jsonl === true) writeLine(io.stdout, JSON.stringify({
          schema: CODING_CLI_EVENT_SCHEMA,
          type: "snapshot",
          conversationId: snapshot.conversation.id,
          executionId: snapshot.run.executionId,
          jobId: snapshot.job?.id,
          phase: codingCliPhase(snapshot),
          snapshot,
        }));
        else if (!json) writeLine(io.stdout, formatSnapshot(snapshot));
        if (waitMatches(snapshot, until)) break;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      throw new CodingCommandError(`Timed out waiting for conversation ${runId}`, 4);
    } finally {
      clearTimeout(timer);
    }
    if (!finalSnapshot) throw new CodingCommandError(`No projection observed for conversation ${runId}`, 4);
    if (json) printJson(io, "wait", finalSnapshot);
    return;
  }

  if (subcommand === "review") {
    const runId = required(rest[0], "review requires a conversation ID");
    const jobId = required(flagString(flags, "job"), "review requires --job <job-id>");
    const diff = await client.diff(runId, jobId);
    if (json) printJson(io, "review", diff);
    else writeLine(io.stdout, formatDiff(diff));
    return;
  }

  if (subcommand === "record") {
    const runId = required(rest[0], "record requires a conversation ID");
    const jobId = required(flagString(flags, "job"), "record requires --job <job-id>");
    writeLine(io.stdout, await client.collaborationRecord(runId, jobId));
    return;
  }

  const exactMutation = async (action: "merge" | "abort" | "retry" | "close"): Promise<void> => {
    const runId = required(rest[0], `${action} requires a conversation ID`);
    const jobId = required(flagString(flags, "job"), `${action} requires --job <job-id>`);
    requireConfirmed(flags, action);
    const result = action === "merge"
      ? await client.integrate(runId, jobId)
      : action === "abort"
        ? await client.abort(runId, { jobId, reason: required(flagString(flags, "reason"), "abort requires --reason <text>") })
        : action === "retry"
          ? await client.retry(runId, jobId)
          : await client.close(runId, jobId);
    if (json) printJson(io, action, result);
    else writeLine(io.stdout, `${action === "merge" ? "Guarded local integration" : action} accepted for ${runId} · job ${jobId}.`);
  };

  if (subcommand === "merge" || subcommand === "abort" || subcommand === "retry" || subcommand === "close") {
    await exactMutation(subcommand);
    return;
  }

  throw new CodingCommandError(`Unknown Coding command '${subcommand}'. Run \`roster coding help\`.`);
};

export const runCodingCommand = executeCodingCommand;

export const codingCommandExitCode = (error: unknown): number => {
  if (error instanceof CodingCommandError) return error.exitCode;
  if (error instanceof CodingCliRequestError) {
    if (error.status === 401 || error.status === 403) return 77;
    if (error.status === 404 || error.status === 409) return 5;
    if (error.status === 429 || error.status === 502 || error.status === 503 || error.status === 504) return 69;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return 69;
  if (error instanceof TypeError && /fetch failed|network/iu.test(error.message)) return 69;
  return 1;
};
